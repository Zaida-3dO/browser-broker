import assert from 'node:assert/strict';
import test from 'node:test';

import { OPERATION_NAMES } from '../../src/adapter/operations.ts';
import type { BrokerService, OperationRequest } from '../../src/adapter/service-seam.ts';
import { encodeMessage, METHODS } from '../../src/tool/protocol.ts';
import { linesFrom, listTools, serveSession, withoutSecrets } from '../../src/tool/session.ts';
import { TOOL_DEFINITIONS } from '../../src/tool/tools.ts';

/**
 * The session loop: the lifecycle, the dispatch, and the two rules this route
 * would otherwise be free to hold differently from the command line.
 */

/** A service that records what it was asked and answers as it is told. */
function recordingService(answer?: (request: OperationRequest) => unknown): {
  readonly service: BrokerService;
  readonly requests: OperationRequest[];
} {
  const requests: OperationRequest[] = [];
  const service: BrokerService = {
    perform: (request) => {
      requests.push(request);
      const given = answer?.(request);
      if (given !== undefined) {
        return Promise.resolve(given as never);
      }
      return Promise.resolve({ outcome: 'accepted' as const, value: { ok: true } });
    },
  };
  return { service, requests };
}

async function* lines(...given: string[]): AsyncGenerator<string> {
  for (const line of given) {
    yield line;
  }
}

/** Run a session over the given lines and return what it wrote, parsed. */
async function serve(
  service: BrokerService,
  ...given: string[]
): Promise<Record<string, unknown>[]> {
  const written: string[] = [];
  await serveSession(lines(...given), {
    service,
    streams: { write: (line) => written.push(line) },
  });
  return written.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const callTool = (name: string, args: Record<string, unknown> = {}, id: number = 1): string =>
  encodeMessage({ id, method: METHODS.callTool, params: { name, arguments: args } });

test('tools/list returns the ten tools, NAMED', () => {
  // Named rather than counted: `MILESTONES.md` records a hollow test that
  // "iterated a list rather than naming its entries, so deleting an entry
  // stayed green". Deleting a tool changes this list and fails here.
  const listed = listTools() as { tools: { name: string }[] };
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
      'browser_claim',
      'browser_status',
      'browser_release',
      'browser_tab_replace',
      'browser_navigate',
      'browser_act',
      'browser_read',
      'browser_evaluate',
      'browser_capture',
      'browser_feedback',
    ],
  );
});

test('every tool has a description, because the description is the only place a caller reads', () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.description.length > 40, `${tool.name} has no real description`);
    for (const argument of tool.arguments) {
      assert.ok(argument.description.length > 10, `${tool.name}.${argument.name} is undescribed`);
    }
  }
});

test('the ten tools cover the ten operations, one each', () => {
  assert.deepEqual(
    [...TOOL_DEFINITIONS.map((tool) => tool.operation)].sort((a, b) => a.localeCompare(b)),
    [...OPERATION_NAMES].sort((a, b) => a.localeCompare(b)),
  );
});

test('THERE IS NO BROWSER-SCOPED DESTRUCTIVE VERB on this surface', () => {
  // §3.13, and the ceiling that makes this surface safe to hand to an
  // arbitrary caller: the worst an agent can do is close its own tab. The
  // administrative operations — reap, restart, clear a leaked tab — act on
  // something every caller shares and are commands a person runs (§4.3).
  //
  // Matched as shapes rather than as a list of forbidden names, so a verb
  // nobody thought to forbid is still caught if it scopes to the browser or
  // to everyone.
  const forbidden = /\b(kill|reap|restart|shutdown|destroy|purge)\b|_all\b|\ball\b/iu;
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(
      forbidden.test(tool.name),
      false,
      `${tool.name} names a browser-scoped destructive verb`,
    );
  }
  // And the two removed tools are absent rather than deprecated (§3.1).
  const names = TOOL_DEFINITIONS.map((tool) => tool.name);
  assert.equal(names.includes('browser_tab_close'), false, 'browser_tab_close is back');
  assert.equal(names.includes('browser_compare'), false, 'browser_compare is back');
});

test('THERE IS NO SEPARATE RENEW TOOL, and browser_status says it renews', () => {
  // §3.1: "two names for one effect is how a caller comes to believe one of
  // them does not renew". The absence is the contract, and the description
  // carrying the fact is what makes the absence workable — a caller that
  // could not see status renews would look for a renew tool and not find one.
  const names = TOOL_DEFINITIONS.map((tool) => tool.name);
  assert.equal(names.includes('browser_renew'), false, 'a second name for renewing exists');
  const status = TOOL_DEFINITIONS.find((tool) => tool.name === 'browser_status');
  assert.ok(status !== undefined);
  assert.match(status.description, /renew/iu, 'browser_status does not say that it renews');
});

