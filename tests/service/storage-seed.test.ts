import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SEED_ENTRIES,
  MAX_SEED_VALUE_BYTES,
  StorageSeedRefusal,
  seedRecord,
  validateStorageSeed,
} from '../../src/service/storage-seed.ts';
import { claimInput, withBroker } from '../helpers/broker.ts';

/**
 * `storage_seed` on `browser_claim` (§3.2, row #65) — the five refusals, the
 * structural property, and the redaction.
 *
 * **Every refusal test asserts the physical side-effect as well as the
 * response**, per `CLAUDE.md`: the seed is an argument on the claim, so a
 * refused seed must leave no claim row, no tab row and no key. A refusal
 * returned after the lease was written would be a refusal that did not
 * happen, and the caller would be holding capacity it was told it did not get.
 *
 * ── What is asserted through a second connection, and why ───────────────
 *
 * Anything about what **committed** is read through `readCommitted`, which is
 * a separate read-only handle. A read through the store's own handle sees
 * uncommitted writes, so an assertion about durable state made through it can
 * pass while the violation is present — the house rule a mutation sweep
 * caught a test breaking.
 */

/**
 * The refusal a call produced, or a failure saying it produced none.
 *
 * `assert.throws` verifies that something threw but hands back nothing, so a
 * test that needs to read the refusal's own fields has to catch it. Written
 * as a helper rather than a try/catch per test because the failure case is
 * the one worth getting right: **a call that does not throw must fail the
 * test**, not return undefined and make every later assertion throw a
 * confusing type error instead of the clear one.
 */
function refusalFrom(call: () => unknown): StorageSeedRefusal {
  try {
    call();
  } catch (error) {
    assert.ok(
      error instanceof StorageSeedRefusal,
      `expected a StorageSeedRefusal, got ${String(error)}`,
    );
    return error;
  }
  assert.fail('the call was expected to be refused and was not');
}

/** One well-formed entry, so a test states only the field it is varying. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    origin: 'https://example.com',
    area: 'local',
    key: 'token',
    value: 'a-token-value',
    ...overrides,
  };
}

/* ─────────────────── refusal one: the count and size bounds ─────────────────── */

test('MORE THAN SIXTEEN ENTRIES is refused, and the bound is named in the sentence', () => {
  const seed = Array.from({ length: MAX_SEED_ENTRIES + 1 }, (_unused, index) =>
    entry({ key: `token-${String(index)}` }),
  );

  const refusal = refusalFrom(() => validateStorageSeed(seed));

  assert.equal(refusal.detail.maximum, MAX_SEED_ENTRIES);
  assert.equal(refusal.detail.entries, MAX_SEED_ENTRIES + 1);
});

test('EXACTLY sixteen entries is allowed — the bound is a maximum, not an off-by-one', () => {
  // The boundary in the permitted direction. Without it, a mutation changing
  // `>` to `>=` would refuse a legal seed and every other test here would
  // still pass, because every other test is over the limit or well under it.
  const seed = Array.from({ length: MAX_SEED_ENTRIES }, (_unused, index) =>
    entry({ key: `token-${String(index)}` }),
  );
  assert.equal(validateStorageSeed(seed).length, MAX_SEED_ENTRIES);
});

test('A VALUE OVER FOUR KILOBYTES is refused, and one byte under it is not', () => {
  const overLimit = 'x'.repeat(MAX_SEED_VALUE_BYTES + 1);
  const refusal = refusalFrom(() => validateStorageSeed([entry({ value: overLimit })]));
  assert.equal(refusal.detail.maximum, MAX_SEED_VALUE_BYTES);
  assert.equal(refusal.detail.bytes, MAX_SEED_VALUE_BYTES + 1);

  // The permitted boundary, for the same reason as the entry count above.
  const atLimit = 'x'.repeat(MAX_SEED_VALUE_BYTES);
  assert.equal(validateStorageSeed([entry({ value: atLimit })])[0]?.value, atLimit);
});

test('the size bound counts BYTES, not characters — a multi-byte value cannot exceed it', () => {
  // Each of these characters is four bytes in UTF-8, so a string of one
  // quarter the limit in *characters* is exactly at the limit in bytes, and
  // one character more is over it. A bound written against `.length` accepts
  // this and is wrong by a factor of four — which is the whole reason the
  // implementation measures bytes, so it is the assertion that protects it.
  const fourByteCharacter = '𝄞';
  assert.equal(Buffer.byteLength(fourByteCharacter, 'utf8'), 4);

  const overLimit = fourByteCharacter.repeat(MAX_SEED_VALUE_BYTES / 4 + 1);
  assert.ok(overLimit.length < MAX_SEED_VALUE_BYTES, 'shorter than the limit in characters');

  const refusal = refusalFrom(() => validateStorageSeed([entry({ value: overLimit })]));
  assert.equal(refusal.detail.bytes, MAX_SEED_VALUE_BYTES + 4);
});

