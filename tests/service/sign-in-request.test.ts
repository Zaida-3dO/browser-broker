import assert from 'node:assert/strict';
import test from 'node:test';

import { CallRefusal } from '../../src/service/refusals.ts';
import {
  SIGNABLE_BROWSER,
  SIGN_IN_REQUEST_SECONDS,
  SIGN_IN_WHAT_MAX,
} from '../../src/service/operations/sign-in.ts';
import { claimInput, withBroker } from '../helpers/broker.ts';

/**
 * Asking a person to sign in (`SCHEMA.md` §5.5.2, `DECISIONS.md` §13j).
 *
 * ── What these tests drive, and why it is the shipped path ──────────────
 *
 * Every assertion goes through `broker.sign_in` / `broker.sign_in_done` — the
 * real service, bound to a real store by `withBroker`, running the real
 * arbitration transaction. **Nothing here seeds a browser state by writing to
 * the table**, which matters more for this row than for most: the whole
 * subject is a state transition between two operations, and a test that put
 * the browser into `signing-in` by hand would be asserting that the finish
 * path can move a row somebody inserted.
 *
 * **No browser is started by any test in this file.** The fixture binds no
 * session, so nothing here can leak one — the operations under test do no
 * browser work at all, which is itself the design (§2.4b: browser calls never
 * happen inside the arbitration transaction).
 */

/** Every durable assertion reads the committed row, not the handle's view. */
const BROWSER_ROW =
  'SELECT state, signin_owner_pid, signin_deadline, signin_claim_id FROM browsers WHERE id = @id';

/** The lease row, for the assertions about what a sign-in did *not* touch. */
const CLAIM_ROW =
  'SELECT state, expires_at AS expiresAt, renew_count AS renewCount FROM claims WHERE id = @id';

/** The tab a lease holds, for the same reason. */
const TAB_ROWS =
  "SELECT id, state FROM tabs WHERE claim_id = @claimId AND state IN ('opening','open')";

/**
 * The rule a refusal was recorded under, read from the ledger.
 *
 * ── Why the ledger rather than the thrown refusal ───────────────────────
 *
 * `CallRefusal` looks its rule up **from the code**, deliberately, so *"a
 * surface cannot quietly attribute a refusal to a rule that did not make
 * it"* — several rules share one code on purpose, and `browser_unavailable`
 * is the most shared of them. So the thrown error cannot distinguish
 * `browser.busy_for_login` from `browser.serving`, and asserting on
 * `error.rule` would be asserting on the taxonomy's lookup table rather than
 * on which guard actually fired.
 *
 * The ledger can: §1.6 keeps one row per decision and the `guard` column is
 * the rule that refused, written by the guard itself. **That is the only
 * place these three rules are observable**, which makes it the right place to
 * assert them — and it is the same column an operator greps.
 */
function lastRefusalGuard(
  readCommitted: <T>(sql: string, parameters?: Record<string, unknown>) => T[],
): string | null {
  const [row] = readCommitted<{ guard: string | null }>(
    `SELECT guard FROM events WHERE outcome = 'deny' ORDER BY id DESC LIMIT 1`,
  );
  return row?.guard ?? null;
}

interface BrowserRow {
  readonly state: string;
  readonly signin_owner_pid: number | null;
  readonly signin_deadline: string | null;
  readonly signin_claim_id: string | null;
}

