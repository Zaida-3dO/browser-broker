import assert from 'node:assert/strict';
import test from 'node:test';

import { claimInput, withBroker } from '../helpers/broker.ts';

/**
 * The queue as a **caller** meets it (§2.5) — item 7fdf4936.
 *
 * ── Why this file exists next to `give-back.test.ts` ────────────────────
 *
 * The promotion mechanism is already covered there, and well: releasing an
 * active lease promotes the head, everyone behind a released place moves up,
 * and live tabs and active leases stay the same count through a promotion.
 * **This file asserts something different — not that promotion happens, but
 * that a caller who was told to wait can actually get from the queue place to
 * the tab using only what the responses hand them.**
 *
 * That distinction is the whole reason the item was raised. A stress campaign
 * issued seven concurrent claims, received seven grants, and concluded the
 * budget was not binding. It was: the budget is fifteen
 * (`BROKER_TAB_BUDGET`, `environment.ts`), global across both browsers, and
 * seven never approached it. So the queue was never entered — and a path
 * nothing reaches under deliberate load is a path whose *caller-facing
 * contract* nobody has checked, even where its internals are tested.
 *
 * The contract under test is the one the documentation makes:
 *
 *   > a queue place is an OUTCOME rather than a failure, and the caller polls
 *   > `browser_status` until promoted
 *
 * Both halves are asserted here: that queueing returns rather than throws and
 * carries what a caller needs to act, and that **polling with the same key is
 * what observes the promotion** — the caller is never handed a second key and
 * never re-claims.
 *
 * Every lease is created through `broker.claim` and every observation made
 * through `broker.status`, never by seeding or by reading the store. A test
 * that reached into the tables could pass against a store shape no caller can
 * produce, which is the failure `give-back.test.ts` records in its own header.
 */

test('a queue place is a returned outcome carrying what a caller needs, not a thrown failure', async () => {
  await withBroker(
    async ({ broker }) => {
      const first = await broker.claim(claimInput({ sessionId: 'session-a' }));
      assert.equal(first.outcome, 'granted', 'the first caller under a budget of one is granted');

      // The second caller is the one under test. It must RETURN.
      const second = await broker.claim(claimInput({ sessionId: 'session-b' }));

      assert.equal(second.outcome, 'queued', 'over budget is a queue place, not a refusal');
      if (second.outcome !== 'queued') {
        assert.fail('expected a queue place');
      }

      // "Actionable in shape": the caller can poll (key), knows where it
      // stands (position), knows when the place dies (expiresAt), and has
      // been told when to come back (checkBack/checkBackSeconds).
      assert.ok(second.key, 'a queued caller gets a key, which is what it polls with');
      assert.equal(second.position, 1, 'the only waiter is at the front');
      assert.ok(second.expiresAt, 'the place has a stated expiry');
      assert.ok(
        second.checkBackSeconds > 0 && second.checkBackSeconds < second.queueSeconds,
        'the check-back is under the lifetime, so a caller that obeys it does not race the sweep',
      );
      assert.match(
        second.checkBack,
        /extends the place/,
        'the advice names the mechanism, not just the number',
      );
      assert.match(
        second.checkBack,
        /queues at the back with a new key/,
        'and names the cost of letting the place lapse, which is what makes the obligation legible',
      );
    },
    { tabBudget: 1 },
  );
});

