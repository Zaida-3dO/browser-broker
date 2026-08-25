import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step four: a tab that ended without ever opening becomes representable.
 *
 * **A new step rather than an edit to step one**, per the rule that a step
 * which has run somewhere is history (`CLAUDE.md`, `SCHEMA.md` §1.2d).
 * SQLite cannot alter a check in place, so the table is rebuilt — which is
 * why this step is longer than the change it makes.
 *
 * ── The defect, and why the constraint rather than the writer is wrong ───
 *
 * Step one carries `CHECK ((state = 'opening') = (driver_tab_id IS NULL))`,
 * an **equivalence**: a null driver name is permitted on `opening` and
 * nowhere else. Its own comment gives the reason it exists, and the reason is
 * narrower than the rule it wrote:
 *
 * > A tab that has not opened has no driver name to be unique against, and
 * > one that has opened does. **Without this the partial unique index below
 * > would be satisfied by any number of live rows holding null.**
 *
 * That index is `one_row_per_physical_tab`, and it covers
 * `state IN ('opening', 'open', 'closing')`. **`closed` and `failed` are
 * outside it**, so a null driver name on a closed row cannot dilute a
 * uniqueness rule that does not range over it. The equivalence constrains two
 * states its own justification never reaches.
 *
 * ── What that cost, measured ────────────────────────────────────────────
 *
 * A lease ends in one of two ways and both have to write the tab row.
 * A tab that never opened has no driver name, so **every** terminal state was
 * refused for it: `closing` is dishonest (§1.4 — nothing was asked and no
 * page may still exist), and `closed` was forbidden by the equivalence. The
 * row could not leave `opening`, so the update threw.
 *
 * Because the sweep runs unconditionally before every handler (§1.0a, and
 * that is correct), **one lapsed lease holding such a tab made every
 * arbitration call by every caller throw, permanently and across spawns** —
 * the lapsed row could never be swept, because sweeping it was the operation
 * that threw. A lapsing lease is the ordinary case the lazy sweep exists to
 * serve (§2.4), so this was the main line rather than an edge.
 *
 * ── The narrowing, stated exactly ───────────────────────────────────────
 *
 * | State | Driver name | Before | Now |
 * |---|---|---|---|
 * | `opening` | null | required | **required**, unchanged |
 * | `open` · `closing` | present | required | **required**, unchanged |
 * | `closed` · `failed` | either | null refused | **permitted** |
 *
 * The live states keep the rule exactly as it was, which is the whole of what
 * the index needs. What becomes representable is the true fact the design had
 * no way to record: **a tab whose lease ended before the tab ever opened.**
 * Nothing is loosened while a tab is live.
 */
const REBUILD: readonly string[] = [
  `
CREATE TABLE tabs_next (
  id             TEXT PRIMARY KEY,
  claim_id       TEXT NOT NULL,
  browser_id     TEXT NOT NULL,
  driver_tab_id  TEXT,
  state          TEXT NOT NULL
                 CHECK (state IN ('opening', 'open', 'closing', 'closed', 'failed')),
  opened_at      TEXT,
  closed_at      TEXT,
  close_failed   INTEGER NOT NULL DEFAULT 0
                 CHECK (close_failed IN (0, 1)),
  close_attempts INTEGER NOT NULL DEFAULT 0
                 CHECK (close_attempts >= 0),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (claim_id, browser_id) REFERENCES claims (id, browser_id),
  -- Narrowed to the live states, which are the ones the partial unique index
  -- ranges over. A tab still live must say whether it has a driver name; one
  -- that has finished may have ended before it ever acquired one.
  CHECK (
    state NOT IN ('opening', 'open', 'closing')
    OR (state = 'opening') = (driver_tab_id IS NULL)
  )
) STRICT
`,
  `INSERT INTO tabs_next SELECT * FROM tabs`,
  `DROP TABLE tabs`,
  `ALTER TABLE tabs_next RENAME TO tabs`,
  // Rebuilt with the table, because dropping it took them with it. Identical
  // to step one's, which is what keeps this a change to one constraint.
  `CREATE UNIQUE INDEX one_row_per_physical_tab
     ON tabs (browser_id, driver_tab_id) WHERE state IN ('opening', 'open', 'closing')`,
  `CREATE INDEX tabs_claim ON tabs (claim_id)`,
];

/** Every statement this step runs, in order. */
export const STEP_FOUR_SQL: readonly string[] = REBUILD;

export const stepFour: Step = {
  version: 4,
  summary: 'A tab may end without ever having opened; the driver-name rule narrows to live states.',
  apply: (db: Database) => {
    for (const statement of STEP_FOUR_SQL) {
      db.exec(statement);
    }
  },
};