test('a caller holding a tab can ask a person to sign in, and the state says so', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(granted.outcome, 'granted', 'the fixture did not produce a live lease');

    const asked = await broker.sign_in({
      key: granted.key,
      what: 'the account dashboard',
    });

    assert.equal(asked.browser, SIGNABLE_BROWSER);
    assert.equal(asked.state, 'signing-in');
    assert.equal(asked.claimId, granted.claimId);

    // **Read from the committed row.** The mechanism is the state being
    // durable — a caller in another process is what it has to turn away, and
    // that caller cannot see this handle's uncommitted writes.
    const [row] = readCommitted<BrowserRow>(BROWSER_ROW, { id: SIGNABLE_BROWSER });
    assert.equal(row?.state, 'signing-in', 'the browser state did not commit as signing-in');

    // The two columns step ten added, and the one it deliberately leaves
    // alone. A requested sign-in is held by a deadline and a lease, never by a
    // process — recording a process identifier here would make the recovery
    // path read it as permanently live.
    assert.equal(row?.signin_claim_id, granted.claimId, 'the asking lease was not recorded');
    assert.ok(row?.signin_deadline !== null, 'a requested sign-in committed with no deadline');
    assert.equal(
      row?.signin_owner_pid,
      null,
      'a requested sign-in recorded a process as its owner',
    );
  });
});

test('THE PROPERTY MOST LIKELY TO BE GOT WRONG: the asking lease keeps its tab and its life', async () => {
  await withBroker(async ({ broker, readCommitted, closed }) => {
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(granted.outcome, 'granted');

    const [tabBefore] = readCommitted<{ id: string; state: string }>(TAB_ROWS, {
      claimId: granted.claimId,
    });
    assert.ok(tabBefore !== undefined, 'the fixture did not produce a lease holding a tab');

    const asked = await broker.sign_in({ key: granted.key, what: 'the account dashboard' });

    // ── The lease is live, and it is the same lease ──────────────────────
    const [claim] = readCommitted<{ state: string; expiresAt: string }>(CLAIM_ROW, {
      id: granted.claimId,
    });
    assert.equal(claim?.state, 'active', 'asking for a sign-in ended the lease that asked');

    // ── The tab is the same tab, still open ─────────────────────────────
    //
    // The identifier is compared rather than merely counting one open tab: a
    // path that closed this tab and opened a fresh one would keep the count
    // at one and would lose the login page the person is supposed to sign in
    // on, which is the whole point of asking on the tab already there.
    const [tabAfter] = readCommitted<{ id: string; state: string }>(TAB_ROWS, {
      claimId: granted.claimId,
    });
    assert.equal(tabAfter?.id, tabBefore.id, 'the lease was moved to a different tab');
    assert.equal(asked.tabId, tabBefore.id, 'the result named a tab the lease does not hold');

    // ── And nothing was asked to be closed ──────────────────────────────
    //
    // The fixture records what the service *asked* to close rather than
    // closing it, which is what makes this checkable at all: a guard that
    // returns the right answer after the tab has already gone is worse than
    // no guard.
    assert.deepEqual(closed, [], 'asking for a sign-in scheduled a tab to be closed');
  });
});

test('the request renews the asking lease rather than letting it run down', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(granted.outcome, 'granted');

    const [before] = readCommitted<{ expiresAt: string; renewCount: number }>(CLAIM_ROW, {
      id: granted.claimId,
    });
    assert.ok(before !== undefined);

    // §3.1: **there is no keyed call that does not extend.** A caller waiting
    // out a person's sign-in polls, and the poll is what keeps it alive — but
    // the request itself is a keyed call too, and one that did not renew
    // would be a hole in the one rule the whole liveness model rests on.
    const asked = await broker.sign_in({ key: granted.key, what: 'the account dashboard' });

    const [after] = readCommitted<{ expiresAt: string; renewCount: number }>(CLAIM_ROW, {
      id: granted.claimId,
    });
    assert.equal(
      after?.expiresAt,
      asked.leaseExpiresAt,
      'the result did not report the new expiry',
    );

    // **The renewal counter, not the timestamp.** Two calls inside one
    // millisecond produce the same `expires_at`, so `after >= before` on the
    // instant is satisfied by a lease that was never touched — which a
    // mutation removing the renewal proved, by surviving. The counter moves
    // once per renewal and is not a function of the clock, so it is the
    // signal that can actually fail.
    assert.equal(
      after?.renewCount,
      before.renewCount + 1,
      'asking for a sign-in did not extend the lease that asked',
    );
  });
});

