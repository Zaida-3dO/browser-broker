import assert from 'node:assert/strict';
import test from 'node:test';

import { CallRefusal } from '../../src/service/refusals.ts';
import { SIGNABLE_BROWSER, SIGN_IN_RULES } from '../../src/service/operations/sign-in.ts';
import { claimInput, withBroker } from '../helpers/broker.ts';

/**
 * `broker login`'s service half (`SCHEMA.md` §5.5.1).
 *
 * ── What these tests drive, and why it is the shipped path ──────────────
 *
 * Every assertion below goes through `broker.begin_sign_in` /
 * `broker.end_sign_in` — the real service, bound to a real store by
 * `withBroker`, running the real arbitration transaction. Nothing here
 * reimplements a decision or seeds a state by writing to the tables directly.
 *
 * **That is the point rather than a stylistic preference.** The house
 * standard names *seeding a state the product cannot reach* as a hollow
 * shape, and the state most tempting to seed here is exactly the one that
 * matters: a browser holding a live lease. So the leases these tests refuse
 * against are granted by `broker.claim`, the way a caller gets one.
 */

/** Every durable assertion reads the committed row, not the handle's view. */
const BROWSER_STATE = 'SELECT state, pid FROM browsers WHERE id = @id';

test('a person can claim the signed-in browser, and the state says so', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const began = await broker.begin_sign_in({ browser: SIGNABLE_BROWSER });

    assert.equal(began.browser, SIGNABLE_BROWSER);
    assert.equal(began.state, 'signing-in');
    // Relative, never absolute (§1.7a).
    assert.equal(began.profileRelativePath, SIGNABLE_BROWSER);

    // **Read from the committed row.** The mechanism is the state being
    // durable — a caller in another process is what it has to turn away, and
    // that caller cannot see this handle's uncommitted writes.
    const [row] = readCommitted<{ state: string }>(BROWSER_STATE, { id: SIGNABLE_BROWSER });
    assert.equal(row?.state, 'signing-in', 'the browser state did not commit as signing-in');
  });
});

test('THE REFUSAL THAT MAKES THIS A SERVICE OPERATION: a live lease holding a tab', async () => {
  await withBroker(async ({ broker }) => {
    // Granted through the product, not written into the table. A lease seeded
    // by hand would prove the query matches rows somebody inserted, which is
    // not the claim being made.
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(granted.outcome, 'granted', 'the fixture did not produce a live lease');

    const refusal = await broker
      .begin_sign_in({ browser: SIGNABLE_BROWSER })
      .then(() => undefined)
      .catch((error: unknown) => error);

    assert.ok(refusal instanceof CallRefusal, 'a live lease did not refuse the sign-in');
    assert.equal(refusal.rule, 'browser.serving');
    assert.equal(refusal.code, 'browser_unavailable');

    // §5.5.1 step 1 says the refusal **names them**, and that is the part a
    // person acts on: it is the difference between "you cannot" and "wait for
    // this one". Asserted on the sentence because the sentence is what they
    // read.
    assert.match(refusal.message, new RegExp(granted.claimId, 'u'), 'the holder was not named');
    assert.match(refusal.message, /session-a/u, 'the holding session was not named');

    // And the key is never printed by any surface (§5.6) — including a
    // refusal that is otherwise being generous with detail about the lease.
    assert.doesNotMatch(refusal.message, new RegExp(granted.key, 'u'), 'a lease key leaked');
    assert.ok(
      !JSON.stringify(refusal.detail).includes(granted.key),
      'a lease key leaked into the refusal detail',
    );
  });
});

test('a released lease does not refuse a sign-in — the check is liveness, not history', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    await broker.release({ key: granted.key });

    // **The counterweight to the test above, and it is what stops that one
    // passing for the wrong reason.** A check that refused whenever a claim
    // row existed would pass the previous assertion and be wrong: it would
    // make a browser unsignable forever after its first caller. The rule is
    // that a *live* lease holds a tab, so a released one must not refuse.
    const began = await broker.begin_sign_in({ browser: SIGNABLE_BROWSER });
    assert.equal(began.state, 'signing-in');

    const [row] = readCommitted<{ state: string }>(BROWSER_STATE, { id: SIGNABLE_BROWSER });
    assert.equal(row?.state, 'signing-in');
  });
});

test('AN EXPIRED LEASE DOES NOT REFUSE A SIGN-IN — the sweep runs first', async () => {
  await withBroker(
    async ({ broker }) => {
      // The whole reason §5.5.1 makes this a service operation rather than a
      // command: the check has to run against the state the arbitration
      // transaction's own sweep reconciled. This lease is never released —
      // its holder simply stops calling in, which is the failure mode
      // reclamation exists for — and the sign-in must not be refused over a
      // caller that is already gone.
      const abandoned = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
      assert.equal(abandoned.outcome, 'granted');

      await new Promise((resolve) => setTimeout(resolve, 1_100));

      // No explicit expiry call: `begin_sign_in` sweeps globally before its
      // handler is reached, exactly as every other arbitration call does.
      const began = await broker.begin_sign_in({ browser: SIGNABLE_BROWSER });
      assert.equal(began.state, 'signing-in', 'a lapsed lease blocked a sign-in');
    },
    { leaseSeconds: 1 },
  );
});

