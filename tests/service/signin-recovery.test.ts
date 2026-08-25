import assert from 'node:assert/strict';
import test from 'node:test';

import type { Database } from 'better-sqlite3';

import {
  classifySignIn,
  livenessFromSignalError,
  processIsRunning,
  type ProcessLiveness,
} from '../../src/service/signin-recovery.ts';
import { SIGNABLE_BROWSER } from '../../src/service/operations/sign-in.ts';
import { CallRefusal } from '../../src/service/refusals.ts';
import { withBroker } from '../helpers/broker.ts';

/**
 * **A sign-in whose process is gone can be reclaimed** (`SCHEMA.md` §5.5.1).
 *
 * This is the half of the guarantee a signal handler cannot provide. `SIGKILL`
 * is not deliverable to a handler, a power cut runs nothing, and a crash in the
 * runtime runs nothing — so the tests here never send or simulate a signal.
 * They put the store in the state those deaths leave behind and ask whether the
 * product can get out of it.
 *
 * **The liveness question is injected**, because the alternative is a test that
 * spawns a real process, kills it, and hopes the identifier is not reused
 * before the assertion runs. That test would be flaky in the one direction that
 * matters — a reused identifier reads as *alive* and the reclaim silently does
 * not happen — and a flaky test of a recovery path is worse than none.
 */

/** Nothing is running. What a machine looks like after the owner died. */
const nothingRunning: ProcessLiveness = () => false;
/** Everything is running. What it looks like while a person is signing in. */
const everythingRunning: ProcessLiveness = () => true;

/** Put the browser into `signing-in` with a chosen owner, without a command. */
function strand(db: Database, ownerPid: number | null): void {
  db.prepare(`UPDATE browsers SET state = 'signing-in', signin_owner_pid = ? WHERE id = ?`).run(
    ownerPid,
    SIGNABLE_BROWSER,
  );
}

function readBrowser(db: Database): {
  state: string;
  signin_owner_pid: number | null;
} {
  return db
    .prepare('SELECT state, signin_owner_pid FROM browsers WHERE id = ?')
    .get(SIGNABLE_BROWSER) as { state: string; signin_owner_pid: number | null };
}

test('a sign-in whose owner is gone is classified as reclaimable', () => {
  assert.deepEqual(
    classifySignIn({ state: 'signing-in', signin_owner_pid: 4242 }, nothingRunning),
    { kind: 'owner-gone', pid: 4242 },
  );
});

test('a sign-in whose owner is RUNNING is not reclaimable', () => {
  assert.deepEqual(
    classifySignIn({ state: 'signing-in', signin_owner_pid: 4242 }, everythingRunning),
    { kind: 'owner-running', pid: 4242 },
  );
});

test('a sign-in with NO recorded owner is unknown, never reclaimable', () => {
  // A store written before the owner column existed. Reclaiming here would end
  // a live sign-in because an old build did not write down who started it.
  assert.deepEqual(
    classifySignIn({ state: 'signing-in', signin_owner_pid: null }, nothingRunning),
    {
      kind: 'owner-unknown',
    },
  );
});

test('a browser that is not signing in has nothing to recover', () => {
  for (const state of ['stopped', 'running', 'starting', 'failed']) {
    assert.deepEqual(classifySignIn({ state, signin_owner_pid: 4242 }, nothingRunning), {
      kind: 'not-signing-in',
    });
  }
});

test('the REAL liveness answer: this process is alive, and an unused identifier is not', () => {
  // Drives the shipped predicate rather than the injected one, so the seam
  // cannot be correct while the thing that ships is not.
  assert.equal(processIsRunning(process.pid), true, 'this very process must read as running');

  // A non-positive identifier is not a process. Zero and the negatives address
  // process *groups* on a POSIX system, so passing them through would ask a
  // different question and answer it confidently.
  assert.equal(processIsRunning(0), false, 'zero addresses a process group, not a process');
  assert.equal(processIsRunning(-1), false, 'a negative addresses a group, not a process');
  assert.equal(processIsRunning(1.5), false, 'a non-integer is not a process identifier');
});

