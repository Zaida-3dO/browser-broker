import assert from 'node:assert/strict';
import test from 'node:test';

import { CallRefusal } from '../../src/service/refusals.ts';
import { claimInput, withBroker } from '../helpers/broker.ts';

/**
 * `browser_claim` (§3.2), the admission predicate (§2.3) and the queue (§2.5).
 *
 * **Every rejection test here asserts the physical side-effect as well as the
 * response**, per `CLAUDE.md`: a refusal that returned after the row was
 * written is a refusal that did not happen, and everything downstream would
 * believe it.
 */

test('a claim with capacity is granted one tab, and returns a key once', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const result = await broker.claim(claimInput());
    assert.equal(result.outcome, 'granted');
    assert.ok(result.key.length > 0);

    // Read on a second, read-only connection: what committed, not what the
    // writing handle can see.
    const claims = readCommitted<{ state: string; keyHash: string }>(
      'SELECT state, key_hash AS keyHash FROM claims',
    );
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.state, 'active');
    // The secret is never stored (§1.3), only its hash.
    assert.notEqual(claims[0]?.keyHash, result.key);

    const tabs = readCommitted<{ state: string }>('SELECT state FROM tabs');
    assert.equal(tabs.length, 1, 'one claim is one tab');
    assert.equal(tabs[0]?.state, 'opening');
  });
});

test('a grant is one tab — a second claim is a second lease and a second row', async () => {
  // §2.3: need two tabs, claim twice. There is no tab-count argument to ask
  // for more with, and its absence is the model rather than a restriction.
  await withBroker(async ({ broker, readCommitted }) => {
    const first = await broker.claim(claimInput());
    const second = await broker.claim(claimInput());
    assert.equal(first.outcome, 'granted');
    assert.equal(second.outcome, 'granted');
    assert.notEqual(first.claimId, second.claimId);
    assert.notEqual(first.key, second.key);
    assert.equal(readCommitted('SELECT id FROM tabs').length, 2);
  });
});

test('one session holding several leases is the ordinary case, not a refusal', async () => {
  // §2.2: a session already holding a lease cannot be a refusal when holding
  // several is how a caller gets several tabs.
  await withBroker(async ({ broker }) => {
    for (let index = 0; index < 3; index += 1) {
      const result = await broker.claim(claimInput({ sessionId: 'session-a' }));
      assert.equal(result.outcome, 'granted');
    }
  });
});

test('the claim past the budget is queued, and takes no tab', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      const first = await broker.claim(claimInput());
      assert.equal(first.outcome, 'granted');

      const second = await broker.claim(claimInput({ sessionId: 'session-b' }));
      assert.equal(second.outcome, 'queued');
      assert.equal(second.outcome === 'queued' ? second.position : -1, 1);

      // The physical side-effect: capacity did not move. A queue placement
      // that had opened a tab would be an over-budget grant wearing a queue's
      // clothes.
      assert.equal(readCommitted('SELECT id FROM tabs').length, 1, 'the queued claim took a tab');
      const active = readCommitted<{ n: number }>(
        "SELECT count(*) AS n FROM claims WHERE state = 'active'",
      );
      assert.equal(active[0]?.n, 1);
    },
    { tabBudget: 1 },
  );
});

test('the admission predicate is one integer: the budget is exactly how many are granted', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      for (let index = 0; index < 3; index += 1) {
        const result = await broker.claim(claimInput({ sessionId: `session-${String(index)}` }));
        assert.equal(result.outcome, 'granted', `claim ${String(index)} should have been granted`);
      }
      const fourth = await broker.claim(claimInput({ sessionId: 'session-d' }));
      assert.equal(fourth.outcome, 'queued');

      assert.equal(readCommitted('SELECT id FROM tabs').length, 3);
    },
    { tabBudget: 3 },
  );
});

test('the queue hands out one position each, and every place is distinct', async () => {
  // §2.5: strict order, and a position that only ever improves. The
  // positions form the complete run 1..n with no repeat, which is the
  // property a caller acts on — being told "you are third" by a queue that
  // has told somebody else the same thing is the failure this catches.
  await withBroker(
    async ({ broker }) => {
      await broker.claim(claimInput());
      const positions: number[] = [];
      for (const session of ['session-b', 'session-c', 'session-d']) {
        const queued = await broker.claim(claimInput({ sessionId: session }));
        if (queued.outcome !== 'queued') {
          assert.fail('expected a queue placement');
        }
        positions.push(queued.position);
      }
      assert.deepEqual(
        [...positions].sort((a, b) => a - b),
        [1, 2, 3],
      );
    },
    { tabBudget: 1 },
  );
});