test('a tool call reaches the service as ONE operation, on this adapter', async () => {
  const { service, requests } = recordingService();
  await serve(service, callTool('browser_navigate', { lease_key: 'k', url: 'https://example.com/' }));

  assert.equal(requests.length, 1, 'one tool call must be one service call');
  assert.equal(requests[0]?.operation, 'navigate');
  assert.equal(requests[0]?.adapter, 'tool-stdio');
  assert.deepEqual(requests[0]?.arguments, { lease_key: 'k', url: 'https://example.com/' });
});

test('A REFUSAL IS A SUCCESSFUL RESPONSE CARRYING A REFUSAL, not a protocol error', async () => {
  // The most load-bearing assertion on this route. §5.6: a refusal is the
  // service working, which is why the command line gives it a distinct exit
  // code rather than the malformed-command one. Reporting a refusal as a
  // protocol error here would take that distinction away from every caller on
  // this route and from nobody on the other — the exact drift #30 exists to
  // catch.
  //
  // The single-character change that breaks this test: returning `error:`
  // instead of `result:` in the refusal branch of `handleRequest`.
  const { service } = recordingService(() => ({
    outcome: 'refused' as const,
    code: 'unknown_browser',
    rule: 'claim.browser_known',
    message: 'There are two browsers.',
  }));

  const [response] = await serve(service, callTool('browser_claim', { browser: 'third' }));

  assert.ok(response !== undefined);
  assert.equal(response['error'], undefined, 'a refusal was reported as a protocol error');
  const result = response['result'] as Record<string, unknown>;
  assert.equal(result['outcome'], 'refused');
  assert.equal(result['code'], 'unknown_browser');
  assert.equal(result['rule'], 'claim.browser_known');
});

test('an unknown METHOD is a protocol error — and it says what this surface does answer', async () => {
  const { service, requests } = recordingService();
  const [response] = await serve(
    service,
    encodeMessage({ id: 3, method: 'resources/read', params: {} }),
  );

  assert.ok(response !== undefined);
  const error = response['error'] as Record<string, unknown>;
  assert.equal(error['code'], 'method_not_found');
  assert.match(String(error['message']), /tools\/list/u);
  assert.match(String(error['message']), /tools\/call/u);
  assert.equal(requests.length, 0, 'an unknown method reached the service');
});

test('an unknown TOOL is a protocol error, and never reaches the service', async () => {
  const { service, requests } = recordingService();
  const [response] = await serve(service, callTool('browser_kill_all', {}));

  assert.ok(response !== undefined);
  const error = response['error'] as Record<string, unknown>;
  assert.equal(error['code'], 'tool_not_found');
  // The physical side-effect: the service was never asked. A surface that
  // reported "no such tool" *after* calling something would be reporting a
  // refusal that did not happen.
  assert.equal(requests.length, 0, 'an unknown tool reached the service');
});

test('a malformed line WITH an id is answered, so no caller waits forever', async () => {
  const { service } = recordingService();
  const [response] = await serve(service, JSON.stringify({ id: 9, method: 42 }));

  assert.ok(response !== undefined);
  assert.equal(response['id'], 9);
  const error = response['error'] as Record<string, unknown>;
  assert.equal(error['code'], 'malformed_message');
});

test('a malformed line with NO id is logged rather than answered — there is nobody to answer', async () => {
  const { service } = recordingService();
  const written: string[] = [];
  const logged: string[] = [];

  const answered = await serveSession(lines('{not json at all'), {
    service,
    streams: { write: (line) => written.push(line), log: (line) => logged.push(line) },
  });

  assert.equal(answered, 0);
  assert.deepEqual(written, [], 'a message with no id was answered anyway');
  assert.equal(logged.length, 1, 'a message that could not be answered was dropped silently');
  assert.match(logged[0] ?? '', /not JSON/u);
});

test('one unexpected failure does not end the session — the caller could not release its lease', async () => {
  let calls = 0;
  const service: BrokerService = {
    perform: () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('the service came apart');
      }
      return Promise.resolve({ outcome: 'accepted' as const, value: { ok: true } });
    },
  };

  const responses = await serve(
    service,
    callTool('browser_status', { lease_key: 'k' }, 1),
    callTool('browser_release', { lease_key: 'k' }, 2),
  );

  assert.equal(responses.length, 2, 'the session died on the first failure');
  const first = responses[0]?.['error'] as Record<string, unknown>;
  assert.equal(first['code'], 'unexpected_failure');
  assert.match(String(first['message']), /came apart/u);
  // The second call — the one that gives capacity back — still went through.
  const second = responses[1]?.['result'] as Record<string, unknown>;
  assert.equal(second['outcome'], 'accepted');
});

