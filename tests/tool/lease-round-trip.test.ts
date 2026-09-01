import assert from 'node:assert/strict';
import test from 'node:test';

import { makeServiceSubject } from '../../src/adapter/conformance/service-subject.ts';
import { encodeMessage, METHODS } from '../../src/tool/protocol.ts';
import { serveSession } from '../../src/tool/session.ts';
import { asyncLines } from '../helpers/async-lines.ts';

/**
 * **A caller can claim a lease over this surface and then release it, using
 * only what the surface gave back.**
 *
 * ── The loss this asserts against ───────────────────────────────────────
 *
 * A field session claimed at least two leases over the tool surface and never
 * saw the keys. The claims genuinely succeeded — real leases, real tabs — and
 * the replies carried no `content`, so the client rendered nothing. A key is
 * returned exactly once and is recoverable from nowhere (§2.2), so a key that
 * is not rendered is a key that is gone: the caller was left holding leases it
 * could not give back, waiting for them to lapse.
 *
 * For a service whose most consequential defect class is a leak, "the caller
 * cannot release what it successfully claimed" is the worst property it can
 * have. So this test does the whole round trip and — the part that matters —
 * **releases with a key it read out of the claim's own reply**, the way a
 * caller must.
 *
 * ── Why the key is threaded rather than looked up ───────────────────────
 *
 * Nothing here reaches into the store for the key, and that restriction is
 * the entire assertion. A test that asked the database what key had been
 * issued would pass against precisely the broken build this exists to catch:
 * the store knew the key all along; the *caller* was the one who could not see
 * it. Reading it back off the wire is what makes this a test about the reply.
 *
 * ── In process, over the real session loop, with a fake browser ─────────
 *
 * injected-test-ok: a granted lease whose key is then spent is unreachable
 * through any shipped binary without launching a real browser, because the
 * grant is what starts one — and continuous integration has no browser, so a
 * spawn-driven version of this could not run in the one place it must. The
 * faithful mutation it kills is rendering only the outcome into the text
 * block, leaving the key in `structuredContent` alone: `check-operations.mjs`,
 * `check-argument-refusals.mjs` and the spawned tests all still pass, because
 * the key genuinely is in the reply and every one of them reads it
 * structurally — and a client that renders `content`, which is what the caller
 * in the field actually had, still shows a lease key nobody can read. This
 * duplicates nothing `check-operations.mjs` owns: that gate proves a lease
 * survives the process that made it, by reading the key out of the structured
 * half, which is exactly the half this mutation leaves intact.
 *
 * `makeServiceSubject` is the real service `createRuntime` builds for both
 * shipped binaries, with only the browser driver faked — so the claim, the
 * key, the lease and the release are all real, and no browser is launched.
 * Launching one per run is also how browsers get leaked, which is the thing
 * this file is about.
 */

/** Send one message through a real session and read the single reply back. */
async function call(
  service: Awaited<ReturnType<typeof makeServiceSubject>>['service'],
  name: string,
  args: Record<string, unknown>,
): Promise<{
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly structured: Record<string, unknown>;
  readonly isError: unknown;
}> {
  const written: string[] = [];
  await serveSession(
    asyncLines(
      encodeMessage({ id: 1, method: METHODS.callTool, params: { name, arguments: args } }),
    ),
    { service, streams: { write: (line) => written.push(line) } },
  );

  assert.equal(written.length, 1, `${name} wrote ${String(written.length)} replies, expected one`);
  const response = JSON.parse(written[0] ?? '') as Record<string, unknown>;
  assert.equal(response['error'], undefined, `${name} came back as a protocol error`);

  const result = response['result'] as Record<string, unknown> | undefined;
  assert.ok(result !== undefined, `${name} carried no result`);

  const content = result['content'];
  assert.ok(Array.isArray(content), `${name} carried NO CONTENT ARRAY — a client sees nothing`);
  assert.ok(content.length > 0, `${name} carried an empty content array`);

  const structured = result['structuredContent'];
  assert.ok(
    structured !== null && typeof structured === 'object',
    `${name} carried no structured content`,
  );

  return {
    content: content as { type: string; text: string }[],
    structured: structured as Record<string, unknown>,
    isError: result['isError'],
  };
}

test('A CALLER CAN CLAIM AND THEN RELEASE USING ONLY WHAT MCP GAVE BACK', async () => {
  const subject = await makeServiceSubject();
  try {
    // ── The claim ────────────────────────────────────────────────────────
    const claimed = await call(subject.service, 'browser_claim', {
      session_id: 'a-round-trip',
      browser: 'regular',
      purpose: 'Prove a lease claimed over this surface can be released over it.',
    });

    assert.equal(claimed.structured['outcome'], 'accepted', 'the claim was not granted');
    assert.notEqual(claimed.isError, true, 'a granted claim was flagged as an error');

    const granted = claimed.structured['value'] as Record<string, unknown>;

    // **The key came back.** `browser_claim` is the single named exception to
    // the never-returned rule, because a grant that withholds its key issues a
    // lease nobody can reach.
    const key = granted['key'];
    assert.equal(typeof key, 'string', 'the grant returned no lease key');
    assert.ok(String(key).length > 0, 'the grant returned an empty lease key');

    // And it is *visible*, not merely present in a field a client does not
    // render. This is the exact failure: the key was in the reply all along
    // and no client could show it.
    const rendered = claimed.content.map((block) => block.text).join('\n');
    assert.ok(
      rendered.includes(String(key)),
      'the lease key never reached the content a client renders, so a caller cannot read it',
    );

    // ── The release, with that key and nothing else ───────────────────────
    const released = await call(subject.service, 'browser_release', { lease_key: key });

    assert.equal(
      released.structured['outcome'],
      'accepted',
      'the lease could not be released with the key its own claim returned',
    );
    assert.notEqual(released.isError, true, 'a successful release was flagged as an error');

    // The lease is actually gone, by the same predicate the capacity check
    // uses — not merely reported as released.
    assert.equal(subject.liveClaimCount(), 0, 'the claim survived its own release');
  } finally {
    await subject.dispose?.();
  }
});

test('a release with a key the caller never held is refused, and says why', async () => {
  // The negative control. Without it the test above would pass against a
  // surface that accepted every release — including one that never checked the
  // key at all, which would make "the round trip works" mean nothing.
  const subject = await makeServiceSubject();
  try {
    const refused = await call(subject.service, 'browser_release', {
      lease_key: 'a-key-that-was-never-issued',
    });

    assert.equal(refused.structured['outcome'], 'refused');
    assert.equal(refused.structured['rule'], 'key.valid');
    assert.equal(refused.isError, true, 'a refusal was not flagged as an error');

    // The refusal is renderable, and it is the *sentence* that renders —
    // `key.valid` explains that a key is issued once and cannot be looked up,
    // which is the whole reason losing one matters.
    const rendered = refused.content.map((block) => block.text).join('\n');
    assert.match(rendered, /key\.valid/u);
  } finally {
    await subject.dispose?.();
  }
});
