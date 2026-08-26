import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import { MAX_INLINE_RESULT_BYTES } from '../../src/service/pages.ts';
import { claimInput, withBroker, type BrokerFixture } from '../helpers/broker.ts';

/** The discovery record the fake is attached with. Nothing here reaches a network. */
const RECORD = { endpoint: 'http://127.0.0.1:9000', browserUuid: 'fake-regular-uuid' };

/**
 * `browser_evaluate` hands its value back (§3.10, row #24).
 *
 * ── The defect these measure, stated as a mechanism ─────────────────────
 *
 * The evaluation always happened. `afterCommitWork` awaited the closure that
 * performed it and **ignored the return**, so the value was produced in the
 * page, serialised, measured against the inline cap — and dropped. The caller
 * received `accepted`, `pageDriven: true`, and no value anywhere in the
 * result.
 *
 * That is invisible to any assertion made about the outcome or the ledger,
 * both of which were correct. It is only visible by **asking for a value the
 * page produced and checking it arrived**, which is what every test here
 * does.
 *
 * ── Why the value is one the fake was told to produce ───────────────────
 *
 * The fake does not evaluate expressions — see `browser/fake.ts` — so each
 * test states what the page is to be treated as having returned and then
 * asserts *that specific value* comes back. **A test asserting merely that
 * some value is present would pass against a handler that invented one**, and
 * a test asserting a value the fake returns by default would pass against a
 * handler that hard-coded the default. The values below are chosen so that
 * neither shortcut satisfies them.
 */

/** A granted lease, which is what every test here starts from. */
async function grantedLease(fixture: BrokerFixture): Promise<{
  readonly key: string;
  readonly tabId: string;
  readonly claimId: string;
}> {
  const claim = await fixture.broker.claim(claimInput());
  assert.equal(claim.outcome, 'granted');
  if (claim.outcome !== 'granted') throw new Error('unreachable');
  return { key: claim.key, tabId: claim.tabId, claimId: claim.claimId };
}

test('a small result comes back inline, and it is the value the page produced', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    // A structure with two distinguishable fields, so an assertion on it
    // cannot be satisfied by a handler returning a constant or an empty
    // object. These are the measurements §3.10 says this path exists for.
    const driver = new FakeBrowserDriver({
      evaluate: { value: { fontSize: '16px', lineHeight: '24px' } },
    });

    const result = await fixture.broker.evaluate({
      key: lease.key,
      tabId: lease.tabId,
      expression: 'measurements()',
      session: () => driver.attach('regular', RECORD),
      artifacts: fixture.artifacts,
    });

    assert.equal(result.pageDriven, true, 'the page was not driven, so nothing was evaluated');
    assert.ok(result.result, 'the evaluation returned no value at all — row #24 verbatim');
    assert.equal(result.result.spilled, false, 'a small result should not have spilled');
    // The serialised value itself, compared by parsing rather than by string
    // equality: the assertion is about the value that came out of the page,
    // and key order in JSON text is not part of that.
    assert.equal(result.result.spilled, false);
    assert.deepEqual(JSON.parse(result.result.value), {
      fontSize: '16px',
      lineHeight: '24px',
    });
    assert.equal(result.result.bytes, Buffer.byteLength(result.result.value, 'utf8'));
  });
});

test('a result past the inline cap spills to a file, and the file holds the value', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    // Comfortably past the cap once serialised. A single long string rather
    // than many small values, because `disposeEvaluationResult` measures the
    // serialised bytes and a test built on element count would pass against
    // an implementation that measured the wrong thing.
    const large = 'x'.repeat(MAX_INLINE_RESULT_BYTES + 500);
    const driver = new FakeBrowserDriver({ evaluate: { value: large } });

    const result = await fixture.broker.evaluate({
      key: lease.key,
      tabId: lease.tabId,
      expression: 'wholeDocument()',
      session: () => driver.attach('regular', RECORD),
      artifacts: fixture.artifacts,
    });

    assert.equal(result.pageDriven, true);
    assert.ok(result.result);
    assert.equal(result.result.spilled, true, 'a result past the cap came back inline');
    if (!result.result.spilled) throw new Error('unreachable');

    // **The bytes are the serialised size, not the file size**, and the two
    // are the same here only because the file is the serialisation. Asserting
    // both is what would catch a handler that reported one and wrote the
    // other.
    assert.ok(
      result.result.bytes > MAX_INLINE_RESULT_BYTES,
      'a spilled result reported a size within the inline cap',
    );

    // The path is relative to the artifact root (§1.7a) — never absolute, and
    // never climbing out of it.
    assert.ok(
      !path.isAbsolute(result.result.path),
      `a stored path must be relative to the root, got ${result.result.path}`,
    );

    // **The file, read from disk.** This is the assertion the whole feature
    // rests on: a path that names nothing is the same defect as no value.
    const onDisk = fs.readFileSync(fixture.artifacts.resolve(result.result.path), 'utf8');
    assert.equal(
      JSON.parse(onDisk),
      large,
      'the spilled file does not hold the value the page produced',
    );
    assert.equal(Buffer.byteLength(onDisk, 'utf8'), result.result.bytes);
  });
});

