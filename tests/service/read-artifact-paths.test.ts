import assert from 'node:assert/strict';
import test from 'node:test';

import { makeServiceSubject } from '../../src/adapter/conformance/service-subject.ts';
import type { ConformanceSubject } from '../../src/adapter/conformance/run.ts';
import { claimInput, withBroker } from '../helpers/broker.ts';

/**
 * **A read says where it put what it collected.**
 *
 * ── What was wrong, precisely ───────────────────────────────────────────
 *
 * `read` reported `artifacts: ["snapshot"]` and no path, while `capture` next
 * door returned `"path": "claims/<id>/images/…"`. The files existed the whole
 * time: the driver writes each artefact and returns an `ArtifactResult`
 * carrying a path, and `decideRead` **discarded that return value entirely**.
 *
 * So the caller was told what had been collected and never where, and the
 * natural inference — the same place as my captures — is wrong. Reads land in
 * a sibling directory keyed by page and timestamp, not under the claim. A
 * field session looked under the claim directory, found only `images/`, and
 * concluded the read had silently failed.
 *
 * The knock-on is what made it expensive rather than annoying: `act` refuses a
 * CSS selector and tells the caller to use a reference minted by a snapshot —
 * correctly, and with a message the reporter called exactly right. A caller
 * who cannot find the snapshot cannot follow that advice, so every click, type
 * and hover was out of reach until they went looking through the artefact root
 * by hand.
 *
 * ── What these tests do and do not prove ────────────────────────────────
 *
 * They prove the **service reports the paths the driver gave it**, on a real
 * service through the real operation. They do not prove a file exists at that
 * path, because the browser driver here is faked — that round trip is proved
 * where it belongs, in `tests/browser/act-and-read.test.ts`, whose
 * `snapshotText` helper reads a real snapshot **file** off the path a real
 * `read` returned and pulls references out of it.
 *
 * Saying that plainly matters: a test asserting `path` is a non-empty string
 * against a fake would be easy to over-read as "the snapshot is written", and
 * it is not that. It is the narrower claim that was actually broken — the
 * handler dropped a value it had.
 */

/** Claim a lease, drive a page, and read it. */
async function readOn(subject: ConformanceSubject, what: string): Promise<Record<string, unknown>> {
  const claimed = await subject.service.perform({
    operation: 'claim',
    adapter: 'cli',
    arguments: {
      session_id: 'read-paths',
      purpose: 'Proving a read reports where it wrote what it collected.',
    },
  });
  assert.equal(claimed.outcome, 'accepted', 'the lease this test needs was not granted');
  const key = String((claimed as { value: Record<string, unknown> }).value['key']);

  await subject.service.perform({
    operation: 'navigate',
    adapter: 'cli',
    arguments: { key, url: 'https://example.com' },
  });

  const read = await subject.service.perform({
    operation: 'read',
    adapter: 'cli',
    arguments: { key, what },
  });
  assert.equal(read.outcome, 'accepted', `the read was refused: ${JSON.stringify(read)}`);

  return (read as { value: Record<string, unknown> }).value;
}

test('A READ REPORTS A PATH FOR EVERY ARTEFACT IT COLLECTED, not just their names', async () => {
  // The single change that breaks this test: dropping the `collected` getter
  // from `decideRead`, or going back to ignoring what `session.read` returns.
  const subject = await makeServiceSubject();
  try {
    const value = await readOn(subject, 'snapshot,console');

    assert.equal(value['pageDriven'], true, 'the page was not driven, so nothing was collected');
    assert.deepEqual(value['artifacts'], ['snapshot', 'console']);

    const collected = value['collected'] as { artifact: string; path: string; bytes: number }[];
    assert.ok(Array.isArray(collected), 'the read reported no collected artefacts');

    // One entry per artefact, named — not merely the right *number* of
    // entries, which would stay green if both were snapshots.
    assert.deepEqual(
      collected.map((entry) => entry.artifact),
      ['snapshot', 'console'],
      'the collected artefacts do not match the ones that were asked for',
    );

    for (const entry of collected) {
      assert.equal(typeof entry.path, 'string', `${entry.artifact} came back with no path`);
      assert.ok(entry.path.length > 0, `${entry.artifact} came back with an empty path`);
      assert.equal(typeof entry.bytes, 'number');
    }
  } finally {
    await subject.dispose?.();
  }
});

test('the paths survive serialisation, so they reach a caller on either surface', async () => {
  // `collected` is a getter, because the paths do not exist until the
  // after-commit work has run. A getter that is not enumerable is invisible to
  // `JSON.stringify` — and **both surfaces serialise**, so it would be present
  // in process, absent on the wire, and green in any test that read the object
  // directly. That is a subtle enough failure to be worth its own assertion.
  const subject = await makeServiceSubject();
  try {
    const value = await readOn(subject, 'snapshot');
    const roundTripped = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

    assert.ok(
      'collected' in roundTripped,
      'the collected artefacts did not survive serialisation, so no caller sees them',
    );
    const collected = roundTripped['collected'] as { artifact: string; path: string }[];
    assert.equal(collected.length, 1);
    assert.equal(collected[0]?.artifact, 'snapshot');
    assert.ok(String(collected[0]?.path).length > 0);
  } finally {
    await subject.dispose?.();
  }
});

test('A READ THAT DROVE NO PAGE REPORTS NO PATHS — not an empty list', async () => {
  // The negative control, and the discipline `capture` and `evaluate` both
  // keep: a caller that reached no page should find no field at all, rather
  // than an empty array it cannot tell apart from a read that genuinely
  // collected nothing. `pageDriven` is what says which happened.
  //
  // **This needs a browser that fails**, which is why it uses the broker
  // fixture rather than the conformance subject above — that subject always
  // supplies a working session, so `pageDriven` is always true and an
  // assertion guarded on it would never run. A test whose assertion is
  // unreachable is worse than no test.
  await withBroker(async (fixture) => {
    const granted = await fixture.broker.claim(claimInput());
    assert.equal(granted.outcome, 'granted');
    if (granted.outcome !== 'granted') throw new Error('unreachable');

    const result = await fixture.broker.read({
      key: granted.key,
      tabId: granted.tabId,
      session: () => {
        throw new Error('no browser could be started');
      },
    });

    // The decision still committed and the lease was still extended, so the
    // outcome is genuinely accepted — reporting a refusal would be a lie in
    // the other direction (§5.6).
    assert.equal(result.pageDriven, false, 'this test did not reach the undriven branch');

    // It still says what it *would* have collected. That half was never wrong.
    assert.deepEqual(result.artifacts, ['snapshot']);

    // And it claims no paths, because there are none.
    assert.equal(
      result.collected,
      undefined,
      'a read that drove no page reported collected artefacts anyway',
    );
  });
});
