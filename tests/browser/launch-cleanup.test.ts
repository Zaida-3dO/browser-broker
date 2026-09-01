import assert from 'node:assert/strict';
import type { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PORT_FILE_NAME } from '../../src/browser/discovery.ts';
import { coldStartDetached, LAUNCH_RULES } from '../../src/browser/launch.ts';
import { StartupRefusal } from '../../src/errors.ts';

/**
 * ── The leak these tests exist for ──────────────────────────────────────
 *
 * Measured, 2026-08-28: **1,637 browser processes across 164 launches**, and
 * a machine that stopped responding. A detached spawn whose endpoint never
 * answered was thrown away without being ended, and a detached browser
 * survives the process that spawned it **by design** — that is the measured
 * property the whole module is built on — so every failed launch left one
 * behind and nothing ever reaped it.
 *
 * **Nothing here starts a real browser, and that is the point rather than a
 * shortcut.** The defect *is* a surviving process, so a test that spawned a
 * real browser to prove it gets ended would leak one every time it failed,
 * reproducing the incident inside the suite meant to guard against it. The
 * launch is driven through the injected spawn and kill seams instead, which
 * also buys the assertion that actually matters: **which identifier was
 * signalled**. A test that merely counted kills could not tell *ending our
 * own failed launch* from *ending somebody else's browser*, and those two are
 * the entire difference between the fix and a much worse bug.
 *
 * The readiness bound is injected too, so these run in milliseconds rather
 * than waiting out a real timeout.
 */

interface StubChild {
  readonly pid: number | undefined;
  once: (event: string, listener: (error: Error) => void) => unknown;
  unref: () => void;
}

/** A child that never emits: a process that started fine and never answered. */
function stubChild(pid: number | undefined): StubChild {
  return {
    pid,
    // Never fires. This stands in for a browser process that started
    // perfectly well and simply never opened an endpoint — the incident case,
    // and the one where nothing else reports a failure.
    once: () => undefined,
    unref: () => undefined,
  };
}

/** A stub child as the spawn seam's type, kept in one place. */
function spawningStub(build: () => StubChild): typeof spawn {
  return build as unknown as typeof spawn;
}

