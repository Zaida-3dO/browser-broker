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

import { createRequire } from 'node:module';

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
 * Spin until the shared instant arrives.
 *
 * **A spin rather than a sleep**, because the wait has to end at the same
 * moment in every process and a timer's resolution is the thing being
 * defended against. The spin is bounded by the barrier itself and runs for
 * however much of the lead time this child did not spend starting up.
 *
 * A child that arrives late does not wait, which is the failure mode the lead
 * time is generous to avoid — see `harness.ts`.
 */
export function waitForBarrier(startAtMs) {
  const startAt = Number(startAtMs);
  while (Date.now() < startAt) {
    /* the barrier: every process leaves here at one instant */
  }
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
