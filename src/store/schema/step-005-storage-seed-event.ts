import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step five: `storage_seeded` becomes a recordable event kind (row #65).
 *
 * **A new step rather than an edit to step one**, per the rule that a step
 * which has run somewhere is history (`CLAUDE.md`, `SCHEMA.md` §1.2d). SQLite
 * cannot alter a check in place, so the table is rebuilt — which is why this
 * step is longer than the one value it adds.
 *
 * ── Why the seed needs a kind of its own ────────────────────────────────
 *
 * `SCHEMA.md` §3.2 asks a specific question of the ledger: *"which leases
 * started life already holding a credential"*. That is a question about a
 * category of lease, so it has to be answerable by selecting on one — and a
 * seed folded into the `claim_granted` row's detail would only be findable by
 * reading every grant's JSON and testing for a key. **A kind is what makes it
 * a query rather than a scan**, which is the same argument §1.6 makes for the
 * kind column being a fixed list at all.
 *
 * It is recorded as its own row rather than as a field on the grant for a
 * second reason: the seed is applied **after** the arbitration transaction
 * commits, because writing storage is browser work and browser work never
 * happens inside the transaction (§2.4b). The grant row is written before the
 * seeding has happened, so a field on it would be a claim about the future.
 *
 * ── What the row carries, and what it must never carry ──────────────────
 *
 * **Origins and keys, never values.** §3.2 states it outright and gives the
 * reason §3.9 gives about cookie values: the question needs an answer and the
 * answer does not need the credential in it. Nothing in the schema can
 * enforce that — `detail` is text — so it is enforced where the row is built
 * (`storage-seed.ts`) and asserted by a test that reads the ledger back and
 * looks for the value it seeded.
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
               'launch_race_lost', 'sweep',
               -- Added by this step. The origins and the keys of a seeded
               -- lease, and never the values.
               'storage_seeded'
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
export const STEP_FIVE_SQL: readonly string[] = REBUILD;

export const stepFive: Step = {
  version: 5,
  summary: 'A seeded lease is recordable: the `storage_seeded` event kind (#65).',
  apply: (db: Database) => {
    for (const statement of STEP_FIVE_SQL) {
      db.exec(statement);
    }
  },
};
