import type { Database } from 'better-sqlite3';

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
 *
 * ── Why this list is empty ──────────────────────────────────────────────
 *
 * Step one is the whole schema and it belongs to row #7 (`MILESTONES.md`).
 * Landing a partial schema here to give the stepper something to do would be
 * the worst possible favour to that row: the half-schema would immediately be
 * history, and #7 would be forbidden from editing it.
 */

export interface Step {
  /** One-based, contiguous, and never reused. */
  readonly version: number;
  /** What it does, for the person reading the list rather than the code. */
  readonly summary: string;
  readonly apply: (db: Database) => void;
}

export const STEPS: readonly Step[] = [];

/** The version a store must be at for this build to use it. */
export const EXPECTED_VERSION: number = STEPS.length;
