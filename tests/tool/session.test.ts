import assert from 'node:assert/strict';
import test from 'node:test';

import { OPERATION_NAMES } from '../../src/adapter/operations.ts';
import type { BrokerService, OperationRequest } from '../../src/adapter/service-seam.ts';
import {
  encodeMessage,
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  METHODS,
  NOTIFICATIONS,
  PROTOCOL_VERSION,
  toJsonRpcCode,
} from '../../src/tool/protocol.ts';
import { linesFrom, listTools, serveSession, withoutSecrets } from '../../src/tool/session.ts';
import { TOOL_DEFINITIONS } from '../../src/tool/tools.ts';
import { asyncLines } from '../helpers/async-lines.ts';

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

const lines = asyncLines;

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

/**
 * Build a notification line: a method with **no identifier**.
 *
 * Written out here rather than taken from `encodeMessage`, because that
 * function's type deliberately cannot express a message without an
 * identifier — which is the property that stops this surface answering one by
 * accident. A test needs to send the thing a real client sends, so it builds
 * it as a client would.
 */
function notificationLine(method: string): string {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, method });
}

/**
 * Read this surface's own refusal name off a response, and check on the way
 * past that the transport's integer agrees with it.
 *
 * The two code spaces are asserted together deliberately: a test that read
 * only the name would stay green if the envelope stopped emitting an integer,
 * and one that read only the integer would stay green if the taxonomy were
 * flattened. Both are the failure this handshake work exists to prevent.
 */
function refusalName(response: Record<string, unknown> | undefined): string {
  assert.ok(response !== undefined, 'there was no response to read an error from');
  assert.equal(response['jsonrpc'], JSONRPC_VERSION, 'a response went out with no envelope');
  const error = response['error'] as { code: number; data?: { code: string } } | undefined;
  assert.ok(error !== undefined, 'the response carried no error');
  const name = error.data?.code;
  assert.equal(typeof name, 'string', 'the internal refusal name did not survive the envelope');
  assert.equal(
    error.code,
    toJsonRpcCode(String(name)),
    'the numeric code and the internal name disagree',
  );
  return String(name);
}

/**
 * Read a `tools/call` result, **asserting the wire shape on the way past.**
 *
 * ── Why every test that reads a result goes through here ────────────────
 *
 * The missing content array shipped because nothing looked at the bytes. The
 * conformance matrix compared *outcomes* at the service layer, so both routes
 * agreed and both were asked the wrong question; the handshake test called
 * `initialize` and `tools/list`, which were correct throughout. A caller got
 * an empty result for every call for as long as that arrangement held.
 *
 * So the shape is checked here rather than in one dedicated test that the
 * rest of the file routes around. Every assertion below about an outcome now
 * also asserts that the outcome arrived somewhere a client can find it, and
 * deleting `content` from `handleRequest` fails all of them at once instead of
 * none of them.
 *
 * Returns the structured half, which is what the callers of this helper go on
 * to make their own assertions against.
 */
function callResult(response: Record<string, unknown> | undefined): Record<string, unknown> {
  assert.ok(response !== undefined, 'there was no response to read a result from');
  assert.equal(response['jsonrpc'], JSONRPC_VERSION, 'a response went out with no envelope');
  assert.equal(response['error'], undefined, 'a tool call came back as a protocol error');

  const result = response['result'] as Record<string, unknown> | undefined;
  assert.ok(result !== undefined, 'the response carried no result');

  // **`content` is required by the specification and is what a client
  // renders.** Its absence is invisible to any assertion about `outcome`,
  // which is exactly how this shipped.
  const content = result['content'];
  assert.ok(Array.isArray(content), 'the result carried no content array');
  assert.ok(content.length > 0, 'the content array was empty, so a client renders nothing');
  for (const block of content as Record<string, unknown>[]) {
    assert.equal(block['type'], 'text', 'a content block was not a text block');
    assert.equal(typeof block['text'], 'string', 'a text block carried no text');
    assert.ok(String(block['text']).length > 0, 'a text block was empty');
  }

  const structured = result['structuredContent'];
  assert.ok(
    structured !== null && typeof structured === 'object',
    'the result carried no structured content, so the taxonomy is unreadable',
  );
  return structured as Record<string, unknown>;
}

/** Whether a `tools/call` result flagged itself as an error. */
function callIsError(response: Record<string, unknown> | undefined): unknown {
  return (response?.['result'] as Record<string, unknown> | undefined)?.['isError'];
}