test('the requester is not refused by its own request — the exemption is exactly one lease wide', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    // One lease, holding a tab on the signable browser. Under §5.5.1's rule as
    // `begin_sign_in` applies it this is precisely the state that refuses —
    // and it must not refuse here, because this lease is the one asking.
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(granted.outcome, 'granted');

    // The control: the unkeyed operation a person uses still refuses against
    // the very same state, which is what makes the exemption a second rule
    // rather than a weakening of the first.
    const refusedForAPerson = await broker
      .begin_sign_in({ browser: SIGNABLE_BROWSER })
      .then(() => undefined)
      .catch((error: unknown) => error);
    assert.ok(
      refusedForAPerson instanceof CallRefusal,
      'begin_sign_in stopped refusing a live lease, which is the rule this exemption must not weaken',
    );
    assert.equal(lastRefusalGuard(readCommitted), 'browser.busy_for_login');

    // And the request itself is allowed.
    const asked = await broker.sign_in({ key: granted.key, what: 'the account dashboard' });
    assert.equal(asked.state, 'signing-in');
  });
});

test('another live lease holding a tab still refuses the request, naming it', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const asking = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    const other = await broker.claim(
      claimInput({ browser: SIGNABLE_BROWSER, sessionId: 'session-b' }),
    );
    assert.equal(asking.outcome, 'granted');
    assert.equal(other.outcome, 'granted', 'the fixture did not produce a second live lease');

    const refusal = await broker
      .sign_in({ key: asking.key, what: 'the account dashboard' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    assert.ok(refusal instanceof CallRefusal, 'a second live lease did not refuse the request');
    assert.equal(refusal.code, 'browser_unavailable');
    // The guard that actually fired, from the ledger — see `lastRefusalGuard`
    // for why the thrown refusal cannot answer this.
    assert.equal(lastRefusalGuard(readCommitted), 'browser.busy_for_login');

    // Named, which is the part a caller acts on: it is the difference between
    // "you cannot" and "wait for this one".
    assert.match(refusal.message, new RegExp(other.claimId, 'u'), 'the holder was not named');
    assert.match(refusal.message, /session-b/u, 'the holding session was not named');

    // **And the asking lease is not among them.** A refusal that listed the
    // requester would be the exemption failing while still producing the
    // right verdict for the wrong reason — the case a count-only assertion
    // would miss.
    assert.doesNotMatch(
      refusal.message,
      new RegExp(asking.claimId, 'u'),
      'the refusal named the asking lease as an obstacle to itself',
    );

    // The key is never printed by any surface (§5.6), including a refusal
    // that is otherwise being generous with detail about the lease.
    assert.doesNotMatch(refusal.message, new RegExp(other.key, 'u'), 'a lease key leaked');
    assert.ok(
      !JSON.stringify(refusal.detail).includes(other.key),
      'a lease key leaked into the refusal detail',
    );
  });
});

test('a request that says nothing about what it is signing into is refused', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(granted.outcome, 'granted');

    for (const what of ['', '  ', 'x'.repeat(SIGN_IN_WHAT_MAX + 1)]) {
      // Annotated rather than inferred: inside a loop the compiler reads this
      // as referring to itself, because `catch` returns whatever the `try`
      // would have. The annotation says what the two arms actually produce.
      const refusal: unknown = await broker
        .sign_in({ key: granted.key, what })
        .then(() => undefined)
        .catch((error: unknown) => error);

      assert.ok(refusal instanceof CallRefusal, `"${what.slice(0, 8)}" was not refused`);
      // This one **can** be asserted on the thrown refusal, because the code
      // is not shared: `sign_in_what_out_of_bounds` names exactly one rule.
      assert.equal(refusal.rule, 'signin.what_bounded');
      assert.equal(refusal.code, 'sign_in_what_out_of_bounds');
      assert.equal(lastRefusalGuard(readCommitted), 'signin.what_bounded');
    }

    // **The browser was never moved.** A guard that refuses after the state
    // has already changed is the shape this repository names as worse than no
    // guard: every other caller would have been turned away over a request
    // that was itself refused.
    const [row] = readCommitted<BrowserRow>(BROWSER_ROW, { id: SIGNABLE_BROWSER });
    assert.notEqual(row?.state, 'signing-in', 'a refused request still took the browser');
  });
});

