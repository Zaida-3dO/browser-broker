import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step eleven: secrets (`SCHEMA.md` §3.8a) — which tabs have received one, and
 * the `secret_filled` event kind.
 *
 * ── `tab_secrets`: names, never values ──────────────────────────────────
 *
 * A tab that has received a secret is treated differently **for the rest of
 * its lease**: what is read from it is scrubbed, and `evaluate` is refused on
 * it. The service is spawned per caller, so "this tab has received a secret"
 * has to be a fact every process can see — which makes it a row, not a
 * variable. One row per tab per secret name.
 *
 * **Written when an `act` carrying a sentinel is decided**, inside the
 * arbitration transaction and before any browser work, rather than after the
 * secret is typed. That is the conservative direction on purpose: an attempt
 * that typed half a value before failing has still put something in the page,
 * and a row written only on success would leave that tab unguarded.
 *
 * A tab belongs to exactly one lease (§2.3), so keying by tab is keying by
 * lease: a new lease gets a new tab and starts clean.
 *
 * ── `secret_filled`: the audit row ──────────────────────────────────────
 *
 * One per attempt to type a secret, allowed or refused, carrying the name,
 * the origin and the field kind in `detail` — **never the value**. SQLite
 * cannot alter a check in place, so the events table is rebuilt exactly as
 * step six built it, with one more kind.
 */
const STATEMENTS: readonly string[] = [
  `
CREATE TABLE tab_secrets (
  tab_id     TEXT NOT NULL REFERENCES tabs (id),
  name       TEXT NOT NULL
             CHECK (length(name) BETWEEN 1 AND 128),
  first_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tab_id, name)
) STRICT
`,
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
               'browser_signin_began', 'browser_signin_ended',
               -- Added by this step: one row per attempt to type a secret.
               'secret_filled'
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
export const STEP_ELEVEN_SQL: readonly string[] = STATEMENTS;

export const stepEleven: Step = {
  version: 11,
  summary: 'Secrets: the `tab_secrets` table and the `secret_filled` event kind (§3.8a).',
  apply: (db: Database) => {
    for (const statement of STEP_ELEVEN_SQL) {
      db.exec(statement);
    }
  },
};
