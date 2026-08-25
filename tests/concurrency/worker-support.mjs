/**
 * What every contention worker needs: the barrier, the driver, and one line
 * of output.
 *
 * **Plain JavaScript rather than TypeScript, deliberately.** These files are
 * executed as spawned child processes, and the type-stripping the rest of the
 * suite relies on is a property of how the runner starts the *test* file.
 * Keeping the workers dependency-free at their entry point means a child is
 * started with nothing but a path — no loader flag to keep in step with the
 * Node version matrix, and nothing to go wrong differently on one row of it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * The driver, reached the way the application reaches it.
 *
 * A worker is not application code and does not go through `openStore`: the
 * transaction-mode control has to open a transaction the application would
 * never open, which is the entire point of a control.
 */
export const Database = require('better-sqlite3');

/**
 * Announce that this child is ready, then leave at the same moment as every
 * other child.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY READINESS IS SIGNALLED RATHER THAN PREDICTED
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A barrier could be a wall-clock instant alone: the parent picks
 * `now + lead`, and each child spins until it arrives. **A child that starts
 * up more slowly than the lead allows would then not wait at all** — it finds
 * the instant already past and goes straight into its transaction, on its
 * own, while its siblings are still starting. That failure is silent and it
 * fails **open**: it does not error, it just quietly removes contention.
 *
 * Measured on this repository, deferred failures out of 25, varying only that
 * lead time:
 *
 * | lead    | failures per run   |
 * |---------|--------------------|
 * | 4000 ms | 22, 23, 23, 23, 23 |
 * | 800 ms  | 23, 23, 22         |
 * | 400 ms  | 10, 7, 10          |
 * | 100 ms  | 8, 9, 4, 7         |
 * | 50 ms   | 4, 5, 6, 4         |
 *
 * The collapse from 23 to 4 is the control losing its meaning, and **every
 * one of those runs still satisfies `failed.length > 0`** — which is how a
 * hosted runner can report the control green on one run and red on the next.
 * A slower or busier machine is the same condition as a shorter lead: the
 * children spread out across the instant instead of meeting at it.
 *
 * So readiness is **signalled rather than assumed**. Each child writes a
 * file into the rendezvous directory once it is loaded, connected and holding
 * everything it needs, then waits for the parent to publish the release
 * instant — which the parent does only once every child has checked in. The
 * lead time stops being a guess about the slowest runner and becomes a
 * timeout on a condition that is actually observed.
 *
 * **The wait for release is still a spin**, for the original reason: the wait
 * has to end at the same moment in every process, and a timer's resolution is
 * the thing being defended against.
 *
 * `startAtMs` may also be a bare instant, which is what the workers that do
 * not need a strict rendezvous pass.
 */
export function waitForBarrier(startAtMs) {
  const rendezvous = process.env['BROKER_RENDEZVOUS_DIR'];
  if (rendezvous === undefined || rendezvous === '') {
    // No rendezvous configured: the plain deadline, unchanged.
    const startAt = Number(startAtMs);
    while (Date.now() < startAt) {
      /* the barrier: every process leaves here at one instant */
    }
    return;
  }

  const index = process.env['BROKER_RENDEZVOUS_INDEX'] ?? String(process.pid);

  // Check in. Written to a file per child rather than appended to one, so no
  // two children can interleave a partial write and be counted as one.
  writeFileSync(join(rendezvous, `ready-${index}`), '1');

  // Wait for the parent to publish the release instant. Polled rather than
  // spun, because this wait is unbounded-ish and burning a core here would
  // itself distort the startup it is waiting on.
  const releasePath = join(rendezvous, 'release');
  let releaseAt = null;
  const deadline = Date.now() + RENDEZVOUS_TIMEOUT_MS;
  while (releaseAt === null) {
    try {
      const text = readFileSync(releasePath, 'utf8').trim();
      if (text !== '') releaseAt = Number(text);
    } catch {
      /* not published yet */
    }
    if (releaseAt === null) {
      if (Date.now() > deadline) {
        // Loud rather than quiet. A child that gave up waiting would
        // contend alone and reduce the overlap invisibly, which is the exact
        // silent thinning the rendezvous exists to prevent.
        throw new Error(
          `rendezvous timed out after ${String(RENDEZVOUS_TIMEOUT_MS)}ms waiting for release; ` +
            'contention cannot be established, so this run must not report a result',
        );
      }
      sleepBriefly();
    }
  }

  // The final approach, spun so every process leaves at one instant.
  while (Date.now() < releaseAt) {
    /* the barrier: every process leaves here at one instant */
  }
}

/** How long a child waits to be released before refusing to run at all. */
const RENDEZVOUS_TIMEOUT_MS = 60000;

/**
 * A short sleep without a timer, usable from synchronous code.
 *
 * `Atomics.wait` blocks this thread without spinning, which is what the
 * check-in wait wants: a child burning a core while its siblings are still
 * starting up would slow down the very thing it is waiting for.
 */
function sleepBriefly() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}

/**
 * Report exactly one line of JSON and nothing else.
 *
 * The harness reads the last line, so a worker is free to be noisy on the
 * error stream without confusing its own result.
 */
export function report(outcome) {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

/** A committed child. */
export function succeeded(detail = {}) {
  report({ ok: true, code: null, message: null, detail });
}

/** A child whose transaction did not commit, carrying the driver's own code. */
export function failed(error, detail = {}) {
  report({
    ok: false,
    code: error?.code ?? null,
    message: String(error?.message ?? error),
    detail,
  });
}