test('tools/list returns the twelve tools, NAMED', () => {
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
      'browser_sign_in',
      'browser_sign_in_done',
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

test('the twelve tools cover the twelve operations, one each', () => {
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
  await serve(
    service,
    callTool('browser_navigate', { lease_key: 'k', url: 'https://example.com/' }),
  );

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
  const result = callResult(response);
  assert.equal(result['outcome'], 'refused');
  assert.equal(result['code'], 'unknown_browser');
  assert.equal(result['rule'], 'claim.browser_known');

  // **The taxonomy survives the move into `structuredContent`.** The three
  // fields above are the ones a caller branches on, and they are still three
  // fields rather than a sentence — flattening them into prose would leave
  // every caller matching on English, which is the regression this asserts
  // against.
  //
  // And the refusal is marked as an error *inside* a successful result, which
  // is what the specification asks for: a model that cannot see a refusal
  // cannot self-correct from one.
  assert.equal(callIsError(response), true, 'a refusal was not flagged as an error');

  // The sentence a person reads is the refusal itself, not a serialised
  // object — the message is the part that says what to do next.
  const rendered = (
    (response['result'] as Record<string, unknown>)['content'] as { text: string }[]
  )[0]?.text;
  assert.match(String(rendered), /claim\.browser_known/u);
  assert.match(String(rendered), /There are two browsers\./u);
});

test('an unknown METHOD is a protocol error — and it says what this surface does answer', async () => {
  const { service, requests } = recordingService();
  const [response] = await serve(
    service,
    encodeMessage({ id: 3, method: 'resources/read', params: {} }),
  );

  assert.ok(response !== undefined);
  assert.equal(refusalName(response), 'method_not_found');
  const error = response['error'] as Record<string, unknown>;
  assert.match(String(error['message']), /tools\/list/u);
  assert.match(String(error['message']), /tools\/call/u);
  assert.equal(requests.length, 0, 'an unknown method reached the service');
});

test('an unknown TOOL is a protocol error, and never reaches the service', async () => {
  const { service, requests } = recordingService();
  const [response] = await serve(service, callTool('browser_kill_all', {}));

  assert.ok(response !== undefined);
  assert.equal(refusalName(response), 'tool_not_found');
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
  assert.equal(refusalName(response), 'malformed_message');
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
  assert.equal(refusalName(responses[0]), 'unexpected_failure');
  const first = responses[0]?.['error'] as Record<string, unknown>;
  assert.match(String(first['message']), /came apart/u);
  // The second call — the one that gives capacity back — still went through,
  // and came back in a shape a client can actually render.
  const second = callResult(responses[1]);
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
  const answered = await serveSession(
    lines('', '   ', callTool('browser_status', { lease_key: 'k' })),
    {
      service,
      streams: { write: (line) => written.push(line) },
    },
  );
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
  const grantValue = callResult(granted)['value'] as Record<string, unknown>;
  assert.equal(grantValue['lease_key'], 'the-issued-key', 'the grant withheld the key it issued');

  const [status] = await serve(
    service,
    callTool('browser_status', { lease_key: 'the-issued-key' }),
  );
  const statusValue = callResult(status)['value'] as Record<string, unknown>;
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
  // Two chunks that split a message mid-way, so the second one ends without a
  // trailing newline — which is what a caller's last write often looks like.
  const chunks = asyncLines('{"id":1,"method":"tools/list"}\n{"id":2,', '"method":"tools/list"}');
  const collected: string[] = [];
  for await (const line of linesFrom(chunks)) {
    collected.push(line);
  }
  assert.deepEqual(collected, ['{"id":1,"method":"tools/list"}', '{"id":2,"method":"tools/list"}']);
});

/**
 * The handshake, in process.
 *
 * The end-to-end version of this lives in the spawned smoke subset, because
 * the process boundary is part of what a real client exercises. These cover
 * the dispatch decisions themselves, which cost nothing per case here.
 */

test('INITIALIZE is answered with a negotiated version, capabilities and serverInfo', async () => {
  // The single change that breaks this test: deleting the `initialize` branch
  // from `handleRequest`. That is precisely the state the surface shipped in,
  // where a real client got `method_not_found` on its first message and hung
  // up before reaching the twelve tools.
  const { service, requests } = recordingService();
  const [response] = await serve(
    service,
    encodeMessage({
      id: 1,
      method: METHODS.initialize,
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'a-client', version: '1.0.0' },
      },
    }),
  );

  assert.ok(response !== undefined, 'initialize drew no response at all');
  assert.equal(response['jsonrpc'], JSONRPC_VERSION);
  assert.equal(response['id'], 1);
  assert.equal(response['error'], undefined, 'initialize was refused');

  const result = response['result'] as {
    protocolVersion: string;
    capabilities: Record<string, unknown>;
    serverInfo: { name: string; version: string };
  };
  assert.equal(result.protocolVersion, PROTOCOL_VERSION);
  // `tools` is announced; nothing else is, because nothing else exists. A
  // surface claiming `resources` here would make a client offer its user a
  // menu that answers `method_not_found` when chosen.
  assert.deepEqual(Object.keys(result.capabilities), ['tools']);
  assert.equal(result.serverInfo.name, 'browser-broker');
  assert.equal(typeof result.serverInfo.version, 'string');

  // The handshake is answered by the surface itself and never reaches the
  // arbitration core — there is no lease involved in saying hello.
  assert.equal(requests.length, 0, 'initialize reached the service');
});