test('THE PRIVATE BROWSER IS REFUSED — an ephemeral profile keeps no sign-in', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const refusal = await broker
      .begin_sign_in({ browser: 'private' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    assert.ok(refusal instanceof CallRefusal, 'the private browser accepted a sign-in');
    // §5.5.1: the failure this prevents is a command that *appears to work*,
    // so the sentence has to say that rather than only saying no.
    assert.match(refusal.message, /ephemeral|discarded/u);

    // **The rule and the sentence must agree.** This was wrong once: the
    // refusal borrowed `unknown_browser`, so the command reported the rule
    // `claim.browser_known` while the message correctly explained that the
    // profile was ephemeral. The private browser *is* one of the two, so a
    // caller branching on that rule would conclude it had a typo and retry
    // the identical word forever. The taxonomy looks the rule up from the
    // code for exactly this reason, which means the wrong rule is only ever
    // fixable by using the right code.
    assert.equal(refusal.code, 'cannot_sign_in');
    assert.equal(refusal.rule, SIGN_IN_RULES.serving);
    assert.notEqual(refusal.rule, 'claim.browser_known', 'refused as though the name were wrong');
    // And waiting will never help, so it must not invite a retry.
    assert.equal(refusal.retryable, false);
    assert.match(
      refusal.message,
      new RegExp(SIGNABLE_BROWSER, 'u'),
      'it did not say which browser',
    );

    // Nothing moved. A refusal that had already changed the state would be
    // the shape `DECISIONS.md` §5 names — a denial reported after the effect.
    const [row] = readCommitted<{ state: string }>(BROWSER_STATE, { id: 'private' });
    assert.notEqual(row?.state, 'signing-in', 'the private browser was moved into signing-in');
  });
});

test('a browser that is not one of the two is refused as a name, not as a policy', async () => {
  await withBroker(async ({ broker }) => {
    const refusal = await broker
      .begin_sign_in({ browser: 'teleport' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    assert.ok(refusal instanceof CallRefusal);
    // Two different mistakes get two different sentences: this one is about
    // the name existing, and must not read as though a real browser declined.
    assert.match(refusal.message, /no browser named/iu);
  });
});

test('a second sign-in is refused while one is open', async () => {
  await withBroker(async ({ broker }) => {
    await broker.begin_sign_in({ browser: SIGNABLE_BROWSER });

    const refusal = await broker
      .begin_sign_in({ browser: SIGNABLE_BROWSER })
      .then(() => undefined)
      .catch((error: unknown) => error);

    assert.ok(refusal instanceof CallRefusal, 'two people were handed the same window');
    assert.equal(refusal.rule, 'browser.serving');
  });
});

test('ending a sign-in that never began is refused', async () => {
  await withBroker(async ({ broker }) => {
    const refusal = await broker
      .end_sign_in({ browser: SIGNABLE_BROWSER })
      .then(() => undefined)
      .catch((error: unknown) => error);

    assert.ok(refusal instanceof CallRefusal, 'the browser state was moved by a call for nothing');
  });
});

test('THE GATE: a browser being signed into refuses callers, and the refusal is retryable', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    await broker.begin_sign_in({ browser: SIGNABLE_BROWSER });

    const refusal = await broker
      .claim(claimInput({ browser: SIGNABLE_BROWSER, sessionId: 'session-b' }))
      .then(() => undefined)
      .catch((error: unknown) => error);

    // **Without this, the `signing-in` state is decorative.** It is a value
    // in a column that nothing reads, and a person would be handed a window
    // while callers carried on opening tabs in it.
    assert.ok(refusal instanceof CallRefusal, 'a caller was admitted mid-sign-in');
    assert.equal(refusal.rule, 'browser.serving');
    assert.equal(refusal.code, 'browser_unavailable');

    // §2.2's line: this is availability, not capacity, so it is retryable and
    // the caller is told to come back rather than being queued.
    assert.equal(refusal.retryable, true);
    assert.match(refusal.message, /again/iu, 'the retry hint §5.5.1 asks for is missing');

    // **And it cost the refused caller nothing.** §2.2 puts the refusal
    // before any row is written, so there is no lease to release and no tab
    // budget spent — asserted on the committed rows rather than inferred.
    const claims = readCommitted<{ n: number }>('SELECT COUNT(*) AS n FROM claims');
    assert.equal(claims[0]?.n, 0, 'a refused caller left a claim row behind');
  });
});

test('the private browser keeps serving while the other is being signed into', async () => {
  await withBroker(async ({ broker }) => {
    await broker.begin_sign_in({ browser: SIGNABLE_BROWSER });

    // The counterweight to the gate above: a check that refused every caller
    // regardless of which browser they asked for would pass that test and be
    // wrong. Only the browser a person is holding is unavailable.
    const granted = await broker.claim(claimInput({ browser: 'private' }));
    assert.equal(granted.outcome, 'granted', 'the private browser was taken out of service too');
  });
});

