/**
 * One spawn against a store that may not exist yet, through the real entry
 * point.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS GOES THROUGH `prepareStore`, AND THAT IS THE WHOLE POINT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A worker that opened a connection and called `stepSchema` itself would be a
 * **reproduction**, not a test. The distinction is not pedantry — it was paid
 * for: an earlier attempt at this fix wrote `return immediate(...)` without
 * awaiting it, so the `finally` restored a suspended pragma *before the
 * transaction began*. A hand-rolled reproduction passed; only a caller that
 * came through the real entry point caught it.
 *
 * So this child does what a spawn does and nothing else: read the environment
 * the way the application reads it, call `prepareStore`, report. Every pragma,
 * every ordering decision and every `await` in the startup path is therefore
 * inside the measurement rather than restated around it.
 *
 * ── Why the child is plain JavaScript ───────────────────────────────────
 *
 * It is spawned as a child process, and the type-stripping the suite relies on
 * is a property of how the runner starts the *test* file. Keeping the entry
 * point dependency-free means the child starts with nothing but a path — no
 * loader flag to keep in step with the Node version matrix. It imports the
 * application's TypeScript, which the runtime strips on the way in.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readEnvironment } from '../../../src/config/environment.ts';
import { prepareStore } from '../../../src/store/open.ts';

const [, , startAtMs] = process.argv;

/**
 * Everything that is not the thing under test, done **before** the barrier.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS WHAT MAKES THE BARRIER ACTUALLY BITE, AND IT WAS MEASURED
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The collision window here is far narrower than an arbitration transaction's:
 * the loser only collides if it reads the version before the winner commits
 * step one, which is a couple of milliseconds on a fresh file. Anything a child
 * does *after* the barrier and *before* the version read is therefore jitter
 * subtracted directly from that window.
 *
 * With the environment read and the directory creation left after the barrier,
 * the defect reproduced in **2 runs of 3** — a test that would have gone green
 * on a third of runs with the bug fully present, and would have been called
 * flaky rather than believed. Hoisting them here made it 5 of 5.
 *
 * Note what is *not* hoisted: `prepareStore` itself, which opens the store,
 * sets the three pragmas and steps the schema. That whole call is the thing
 * being raced, so it stays whole and stays after the barrier. The child still
 * comes through the real entry point — a worker that inlined the open and
 * called the stepper itself would be a reproduction rather than a test, which
 * is the distinction that caught the unawaited-transaction bug.
 */
const environment = readEnvironment({ env: process.env });
fs.mkdirSync(path.dirname(environment.databasePath), { recursive: true });

/**
 * Spin until the shared instant arrives.
 *
 * **A spin rather than a sleep**, because the wait has to end at the same
 * moment in every process and a timer's resolution is the thing being defended
 * against. A child that arrives late does not wait at all, which is why the
 * lead time is generous rather than trimmed.
 */
const startAt = Number(startAtMs);
while (Date.now() < startAt) {
  /* the barrier: every process leaves here at one instant */
}

let store;
try {
  store = await prepareStore(environment);

  // What this child saw. A correct run has exactly one child reporting that it
  // applied steps and the rest reporting none — which is the §1.2d promise
  // ("a store already at the right version is left untouched") stated as an
  // observation rather than as a hope.
  const version = store.pragma('user_version');
  process.stdout.write(
    `${JSON.stringify({ ok: true, code: null, message: null, detail: { version } })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code: error?.code ?? null,
      message: String(error?.message ?? error),
      detail: {},
    })}\n`,
  );
} finally {
  store?.close();
}