/* ─────────────────── refusal two: a non-string value ─────────────────── */

test('A NON-STRING VALUE is refused — an object, a number and a boolean alike', () => {
  // Named individually rather than iterated, and the object case is the one
  // that matters: a structure is the only thing that could carry something
  // requiring interpretation, and interpretation is what this argument exists
  // to avoid.
  const structure = refusalFrom(() =>
    validateStorageSeed([entry({ value: { nested: 'structure' } })]),
  );
  assert.equal(structure.detail.received, 'object');

  const numeric = refusalFrom(() => validateStorageSeed([entry({ value: 42 })]));
  assert.equal(numeric.detail.received, 'number');

  const boolean = refusalFrom(() => validateStorageSeed([entry({ value: true })]));
  assert.equal(boolean.detail.received, 'boolean');
});

test('a value that LOOKS like an expression is stored verbatim, because it is only ever a string', () => {
  // The positive half of the structural claim, and it is the assertion that
  // says what the property actually is: the service does not filter values
  // for anything program-shaped — a filter would be a guess and would
  // eventually be wrong. It accepts this text and keeps it as text, because
  // the only place it goes is an interface taking a key and a string.
  const expressionShaped = '(() => { return 1 })()';
  const validated = validateStorageSeed([entry({ value: expressionShaped })]);
  assert.equal(validated[0]?.value, expressionShaped);
});

/* ─────────────────── refusal three: a non-web origin ─────────────────── */

test('A LOCAL-FILE ORIGIN is refused, and the sentence says what it would have granted', () => {
  const refusal = refusalFrom(() => validateStorageSeed([entry({ origin: 'file:///etc/passwd' })]));

  assert.equal(refusal.detail.scheme, 'file:');
  assert.match(refusal.message, /filesystem/);
});

test('http and https origins are both allowed, and the entry keeps the ORIGIN, not the path', () => {
  const validated = validateStorageSeed([
    entry({ origin: 'https://example.com/a/path?query=1#fragment' }),
    entry({ origin: 'http://example.org' }),
  ]);
  // A path is not part of what storage is keyed by, so keeping one would
  // record a distinction the browser does not make.
  assert.equal(validated[0]?.origin, 'https://example.com');
  assert.equal(validated[1]?.origin, 'http://example.org');
});

test('a blank page is refused as an origin although navigation permits it as an address', () => {
  // Not a narrower request but an incoherent one: a blank page has no origin
  // to write storage into.
  assert.throws(() => validateStorageSeed([entry({ origin: 'about:blank' })]), StorageSeedRefusal);
});

/* ─────────────────── refusal four: cookies, by name ─────────────────── */

test('COOKIES ARE REFUSED BY NAME, and the refusal says why rather than only that', () => {
  const refusal = refusalFrom(() => validateStorageSeed([entry({ area: 'cookie' })]));

  assert.equal(refusal.detail.area, 'cookie');
  // The reason, not just the refusal: a caller told only "no" writes an
  // ingenious workaround, and a caller told why writes something else.
  assert.match(refusal.message, /credential injection/);
  assert.match(refusal.message, /share/);
});

test('the plural spelling is refused too, and still explains itself', () => {
  const refusal = refusalFrom(() => validateStorageSeed([entry({ area: 'cookies' })]));
  assert.match(refusal.message, /credential injection/);
});

test('local and session are the two areas on offer, NAMED — and nothing else is', () => {
  assert.equal(validateStorageSeed([entry({ area: 'local' })])[0]?.area, 'local');
  assert.equal(validateStorageSeed([entry({ area: 'session' })])[0]?.area, 'session');
  // A third area nobody thought of is refused because the check is an
  // allowlist. A denylist would have permitted this.
  assert.throws(() => validateStorageSeed([entry({ area: 'indexeddb' })]), StorageSeedRefusal);
});

/* ────────── refusal five: no entry may reach a lease that is not the caller's ────────── */