test('polling browser_status with the queued key reports the promotion after the holder releases', async () => {
  await withBroker(
    async ({ broker }) => {
      const holder = await broker.claim(claimInput({ sessionId: 'session-a' }));
      if (holder.outcome !== 'granted') {
        assert.fail('expected a grant');
      }

      const waiter = await broker.claim(claimInput({ sessionId: 'session-b' }));
      if (waiter.outcome !== 'queued') {
        assert.fail('expected a queue place');
      }

      // Poll BEFORE the release: still waiting, and still told where it is.
      const whileWaiting = await broker.status({ key: waiter.key });
      assert.equal(whileWaiting.state, 'queued', 'nothing has freed capacity yet');
      assert.equal(whileWaiting.position, 1, 'the waiter is still at the front');
      assert.equal(whileWaiting.queueDepth, 1, 'and is the whole queue');

      await broker.release({ key: holder.key });

      // Poll AFTER: the SAME key now reports active. This is the assertion
      // the documented instruction rests on — the caller is not given a new
      // key and does not re-claim, so if promotion were not observable
      // through this call the advice to "poll until promoted" would be
      // unfollowable.
      const afterRelease = await broker.status({ key: waiter.key });
      assert.equal(afterRelease.state, 'active', 'the waiter was promoted and polling saw it');
      assert.equal(
        afterRelease.claimId,
        waiter.claimId,
        'it is the same lease throughout, not a new one',
      );
      assert.ok(afterRelease.tabId, 'a promoted lease has a tab, which is what it was waiting for');
    },
    { tabBudget: 1 },
  );
});

test('a queued caller that gives up strands no capacity — the next waiter takes its place', async () => {
  await withBroker(
    async ({ broker }) => {
      const holder = await broker.claim(claimInput({ sessionId: 'session-a' }));
      if (holder.outcome !== 'granted') {
        assert.fail('expected a grant');
      }

      const givesUp = await broker.claim(claimInput({ sessionId: 'session-b' }));
      const staysWaiting = await broker.claim(claimInput({ sessionId: 'session-c' }));
      if (givesUp.outcome !== 'queued' || staysWaiting.outcome !== 'queued') {
        assert.fail('expected both to queue');
      }
      assert.equal(givesUp.position, 1);
      assert.equal(staysWaiting.position, 2);

      // The caller in front abandons its place explicitly.
      const abandoned = await broker.release({ key: givesUp.key });
      assert.equal(
        abandoned.released,
        'queue-place',
        'releasing a queued lease gives back a place rather than a tab',
      );

      // The one behind moves up rather than being stuck behind a place
      // nobody holds.
      const moved = await broker.status({ key: staysWaiting.key });
      assert.equal(moved.state, 'queued', 'still waiting: the holder has not released');
      assert.equal(moved.position, 1, 'but it moved up, so the abandoned place stranded nothing');

      // And the capacity is genuinely reachable: when the holder releases,
      // the remaining waiter gets the tab rather than the departed one.
      await broker.release({ key: holder.key });
      const promoted = await broker.status({ key: staysWaiting.key });
      assert.equal(promoted.state, 'active', 'the surviving waiter was promoted');
    },
    { tabBudget: 1 },
  );
});

test('promotion follows arrival order across a budget larger than one', async () => {
  await withBroker(
    async ({ broker }) => {
      // Two tabs of capacity, filled, then two waiters behind them. A budget
      // above one is worth covering separately: the promotion loop runs
      // `while capacity` rather than once, and a budget of one cannot tell a
      // loop that promotes one from a loop that promotes all.
      const holderA = await broker.claim(claimInput({ sessionId: 'session-a' }));
      const holderB = await broker.claim(claimInput({ sessionId: 'session-b' }));
      if (holderA.outcome !== 'granted' || holderB.outcome !== 'granted') {
        assert.fail('both should be granted under a budget of two');
      }

      const third = await broker.claim(claimInput({ sessionId: 'session-c' }));
      const fourth = await broker.claim(claimInput({ sessionId: 'session-d' }));
      if (third.outcome !== 'queued' || fourth.outcome !== 'queued') {
        assert.fail('the third and fourth callers are over budget');
      }
      assert.equal(third.position, 1, 'the earlier arrival is in front');
      assert.equal(fourth.position, 2);

      // Freeing ONE tab promotes exactly the front one, and leaves the other
      // waiting — capacity is given away once per tab, not once per release.
      await broker.release({ key: holderA.key });

      const thirdNow = await broker.status({ key: third.key });
      const fourthNow = await broker.status({ key: fourth.key });
      assert.equal(thirdNow.state, 'active', 'the front of the queue was promoted');
      assert.equal(fourthNow.state, 'queued', 'the one behind it was not');
      assert.equal(fourthNow.position, 1, 'and has moved up to the front');

      await broker.release({ key: holderB.key });
      const fourthAfter = await broker.status({ key: fourth.key });
      assert.equal(fourthAfter.state, 'active', 'the second release promoted the last waiter');
    },
    { tabBudget: 2 },
  );
});