test('a queued lease has no tab to sign in on, and is refused', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      const first = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
      assert.equal(first.outcome, 'granted');

      // The budget is one, so the second is queued — a real key with no tab
      // behind it, which is the state §2.5 describes and the only reachable
      // way to a lease that is live and holds nothing.
      const queued = await broker.claim(
        claimInput({ browser: SIGNABLE_BROWSER, sessionId: 'session-b' }),
      );
      assert.equal(queued.outcome, 'queued', 'the fixture did not produce a queue placement');

      const refusal = await broker
        .sign_in({ key: queued.key, what: 'the account dashboard' })
        .then(() => undefined)
        .catch((error: unknown) => error);

      assert.ok(refusal instanceof CallRefusal, 'a queued lease was allowed to ask for a sign-in');
      // Either arm of `signin.requester_holds_tab` is a correct answer here
      // and the rule is what this asserts on, deliberately, rather than which
      // of its two branches fired. A queued lease trips the state check; a
      // lease that somehow reached the tab lookup with nothing open trips the
      // second. **Pinning the branch would make this test a description of
      // the current ordering** — and the ordering is not the guarantee. The
      // guarantee is that a lease with no tab cannot put a person in front of
      // a page that is not there.
      const guard = lastRefusalGuard(readCommitted);
      assert.equal(
        guard,
        'signin.requester_holds_tab',
        `a queued lease was refused by ${String(guard)} rather than for holding no tab`,
      );
    },
    { tabBudget: 1 },
  );
});

test('the request is refused while one is already open, and the caller is told which case it is', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const asking = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(asking.outcome, 'granted');
    await broker.sign_in({ key: asking.key, what: 'the account dashboard' });

    // The same lease asking twice. Refused, and the sentence says the request
    // it already has is still open rather than implying somebody else has the
    // browser — a caller told the wrong one of those waits for the wrong
    // thing.
    const again = await broker
      .sign_in({ key: asking.key, what: 'the account dashboard' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    assert.ok(again instanceof CallRefusal, 'a second request from the same lease was allowed');
    assert.equal(lastRefusalGuard(readCommitted), 'browser.serving');
    assert.match(
      again.message,
      /already asked/u,
      'the caller was not told this was its own request',
    );
  });
});

test('ONLY THE LEASE THAT ASKED MAY FINISH IT', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      // ── Both leases are taken on the SAME browser, and taken FIRST ────────
      //
      // This ordering is the whole of what makes the test reach the guard it
      // names, and getting it wrong made an earlier version of this test hollow
      // in a way that mutation testing caught and reading did not. Two mistakes
      // are available:
      //
      // - **A lease on the other browser** is refused by `resolveSignableBrowser`
      //   long before ownership is considered — correctly, since a caller naming
      //   an unsignable browser should hear about the browser. The test then
      //   passes while the ownership guard is deleted.
      // - **A lease taken after the request** is refused, because a browser
      //   being signed into turns new claims away (§5.5.1 step 2). There is no
      //   second lease at all, and nothing to test with.
      //
      // So both are granted while the browser is still serving, and only then
      // does one of them ask.
      const asking = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
      assert.equal(asking.outcome, 'granted');

      // The second lease is **queued**, not released. A released lease has
      // *ended*, so `claim.live` refuses it before ownership is ever consulted
      // — which is correct ordering and would make this test hollow again, one
      // rule further along. A queued lease is the reachable state that is live
      // and holds no tab (§2.5), so it has a usable key and is not an obstacle
      // to the request.
      const other = await broker.claim(
        claimInput({ browser: SIGNABLE_BROWSER, sessionId: 'session-b' }),
      );
      assert.equal(other.outcome, 'queued', 'the fixture did not produce a queued second lease');

      await broker.sign_in({ key: asking.key, what: 'the account dashboard' });

      const refusal = await broker
        .sign_in_done({ key: other.key })
        .then(() => undefined)
        .catch((error: unknown) => error);

      assert.ok(refusal instanceof CallRefusal, 'a lease finished a sign-in it did not ask for');
      assert.equal(lastRefusalGuard(readCommitted), 'signin.finish_owned');

      // **And the sign-in is still open**, which is the consequence that
      // matters: a person mid-password would otherwise have had the window
      // taken from under them by a caller that never asked for it.
      const [row] = readCommitted<BrowserRow>(BROWSER_ROW, { id: SIGNABLE_BROWSER });
      assert.equal(row?.state, 'signing-in', "another lease's call ended the sign-in");
      assert.equal(row?.signin_claim_id, asking.claimId, 'the asking lease was overwritten');
    },
    { tabBudget: 1 },
  );
});

