import fs from 'node:fs';
import path from 'node:path';

// The one place the driver is imported. Keeping it to a single file is what
// makes the storage choice reversible: the built-in module is a plausible
// future once it stops being experimental and stops taking its SQLite
// version from the runtime, and swapping to it is then a change to this file
// rather than to everything that opens a store.
//
// A default import, not a named one: the driver is CommonJS, and under
// `verbatimModuleSyntax` with node-style resolution the named form
// type-checks in some configurations and fails at run time.
import Database from 'better-sqlite3';

import type { Environment } from '../config/environment.ts';
import { agreeOnTabBudget } from './budget.ts';
import { resolveStoreLocation } from './location.ts';
import type { NetworkPathChecks } from './network-path.ts';
import { stepSchema } from './schema/step.ts';
import { immediate, type TransactionResult, type TransactionScope } from './transaction.ts';

/**
 * Open the store: resolve where it is, refuse a network location, create the
 * directory if it is absent, and set the three pragmas that make many
 * processes on one file safe.
 *
 * There is no connection pool and looking for one is looking for the wrong
 * shape (`MILESTONES.md`): a pool shares connections between concurrent work
 * inside one long-lived process, and here the callers are separate operating
 * system processes, each opening the file, doing its work and exiting.
 *
 * ── Opening and stepping are two functions, and `openStore` is the first ──
 *
 * `SCHEMA.md` §1.2d puts stepping on **every spawn**, so `prepareStore` below
 * is what a spawn calls and it does both. They are separate because stepping
 * is asynchronous — it goes through the transaction helper, which is — and an
 * open that had to be awaited would make every test and every caller that
 * wants a handle pay for a schema it may not touch. **A caller that opens
 * without stepping gets a store at whatever version it is at**, which is the
 * right answer for the stepper's own tests and the wrong one for a spawn;
 * `prepareStore` is the name a spawn is meant to reach for.
 */

/** How long a blocked writer waits before giving up, in milliseconds. */
export const BUSY_TIMEOUT_MS = 5000;

export interface StoreHandle {
  /** Where the file is. */
  readonly location: string;
  /**
   * Run work in an immediate transaction. **The only transaction affordance
   * this handle exports** — see `transaction.ts` for what that does and does
   * not guarantee.
   */
  readonly immediate: <T>(
    fn: (scope: TransactionScope) => TransactionResult<T> | Promise<TransactionResult<T>>,
  ) => Promise<T>;
  /** Read a pragma back, which is how the open above is proved rather than assumed. */
  readonly pragma: (statement: string) => unknown;
  readonly close: () => void;
  /**
   * The driver handle. Row #7 needs it to apply schema steps and row #10 needs
   * it inside the service layer; `db.import_isolated` (§7.3) is what keeps
   * every other module from reaching it, and that allowlist lands with code
   * for it to check.
   */
  readonly db: Database.Database;
}

export interface OpenStoreOptions {
  readonly checks?: NetworkPathChecks;
}

/**
 * How many times the conversion to write-ahead-log mode is retried, and how
 * long each attempt waits before the next.
 *
 * Deliberately small. The conversion the retry is waiting on is one pragma on
 * a file with no rows in it yet, so the only thing being waited for is another
 * process finishing something that takes single-digit milliseconds. A budget
 * this size turns the collision into a pause nobody notices; a larger one
 * would turn a genuinely stuck file into a long hang.
 */
const WAL_CONVERSION_ATTEMPTS = 10;
const WAL_CONVERSION_PAUSE_MS = 20;

/**
 * Put the store into write-ahead-log mode, retrying while another process is
 * doing the same thing.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A RETRY AND NOT A LONGER BUSY TIMEOUT — MEASURED, NOT ASSUMED
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Switching a database into write-ahead-log mode **takes an exclusive lock on
 * the file**. On a store already in that mode the pragma is a cheap no-op, so
 * this never shows once an installation is warm. On a **fresh file the first
 * spawn converts it**, and because the service is spawned per session and
 * exits with it, a second spawn arriving during that conversion is the
 * ordinary case on a machine that has never run this.
 *
 * The obvious repair — set `busy_timeout` first and let the second process
 * wait the conversion out — **is not sufficient, and that was measured rather
 * than reasoned about.** The timeout *is* honoured: with the file held by
 * another connection, the conversion waits and then throws `SQLITE_BUSY`
 * anyway, and it waits longer the larger the timeout is (measured at 0, 50,
 * 200 and 1000ms: it threw after 21, 321, 664 and 1787ms respectively, and at
 * five seconds after 7.4). So the timeout buys time and does not buy success —
 * raising it only makes the eventual failure slower.
 *
 * Retrying works because the thing being contended for is transient by
 * construction: the other process is converting the same file to the same
 * mode, and once it has, this call finds the mode already set and returns it
 * without needing any lock at all.
 *
 * **How load-bearing this is, measured:** with the budget cut to a single
 * attempt, two barrier-aligned spawns against an empty directory fail in
 * **9 runs of 10**. It is not a defensive flourish; without it a fresh install
 * where two agents reach for a browser at once usually fails outright.
 *
 * ── One thing this comment will not overclaim ───────────────────────────
 *
 * The `busy_timeout` ordering above is correct and is kept, but **no test
 * fails if it is moved back** — the retry covers that case on its own. It is
 * ordered this way because a timeout configured after the first thing that can
 * block is a timeout that was not configured when it was needed, not because
 * anything currently proves it.
 *
 * **A busy error is the only one retried.** Anything else — a directory that
 * cannot be written, a file that is not a database — is returned to the caller
 * immediately, because retrying a permanent failure ten times only delays the
 * message that says what is actually wrong.
 */
