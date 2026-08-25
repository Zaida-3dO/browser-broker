import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { BrowserId } from '../browser/driver.ts';
import { profileDirectory } from '../browser/discovery.ts';

/**
 * Whether the signed-in browser's profile **looks** signed in.
 *
 * ── The question, and why it is worth answering without a browser ───────
 *
 * A person signs in by hand exactly once (`SCHEMA.md` §5.5.1) and then has no
 * way to confirm it took. Opening a browser to look is the obvious answer and
 * is a bad one: `broker doctor` **reports and changes nothing**, and a check
 * that launched a browser against the profile would be a check that could
 * itself take the profile's lock — reporting a fault it had just caused, on
 * an installation that was fine a moment earlier.
 *
 * So this reads files, and the whole design problem is that **the obvious
 * observable does not work**.
 *
 * ── What was measured, because the obvious check always passes ──────────
 *
 * Two profiles were built with a real browser: one where nothing was ever
 * visited, and one where a session cookie was set and the browser was closed
 * cleanly. Then every candidate observable was compared.
 *
 * | Observable | Fresh profile | Signed-in profile | Distinguishes? |
 * |---|---|---|---|
 * | `Default/Network/Cookies` exists | **yes** | yes | **no** |
 * | its size on disk | **20480 bytes** | 20480 bytes | **no** |
 * | rows in its `cookies` table | **0** | **1** | **yes** |
 *
 * **The file is created on first run whether or not anything is stored in
 * it.** So `existsSync` — the check anyone reaches for first, and the one this
 * module would have shipped without the measurement — is a check that
 * **cannot fail**. It would report every fresh install as signed in, which is
 * the exact failure the house standard names: a check that claims what it
 * cannot see. The size is no better, because SQLite allocates its pages up
 * front.
 *
 * The row count is the observable that carries the fact, so it is the one
 * this reads.
 *
 * ── The two things this deliberately does not claim ─────────────────────
 *
 * Both are reported as `unknown` with the reason rather than being guessed
 * at, because an `unknown` that says why beats a confident wrong answer.
 *
 * 1. **A running browser has not necessarily written its cookies down.**
 *    Measured: with the browser ended abruptly, the signed-in profile read
 *    **zero rows** — identical to the fresh one. The store is flushed on a
 *    clean shutdown, so a count taken while a browser is live is a count of
 *    what has been flushed so far and not of what the session holds. Reading
 *    zero in that state means *cannot tell yet*, never *not signed in*.
 * 2. **Cookies are one carrier of a session, not the only one.** A site that
 *    keeps its session in local storage or a token in IndexedDB leaves this
 *    table empty while being perfectly signed in. So a positive result is
 *    strong and a zero result is weak, and they are reported asymmetrically
 *    for that reason.
 *
 * **This is positive-evidence-only, in exactly the way `profileLockLooksHeld`
 * is**, and for the same reason: finding rows means a session was stored;
 * finding none means no evidence was found, which is not the same as evidence
 * of absence.
 */

/**
 * Where a Chromium profile keeps its cookies.
 *
 * **Measured rather than assumed, and the obvious guess is wrong.** It is not
 * `Default/Cookies` — that path does not exist in a profile this service
 * creates. The store sits under the network directory, and a check pointed at
 * the wrong path would report every profile as unreadable.
 */
export const COOKIE_STORE_RELATIVE: readonly string[] = ['Default', 'Network', 'Cookies'];

/** What the profile inspection concluded. */
export type SessionEvidence =
  /** Cookies are stored: something was signed in and written down. */
  | 'session-present'
  /** The profile exists and holds no stored cookies. */
  | 'no-session-found'
  /** The profile has not been created yet. */
  | 'no-profile'
  /** There is a profile and the question could not be answered. */
  | 'undetermined';

export interface SessionProbe {
  readonly evidence: SessionEvidence;
  /** How many stored cookies were counted, when counting was possible. */
  readonly cookieCount?: number;
  /** Why the answer is not a plain yes or no. Always set when it is not. */
  readonly reason?: string;
}

