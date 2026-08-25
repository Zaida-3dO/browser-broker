import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { contend } from './harness.ts';
import { withCounterStore } from './stores.ts';

/**
 * The measurement `SCHEMA.md` §1.0a rests on, reproduced as a matched pair.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **Proves:** that on this machine, with real operating-system processes
 * contending over one store file, an immediate transaction serialises the
 * writers and a deferred one with the same widened read-then-write window
 * does not — failing with an error the busy timeout cannot retry.
 *
 * **Does not prove:** that the application's own paths use the immediate
 * mode. That is a source fact, and `scripts/check-arbitration.mjs` is what
 * checks it. Neither substitutes for the other and the check's own header
 * says so: source scanning cannot show that the mode is what makes
 * concurrency safe, and this file cannot show that every path takes it.
 * `arbitration.test.ts` in this directory is what ties the two together by
 * driving the real arbitration path under the same contention.
 *
 * ── Why the deferred arm is asserted to fail ────────────────────────────
 *
 * Because **deferred passes at low contention**. An immediate-only suite that
 * went green would be equally consistent with the mode mattering and with
 * there never having been enough contention to tell. The failing arm is what
 * makes the passing arm mean something, so it is asserted rather than
 * observed — and its assertion message says outright that a green deferred
 * run is a broken control rather than good news.
 */

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

/**
 * How many processes each arm starts.
 *
 * §1.0a's own numbers, kept rather than trimmed: thirty for the immediate
 * arm, twenty-five for the deferred one. They are what was measured, so a
 * later reader comparing this suite against the specification is comparing
 * the same experiment.
 */
const IMMEDIATE_PROCESSES = 30;
const DEFERRED_PROCESSES = 25;

/**
 * How long each child holds its read-then-write window open, in milliseconds.
 *
 * Small on purpose. The window only has to be wide enough that the children
 * overlap, and the start barrier is what actually delivers the overlap — this
 * number is the belt to the barrier's braces. Making it large would slow
 * every run to buy contention the barrier has already bought.
 */
const WIDEN_MS = 5;

test('thirty processes on an immediate transaction all commit, and none reads a value another read', async () => {
  await withCounterStore(async (databasePath) => {
    const run = await contend({
      worker: 'worker-transaction-mode.mjs',
      processes: IMMEDIATE_PROCESSES,
      argv: [databasePath, 'immediate', String(WIDEN_MS)],
    });

    assert.equal(
      run.failed.length,
      0,
      `Every process using an immediate transaction is expected to commit. ${String(run.failed.length)} did not: ${JSON.stringify(run.codes)}. The first said: ${String(run.failed[0]?.message)}`,
    );

    // The counter is read on a **second, read-only connection**, opened after
    // every child has exited. Reading through a handle that took part in the
    // contention would be reading a connection's own view rather than what
    // committed, which is the house rule a mutation sweep caught a test
    // breaking.
    const reader = new Database(databasePath, { readonly: true });
    const final = reader.prepare('SELECT n FROM counter WHERE only_row = 1').get() as { n: number };
    reader.close();

    assert.equal(
      final.n,
      IMMEDIATE_PROCESSES,
      `The counter must have been incremented once per process. Each of the ${String(IMMEDIATE_PROCESSES)} committed, so a lower total is a lost update — a write that reported success and was overwritten by a process that read the same value.`,
    );

    // The stronger property, and the one a total alone cannot show: no two
    // processes read the same value. A pair that did would each have written
    // the same increment, and one of the two writes is lost — which a total
    // catches only because nothing else went wrong on that run.
    const read = run.succeeded.map((outcome) => outcome.detail['read'] as number);
    assert.equal(
      new Set(read).size,
      read.length,
      `No two processes may read the same counter value: a repeat is a lost update. The values read were ${JSON.stringify([...read].sort((a, b) => a - b))}.`,
    );
    assert.deepEqual(
      [...read].sort((a, b) => a - b),
      Array.from({ length: IMMEDIATE_PROCESSES }, (_unused, index) => index),
      'The values read must be exactly zero through one less than the process count, with no repeats and no gaps.',
    );
  });
});

test('the deferred control fails, which is what makes the immediate result mean anything', async () => {
  await withCounterStore(async (databasePath) => {
    const run = await contend({
      worker: 'worker-transaction-mode.mjs',
      processes: DEFERRED_PROCESSES,
      argv: [databasePath, 'deferred', String(WIDEN_MS)],
    });

    // ── The assertion this whole file exists for ────────────────────────
    //
    // If this fails because nothing failed, **the control has stopped
    // controlling**: either the contention is not real (most likely the start
    // barrier in `harness.ts` fails to line the children up) or the store's
    // configuration differs from what this assumes. Either way the immediate
    // arm above is quietly not evidence of anything, because it lacks a case
    // that fails to be compared against.
    //
    // Do not "fix" this by relaxing it to allow zero failures. The correct
    // repair is to restore the contention.
    assert.ok(
      run.failed.length > 0,
      `THE FAILING CONTROL PASSED, WHICH MEANS THIS SUITE HAS STOPPED PROVING ANYTHING. ` +
        `All ${String(DEFERRED_PROCESSES)} deferred processes committed. A deferred transaction with a widened ` +
        `read-then-write window is expected to fail under real contention; it passes at low contention, so a green ` +
        `run here says the processes did not actually overlap rather than that deferred is safe. The immediate ` +
        `assertion above is only evidence while this one fails. Restore the contention — check the start barrier ` +
        `in harness.ts — rather than relaxing this assertion.`,
    );

    // And it fails the specific way §1.0a describes: a busy-snapshot error,
    // which the busy timeout cannot retry because the transaction holds a
    // read snapshot it has lost the right to upgrade. There is nothing to
    // wait for, so waiting longer would not help.
    //
    // Both codes are accepted because both are the same defect: under this
    // much contention some children lose the snapshot they held and others
    // never acquire the lock within the timeout. `SQLITE_BUSY_SNAPSHOT` is
    // the one that cannot be retried and is dominant in every measured run;
    // requiring it exclusively would make the test flaky for a reason that
    // is not about the property.
    const busy = (run.codes['SQLITE_BUSY_SNAPSHOT'] ?? 0) + (run.codes['SQLITE_BUSY'] ?? 0);
    assert.equal(
      busy,
      run.failed.length,
      `Every deferred failure must be a busy or busy-snapshot error rather than something incidental. Codes seen: ${JSON.stringify(run.codes)}.`,
    );
    assert.ok(
      (run.codes['SQLITE_BUSY_SNAPSHOT'] ?? 0) > 0,
      `At least one process must fail with the busy-snapshot error specifically — the one the busy timeout cannot retry. Codes seen: ${JSON.stringify(run.codes)}.`,
    );

    // The lost writes are real and observable: the counter is short by
    // exactly the processes that failed. Read on a second connection.
    const reader = new Database(databasePath, { readonly: true });
    const final = reader.prepare('SELECT n FROM counter WHERE only_row = 1').get() as { n: number };
    reader.close();

    assert.equal(
      final.n,
      run.succeeded.length,
      'The counter must reflect exactly the processes that committed, so the failures are visible as work that did not happen rather than as work silently lost.',
    );
    assert.ok(
      final.n < DEFERRED_PROCESSES,
      'The deferred run must leave the counter short of the process count; a full count would mean nothing actually failed.',
    );
  });
});