function convertToWriteAheadLog(db: Database.Database, location: string): unknown {
  let lastError: unknown;

  for (let attempt = 0; attempt < WAL_CONVERSION_ATTEMPTS; attempt += 1) {
    try {
      return db.pragma('journal_mode = WAL', { simple: true });
    } catch (error) {
      if ((error as { code?: string }).code !== 'SQLITE_BUSY') {
        throw error;
      }
      lastError = error;

      // A synchronous pause, because everything on this path is synchronous
      // and making the open asynchronous to accommodate a rare retry would
      // change the signature of every caller that wants a handle.
      const until = Date.now() + WAL_CONVERSION_PAUSE_MS;
      while (Date.now() < until) {
        /* waiting for the other process to finish converting */
      }
    }
  }

  throw new Error(
    `The store at ${location} could not be put into write-ahead-log mode after ${String(WAL_CONVERSION_ATTEMPTS)} attempts: another process held the file locked throughout. That mode is what lets several processes share this file. The underlying error was: ${String((lastError as { message?: string }).message ?? lastError)}`,
  );
}

export function openStore(environment: Environment, options: OpenStoreOptions = {}): StoreHandle {
  const location = resolveStoreLocation(environment, options.checks);

  // Created on first spawn, not at install time. An install step that
  // prepares state is a second lifecycle, and installation is the whole of
  // deployment here.
  fs.mkdirSync(path.dirname(location), { recursive: true });

  const db = new Database(location);

  // ── The busy timeout is set BEFORE the journal mode, and that ordering is
  //    necessary but on its own not sufficient ─────────────────────────────
  //
  // Ordinary lock contention: a blocked writer waits rather than failing at
  // once. What this does **not** do is worth knowing before somebody reads
  // the line and concludes retries are handled — the busy-snapshot error a
  // deferred transaction raises is not retryable by this setting at all
  // (§1.0a). The transaction mode is what addresses that, not this number.
  //
  // It precedes the conversion below because the conversion is the first
  // thing on this path that can block, and a timeout set after it is a
  // timeout that was not configured at the moment it was needed.
  db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);

  // The mode that lets several processes read while one writes, which is the
  // whole basis of the concurrency model (§1.0a). Asserted rather than
  // assumed: the pragma returns the mode it actually set.
  const journalMode = convertToWriteAheadLog(db, location);
  if (journalMode !== 'wal') {
    throw new Error(
      `The store could not be opened in write-ahead-log mode; the journal mode is ${String(journalMode)}. That mode is what lets several processes share this file.`,
    );
  }

  // Set explicitly, and the reason is not that the engine defaults it off.
  // The driver in use is compiled with foreign keys defaulted on, so this
  // pragma is a restatement of what it already does rather than a change to
  // it. It is set because **a correctness guarantee must not rest on a
  // third-party dependency's compile-time flag**: that
  // flag is not part of the driver's public interface, and a rebuild from
  // source, a differently packaged build, or the driver swap this file's own
  // import comment contemplates could all change it with nothing to notice.
  // Row #7's composite foreign key on tabs — the one that stops a tab naming
  // a browser its own lease did not — is the guarantee being protected.
  db.pragma('foreign_keys = ON');

  return {
    location,
    immediate: (fn) => immediate(db, fn),
    pragma: (statement) => db.pragma(statement, { simple: true }),
    close: () => {
      db.close();
    },
    db,
  };
}

/**
 * What a spawn calls: open the store and step it to the version this build
 * expects, in that order, before anything else happens.
 *
 * `startup.schema_stepped` (§7.2) and §1.2d — **on every spawn, not just the
 * first**. There is no deployment moment at which "run the migrations" could
 * be a separate act: a caller that has just upgraded and a caller that has not
 * may both spawn within the same minute, so the check belongs on every spawn
 * or it belongs nowhere. A store already at the right version is left
 * untouched, so the ordinary cost of this is a version read.
 *
 * **The handle is closed if stepping refuses**, because a caller that gets a
 * throw has no handle to close and the file would otherwise be held open by a
 * process that has already decided not to run.
 */
export async function prepareStore(
  environment: Environment,
  options: OpenStoreOptions = {},
): Promise<StoreHandle> {
  const store = openStore(environment, options);
  try {
    await stepSchema(store.db);
    // `budget.agrees_with_store` (§7.2), and it runs **after** stepping
    // because the row it compares against is part of the schema. A process
    // whose environment disagrees with the store refuses here rather than
    // arbitrating against a bound the other processes are not using.
    agreeOnTabBudget(store.db, environment.tabBudget);
  } catch (error) {
    store.close();
    throw error;
  }
  return store;
}