test("a person's sign-in cannot be ended by a caller at all", async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const holding = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(holding.outcome, 'granted');
    await broker.release({ key: holding.key });

    // `broker login`'s half: no lease behind it, so `signin_claim_id` is null.
    await broker.begin_sign_in({ browser: SIGNABLE_BROWSER, ownerPid: process.pid });

    const caller = await broker
      .claim(claimInput({ browser: SIGNABLE_BROWSER, sessionId: 'session-b' }))
      .then((granted) => granted)
      .catch(() => undefined);
    // A claim is refused while the browser is being signed into, so the caller
    // that tries this is one holding a key from before — reuse the released
    // one, whose lease has ended, and confirm it gets nowhere either.
    assert.equal(caller, undefined, 'a claim was granted against a browser being signed into');

    const refusal = await broker
      .sign_in_done({ key: holding.key })
      .then(() => undefined)
      .catch((error: unknown) => error);
    assert.ok(refusal instanceof CallRefusal, "a caller ended a person's sign-in");

    const [row] = readCommitted<BrowserRow>(BROWSER_ROW, { id: SIGNABLE_BROWSER });
    assert.equal(row?.state, 'signing-in', "a caller ended a person's sign-in");
    assert.equal(row?.signin_owner_pid, process.pid, 'the owning process was cleared');
  });
});

test('finishing gives the browser back and leaves the lease exactly where it was', async () => {
  await withBroker(async ({ broker, readCommitted, closed }) => {
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(granted.outcome, 'granted');
    const [tabBefore] = readCommitted<{ id: string }>(TAB_ROWS, { claimId: granted.claimId });

    await broker.sign_in({ key: granted.key, what: 'the account dashboard' });
    const done = await broker.sign_in_done({ key: granted.key });

    assert.equal(done.browser, SIGNABLE_BROWSER);
    assert.equal(done.claimId, granted.claimId);

    // The browser serves again, and every sign-in column is cleared. A stale
    // deadline or asking lease left on a serving browser is exactly the
    // leftover a later reader trusts.
    const [row] = readCommitted<BrowserRow>(BROWSER_ROW, { id: SIGNABLE_BROWSER });
    assert.notEqual(row?.state, 'signing-in', 'the browser was not given back');
    assert.equal(row?.signin_deadline, null, 'a deadline was left on a serving browser');
    assert.equal(row?.signin_claim_id, null, 'an asking lease was left on a serving browser');

    // And the caller carries straight on: same lease, same tab, nothing closed.
    const [claim] = readCommitted<{ state: string }>(CLAIM_ROW, { id: granted.claimId });
    assert.equal(claim?.state, 'active', 'finishing ended the lease that asked');
    const [tabAfter] = readCommitted<{ id: string }>(TAB_ROWS, { claimId: granted.claimId });
    assert.equal(tabAfter?.id, tabBefore?.id, 'finishing moved the lease to a different tab');
    assert.deepEqual(closed, [], 'finishing scheduled a tab to be closed');
  });
});

