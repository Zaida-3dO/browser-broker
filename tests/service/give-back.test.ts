import assert from 'node:assert/strict';
import test from 'node:test';

import { CallRefusal } from '../../src/service/refusals.ts';
import { claimInput, withBroker } from '../helpers/broker.ts';

/**
 * `browser_release` (§3.4) — rows #15 and #72.
 *
 * **Every lease in this file is created by `broker.claim`**, never seeded.
 * That is the point of the file rather than a stylistic preference: these
 * rows shipped with no test at all, and the sweep tests that did exist were
 * green against a tab shape no code path produces — so a release built on a
 * seeded tab would repeat exactly the mistake that let a store-bricking
 * defect through a 381-test suite. If the product changes what a granted tab
 * looks like, these tests change with it or they fail.
 */

test('releasing an active lease gives back its tab and its capacity', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      const granted = await broker.claim(claimInput());
      if (granted.outcome !== 'granted') {
        assert.fail('expected a grant');
      }

      const result = await broker.release({ key: granted.key });

      assert.equal(result.released, 'tab');
      assert.equal(result.alreadyEnded, false);
      assert.equal(result.state, 'released');

      // Read on a second, read-only connection: what committed.
      const claims = readCommitted<{ state: string; endedAt: string | null }>(
        'SELECT state, ended_at AS endedAt FROM claims WHERE id = @id',
        { id: granted.claimId },
      );
      assert.equal(claims[0]?.state, 'released');
      assert.notEqual(claims[0]?.endedAt, null, 'a final lease records when it ended');

      // The capacity is genuinely back: the budget is one, and a second
      // caller is granted rather than queued.
      const next = await broker.claim(claimInput({ sessionId: 'session-b' }));
      assert.equal(next.outcome, 'granted', 'the released capacity did not come back');
    },
    { tabBudget: 1 },
  );
});

test('a released tab that never opened ends as closed, and no driver is asked', async () => {
  // Nothing in this build opens a tab, so every granted tab has no driver
  // name. §1.4 makes `closing` mean "the tool was asked and has not
  // answered", which is false of a page that never existed — and the schema
  // refuses it, which is how the defect this pins announced itself.
  await withBroker(async ({ broker, closed, readCommitted }) => {
    const granted = await broker.claim(claimInput());
    if (granted.outcome !== 'granted') {
      assert.fail('expected a grant');
    }

    await broker.release({ key: granted.key });

    const tabs = readCommitted<{ state: string; driverTabId: string | null }>(
      'SELECT state, driver_tab_id AS driverTabId FROM tabs WHERE id = @id',
      { id: granted.tabId },
    );
    assert.equal(tabs[0]?.state, 'closed');
    assert.equal(tabs[0]?.driverTabId, null);

    // The physical side-effect, from the other direction: the driver was not
    // asked to close a page that does not exist.
    assert.deepEqual(closed, [], 'a tab that never opened was handed to the driver to close');
  });
});

test('releasing a queued place gives back the place, and is complete at commit', async () => {
  // Row #72. A queued caller that changes its mind otherwise has no way out
  // and blocks everyone behind it until it lapses — the same failure as a
  // dead entry at the head, with the aggravating detail that this one is
  // alive and would happily have stood aside if asked.
  await withBroker(
    async ({ broker, readCommitted }) => {
      await broker.claim(claimInput());
      const queued = await broker.claim(claimInput({ sessionId: 'session-b' }));
      if (queued.outcome !== 'queued') {
        assert.fail('expected a queue placement');
      }

      const result = await broker.release({ key: queued.key });

      assert.equal(result.released, 'queue-place');
      // **Complete at commit**, because there is no browser round trip in it —
      // the one case where §2.4b's best-effort caveat does not apply and the
      // response can say so without qualification.
      assert.equal(result.completeAtCommit, true);

      assert.equal(readCommitted('SELECT id FROM tabs').length, 1, 'a queued release closed a tab');
    },
    { tabBudget: 1 },
  );
});

test('releasing an active lease is not complete at commit — the page close is best effort', async () => {
  // The asymmetry with the queued half is reported rather than left to be
  // inferred: capacity has definitely come back, the page has probably
  // closed.
  await withBroker(async ({ broker }) => {
    const granted = await broker.claim(claimInput());
    if (granted.outcome !== 'granted') {
      assert.fail('expected a grant');
    }
    const result = await broker.release({ key: granted.key });
    assert.equal(result.completeAtCommit, false);
  });
});

test('everyone behind a released queue place moves up immediately', async () => {
  await withBroker(
    async ({ broker }) => {
      await broker.claim(claimInput());
      const first = await broker.claim(claimInput({ sessionId: 'session-b' }));
      const second = await broker.claim(claimInput({ sessionId: 'session-c' }));
      if (first.outcome !== 'queued' || second.outcome !== 'queued') {
        assert.fail('expected two queue placements');
      }
      assert.equal(second.position, 2);

      await broker.release({ key: first.key });

      const after = await broker.status({ key: second.key });
      assert.equal(after.position, 1, 'a caller behind a released place did not move up');
    },
    { tabBudget: 1 },
  );
});

