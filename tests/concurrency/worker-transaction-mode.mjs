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
 */
db.pragma('busy_timeout = 5000');

waitForBarrier(startAtMs);

try {
  // The single word under test. `BEGIN IMMEDIATE` declares intent to write at
  // the moment it opens; `BEGIN DEFERRED` takes a read snapshot and discovers
  // at write time that it has lost the right to upgrade it.
  db.prepare(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED').run();

  const before = db.prepare('SELECT n FROM counter WHERE only_row = 1').get();

  // The read-then-write window, widened. Everything that makes this test able
  // to distinguish the two modes happens because other processes are inside
  // this same window at this same moment.
  const until = Date.now() + Number(widenMs);
  while (Date.now() < until) {
    /* holding the window open */
  }

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
  failed(error, { index: Number(index) });
} finally {
  db.close();
}