test('a queue position does not flip between reads', async () => {
  // §1.5 states exactly what the tie-break buys, and it is this rather than
  // insertion order: "two requests in the same millisecond share a
  // `created_at`, and without a tie-break the front of the queue flips
  // between reads". Sub-millisecond arrivals are ordinary at this rate, so
  // the guarantee a caller gets is a stable answer, not one derived from the
  // order the calls happened to be made in.
  //
  // The single-character change that breaks this is dropping `, id` from the
  // ordering in `queuePosition`.
  await withBroker(
    async ({ broker }) => {
      await broker.claim(claimInput());
      const queued = [];
      for (const session of ['session-b', 'session-c', 'session-d']) {
        const result = await broker.claim(claimInput({ sessionId: session }));
        if (result.outcome !== 'queued') {
          assert.fail('expected a queue placement');
        }
        queued.push(result);
      }

      for (const entry of queued) {
        const first = await broker.status({ key: entry.key });
        const second = await broker.status({ key: entry.key });
        assert.equal(first.position, second.position, 'a position moved between two reads');
        assert.equal(first.position, entry.position, 'a position differs from the one issued');
      }
    },
    { tabBudget: 1 },
  );
});

test('a queued response carries the obligation, the number and the mechanism', async () => {
  // A caller told only a deadline will agree, intend to return, and be gone.
  // The response has to say to check back at just under the lifetime, because
  // a check made exactly at the deadline races the reclamation.
  await withBroker(
    async ({ broker }) => {
      await broker.claim(claimInput());
      const queued = await broker.claim(claimInput({ sessionId: 'session-b' }));
      if (queued.outcome !== 'queued') {
        assert.fail('expected a queue placement');
      }

      assert.equal(queued.queueSeconds, 600);
      // Under, not at. Nine minutes against ten.
      assert.equal(queued.checkBackSeconds, 540);
      assert.ok(queued.checkBackSeconds < queued.queueSeconds);
      assert.match(queued.checkBack, /540/);
      assert.match(queued.checkBack, /races/);
    },
    { tabBudget: 1 },
  );
});

test('the check-back deadline stays under a short lifetime rather than going negative', async () => {
  // A fixed subtraction would give a caller on a ten-second place a
  // check-back deadline of zero or below, which is no deadline at all.
  await withBroker(
    async ({ broker }) => {
      await broker.claim(claimInput());
      const queued = await broker.claim(claimInput({ sessionId: 'session-b' }));
      if (queued.outcome !== 'queued') {
        assert.fail('expected a queue placement');
      }
      assert.ok(queued.checkBackSeconds >= 1);
      assert.ok(queued.checkBackSeconds < queued.queueSeconds);
    },
    { tabBudget: 1, queueSeconds: 10 },
  );
});

test('an unknown browser is refused outright, and nothing is written', async () => {
  // §2.2: nothing will ever make it valid, so waiting does not help and a
  // queue entry would be a promise the service cannot keep.
  await withBroker(async ({ broker, readCommitted }) => {
    await assert.rejects(
      () => broker.claim(claimInput({ browser: 'chrome' })),
      (error: unknown) => {
        assert.ok(error instanceof CallRefusal);
        assert.equal(error.code, 'unknown_browser');
        assert.equal(error.rule, 'claim.browser_known');
        assert.equal(error.retryable, false);
        return true;
      },
    );

    // The side-effect assertion: no lease, no tab.
    assert.equal(readCommitted('SELECT id FROM claims').length, 0);
    assert.equal(readCommitted('SELECT id FROM tabs').length, 0);
  });
});

