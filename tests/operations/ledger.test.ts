import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clampLimit,
  countByGuard,
  DEFAULT_LEDGER_LIMIT,
  MAXIMUM_LEDGER_LIMIT,
  readLedger,
} from '../../src/operations/ledger.ts';
import { seedEvent } from '../helpers/seed.ts';
import { withSteppedStore } from '../helpers/temp-store.ts';

/**
 * The ledger view (`MILESTONES.md` #47, `SCHEMA.md` §1.6).
 *
 * Every slicing test **names the entries it expects** rather than asserting a
 * count, because a count stays green when the wrong rows come back — which is
 * exactly the hollow shape this repository has already been caught by.
 */
describe('slicing the ledger', () => {
  it('filters by kind, returning those entries and not the others', async () => {
    await withSteppedStore(async (store) => {
      const navigate = seedEvent(store.db, { kind: 'navigate', at: '2026-01-01T00:00:01.000Z' });
      seedEvent(store.db, { kind: 'capture', at: '2026-01-01T00:00:02.000Z' });
      const act = seedEvent(store.db, { kind: 'act', at: '2026-01-01T00:00:03.000Z' });

      const slice = readLedger(store.db, { kinds: ['navigate', 'act'] });

      const ids = slice.entries.map((entry) => entry.id).sort((a, b) => a - b);
      assert.deepEqual(
        ids,
        [navigate, act].sort((a, b) => a - b),
      );
      assert.equal(slice.total, 2);
      await Promise.resolve();
    });
  });

  it('filters by outcome', async () => {
    await withSteppedStore(async (store) => {
      const allowed = seedEvent(store.db, { kind: 'navigate', outcome: 'allow' });
      const denied = seedEvent(store.db, { kind: 'navigate', outcome: 'deny', guard: 'a.rule' });

      const denials = readLedger(store.db, { outcome: 'deny' });
      assert.deepEqual(
        denials.entries.map((entry) => entry.id),
        [denied],
      );

      const allows = readLedger(store.db, { outcome: 'allow' });
      assert.deepEqual(
        allows.entries.map((entry) => entry.id),
        [allowed],
      );
      await Promise.resolve();
    });
  });

  it('filters by the rule that refused', async () => {
    await withSteppedStore(async (store) => {
      seedEvent(store.db, { kind: 'navigate', outcome: 'deny', guard: 'lease.required' });
      const capacity = seedEvent(store.db, {
        kind: 'claim_requested',
        outcome: 'deny',
        guard: 'capacity.bounded',
      });

      const slice = readLedger(store.db, { guard: 'capacity.bounded' });

      assert.deepEqual(
        slice.entries.map((entry) => entry.id),
        [capacity],
      );
      await Promise.resolve();
    });
  });

  it('filters by session, which is why that column is denormalised', async () => {
    // §1.6: without `session_id` on the event row "every refusal on the
    // busiest rule in the service is anonymous", because a refused request
    // never becomes a lease to join to.
    await withSteppedStore(async (store) => {
      const mine = seedEvent(store.db, {
        kind: 'claim_requested',
        outcome: 'deny',
        guard: 'capacity.bounded',
        sessionId: 'session-a',
      });
      seedEvent(store.db, { kind: 'claim_requested', sessionId: 'session-b' });

      const slice = readLedger(store.db, { sessionId: 'session-a' });

      assert.deepEqual(
        slice.entries.map((entry) => entry.id),
        [mine],
      );
      await Promise.resolve();
    });
  });

  it('reads everything since a cursor, in the order it happened', async () => {
    // The cursor the counter primary key already provides (§1.6). An offset
    // would re-read rows as earlier ones accumulate; an id does not.
    await withSteppedStore(async (store) => {
      const first = seedEvent(store.db, { kind: 'sweep' });
      const second = seedEvent(store.db, { kind: 'navigate' });
      const third = seedEvent(store.db, { kind: 'capture' });

      const slice = readLedger(store.db, { since: first, order: 'oldest' });

      assert.deepEqual(
        slice.entries.map((entry) => entry.id),
        [second, third],
      );
      // The cursor to pass next time is the highest seen, not the last
      // returned — a caller taking the last would page backwards forever
      // under `newest` order.
      assert.equal(slice.cursor, third);
      await Promise.resolve();
    });
  });

  it('reads the end of the stream by default, most recent first', async () => {
    await withSteppedStore(async (store) => {
      seedEvent(store.db, { kind: 'sweep' });
      const middle = seedEvent(store.db, { kind: 'navigate' });
      const last = seedEvent(store.db, { kind: 'capture' });

      const slice = readLedger(store.db, { limit: 2 });

      assert.deepEqual(
        slice.entries.map((entry) => entry.id),
        [last, middle],
      );
      // Total ignores the limit, which is the number that tells a reader the
      // page is a page.
      assert.equal(slice.total, 3);
      await Promise.resolve();
    });
  });

  it('pages backwards from a cursor', async () => {
    await withSteppedStore(async (store) => {
      const first = seedEvent(store.db, { kind: 'sweep' });
      const second = seedEvent(store.db, { kind: 'navigate' });
      seedEvent(store.db, { kind: 'capture' });

      const slice = readLedger(store.db, { before: second });

      assert.deepEqual(
        slice.entries.map((entry) => entry.id),
        [first],
      );
      await Promise.resolve();
    });
  });

  it('returns an empty slice with a null cursor rather than throwing', async () => {
    await withSteppedStore(async (store) => {
      const slice = readLedger(store.db, { kinds: ['sweep'] });
      assert.deepEqual(slice.entries, []);
      assert.equal(slice.cursor, null);
      assert.equal(slice.total, 0);
      await Promise.resolve();
    });
  });

  it('treats a value that would end a statement as a value, not as syntax', async () => {
    // Every caller value is a bound parameter. A build that interpolated
    // would either throw here or return the whole table; both fail this.
    await withSteppedStore(async (store) => {
      seedEvent(store.db, { kind: 'navigate', sessionId: 'session-a' });

      const slice = readLedger(store.db, { sessionId: "' OR 1=1 --" });

      assert.deepEqual(slice.entries, []);
      assert.equal(slice.total, 0);
      await Promise.resolve();
    });
  });
});

