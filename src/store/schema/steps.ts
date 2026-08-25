import type { Database } from 'better-sqlite3';

import { stepOne } from './step-001-initial.ts';
import { stepFive } from './step-005-storage-seed-event.ts';
import { stepSix } from './step-006-signin-events.ts';
import { stepFour } from './step-004-tab-never-opened.ts';
import { stepThree } from './step-003-queue-order.ts';
import { stepTwo } from './step-002-tab-budget.ts';

/**
 * The ordered list of schema steps, and the rule that governs it.
 *
 * ── The rule, which is not style ────────────────────────────────────────
 *
 * **Change the schema by adding a step with an `ALTER`, never by editing a
 * step that has already been applied.** A step that has run somewhere is
 * history, and editing one means two installations reporting the same version
 * with different schemas — a difference nothing reports until something
 * breaks far from the cause (`CLAUDE.md`, `SCHEMA.md` §1.2d).
 *
 * Append to the end of this list. Never renumber, never reorder, never edit
 * the body of a step that is already here.
 */

export interface Step {
  /** One-based, contiguous, and never reused. */
  readonly version: number;
  /** What it does, for the person reading the list rather than the code. */
  readonly summary: string;
  readonly apply: (db: Database) => void;
}

export const STEPS: readonly Step[] = [stepOne, stepTwo, stepThree, stepFour, stepFive, stepSix];

/**
 * The version a store must be at for this build to use it.
 *
 * **Stamped, not counted.** A store's version is written into the file and is
 * then compared against by every later build, so it is a fact about what has
 * been applied rather than a fact about this array's shape. Deriving it from
 * the length couples the two: a step deleted or a placeholder appended by
 * somebody who has not read the rule above moves the number every installed
 * store is compared against, and the refusal that protects a store from a
 * build it does not understand starts firing — or stops firing — for a reason
 * nobody wrote down.
 *
 * So the number is written here and the check below is what keeps it honest.
 */
export const EXPECTED_VERSION = 6;

/**
 * The list is consistent with the version above, asserted where the list is
 * defined rather than in a test.
 *
 * A test would prove this on a machine running the tests. This proves it on
 * every spawn, which is the only moment that matters for a store somebody is
 * about to open — and it is the moment the mistake is cheapest to see, because
 * nothing has been written yet.
 */
function assertStepsAreWellFormed(steps: readonly Step[], expected: number): void {
  steps.forEach((step, index) => {
    if (step.version !== index + 1) {
      throw new Error(
        `Schema step ${String(index + 1)} declares version ${String(step.version)}. Steps are one-based and contiguous, in order, and a version is never reused.`,
      );
    }
  });

  const last = steps.at(-1)?.version ?? 0;
  if (last !== expected) {
    throw new Error(
      `The last schema step is version ${String(last)} and this build expects version ${String(expected)}. A step was added without stamping the version, or the version was stamped without the step.`,
    );
  }
}

assertStepsAreWellFormed(STEPS, EXPECTED_VERSION);