// The mutation this catches: deleting the `killSpawnedProcess` call on the
// readiness-timeout path. The refusal is still raised and still worded
// identically — which is exactly why the incident went unnoticed for two days
// — but the process stays alive, `killed` stays empty, and this fails.
test('a launch whose endpoint NEVER answers ends the process it spawned, rather than leaking it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-never-answers-'));
  const killed: number[] = [];
  const spawnedPid = 4242;

  try {
    await assert.rejects(
      async () =>
        await coldStartDetached(
          {
            profileDirectory: path.join(root, 'regular'),
            mode: 'headless',
            executablePath: path.join(root, 'a-browser'),
          },
          {
            // Short and injected, so this is a real readiness timeout rather
            // than a sleep pretending to be one: the loop runs, polls, finds
            // no record, and exhausts its bound exactly as it would after the
            // production thirty seconds.
            readinessTimeoutMs: 50,
            pollIntervalMs: 10,
            spawnImpl: spawningStub(() => stubChild(spawnedPid)),
            killImpl: (pid: number) => {
              killed.push(pid);
            },
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal, 'it still refuses');
        assert.equal(
          error.rule,
          LAUNCH_RULES.explicitProfileDir,
          'and the refusal is unchanged by the cleanup',
        );
        return true;
      },
    );

    // The claim. A process that never became a browser is reachable by
    // nothing else: no reference is held, no row names it, and the sweep
    // reconciles claims and tabs rather than orphaned processes.
    assert.deepEqual(
      killed,
      [spawnedPid],
      'the process this call spawned must be ended, by its own identifier',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The mutation this catches: widening the collision branch's kill from the
// identifier this call spawned to anything derived from the profile
// directory or the answering record — the single most damaging change that
// could be made to this file. It would read as equivalent, and it would
// destroy another caller's browser: quite possibly the signed-in one whose
// keeper tab exists to hold the shared sign-in open.
//
// The two identifiers are deliberately different values here (4242 spawned,
// 9222 answering), so a kill aimed at the wrong one is a failing assertion
// rather than a coincidence that passes.
test('the profile-collision refusal ends the SPAWNED process, and never the browser that answered', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-collision-'));
  const profile = path.join(root, 'regular');
  const killed: number[] = [];
  const browserUuid = 'the-browser-that-was-already-running';

  try {
    // A browser is already running against this profile and has left its
    // record. That record is read as `previous`, so the endpoint answering
    // below is recognised as the pre-existing browser rather than a new one.
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(
      path.join(profile, PORT_FILE_NAME),
      `9222\n/devtools/browser/${browserUuid}\n`,
      'utf8',
    );

    await assert.rejects(
      async () =>
        await coldStartDetached(
          {
            profileDirectory: profile,
            mode: 'headless',
            executablePath: path.join(root, 'a-browser'),
          },
          {
            readinessTimeoutMs: 500,
            pollIntervalMs: 10,
            // The pre-existing browser answers, healthily, and identifies
            // itself as the browser the record already described. That match
            // is what makes this a collision rather than a successful launch.
            fetchImpl: (() =>
              Promise.resolve(
                new Response(
                  JSON.stringify({
                    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/browser/${browserUuid}`,
                  }),
                  { status: 200 },
                ),
              )) as unknown as typeof fetch,
            spawnImpl: spawningStub(() => stubChild(4242)),
            killImpl: (pid: number) => {
              killed.push(pid);
            },
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal, 'it refuses the collision');
        assert.equal(error.rule, LAUNCH_RULES.explicitProfileDir);
        assert.match(
          error.message,
          /already running against this profile directory/u,
          'and says a browser is already there, rather than reporting a launch',
        );
        return true;
      },
    );

    // The whole point of the row, and it is two claims, not one.
    //
    // First: the process this call spawned IS ended. Measured on Windows it
    // does not exit on its own, and nothing else reaps it — no row names it
    // and the sweep reconciles claims and tabs rather than orphaned
    // processes.
    assert.deepEqual(
      killed,
      [4242],
      'the losing spawn must be ended, by the identifier this call spawned',
    );

    // Second, and this is the one that must never regress: the browser
    // behind the answering endpoint is somebody else's, and nothing signals
    // it. 9222 is that browser's port; it must appear nowhere in `killed`.
    assert.ok(
      !killed.includes(9222),
      'the browser already holding the profile must never be signalled',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The mutation this catches: letting the cleanup throw — dropping the
// try/catch inside `killSpawnedProcess`, or signalling directly instead of
// going through it. A refusal that explains what went wrong would be replaced
// by whatever the cleanup threw, and on the incident path that refusal is the
// only thing the caller ever sees.
test('a kill that fails does not turn a clean refusal into a crash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-kill-fails-'));

  try {
    await assert.rejects(
      async () =>
        await coldStartDetached(
          {
            profileDirectory: path.join(root, 'regular'),
            mode: 'headless',
            executablePath: path.join(root, 'a-browser'),
          },
          {
            readinessTimeoutMs: 50,
            pollIntervalMs: 10,
            spawnImpl: spawningStub(() => stubChild(4242)),
            killImpl: () => {
              // Every ordinary reason a kill fails here: the process exited on
              // its own between the check and the signal, or the operating
              // system will not let this process signal it. Neither is news
              // the caller can act on, and neither is worse than the refusal
              // already being raised.
              throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
            },
          },
        ),
      (error: unknown) => {
        // The original refusal, not the cleanup's error.
        assert.ok(error instanceof StartupRefusal, 'the refusal survives its own cleanup');
        assert.equal(error.rule, LAUNCH_RULES.explicitProfileDir);
        assert.match(
          error.message,
          /no debugging endpoint of its own ever answered/u,
          'with its message intact, rather than an EPERM raised by the kill',
        );
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The first row of the kill-condition table: no identifier means no process,
// so there is nothing to end.
//
// **This one is honest about being weaker than the others.** The refusal
// happens before the readiness loop starts, so the cleanup is never reached
// on this path and the "nothing was killed" assertion cannot fail while that
// remains true — it is pinning the shape rather than catching a mutation.
// What actually enforces this row is the type: `killSpawnedProcess` takes a
// `number`, so a future caller that tried to signal an absent identifier
// would not compile. The mutation this *does* catch is the refusal moving or
// changing rule, which is what would let a launch with no identifier proceed
// into the loop in the first place.
test('a spawn that produced no identifier refuses cleanly, with nothing to kill', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-no-pid-'));
  const killed: number[] = [];

  try {
    await assert.rejects(
      async () =>
        await coldStartDetached(
          {
            profileDirectory: path.join(root, 'regular'),
            mode: 'headless',
            executablePath: path.join(root, 'a-browser'),
          },
          {
            readinessTimeoutMs: 50,
            pollIntervalMs: 10,
            spawnImpl: spawningStub(() => stubChild(undefined)),
            killImpl: (pid: number) => {
              killed.push(pid);
            },
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal);
        assert.equal(error.rule, LAUNCH_RULES.detached);
        return true;
      },
    );

    assert.deepEqual(killed, [], 'there is no process, so there is nothing to signal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The remaining row of the table: a spawn failure observed by the **post-loop
// check** rather than by the race inside the loop.
//
// The mutation this catches: deleting the `killSpawnedProcess` call in the
// post-loop `spawnFailure` branch. That deletion passes every other assertion
// in this file, which is how it was found — by mutating it and watching
// nothing fail.
//
// ── Why this is driven by an exhausted bound and not by a delay ──────────
//
// The obvious construction is to have the failure arrive *later* than the
// bound. **Measured, and it is a coin toss:** sweeping the arrival time
// across the bound, the refusal alternated between the two branches with no
// stable ordering, because whether the final poll's race or the post-loop
// check observes the rejection first comes down to scheduling jitter. A test
// built that way would pass on the machine it was written on and flake
// elsewhere, while claiming to pin a specific branch.
//
// A bound of zero removes the race from the picture entirely: the deadline
// has already passed when the loop is reached, so the loop body never runs
// and the post-loop check is the **only** thing that can observe the failure.
// Deterministic by construction rather than by timing.
test('a spawn failure observed by the post-loop check still ends the process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-post-loop-failure-'));
  const killed: number[] = [];
  const spawnedPid = 909;

  try {
    await assert.rejects(
      async () =>
        await coldStartDetached(
          {
            profileDirectory: path.join(root, 'regular'),
            mode: 'headless',
            executablePath: path.join(root, 'a-browser'),
          },
          {
            // Already expired, so the readiness loop never executes a poll.
            readinessTimeoutMs: 0,
            pollIntervalMs: 5,
            spawnImpl: spawningStub(() => ({
              ...stubChild(spawnedPid),
              // Reported immediately, so the failure is recorded before the
              // post-loop check reads it. An identifier was still assigned —
              // the measured shape of an asynchronous spawn failure — so a
              // process may exist under it.
              once: (event: string, listener: (error: Error) => void) => {
                if (event === 'error') {
                  listener(new Error('spawn ENOENT'));
                }
                return undefined;
              },
            })),
            killImpl: (pid: number) => {
              killed.push(pid);
            },
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal);
        assert.equal(
          error.rule,
          LAUNCH_RULES.detached,
          'it leaves by the spawn-failure branch, which is the branch under test',
        );
        return true;
      },
    );

    assert.deepEqual(
      killed,
      [spawnedPid],
      'an identifier was assigned before the failure arrived, so a process may exist under it',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The mutation this catches: cleaning up only the two written `throw` sites
// and missing the rejection that escapes from the `Promise.race`. That is the
// path a machine with a broken or missing browser binary takes on EVERY
// launch — the race exists precisely so such a failure is reported at once
// rather than after the full readiness timeout — so missing it would leave
// the most frequently-taken failure path still leaking.
test('a spawn failure reported DURING the readiness wait still ends the process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-late-spawn-failure-'));
  const killed: number[] = [];
  const spawnedPid = 777;

  try {
    await assert.rejects(
      async () =>
        await coldStartDetached(
          {
            profileDirectory: path.join(root, 'regular'),
            mode: 'headless',
            executablePath: path.join(root, 'a-browser'),
          },
          {
            // Long, deliberately. If the cleanup lived only on the post-loop
            // check, this test would have to wait the whole bound out to see
            // a kill. It does not, because the race reports at once — which
            // is what makes this a distinct path rather than a slower one.
            readinessTimeoutMs: 10_000,
            pollIntervalMs: 10,
            spawnImpl: spawningStub(() => ({
              ...stubChild(spawnedPid),
              // An identifier is assigned and the failure arrives a moment
              // later, which is the measured shape of an asynchronous spawn
              // failure — so a process may well exist under that identifier.
              once: (event: string, listener: (error: Error) => void) => {
                if (event === 'error') {
                  setTimeout(() => {
                    listener(new Error('spawn ENOENT'));
                  }, 5);
                }
                return undefined;
              },
            })),
            killImpl: (pid: number) => {
              killed.push(pid);
            },
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal);
        assert.equal(error.rule, LAUNCH_RULES.detached, 'it refuses by the launch rule');
        return true;
      },
    );

    assert.deepEqual(
      killed,
      [spawnedPid],
      'the identifier the spawn returned must be ended on the early-report path too',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
