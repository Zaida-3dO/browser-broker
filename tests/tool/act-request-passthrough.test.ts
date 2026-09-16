import assert from 'node:assert/strict';
import test from 'node:test';

import { makeServiceSubject } from '../../src/adapter/conformance/service-subject.ts';
import type { ObservedDriverCall } from '../../src/adapter/conformance/case.ts';
import type { BrokerService } from '../../src/adapter/service-seam.ts';
import { encodeMessage, METHODS } from '../../src/tool/protocol.ts';
import { serveSession } from '../../src/tool/session.ts';
import { TOOLS_BY_NAME } from '../../src/tool/tools.ts';
import { asyncLines } from '../helpers/async-lines.ts';

/**
 * **The four verbs a flat string cannot describe are callable from the tool
 * surface, and their input arrives at the driver.**
 *
 * ── The defect this file exists for, as the thing that happened ─────────
 *
 * `emulate`, `fill_form`, `drag` and `dialog`-with-prompt-text were
 * implemented, given request types, validated, and **already parsed by the
 * bridge** — and could not be called over this surface at all, because
 * `browser_act` declared only `lease_key`, `action`, `target` and `value`,
 * and not one of those can carry an object, an array, or a second element
 * reference.
 *
 * The cost was measured rather than theorised. Two reviewers, in different
 * repositories, without conferring, guessed the same three shapes for
 * `emulate` in the same order and were refused identically each time. Both
 * fell back to reading the stylesheet rule and **both wrote in their verdicts
 * that they had tested the rule and not the media query firing** — a strictly
 * weaker claim, honestly recorded. Reduced-motion became twice running the
 * one criterion a visual review had to downgrade in writing.
 *
 * `additionalProperties: false` did not cause that and does not need
 * loosening: before it, the argument was silently dropped and the caller was
 * told nothing; after it, the same call is refused by name. The refusal is
 * the better failure. **The missing thing was always a declaration**, and
 * `actionFrom` in `src/service/bridge.ts` has opened with a whole-request
 * passthrough the entire time.
 *
 * ── Why this drives real JSON-RPC into the real service ─────────────────
 *
 * The claim is "**a caller can call this**", so a test that invoked the
 * bridge helper directly would assert something narrower than the claim and
 * would have passed on the day the surface was broken — the bridge parsed
 * `request` perfectly throughout, and the call still could not be made.
 *
 * So every case below starts at an encoded `tools/call` line fed to
 * `serveSession` — the actual session loop, over the actual protocol — and
 * runs into the service `makeServiceSubject` builds, which is the real store,
 * schema, broker and bridge. Only the browser driver is faked, as everywhere
 * in this suite: nothing under test here is a claim about what a page does,
 * and continuous integration has no browser binary.
 *
 * That means the path exercised is the whole one a caller walks: schema
 * rendering, the undeclared-argument guard, the bridge's `actionFrom`, the
 * service's own validation, and the driver at the end.
 *
 * ── Why it asserts on what the DRIVER was told ──────────────────────────
 *
 * **This is the point of the file.** Asserting `outcome === 'accepted'`
 * would pass against a surface that accepted `request` and dropped its
 * contents on the floor — which is the inert-argument defect
 * `scripts/check-argument-reachability.mjs` was written for, and a defect
 * that "does not fail, it manufactures evidence". A caller that sees
 * `accepted` concludes its preference is in force and then reports a finding
 * about a page that never had one.
 *
 * `FakeBrowserDriver` records `detail: { ...request }` — the whole
 * `ActionRequest`, not a hand-picked few fields — so each case below reads
 * the value it sent back out of the driver's log. If the forwarding breaks
 * anywhere between the wire and the driver, the value is absent or wrong and
 * these fail. That is the property worth having: the assertion is about the
 * argument *arriving*, not about the call being tolerated.
 */

/** A lease on a fresh real service, and a `tools/call` driven over the session loop. */
async function withLease(
  body: (
    callTool: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<Record<string, unknown> | undefined>,
    driverCalls: () => readonly ObservedDriverCall[],
    leaseKey: string,
  ) => Promise<void>,
): Promise<void> {
  const subject = await makeServiceSubject();
  try {
    const callTool = await callToolOver(subject.service);
    const claimed = await callTool('browser_claim', {
      session_id: 'act-request-passthrough',
      purpose: 'Proving the request passthrough reaches the operation that needs it.',
    });
    const key = leaseKeyFrom(claimed);
    await body(callTool, () => subject.driverCalls(), key);
  } finally {
    await subject.dispose?.();
  }
}