test('the two dispositions are decided by the size, not by the shape', async () => {
  // The pair that distinguishes measuring serialised bytes from measuring
  // anything about the value's structure: one long string is one element and
  // spills; five hundred small numbers are many elements and do not.
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = new FakeBrowserDriver({
      evaluate: { value: Array.from({ length: 500 }, (_, index) => index) },
    });

    const result = await fixture.broker.evaluate({
      key: lease.key,
      tabId: lease.tabId,
      expression: 'indices()',
      session: () => driver.attach('regular', RECORD),
      artifacts: fixture.artifacts,
    });

    assert.ok(result.result);
    assert.equal(
      result.result.spilled,
      false,
      'a long list of small numbers is within the cap and should be inline',
    );
  });
});

test('a spill with nowhere to write says so, rather than silently returning nothing', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = new FakeBrowserDriver({
      evaluate: { value: 'y'.repeat(MAX_INLINE_RESULT_BYTES + 500) },
    });

    // A browser, and no artifact store.
    const result = await fixture.broker.evaluate({
      key: lease.key,
      tabId: lease.tabId,
      expression: 'wholeDocument()',
      session: () => driver.attach('regular', RECORD),
    });

    // The arbitration half genuinely happened, so the outcome is accepted —
    // the same position `decideCapture` takes when handed a browser and no
    // store. What must not happen is `pageDriven: true` with no value.
    assert.equal(result.pageDriven, false);
    assert.equal(result.result, undefined);
    assert.match(
      String(result.notDrivenReason),
      /inline limit/i,
      'the caller was not told why its value did not arrive',
    );
  });
});

test('an evaluation that reaches no browser reports no value at all', async () => {
  // The control for the assertions above: absent because nothing ran, not
  // absent because the value was dropped. Without this pair, a handler that
  // never returned a value would satisfy "the field is optional".
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);

    const result = await fixture.broker.evaluate({
      key: lease.key,
      tabId: lease.tabId,
      expression: '1 + 1',
      artifacts: fixture.artifacts,
    });

    assert.equal(result.pageDriven, false);
    assert.equal(result.result, undefined);
    // The decision is still durable — the lease was renewed and the row
    // written — which is what makes the missing value a report rather than a
    // failure.
    assert.equal(result.claimId, lease.claimId);
  });
});

/* ── `capture.exclusive_mode` (§7.1), which had no implementation ── */

test('a capture naming a selector and the whole page is refused', async () => {
  // The rule is specified in §7.1 and was enforced nowhere: a capture asking
  // for both was accepted, and which picture it took was decided by whichever
  // argument the pipeline read first.
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = new FakeBrowserDriver();

    await assert.rejects(
      fixture.broker.capture({
        key: lease.key,
        tabId: lease.tabId,
        fullPage: true,
        selector: '.thing',
        session: () => driver.attach('regular', RECORD),
        artifacts: fixture.artifacts,
      }),
      (error: unknown) => error instanceof Error && /both/i.test(error.message),
    );

    // **The physical side-effect, not only the throw.** A refusal that fires
    // after the shutter has already been pressed is not a refusal — the
    // picture exists and the caller was told it does not.
    assert.deepEqual(driver.callsOf('capture'), [], 'the refused capture still took a picture');
    assert.equal(
      fixture.readCommitted<{ n: number }>('SELECT count(*) AS n FROM captures')[0]?.n,
      0,
      'the refused capture wrote a row',
    );
  });
});

test('each mode alone is still accepted, so the rule refuses the pair and not the arguments', async () => {
  // Without this pair the test above would pass against a handler that
  // refused every capture, or refused any capture naming a selector at all.
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = new FakeBrowserDriver();

    const wholePage = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      fullPage: true,
      session: () => driver.attach('regular', RECORD),
      artifacts: fixture.artifacts,
    });
    assert.equal(wholePage.pageDriven, true);

    const element = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      selector: '.thing',
      session: () => driver.attach('regular', RECORD),
      artifacts: fixture.artifacts,
    });
    assert.equal(element.pageDriven, true);
  });
});