test('A SIGN-IN IS A PAUSE, NOT A CANCELLATION: queued callers keep their places', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      // ── Why the queued caller waits on the OTHER browser ────────────────
      //
      // The first shape this test took was: fill the signed-in browser, queue
      // a second caller behind it, release the first, sign in. **The product
      // refused, and it was right to** — releasing the active lease promotes
      // the queued caller straight into it, so by the time the sign-in asked,
      // a live lease held a tab again. That is the previous test's rule
      // working, not a bug, and writing around it would have meant weakening
      // the very refusal this file exists to prove.
      //
      // The queue is global (one budget across both browsers), so a caller
      // queued against the private browser is genuinely queued, genuinely
      // keeps a place and a timer, and is not promoted by anything the
      // sign-in does. That is the state §5.5.1's promise is actually about.
      const holder = await broker.claim(claimInput({ browser: 'private' }));
      assert.equal(holder.outcome, 'granted');

      const queued = await broker.claim(claimInput({ browser: 'private', sessionId: 'session-b' }));
      assert.equal(queued.outcome, 'queued', 'the fixture did not produce a queued caller');
      const positionBefore = queued.outcome === 'queued' ? queued.position : undefined;

      await broker.begin_sign_in({ browser: SIGNABLE_BROWSER });
      const ended = await broker.end_sign_in({ browser: SIGNABLE_BROWSER });

      // §5.5.1: "Queued callers keep their places and their timers, because a
      // sign-in is a pause and not a cancellation." The queued caller is
      // still queued, still in the same place, and still addressable with the
      // key it already holds.
      assert.equal(ended.queueDepth, 1, 'the queued caller was dropped by the sign-in');

      const after = await broker.status({ key: queued.key });
      assert.equal(after.state, 'queued', 'the queued caller lost its place');
      assert.equal(after.position, positionBefore, 'the queued caller moved position');

      const rows = readCommitted<{ n: number }>(
        "SELECT COUNT(*) AS n FROM claims WHERE state = 'queued'",
      );
      assert.equal(rows[0]?.n, 1);
    },
    { tabBudget: 1 },
  );
});

test('ending a sign-in returns the browser to service and callers are admitted again', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    await broker.begin_sign_in({ browser: SIGNABLE_BROWSER });
    const ended = await broker.end_sign_in({ browser: SIGNABLE_BROWSER });

    // No browser was ever running in this fixture, so the honest destination
    // is `stopped` rather than `running` — the table's own check constraint
    // ties `stopped` to a null process, and a state moved without regard to
    // it would be rejected by the store.
    assert.equal(ended.state, 'stopped');

    const [row] = readCommitted<{ state: string }>(BROWSER_STATE, { id: SIGNABLE_BROWSER });
    assert.notEqual(row?.state, 'signing-in', 'the browser was left claimed by a person');

    // The gate has lifted: the caller refused a moment ago is admitted.
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(granted.outcome, 'granted', 'callers are still refused after the sign-in ended');
  });
});

test('both edges of the interval are in the ledger, and neither carries a credential', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    await broker.begin_sign_in({ browser: SIGNABLE_BROWSER });
    await broker.end_sign_in({ browser: SIGNABLE_BROWSER });

    const rows = readCommitted<{ kind: string; browserId: string; detail: string | null }>(
      "SELECT kind, browser_id AS browserId, detail FROM events WHERE kind LIKE 'browser_signin%' ORDER BY id",
    );

    // §1.6 requires every decision recorded, and this is the one interval in
    // which the service turns callers away on purpose — so without both edges
    // a reader cannot tell a sign-in from a fault.
    assert.deepEqual(
      rows.map((row) => row.kind),
      ['browser_signin_began', 'browser_signin_ended'],
    );
    assert.ok(rows.every((row) => row.browserId === SIGNABLE_BROWSER));

    // Which browser and when, and nothing a person typed. The ledger is a
    // file that gets read and pasted into messages.
    const everything = rows.map((row) => row.detail ?? '').join(' ');
    assert.doesNotMatch(everything, /password|credential|token|cookie/iu);
  });
});

test('a refused sign-in is in the ledger too, so a guard firing is visible', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    await broker.begin_sign_in({ browser: SIGNABLE_BROWSER }).catch(() => undefined);

    // **A refusal throws and the throw rolls the transaction back**, so a
    // guard that recorded its denial with an ordinary append would write a
    // row that never commits — leaving a ledger of grants that can never show
    // a guard firing (§1.6). This asserts the refusal survived the rollback.
    const rows = readCommitted<{ guard: string | null }>(
      "SELECT guard FROM events WHERE kind = 'browser_signin_began' AND outcome = 'deny'",
    );
    assert.equal(rows.length, 1, 'the refused sign-in left no ledger row');
    assert.equal(rows[0]?.guard, SIGN_IN_RULES.busyForLogin);
  });
});
