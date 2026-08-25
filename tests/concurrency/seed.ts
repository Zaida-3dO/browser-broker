import { createRequire } from 'node:module';

/**
 * Rows written directly, for the states a caller cannot ask for.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THESE TESTS WRITE SQL WHEN THE REST OF THE SUITE REFUSES TO
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Everywhere else in this directory the children drive the real service,
 * deliberately: a worker issuing its own SQL would keep passing after the
 * real code grew a fast path, which is the defect the suite exists to catch.
 *
 * Two properties cannot be set up that way, and the reason is the same for
 * both — **the state under test is one the service will not create on
 * request**:
 *
 * - A **lapsed** claim. Nothing can ask for a lease that has already expired;
 *   the only honest way to have one is to write it, or to wait out a real
 *   lifetime, and the shortest configurable lifetime is still a second per
 *   test with a timing race attached.
 * - A **forced tie** on `created_at`. Callers arriving inside one millisecond
 *   happen by chance, and a test that waits for chance is a test that detects
 *   the defect by chance.
 *
 * So the seeding is confined to this file, it writes only the columns it
 * names, and it goes through the ordinary schema — foreign keys on, checks
 * enforced — so a row it writes is a row the service could have written.
 * What it must never do is stand in for an operation the service *does*
 * offer, and it does not: nothing here grants, queues or releases anything.
 */

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

/** What a seeded queue entry needs beyond the schema's own defaults. */
export interface SeededQueuedClaim {
  readonly id: string;
  /** The counter the queue orders by. */
  readonly arrival: number;
  /** Shared between rows on purpose, to force the tie. */
  readonly createdAt: string;
  readonly browserId: string;
  /** Far enough ahead that the sweep leaves it alone. */
  readonly expiresAt?: string;
  readonly sessionId?: string;
}

/**
 * A queued claim, written as the service would have written it.
 *
 * The expiry defaults to well into the future because these rows exist to be
 * *ordered*, not to be reclaimed — a row that lapsed mid-test would be swept
 * by the next arbitration call and the ordering assertion would be about a
 * shorter queue than the test set up.
 */
export function seedQueuedClaim(databasePath: string, claim: SeededQueuedClaim): void {
  withConnection(databasePath, (db) => {
    db.prepare(
      `INSERT INTO claims
         (id, key_hash, session_id, browser_id, state, purpose,
          expires_at, ttl_seconds, activated_at, arrival, created_at, updated_at)
       VALUES
         (@id, @keyHash, @sessionId, @browserId, 'queued', @purpose,
          @expiresAt, 600, NULL, @arrival, @createdAt, @createdAt)`,
    ).run({
      id: claim.id,
      // A hash column that is unique per row; these rows are never looked up
      // by key, so the value only has to differ.
      keyHash: `seeded-${claim.id}`,
      sessionId: claim.sessionId ?? `session-${claim.id}`,
      browserId: claim.browserId,
      purpose: 'a seeded queue entry, for an ordering assertion',
      expiresAt: claim.expiresAt ?? '2099-01-01T00:00:00.000Z',
      arrival: claim.arrival,
      createdAt: claim.createdAt,
    });
  });
}

/** What a seeded lapsed claim needs. */
export interface SeededLapsedClaim {
  readonly id: string;
  readonly arrival: number;
  readonly browserId: string;
  readonly sessionId: string;
  /** An instant the sweep will consider elapsed, so it reclaims the row. */
  readonly expiresAt: string;
  /** Give it a tab, so the sweep has something to orphan. */
  readonly tabId?: string;
}

/**
 * An **active** claim whose expiry has already passed, and optionally the tab
 * it holds.
 *
 * This is the state the global sweep exists for: a caller that died holding
 * capacity. It is written as `active` rather than as `expired` precisely
 * because the test is about something else noticing — a row already marked
 * expired would prove nothing about reclamation.
 */
export function seedLapsedClaim(databasePath: string, claim: SeededLapsedClaim): void {
  withConnection(databasePath, (db) => {
    db.prepare(
      `INSERT INTO claims
         (id, key_hash, session_id, browser_id, state, purpose,
          expires_at, ttl_seconds, activated_at, arrival, created_at, updated_at)
       VALUES
         (@id, @keyHash, @sessionId, @browserId, 'active', @purpose,
          @expiresAt, 600, @expiresAt, @arrival, @expiresAt, @expiresAt)`,
    ).run({
      id: claim.id,
      keyHash: `seeded-${claim.id}`,
      sessionId: claim.sessionId,
      browserId: claim.browserId,
      purpose: 'a seeded lapsed lease, for a reclamation assertion',
      expiresAt: claim.expiresAt,
      arrival: claim.arrival,
    });

    if (claim.tabId !== undefined) {
      // `driver_tab_id` is mandatory for an open tab and forbidden for one
      // still opening — the schema states the rule as a check, and a tab that
      // has opened has a name the automation tool gave it. Seeding an open
      // tab therefore means seeding that name too.
      db.prepare(
        `INSERT INTO tabs
           (id, claim_id, browser_id, driver_tab_id, state, opened_at, created_at, updated_at)
         VALUES
           (@tabId, @claimId, @browserId, @driverTabId, 'open', @now, @now, @now)`,
      ).run({
        tabId: claim.tabId,
        claimId: claim.id,
        browserId: claim.browserId,
        driverTabId: `driver-${claim.tabId}`,
        now: claim.expiresAt,
      });
    }
  });
}

/**
 * Open, write, close.
 *
 * A connection per seed rather than one held open for the test: these tests
 * spawn processes that contend over the same file, and a writer this process
 * is holding open is a participant in a measurement it is supposed to be
 * setting up.
 */
function withConnection(
  databasePath: string,
  fn: (db: InstanceType<typeof Database>) => void,
): void {
  const db = new Database(databasePath);
  try {
    // The same guarantees the application opens with, so a seeded row is
    // refused by the same constraints a real one would be.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    fn(db);
  } finally {
    db.close();
  }
}
