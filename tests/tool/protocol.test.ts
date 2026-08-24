import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeMessage, encodeMessage, METHODS } from '../../src/tool/protocol.ts';

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

test('a message with no id is malformed, and carries no id to answer to', () => {
  const decoded = decodeMessage(JSON.stringify({ method: METHODS.listTools }));
  assert.equal(decoded.kind, 'malformed');
  if (decoded.kind !== 'malformed') {
    return;
  }
  assert.equal(decoded.id, undefined, 'a message with no id must not invent one');
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
  for (const id of [null, true, { nested: 1 }, ['a']]) {
    const decoded = decodeMessage(JSON.stringify({ id, method: METHODS.listTools }));
    assert.equal(decoded.kind, 'malformed', `${JSON.stringify(id)} was accepted as an id`);
    if (decoded.kind === 'malformed') {
      assert.equal(decoded.id, undefined);
    }
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

test('the method names are the two this surface answers, named rather than counted', () => {
  assert.deepEqual(METHODS, { listTools: 'tools/list', callTool: 'tools/call' });
});
