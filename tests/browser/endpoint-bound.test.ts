import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

/**
 * The endpoint bound, asserted **under a drained event loop** — which is the
 * only place it can be asserted at all.
 *
 * ── Why this suite exists as a separate file, and as a child process ────
 *
 * `discovery.test.ts` already bounds the same request. It is a real test and
 * it kills a signal that can never fire. **It still cannot express this
 * property**, and the reason is worth stating in full because it is a shape
 * that is easy to build by accident:
 *
 * > **The test harness supplies the very condition the production path is
 * > missing.** That suite bounds itself with a `Promise.race` against a
 * > `setTimeout`, and that arm is **ref'd** — it keeps the event loop alive.
 * > An unref'd abort timer fires perfectly well while something else is
 * > holding the loop open, so the assertion passes for a reason that does not
 * > exist in production.
 *
 * The failure it hides is not a hang. It is the opposite and it is worse: the
 * process **exits, silently, reporting success**, without ever concluding
 * that the endpoint was unreachable. `AbortSignal.timeout` creates an
 * **unref'd** timer, and this service is a short-lived spawn whose only
 * outstanding work, on the adopt path, is exactly this request.
 *
 * So the assertion has to be made where nothing else is keeping the process
 * alive — which cannot be arranged inside a test runner, because a test
 * runner is itself outstanding ref'd work. Hence a **child process** that
 * awaits the real function and nothing else, and whose exit code is the
 * assertion.
 *
 * ── What a green run here means ────────────────────────────────────────
 *
 * That the bound is enforced by something capable of keeping the process
 * alive until it fires. It does not certify anything about how long the bound
 * is, and it says nothing about the launch-readiness gap (§1.2b), which is
 * row #55's and is a different quantity.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISCOVERY = path.resolve(HERE, '..', '..', 'src', 'browser', 'discovery.ts');

/**
 * The probe, written to disk and run as its own process.
 *
 * It imports the **real** `verifyDiscoveryRecord` and hands it a fetch that
 * settles only on abort — a port that accepts a connection and never replies.
 * Nothing else ref'd is outstanding, which is the whole point.
 *
 * The exit codes are the assertion:
 * - `0` — concluded `endpoint_unreachable`. The bound held.
 * - `20` — the process reached the end of its work without concluding, which
 *   is the silent-early-exit defect.
 * - `21` — it concluded, but with something other than the expected refusal.
 */
function probeSource(discoveryPath: string): string {
  // A `file://` URL, not a bare path: an absolute Windows path is not a valid
  // module specifier, and the loader rejects it as an unknown scheme.
  const specifier = JSON.stringify(pathToFileURL(discoveryPath).href);
  return `
import { verifyDiscoveryRecord } from ${specifier};

// Accepts, never answers. The only thing that can settle this is the bound.
const neverAnswers = ((_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new Error('aborted'));
    });
  }));

let concluded = false;

// If the loop drains before the bound fires, this is the last thing that runs
// — so the silent exit becomes a loud, specific exit code.
process.on('exit', () => {
  if (!concluded) {
    process.exitCode = 20;
  }
});

const outcome = await verifyDiscoveryRecord(
  { endpoint: 'http://127.0.0.1:1' },
  'expected',
  { fetchImpl: neverAnswers, timeoutMs: 50 },
);

concluded = true;
process.exitCode = outcome.ok === false && outcome.failure === 'endpoint_unreachable' ? 0 : 21;
`;
}

function runProbe(): { status: number | null; stderr: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-bound-'));
  const probe = path.join(directory, 'probe.mjs');
  try {
    fs.writeFileSync(probe, probeSource(DISCOVERY));
    const result = spawnSync(process.execPath, [probe], {
      encoding: 'utf8',
      // Generous, because it bounds the *test*, not the thing under test: the
      // probe's own bound is 50ms, so anything approaching this means the
      // process genuinely wedged rather than answering slowly.
      timeout: 30_000,
    });
    return { status: result.status, stderr: result.stderr };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// The mutation this catches: delete the ref'd timer and bound the request with
// `AbortSignal.timeout(timeoutMs)` instead. The probe then exits 20 — it
// reached the end of its work without concluding — because an unref'd timer
// cannot keep the process alive long enough to fire.
//
// Verified both ways while writing this: with `AbortSignal.timeout` the probe
// exits without concluding; with the ref'd timer it concludes
// `endpoint_unreachable`. Nothing else about the call differs.
test('the endpoint bound concludes even when the request is the ONLY outstanding work', () => {
  const { status, stderr } = runProbe();

  assert.notEqual(
    status,
    20,
    `The process exited without concluding, so the endpoint bound is not enforced by anything capable of keeping the event loop alive. This is the silent early exit: a caller verifying a record, with no other outstanding work, exits reporting success instead of reporting that the endpoint was unreachable.\n${stderr}`,
  );
  assert.notEqual(status, 21, `The bound fired but produced the wrong outcome.\n${stderr}`);
  assert.equal(status, 0, `The probe failed unexpectedly.\n${stderr}`);
});

// A bound that is never cleared is the opposite failure, and it is the one a
// naive fix introduces: an ordinary `setTimeout` keeps the process alive until
// it fires, so a request that answered immediately would still hold the
// process open for the rest of the window.
//
// The mutation this catches: dropping the `clearTimeout` from the `finally`.
// The probe below answers at once, so with the bound uncleared it would sit
// for the full five seconds rather than exiting promptly.
test('a request that answers promptly does not hold the process open for its bound', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-bound-'));
  const probe = path.join(directory, 'probe.mjs');
  const specifier = JSON.stringify(pathToFileURL(DISCOVERY).href);

  try {
    fs.writeFileSync(
      probe,
      `
import { verifyDiscoveryRecord } from ${specifier};

const answersAtOnce = (() =>
  Promise.resolve(
    new Response(
      JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/expected' }),
      { status: 200 },
    ),
  ));

const started = Date.now();
const outcome = await verifyDiscoveryRecord(
  { endpoint: 'http://127.0.0.1:1' },
  'expected',
  { fetchImpl: answersAtOnce, timeoutMs: 5000 },
);

// Reported rather than asserted here, so the parent decides what is too slow.
process.stdout.write(String(Date.now() - started));
process.exitCode = outcome.ok ? 0 : 22;
`,
    );

    const started = Date.now();
    const result = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30_000 });
    const elapsed = Date.now() - started;

    assert.equal(result.status, 0, `The probe did not verify successfully.\n${result.stderr}`);
    assert.ok(
      elapsed < 4000,
      `A prompt answer must not keep the process alive for its bound; the process took ${String(elapsed)}ms against a 5000ms bound, so the timer was left uncleared.`,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
