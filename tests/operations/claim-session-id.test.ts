import assert from 'node:assert/strict';
import test from 'node:test';

import { SESSION_ID_MINIMUM } from '../../src/service/operations/claim.ts';
import { CallRefusal } from '../../src/service/refusals.ts';
import { claimInput, withBroker } from '../helpers/broker.ts';

/**
 * `claim.session_bounded` (§7.1) — the session identity is refused by the
 * service, before a statement reaches the store.
 *
 * ── What was wrong, and why it is worse than the purpose defect ─────────
 *
 * The same coercion, with none of the noise. `bridge.ts`'s `asString` turns a
 * missing argument into `''`, exactly as it did for `purpose`. But
 * `claims.purpose` had `CHECK (length(purpose) BETWEEN 3 AND 200)` standing
 * behind it, so the missing guard announced itself as an unhandled
 * `SqliteError` — and was fixed. **`claims.session_id` is `TEXT NOT NULL`
 * with no `CHECK` at all**, and `''` satisfies `NOT NULL`, so there was
 * nothing behind it to fail. `broker claim` with no `--session-id` returned a
 * granted lease with a real key and a real tab, and wrote `session_id = ''`
 * to the claims row and to every one of its ledger events.
 *
 * So the property under test is **not** "a bad session id is refused" —
 * nothing would have refused it, which is the defect. It is that the service
 * refuses and *nothing reaches the store*, and that the ledger is left able
 * to say who was refused.
 *
 * ── The fixture trap, and why this file escapes it for free ─────────────
 *
 * `claim-purpose.test.ts` had to work to find an input the column would have
 * accepted, because the column had an opinion. Here the column has none: it
 * accepts every string, so **every input below is one the store would have
 * taken**. There is no coincident fixture available to write. The first test
 * measures that premise in the open rather than asserting it, so that a
 * future `CHECK` added to the column turns this file's reasoning into a
 * failure instead of silently invalidating it.
 */

/**
 * The premise the whole file rests on, measured rather than claimed.
 *
 * If somebody later adds a `CHECK` to `claims.session_id`, the tests below
 * stop being able to prove the guard is what refused — they would pass just
 * as happily on a crash the store produced. This fails at that moment and
 * says so, rather than letting the file degrade into a coincident fixture.
 */
