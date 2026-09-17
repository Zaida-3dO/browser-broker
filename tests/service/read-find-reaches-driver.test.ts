import assert from 'node:assert/strict';
import test from 'node:test';

import { makeServiceSubject } from '../../src/adapter/conformance/service-subject.ts';
import { parseArguments } from '../../src/cli/adapter.ts';

/**
 * **`find` survives every layer between the caller and the driver.**
 *
 * ── Why this file exists, and it is not "for completeness" ──────────────
 *
 * `scripts/check-argument-reachability.mjs` proves that `find` is READ at the
 * bridge. Its own header is emphatic that this is necessary and **not
 * sufficient**, and names this repository's own counter-example:
 *
 *   `tier` WAS read at the bridge, WAS validated, WAS packed into a request
 *   object, and was then **dropped at the single `takeCapture` call site**,
 *   which spread only `fullPage` and `selector`. Every capture was taken at
 *   the default rung regardless of what was asked for, and **the check passed
 *   throughout.** It compiled silently because TypeScript's excess-property
 *   check does not apply to conditionally-spread properties.
 *
 * `find` is assembled the same way — conditionally spread at the bridge — so
 * it is vulnerable to exactly that failure, and the static check cannot see
 * it. This is the instrument that can: it asserts the value **arrived at the
 * seam**, by reading the fake driver's call log.
 *
 * An inert `find` would be worse than a missing one. A caller that filters a
 * snapshot for "Checkout", gets the whole tree back, and does not notice has
 * been handed a file whose contents mean something other than what was asked
 * for — the manufactured-evidence class the reachability check's header
 * describes.
 *
 * ── The mutations these kill ────────────────────────────────────────────
 *
 * - Deleting `...(find === undefined ? {} : { find })` from the bridge's
 *   `case 'read'` — the filter never arrives and the first test fails.
 * - Dropping `{ snapshotFind }` from the `session.read(...)` call site in
 *   `decideRead`, which is precisely the `tier` mutation — same failure.
 * - Ignoring `options` inside `RealBrowserDriver.read` would NOT be caught
 *   here, because this runs against the fake; that half is covered by
 *   `tests/service/snapshot-find.test.ts`, which tests the filter directly.
 *   Stated rather than left for a reader to discover.
 */

/**
 * Perform one `read` through the real service, from an argv a person types,
 * and hand back both the outcome and what the driver was told.
 *
 * Starts at `parseArguments` deliberately: a test that called the service
 * with a hand-built argument record would skip the CLI spelling, which is one
 * of the two surfaces this argument has.
 */
async function readWith(
  argv: readonly string[],
): Promise<{ outcome: string; value: Record<string, unknown>; readDetail: unknown }> {
  const subject = await makeServiceSubject();
  try {
    const claimed = await subject.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: parseArguments([
        '--session-id',
        'read-find',
        '--purpose',
        'Proving a snapshot filter reaches the driver that has to apply it.',
      ]),
    });
    assert.equal(claimed.outcome, 'accepted', 'the lease this test needs was not granted');
    const key = String((claimed as { value: Record<string, unknown> }).value['key']);

    const performed = await subject.service.perform({
      operation: 'read',
      adapter: 'cli',
      arguments: parseArguments([...argv, '--lease-key', key]),
    });

    const readCall = subject.driverCalls().findLast((call) => call.name === 'read');
    return {
      outcome: performed.outcome,
      value: (performed as { value?: Record<string, unknown> }).value ?? {},
      readDetail: readCall?.detail,
    };
  } finally {
    await subject.dispose?.();
  }
}

/** The filter the driver was told about, as the fake records it. */
function snapshotFindFrom(detail: unknown): unknown {
  assert.ok(detail !== null && typeof detail === 'object', 'the driver recorded no read at all');
  return (detail as Record<string, unknown>)['snapshotFind'];
}

test('THE HEADLINE: a find typed by a caller arrives at the driver', async () => {
  const { outcome, readDetail } = await readWith(['--find', 'Checkout']);

  assert.equal(
    outcome,
    'accepted',
    `a well-formed find was refused: ${JSON.stringify(readDetail)}`,
  );
  assert.equal(
    snapshotFindFrom(readDetail),
    '"Checkout"',
    'the filter did not reach the driver — this is the `tier` failure, exactly',
  );
});

test('a pattern arrives as a pattern, not flattened to the text of one', async () => {
  // The distinction matters at the seam: a `/…/` that arrived as the literal
  // string "/^\\s*- button/" would match nothing at all, and would do it
  // silently.
  const { outcome, readDetail } = await readWith(['--find', '/^\\s*- button/']);

  assert.equal(outcome, 'accepted');
  assert.equal(snapshotFindFrom(readDetail), '/^\\s*- button/');
});

test('THE CONTROL: a read with no find tells the driver nothing to filter by', async () => {
  // Without this, "the filter arrives" would also pass against a driver that
  // was handed some filter on every read — including one that filtered the
  // whole tree away for a caller who never asked.
  const { outcome, readDetail } = await readWith([]);

  assert.equal(outcome, 'accepted');
  assert.equal(
    snapshotFindFrom(readDetail),
    undefined,
    'a read that asked for no filter was given one',
  );
});

test('the return is still a path, and find does not add a second return shape', async () => {
  // `DECISIONS.md` §3, references not payloads: `read` is path-only, and the
  // filter narrows what is WRITTEN rather than what comes back. A filtered
  // read that started returning lines inline would be a new size policy
  // nobody argued for, and a caller would have to branch on which it got.
  const filtered = await readWith(['--find', 'Checkout']);
  const whole = await readWith([]);

  for (const result of [filtered, whole]) {
    const collected = result.value['collected'];
    assert.ok(Array.isArray(collected), `no collected list came back: ${JSON.stringify(result)}`);
    const snapshot = collected.find(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === 'object' &&
        (entry as { artifact?: unknown })['artifact'] === 'snapshot',
    ) as Record<string, unknown> | undefined;

    assert.ok(snapshot !== undefined, 'the read collected no snapshot');
    assert.equal(typeof snapshot['path'], 'string');
    // The shape is identical whether or not a filter ran: same fields, and
    // nothing carrying the matched lines themselves.
    assert.deepEqual(Object.keys(snapshot).sort(), ['artifact', 'bytes', 'path']);
  }
});

test('a malformed pattern is refused as a refusal, with the rule and the way out', async () => {
  const { outcome, value } = await readWith(['--find', '/[/']);

  assert.equal(outcome, 'refused', 'an uncompilable pattern was accepted');
  assert.equal(value['rule'], 'read.find_shape');
  // The house bar: the message names the argument and says what to do
  // instead, rather than relaying a JavaScript engine's internal wording and
  // leaving the caller to infer that the broker is broken.
  const raw = value['message'];
  const message = typeof raw === 'string' ? raw : '';
  assert.notEqual(message, '', 'the refusal carried no message at all');
  assert.match(message, /find/);
  assert.match(message, /slashes/i);
});

test('a refusal happens before the driver is touched at all', async () => {
  // The filter is validated beside the artefact list and before admission, so
  // a caller whose request cannot be honoured does not first drive a page.
  const { outcome, readDetail } = await readWith(['--find', '/[/']);

  assert.equal(outcome, 'refused');
  assert.equal(readDetail, undefined, 'the driver was asked to read despite the refusal');
});
