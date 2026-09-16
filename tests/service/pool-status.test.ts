import assert from 'node:assert/strict';
import test from 'node:test';

import type { Database } from 'better-sqlite3';

import type { BrowserId } from '../../src/browser/driver.ts';
import { withBroker } from '../helpers/broker.ts';
import { seedClaim, type SeededClaim } from '../helpers/leases.ts';
import { readPoolStatus } from '../../src/service/operations/pool-status.ts';

/**
 * The keyless half of `browser_status` (§3.3).
 *
 * ── What these are really asserting ─────────────────────────────────────
 *
 * Two properties, and they pull in opposite directions, which is why both are
 * pinned. The answer has to be **useful enough** that a caller whose browser
 * is wedged learns something it can act on, and **narrow enough** that it is
 * not a read of other callers' state — the objection that keeps `reconcile`
 * off the agent surface entirely (§3.13) and governs `compare_to` (§1.9).
 *
 * The resolution §3.3 settles on is **counts, never identities**, and the
 * disclosure test below is the one that holds it there. It is written against
 * the serialised response rather than against named fields on purpose: a
 * later edit that adds `sessionId` to the browser view, or carries a lease's
 * `purpose` through for context, would pass any assertion that only checked
 * the fields somebody remembered to name.
 */

/**
 * A lease that is **still live when it is read**, which the shared seed does
 * not produce on its own.
 *
 * `seedClaim` writes `expires_at` at the instant it runs, so by the time
 * anything derives against a later clock reading the lease has already
 * lapsed. That is exactly right for the tab-lifecycle tests it was written
 * for — they want a lease with a tab hanging off it and do not derive — and
 * exactly wrong here, where **every count is derived** (§2.4) and a lapsed
 * lease correctly counts for nothing.
 *
 * Pushing the expiry out is therefore part of the fixture rather than a
 * workaround: a test asserting that two live leases are counted has to have
 * two live leases. The `state` column is left as the shared helper wrote it,
 * so the row is one the service could really produce.
 */
function seedLiveClaim(
  db: Database,
  options: { browserId: BrowserId; state: 'active' | 'queued'; sessionId?: string },
): SeededClaim {
  const lease = seedClaim(db, options);
  db.prepare('UPDATE claims SET expires_at = ? WHERE id = ?').run(
    new Date(Date.now() + 600_000).toISOString(),
    lease.claimId,
  );
  return lease;
}

test('the pool answers with no key, and reports capacity a caller can act on', async () => {
  await withBroker(({ store }) => {
    seedLiveClaim(store.db, { browserId: 'regular', state: 'active' });
    seedLiveClaim(store.db, { browserId: 'regular', state: 'active' });

    const pool = readPoolStatus(store.db);

    assert.equal(pool.tabsInUse, 2, 'two live leases were not counted as two tabs in use');
    assert.equal(pool.queueDepth, 0);
    assert.ok(pool.at.length > 0, 'the report names no instant, so its counts are undatable');
    assert.ok(
      pool.browsers.some((browser) => browser.id === 'regular'),
      'the configured browsers are not reported',
    );
    assert.ok(
      pool.advice.length > 0,
      'the response carries no advice; a caller reading this is usually already stuck',
    );
  });
});

test('a queued caller is counted in the depth, not in the tabs in use', async () => {
  // The distinction a caller acts on: tabs in use says whether there is room,
  // and queue depth says how long a wait is likely. Collapsing them would
  // report a waiting caller as consuming the capacity it is waiting for.
  await withBroker(({ store }) => {
    seedLiveClaim(store.db, { browserId: 'regular', state: 'active' });
    seedLiveClaim(store.db, { browserId: 'regular', state: 'queued' });

    const pool = readPoolStatus(store.db);

    assert.equal(pool.tabsInUse, 1, 'a queued lease was counted as holding a tab');
    assert.equal(pool.queueDepth, 1, 'a queued lease was not counted as waiting');
  });
});

test('a lease that has ENDED does not hold capacity in the answer', async () => {
  // §2.4: **stored state is provisional, derived state is the truth.** A row
  // saying `active` past its expiry is a lapsed lease the sweep has not
  // reached yet, and this read deliberately does not sweep — so if it read
  // the stored column it would report a full pool that is actually empty,
  // which is the reader-rule defect (§5.2) exactly.
  await withBroker(({ store }) => {
    seedClaim(store.db, { browserId: 'regular', state: 'released' });
    seedClaim(store.db, { browserId: 'regular', state: 'expired' });
    seedClaim(store.db, { browserId: 'regular', state: 'revoked' });

    const pool = readPoolStatus(store.db);

    assert.equal(pool.tabsInUse, 0, 'an ended lease was reported as holding a tab');
    assert.equal(pool.queueDepth, 0);
  });
});

test('THE KEYLESS ANSWER NAMES NOBODY — counts, never identities', async () => {
  // §3.3's whole admissibility argument. An unkeyed caller may learn that the
  // pool is full; it may not learn whose work filled it, what that work is
  // for, or anything it could use to address another caller's tab.
  //
  // Two callers with distinguishable session identifiers and purposes, so the
  // test can tell a report that leaks them from one that does not — a single
  // seeded lease could not, because the defaulted values would be the only
  // ones present and a leak would have nothing to contrast against.
  await withBroker(({ store }) => {
    const first = seedLiveClaim(store.db, {
      browserId: 'regular',
      state: 'active',
      sessionId: 'session-alpha-holds-the-login',
    });
    const second = seedLiveClaim(store.db, {
      browserId: 'private',
      state: 'queued',
      sessionId: 'session-beta-is-waiting',
    });

    const pool = readPoolStatus(store.db);
    // Serialised, so this catches a field nobody thought to name as well as
    // the ones named below. A test listing only known fields would go green
    // on the next field somebody adds "for context".
    const serialised = JSON.stringify(pool);

    for (const secret of [
      'session-alpha-holds-the-login',
      'session-beta-is-waiting',
      first.claimId,
      second.claimId,
      // The default purpose the seed writes. A pool report carrying a lease's
      // purpose would be telling an unkeyed caller what somebody else's work
      // is for.
      'seeded',
    ]) {
      assert.equal(
        serialised.includes(secret),
        false,
        `the keyless pool answer disclosed "${secret}" — it must carry counts, never identities (§3.3)`,
      );
    }

    // And the counts it is allowed to carry are still there, so the assertion
    // above cannot be satisfied by returning nothing at all.
    assert.equal(pool.tabsInUse, 1);
    assert.equal(pool.queueDepth, 1);
  });
});

test('reading the pool RENEWS NOTHING and sweeps nothing', async () => {
  // The property that keeps this outside arbitration (§3.3). A keyless caller
  // holds no lease, so there is nothing to renew — and a sweep charged to it
  // would put the cheapest question on the surface inside the transaction
  // every other caller waits behind.
  //
  // Asserted as *the rows did not move*: a read that renewed would push an
  // expiry out, and one that swept would end the lapsed lease it found.
  await withBroker(({ store, readCommitted }) => {
    const lease = seedClaim(store.db, { browserId: 'regular', state: 'active' });
    const before = readCommitted<{ expires_at: string; state: string }>(
      'SELECT expires_at, state FROM claims WHERE id = @id',
      { id: lease.claimId },
    );

    readPoolStatus(store.db);
    readPoolStatus(store.db);

    const after = readCommitted<{ expires_at: string; state: string }>(
      'SELECT expires_at, state FROM claims WHERE id = @id',
      { id: lease.claimId },
    );

    assert.deepEqual(after, before, 'reading the pool moved a lease row: it renewed or it swept');
  });
});