test('a browser row of the wrong kind is refused by name, not silently adopted', async () => {
  // `DECISIONS.md` §13i: two processes on one machine may hold different
  // configurations for the same name. `INSERT OR IGNORE` at claim time is a
  // no-op once a row with the name exists — whatever kind it was created
  // with — which is what makes this the one disagreement it cannot itself
  // detect. Simulated here as another process's row already on disk: this
  // fixture configures `shared` as `regular` (the default list), and a row
  // with the same name is pre-seeded as `private`, standing in for the
  // other process that created it.
  await withBroker(
    async ({ broker, store, readCommitted }) => {
      store.db
        .prepare("INSERT INTO browsers (id, kind, state) VALUES ('shared', 'private', 'stopped')")
        .run();

      await assert.rejects(
        () => broker.claim(claimInput({ browser: 'shared' })),
        (error: unknown) => {
          assert.ok(error instanceof CallRefusal);
          assert.equal(error.code, 'browser_kind_mismatch');
          assert.equal(error.rule, 'claim.browser_kind_agrees');
          assert.equal(error.retryable, false);
          assert.match(error.message, /shared/);
          assert.match(error.message, /private/);
          assert.match(error.message, /regular/);
          return true;
        },
      );

      // The side-effect assertion: the row keeps the kind it was created
      // with, and no lease or tab was written for the mismatched claim.
      const rows = readCommitted<{ kind: string }>("SELECT kind FROM browsers WHERE id = 'shared'");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.kind, 'private', 'the mismatched claim silently adopted the row');
      assert.equal(readCommitted('SELECT id FROM claims').length, 0);
      assert.equal(readCommitted('SELECT id FROM tabs').length, 0);
    },
    { regularBrowsers: ['shared'] },
  );
});

test('a refused request still leaves a ledger row, and it names the session', async () => {
  // §1.6: a refused request never becomes a lease, so without the
  // denormalised session column every refusal on the busiest rule is
  // anonymous.
  await withBroker(async ({ broker, readCommitted }) => {
    await assert.rejects(() => broker.claim(claimInput({ browser: 'chrome' })));
    const denials = readCommitted<{ guard: string; sessionId: string }>(
      "SELECT guard, session_id AS sessionId FROM events WHERE outcome = 'deny'",
    );
    assert.equal(denials.length, 1);
    assert.equal(denials[0]?.guard, 'claim.browser_known');
    assert.equal(denials[0]?.sessionId, 'session-a');
  });
});

test('a grant and a queue placement are both recorded, allowed as well as refused', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      await broker.claim(claimInput());
      await broker.claim(claimInput({ sessionId: 'session-b' }));
      const kinds = readCommitted<{ kind: string }>(
        "SELECT kind FROM events WHERE outcome = 'allow' ORDER BY id",
      ).map((row) => row.kind);
      assert.ok(kinds.includes('claim_granted'));
      assert.ok(kinds.includes('claim_queued'));
      assert.ok(kinds.includes('tab_opening'));
    },
    { tabBudget: 1 },
  );
});

test('a position never gets worse, even when callers arrive in the same millisecond', async () => {
  // §2.5 promises a position that "only ever improves". Ordering by
  // `created_at` tie-broken by `id` is *stable* but not *arrival-ordered*:
  // among callers sharing a millisecond the order falls to a random
  // identifier, and a caller told position 1 can be told position 2 once
  // somebody who really did arrive earlier is placed ahead of it.
  //
  // **The tie is forced rather than raced for.** Waiting for three claims to
  // land in one millisecond makes the test a coin flip that passes most of
  // the time — which is exactly the shape of the defect this pins, so a
  // probabilistic version of it would be a test that agrees with the bug.
  // Every queued row is stamped with one `created_at` after the fact, which
  // is the condition the clock-based ordering cannot survive and the counter
  // does not notice.
  //
  // The single change that breaks this is ordering `queuePosition` by
  // `created_at, id` again.
  await withBroker(
    async ({ broker, store }) => {
      await broker.claim(claimInput());

      const issued: { key: string; position: number }[] = [];
      for (let index = 0; index < 8; index += 1) {
        const result = await broker.claim(claimInput({ sessionId: `session-${String(index)}` }));
        if (result.outcome !== 'queued') {
          assert.fail('expected a queue placement');
        }
        issued.push({ key: result.key, position: result.position });

        // Collapse every queued arrival into one instant, so the only thing
        // left to order by is what the design chose to order by.
        store.db
          .prepare("UPDATE claims SET created_at = ? WHERE state = 'queued'")
          .run('2026-01-01T00:00:00.000Z');

        // Every position issued so far must still be the position it was
        // issued as. Nobody's answer may move because somebody arrived after
        // them.
        for (const entry of issued) {
          const now = await broker.status({ key: entry.key });
          assert.equal(
            now.position,
            entry.position,
            'a queued position changed when a later caller arrived',
          );
        }
      }

      // And the whole set is the complete run, with no repeats.
      assert.deepEqual(
        issued.map((entry) => entry.position).sort((a, b) => a - b),
        [1, 2, 3, 4, 5, 6, 7, 8],
      );
    },
    { tabBudget: 1 },
  );
});
