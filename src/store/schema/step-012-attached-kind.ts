import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step twelve: the `attached` browser kind (`DECISIONS.md` §13m).
 *
 * ── What this adds, and what it deliberately changes nothing else about ──
 *
 * Step nine made the kind a database-checked column — *"every row is either a
 * persistent signed-in browser or an ephemeral clean-room one, with no third
 * thing and no row that is neither"* — and that sentence was exactly true of
 * a world with two kinds. The third kind breaks the sentence, not the
 * mechanism: an **attached** browser is a person's own, reached through the
 * attach relay (`src/attach/`), which this service never launches, never
 * closes, and never writes to. It is a browser like no other in one direction
 * only, and the schema says so with one value in one check.
 *
 * **A third value in a check, and nothing else.** Every other column, every
 * other constraint and the two state/pid invariants carry forward unchanged
 * from step nine, including `CHECK (state != 'stopped' OR pid IS NULL)`.
 * That one matters enough to name here: an attached browser has **no pid this
 * service recorded**, because there is no process this service started or
 * adopted, and the invariant that a stopped browser carries no process is
 * precisely the shape an attached row keeps — `stopped`, `pid` null. The
 * store can never be made to claim the broker owns a process it does not.
 *
 * ── Why no rows are seeded here ──────────────────────────────────────────
 *
 * §13i's rule that a browser row appears at first launch rather than from
 * configuration at startup applies to the new kind unchanged: an attached row
 * is written by the claim path the first time a caller names that browser,
 * and two processes holding different attached configurations only ever
 * create rows for browsers somebody actually asked for.
 *
 * **A new step rather than an edit to step nine**, per the rule in
 * `steps.ts`: a step that has run somewhere is history. SQLite cannot alter
 * a check in place, so the table is rebuilt — the same shape step nine used.
 * The copy names every column on both sides because the destination has the
 * same columns as the source: this rebuild rewrites one check, not a schema.
 */
const REBUILD: readonly string[] = [
  `
CREATE TABLE browsers_next (
  -- Unchanged from step nine: the legal names are the configured ones, and
  -- what a name must satisfy is enforced where it is read, in
  -- 'src/config/environment.ts', once, at startup, naming the entry.
  id            TEXT PRIMARY KEY,
  -- **The widened check — the whole of what this step does.** Three kinds,
  -- still total, still no row that is none of them.
  kind          TEXT NOT NULL
                CHECK (kind IN ('regular', 'private', 'attached')),
  state         TEXT NOT NULL DEFAULT 'stopped'
                CHECK (state IN ('stopped', 'starting', 'running', 'signing-in', 'failed')),
  pid           INTEGER,
  launched_at   TEXT,
  endpoint      TEXT,
  browser_uuid  TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0
                CHECK (restart_count >= 0),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  signin_owner_pid INTEGER,
  -- The two invariants step nine carried forward unchanged. The first is
  -- load-bearing for the new kind: an attached browser's process is a
  -- person's own, is not recorded here, and must never be.
  CHECK (state != 'stopped' OR pid IS NULL),
  CHECK (pid IS NOT NULL OR state IN ('stopped', 'signing-in'))
) STRICT
`,
  // Every column present on both sides, named rather than `SELECT *`, so a
  // later widening of either shape cannot shift a value into the wrong
  // column silently.
  `
INSERT INTO browsers_next
  (id, kind, state, pid, launched_at, endpoint, browser_uuid, restart_count,
   created_at, updated_at, signin_owner_pid)
SELECT
  id, kind, state, pid, launched_at, endpoint, browser_uuid, restart_count,
  created_at, updated_at, signin_owner_pid
FROM browsers
`,
  `DROP TABLE browsers`,
  `ALTER TABLE browsers_next RENAME TO browsers`,
];

/** Every statement this step runs, in order. */
export const STEP_TWELVE_SQL: readonly string[] = REBUILD;

export const stepTwelve: Step = {
  version: 12,
  summary: "The `attached` browser kind: a person's own browser, never launched or owned (§13m).",
  apply: (db: Database) => {
    for (const statement of STEP_TWELVE_SQL) {
      db.exec(statement);
    }
  },
};