test('THERE IS NO ARGUMENT NAMING ANOTHER LEASE — the fifth refusal is structural', () => {
  // §3.2's fifth refusal is "any entry at all on a lease that is not the
  // caller's". It is not a guard and cannot be written as one: the seed is an
  // argument on the claim, so it applies once, to the tab that claim grants.
  //
  // What is assertable is the shape that makes it true — that a validated
  // entry carries **no field naming a lease, a claim, a tab or a session**.
  // The fields are named individually rather than counted, so adding one
  // called `claimId` later fails this test rather than sliding past a length
  // check.
  const validated = validateStorageSeed([entry()]);
  const only = validated[0] as unknown as Record<string, unknown>;

  assert.deepEqual(Object.keys(only).sort(), ['area', 'key', 'origin', 'value']);
  for (const forbidden of ['claimId', 'claim_id', 'leaseKey', 'lease_key', 'tabId', 'sessionId']) {
    assert.equal(only[forbidden], undefined, `an entry must not be able to name ${forbidden}`);
  }
});

/* ─────────────────── the redaction: origins and keys, never values ─────────────────── */

test('the ledger record STRUCTURALLY cannot carry a value', () => {
  const secret = 'the-secret-token-value';
  const records = seedRecord(validateStorageSeed([entry({ value: secret })]));

  assert.deepEqual(Object.keys(records[0] ?? {}).sort(), ['area', 'key', 'origin']);
  assert.equal(JSON.stringify(records).includes(secret), false);
});

/* ─────────────────── the whole path, through the service ─────────────────── */

test('A SEEDED GRANT records origins and keys in the ledger, and NEVER the value', async () => {
  const secret = 'sk-a-credential-nobody-should-find-in-a-log';

  await withBroker(async ({ broker, readCommitted }) => {
    const result = await broker.claim(
      claimInput({
        storageSeed: [{ origin: 'https://example.com', area: 'local', key: 'auth', value: secret }],
      }),
    );
    assert.equal(result.outcome, 'granted');

    // Read on the second connection: what committed.
    const rows = readCommitted<{ kind: string; detail: string }>(
      "SELECT kind, detail FROM events WHERE kind = 'storage_seeded'",
    );
    assert.equal(rows.length, 1, 'a seeded grant leaves exactly one storage_seeded row');

    const detail = rows[0]?.detail ?? '';
    // The question the row exists to answer — which lease started life
    // holding a credential, and where.
    assert.match(detail, /example\.com/);
    assert.match(detail, /auth/);
    // And the thing it must never answer.
    assert.equal(detail.includes(secret), false, 'a seeded VALUE must never reach the ledger');

    // Nothing else in the ledger carries it either — the redaction is about
    // the store, not about one row.
    const everything = readCommitted<{ detail: string | null }>('SELECT detail FROM events');
    for (const row of everything) {
      assert.equal((row.detail ?? '').includes(secret), false);
    }
  });
});

test('THE LEDGER SAYS THE SEED WAS REQUESTED, NOT THAT STORAGE WAS WRITTEN', async () => {
  // `seedStorage` is implemented on both drivers and has no caller: the claim
  // path creates a tab row in `opening` and nothing on this layer holds a
  // browser session to open it with. So the row must not assert that the
  // lease started life holding a credential — that would be the ledger
  // claiming something the system did not do, and §3.2's question is a
  // security question where a false all-clear is the expensive direction.
  //
  // This is the assertion that fails if somebody wires the write and forgets
  // to change the word, or removes the word while the write is still absent.
  await withBroker(async ({ broker, readCommitted }) => {
    await broker.claim(
      claimInput({
        storageSeed: [{ origin: 'https://example.com', area: 'local', key: 'auth', value: 'v' }],
      }),
    );

    const row = readCommitted<{ detail: string }>(
      "SELECT detail FROM events WHERE kind = 'storage_seeded'",
    )[0];
    const detail = JSON.parse(row?.detail ?? '{}') as { seed?: string };
    assert.equal(
      detail.seed,
      'requested',
      'the ledger must record what was accepted, not a write that has no caller',
    );
  });
});

test('AN UNSEEDED GRANT writes no storage_seeded row at all', async () => {
  // Without this, an implementation that recorded an empty seed on every
  // grant would pass the test above and would make the ledger's answer to
  // "which leases started life holding a credential" useless by answering
  // "all of them".
  await withBroker(async ({ broker, readCommitted }) => {
    const result = await broker.claim(claimInput());
    assert.equal(result.outcome, 'granted');
    assert.equal(
      readCommitted("SELECT id FROM events WHERE kind = 'storage_seeded'").length,
      0,
      'a grant that seeded nothing must not claim to have seeded something',
    );
  });
});

