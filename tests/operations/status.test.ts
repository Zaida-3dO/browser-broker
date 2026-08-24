import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  readOperationsStatus,
  readStoreClock,
  STORE_CLOCK_SQL,
} from '../../src/operations/status.ts';
import { STEP_ONE_SQL } from '../../src/store/schema/step-001-initial.ts';
import { seedClaim, seedEvent, seedFeedback, seedTab } from '../helpers/seed.ts';
import { withSteppedStore } from '../helpers/temp-store.ts';

/**
 * The derived operations read.
 *
 * Every test here seeds a row the sweep has **not** reconciled, because that
 * is the only state in which the rule under test is observable: a lease that
 * has been swept reads the same whether or not the reader derives.
 */
describe('the operations status read', () => {
  const now = '2026-03-01T12:00:00.000Z';
  const soon = '2026-03-01T12:05:00.000Z';
  const gone = '2026-03-01T11:50:00.000Z';

  it('does not report a lapsed lease as live', async () => {
    // The single most important assertion in this row. A reader assembled
    // from direct table reads would return one lease here and would look
    // entirely plausible doing it (`SCHEMA.md` §4.5).
    //
    // Breaks if `readOperationsStatus` filters on `claim.state` instead of
    // `isLive`, or if the derivation's comparison is removed.
    await withSteppedStore(async (store) => {
      seedClaim(store.db, { state: 'active', expiresAt: gone, sessionId: 'session-a' });

      const status = readOperationsStatus(store.db, { now });

      assert.deepEqual(status.sessions, []);
      assert.equal(status.budget.used, 0);
      assert.equal(status.budget.active, 0);
      await Promise.resolve();
    });
  });

  it('reports a live lease as live, with its derived state', async () => {
    await withSteppedStore(async (store) => {
      const claimId = seedClaim(store.db, {
        state: 'active',
        expiresAt: soon,
        sessionId: 'session-a',
        purpose: 'reviewing a page',
      });

      const status = readOperationsStatus(store.db, { now });

      assert.equal(status.sessions.length, 1);
      const session = status.sessions[0];
      assert.ok(session);
      assert.equal(session.sessionId, 'session-a');
      // Named rather than iterated. A test that walked the list and asserted
      // a length would stay green if the wrong lease were returned.
      const lease = session.leases[0];
      assert.ok(lease);
      assert.equal(lease.claimId, claimId);
      assert.equal(lease.state, 'active');
      assert.equal(lease.purpose, 'reviewing a page');
      assert.equal(lease.secondsUntilExpiry, 300);
      await Promise.resolve();
    });
  });

  it('drops a lapsed queue place and renumbers the positions behind it', async () => {
    // §1.5's ordering is `created_at` then `id`, and a lapsed caller at the
    // front is the failure the section calls invisible in a capacity count.
    // A reader that kept it would report the caller behind it as second when
    // it is in fact first.
    await withSteppedStore(async (store) => {
      seedClaim(store.db, {
        state: 'queued',
        expiresAt: gone,
        createdAt: '2026-03-01T11:00:00.000Z',
        sessionId: 'session-dead',
      });
      seedClaim(store.db, {
        state: 'queued',
        expiresAt: soon,
        createdAt: '2026-03-01T11:30:00.000Z',
        sessionId: 'session-waiting',
      });

      const status = readOperationsStatus(store.db, { now });

      assert.equal(status.queue.length, 1);
      const front = status.queue[0];
      assert.ok(front);
      // Named, not counted: deleting the wrong entry would keep a
      // length-one assertion green.
      assert.equal(front.sessionId, 'session-waiting');
      assert.equal(front.position, 1);
      assert.equal(front.waitedSeconds, 1800);
      await Promise.resolve();
    });
  });

  it('groups several leases of one session as one caller', async () => {
    // §4.2: "grouped by session so one caller holding several reads as one
    // caller".
    await withSteppedStore(async (store) => {
      seedClaim(store.db, { state: 'active', expiresAt: soon, sessionId: 'session-a' });
      seedClaim(store.db, { state: 'active', expiresAt: soon, sessionId: 'session-a' });
      seedClaim(store.db, { state: 'active', expiresAt: soon, sessionId: 'session-b' });

      const status = readOperationsStatus(store.db, { now });

      assert.equal(status.sessions.length, 2);
      const byId = new Map(status.sessions.map((s) => [s.sessionId, s.leases.length]));
      assert.equal(byId.get('session-a'), 2);
      assert.equal(byId.get('session-b'), 1);
      await Promise.resolve();
    });
  });

  it('counts the keeper tabs separately so the numbers reconcile', async () => {
    // §3.15: the keeper tab is not capacity and is not counted against the
    // budget, and it is reported wherever pages are counted so a person
    // looking at a browser window can reconcile what they see.
    await withSteppedStore(async (store) => {
      const claimId = seedClaim(store.db, { state: 'active', expiresAt: soon });
      seedTab(store.db, { claimId });

      const status = readOperationsStatus(store.db, { now });

      assert.equal(status.budget.active, 1);
      assert.equal(status.budget.keeperTabsExpected, 2);
      await Promise.resolve();
    });
  });

  it('does not attribute a lapsed lease’s tab to its browser', async () => {
    // The tab count is derived from the live leases, so a lapsed lease's tab
    // must not inflate a browser's count. Breaks if `liveTabsByBrowser` is
    // built from a table read rather than from the derived lease list.
    await withSteppedStore(async (store) => {
      const dead = seedClaim(store.db, { state: 'active', expiresAt: gone });
      seedTab(store.db, { claimId: dead });

      const status = readOperationsStatus(store.db, { now });

      const regular = status.browsers.find((browser) => browser.id === 'regular');
      assert.ok(regular);
      assert.equal(regular.liveTabs, 0);
      await Promise.resolve();
    });
  });

  it('lists a leaked tab with what it was leased by', async () => {
    // §2.4b: a leaked tab is not a leaked lease. The flag is what the clear
    // operation selects on, so a reader that selected on state instead would
    // list every closed tab.
    await withSteppedStore(async (store) => {
      const claimId = seedClaim(store.db, { state: 'released', expiresAt: gone });
      const leaked = seedTab(store.db, {
        claimId,
        state: 'closing',
        closeFailed: true,
        closeAttempts: 3,
      });
      // A tab that closed cleanly. If the reader selected on state rather
      // than on close_failed, this would appear too.
      seedTab(store.db, { claimId, state: 'closing', closeFailed: false });

      const status = readOperationsStatus(store.db, { now });

      assert.equal(status.leakedTabs.length, 1);
      const tab = status.leakedTabs[0];
      assert.ok(tab);
      assert.equal(tab.tabId, leaked);
      assert.equal(tab.closeAttempts, 3);
      await Promise.resolve();
    });
  });

  it('carries the most recent ledger entries and the refusal rollup', async () => {
    await withSteppedStore(async (store) => {
      seedEvent(store.db, { kind: 'claim_granted', outcome: 'allow' });
      seedEvent(store.db, { kind: 'claim_requested', outcome: 'deny', guard: 'capacity.bounded' });
      seedEvent(store.db, { kind: 'claim_requested', outcome: 'deny', guard: 'capacity.bounded' });
      seedEvent(store.db, { kind: 'navigate', outcome: 'deny', guard: 'lease.required' });

      const status = readOperationsStatus(store.db, { now });

      assert.equal(status.recentEvents.length, 4);
      // Named counts, not a length: deleting the `lease.required` row would
      // leave a length-two assertion green.
      const counts = new Map(status.refusalsByGuard.map((g) => [g.guard, g.count]));
      assert.equal(counts.get('capacity.bounded'), 2);
      assert.equal(counts.get('lease.required'), 1);
      await Promise.resolve();
    });
  });

  it('carries what callers reported', async () => {
    await withSteppedStore(async (store) => {
      seedFeedback(store.db, {
        rating: 2,
        category: 'refusal-unclear',
        note: 'the refusal did not say which rule had refused the call',
      });

      const status = readOperationsStatus(store.db, { now });

      const entry = status.feedback[0];
      assert.ok(entry);
      assert.equal(entry.category, 'refusal-unclear');
      assert.equal(entry.rating, 2);
      await Promise.resolve();
    });
  });

  it('reports the tab budget as not recorded when nothing has recorded one', async () => {
    // §1.10: the row is written by the first process to open the store, and
    // that row's owner has not landed. Null is a true statement; a default
    // would be a number nobody chose.
    await withSteppedStore(async (store) => {
      const status = readOperationsStatus(store.db, { now });
      assert.equal(status.budget.limit, null);
      await Promise.resolve();
    });
  });

  it('reports the browsers’ state and restart count', async () => {
    await withSteppedStore(async (store) => {
      store.db
        .prepare(
          `UPDATE browsers SET state = 'running', pid = 4242, restart_count = 2,
             endpoint = 'http://127.0.0.1:1/', browser_uuid = 'uuid-a' WHERE id = 'regular'`,
        )
        .run();

      const status = readOperationsStatus(store.db, { now });

      const regular = status.browsers.find((browser) => browser.id === 'regular');
      assert.ok(regular);
      assert.equal(regular.state, 'running');
      assert.equal(regular.restartCount, 2);
      assert.equal(regular.discoveryRecorded, true);
      assert.equal(regular.identityRecorded, true);

      const priv = status.browsers.find((browser) => browser.id === 'private');
      assert.ok(priv);
      assert.equal(priv.discoveryRecorded, false);
      await Promise.resolve();
    });
  });
});

describe('the store’s own clock', () => {
  it('is the same expression every timestamp column defaults to', () => {
    // The format string is repeated in `status.ts` rather than imported out
    // of the schema step, because a step that has run anywhere is history and
    // must never become a dependency of a file that changes. This is the
    // check that keeps the repetition honest: it breaks the moment the two
    // spellings drift.
    const seedSql = STEP_ONE_SQL.join('\n');
    assert.ok(
      seedSql.includes(STORE_CLOCK_SQL),
      'the clock expression in status.ts and the one in the schema step have drifted apart',
    );
  });

  it('answers in a form the derivation can compare', async () => {
    await withSteppedStore(async (store) => {
      const clock = readStoreClock(store.db);
      assert.match(clock, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      await Promise.resolve();
    });
  });
});
