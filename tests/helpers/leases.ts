import { randomUUID } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import type { BrowserId } from '../../src/browser/driver.ts';

/**
 * A lease row, seeded directly, for the tests that need one to hang a tab
 * off.
 *
 * Written here rather than through a service operation on purpose: the rows
 * these tests are about are tab rows, and going through a claim operation
 * would make every one of them fail for reasons belonging to another row's
 * code. The schema's own constraints still apply — the composite foreign key
 * from `tabs` means a tab cannot name a browser its lease did not, so a
 * fixture that got this wrong would be refused by the database rather than
 * silently produce a shape the real path cannot.
 */
export interface SeededClaim {
  readonly claimId: string;
  readonly browserId: BrowserId;
}

export interface SeedClaimOptions {
  readonly browserId?: BrowserId;
  readonly state?: 'queued' | 'active' | 'released' | 'expired' | 'revoked';
}

export function seedClaim(db: Database, options: SeedClaimOptions = {}): SeededClaim {
  const claimId = randomUUID();
  const browserId = options.browserId ?? 'regular';
  const state = options.state ?? 'active';
  const at = new Date().toISOString();

  // A final state owes an end (§1.3's own CHECK), and a queued lease has
  // never had a tab. Both are the schema's rules rather than this helper's,
  // and satisfying them here is what keeps the fixture from being a shape the
  // service could never produce.
  const ended = state === 'queued' || state === 'active' ? null : at;
  const activated = state === 'queued' ? null : at;
  const revokeReason = state === 'revoked' ? 'seeded for a test' : null;

  db.prepare(
    `INSERT INTO claims
       (id, key_hash, session_id, browser_id, state, purpose, expires_at,
        ttl_seconds, activated_at, ended_at, revoke_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    claimId,
    `hash-${claimId}`,
    'session-a',
    browserId,
    state,
    'a seeded lease for a test',
    at,
    600,
    activated,
    ended,
    revokeReason,
  );

  return { claimId, browserId };
}

/**
 * Read a tab row back.
 *
 * Takes whichever handle it is given so a caller can pass a **second,
 * read-only connection** when the claim under test is about what committed.
 * A read through the writing handle sees that handle's own uncommitted
 * writes, which is how a test in this repository once passed while the
 * violation it was written to catch was present.
 */
export function readTab(
  db: Database,
  tabId: string,
): { state: string; driverTabId: string | null; closeFailed: number; closeAttempts: number } {
  return db
    .prepare(
      `SELECT state, driver_tab_id AS driverTabId, close_failed AS closeFailed,
              close_attempts AS closeAttempts
         FROM tabs WHERE id = ?`,
    )
    .get(tabId) as {
    state: string;
    driverTabId: string | null;
    closeFailed: number;
    closeAttempts: number;
  };
}

/** Read a lease's state back, same handle discipline as {@link readTab}. */
export function readClaimState(db: Database, claimId: string): string {
  return (db.prepare(`SELECT state FROM claims WHERE id = ?`).get(claimId) as { state: string })
    .state;
}