/**
 * One `tools/call` over a fresh session, returning the parsed response.
 *
 * A session per call rather than one long-lived session, because
 * `serveSession` consumes its input to exhaustion and returns; the lease it
 * issues lives in the store, not in the loop, so the next session finds it.
 * The alternative — an input stream fed lazily across the whole test — would
 * put the test's own plumbing on the critical path of an assertion about
 * argument forwarding, which is not what is being measured.
 */
function callToolOver(
  service: BrokerService,
): Promise<(name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>> {
  return Promise.resolve(async (name: string, args: Record<string, unknown>) => {
    const written: string[] = [];
    await serveSession(
      asyncLines(
        encodeMessage({ id: 1, method: METHODS.callTool, params: { name, arguments: args } }),
      ),
      { service, streams: { write: (line) => written.push(line) } },
    );
    assert.equal(written.length, 1, `${name} did not produce exactly one response line`);
    return JSON.parse(written[0] ?? '') as Record<string, unknown>;
  });
}

/**
 * The structured payload a `tools/call` reply carries.
 *
 * Read from `structuredContent`, which is the field a client parses and which
 * is present on an acceptance and a refusal alike — a refusal's human half is
 * prose in `content`, so scraping that text would work for one outcome and
 * not the other. `content` is still asserted present, because a reply a
 * client cannot render is its own defect and this is a cheap place to notice.
 */
function structured(response: Record<string, unknown> | undefined): Record<string, unknown> {
  const result = response?.['result'] as Record<string, unknown> | undefined;
  assert.ok(result, `the reply carried no result: ${JSON.stringify(response)}`);
  const content = result['content'] as { type: string; text: string }[] | undefined;
  assert.ok(content && content.length > 0, 'the reply carried no renderable content');
  const payload = result['structuredContent'] as Record<string, unknown> | undefined;
  assert.ok(payload, `the reply carried no structuredContent: ${JSON.stringify(result)}`);
  return payload;
}

function leaseKeyFrom(response: Record<string, unknown> | undefined): string {
  const payload = structured(response);
  assert.equal(payload['outcome'], 'accepted', `the lease this test needs was not granted`);
  const value = payload['value'] as Record<string, unknown>;
  const key = value['key'];
  assert.equal(typeof key, 'string', 'the grant returned no lease key');
  return String(key);
}

/** The most recent `act` the driver was asked to perform, as the request it received. */
function lastAct(calls: readonly ObservedDriverCall[]): Readonly<Record<string, unknown>> {
  const acts = calls.filter((call) => call.name === 'act');
  const latest = acts[acts.length - 1];
  assert.ok(latest, 'the driver was never asked to act at all');
  return latest.detail ?? {};
}

test('browser_act declares `request`, and the schema a client reads offers it', () => {
  const actTool = TOOLS_BY_NAME.get('browser_act');
  assert.ok(actTool, 'browser_act is on the surface');

  const request = actTool.arguments.find((argument) => argument.name === 'request');
  assert.ok(request, 'browser_act does not declare `request`, so all four verbs are unreachable');
  assert.equal(
    request.type,
    'object',
    '`request` must be an object to carry preferences or fields',
  );
  assert.equal(
    request.required,
    false,
    '`request` is the alternative to action/target/value, not a new obligation',
  );

  // The description is the only place a caller can learn the shape while the
  // refusals still name a command-line flag instead. A `request` nobody can
  // guess the contents of is no better than a refusal, so the four verbs it
  // exists for are named in the text a client actually renders.
  for (const verb of ['emulate', 'fill_form', 'drag', 'dialog']) {
    assert.ok(
      request.description.includes(verb),
      `\`request\`'s description never mentions "${verb}", so a caller cannot discover it`,
    );
  }
  assert.ok(
    request.description.includes('preferences'),
    'the description does not name the `preferences` field an emulate needs',
  );
});

test('emulate: a media preference sent through `request` reaches the driver', async () => {
  await withLease(async (callTool, driverCalls, key) => {
    const response = await callTool('browser_act', {
      lease_key: key,
      request: { action: 'emulate', preferences: { reducedMotion: 'reduce' } },
    });

    const payload = structured(response);
    assert.equal(
      payload['outcome'],
      'accepted',
      `emulate was refused over the tool surface: ${JSON.stringify(payload)}`,
    );

    // The assertion that matters. An accepted call proves the guard let it
    // through; only the driver's log proves the preference was carried.
    const performed = lastAct(driverCalls());
    assert.equal(performed['action'], 'emulate');
    assert.deepEqual(
      performed['preferences'],
      { reducedMotion: 'reduce' },
      'the driver was asked to emulate, but without the preference the caller sent',
    );
  });
});

test('fill_form: the fields array arrives intact, in order', async () => {
  await withLease(async (callTool, driverCalls, key) => {
    const fields = [
      { ref: 'e1', value: 'first' },
      { ref: 'e2', value: 'second' },
    ];
    const response = await callTool('browser_act', {
      lease_key: key,
      request: { action: 'fill_form', fields },
    });

    assert.equal(
      structured(response)['outcome'],
      'accepted',
      'fill_form was refused over the tool surface',
    );

    const performed = lastAct(driverCalls());
    assert.equal(performed['action'], 'fill_form');
    // Deep-equal over both entries rather than a length check: a forwarding
    // that kept the array and emptied its members would pass a count.
    assert.deepEqual(
      performed['fields'],
      fields,
      'the driver was asked to fill a form, but not with the fields the caller sent',
    );
  });
});

test('drag: the SECOND element reference arrives, which `target` alone could never carry', async () => {
  await withLease(async (callTool, driverCalls, key) => {
    const response = await callTool('browser_act', {
      lease_key: key,
      request: { action: 'drag', ref: 'e1', targetRef: 'e2' },
    });

    assert.equal(
      structured(response)['outcome'],
      'accepted',
      'drag was refused over the tool surface',
    );

    const performed = lastAct(driverCalls());
    assert.equal(performed['action'], 'drag');
    assert.equal(performed['ref'], 'e1', 'the dragged element was not carried');
    assert.equal(
      performed['targetRef'],
      'e2',
      'the drop target was not carried — the whole reason a flat `target` cannot express a drag',
    );
  });
});

test('dialog: promptText arrives, so a prompt can be answered rather than left blocking', async () => {
  await withLease(async (callTool, driverCalls, key) => {
    const response = await callTool('browser_act', {
      lease_key: key,
      request: { action: 'dialog', response: { accept: true, promptText: 'answered' } },
    });

    assert.equal(
      structured(response)['outcome'],
      'accepted',
      'dialog with prompt text was refused over the tool surface',
    );

    const performed = lastAct(driverCalls());
    assert.equal(performed['action'], 'dialog');
    assert.deepEqual(
      performed['response'],
      { accept: true, promptText: 'answered' },
      'the driver was asked to answer a dialog, but without the text to answer it with',
    );
  });
});

test('THE GUARD IS NOT WEAKENED: an undeclared argument is still refused by name', async () => {
  // The negative control, and the reason this file can claim the fix is a
  // declaration rather than a hole. `additionalProperties: false` was added
  // deliberately, on the argument that an argument name which is not rejected
  // cannot be distinguished from one that is supported. Declaring `request`
  // must not buy that back for anything else — so the flat `preferences` both
  // reviewers guessed is still refused, and refused *naming itself*.
  await withLease(async (callTool, driverCalls, key) => {
    const before = driverCalls().filter((call) => call.name === 'act').length;

    const payload = structured(
      await callTool('browser_act', {
        lease_key: key,
        action: 'emulate',
        preferences: { reducedMotion: 'reduce' },
      }),
    );

    assert.equal(payload['outcome'], 'refused', 'an undeclared argument was accepted');
    assert.equal(payload['rule'], 'call.arguments_declared');
    assert.match(
      String(payload['message']),
      /preferences/u,
      'the refusal does not name the offending argument',
    );
    // It must also point at the way through, or a refused caller is exactly
    // as stuck as the two reviewers were.
    assert.match(
      String(payload['message']),
      /request/u,
      'the refusal lists what browser_act takes but not `request`, so a caller cannot recover',
    );

    assert.equal(
      driverCalls().filter((call) => call.name === 'act').length,
      before,
      'a refused call still reached the driver',
    );
  });
});