test('a sign-in is refused to other callers while it is open, and they keep their places', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const asking = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(asking.outcome, 'granted');
    await broker.sign_in({ key: asking.key, what: 'the account dashboard' });

    // §5.5.1 step 2, which the requested path has to inherit rather than
    // re-implement: from that moment, requests for the browser are refused.
    const refusal = await broker
      .claim(claimInput({ browser: SIGNABLE_BROWSER, sessionId: 'session-c' }))
      .then(() => undefined)
      .catch((error: unknown) => error);

    assert.ok(
      refusal instanceof CallRefusal,
      'a claim was granted against a browser being signed into',
    );
    assert.equal(refusal.code, 'browser_unavailable');
    assert.equal(refusal.retryable, true, 'a pause was reported as permanent');

    // And the asking lease is untouched by that refusal.
    const [claim] = readCommitted<{ state: string }>(CLAIM_ROW, { id: asking.claimId });
    assert.equal(claim?.state, 'active');
  });
});

test('BOUNDING THE WAIT: an unanswered request lapses and the browser serves again', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(granted.outcome, 'granted');

    // One second, which the operation clamps *down* to rather than up — so
    // this is a real deadline the product accepted, not a value forced past
    // its own bound.
    const asked = await broker.sign_in({
      key: granted.key,
      what: 'the account dashboard',
      requestSeconds: 1,
    });
    assert.equal(asked.requestSeconds, 1);

    const [during] = readCommitted<BrowserRow>(BROWSER_ROW, { id: SIGNABLE_BROWSER });
    assert.equal(during?.state, 'signing-in', 'the request never opened');

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // **Nothing runs a timer.** The lapse is reconciled by the next caller's
    // transaction, the same way capacity comes back (§2.4) — so a call is
    // what makes it happen, and any call will do.
    await broker.status({ key: granted.key });

    const [after] = readCommitted<BrowserRow>(BROWSER_ROW, { id: SIGNABLE_BROWSER });
    assert.notEqual(
      after?.state,
      'signing-in',
      'an unanswered request held the browser past its deadline',
    );
    assert.equal(after?.signin_deadline, null, 'a lapsed request left its deadline behind');
    assert.equal(after?.signin_claim_id, null, 'a lapsed request left its asking lease behind');

    // **The caller lost the request and not the work**, which is the property
    // that makes bounding the wait acceptable at all.
    const [claim] = readCommitted<{ state: string }>(CLAIM_ROW, { id: granted.claimId });
    assert.equal(claim?.state, 'active', 'a lapsed request took the asking lease with it');
    const [tab] = readCommitted<{ id: string }>(TAB_ROWS, { claimId: granted.claimId });
    assert.ok(tab !== undefined, 'a lapsed request took the asking tab with it');

    // And the refusal it gets when it tries to finish says what happened.
    const refusal = await broker
      .sign_in_done({ key: granted.key })
      .then(() => undefined)
      .catch((error: unknown) => error);
    assert.ok(refusal instanceof CallRefusal);
    assert.match(refusal.message, /lapsed/u, 'the caller was not told its request had lapsed');
  });
});

test("a person's sign-in has no deadline and is never lapsed by the sweep", async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    // `broker login`'s half: no lease, no deadline, held by a process.
    await broker.begin_sign_in({ browser: SIGNABLE_BROWSER, ownerPid: process.pid });

    const [row] = readCommitted<BrowserRow>(BROWSER_ROW, { id: SIGNABLE_BROWSER });
    assert.equal(row?.state, 'signing-in');
    assert.equal(row?.signin_deadline, null, "a person's sign-in was given a deadline");

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Any call runs the reconciliation. **This is the assertion that keeps
    // §5.5.1's "a person takes as long as they take" true**: a sweep written
    // against `signing-in` alone rather than against the deadline column would
    // end exactly the sign-ins that rule protects, and would do it on the very
    // next call anybody made.
    await broker
      .claim(claimInput({ browser: SIGNABLE_BROWSER, sessionId: 'session-d' }))
      .catch(() => undefined);

    const [after] = readCommitted<BrowserRow>(BROWSER_ROW, { id: SIGNABLE_BROWSER });
    assert.equal(after?.state, 'signing-in', "a person's sign-in was swept away");
  });
});

