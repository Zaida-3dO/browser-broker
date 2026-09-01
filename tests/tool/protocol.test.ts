import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeMessage,
  encodeMessage,
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  METHODS,
  negotiateProtocolVersion,
  NOTIFICATIONS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  toJsonRpcCode,
} from '../../src/tool/protocol.ts';

/**
 * The wire format, and the two properties the framing rests on.
 *
 * The framing rule is "one JSON object per line", which has exactly one way
 * to break: a message that spans lines. So that is asserted directly rather
 * than trusted to the serialiser's documented behaviour.
 */

test('an encoded message is ONE line, even when its content contains newlines', () => {
  // The single-character change that breaks this test: adding an indent
  // argument to `JSON.stringify` in `encodeMessage`. That is a change
  // somebody makes to be helpful when debugging, and it silently destroys the
  // framing for every caller.
  const line = encodeMessage({
    id: 1,
    result: { message: 'first line\nsecond line\r\nthird' },
  });

  assert.equal(line.includes('\n'), false, 'the encoded message spans lines');
  assert.equal(line.includes('\r'), false, 'the encoded message carries a carriage return');
  // And it still round-trips: the newlines survive as escaped content.
  const parsed = JSON.parse(line) as { result: { message: string } };
  assert.equal(parsed.result.message, 'first line\nsecond line\r\nthird');
});

test('a request round-trips through the encoder and the decoder', () => {
  const line = encodeMessage({
    id: 'a-string-id',
    method: METHODS.callTool,
    params: { name: 'browser_status', arguments: { lease_key: 'k' } },
  });

  const decoded = decodeMessage(line);
  assert.equal(decoded.kind, 'request');
  if (decoded.kind !== 'request') {
    return;
  }
  assert.equal(decoded.request.id, 'a-string-id');
  assert.equal(decoded.request.method, METHODS.callTool);
  assert.deepEqual(decoded.request.params, {
    name: 'browser_status',
    arguments: { lease_key: 'k' },
  });
});

test('a line that is not JSON is reported as malformed, not thrown and not skipped', () => {
  const decoded = decodeMessage('{not json');
  assert.equal(decoded.kind, 'malformed');
  if (decoded.kind !== 'malformed') {
    return;
  }
  assert.equal(decoded.id, undefined);
  assert.match(decoded.why, /not JSON/u);
});

test('a message that is a JSON array is malformed — a message is an object', () => {
  const decoded = decodeMessage('[1, 2, 3]');
  assert.equal(decoded.kind, 'malformed');
  if (decoded.kind !== 'malformed') {
    return;
  }
  assert.match(decoded.why, /JSON object/u);
});

test('a message with no id but a method is a NOTIFICATION, not a malformed message', () => {
  // The identifier's absence is the entire signal. Reading this as malformed
  // is how a surface ends up answering `notifications/initialized` — the one
  // thing a notification must never draw — so the reading is asserted here at
  // the decoder rather than only at the loop that acts on it.
  const decoded = decodeMessage(JSON.stringify({ method: NOTIFICATIONS.initialized }));
  assert.equal(decoded.kind, 'notification');
  if (decoded.kind !== 'notification') {
    return;
  }
  assert.equal(decoded.notification.method, NOTIFICATIONS.initialized);
});

test('the id KEY being absent is what makes a notification, not merely an unusable value', () => {
  // The distinction the fix for the sibling defect rests on: `record['id']`
  // is `undefined` both when the key is missing and when it is `id: null`,
  // so a decoder that read only the value could not tell them apart. This
  // pins the true-absence case, so a future change collapsing the two
  // checks back into one would be caught here rather than only by the
  // present-but-unusable test beside it.
  const decoded = decodeMessage(JSON.stringify({ method: METHODS.listTools }));
  assert.equal(decoded.kind, 'notification', 'a truly absent id must still read as a notification');
});

test('a notification with malformed params has nobody to answer, so it stays malformed', () => {
  // No identifier means no way to report the problem to the sender. The loop
  // logs this rather than replying, which is the same rule as any other
  // unanswerable line.
  const decoded = decodeMessage(
    JSON.stringify({ method: NOTIFICATIONS.initialized, params: 'a string' }),
  );
  assert.equal(decoded.kind, 'malformed');
  if (decoded.kind !== 'malformed') {
    return;
  }
  assert.equal(decoded.id, undefined, 'a message with no id must not invent one');
  assert.match(decoded.why, /params/u);
});

test('a message with an id but no method is malformed, and KEEPS the id so it can be answered', () => {
  // This is the case the distinction exists for: there is somebody to answer,
  // so the loop above must answer rather than log. Losing the id here would
  // turn an answerable failure into a silent one.
  const decoded = decodeMessage(JSON.stringify({ id: 7 }));
  assert.equal(decoded.kind, 'malformed');
  if (decoded.kind !== 'malformed') {
    return;
  }
  assert.equal(decoded.id, 7);
  assert.match(decoded.why, /method/u);
});

test('an id that is neither a number nor a string is not accepted as an id', () => {
  // With a method present, an id KEY present, and no usable identifier value,
  // the message is malformed rather than a request — the surface will not
  // invent an identifier to answer to. It is also not read as a
  // notification: the key is present, so there is somebody to answer, and
  // `decoded.id` is `null` rather than `undefined` for exactly that reason
  // — see the sibling test asserting a response is written for this case.
  for (const id of [null, true, { nested: 1 }, ['a']]) {
    const decoded = decodeMessage(JSON.stringify({ id, method: METHODS.listTools }));
    assert.equal(decoded.kind, 'malformed', `${JSON.stringify(id)} was accepted as an id`);
    if (decoded.kind !== 'malformed') {
      continue;
    }
    assert.equal(decoded.id, null, 'a present-but-unusable id must answer with id: null');
  }
});

