import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

/** Spawn the shim, write the given lines, close the pipe, collect the result. */
async function spawnSession(lines: readonly string[]): Promise<Spawned> {
  return new Promise<Spawned>((resolve, reject) => {
    const child = spawn(process.execPath, [shim], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  // The ten tools came back over a real pipe.
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

  // The middle one is a real call. The service layer is not built, so it is
  // refused by name — and that refusal arrives as a RESULT, not as a protocol
  // error, over the real wire.
  const call = JSON.parse(lines[1] ?? '') as {
    result?: { outcome: string; rule: string };
    error?: unknown;
  };
  assert.equal(call.error, undefined, 'a refusal came back as a protocol error');
  assert.equal(call.result?.outcome, 'refused');
  assert.equal(call.result?.rule, 'service.not_built');

  // The last one is an unknown method, which IS a protocol error.
  const unknown = JSON.parse(lines[2] ?? '') as { error?: { code: string } };
  assert.equal(unknown.error?.code, 'method_not_found');
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
