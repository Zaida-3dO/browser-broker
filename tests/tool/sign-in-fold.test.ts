import assert from 'node:assert/strict';
import test from 'node:test';

import type { BrokerService, OperationRequest } from '../../src/adapter/service-seam.ts';
import { encodeMessage, METHODS } from '../../src/tool/protocol.ts';
import { serveSession } from '../../src/tool/session.ts';
import { asyncLines } from '../helpers/async-lines.ts';

/**
 * `browser_sign_in` is two operations folded under an `action`.
 *
 * What each test pins is a way the fold could silently go wrong: the action
 * reaching the wrong operation (a ledger and rules keyed on the operation name
 * would then see the wrong thing), an argument being dropped on the way, the
 * discriminator leaking into the service, or an argument belonging to the
 * other action being accepted and ignored.
 *
 * injected-test-ok: which operation a folded call performs is unreachable
 * through any shipped binary against a fresh store, because both operations
 * refuse an unknown key with the same `key.valid` rule — a spawned call
 * cannot tell `request` from `done`. The faithful mutation it kills is
 * swapping the two entries of the tool's `actions` map, which every spawned
 * and conformance check still passes. It duplicates nothing a spawn-driven
 * gate owns: those prove the tool is reachable, not which operation it chose.
 */

function recordingService(): {
  readonly service: BrokerService;
  readonly requests: OperationRequest[];
} {
  const requests: OperationRequest[] = [];
  return {
    requests,
    service: {
      perform: (request) => {
        requests.push(request);
        return Promise.resolve({ outcome: 'accepted' as const, value: { ok: true } });
      },
    },
  };
}

async function call(
  service: BrokerService,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const written: string[] = [];
  await serveSession(
    asyncLines(
      encodeMessage({ id: 1, method: METHODS.callTool, params: { name, arguments: args } }),
    ),
    { service, streams: { write: (line) => written.push(line) } },
  );
  return JSON.parse(written[0] ?? '{}') as Record<string, unknown>;
}

function structured(response: Record<string, unknown>): Record<string, unknown> {
  return (response['result'] as { structuredContent: Record<string, unknown> }).structuredContent;
}

test('action "request" performs the sign_in operation with every argument, and no action', async () => {
  const { service, requests } = recordingService();
  const response = await call(service, 'browser_sign_in', {
    action: 'request',
    lease_key: 'k',
    what: 'the account dashboard',
    request_seconds: 90,
  });
  assert.equal(structured(response)['outcome'], 'accepted');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.operation, 'sign_in');
  // The discriminator is consumed by the tool layer; the other three reach the service.
  assert.deepEqual(requests[0]?.arguments, {
    lease_key: 'k',
    what: 'the account dashboard',
    request_seconds: 90,
  });
});

test('action "done" performs the sign_in_done operation, not sign_in', async () => {
  const { service, requests } = recordingService();
  const response = await call(service, 'browser_sign_in', { action: 'done', lease_key: 'k' });
  assert.equal(structured(response)['outcome'], 'accepted');
  assert.equal(requests[0]?.operation, 'sign_in_done');
  assert.deepEqual(requests[0]?.arguments, { lease_key: 'k' });
});

test('an argument belonging to "request" sent with "done" is refused BY NAME, and nothing reaches the service', async () => {
  const { service, requests } = recordingService();
  const response = await call(service, 'browser_sign_in', {
    action: 'done',
    lease_key: 'k',
    what: 'the account dashboard',
  });
  const refusal = structured(response);
  assert.equal(refusal['outcome'], 'refused');
  assert.equal(refusal['rule'], 'call.arguments_declared');
  assert.match(String(refusal['message']), /"what"/u);
  assert.equal(requests.length, 0, 'a misplaced argument was forwarded and dropped');
});

test('a missing or unknown action is refused, listing the valid ones', async () => {
  for (const args of [
    { lease_key: 'k', what: 'the account dashboard' },
    { action: 'finish', lease_key: 'k' },
  ]) {
    const { service, requests } = recordingService();
    const refusal = structured(await call(service, 'browser_sign_in', args));
    assert.equal(refusal['rule'], 'call.arguments_declared');
    assert.match(String(refusal['message']), /"request" or "done"/u);
    assert.equal(requests.length, 0);
  }
});

test('the retired tool names are tool_not_found', async () => {
  for (const name of ['browser_sign_in_done', 'browser_feedback']) {
    const { service, requests } = recordingService();
    const response = await call(service, name, { lease_key: 'k' });
    assert.equal((response['error'] as { data: { code: string } }).data.code, 'tool_not_found');
    assert.equal(requests.length, 0);
  }
});