test('A REFUSED SEED LEAVES NO LEASE — no claim row, no tab row, and no capacity taken', async () => {
  // The side-effect half, and the reason the validation runs before the first
  // insert. A refusal returned after the row was written would leave the
  // caller holding capacity it was told it did not get, with no key to
  // release it with.
  await withBroker(async ({ broker, readCommitted }) => {
    await assert.rejects(
      broker.claim(claimInput({ storageSeed: [entry({ area: 'cookie' })] })),
      /cookie/i,
    );

    assert.equal(readCommitted('SELECT id FROM claims').length, 0, 'no lease was written');
    assert.equal(readCommitted('SELECT id FROM tabs').length, 0, 'no tab was written');
    assert.equal(
      readCommitted("SELECT id FROM events WHERE kind = 'storage_seeded'").length,
      0,
      'nothing was recorded as seeded',
    );
  });
});

test('A REFUSED SEED IS RECORDED AS A REFUSAL, and the ledger names the rule that refused', async () => {
  // §1.6 requires every decision, allowed and refused alike. A refusal throws
  // and the throw rolls the transaction back, so this row exists only because
  // it is written through the scope's after-rollback path rather than with an
  // ordinary append — an append would be undone and the ledger would contain
  // grants only.
  //
  // **Honest limit, recorded because a mutation proved it.** Neither this
  // test nor the no-lease-left-behind one above pins the *position* of the
  // validation within the handler. Moving it to after the insert was tried as
  // a mutation and both stayed green — correctly, because the arbitration
  // transaction rolls back on any throw and takes the claim row, the tab row
  // and the in-transaction ledger rows with it. **Validating late is
  // therefore not observably different from validating early**, so there is
  // no assertion to write for it and one that appeared to test it would be
  // testing something else. Early is still where it belongs, for the reason
  // §2.2 gives about the unknown-browser refusal — nothing about waiting
  // makes a malformed argument valid — but that is a reasoned position rather
  // than a checked one, and it is written down as such.
  await withBroker(async ({ broker, readCommitted }) => {
    await assert.rejects(
      broker.claim(claimInput({ storageSeed: [entry({ value: 12345 })] })),
      /string/i,
    );

    const rows = readCommitted<{ outcome: string; guard: string | null }>(
      "SELECT outcome, guard FROM events WHERE kind = 'claim_requested'",
    );
    assert.equal(rows.length, 1, 'the refused request is recorded exactly once');
    assert.equal(rows[0]?.outcome, 'deny');
    assert.equal(rows[0]?.guard, 'claim.seed_value_string');
  });
});

test('a refusal detail NEVER carries the value that was refused', async () => {
  // The refusal is the one place a rejected credential could plausibly be
  // echoed back — the caller sent it, so quoting it in the error reads as
  // helpful. It is exactly as sensitive as an accepted one.
  const secret = 'sk-a-rejected-but-still-real-credential';

  await withBroker(async ({ broker, readCommitted }) => {
    await assert.rejects(
      broker.claim(
        claimInput({
          storageSeed: [{ origin: 'file:///etc/passwd', area: 'local', key: 'k', value: secret }],
        }),
      ),
      /filesystem/i,
    );

    const rows = readCommitted<{ detail: string | null }>('SELECT detail FROM events');
    assert.ok(rows.length > 0, 'something was recorded, so the assertion is not vacuous');
    for (const row of rows) {
      assert.equal((row.detail ?? '').includes(secret), false);
    }
  });
});

test('a granted claim carries the validated entries back for the service to write', async () => {
  await withBroker(async ({ broker }) => {
    const result = await broker.claim(
      claimInput({
        storageSeed: [{ origin: 'https://example.com', area: 'session', key: 'k', value: 'v' }],
      }),
    );
    assert.equal(result.outcome, 'granted');
    if (result.outcome !== 'granted') return;

    // The entries reach the caller of the service as validated data, because
    // writing them is browser work and happens after the commit (§2.4b).
    assert.equal(result.storageSeed.length, 1);
    assert.equal(result.storageSeed[0]?.origin, 'https://example.com');
    assert.equal(result.storageSeed[0]?.area, 'session');
    assert.equal(result.storageSeed[0]?.value, 'v');
  });
});

test('an absent seed is the ordinary case and is not an error', () => {
  assert.deepEqual(validateStorageSeed(undefined), []);
  assert.deepEqual(validateStorageSeed(null), []);
});

test('a seed that is not a list is refused rather than coerced', () => {
  assert.throws(() => validateStorageSeed('not-a-list'), StorageSeedRefusal);
  assert.throws(() => validateStorageSeed({ origin: 'https://example.com' }), StorageSeedRefusal);
});
