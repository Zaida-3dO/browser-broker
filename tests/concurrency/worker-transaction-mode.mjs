/**
 * One counter increment, in whichever transaction mode this child was told.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS WORKER IS ONE HALF OF A MATCHED PAIR AND MEANS NOTHING ALONE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `SCHEMA.md` §1.0a states the property the whole design rests on, and states
 * it as a measurement rather than as a belief:
 *
 * > 30 concurrent processes on an immediate transaction all succeeded, with
 * > no repeats and no lost writes. The same test on a deferred transaction
 * > with a widened read-then-write window failed 15 times in 25, with a
 * > busy-snapshot error **the busy-timeout setting cannot retry**.
 *
 * **Deferred passes at low contention**, and that is the trap this file
 * exists to spring. A suite that ran only the immediate case and went green
 * would not have shown that the immediate mode is what made it green — it
 * would be equally consistent with there never having been enough contention
 * to tell the two apart. The deferred run is therefore asserted to *fail*,
 * and if it ever stops failing the control has stopped controlling and the
 * suite must go red rather than quietly lose its meaning.
 *
 * ── The shape is the arbitration shape, in miniature ────────────────────
 *
 * Read a value, take a while over deciding, write a value derived from what
 * was read. That is a wide read-then-write window, which §1.0a calls "the
 * worst possible shape for the mode that fails" — and it is not a contrivance
 * for the test: the real arbitration transaction reads a capacity count and
 * writes a row derived from it, with a sweep in between.
 *
 * The widening is a spin rather than a sleep so the transaction stays open
 * and busy, which is what a real handler does. It is milliseconds, not
 * seconds: enough to overlap, bounded enough to keep the suite quick.
 */

import { Database, waitForBarrier, succeeded, failed } from './worker-support.mjs';

const [, , startAtMs, index, databasePath, mode, widenMs] = process.argv;

const db = new Database(databasePath);

/**
 * The same busy timeout the application sets.
 *
 * **Set on both arms of the control on purpose**, because it is what makes
 * the deferred failure meaningful: the error the deferred arm raises is not
 * one this setting can wait out. A control that dropped the timeout could be
 * dismissed as having simply not waited long enough.
 *
 * Reported to the caller as {@link BUSY_TIMEOUT_MS} so the assertion can
 * compare it against how long a failure actually took. See the report of
 * `waitedMs` below.
 */
const BUSY_TIMEOUT_MS = 5000;
db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

waitForBarrier(startAtMs);

// ── The clock starts here, at the barrier, not at the write ──────────────
//
// **It has to cover `BEGIN` as well as the upgrade, because the two modes
// block in different places.** An immediate transaction declares intent to
// write at the moment it opens, so a child queued behind a held lock waits
// inside `BEGIN` and never reaches the update at all. A deferred one opens
// instantly and discovers the problem later, at the upgrade.
//
// Measuring only the upgrade would report nothing at all for a
// genuinely-queued writer, because that child fails before it ever gets
// there — which is exactly what an earlier draft of this file did, and it
// left the assertion unable to tell a long wait from no wait. Measured on
// that draft: children queued behind a held lock reported no wait, while the
// same children under this clock report the full 5514ms.
const startedAt = Date.now();

/**
 * How much of the elapsed time this worker spent holding its own window open.
 *
 * Subtracted from the wait it reports, so the number stays a measurement of
 * how long the *engine* blocked rather than of how wide this test chose to
 * make its read-then-write window. Zero until the window has been held.
 */
let spentWidening = 0;

try {
  // The single word under test. `BEGIN IMMEDIATE` declares intent to write at
  // the moment it opens; `BEGIN DEFERRED` takes a read snapshot and discovers
  // at write time that it has lost the right to upgrade it.
  db.prepare(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED').run();

  const before = db.prepare('SELECT n FROM counter WHERE only_row = 1').get();

  // The read-then-write window, widened. Everything that makes this test able
  // to distinguish the two modes happens because other processes are inside
  // this same window at this same moment.
  const wideningFrom = Date.now();
  const until = wideningFrom + Number(widenMs);
  while (Date.now() < until) {
    /* holding the window open */
  }
  spentWidening = Date.now() - wideningFrom;

  db.prepare('UPDATE counter SET n = ? WHERE only_row = 1').run(before.n + 1);
  db.prepare('COMMIT').run();

  // What this child read is reported so the caller can assert the stronger
  // property: not merely that the total is right, but that no two children
  // ever read the same value. A lost update shows up as a repeat.
  succeeded({ index: Number(index), read: before.n });
} catch (error) {
  try {
    db.prepare('ROLLBACK').run();
  } catch {
    // A transaction the engine already aborted cannot be rolled back, and
    // saying so would replace the useful error with a meaningless one.
  }
  // ── How long the engine actually blocked this child ────────────────────
  //
  // Everything since the barrier, **less the window this worker deliberately
  // held open itself**. Subtracting the spin is what keeps the number a
  // measurement of the busy timeout rather than of the test's own widening:
  // without it, raising `widenMs` would inflate every wait and could push a
  // run past the assertion's ceiling for a reason that is not about the
  // store at all.
  //
  // Clamped at zero because the subtraction is of two independently-read
  // clocks and a few milliseconds of skew must not produce a negative.
  failed(error, {
    index: Number(index),
    waitedMs: Math.max(0, Date.now() - startedAt - spentWidening),
    busyTimeoutMs: BUSY_TIMEOUT_MS,
  });
} finally {
  db.close();
}
