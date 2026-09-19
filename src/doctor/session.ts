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
 *
 * Kept as the name of the layout this service's own profiles use. The check
 * itself walks {@link COOKIE_STORE_CANDIDATES}, because one machine's layout
 * is not the only real one.
 */
export const COOKIE_STORE_RELATIVE: readonly string[] = ['Default', 'Network', 'Cookies'];

/**
 * Every layout a Chromium cookie store is known to use, newest first.
 *
 * ── Why this is a list and not the single path above ────────────────────
 *
 * Chromium keeps the cookie store under `Default/Network/` from M96 onward
 * and directly under `Default/` before it. Both layouts are real and both are
 * in use: which one a profile has depends on the Chromium version that built
 * it, and a profile carried across the boundary keeps what it had. A check
 * that knows only one
 * of them does not report "I looked in one place"; it reports **the profile
 * has never been used**, which is a statement about the world drawn from a
 * statement about one path. That is the defect this list exists to fix, and
 * it was found by somebody whose profile kept the pre-M96 layout while being
 * perfectly signed in.
 *
 * **Order is the semantics.** The first candidate that exists wins, and the
 * rest are not read. A migrated profile can hold both files — the modern one
 * live and the legacy one left behind, usually empty — so summing them would
 * count a single store twice and reading the legacy one first would answer
 * from the stale half.
 *
 * **Deliberately not a glob over `Profile *`.** This service always launches
 * the default profile (`SCHEMA.md` §1.2), so a numbered profile directory is
 * not a state it can produce; searching for one would be a check answering a
 * question nobody asked, and a stray directory would make it answer wrongly.
 */
export const COOKIE_STORE_CANDIDATES: readonly (readonly string[])[] = [
  ['Default', 'Network', 'Cookies'],
  ['Default', 'Cookies'],
];

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
  /**
   * How many stored cookies were counted, when counting was possible.
   *
   * **Absent whenever no store was opened.** A zero set on a branch that
   * never found a file to read reads as a measurement and is not one, which
   * is the same overstatement in a number that prose can make in words.
   */
  readonly cookieCount?: number;
  /**
   * Which candidate layout the store was found at, relative to the profile
   * directory.
   *
   * Reported because naming the file is what lets somebody check the answer
   * against their own machine. A verdict about a profile that does not say
   * which path it read leaves a person with no way to tell a real negative
   * from a check looking in the wrong place. **Relative, never absolute**:
   * §1.7a's rule is that no absolute path is stored or emitted.
   */
  readonly storeRelativePath?: string;
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
   *
   * **Three-valued on purpose, and `undefined` is the important one.** A
   * `boolean` cannot say *nobody asked*, so it collapses that state into
   * `false` — and a `false` here is what licenses the negative verdict. That
   * collapse is exactly how this check came to report a confident "no browser
   * has ever run against this profile" on installations where no caller had
   * supplied the probe at all: the report was not measuring a browser, it was
   * reading a default. Only a measured `false` earns the negative now.
   */
  readonly browserRunning?: boolean | undefined;
}

/**
 * The first candidate cookie store that exists, or nothing.
 *
 * Returns the relative form alongside the absolute one because the probe
 * reports the relative path and the reader needs the absolute; deriving the
 * relative half back out of the absolute one later would be a second place
 * for the two to disagree.
 */
function findCookieStore(directory: string):
  | {
      readonly file: string;
      readonly relative: string;
      readonly alsoPresent: readonly string[];
    }
  | undefined {
  const found = COOKIE_STORE_CANDIDATES.map((candidate) => ({
    file: path.join(directory, ...candidate),
    relative: candidate.join('/'),
  })).filter((candidate) => fs.existsSync(candidate.file));

  const first = found[0];
  if (first === undefined) {
    return undefined;
  }

  return {
    file: first.file,
    relative: first.relative,
    alsoPresent: found.slice(1).map((candidate) => candidate.relative),
  };
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

  const store = findCookieStore(directory);
  if (store === undefined) {
    // **A statement about the record, not about the world.** The previous
    // wording here said the browser had never written a store and that no
    // browser had run against the profile — two claims that a missing file
    // does not support. The file's location varies by Chromium version, and
    // a profile keeping its store somewhere neither candidate names is
    // indistinguishable from one that has genuinely never been used. So this
    // reports what was looked for and where, and concludes nothing.
    //
    // No `cookieCount`: a count from a file that was never opened is a
    // measurement that did not happen, and reporting `0` would re-tell in a
    // number the same overstatement this branch just removed from the prose.
    return {
      evidence: 'undetermined',
      reason: `No cookie store was found at either known location (${COOKIE_STORE_CANDIDATES.map((candidate) => candidate.join('/')).join(' or ')}). Chromium has kept the store in different places across versions, so a profile holding one elsewhere would look exactly like this; nothing is concluded about whether a session exists.`,
    };
  }

  const reader = options.reader ?? realCookieStoreReader();
  const outcome = reader.countCookies(store.file);

  // Said on every branch below that reports an outcome, because the whole
  // value of naming the file is that a reader can go and look at the same one.
  const alsoNote =
    store.alsoPresent.length === 0
      ? ''
      : ` A store is also present at ${store.alsoPresent.join(' and ')}; it is left unread, because a profile migrated between layouts holds both and adding the two together would count one store twice.`;

  if ('error' in outcome) {
    return {
      evidence: 'undetermined',
      storeRelativePath: store.relative,
      reason: `The cookie store at ${store.relative} could not be read (${outcome.error}). A store held open by a running browser is the ordinary cause; nothing is concluded from a read that did not happen.${alsoNote}`,
    };
  }

  if (outcome.count > 0) {
    return {
      evidence: 'session-present',
      cookieCount: outcome.count,
      storeRelativePath: store.relative,
      ...(alsoNote === '' ? {} : { reason: alsoNote.trim() }),
    };
  }

  // Zero. The one branch where the honest answer depends on something else,
  // because a live browser has not necessarily flushed yet — measured, and
  // the reason this parameter exists.
  if (options.browserRunning === true) {
    return {
      evidence: 'undetermined',
      cookieCount: 0,
      storeRelativePath: store.relative,
      reason: `The stored cookie count at ${store.relative} is zero and a browser is running against this profile. A browser writes its cookies down when it shuts down cleanly, so a zero read while one is live means the store has nothing flushed yet rather than that nobody is signed in. Close the browser and ask again.${alsoNote}`,
    };
  }

  // **Nobody measured whether a browser is live, so the zero cannot be read.**
  // A zero means *nothing flushed yet* when a browser is running and *no
  // session stored* when one is not, and those are opposite answers. With the
  // question unasked there is no ground to pick between them, and picking the
  // negative — which is what a defaulted `false` silently did — turns an
  // unasked question into a verdict against the person's installation.
  if (options.browserRunning === undefined) {
    return {
      evidence: 'undetermined',
      cookieCount: 0,
      storeRelativePath: store.relative,
      reason: `The stored cookie count at ${store.relative} is zero, and nothing established whether a browser is running against this profile. A zero means the store has nothing flushed yet while a browser is live, and means no session is stored once one has exited — so without that answer the count does not distinguish the two.${alsoNote}`,
    };
  }

  return {
    evidence: 'no-session-found',
    cookieCount: 0,
    storeRelativePath: store.relative,
    reason: `The profile has a cookie store at ${store.relative}, no browser is running against it, and it holds no cookies. That is what a profile nobody has signed into looks like — though a site that keeps its session only in local storage would look the same, so this is the absence of evidence rather than evidence of absence.${alsoNote}`,
  };
}
