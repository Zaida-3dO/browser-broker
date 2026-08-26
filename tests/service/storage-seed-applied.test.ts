import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import { MAX_SEED_ENTRIES, MAX_SEED_VALUE_BYTES } from '../../src/service/storage-seed.ts';
import { claimInput, withBroker, type BrokerFixture } from '../helpers/broker.ts';

/**
 * `storage_seed` reaches the page it was seeded for (§3.2, row #65).
 *
 * ── The defect these measure ────────────────────────────────────────────
 *
 * `seedStorage` was implemented on both drivers and **called by nothing**.
 * The claim path appended `seed: "requested"` and the values went no further,
 * so a page reading its own seeded key found nothing while the ledger said
 * something had happened.
 *
 * ── Why the fake has real storage, and why that is the whole test ───────
 *
 * **A seed test in which the page would have read nothing anyway proves
 * nothing.** If the fake's `seedStorage` only logged, then "the page reads
 * `null`" and "the page reads `null` because nobody seeded it" are the same
 * observation, and every test below would pass against the unwired service —
 * the coinciding fixture this project has been caught by repeatedly.
 *
 * So the fake keeps per-tab, per-origin, per-area storage that `seedStorage`
 * writes and one fixed-form expression reads, and the assertions below are
 * **reads of a value out of storage**, not assertions about the call log.
 * The second test is the control that makes the first one mean something: it
 * shows the same read answering `null` when nothing was seeded.
 */

/** The discovery record the fake is attached with. Nothing here reaches a network. */
const RECORD = { endpoint: 'http://127.0.0.1:9000', browserUuid: 'fake-regular-uuid' };

const ORIGIN = 'https://example.com';

/** How a page asks the fake what it holds — the form its one expression matches. */
function readsStorage(area: 'local' | 'session', origin: string, key: string): string {
  return `__seeded(${area}, ${origin}, ${key})`;
}

/** Every `storage_seeded` row that committed, with the detail parsed. */
function seedRows(fixture: BrokerFixture): { seed: string; entries: unknown[] }[] {
  return fixture
    .readCommitted<{
      detail: string;
    }>("SELECT detail FROM events WHERE kind = 'storage_seeded' ORDER BY id")
    .map((row) => JSON.parse(row.detail) as { seed: string; entries: unknown[] });
}

test('a seeded value is in the page storage the first time the page is used', async () => {
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    const claim = await fixture.broker.claim(
      claimInput({
        storageSeed: [{ origin: ORIGIN, area: 'local', key: 'auth', value: 'a-token-value' }],
      }),
    );
    assert.equal(claim.outcome, 'granted');
    if (claim.outcome !== 'granted') throw new Error('unreachable');

    // The tab's first use. The page is opened here, seeded, and only then
    // driven — which is the ordering the feature is entirely about.
    const result = await fixture.broker.evaluate({
      key: claim.key,
      tabId: claim.tabId,
      expression: readsStorage('local', ORIGIN, 'auth'),
      session: () => driver.attach('regular', RECORD),
      artifacts: fixture.artifacts,
    });

    assert.equal(result.pageDriven, true);
    assert.ok(result.result);
    assert.equal(result.result.spilled, false);
    if (result.result.spilled) throw new Error('unreachable');
    // **The page read back the value that was seeded for it.** This is the
    // assertion the row owes, and it is a read out of storage rather than an
    // assertion that a method was called.
    assert.equal(
      JSON.parse(result.result.value),
      'a-token-value',
      'the page could not see the value seeded for it',
    );
  });
});

test('the same read answers null when nothing was seeded — the control', async () => {
  // Without this, the test above would be satisfied by a fake that answered
  // the seeded value to everyone, and by a service that seeded the wrong tab.
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    const claim = await fixture.broker.claim(claimInput());
    assert.equal(claim.outcome, 'granted');
    if (claim.outcome !== 'granted') throw new Error('unreachable');

    const result = await fixture.broker.evaluate({
      key: claim.key,
      tabId: claim.tabId,
      expression: readsStorage('local', ORIGIN, 'auth'),
      session: () => driver.attach('regular', RECORD),
      artifacts: fixture.artifacts,
    });

    assert.ok(result.result);
    if (result.result.spilled) throw new Error('unreachable');
    assert.equal(JSON.parse(result.result.value), null);
  });
});

