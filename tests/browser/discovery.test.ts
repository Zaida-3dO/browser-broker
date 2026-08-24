import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ENDPOINT_TIMEOUT_MS,
  parsePortFile,
  portFilePath,
  profileDirectory,
  readDiscoveryRecord,
  verifyDiscoveryRecord,
} from '../../src/browser/discovery.ts';

/**
 * The record is a claim, not a proof — and these are the tests that make that
 * a checked property rather than a comment.
 *
 * Everything here runs on any machine, with no browser: the verification path
 * takes an injected fetch, which is what lets the *stale record* and the
 * *reused port* cases be driven deterministically. Those two cases are the
 * whole reason the module exists and neither is reproducible on demand
 * against a real browser — a port being reused by an unrelated process is not
 * something a test can arrange.
 *
 * The live counterparts — that a real browser writes this file, and that it
 * survives a hard kill — are in `real-driver.test.ts`, which needs a browser
 * and says so.
 */

function temporaryDirectory(): { dir: string; remove: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-discovery-'));
  return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A fetch that answers with the identifier it was given. */
function fetchReporting(browserUuid: string): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:1/devtools/browser/${browserUuid}`,
        }),
        { status: 200 },
      ),
    );
}

test('a well-formed record yields its port and the browser identifier', () => {
  const parsed = parsePortFile('53012\n/devtools/browser/abc-123');
  assert.deepEqual(parsed, { port: 53012, browserUuid: 'abc-123' });
});

// The mutation this catches: treating a one-line file as complete. The
// browser writes the record in two lines, so a reader can arrive between
// them — a half-written record has a valid port and no identifier, and
// accepting it would produce a record that can never be identity-checked.
test('a record with only the port line is not a record', () => {
  assert.equal(parsePortFile('53012'), undefined);
});

// The mutation this catches: testing the port for truthiness rather than for
// range. An empty first line converts to zero, which is falsy and would be
// caught, but a whitespace line also converts to zero — and zero is exactly
// what an unfinished write looks like.
test('a zero port, or one out of range, is not a record', () => {
  assert.equal(parsePortFile('0\n/devtools/browser/abc'), undefined);
  assert.equal(parsePortFile('   \n/devtools/browser/abc'), undefined);
  assert.equal(parsePortFile('70000\n/devtools/browser/abc'), undefined);
  assert.equal(parsePortFile('12abc\n/devtools/browser/abc'), undefined);
});

test('a record whose second line carries no identifier is not a record', () => {
  assert.equal(parsePortFile('53012\n'), undefined);
  assert.equal(parsePortFile('53012\n/devtools/browser/'), undefined);
});

test('an absent record file reads as no record rather than throwing', () => {
  const temp = temporaryDirectory();
  try {
    assert.equal(readDiscoveryRecord(temp.dir), undefined);
  } finally {
    temp.remove();
  }
});

// The mutation this catches: putting the file's own identifier into the
// returned record's `browserUuid`. The seam documents that field as absent
// until it has been checked against a live browser, and a record carrying an
// unverified identifier is one a later reader would reasonably treat as
// verified — which is the exact confusion this whole module exists to prevent.
test('a record read off disk carries no browser identifier, because nothing has been checked', () => {
  const temp = temporaryDirectory();
  try {
    fs.writeFileSync(portFilePath(temp.dir), '4321\n/devtools/browser/from-the-file');
    const found = readDiscoveryRecord(temp.dir);
    assert.ok(found);
    assert.equal(found.record.browserUuid, undefined);
    assert.equal(found.record.endpoint, 'http://127.0.0.1:4321');
    // Not discarded — it is the expectation the identity check matches against.
    assert.equal(found.expectedUuid, 'from-the-file');
  } finally {
    temp.remove();
  }
});

test('a live endpoint reporting the expected identifier verifies, and the record gains it', async () => {
  const outcome = await verifyDiscoveryRecord(
    { endpoint: 'http://127.0.0.1:1' },
    'the-expected-one',
    { fetchImpl: fetchReporting('the-expected-one') },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.record.browserUuid, 'the-expected-one');
});

// THE measured case, and the reason liveness is checked at all: the record
// survives the browser. Verified against a real browser while building this
// row — after a hard kill the file was still present, still readable, and
// still naming a port that answered nothing.
//
// The mutation this catches: attaching on the strength of the file. Delete
// the liveness check and this test fails, because a dead endpoint would be
// reported as verified.
test('a record whose endpoint does not answer is refused — the file outlives the browser', async () => {
  const dead = (() => Promise.reject(new Error('connection refused'))) as unknown as typeof fetch;
  const outcome = await verifyDiscoveryRecord({ endpoint: 'http://127.0.0.1:1' }, 'anything', {
    fetchImpl: dead,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.failure, 'endpoint_unreachable');
});

// THE case that makes matching the port alone unsound. Ports are reused: a
// stale record plus an unrelated process handed the same port answers
// perfectly well, and a check comparing only the number reads it as success.
//
// The mutation this catches: dropping the identifier comparison, or comparing
// the endpoint instead of the identifier. Either one makes this test pass a
// stranger.
test('an endpoint that answers as a DIFFERENT browser is refused — a matching port is not a matching browser', async () => {
  const outcome = await verifyDiscoveryRecord(
    { endpoint: 'http://127.0.0.1:1' },
    'the-browser-we-recorded',
    { fetchImpl: fetchReporting('an-entirely-unrelated-process') },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.failure, 'identity_mismatch');
});

test('an endpoint that answers without reporting an identifier is refused', async () => {
  const noIdentifier = (() =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))) as unknown as typeof fetch;
  const outcome = await verifyDiscoveryRecord({ endpoint: 'http://127.0.0.1:1' }, 'expected', {
    fetchImpl: noIdentifier,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.failure, 'identity_mismatch');
});

test('an endpoint answering with an error status is unreachable rather than verified', async () => {
  const failing = (() =>
    Promise.resolve(new Response('nope', { status: 500 }))) as unknown as typeof fetch;
  const outcome = await verifyDiscoveryRecord({ endpoint: 'http://127.0.0.1:1' }, 'expected', {
    fetchImpl: failing,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.failure, 'endpoint_unreachable');
});

// The mutation this catches: removing the timeout from the request. A port
// can be held by something that accepts a connection and never answers, and a
// verification step that inherits that hang stalls every caller rather than
// concluding the browser is not usable.
test('an endpoint that accepts and never answers is refused rather than waited on forever', async () => {
  const hangs = ((_url: string, init?: { signal?: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });
  }) as unknown as typeof fetch;

  const outcome = await verifyDiscoveryRecord({ endpoint: 'http://127.0.0.1:1' }, 'expected', {
    fetchImpl: hangs,
    timeoutMs: 50,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.failure, 'endpoint_unreachable');
});

test('the endpoint timeout is a bound, not an absent one', () => {
  assert.ok(ENDPOINT_TIMEOUT_MS > 0);
});

test('a profile directory is the configured root plus the browser, never an absolute path stored anywhere', () => {
  const root = path.join('a', 'configured', 'root');
  assert.equal(profileDirectory(root, 'regular'), path.join(root, 'regular'));
  assert.equal(profileDirectory(root, 'private'), path.join(root, 'private'));
});
