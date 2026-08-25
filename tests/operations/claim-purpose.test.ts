import assert from 'node:assert/strict';
import test from 'node:test';

import { PURPOSE_MAXIMUM, PURPOSE_MINIMUM } from '../../src/service/operations/claim.ts';
import { CallRefusal } from '../../src/service/refusals.ts';
import { claimInput, withBroker } from '../helpers/broker.ts';

/**
 * `claim.purpose_bounded` (§7.1) — the purpose is refused by the service,
 * before a statement reaches the store.
 *
 * ── What was wrong, and what these tests are therefore for ──────────────
 *
 * The bound §1.3 states — three to two hundred characters, mandatory — was
 * enforced only by `claims.purpose`'s own
 * `CHECK (length(purpose) BETWEEN 3 AND 200)`. A `CHECK` is not a refusal: it
 * fires *after* the insert is handed to the driver, so a caller who left the
 * argument out got an unhandled `SqliteError` and a dead process on the
 * command line, and `unexpected_failure` carrying the constraint text on the
 * tool surface. Both named a database constraint rather than the argument
 * that was wrong.
 *
 * So the property under test is not merely "a bad purpose is refused" — the
 * column would have produced *a* failure for most of these inputs either way.
 * It is that **the service refuses, and nothing reaches the store**. Every
 * test below asserts the physical side-effect as well as the response, per
 * `CLAUDE.md`: a refusal that returned after the row was written is a refusal
 * that did not happen.
 *
 * ── The fixture trap this file is written to avoid ──────────────────────
 *
 * A test whose input fails **both** the guard and the column's own check
 * proves nothing about which of the two refused, and therefore nothing about
 * ordering: it passes just as happily when the guard is absent and the crash
 * is present. That is the coincident-fixture defect, and the last test in
 * this file is the one that rules it out: it uses an input the guard rejects
 * that **the column would have accepted**, so the store cannot be what said
 * no. See its own comment for why that input is the discriminating one.
 */

/** The two ends of the accepted range, which must keep working. */
test('the bounds themselves are accepted — the guard refuses outside, not at, the edges', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const shortest = await broker.claim(claimInput({ purpose: 'x'.repeat(PURPOSE_MINIMUM) }));
    assert.equal(shortest.outcome, 'granted');

    const longest = await broker.claim(claimInput({ purpose: 'y'.repeat(PURPOSE_MAXIMUM) }));
    assert.equal(longest.outcome, 'granted');

    // Both committed. An off-by-one in the guard that refused a legal purpose
    // would show here as a missing row rather than only as a thrown refusal,
    // because a guard that throws leaves nothing behind to count.
    const claims = readCommitted<{ count: number }>('SELECT count(*) AS count FROM claims');
    assert.equal(claims[0]?.count, 2, 'both boundary purposes are legal and were written');
  });
});

test('a missing purpose is refused by the service, and no lease is written', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    // What a surface actually delivers for an absent argument: `bridge.ts`'s
    // `asString` turns `undefined` into the empty string, which is why the
    // TypeScript signature `purpose: string` never caught this.
    await assert.rejects(
      async () => await broker.claim(claimInput({ purpose: '' })),
      (error: unknown) => {
        assert.ok(error instanceof CallRefusal);
        assert.equal(error.code, 'purpose_out_of_bounds');
        assert.equal(error.rule, 'claim.purpose_bounded');
        // The argument is named and the mistake is described. The constraint
        // is not: a caller told `length(purpose) BETWEEN 3 AND 200` has been
        // told the name of a column check, which is the defect.
        assert.match(error.message, /purpose/i);
        assert.match(error.message, /missing/i);
        assert.doesNotMatch(error.message, /CHECK|constraint|Sqlite/i);
        return true;
      },
    );

    // Nothing was written. This is the half that distinguishes a guard from a
    // rescued crash: an implementation that caught the `SqliteError` and
    // rethrew it as a `CallRefusal` would satisfy every assertion above and
    // fail this one, because the insert would have been attempted.
    const claims = readCommitted<{ count: number }>('SELECT count(*) AS count FROM claims');
    assert.equal(claims[0]?.count, 0, 'a refused claim leaves no lease behind');
    const tabs = readCommitted<{ count: number }>('SELECT count(*) AS count FROM tabs');
    assert.equal(tabs[0]?.count, 0, 'and no tab');
  });
});

test('a purpose over the maximum is refused, naming its length', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    await assert.rejects(
      async () => await broker.claim(claimInput({ purpose: 'z'.repeat(PURPOSE_MAXIMUM + 1) })),
      (error: unknown) => {
        assert.ok(error instanceof CallRefusal);
        assert.equal(error.code, 'purpose_out_of_bounds');
        assert.equal(error.detail['length'], PURPOSE_MAXIMUM + 1);
        assert.equal(error.detail['maximum'], PURPOSE_MAXIMUM);
        return true;
      },
    );

    const claims = readCommitted<{ count: number }>('SELECT count(*) AS count FROM claims');
    assert.equal(claims[0]?.count, 0);
  });
});

/**
 * The refusal is on the ledger, which is what makes it a decision rather than
 * an exception (§1.6).
 *
 * It matters here specifically because the refusal **throws**, and a throw
 * rolls the arbitration transaction back — an ordinary append would go with
 * it, leaving a ledger of grants in which this guard could never be seen to
 * fire. The guard therefore records through `recordRefusal`, and this test is
 * what holds it to that.
 */