test('the seed lands before the first navigation, not after it', async () => {
  // The ordering **is** the feature: a value written after the load it was
  // meant to precede is a value the page could not use. Asserted against the
  // call log's order, which is where a sequence is observable.
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    const claim = await fixture.broker.claim(
      claimInput({
        storageSeed: [{ origin: ORIGIN, area: 'local', key: 'auth', value: 'a-token-value' }],
      }),
    );
    if (claim.outcome !== 'granted') throw new Error('unreachable');

    await fixture.broker.navigate({
      key: claim.key,
      tabId: claim.tabId,
      url: `${ORIGIN}/dashboard`,
      session: () => driver.attach('regular', RECORD),
    });

    const order = driver.calls.map((call) => call.name);
    const seeded = order.indexOf('seedStorage');
    const navigated = order.indexOf('navigate');
    assert.ok(seeded >= 0, 'the seed never reached the driver');
    assert.ok(navigated >= 0, 'the navigation never happened');
    assert.ok(
      seeded < navigated,
      `the seed must precede the first navigation, got ${order.join(' -> ')}`,
    );
  });
});

test('the ledger records what was applied, not only what was requested', async () => {
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    const claim = await fixture.broker.claim(
      claimInput({
        storageSeed: [{ origin: ORIGIN, area: 'session', key: 'auth', value: 'a-token-value' }],
      }),
    );
    if (claim.outcome !== 'granted') throw new Error('unreachable');

    // Before the tab is used there is a request and nothing else — the honest
    // state, because nothing has been written yet.
    assert.deepEqual(
      seedRows(fixture).map((row) => row.seed),
      ['requested'],
    );

    await fixture.broker.navigate({
      key: claim.key,
      tabId: claim.tabId,
      url: `${ORIGIN}/dashboard`,
      session: () => driver.attach('regular', RECORD),
    });

    assert.deepEqual(
      seedRows(fixture).map((row) => row.seed),
      ['requested', 'applied'],
      'the ledger does not say the seed was applied, so it still overstates or understates',
    );
  });
});

test('a seed the browser refused leaves no applied row', async () => {
  // The half that keeps the ledger from overstating: the `applied` row is
  // written **after** the driver returns, so a browser that refuses produces
  // a request with no act beside it.
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    driver.failNext('seedStorage', new Error('the browser refused the write'));

    const claim = await fixture.broker.claim(
      claimInput({
        storageSeed: [{ origin: ORIGIN, area: 'local', key: 'auth', value: 'a-token-value' }],
      }),
    );
    if (claim.outcome !== 'granted') throw new Error('unreachable');

    const result = await fixture.broker.navigate({
      key: claim.key,
      tabId: claim.tabId,
      url: `${ORIGIN}/dashboard`,
      session: () => driver.attach('regular', RECORD),
    });

    // The decision stands and the failure is swallowed (§2.4b) — but the
    // caller is told the page was not driven, and the ledger does not claim
    // the credential landed.
    assert.equal(result.pageDriven, false);
    assert.deepEqual(
      seedRows(fixture).map((row) => row.seed),
      ['requested'],
      'the ledger recorded a seed as applied that the browser refused',
    );
  });
});

test('the ledger row carries origins and keys and never the value', async () => {
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    const secret = 'a-value-that-must-not-be-written-down';
    const claim = await fixture.broker.claim(
      claimInput({
        storageSeed: [{ origin: ORIGIN, area: 'local', key: 'auth', value: secret }],
      }),
    );
    if (claim.outcome !== 'granted') throw new Error('unreachable');

    await fixture.broker.navigate({
      key: claim.key,
      tabId: claim.tabId,
      url: `${ORIGIN}/dashboard`,
      session: () => driver.attach('regular', RECORD),
    });

    // Read over the whole events table rather than the seed rows alone: the
    // question is whether the value reached the ledger **anywhere**, and a
    // check scoped to the row it was expected in would miss it landing in
    // another.
    const everything = fixture
      .readCommitted<{ detail: string | null }>('SELECT detail FROM events')
      .map((row) => row.detail ?? '')
      .join('\n');
    assert.ok(!everything.includes(secret), 'a seeded value was written into the ledger');

    // And the row is not empty — the redaction has something to have removed.
    // Without this, deleting the row entirely would satisfy the assertion
    // above.
    const applied = seedRows(fixture).find((row) => row.seed === 'applied');
    assert.ok(applied, 'no applied row at all, so the assertion above is vacuous');
    assert.deepEqual(applied.entries, [{ origin: ORIGIN, area: 'local', key: 'auth' }]);
  });
});

