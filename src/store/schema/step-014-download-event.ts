import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step fourteen: the `download` event kind (`SCHEMA.md` §3.18).
 *
 * One row per download, allowed or refused — the same pairing §1.6 insists on
 * for every operation: a ledger that records only the files that came home
 * cannot answer *was the fence ever reached*, and that is the question the
 * site list gets asked the first time a download refuses.
 *
 * **The bytes are not in the row and never are.** `detail` carries the file's
 * host and the ceiling in force at the decision — the whole of what a
 * *decision* can honestly say before any byte moves. The saved name, size and
 * digest belong to the file record handed to the caller, not to this row:
 * recording them would make the ledger a second, staler copy of the artifact
 * index. The query string is absent by the same rule that excludes the
 * address: a signed address in the ledger is a credential with an expiry.
 *
 * SQLite cannot alter a check in place, so the events table is rebuilt
 * exactly as step eleven rebuilt it: a widened table, a copy, a swap, and the
 * four indexes recreated.
 */
const STATEMENTS: readonly string[] = [
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
               'browser_signin_began', 'browser_signin_ended', 'secret_filled',
               -- Added by this step: one row per download, fetched or refused.
               'download'
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
  CHECK ((outcome = 'deny') = (guard IS NOT NULL))
) STRICT
`,
  `INSERT INTO events_next SELECT * FROM events`,
  `DROP TABLE events`,
  `ALTER TABLE events_next RENAME TO events`,
  `CREATE INDEX events_at ON events (at)`,
  `CREATE INDEX events_claim_id ON events (claim_id, id)`,
  `CREATE INDEX events_kind_at ON events (kind, at)`,
  `CREATE INDEX events_guard ON events (guard) WHERE guard IS NOT NULL`,
];

/** Every statement this step runs, in order. */
export const STEP_FOURTEEN_SQL: readonly string[] = STATEMENTS;

export const stepFourteen: Step = {
  version: 14,
  summary: 'The `download` event kind (§3.18).',
  apply: (db: Database) => {
    for (const statement of STEP_FOURTEEN_SQL) {
      db.exec(statement);
    }
  },
};
