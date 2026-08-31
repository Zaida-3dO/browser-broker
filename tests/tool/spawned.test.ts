import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSONRPC_ERROR_CODES, JSONRPC_VERSION, PROTOCOL_VERSION } from '../../src/tool/protocol.ts';

/**
 * The spawned smoke subset: **a real process, a real session, a real pipe.**
 *
 * `MILESTONES.md`: "Run in process wherever the process boundary is not the
 * thing under test… Keep a smaller spawned smoke subset (a real process, a
 * real session, a real store) as its own job. The in-process matrix runs on
 * every change; the spawned subset proves the wiring and does not grow with
 * the case table."
 *
 * So this file is deliberately small and must stay small. What it proves is
 * the part the in-process matrix cannot: that the executable shim exists, is
 * runnable, speaks the framing over a real pipe, and — the lifecycle claim of
 * row #27 — **exits when its input ends**, with no port bound and nothing
 * left running.
 *
 * Do not add cases here. A case belongs in the case table, which costs
 * nothing per route; a case here costs a process spawn.
 */

const shim = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'bin',
  'broker-tool.ts',
);

interface Spawned {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/**
 * Spawn the shim, write the given lines, close the pipe, collect the result.
 *
 * **Each spawn gets its own store**, in a directory that does not exist until
 * the spawn creates it. The shim builds a real service, and a real service
 * opens a real store — so without this every run of this file would write
 * into whichever store the machine's configuration names, which on a
 * developer's machine is the one they are actually using.
 */
async function spawnSession(lines: readonly string[]): Promise<Spawned> {
  const root = mkdtempSync(path.join(tmpdir(), 'broker-spawned-'));
  try {
    return await new Promise<Spawned>((resolve, reject) => {
      const child = spawn(process.execPath, [shim], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          BROKER_DB: path.join(root, 'broker.db'),
          BROKER_ARTIFACTS_ROOT: path.join(root, 'artefacts'),
          BROKER_PROFILE_ROOT: path.join(root, 'profiles'),
        },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));

      for (const line of lines) {
        child.stdin.write(`${line}\n`);
      }
      // Closing the pipe is the caller going away. The session must end.
      child.stdin.end();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a SPAWNED session serves its caller and EXITS WHEN THE INPUT ENDS', async () => {
  // The lifecycle claim of row #27, proved across a real process boundary:
  // spawned by its caller, serves that session, exits with it. If the loop
  // waited for anything after standard input closed, this test would hang
  // rather than fail — which is why it is worth having as a spawned test and
  // not only as an in-process one.
  const result = await spawnSession([JSON.stringify({ id: 1, method: 'tools/list' })]);

  assert.equal(result.code, 0, `the session did not exit cleanly: ${result.err}`);

  const lines = result.out.trim().split('\n');
  assert.equal(lines.length, 1, 'a real session did not write exactly one line per message');

  const response = JSON.parse(lines[0] ?? '') as {
    id: number;
    result: { tools: { name: string }[] };
  };
  assert.equal(response.id, 1);
  // The twelve tools came back over a real pipe.
  assert.deepEqual(
    response.result.tools.map((tool) => tool.name),
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

test('a spawned session answers several messages in order, one line each', async () => {
  const result = await spawnSession([
    JSON.stringify({ id: 'a', method: 'tools/list' }),
    JSON.stringify({
      id: 'b',
      method: 'tools/call',
      params: { name: 'browser_status', arguments: { lease_key: 'a-key' } },
    }),
    JSON.stringify({ id: 'c', method: 'resources/read' }),
  ]);

  assert.equal(result.code, 0, result.err);
  const lines = result.out.trim().split('\n');
  assert.equal(lines.length, 3);

  const ids = lines.map((line) => (JSON.parse(line) as { id: string }).id);
  assert.deepEqual(ids, ['a', 'b', 'c'], 'responses did not correlate in order');

  // The middle one is a real call, and the key it carries names no lease in
  // this spawn's fresh store — so a rule refuses it, and that refusal arrives
  // as a RESULT, not as a protocol error, over the real wire.
  //
  // **The rule named is the point of the assertion.** `key.valid` is a rule
  // that only the arbitration core can produce: reaching it means the shim
  // built a service, opened a store, hashed the key and looked for a claim.
  // A shim that served a stand-in would refuse this same call — which is why
  // asserting only `outcome: refused` would pass either way — but it would
  // refuse it by a different rule, because it has no store to have looked in.
  const call = JSON.parse(lines[1] ?? '') as {
    result?: { outcome: string; rule: string };
    error?: unknown;
  };
  assert.equal(call.error, undefined, 'a refusal came back as a protocol error');
  assert.equal(call.result?.outcome, 'refused');
  assert.equal(
    call.result?.rule,
    'key.valid',
    'the spawned shim did not reach the arbitration core',
  );

  // The last one is an unknown method, which IS a protocol error — carrying
  // JSON-RPC's integer for the transport and this surface's own name beside
  // it for a caller that knows the taxonomy.
  const unknown = JSON.parse(lines[2] ?? '') as {
    error?: { code: number; data?: { code: string } };
  };
  assert.equal(unknown.error?.code, JSONRPC_ERROR_CODES.methodNotFound);
  assert.equal(unknown.error?.data?.code, 'method_not_found');
});

test('HUMAN TEXT NEVER REACHES THE PROTOCOL STREAM', async () => {
  // One stray line on standard output corrupts the framing for every message
  // after it, so the log stream is the error stream and standard output
  // carries nothing but messages.
  const result = await spawnSession([
    'not json at all',
    JSON.stringify({ id: 1, method: 'tools/list' }),
  ]);

  assert.equal(result.code, 0, result.err);
  for (const line of result.out.trim().split('\n')) {
    assert.doesNotThrow(
      () => JSON.parse(line),
      `standard output carried something that is not a message: ${line}`,
    );
  }
  // And the unanswerable line was reported rather than dropped in silence.
  assert.match(result.err, /not JSON/u);
});

test('A REAL CLIENT HANDSHAKE, END TO END, OVER THE PROCESS BOUNDARY', async () => {
  // This is the case the spawned subset exists for. `MILESTONES.md` reserves
  // spawning for where the process boundary is itself the thing under test,
  // and a client handshake is exactly that: what a client does is spawn this
  // file and speak to its pipes. Every part of the exchange below was
  // unreachable before — the surface answered `initialize` with
  // `method_not_found`, so a client hung up on its first message and the ten
  // tools behind it were never reached.
  //
  // The single change that breaks this test: deleting the `initialize` branch
  // in `handleRequest`. Deleting the `jsonrpc` key from the envelope breaks
  // it too, and so does answering the notification.
  const result = await spawnSession([
    JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'a-client', version: '1.0.0' },
      },
    }),
    JSON.stringify({ jsonrpc: JSONRPC_VERSION, method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: 2, method: 'tools/list' }),
    JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id: 3,
      method: 'tools/call',
      params: { name: 'browser_status', arguments: { lease_key: 'a-key' } },
    }),
  ]);

  assert.equal(result.code, 0, `the session did not exit cleanly: ${result.err}`);

  const lines = result.out.trim().split('\n');
  // **Four messages in, three out.** The notification is the one that draws
  // no response, and the count is what proves it — a surface that replied
  // would put four lines here and break a strict client.
  assert.equal(lines.length, 3, `expected three responses, got: ${result.out}`);

  const [initialize, listed, called] = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );

  // Every response carries the envelope, over a real pipe.
  for (const response of [initialize, listed, called]) {
    assert.equal(response?.['jsonrpc'], JSONRPC_VERSION, 'a real response carried no envelope');
  }
  assert.deepEqual(
    [initialize?.['id'], listed?.['id'], called?.['id']],
    [1, 2, 3],
    'responses did not correlate with their requests',
  );

  // The handshake itself.
  const handshake = initialize?.['result'] as {
    protocolVersion: string;
    capabilities: { tools?: unknown };
    serverInfo: { name: string; version: string };
  };
  assert.equal(handshake.protocolVersion, PROTOCOL_VERSION);
  assert.ok(handshake.capabilities.tools !== undefined, 'the server announced no tools capability');
  assert.equal(handshake.serverInfo.name, 'browser-broker');
  assert.equal(typeof handshake.serverInfo.version, 'string');

  // `tools/list` after the handshake: the ten, reached the way a client
  // reaches them.
  const tools = (listed?.['result'] as { tools: { name: string }[] }).tools;
  assert.equal(tools.length, 12);
  assert.ok(
    tools.some((tool) => tool.name === 'browser_status'),
    'the tool the next message calls was not listed',
  );

  // And a real call went all the way to the arbitration core. The key names
  // no lease in this spawn's fresh store, so a rule refuses it — and the rule
  // NAME is the assertion, because only the core can produce `key.valid`. A
  // shim serving a stand-in would refuse by some other rule.
  const call = called?.['result'] as { outcome: string; rule: string };
  assert.equal(called?.['error'], undefined, 'a refusal came back as a protocol error');
  assert.equal(call.outcome, 'refused');
  assert.equal(call.rule, 'key.valid', 'the handshaken session did not reach the arbitration core');
});

test('a client asking for an UNKNOWN protocol version is negotiated with, not dropped', async () => {
  // Version skew is the thing most likely to happen in the field, and a
  // handshake that crashed on it would fail on the next revision of the
  // specification rather than on anything wrong with the client.
  const result = await spawnSession([
    JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '3999-01-01', capabilities: {} },
    }),
  ]);

  assert.equal(result.code, 0, result.err);
  const response = JSON.parse(result.out.trim()) as {
    error?: { code: number };
    result?: { protocolVersion: string };
  };
  assert.equal(response.error, undefined, 'an unfamiliar version was refused rather than met');
  assert.equal(response.result?.protocolVersion, PROTOCOL_VERSION);
});