test('a seed applies once — a second call does not re-seed', async () => {
  // §3.2: the seed is an argument on the claim and applies to the tab that
  // claim grants. A second application would write a caller's credential into
  // a page it never asked about.
  //
  // ── What enforces this, measured rather than assumed ──────────────────
  //
  // **The store's tab state machine, not the drain in `pending-seeds.ts`.**
  // `pageFor` reaches the seed only on the branch that opens a page, and a
  // tab leaves `opening` the moment it is opened — `recordTabOpened` refuses
  // a tab that is not awaiting an open, so a second attempt throws before the
  // seed is reached. Removing the drain leaves the count at one, and so does
  // removing `pageFor`'s early return; both were planted and neither changed
  // this assertion.
  //
  // The drain is kept for the other reason its own file gives — a credential
  // stops being held the moment it has been used — and this test is honest
  // that it is not what this particular property rests on.
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    const claim = await fixture.broker.claim(
      claimInput({
        storageSeed: [{ origin: ORIGIN, area: 'local', key: 'auth', value: 'a-token-value' }],
      }),
    );
    if (claim.outcome !== 'granted') throw new Error('unreachable');

    for (const url of [`${ORIGIN}/one`, `${ORIGIN}/two`]) {
      await fixture.broker.navigate({
        key: claim.key,
        tabId: claim.tabId,
        url,
        session: () => driver.attach('regular', RECORD),
      });
    }

    assert.equal(
      driver.callsOf('seedStorage').length,
      1,
      'the seed was applied more than once, so a later page was written to as well',
    );
    assert.equal(seedRows(fixture).filter((row) => row.seed === 'applied').length, 1);
  });
});

/* ── The five refusals, verified to still fire now that the write is wired ── */

/**
 * A claim that must be refused, with the physical side-effect asserted.
 *
 * **Both halves, always.** A refusal returned after the driver was asked to
 * write is not a refusal — the credential is already in the browser — so
 * every case below checks the call log as well as the throw.
 */
async function refusedSeed(
  fixture: BrokerFixture,
  driver: FakeBrowserDriver,
  seed: unknown,
  expected: RegExp,
): Promise<void> {
  await assert.rejects(
    fixture.broker.claim(claimInput({ storageSeed: seed })),
    (error: unknown) => error instanceof Error && expected.test(error.message),
    `expected a refusal matching ${String(expected)}`,
  );
  assert.deepEqual(
    driver.callsOf('seedStorage'),
    [],
    'a refused seed still reached the driver, so the value is in the browser',
  );
  assert.equal(
    fixture.readCommitted<{ n: number }>('SELECT count(*) AS n FROM claims')[0]?.n,
    0,
    'a refused seed left a claim behind, so the caller holds capacity it was refused',
  );
}

test('refusal 1: more than sixteen entries', async () => {
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    await refusedSeed(
      fixture,
      driver,
      Array.from({ length: MAX_SEED_ENTRIES + 1 }, (_, index) => ({
        origin: ORIGIN,
        area: 'local',
        key: `k${String(index)}`,
        value: 'v',
      })),
      /at most 16 entries/i,
    );
  });
});

