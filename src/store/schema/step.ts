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

  return immediate(db, () => {
    const applied: number[] = [];
    for (const step of pending) {
      step.apply(db);
      applied.push(step.version);
    }
    // `user_version` takes no parameter binding, and the value is a number
    // this module computed rather than anything a caller supplied.
    db.pragma(`user_version = ${String(expected)}`);
    return { value: { from, to: expected, applied } };
  });
}