test('THE SESSION ENDS WHEN ITS INPUT ENDS — it serves that session and exits with it', async () => {
  const { service } = recordingService();
  const written: string[] = [];

  const answered = await serveSession(lines(callTool('browser_status', { lease_key: 'k' })), {
    service,
    streams: { write: (line) => written.push(line) },
  });

  // The loop returned rather than waiting for more. That is the whole
  // lifecycle claim of row #27: no port, no daemon, nothing left running.
  assert.equal(answered, 1);
  assert.equal(written.length, 1);
});

test('blank lines are skipped without being answered', async () => {
  const { service } = recordingService();
  const written: string[] = [];
  const answered = await serveSession(lines('', '   ', callTool('browser_status', { lease_key: 'k' })), {
    service,
    streams: { write: (line) => written.push(line) },
  });
  assert.equal(answered, 1);
});

test('every response is exactly one line, so the framing survives real content', async () => {
  const { service } = recordingService(() => ({
    outcome: 'refused' as const,
    code: 'unknown_action',
    rule: 'act.verb_known',
    message: 'Not an action.\nThe actions are: click, type.',
  }));

  const written: string[] = [];
  await serveSession(lines(callTool('browser_act', { lease_key: 'k', action: 'teleport' })), {
    service,
    streams: { write: (line) => written.push(line) },
  });

  assert.equal(written.length, 1);
  assert.equal(written[0]?.includes('\n'), false, 'a response spanned lines');
});

test('THE LEASE KEY IS NEVER RETURNED — except by the grant that issues it', async () => {
  // §5.6 states the rule for the command line. Holding it on one route and
  // not the other is precisely the drift the parity claim exists to prevent,
  // so it is enforced and asserted here too.
  //
  // The single named exception is the grant: `browser_claim` has to return
  // the key or the lease it just issued is unreachable.
  const { service } = recordingService((request) =>
    request.operation === 'claim'
      ? { outcome: 'accepted' as const, value: { lease_key: 'the-issued-key', state: 'active' } }
      : { outcome: 'accepted' as const, value: { lease_key: 'leaked', state: 'active' } },
  );

  const [granted] = await serve(
    service,
    callTool('browser_claim', { session_id: 's', browser: 'regular', purpose: 'a test lease' }),
  );
  const grantValue = (granted?.['result'] as Record<string, unknown>)['value'] as Record<
    string,
    unknown
  >;
  assert.equal(grantValue['lease_key'], 'the-issued-key', 'the grant withheld the key it issued');

  const [status] = await serve(service, callTool('browser_status', { lease_key: 'the-issued-key' }));
  const statusValue = (status?.['result'] as Record<string, unknown>)['value'] as Record<
    string,
    unknown
  >;
  assert.equal(statusValue['lease_key'], undefined, 'a non-grant response carried the lease key');
  assert.equal(statusValue['state'], 'active', 'stripping the key took the rest of the value too');
});

test('the never-returned rule reaches every depth, and removes rather than masks', () => {
  const stripped = withoutSecrets({
    state: 'active',
    lease_key: 'top',
    nested: { key: 'deep', kept: 1 },
    list: [{ leaseKey: 'in-a-list', kept: 2 }],
  }) as Record<string, unknown>;

  // Absent rather than masked (§5.6): a masked field tells a reader a key
  // exists and is being withheld, which is an invitation, and a masked value
  // is one careless format change from being the real one.
  assert.equal('lease_key' in stripped, false);
  assert.deepEqual(stripped['nested'], { kept: 1 });
  assert.deepEqual(stripped['list'], [{ kept: 2 }]);
  assert.equal(stripped['state'], 'active');
});

test('a final line with no trailing newline is still a message', async () => {
  async function* chunks(): AsyncGenerator<string> {
    yield '{"id":1,"method":"tools/list"}\n{"id":2,';
    yield '"method":"tools/list"}';
  }
  const collected: string[] = [];
  for await (const line of linesFrom(chunks())) {
    collected.push(line);
  }
  assert.deepEqual(collected, ['{"id":1,"method":"tools/list"}', '{"id":2,"method":"tools/list"}']);
});