test('the refusal is recorded as a denial naming the rule, and carries no purpose text', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    await assert.rejects(async () => await broker.claim(claimInput({ purpose: 'ab' })));

    const events = readCommitted<{
      kind: string;
      outcome: string;
      guard: string | null;
      detail: string | null;
    }>('SELECT kind, outcome, guard, detail FROM events');

    const denial = events.find((event) => event.guard === 'claim.purpose_bounded');
    assert.ok(denial, 'the guard firing is on the ledger');
    assert.equal(denial.outcome, 'deny');
    assert.equal(denial.kind, 'claim_requested');

    // The length and the bounds, never the text. A refusal's detail is read
    // by whoever reads the ledger, and this is the same discipline the
    // storage-seed refusal keeps.
    const detail = JSON.parse(denial.detail ?? '{}') as Record<string, unknown>;
    assert.equal(detail['length'], 2);
    assert.equal(detail['minimum'], PURPOSE_MINIMUM);
    assert.equal(detail['maximum'], PURPOSE_MAXIMUM);
    // Asserted over the *keys*, not by searching the serialised detail for
    // the purpose text. Searching for `'ab'` would be satisfied by the word
    // "about" appearing anywhere in a future detail field, and — the way this
    // was first written — was trivially satisfiable besides. The set of keys
    // is the actual promise: measurements, and nothing else.
    assert.deepEqual(
      Object.keys(detail).sort(),
      ['length', 'maximum', 'minimum'],
      'the detail carries measurements rather than the purpose itself',
    );
  });
});

/**
 * **The discriminating test: an input only the guard can refuse.**
 *
 * Everything above uses a purpose the column would also have rejected, so
 * none of it can tell "the service refused" from "the store refused and
 * something wrapped it". This one closes that gap.
 *
 * The input is a **non-string** — the value an argument of the wrong JSON type
 * arrives as on the tool surface. Fed to the column it would **not** have
 * violated the CHECK: SQLite's `length()` over an integer measures its digits,
 * so `length(1234) = 4`, which sits inside `BETWEEN 3 AND 200` and would have
 * been written happily as a lease whose purpose is `1234`. The store would
 * have said yes.
 *
 * So if this call is refused, the guard is the only thing that can have
 * refused it — and the assertion that the claims table is empty proves the
 * refusal happened *instead of* the insert rather than after it. Delete the
 * `typeof input.purpose !== 'string'` clause from the guard and this test
 * fails while every other test in the file still passes.
 */
test('a non-string purpose is refused by the guard — an input the column would have accepted', async () => {
  await withBroker(async ({ broker, readCommitted, store }) => {
    // First, the premise, measured rather than asserted: the column really
    // would have taken this value. If SQLite ever stopped coercing here, this
    // test would silently become another coincident fixture, so the claim it
    // rests on is checked in the open.
    const wouldColumnAccept = store.db
      .prepare<{ value: unknown }, { ok: number }>(
        'SELECT (length(@value) BETWEEN 3 AND 200) AS ok',
      )
      .get({ value: 1234 });
    assert.equal(
      wouldColumnAccept?.ok,
      1,
      'premise: the CHECK would have accepted this value, so only the guard can refuse it',
    );

    await assert.rejects(
      // Deliberately past the type: this is what a caller sending
      // `{"purpose": 1234}` produces, and the type system is not present at
      // a process boundary.
      async () => await broker.claim(claimInput({ purpose: 1234 as unknown as string })),
      (error: unknown) => {
        assert.ok(error instanceof CallRefusal, 'refused, not crashed');
        assert.equal(error.code, 'purpose_out_of_bounds');
        assert.equal(error.rule, 'claim.purpose_bounded');
        return true;
      },
    );

    // And nothing reached the store. Had the guard not caught the type, this
    // would be a granted lease with the purpose `1234` — not an error at all.
    const claims = readCommitted<{ count: number }>('SELECT count(*) AS count FROM claims');
    assert.equal(
      claims[0]?.count,
      0,
      'no statement reached the store: the guard refused before the insert',
    );
  });
});

/**
 * The guard's bounds and the column's bounds are the same two numbers, read
 * from the live schema.
 *
 * This is the test that keeps the duplication in `claim.ts` honest. The guard
 * exists to make sure no caller reaches the CHECK, which it can only do while
 * it refuses exactly what the CHECK refuses. If somebody widens the column and
 * not the constant, the crash comes back for the newly-legal range; if
 * somebody narrows it, the guard starts refusing purposes the store would
 * take. Either way the two numbers move apart, and this fails.
 */
test('the guard enforces the same bounds the column declares', async () => {
  await withBroker(({ store }) => {
    const schema = store.db
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claims'",
      )
      .get();
    assert.ok(schema, 'the claims table exists');

    const bound = /length\(purpose\)\s+BETWEEN\s+(\d+)\s+AND\s+(\d+)/i.exec(schema.sql);
    assert.ok(bound, 'the purpose CHECK is still spelled as a BETWEEN over length()');
    assert.equal(Number(bound[1]), PURPOSE_MINIMUM, 'the guard minimum matches the column minimum');
    assert.equal(Number(bound[2]), PURPOSE_MAXIMUM, 'the guard maximum matches the column maximum');
  });
});