test('refusal 2: a value over four kilobytes, measured in bytes not characters', async () => {
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    // **Astral-plane characters**, so the string is well within the bound
    // when counted as characters and past it when counted as bytes. A test
    // using Latin letters would pass against an implementation measuring the
    // wrong unit.
    const value = '\u{1F600}'.repeat(MAX_SEED_VALUE_BYTES / 4 + 1);
    assert.ok(value.length < MAX_SEED_VALUE_BYTES, 'the fixture is not testing the unit');
    assert.ok(Buffer.byteLength(value, 'utf8') > MAX_SEED_VALUE_BYTES);
    await refusedSeed(
      fixture,
      driver,
      [{ origin: ORIGIN, area: 'local', key: 'auth', value }],
      /bytes/i,
    );
  });
});

test('refusal 3: a value that is not a string', async () => {
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    await refusedSeed(
      fixture,
      driver,
      [{ origin: ORIGIN, area: 'local', key: 'auth', value: { token: 'nested' } }],
      /string/i,
    );
  });
});

test('refusal 4: an origin that is not ordinary web traffic', async () => {
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    await refusedSeed(
      fixture,
      driver,
      [{ origin: 'file:///etc/passwd', area: 'local', key: 'auth', value: 'v' }],
      /http/i,
    );
  });
});

test('refusal 5: cookies, refused by name', async () => {
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    await refusedSeed(
      fixture,
      driver,
      [{ origin: ORIGIN, area: 'cookie', key: 'auth', value: 'v' }],
      /cookie/i,
    );
  });
});

test('refusal 5b: a seed cannot name another lease, because there is no argument for one', async () => {
  // §3.2's fifth refusal is structural rather than a check: the seed is an
  // argument on the claim, so it applies to the tab that claim grants and
  // there is no parameter naming another. Asserted as the property it is —
  // **one lease's seed does not reach another lease's page** — rather than as
  // a refusal that could not be written.
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    const seeded = await fixture.broker.claim(
      claimInput({
        sessionId: 'session-a',
        storageSeed: [{ origin: ORIGIN, area: 'local', key: 'auth', value: 'a-token-value' }],
      }),
    );
    const other = await fixture.broker.claim(claimInput({ sessionId: 'session-b' }));
    if (seeded.outcome !== 'granted' || other.outcome !== 'granted') {
      throw new Error('both claims should have been granted');
    }

    const result = await fixture.broker.evaluate({
      key: other.key,
      tabId: other.tabId,
      expression: readsStorage('local', ORIGIN, 'auth'),
      session: () => driver.attach('regular', RECORD),
      artifacts: fixture.artifacts,
    });

    assert.ok(result.result);
    if (result.result.spilled) throw new Error('unreachable');
    assert.equal(
      JSON.parse(result.result.value),
      null,
      "one lease's seed reached another lease's page",
    );
  });
});

test('the value reaches the driver as data on a fixed signature, never as source text', async () => {
  // The safety property: `seedStorage` takes origin/area/key/**string**, so
  // there is no position in which a caller's bytes are read as a program.
  // Asserted by checking the driver was handed the entry *as an entry* — a
  // service that built an init script and evaluated it would show an
  // `evaluate` call carrying the value instead.
  await withBroker(async (fixture) => {
    const driver = new FakeBrowserDriver();
    const value = '"); doSomethingElse(); ("';
    const claim = await fixture.broker.claim(
      claimInput({ storageSeed: [{ origin: ORIGIN, area: 'local', key: 'auth', value }] }),
    );
    if (claim.outcome !== 'granted') throw new Error('unreachable');

    await fixture.broker.navigate({
      key: claim.key,
      tabId: claim.tabId,
      url: `${ORIGIN}/dashboard`,
      session: () => driver.attach('regular', RECORD),
    });

    const [seedCall] = driver.callsOf('seedStorage');
    assert.ok(seedCall);
    assert.deepEqual(seedCall.detail, {
      entries: [{ origin: ORIGIN, area: 'local', key: 'auth', value }],
    });

    // And no evaluation carried it. A service that seeded by interpolating
    // the value into an expression would fail here while passing every
    // assertion about the stored result.
    for (const call of driver.callsOf('evaluate')) {
      assert.ok(
        !JSON.stringify(call.detail ?? {}).includes('doSomethingElse'),
        'a seeded value was carried into an expression, which is the interpreting position',
      );
    }
  });
});