test('a caller cannot ask for more time than the bound allows', async () => {
  await withBroker(async ({ broker }) => {
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(granted.outcome, 'granted');

    // A bound a caller can raise is not a bound. Asking for a day gets the
    // ceiling, and — the part that keeps this from being silent — the
    // effective value comes back in the field the caller reads to know when
    // to stop waiting.
    const asked = await broker.sign_in({
      key: granted.key,
      what: 'the account dashboard',
      requestSeconds: 86_400,
    });

    assert.equal(
      asked.requestSeconds,
      SIGN_IN_REQUEST_SECONDS,
      'a caller widened the deadline past its ceiling',
    );
  });
});

test('the result carries what the calling agent has to relay onward', async () => {
  await withBroker(async ({ broker }) => {
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(granted.outcome, 'granted');

    const asked = await broker.sign_in({ key: granted.key, what: 'the account dashboard' });

    // §5.5.2: the service never speaks to a person — the calling agent does.
    // So the result has to carry enough for that agent to say which login wall
    // this is, where it is, and what to do next.
    assert.match(
      asked.relay,
      /account dashboard/u,
      'the relay does not say what is being signed into',
    );
    assert.match(
      asked.relay,
      new RegExp(SIGNABLE_BROWSER, 'u'),
      'the relay does not name the browser',
    );
    assert.match(asked.relay, /browser_sign_in_done/u, 'the relay does not say how to finish');
    assert.match(asked.relay, /browser_status/u, 'the relay does not say how to hold the lease');
    assert.equal(
      asked.what,
      'the account dashboard',
      'the caller’s own words were not echoed back',
    );

    // Never the key, on any field of any surface (§5.6).
    assert.ok(!JSON.stringify(asked).includes(granted.key), 'a lease key leaked into the result');
  });
});

test('both edges are recorded, and a lapse is distinguishable from a person finishing', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const granted = await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));
    assert.equal(granted.outcome, 'granted');

    await broker.sign_in({ key: granted.key, what: 'the account dashboard' });
    await broker.sign_in_done({ key: granted.key });

    // §1.6 keeps one row per decision, and §5.5.1's own reasoning for
    // recording both edges is that a run of denials should read as a person
    // signing in rather than as a browser fault.
    const events = readCommitted<{ kind: string; detail: string | null }>(
      `SELECT kind, detail FROM events WHERE kind IN ('browser_signin_began','browser_signin_ended') ORDER BY id`,
    );
    assert.equal(events.length, 2, 'the two edges of a requested sign-in were not both recorded');
    assert.equal(events[0]?.kind, 'browser_signin_began');
    assert.equal(events[1]?.kind, 'browser_signin_ended');

    // The began row says a caller asked and which lease, so a reader can tell
    // this apart from `broker login`.
    assert.match(String(events[0]?.detail), /"requested":true/u);
    assert.match(String(events[0]?.detail), new RegExp(granted.claimId, 'u'));
    // And the ended row says a person confirmed rather than a deadline
    // passing — the two are different facts and a reader tuning the bound
    // needs them apart.
    assert.match(String(events[1]?.detail), /"confirmed":true/u);

    // **The sentence a caller wrote is never in the ledger.** Step six's
    // header is explicit that its rows are built by hand and that a
    // well-meaning addition is how that stops being true.
    assert.doesNotMatch(
      String(events[0]?.detail),
      /account dashboard/u,
      'caller text reached the ledger',
    );
  });
});
