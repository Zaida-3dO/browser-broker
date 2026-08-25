import type { Database } from 'better-sqlite3';

import { StartupRefusal } from '../../errors.ts';
import { immediate } from '../transaction.ts';
import { EXPECTED_VERSION, STEPS, type Step } from './steps.ts';

/**
 * Step a store from whatever version it is at to the version this build
 * expects.
 *
 * `SCHEMA.md` §1.2d: the schema is a version stepper the service applies to
 * its own store **on every spawn**, rather than a migration tool somebody
 * runs as a deployment step. There is no deployment moment at which "run the
 * migrations" could be a separate act: a caller that has just upgraded and a
 * caller that has not may both spawn within the same minute, so the check
 * belongs on every spawn or it belongs nowhere. A store already at the right
 * version is left untouched.
 *
 * The steps between the two versions are applied **in order, in one
 * transaction**.
 */

/**
 * `startup.schema_stepped` (§7.2): **a store at a version this build does not
 * understand is a refusal, not an attempted downgrade.** Two callers on
 * different builds against one store is an ordinary situation here, and
 * guessing is how one of them corrupts it.
 *
 * This refusal lands before any step exists, deliberately. A stepper that
 * only knows how to step *up* is the one somebody later extends with a
 * well-meaning downgrade path; landing the refusal first makes that a change
 * to existing behaviour rather than a gap somebody fills.
 */
export function readStoreVersion(db: Database): number {
  const row = db.pragma('user_version', { simple: true });
  return typeof row === 'number' ? row : 0;
}

export interface StepResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly number[];
}

export async function stepSchema(
  db: Database,
  steps: readonly Step[] = STEPS,
  expected: number = EXPECTED_VERSION,
): Promise<StepResult> {
  const from = readStoreVersion(db);

  if (from > expected) {
    throw new StartupRefusal(
      'startup.schema_stepped',
      `The store is at schema version ${String(from)} and this build understands version ${String(expected)}. A store newer than the build is refused rather than downgraded: two callers on different builds against one store is ordinary here, and guessing is how one of them corrupts it. Upgrade this installation.`,
    );
  }

  if (from === expected) {
    return { from, to: expected, applied: [] };
  }

  const pending = steps.filter((step) => step.version > from).sort((a, b) => a.version - b.version);

  // ── Foreign keys are suspended for the duration of the steps ────────────
  //
  // **This is SQLite's documented table-rebuild procedure, and it is required
  // rather than convenient.** A step that changes a check constraint cannot
  // alter it in place: the table has to be rebuilt, which means dropping a
  // table that another table references — and that violates the reference
  // *even when the rebuild is going to restore every row*.
  //
  // The failure this prevents is total and was reproduced on this path before
  // the guard existed: `feedback.last_event_id` references `events (id)`, so
  // rebuilding `events` failed with a foreign-key violation on **any store
  // that had feedback naming an event**. `prepareStore` rethrows and there is
  // no long-lived process, so every spawn failed — an installation
  // permanently unable to start, and specifically the installations used
  // enough to have collected feedback.
  //
  // **Why it is here rather than at the four call sites.** The pragma is a
  // **no-op inside a transaction** — SQLite silently ignores it and it reads
  // back unchanged — so it has to be set before `BEGIN`, which is inside this
  // function. Putting it in the callers would mean four places to get right
  // and a fifth caller that misses it; this function owns the transaction, so
  // it owns the pragma that has to wrap it.
  //
  // **What is given up, stated plainly:** during the steps the database does
  // not enforce references, so a step that orphaned a row would not be caught
  // as it ran. That is why the integrity check below is not optional — it is
  // the enforcement, re-applied in one pass before the version is stamped.
  const foreignKeysWereOn = db.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysWereOn) {
    db.pragma('foreign_keys = OFF');
  }

  try {
    // **Awaited, not returned.** `immediate` is asynchronous, so returning its
    // promise would run the `finally` below — restoring the pragma — before
    // the transaction had even begun, which puts enforcement back on for the
    // rebuild it was suspended for. The await is what makes the restore
    // happen after the steps rather than during them.
    return await immediate(db, () => {
      const applied: number[] = [];
      for (const step of pending) {
        step.apply(db);
        applied.push(step.version);
      }

      // **The enforcement that was suspended, re-applied as a check before
      // anything is committed.** `foreign_key_check` reports every row whose
      // reference does not resolve, and it is read *inside* the transaction
      // so a step that broke a reference rolls back rather than committing a
      // store whose integrity nothing will re-examine.
      //
      // This is the assertion that makes suspending the pragma safe rather
      // than merely quiet: without it, turning enforcement off would trade a
      // loud failure for a silent one.
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new StartupRefusal(
          'startup.schema_stepped',
          `Stepping the schema from version ${String(from)} to ${String(expected)} left ${String(violations.length)} row(s) naming something that does not exist. The store has been left at version ${String(from)} rather than committed in that state.`,
        );
      }

      // `user_version` takes no parameter binding, and the value is a number
      // this module computed rather than anything a caller supplied.
      db.pragma(`user_version = ${String(expected)}`);
      return { value: { from, to: expected, applied } };
    });
  } finally {
    // Restored on the way out whatever happened, including a step that threw:
    // a caller that opened the store with references enforced gets a handle
    // with them enforced, and a failed upgrade does not silently leave the
    // connection weaker than the caller asked for.
    if (foreignKeysWereOn) {
      db.pragma('foreign_keys = ON');
    }
  }
}
