import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step seven: a browser can be claimed for a person before it has a process.
 *
 * ── The constraint this widens, and why it was right to begin with ──────
 *
 * Step one states it as `(state = 'stopped') = (pid IS NULL)`, with the
 * reason that *"a stopped browser has no process, and a running one has
 * one"*, expressed as a constraint rather than a convention because the
 * reclamation path branches on the process being absent. Every state that
 * existed when it was written was either *stopped*, or *a process is doing
 * something*, so the biconditional was exactly true.
 *
 * ── What `signing-in` turned out to be, which the constraint did not cover ──
 *
 * `SCHEMA.md` §5.5.1 makes signing in a claim over the **profile**, not over
 * a process: *"What the command does is claim the browser for the person"*,
 * and *"nothing is stopped and nothing is relaunched"*. The claim has to be
 * taken **before** a window is handed over, because its whole purpose is to
 * stop a caller opening a tab in a browser somebody is about to drive by
 * hand — a claim taken after the window appeared would be a guard that
 * announced itself once the race was already lost.
 *
 * So there is a real and ordinary state that constraint makes unwritable:
 * **the browser is not running, and a person has claimed it in order to sign
 * in.** That is what a first sign-in on a fresh installation *is* — nobody
 * has started a browser, which is precisely why nobody is signed in. The
 * store rejected it with a check-constraint failure, which is the correct
 * behaviour of a constraint that had been told something narrower than the
 * truth.
 *
 * ── What is kept, and it is the part that was load-bearing ──────────────
 *
 * The direction the reclamation path relies on is **unchanged and still
 * total**: a row that says `stopped` still has no process, and a row with a
 * process still does not say `stopped`. Nothing that branches on *is there a
 * process to reclaim* sees a different answer than before.
 *
 * What is relaxed is only the other direction, and only for one state: a
 * browser that is `signing-in` may have a process or may not, because a
 * person can be signing into one that is already up or into one that is
 * being started for them. Every other non-stopped state still requires a
 * process, so this does not become "the constraint means nothing now" —
 * `starting`, `running` and `failed` are each still tied to one.
 *
 * **A new step rather than an edit to step one**, per the rule that a step
 * which has run somewhere is history. SQLite cannot alter a check in place,
 * so the table is rebuilt.
 */
const REBUILD: readonly string[] = [
  `
CREATE TABLE browsers_next (
  id            TEXT PRIMARY KEY
                CHECK (id IN ('regular', 'private')),
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
  -- **A stopped browser has no process.** Unchanged from step one, total,
  -- and it is the direction the reclamation path branches on.
  CHECK (state != 'stopped' OR pid IS NULL),
  -- **A browser with no process is stopped — unless a person has claimed it.**
  -- Step one's other direction, with the single exception §5.5.1 requires:
  -- signing in is a claim over the profile rather than over a process, taken
  -- before a window is handed over, so it is the one state that may hold
  -- either. Starting, running and failed each still require a process.
  CHECK (pid IS NOT NULL OR state IN ('stopped', 'signing-in'))
) STRICT
`,
  `INSERT INTO browsers_next SELECT * FROM browsers`,
  `DROP TABLE browsers`,
  `ALTER TABLE browsers_next RENAME TO browsers`,
];

/** Every statement this step runs, in order. */
export const STEP_SEVEN_SQL: readonly string[] = REBUILD;

export const stepSeven: Step = {
  version: 7,
  summary: 'A browser may be claimed for a person before it has a process (§5.5.1).',
  apply: (db: Database) => {
    for (const statement of STEP_SEVEN_SQL) {
      db.exec(statement);
    }
  },
};