test('params, when present, must be an object', () => {
  const decoded = decodeMessage(
    JSON.stringify({ id: 1, method: METHODS.callTool, params: 'a string' }),
  );
  assert.equal(decoded.kind, 'malformed');
  if (decoded.kind !== 'malformed') {
    return;
  }
  assert.equal(decoded.id, 1);
  assert.match(decoded.why, /params/u);
});

test('the method names are the three this surface answers, named rather than counted', () => {
  assert.deepEqual(METHODS, {
    initialize: 'initialize',
    listTools: 'tools/list',
    callTool: 'tools/call',
  });
});

/**
 * The JSON-RPC envelope, and the bargain that keeps two code spaces alive.
 *
 * These assert the doorway rather than the rooms: a client rejects a message
 * with no `jsonrpc` field before it ever reaches a tool, so the envelope is
 * the part that decides whether ten working tools are reachable at all.
 */

test('EVERY encoded message carries the JSON-RPC version', () => {
  // The single-character change that breaks this test: deleting the
  // `jsonrpc` key from `withEnvelope`. That is the whole of what made this
  // surface unreachable from a real client, so it is asserted on all three
  // message shapes rather than on a representative one.
  const request = JSON.parse(encodeMessage({ id: 1, method: METHODS.listTools })) as {
    jsonrpc: string;
  };
  const result = JSON.parse(encodeMessage({ id: 1, result: { ok: true } })) as { jsonrpc: string };
  const failure = JSON.parse(
    encodeMessage({ id: 1, error: { code: 'tool_not_found', message: 'no' } }),
  ) as { jsonrpc: string };

  assert.equal(request.jsonrpc, JSONRPC_VERSION);
  assert.equal(result.jsonrpc, JSONRPC_VERSION);
  assert.equal(failure.jsonrpc, JSONRPC_VERSION);
  assert.equal(JSONRPC_VERSION, '2.0', 'the version string is the one JSON-RPC specifies');
});

test('an error goes out with the NUMERIC code, and keeps this surface\u2019s name beside it', () => {
  // The bargain: the transport gets the integer it requires, and the caller
  // that knows this service keeps the distinction the integer cannot carry.
  // Deleting the `data` field breaks the second half, and returning the
  // string in `code` breaks the first.
  const encoded = JSON.parse(
    encodeMessage({ id: 4, error: { code: 'tool_not_found', message: 'there is no such tool' } }),
  ) as { error: { code: number; message: string; data?: { code: string } } };

  assert.equal(encoded.error.code, JSONRPC_ERROR_CODES.methodNotFound);
  assert.equal(typeof encoded.error.code, 'number', 'a JSON-RPC error code is an integer');
  assert.equal(encoded.error.data?.code, 'tool_not_found', 'the internal taxonomy was flattened');
  assert.equal(encoded.error.message, 'there is no such tool');
});

test('a response carries result XOR error, never both', () => {
  // JSON-RPC requires exactly one, and a client cannot resolve a message
  // carrying both. An error wins; the result is dropped rather than shipped
  // alongside a contradiction.
  const encoded = JSON.parse(
    encodeMessage({ id: 5, result: { ok: true }, error: { code: 'malformed_call', message: 'x' } }),
  ) as Record<string, unknown>;

  assert.ok('error' in encoded, 'the error was dropped');
  assert.equal('result' in encoded, false, 'a response carried both a result and an error');
});

test('the taxonomy maps onto JSON-RPC integers, MANY-TO-ONE and without loss of the name', () => {
  // Two genuinely different facts share one integer, which is exactly why the
  // name survives separately. If this ever becomes one-to-one, the mapping
  // has stopped being needed and the taxonomy has probably been flattened.
  assert.equal(toJsonRpcCode('method_not_found'), JSONRPC_ERROR_CODES.methodNotFound);
  assert.equal(toJsonRpcCode('tool_not_found'), JSONRPC_ERROR_CODES.methodNotFound);
  assert.equal(toJsonRpcCode('malformed_message'), JSONRPC_ERROR_CODES.invalidRequest);
  assert.equal(toJsonRpcCode('malformed_call'), JSONRPC_ERROR_CODES.invalidParams);
  assert.equal(toJsonRpcCode('unexpected_failure'), JSONRPC_ERROR_CODES.internalError);
  // A name this function has not been taught is the surface failing to
  // describe itself, which is an internal error rather than a caller error.
  assert.equal(toJsonRpcCode('a_code_nobody_has_written_yet'), JSONRPC_ERROR_CODES.internalError);
});

test('version negotiation ANSWERS rather than crashes, whatever the client asks for', () => {
  // A client asking for a revision this surface does not implement is told
  // what is on offer and decides for itself. Throwing here would break the
  // handshake on the next revision of the specification rather than on
  // anything wrong with the caller.
  assert.equal(negotiateProtocolVersion(PROTOCOL_VERSION), PROTOCOL_VERSION);
  // An older revision this surface does speak is agreed to on the client's
  // terms, which is the entire reason the supported list has more than one
  // entry.
  const older = SUPPORTED_PROTOCOL_VERSIONS[1];
  assert.ok(older !== undefined, 'the supported list must offer something to negotiate down to');
  assert.equal(negotiateProtocolVersion(older), older);

  for (const asked of ['3999-01-01', '', 'not-a-version', undefined, null, 7, {}]) {
    assert.equal(
      negotiateProtocolVersion(asked),
      PROTOCOL_VERSION,
      `negotiating ${JSON.stringify(asked)} did not fall back to what this surface speaks`,
    );
  }
});
