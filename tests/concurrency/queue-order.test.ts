import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { headOfQueue, queuePosition } from '../../src/service/queue.ts';
import { contend } from './harness.ts';
import { withArbitrationStore } from './stores.ts';
import { seedQueuedClaim } from './seed.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

/**
 * The queue's two promises, under contention and under a forced tie.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY ONE OF THESE TESTS FORCES THE TIE INSTEAD OF RACING FOR IT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §2.5 promises that **a caller's position only ever improves**. The defect
 * that broke it is subtle: ordering by `created_at` tie-broken by `id` is
 * perfectly *stable*, but `created_at` has millisecond resolution and `id` is
 * a random identifier — so among callers arriving inside one millisecond the
 * order bears no relation to arrival, and a caller told position 1 can be
 * told position 2 afterwards when a genuinely earlier caller is placed ahead
 * of it. The repair is an arrival counter the database allocates at insert
 * (`schema/step-003-queue-order.ts`).
 *
 * **A test that spawns callers and hopes two share a millisecond is a test
 * that sometimes detects this and sometimes does not.** It is the exact shape
 * this repository has caught as hollow before: run the mutation five times
 * and it survives some of them, which means a green run is not evidence.
 *
 * So the tie is **constructed**: rows are seeded sharing one `created_at`
 * value to the millisecond, with identifiers deliberately sorted *against*
 * their arrival order. Under the counter the answer is arrival order; under
 * the defect it is identifier order; and the two are opposites by
 * construction, so the assertion cannot pass by luck.
 *
 * The single change that breaks the second test is ordering the queue by
 * `created_at` and `id` rather than by `arrival` — which is the code the
 * counter replaced, and the change somebody makes while tidying.
 */

const BROWSER = 'regular';

test('positions under contention are a permutation of one through the queue depth, with no repeats', async () => {
  const budget = 2;
  const processes = 12;

  await withArbitrationStore(
    async (fixture) => {
      const run = await contend({
        worker: 'worker-claim.mjs',
        processes,
        argv: [BROWSER],
        env: fixture.childEnv,
      });

      assert.equal(run.failed.length, 0, 'Every process must get an answer rather than an error.');

      const queued = run.succeeded.filter((outcome) => outcome.detail['outcome'] === 'queued');
      const positions = queued.map((outcome) => outcome.detail['position'] as number);

      // **Two callers told the same position is the failure this catches**,
      // and it is what a queue whose order is decided inside each caller's
      // own transaction would produce. Under one immediate transaction per
      // caller the allocation is serialised, so the positions handed out are
      // exactly one through the depth.
      assert.deepEqual(
        [...positions].sort((a, b) => a - b),
        Array.from({ length: processes - budget }, (_unused, index) => index + 1),
        `Queue positions must be exactly one through ${String(processes - budget)} with no repeats and no gaps. Two callers told the same position are two callers who both believe they are next. Positions handed out: ${JSON.stringify([...positions].sort((a, b) => a - b))}.`,
      );

      // And the store agrees with what the callers were told: each caller's
      // recorded arrival puts it where its response said it was. Read on the
      // connection that took no part in the contention.
      const byArrival = fixture.readCommitted<{ id: string }>(
        "SELECT id FROM claims WHERE state = 'queued' ORDER BY arrival",
      );
      const expected = new Map(byArrival.map((row, index) => [row.id, index + 1]));
      for (const outcome of queued) {
        const claimId = outcome.detail['claimId'] as string;
        assert.equal(
          outcome.detail['position'],
          expected.get(claimId),
          `The position a caller was told must match where the store puts it. Claim ${claimId} was told ${String(outcome.detail['position'])} and the store orders it at ${String(expected.get(claimId))}.`,
        );
      }
    },
    { tabBudget: budget },
  );
});