describe('the page size', () => {
  it('defaults when it is absent or nonsensical', () => {
    assert.equal(clampLimit(undefined), DEFAULT_LEDGER_LIMIT);
    assert.equal(clampLimit(0), DEFAULT_LEDGER_LIMIT);
    assert.equal(clampLimit(-5), DEFAULT_LEDGER_LIMIT);
    assert.equal(clampLimit(Number.NaN), DEFAULT_LEDGER_LIMIT);
  });

  it('caps rather than refusing, because the ledger is kept forever', () => {
    assert.equal(clampLimit(MAXIMUM_LEDGER_LIMIT + 1000), MAXIMUM_LEDGER_LIMIT);
  });

  it('is actually applied to the query', async () => {
    // Breaks if the limit is computed and not passed — a mistake that leaves
    // every clamp test above green while the query returns everything.
    await withSteppedStore(async (store) => {
      for (let index = 0; index < 5; index += 1) {
        seedEvent(store.db, { kind: 'sweep' });
      }
      const slice = readLedger(store.db, { limit: 2 });
      assert.equal(slice.entries.length, 2);
      assert.equal(slice.total, 5);
      await Promise.resolve();
    });
  });
});

describe('the refusals rollup', () => {
  it('counts each rule, and counts only refusals', async () => {
    // §1.6: an allowed row does not record which rules passed, so a rollup
    // that included allows would be counting something that is not there.
    await withSteppedStore(async (store) => {
      seedEvent(store.db, { kind: 'navigate', outcome: 'allow' });
      seedEvent(store.db, { kind: 'navigate', outcome: 'deny', guard: 'lease.required' });
      seedEvent(store.db, { kind: 'navigate', outcome: 'deny', guard: 'lease.required' });
      seedEvent(store.db, { kind: 'claim_requested', outcome: 'deny', guard: 'capacity.bounded' });

      const counts = new Map(countByGuard(store.db).map((entry) => [entry.guard, entry.count]));

      assert.equal(counts.get('lease.required'), 2);
      assert.equal(counts.get('capacity.bounded'), 1);
      assert.equal(counts.size, 2);
      await Promise.resolve();
    });
  });

  it('orders the most-refused rule first', async () => {
    await withSteppedStore(async (store) => {
      seedEvent(store.db, { kind: 'navigate', outcome: 'deny', guard: 'rare.rule' });
      for (let index = 0; index < 3; index += 1) {
        seedEvent(store.db, { kind: 'navigate', outcome: 'deny', guard: 'common.rule' });
      }

      const rollup = countByGuard(store.db);

      const first = rollup[0];
      assert.ok(first);
      assert.equal(first.guard, 'common.rule');
      await Promise.resolve();
    });
  });
});
