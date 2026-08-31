import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step nine: a browser's name is free, and its kind is the column.
 *
 * ── What this drops, and it is a decision rather than a widening ────────
 *
 * Step one wrote `CHECK (id IN ('regular', 'private'))` and step seven
 * repeated it through a rebuild. That check is the database's half of
 * *"exactly two browsers, no exceptions, ever"* — the half that makes the
 * sentence true from underneath, since the primary key caps the table at two
 * and step one's seed floors it at two.
 *
 * **That sentence is overturned** (`DECISIONS.md` §13i): the configured
 * browsers are a bounded list per kind rather than a fixed pair, so the set
 * of legal names is not knowable when the schema is written. A check
 * naming two literals cannot express *"a name somebody configured"*, and a
 * check that tried would have to be rewritten every time a name changed —
 * which is a schema step per configuration edit, on a table whose whole
 * purpose is to be configured.
 *
 * ── What stands in its place, so nothing load-bearing is merely dropped ────
 *
 * **`kind` is a column with its own check.** What that constraint
 * actually protects is not the two words: it is that every row is either a
 * persistent signed-in browser or an ephemeral clean-room one, with no third
 * thing and no row that is neither. That property is what the rest of
 * the design branches on — a clean-room browser is launched with an
 * ephemeral profile, a signed-in one is not, and `SCHEMA.md` §5.5.1's
 * sign-in is a claim over a persistent profile.
 *
 * So the kind stays **database-enforced and total** while the name becomes
 * free. This is the same trade §1.2 already made in the other direction:
 * *"No `persistent` flag. Whether a browser uses a persistent profile is a
 * property of which browser it is."* That reasoning held while the name was
 * one of two literals and the word carried the kind. Once a name is
 * `checkout` or `admin`, the word carries nothing, and the property has to
 * be written down or it is not enforced anywhere. **The column exists
 * because the name stopped implying it**, which is the condition §1.2's
 * reasoning was conditional on all along.
 *
 * ── Backfill: the two existing rows are named by what they are ──────────
 *
 * A store stepped by an earlier build holds exactly the rows `regular` and
 * `private`, because that is what the check permitted. Each is backfilled to
 * its own kind by name, which is exact rather than a guess: those two names
 * meant those two kinds, and no other name could exist to be ambiguous.
 *
 * The default is deliberately **absent**. A default would let a later insert
 * that forgot the column produce a row whose kind is a guess, and the row
 * creation this step enables (`DECISIONS.md` §13i — rows are created on
 * first launch, not from configuration at startup) is exactly the writer
 * that must state it.
 *
 * ── Rows are still not created from configuration here ──────────────────
 *
 * This step creates no rows and deletes none. It does not read the
 * configured lists, and could not usefully: two processes on one machine may
 * hold different configurations, and a step that seeded from one process's
 * environment would write that process's beliefs into a store the other one
 * shares. §1.2a already arbitrates the launch race through the same
 * transaction as claims — *"one row, one winner"* — so a row appears when a
 * browser is first launched, created by whichever caller won that race.
 *
 * The two rows step one seeded stay exactly where they are. They are the
 * default configuration's two browsers, and a store that has them is a store
 * that was stepped.
 *
 * **A new step rather than an edit to step one or step seven**, per the rule
 * in `steps.ts`: a step that has run somewhere is history. SQLite cannot
 * alter a check in place, so the table is rebuilt — the same shape step
 * seven used, and for the same reason.
 */
const REBUILD: readonly string[] = [
  `
CREATE TABLE browsers_next (
  -- **No check on the name.** The legal names are the configured ones, which
  -- the schema cannot know. What a name must satisfy is enforced where it is
  -- read: 'src/config/environment.ts' refuses a name that is not a usable
  -- word, once, at startup, naming the entry that was wrong.
  id            TEXT PRIMARY KEY,
  -- **The kind, and it is total.** Every row is a persistent signed-in
  -- browser or an ephemeral clean-room one; there is no third and no row
  -- that is neither. This is what the name used to carry.
  kind          TEXT NOT NULL
                CHECK (kind IN ('regular', 'private')),
  state         TEXT NOT NULL DEFAULT 'stopped'
                CHECK (state IN ('stopped', 'starting', 'running', 'signing-in', 'failed')),
  pid           INTEGER,
  launched_at   TEXT,
  endpoint      TEXT,
  browser_uuid  TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0
                CHECK (restart_count >= 0),
  -- **The defaults are part of the column**, and a rebuild that omits them
  -- silently changes what an INSERT that does not name them does: it stops
  -- defaulting from the database's own clock and starts failing NOT NULL.
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  signin_owner_pid INTEGER,
  -- **A stopped browser has no process.** Unchanged from step one, total,
  -- and it is the direction the reclamation path branches on.
  CHECK (state != 'stopped' OR pid IS NULL),
  -- **A browser with no process is stopped — unless a person has claimed it.**
  -- Step seven's exception, carried forward unchanged: signing in is a claim
  -- over the profile rather than over a process, so it is the one state that
  -- may hold either.
  CHECK (pid IS NOT NULL OR state IN ('stopped', 'signing-in'))
) STRICT
`,
  // The columns are named on both sides rather than `SELECT *`, because the
  // destination carries a column the source does not: a positional copy
  // would shift every value one place to the left from `kind` onward.
  `
INSERT INTO browsers_next
  (id, kind, state, pid, launched_at, endpoint, browser_uuid, restart_count,
   created_at, updated_at, signin_owner_pid)
SELECT
  id,
  -- Exact rather than a guess: the check this step drops permitted these two
  -- names and no others, and each named its own kind.
  CASE id WHEN 'private' THEN 'private' ELSE 'regular' END,
  state, pid, launched_at, endpoint, browser_uuid, restart_count,
  created_at, updated_at, signin_owner_pid
FROM browsers
`,
  `DROP TABLE browsers`,
  `ALTER TABLE browsers_next RENAME TO browsers`,
];

/** Every statement this step runs, in order. */
export const STEP_NINE_SQL: readonly string[] = REBUILD;

export const stepNine: Step = {
  version: 9,
  summary: "A browser's name is configured and its kind is a column (§1.2, DECISIONS.md §13i).",
  apply: (db: Database) => {
    for (const statement of STEP_NINE_SQL) {
      db.exec(statement);
    }
  },
};