test('a position never gets worse when callers share a created_at, with the tie forced rather than raced', async () => {
  await withArbitrationStore(
    async (fixture) => {
      // ── The forced tie ───────────────────────────────────────────────
      //
      // One `created_at`, to the millisecond, shared by every row. The
      // identifiers are chosen so that sorting by them is the **reverse** of
      // arrival order: the caller that arrived first has the identifier that
      // sorts last. Nothing here is left to chance — no spawn, no timing, no
      // hoping two processes land in the same millisecond.
      //
      // `arrival` ascends with the order the callers actually arrived in;
      // `id` descends. Under the counter the earliest arrival is position 1.
      // Under the ordering the counter replaced it would be position 4.
      const sharedCreatedAt = '2026-01-01T00:00:00.000Z';
      const arrivals = [
        { id: 'd-arrived-first', arrival: 101 },
        { id: 'c-arrived-second', arrival: 102 },
        { id: 'b-arrived-third', arrival: 103 },
        { id: 'a-arrived-fourth', arrival: 104 },
      ];

      for (const row of arrivals) {
        seedQueuedClaim(fixture.databasePath, {
          id: row.id,
          arrival: row.arrival,
          createdAt: sharedCreatedAt,
          browserId: BROWSER,
        });
      }

      // Sanity: the tie really is a tie. If a future change gives
      // `created_at` a finer resolution or the seed stops sharing one value,
      // this test would silently become the racing version it exists not to
      // be — so the premise is asserted rather than assumed.
      const distinctCreatedAt = fixture.readCommitted<{ n: number }>(
        "SELECT count(DISTINCT created_at) AS n FROM claims WHERE state = 'queued'",
      );
      assert.equal(
        distinctCreatedAt[0]?.n,
        1,
        'The whole point of this test is that every queued row shares one created_at. If they do not, the tie is not forced and the test has stopped being deterministic.',
      );

      // ── Asked of the real functions, not of a query written here ──────
      //
      // `queuePosition` and `headOfQueue` are what the service answers a
      // caller with, so they are what this test calls. An assertion written
      // against its own `ORDER BY` would prove the *column* holds the right
      // numbers while the production ordering had been changed underneath it
      // — measured while building this suite: mutating `queue.ts` to order by
      // `created_at, id` left a self-written query passing three times out of
      // three, and fails here.
      //
      // A connection of this test's own, because these are synchronous
      // functions taking a driver handle. Nothing is contending for the file
      // at this point in the test.
      const db = new Database(fixture.databasePath, { readonly: true });
      try {
        // The promise itself, stated as the defect would break it. Under the
        // ordering the counter replaced, `a-arrived-fourth` — which arrived
        // last — sorts first by identifier and would be told position 1,
        // while the caller that really was first would be told 4. Its
        // position would have got worse, which §2.5 promises cannot happen.
        //
        // Named one at a time rather than looped: a loop over a list stays
        // green when an entry is deleted, and the property here is about
        // *which* caller is told *which* number.
        assert.equal(
          queuePosition(db, 'd-arrived-first'),
          1,
          'The caller that arrived first must be told position 1. Its identifier sorts last, so an ordering that fell back to the identifier would tell it 4.',
        );
        assert.equal(
          queuePosition(db, 'c-arrived-second'),
          2,
          'Second by arrival must be told position 2.',
        );
        assert.equal(
          queuePosition(db, 'b-arrived-third'),
          3,
          'Third by arrival must be told position 3.',
        );
        assert.equal(
          queuePosition(db, 'a-arrived-fourth'),
          4,
          'Last by arrival must be told position 4. Its identifier sorts first, so an ordering that fell back to the identifier would tell it 1.',
        );

        // The front of the queue is what a freed tab is handed to, so it is
        // the other half of the same promise.
        assert.equal(
          headOfQueue(db)?.id,
          'd-arrived-first',
          'The front of the queue must be the earliest arrival. Ordering by a random identifier puts the last arrival first, which is how a caller is overtaken by somebody who arrived after it.',
        );
      } finally {
        db.close();
      }
    },
    { tabBudget: 1 },
  );
});