test('releasing an active lease promotes the front of the queue', async () => {
  // The capacity that comes back reaches whoever is waiting, in the same
  // transaction, rather than waiting for the next caller to arrive.
  await withBroker(
    async ({ broker, readCommitted }) => {
      const holder = await broker.claim(claimInput());
      const waiting = await broker.claim(claimInput({ sessionId: 'session-b' }));
      if (holder.outcome !== 'granted' || waiting.outcome !== 'queued') {
        assert.fail('expected a grant and a queue placement');
      }

      const result = await broker.release({ key: holder.key });
      assert.equal(result.promoted, 1);

      const promoted = await broker.status({ key: waiting.key });
      assert.equal(promoted.state, 'active');
      assert.notEqual(promoted.tabId, undefined, 'a promoted lease has no tab');

      const rows = readCommitted<{ state: string }>('SELECT state FROM claims WHERE id = @id', {
        id: waiting.claimId,
      });
      assert.equal(rows[0]?.state, 'active');
    },
    { tabBudget: 1 },
  );
});

test('releasing twice succeeds, and says the lease had already ended', async () => {
  // **Forgiving, and only this operation is** (§2.2). A caller tidying up in
  // a cleanup path and again on shutdown must not see an error for tidying
  // twice, and there is nothing to corrupt.
  await withBroker(async ({ broker }) => {
    const granted = await broker.claim(claimInput());
    if (granted.outcome !== 'granted') {
      assert.fail('expected a grant');
    }

    await broker.release({ key: granted.key });
    const again = await broker.release({ key: granted.key });

    assert.equal(again.alreadyEnded, true);
    assert.equal(again.released, 'nothing');
    assert.equal(again.state, 'released');
    assert.equal(again.completeAtCommit, true, 'nothing was held, so nothing is outstanding');
  });
});

test('releasing an unrecognised key is the one refusal, and nothing is written', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const granted = await broker.claim(claimInput());
    if (granted.outcome !== 'granted') {
      assert.fail('expected a grant');
    }

    await assert.rejects(
      () => broker.release({ key: 'not-a-key-this-store-has-ever-issued' }),
      (error: unknown) => {
        assert.ok(error instanceof CallRefusal);
        assert.equal(error.code, 'unrecognised_key');
        assert.equal(error.rule, 'key.valid');
        return true;
      },
    );

    // The side-effect assertion: the healthy lease is untouched.
    const claims = readCommitted<{ state: string }>('SELECT state FROM claims WHERE id = @id', {
      id: granted.claimId,
    });
    assert.equal(claims[0]?.state, 'active', 'a refused release ended somebody else’s lease');
  });
});

test('a released lease cannot be used, only released again', async () => {
  // Releasing is forgiving; everything else is not. A caller about to do work
  // it cannot do should be told now, not one operation later.
  await withBroker(async ({ broker }) => {
    const granted = await broker.claim(claimInput());
    if (granted.outcome !== 'granted') {
      assert.fail('expected a grant');
    }
    await broker.release({ key: granted.key });

    await assert.rejects(
      () => broker.status({ key: granted.key }),
      (error: unknown) => {
        assert.ok(error instanceof CallRefusal);
        assert.equal(error.code, 'lease_ended');
        assert.equal(error.rule, 'claim.live');
        // Names the state and when, per §2.2 — a caller told only "no" cannot
        // tell a revoke it should escalate from an expiry it should retry.
        assert.match(error.message, /released/);
        return true;
      },
    );
  });
});

test('a release is recorded, and so is the refusal of one', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const granted = await broker.claim(claimInput());
    if (granted.outcome !== 'granted') {
      assert.fail('expected a grant');
    }
    await broker.release({ key: granted.key });
    await assert.rejects(() => broker.release({ key: 'no-such-key' }));

    const allowed = readCommitted<{ kind: string }>(
      "SELECT kind FROM events WHERE outcome = 'allow' AND kind = 'claim_released'",
    );
    assert.equal(allowed.length, 1);

    // The refusal survives the rollback its own throw caused.
    const denied = readCommitted<{ guard: string }>(
      "SELECT guard FROM events WHERE outcome = 'deny' AND kind = 'claim_released'",
    );
    assert.equal(denied.length, 1);
    assert.equal(denied[0]?.guard, 'key.valid');
  });
});

test('active leases and live tab rows are the same count, through a promotion', async () => {
  // §1.4: "a lease is a tab (§2.3), so this table and the live part of
  // `claims` have the same number of rows, always". A promotion that flipped
  // the state without creating the tab row broke that identity **invisibly**,
  // because every capacity count in the service counts claims — nothing would
  // have reported it.
  //
  // The mutation that breaks this is removing the tab insert from
  // `promoteWhileCapacity`.
  await withBroker(
    async ({ broker, readCommitted }) => {
      const holder = await broker.claim(claimInput());
      await broker.claim(claimInput({ sessionId: 'session-b' }));
      if (holder.outcome !== 'granted') {
        assert.fail('expected a grant');
      }

      await broker.release({ key: holder.key });

      const active = readCommitted<{ n: number }>(
        "SELECT count(*) AS n FROM claims WHERE state = 'active'",
      )[0]?.n;
      const liveTabs = readCommitted<{ n: number }>(
        "SELECT count(*) AS n FROM tabs WHERE state IN ('opening', 'open')",
      )[0]?.n;

      assert.equal(active, 1);
      assert.equal(liveTabs, active, 'a live lease held no tab row, or a tab row held no lease');
    },
    { tabBudget: 1 },
  );
});