test('ONE release that frees capacity for two waiters promotes BOTH, not just the front', async () => {
  // ── What this covers that the test above does not ──────────────────────
  //
  // The test above releases holders **one at a time**, so exactly one
  // promotion is ever due per release — and an implementation that promoted
  // at most one lease per call would satisfy every assertion in it. Measured:
  // capping `promoteWhileCapacity`'s loop at a single promotion left all 13
  // queue/promotion tests green, so nothing anywhere distinguished a loop
  // that promotes one from a loop that promotes all.
  //
  // `promoteWhileCapacity` runs `while capacity exists`. To make the loop
  // iterate more than once, more than one tab's worth of capacity has to come
  // back **before a single promotion pass runs**. The sweep expires leases
  // but deliberately does not promote (promotion lives in `give-back`), so
  // ageing two active leases past their expiry and then releasing a third is
  // exactly that shape: the sweep reconciles two slots away, and the release
  // that follows drives one promotion pass into which two waiters fit.
  //
  // `ReleaseResult.promoted` is the assertion that matters and is the one no
  // test previously made above 1.
  await withBroker(
    async ({ broker, store, readCommitted }) => {
      const holderA = await broker.claim(claimInput({ sessionId: 'session-a' }));
      const holderB = await broker.claim(claimInput({ sessionId: 'session-b' }));
      const holderC = await broker.claim(claimInput({ sessionId: 'session-c' }));
      if (
        holderA.outcome !== 'granted' ||
        holderB.outcome !== 'granted' ||
        holderC.outcome !== 'granted'
      ) {
        assert.fail('all three should be granted under a budget of three');
      }

      const first = await broker.claim(claimInput({ sessionId: 'session-d' }));
      const second = await broker.claim(claimInput({ sessionId: 'session-e' }));
      if (first.outcome !== 'queued' || second.outcome !== 'queued') {
        assert.fail('the fourth and fifth callers are over a budget of three');
      }
      assert.equal(first.position, 1, 'the earlier arrival is in front');
      assert.equal(second.position, 2);

      // Age A and B past their expiry. The leases were created through
      // `broker.claim` like every other lease in this file — only the clock
      // is moved, which is the one thing a test cannot do by waiting.
      await store.immediate(({ db }) => {
        db.prepare(
          `UPDATE claims
              SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
            WHERE id IN (@a, @b)`,
        ).run({ a: holderA.claimId, b: holderB.claimId });
        return { value: undefined };
      });

      // The next operation sweeps first (the runner sweeps unconditionally
      // before any handler), so this single release sees two slots already
      // reconciled away plus its own — and the promotion loop must run more
      // than once to fill them.
      const result = await broker.release({ key: holderC.key });

      assert.equal(
        result.promoted,
        2,
        'one release freed capacity for two waiters but the promotion loop stopped after one',
      );

      const firstNow = await broker.status({ key: first.key });
      const secondNow = await broker.status({ key: second.key });
      assert.equal(firstNow.state, 'active', 'the front of the queue was promoted');
      assert.equal(
        secondNow.state,
        'active',
        'the SECOND waiter was left queued — the loop promoted once rather than while capacity',
      );

      // And it committed, rather than being true only inside the transaction
      // that made it (this file's own house rule).
      const states = readCommitted<{ state: string }>(
        'SELECT state FROM claims WHERE id IN (@first, @second)',
        { first: first.claimId, second: second.claimId },
      );
      assert.deepEqual(
        states.map((row) => row.state).sort(),
        ['active', 'active'],
        'both promotions did not commit',
      );
    },
    { tabBudget: 3 },
  );
});