test('A PERMISSION ERROR MEANS ALIVE, NEVER GONE', () => {
  // **The single most dangerous inference in this module**, and the one a real
  // process cannot be made to produce on demand: you cannot conjure an `EPERM`
  // from a process you own, so without this test the branch is unreachable and
  // a mutation flipping it survives the whole suite. It did, on the first
  // mutation run, which is why this test exists.
  //
  // Reading `EPERM` as gone would reclaim a browser out from under a sign-in
  // running perfectly well under another account — a live sign-in stolen, on
  // the strength of an error that says the opposite of what it was read as.
  assert.equal(
    livenessFromSignalError({ code: 'EPERM' }),
    true,
    'a process this user may not signal still exists',
  );

  // Only ESRCH — no such process — licenses the negative conclusion.
  assert.equal(livenessFromSignalError({ code: 'ESRCH' }), false);

  // Anything unrecognised takes the safe direction too.
  assert.equal(livenessFromSignalError({ code: 'EINVAL' }), true);
  assert.equal(livenessFromSignalError(new Error('no code at all')), true);
  assert.equal(livenessFromSignalError(undefined), true);
});

test('RECOVERY THROUGH THE SERVICE: a stranded sign-in is reclaimed, not refused forever', async () => {
  await withBroker(async ({ broker, store }) => {
    // The state a process that died without running anything leaves behind.
    strand(store.db, 999_999);
    assert.equal(readBrowser(store.db).state, 'signing-in');

    const began = await broker.begin_sign_in({
      browser: SIGNABLE_BROWSER,
      ownerPid: 1234,
      isRunning: nothingRunning,
    });

    assert.equal(began.state, 'signing-in');
    assert.equal(
      readBrowser(store.db).signin_owner_pid,
      1234,
      'the reclaimed sign-in should be owned by the process that took it',
    );
  });
});

test('A LIVE SIGN-IN IS NOT STOLEN: begin refuses while the owner is still running', async () => {
  await withBroker(async ({ broker, store }) => {
    strand(store.db, 999_999);

    await assert.rejects(
      () =>
        broker.begin_sign_in({
          browser: SIGNABLE_BROWSER,
          ownerPid: 1234,
          isRunning: everythingRunning,
        }),
      (error: unknown) => {
        assert.ok(error instanceof CallRefusal);
        assert.match(error.message, /still running/);
        return true;
      },
    );

    assert.equal(
      readBrowser(store.db).signin_owner_pid,
      999_999,
      'the live owner must be left exactly as it was',
    );
  });
});

test('AN UNKNOWN OWNER IS NOT RECLAIMED ON A GUESS', async () => {
  await withBroker(async ({ broker, store }) => {
    // No owner recorded — an older build's row.
    strand(store.db, null);

    await assert.rejects(
      () =>
        broker.begin_sign_in({
          browser: SIGNABLE_BROWSER,
          ownerPid: 1234,
          isRunning: nothingRunning,
        }),
      (error: unknown) => {
        assert.ok(error instanceof CallRefusal);
        assert.match(error.message, /does not say which process began it/);
        return true;
      },
    );

    assert.equal(readBrowser(store.db).state, 'signing-in', 'the row must be left alone');
  });
});

test('ending a sign-in clears its owner, so no stale identifier is left to be trusted', async () => {
  await withBroker(async ({ broker, store }) => {
    await broker.begin_sign_in({ browser: SIGNABLE_BROWSER, ownerPid: 5150 });
    assert.equal(readBrowser(store.db).signin_owner_pid, 5150);

    await broker.end_sign_in({ browser: SIGNABLE_BROWSER });

    const after = readBrowser(store.db);
    assert.notEqual(after.state, 'signing-in');
    assert.equal(after.signin_owner_pid, null, 'the owner must not outlive the sign-in');
  });
});

test('the reclamation is RECORDED, so it is legible afterwards rather than silent', async () => {
  await withBroker(async ({ broker, store }) => {
    strand(store.db, 999_999);

    await broker.begin_sign_in({
      browser: SIGNABLE_BROWSER,
      ownerPid: 1234,
      isRunning: nothingRunning,
    });

    const rows = store.db
      .prepare(
        `SELECT detail FROM events WHERE kind = 'browser_signin_ended' ORDER BY rowid DESC LIMIT 1`,
      )
      .all() as { detail: string }[];

    assert.equal(rows.length, 1, 'a reclamation should leave a ledger row');
    const detail = JSON.parse(rows[0]?.detail ?? '{}') as {
      reclaimed?: boolean;
      ownerPid?: number;
    };
    assert.equal(detail.reclaimed, true, 'and it should say that it was a reclamation');
    assert.equal(detail.ownerPid, 999_999, 'naming the process that had been holding it');
  });
});