/** Reading a SQLite file without adding a way for this module to write one. */
export interface CookieStoreReader {
  /**
   * Count the rows in the cookie store, or report why it could not be read.
   *
   * Injected so the failure branches are reachable by a test: a locked store
   * and a corrupt one are real states this has to report honestly, and
   * neither can be produced portably.
   */
  readonly countCookies: (file: string) => { readonly count: number } | { readonly error: string };
}

/**
 * The real reader: opens the store **read-only** and counts.
 *
 * Read-only is not a precaution, it is the contract — `checks.ts` promises
 * the doctor changes nothing, and a cookie store opened for writing can be
 * migrated by the opening process. Opening a browser's own store read-write
 * to ask a question would be able to damage the one thing this whole command
 * exists to protect.
 */
export function realCookieStoreReader(): CookieStoreReader {
  return {
    countCookies: (file) => {
      try {
        const db = new Database(file, { readonly: true, fileMustExist: true });
        try {
          const row = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM cookies').get();
          return { count: row?.n ?? 0 };
        } finally {
          db.close();
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export interface InspectOptions {
  readonly reader?: CookieStoreReader;
  /**
   * Whether a browser is live against this profile.
   *
   * Supplied by the caller because it is the discovery check's answer and
   * this module does not reach a browser. It changes the **meaning of a zero
   * count**, which is the whole reason it is a parameter: see the note on
   * flushing in this module's header.
   */
  readonly browserRunning?: boolean;
}

/**
 * Inspect one profile and say what the evidence supports.
 *
 * Every branch that cannot answer says so and says why. There is no branch
 * that returns `no-session-found` on evidence that would also be produced by
 * a signed-in profile.
 */
export function inspectProfileSession(
  profileRoot: string,
  browser: BrowserId,
  options: InspectOptions = {},
): SessionProbe {
  const directory = profileDirectory(profileRoot, browser);

  let profilePresent: boolean;
  try {
    profilePresent = fs.statSync(directory).isDirectory();
  } catch {
    profilePresent = false;
  }

  if (!profilePresent) {
    return {
      evidence: 'no-profile',
      reason:
        'No profile directory. It is created by the setup handshake on the next spawn, and nobody has signed in against it.',
    };
  }

  const store = path.join(directory, ...COOKIE_STORE_RELATIVE);
  if (!fs.existsSync(store)) {
    return {
      evidence: 'no-session-found',
      cookieCount: 0,
      reason:
        'The profile exists but the browser has never written a cookie store into it, so no browser has run against it yet.',
    };
  }

  const reader = options.reader ?? realCookieStoreReader();
  const outcome = reader.countCookies(store);

  if ('error' in outcome) {
    return {
      evidence: 'undetermined',
      reason: `The cookie store could not be read (${outcome.error}). A store held open by a running browser is the ordinary cause; nothing is concluded from a read that did not happen.`,
    };
  }

  if (outcome.count > 0) {
    return {
      evidence: 'session-present',
      cookieCount: outcome.count,
    };
  }

  // Zero. The one branch where the honest answer depends on something else,
  // because a live browser has not necessarily flushed yet — measured, and
  // the reason this parameter exists.
  if (options.browserRunning === true) {
    return {
      evidence: 'undetermined',
      cookieCount: 0,
      reason:
        'The stored cookie count is zero and a browser is running against this profile. A browser writes its cookies down when it shuts down cleanly, so a zero read while one is live means the store has nothing flushed yet rather than that nobody is signed in. Close the browser and ask again.',
    };
  }

  return {
    evidence: 'no-session-found',
    cookieCount: 0,
    reason:
      'The profile has a cookie store and it holds no cookies. That is what a profile nobody has signed into looks like — though a site that keeps its session only in local storage would look the same, so this is the absence of evidence rather than evidence of absence.',
  };
}