test('initialize NEGOTIATES: an unknown version gets an answer, not a crash and not silence', async () => {
  const { service } = recordingService();
  const [response] = await serve(
    service,
    encodeMessage({
      id: 2,
      method: METHODS.initialize,
      params: { protocolVersion: '3999-01-01', capabilities: {} },
    }),
  );

  assert.ok(response !== undefined, 'an unfamiliar version ended the session');
  assert.equal(response['error'], undefined, 'an unfamiliar version was refused rather than met');
  const result = response['result'] as { protocolVersion: string };
  assert.equal(result.protocolVersion, PROTOCOL_VERSION, 'the answer did not name what is spoken');
});

test('notifications/initialized DRAWS NO RESPONSE — replying to it breaks strict clients', async () => {
  // The single change that breaks this test: making the notification branch
  // in `serveSession` fall through to the request path. That produces a reply
  // to a message sent without an identifier, which a strict client is
  // entitled to treat as a broken stream.
  const { service } = recordingService();
  const written: string[] = [];
  const logged: string[] = [];

  const answered = await serveSession(lines(notificationLine(NOTIFICATIONS.initialized)), {
    service,
    streams: { write: (line) => written.push(line), log: (line) => logged.push(line) },
  });

  assert.deepEqual(written, [], 'a notification was answered');
  assert.equal(answered, 0, 'a notification was counted as a request that was answered');
  assert.equal(logged.length, 1, 'the notification was not even noted');
});

test('an UNRECOGNISED notification is also answered with silence, not method_not_found', async () => {
  // A notification is defined by having no identifier, so there is nobody to
  // send `method_not_found` to even if the method is genuinely unknown.
  const { service } = recordingService();
  const written: string[] = [];

  await serveSession(lines(notificationLine('notifications/something_invented')), {
    service,
    streams: { write: (line) => written.push(line), log: () => {} },
  });

  assert.deepEqual(written, [], 'an unknown notification drew a reply');
});

test('the whole handshake runs in order and the session still serves tools afterwards', async () => {
  const { service } = recordingService();
  const responses = await serve(
    service,
    encodeMessage({
      id: 1,
      method: METHODS.initialize,
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {} },
    }),
    notificationLine(NOTIFICATIONS.initialized),
    encodeMessage({ id: 2, method: METHODS.listTools }),
  );

  // Three messages in, two responses out: the notification is the one that
  // must not be answered, and the count is what proves it.
  assert.equal(responses.length, 2, 'the notification was answered, or a request was not');
  assert.deepEqual(
    responses.map((response) => response['id']),
    [1, 2],
    'responses did not correlate with the requests that caused them',
  );
  const listed = responses[1]?.['result'] as { tools: { name: string }[] };
  assert.equal(listed.tools.length, 12, 'the twelve tools were not reachable after the handshake');
});

test('an error response carries the numeric code AND the internal name, on the same message', () => {
  // The contract the two code spaces rest on, asserted as one object rather
  // than as two independent facts.
  const encoded = JSON.parse(
    encodeMessage({ id: 1, error: { code: 'unexpected_failure', message: 'x' } }),
  ) as { error: { code: number; data: { code: string } } };
  assert.equal(encoded.error.code, JSONRPC_ERROR_CODES.internalError);
  assert.equal(encoded.error.data.code, 'unexpected_failure');
});
