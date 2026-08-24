import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step two: the one row that is not an environment variable.
 *
 * **A new step rather than an edit to step one**, which is the rule rather
 * than a preference (`CLAUDE.md`, `SCHEMA.md` §1.2d): step one has run
 * somewhere, and editing a step that has run means two installations
 * reporting the same version with different schemas — a difference nothing
 * reports until something breaks far from the cause.
 *
 * ── Why this table exists at all, when §1.10 deletes the settings table ──
 *
 * It is a **check**, not a configuration surface, and the difference is that
 * nothing can write to it through any caller-reachable path. §1.10:
 *
 * > Several processes arbitrate against the tab budget simultaneously
 * > (§1.0a) [...] Each admits callers against its own belief, each is
 * > internally consistent, and **the ceiling silently stops being a
 * > ceiling.**
 *
 * The budget stays an environment variable. This row is what makes several
 * processes' beliefs about it comparable, and `src/store/budget.ts` is the
 * only thing that reads or writes it.
 *
 * **One row, kept by the database rather than by a convention.** `only_row`
 * is pinned to a single value by a check and made unique by the primary key,
 * so a second row cannot be inserted even by a statement written somewhere
 * this design never sees. That is what stops a one-row check quietly becoming
 * a key-value store, which is the shape §1.10 rejected.
 */
const TAB_BUDGET = `
CREATE TABLE tab_budget (
  only_row   INTEGER PRIMARY KEY
             CHECK (only_row = 1),
  -- The same bound the environment carries, recorded by whichever process
  -- opened this store first. Never adopted and never overwritten after that:
  -- a later process that disagrees refuses to start (7.2).
  tabs       INTEGER NOT NULL
             CHECK (tabs > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT
`;

/** Every statement this step runs. */
export const STEP_TWO_SQL: readonly string[] = [TAB_BUDGET];

export const stepTwo: Step = {
  version: 2,
  summary: 'The tab-budget agreement row: one value, one row, no caller-reachable write path.',
  apply: (db: Database) => {
    for (const statement of STEP_TWO_SQL) {
      db.exec(statement);
    }
  },
};