test('premise: the column itself would accept an empty session id, so only the guard can refuse it', async () => {
  await withBroker(({ store }) => {
    const constraint = store.db
      .prepare<[], { sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'claims'`)
      .get();
    assert.ok(constraint, 'the claims table exists');

    // The column is NOT NULL and nothing more. Asserted over the table's own
    // DDL rather than by trying an insert, because an insert would need every
    // other column of a valid claim and would prove less clearly.
    assert.match(
      constraint.sql,
      /session_id\s+TEXT NOT NULL/,
      'session_id is declared TEXT NOT NULL',
    );
    assert.doesNotMatch(
      constraint.sql,
      /length\(session_id\)/,
      'no length CHECK stands behind session_id — the guard is the only thing that can refuse',
    );

    // And the empty string really does satisfy that declaration: NOT NULL is
    // not not-empty, which is the whole reason the grant went through.
    const satisfiesNotNull = store.db
      .prepare<{ value: string }, { ok: number }>('SELECT (@value IS NOT NULL) AS ok')
      .get({ value: '' });
    assert.equal(
      satisfiesNotNull?.ok,
      1,
      "'' satisfies NOT NULL, so the store would have written it",
    );
  });
});

test('a missing session id is refused by the service, and no lease is written', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    // What a surface actually delivers for an absent argument: `bridge.ts`'s
    // `asString` turns `undefined` into the empty string, which is why the
    // TypeScript signature `sessionId: string` never caught this.
    await assert.rejects(
      async () => await broker.claim(claimInput({ sessionId: '' })),
      (error: unknown) => {
        assert.ok(error instanceof CallRefusal, 'refused, not crashed');
        assert.equal(error.code, 'session_id_missing');
        assert.equal(error.rule, 'claim.session_bounded');
        return true;
      },
    );

    // The refusal happened *instead of* the insert rather than after it.
    // Before the guard this count was 1, and the row it counted was anonymous.
    const claims = readCommitted<{ count: number }>('SELECT count(*) AS count FROM claims');
    assert.equal(claims[0]?.count, 0, 'nothing reached the store');
  });
});

/**
 * The argument that never arrived at all, as distinct from one that arrived
 * blank.
 *
 * A caller omitting the field entirely produces `undefined` on an in-process
 * call, where a command line produces `''`. Both are the same mistake and
 * both must be refused, but only one of them is what the TypeScript signature
 * claims cannot happen — so it is checked past the type, the way a process
 * boundary delivers it.
 */
test('an absent session id is refused, and the message distinguishes it from a blank one', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    await assert.rejects(
      async () => await broker.claim(claimInput({ sessionId: undefined as unknown as string })),
      (error: unknown) => {
        assert.ok(error instanceof CallRefusal);
        assert.equal(error.code, 'session_id_missing');
        // "was not supplied", not "is empty" — the two mistakes read
        // differently to the caller who made one of them.
        assert.match(error.message, /was not supplied/);
        return true;
      },
    );

    const claims = readCommitted<{ count: number }>('SELECT count(*) AS count FROM claims');
    assert.equal(claims[0]?.count, 0);
  });
});

/**
 * **The discriminating test: an input the store would unambiguously have
 * written as a lease.**
 *
 * A non-string is what an argument of the wrong JSON type arrives as on the
 * tool surface. Handed to this column it would not merely have passed a
 * constraint — there is no constraint — it would have been coerced by SQLite
 * and stored, producing a lease whose owner is the number `1234`. The store
 * would have said yes, loudly and permanently.
 *
 * So if this call is refused, the guard is the only thing that can have
 * refused it. Delete the `typeof input.sessionId !== 'string'` clause and
 * this test fails while the empty-string tests above still pass.
 */
test('a non-string session id is refused by the guard — an input the store would have written', async () => {
  await withBroker(async ({ broker, readCommitted, store }) => {
    // The premise, measured: the value survives a round trip into a TEXT
    // column rather than being rejected by it.
    //
    // The *text* it coerces to is asserted as a property rather than as a
    // literal, deliberately. The driver binds a JS number as a SQLite REAL,
    // so this actually yields `'1234.0'` — which is itself part of the point
    // (the stored owner would not even have been the string the caller sent),
    // but pinning the exact spelling would make this test fail on a driver
    // change for a reason that has nothing to do with the guard. What has to
    // be true is that the store produces *a non-empty text value* rather than
    // rejecting the input, because that is what it would have written.
    const stored = store.db
      .prepare<{ value: unknown }, { round: string | null }>('SELECT CAST(@value AS TEXT) AS round')
      .get({ value: 1234 });
    assert.equal(typeof stored?.round, 'string');
    assert.ok(
      (stored?.round ?? '').length > 0,
      'premise: the store would have accepted this value as a session id',
    );

    await assert.rejects(
      // Deliberately past the type: this is what a caller sending
      // `{"session_id": 1234}` produces, and the type system is not present
      // at a process boundary.
      async () => await broker.claim(claimInput({ sessionId: 1234 as unknown as string })),
      (error: unknown) => {
        assert.ok(error instanceof CallRefusal, 'refused, not crashed');
        assert.equal(error.code, 'session_id_missing');
        assert.equal(error.rule, 'claim.session_bounded');
        assert.match(error.message, /rather than as text/);
        return true;
      },
    );

    const claims = readCommitted<{ count: number }>('SELECT count(*) AS count FROM claims');
    assert.equal(claims[0]?.count, 0, 'the guard refused instead of the store writing it');
  });
});

/**
 * The refusal is on the ledger, which is what makes it a decision rather than
 * an exception (§1.6) — and it is the one refusal on this operation that must
 * *not* carry a session id.
 *
 * Every other refusal in `decideClaim` attaches `sessionId: input.sessionId`,
 * because §1.6 exists so a denied request is attributable. This guard cannot:
 * the identity is the thing that is missing, so attaching it would write the
 * empty string the guard exists to keep out, and the record of the defect
 * would become an instance of it. `events.session_id` is nullable, so absent
 * is expressible and is the honest value.
 */
test('the refusal is recorded as a denial naming the rule, with the session left null', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    await assert.rejects(async () => await broker.claim(claimInput({ sessionId: '' })));

    const events = readCommitted<{
      kind: string;
      outcome: string;
      guard: string | null;
      session_id: string | null;
      detail: string | null;
    }>('SELECT kind, outcome, guard, session_id, detail FROM events');

    const denial = events.find((event) => event.guard === 'claim.session_bounded');
    assert.ok(denial, 'the guard firing is on the ledger');
    assert.equal(denial.outcome, 'deny');
    assert.equal(denial.kind, 'claim_requested');

    // Null, not ''. This is the assertion that would fail if somebody
    // "helpfully" passed the caller's session id through to this row.
    assert.equal(
      denial.session_id,
      null,
      'the empty identity is recorded as absent rather than written as an empty string',
    );

    const detail = JSON.parse(denial.detail ?? '{}') as Record<string, unknown>;
    assert.equal(detail['supplied'], 0);
    assert.equal(detail['minimum'], SESSION_ID_MINIMUM);
    // Asserted over the keys, so a future field carrying the identity itself
    // would fail here rather than passing a substring search.
    assert.deepEqual(
      Object.keys(detail).sort(),
      ['minimum', 'supplied'],
      'the detail carries measurements rather than the identity itself',
    );
  });
});

/**
 * The nudge is why an anonymous lease is not merely untidy.
 *
 * §2.3a's own-obstacle nudge selects live claims by `session_id = @sessionId`.
 * Two anonymous callers share the identity `''`, so each would match the
 * other's leases and be advised to release work that is not theirs. This is
 * the consequence the guard removes, asserted as a property of the store the
 * guard leaves behind: **no live claim can be anonymous**, so no two callers
 * can be confused for each other by that query.
 */
test('no anonymous lease can exist for the nudge to confuse one caller with another', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    // Two distinct callers, both legitimate, plus two that omit the identity.
    await broker.claim(claimInput({ sessionId: 'session-one' }));
    await broker.claim(claimInput({ sessionId: 'session-two' }));
    await assert.rejects(async () => await broker.claim(claimInput({ sessionId: '' })));
    await assert.rejects(async () => await broker.claim(claimInput({ sessionId: '' })));

    const anonymous = readCommitted<{ count: number }>(
      `SELECT count(*) AS count FROM claims
        WHERE session_id = '' AND state IN ('queued', 'active')`,
    );
    assert.equal(anonymous[0]?.count, 0, 'no live claim is anonymous');

    // And the nudge's own query, run for the identity the defect produced,
    // finds nothing to misattribute. Before the guard this returned both of
    // the anonymous leases, to either of the callers that made one.
    const wouldNudgeSee = readCommitted<{ count: number }>(
      `SELECT count(*) AS count FROM claims
        WHERE session_id = '' AND state IN ('queued', 'active')`,
    );
    assert.equal(wouldNudgeSee[0]?.count, 0);

    // The legitimate callers are untouched and still distinguishable.
    const distinct = readCommitted<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM claims WHERE state = 'active' ORDER BY session_id`,
    );
    assert.deepEqual(
      distinct.map((row) => row.session_id),
      ['session-one', 'session-two'],
    );
  });
});
