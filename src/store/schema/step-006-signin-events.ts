import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step six: signing in becomes recordable — `browser_signin_began` and
 * `browser_signin_ended` (`SCHEMA.md` §5.5.1).
 *
 * **A new step rather than an edit to step five**, per the rule that a step
 * which has run somewhere is history (`CLAUDE.md`, `SCHEMA.md` §1.2d). SQLite
 * cannot alter a check in place, so the table is rebuilt — which is why this
 * step is longer than the two values it adds.
 *
 * ── Why signing in needs kinds of its own ───────────────────────────────
 *
 * §5.5.1 makes signing in a **service operation** rather than something a
 * person does to a browser directly, and the reason it gives is the one that
 * makes these rows necessary: it *"refuses if any live lease holds a tab on
 * that browser"*, and while it is in progress *"requests for it are refused
 * with a retry hint"*. So the service spends a period deliberately turning
 * callers away, and §1.6 requires **every decision, allowed and refused
 * alike**.
 *
 * Without a kind for the two edges, that period is invisible in the ledger:
 * a reader would see a run of `browser_unavailable` denials with nothing
 * saying why the browser was unavailable, and the obvious reading of a
 * cluster of denials is a fault. **These two rows are what make the
 * difference between "the browser was broken" and "a person was signing in"
 * a query rather than a guess** — which is the same argument §1.6 makes for
 * the kind column being a fixed list at all.
 *
 * Two kinds rather than one with a direction field, because the pair brackets
 * an interval and the questions asked of it are asked of the edges: when did
 * this start, did it ever finish, is one open right now. A single kind would
 * make "is a sign-in open" a scan that reads every row's JSON and counts,
 * rather than a comparison of two counts.
 *
 * ── What the rows carry, and what they must never carry ─────────────────
 *
 * **Which browser, and when. Never anything a person typed.** A sign-in is
 * the one moment where credentials are physically present at the machine, and
 * the ledger is a file that gets read, copied and pasted into messages. What
 * a sign-in produces lives in the browser's own profile directory (§1.2) and
 * is written there by the browser; **nothing in this service ever sees it**,
 * so there is nothing here to leak by accident — but the rule is stated
 * because the row is built by hand and a well-meaning addition would be the
 * way it stopped being true. Nothing in the schema can enforce it — `detail`
 * is text — so it is enforced where the row is built (`sign-in.ts`) and
 * asserted by a test that reads the ledger back.
 */
const REBUILD: readonly string[] = [
  `
CREATE TABLE events_next (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind       TEXT NOT NULL
             CHECK (kind IN (
               'claim_requested', 'claim_granted', 'claim_queued', 'claim_promoted',
               'claim_renewed', 'claim_released', 'claim_expired', 'claim_revoked',
               'tab_opening', 'tab_open_failed', 'tab_closing',
               'navigate', 'act', 'read', 'evaluate', 'capture', 'compare',
               'browser_launched', 'browser_adopted', 'browser_exited',
               'launch_race_lost', 'sweep', 'storage_seeded',
               -- Added by this step. The two edges of the one interval in
               -- which this service turns callers away on purpose, so that
               -- period is legible as a sign-in rather than as a fault.
               'browser_signin_began', 'browser_signin_ended'
             )),
  outcome    TEXT NOT NULL
             CHECK (outcome IN ('allow', 'deny')),
  guard      TEXT,
  claim_id   TEXT REFERENCES claims (id),
  tab_id     TEXT REFERENCES tabs (id),
  session_id TEXT,
  adapter    TEXT NOT NULL
             CHECK (adapter IN ('tool-stdio', 'tool-http', 'cli', 'internal')),
  browser_id TEXT REFERENCES browsers (id),
  detail     TEXT,
  -- A guard names the rule that refused, so it belongs on a denial and means
  -- nothing on an allow.
  CHECK ((outcome = 'deny') = (guard IS NOT NULL))
) STRICT
`,
  // The identifier is a cursor callers may already hold (§1.6), so the copy
  // preserves it rather than letting AUTOINCREMENT reissue from one.
  `INSERT INTO events_next SELECT * FROM events`,
  `DROP TABLE events`,
  `ALTER TABLE events_next RENAME TO events`,
  // Rebuilt with the table, because dropping it took them with it. Identical
  // to step one's, which is what keeps this a change to one check constraint
  // and nothing else — a rebuild that quietly loses an index is a rebuild
  // that changes the performance of every ledger read.
  `CREATE INDEX events_at ON events (at)`,
  `CREATE INDEX events_claim_id ON events (claim_id, id)`,
  `CREATE INDEX events_kind_at ON events (kind, at)`,
  `CREATE INDEX events_guard ON events (guard) WHERE guard IS NOT NULL`,
];

/** Every statement this step runs, in order. */
export const STEP_SIX_SQL: readonly string[] = REBUILD;

export const stepSix: Step = {
  version: 6,
  summary: 'Signing in is recordable: the two `browser_signin_*` event kinds (§5.5.1).',
  apply: (db: Database) => {
    for (const statement of STEP_SIX_SQL) {
      db.exec(statement);
    }
  },
};
