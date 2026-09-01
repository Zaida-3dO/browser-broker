import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  decideAdoption,
  recordLaunched,
  recordLaunchFailed,
  type AdoptionDecision,
} from '../../src/browser/adoption.ts';
import { withSteppedStore } from '../helpers/temp-store.ts';

/**
 * The launch race: one row, one winner.
 *
 * ── Why a second connection reads the store here ────────────────────────
 *
 * `CLAUDE.md` records the failure this avoids: a check that reads through the
 * store's own handle sees **uncommitted** writes, so a test asserting what
 * actually committed can pass while the violation is present. Where these
 * tests assert on what landed in the store, they open a **second, read-only
 * connection** and read through that.
 */

/** Read a browser row through a connection this test opened, not the store's. */
function readBrowserRow(
  location: string,
  browser: string,
): { state: string; endpoint: string | null; browser_uuid: string | null; pid: number | null } {
  const db = new Database(location, { readonly: true });
  try {
    const row = db
      .prepare<
        [string],
        { state: string; endpoint: string | null; browser_uuid: string | null; pid: number | null }
      >('SELECT state, endpoint, browser_uuid, pid FROM browsers WHERE id = ?')
      .get(browser);
    assert.ok(row, 'the browser row must exist');
    return row;
  } finally {
    db.close();
  }
}

const RUNNING = { endpoint: 'http://127.0.0.1:9999', browserUuid: 'a-live-browser' };

test('a caller that finds nothing running wins the race and is told to launch', async () => {
  await withSteppedStore(async (store) => {
    const decision = await decideAdoption(store, 'regular', undefined);
    assert.equal(decision.action, 'launch');
  });
});

// THE property of this row, and the one a second mechanism would break: two
// callers arriving at an empty machine at the same instant must produce ONE
// launch, not two. A second launch is two browsers against one profile
// directory, which was measured to fail silently — the second hands its
// address to the first, opening no endpoint of its own.
//
// The mutation this catches: not writing `starting` inside the transaction,
// or reading the state without writing it. Either makes both callers win.
test('two callers racing on an empty machine produce exactly one launch — the loser waits', async () => {
  await withSteppedStore(async (store) => {
    const first = await decideAdoption(store, 'regular', undefined);
    const second = await decideAdoption(store, 'regular', undefined);

    assert.equal(first.action, 'launch');
    assert.equal(second.action, 'wait');

    const launches = [first, second].filter((d) => d.action === 'launch');
    assert.equal(launches.length, 1, 'exactly one caller may launch');
  });
});

// The mutation this catches: leaving the row alone when a caller wins. The
// claim on the race has to be visible to the *next* transaction, and reading
// it back on a separate connection is what proves it committed rather than
// merely having been written in a transaction that is still open.
test('winning the race commits the starting state, visible to another connection', async () => {
  await withSteppedStore(async (store) => {
    await decideAdoption(store, 'regular', undefined);
    const row = readBrowserRow(store.location, 'regular');
    assert.equal(row.state, 'starting');
  });
});

test('a caller that observes a live browser is told to attach, and the record is written', async () => {
  await withSteppedStore(async (store) => {
    const decision = await decideAdoption(store, 'regular', RUNNING);
    assert.equal(decision.action, 'attach');
    assert.equal(decision.action === 'attach' && decision.endpoint, RUNNING.endpoint);

    const row = readBrowserRow(store.location, 'regular');
    assert.equal(row.state, 'running');
    assert.equal(row.endpoint, RUNNING.endpoint);
    assert.equal(row.browser_uuid, RUNNING.browserUuid);
  });
});

// The ordinary case after a process died between launching a browser and
// recording it: the row says stopped while a browser is in fact running.
// Attaching is right and launching a second browser would be the failure.
test('a live browser is attached to even when the row still says stopped', async () => {
  await withSteppedStore(async (store) => {
    assert.equal(readBrowserRow(store.location, 'regular').state, 'stopped');
    const decision = await decideAdoption(store, 'regular', RUNNING);
    assert.equal(decision.action, 'attach');
  });
});

// The mutation this catches: writing this process's identifier over the one
// already recorded, instead of coalescing. `SCHEMA.md` §1.2 calls `pid` the
// isolation fact — the service acts on the process recorded here and on
// nothing else — so overwriting a browser's identifier with the identifier of
// a caller that merely attached to it points every later reader at the wrong
// process. An attaching caller did not start the browser and has no handle to
// read the real one from, so it must leave what is there alone.
test('attaching to an already-recorded browser leaves its process identifier alone', async () => {
  await withSteppedStore(async (store) => {
    await decideAdoption(store, 'regular', undefined);
    await recordLaunched(store, 'regular', {
      pid: 4321,
      endpoint: RUNNING.endpoint,
      browserUuid: RUNNING.browserUuid,
    });

    // A second caller attaches to the browser the first one launched.
    const decision = await decideAdoption(store, 'regular', RUNNING);
    assert.equal(decision.action, 'attach');

    const row = readBrowserRow(store.location, 'regular');
    assert.equal(
      row.pid,
      4321,
      "the browser's own process identifier must survive another caller attaching",
    );
    assert.notEqual(row.pid, process.pid, 'the attaching process must not record itself');
  });
});

// The mutation this catches: letting a caller that observed a live browser be
// sent to `wait` because another caller is mid-launch. A browser that is
// actually reachable is attachable now, and waiting for a launch that is
// producing a second browser against the same profile is the failure.
test('an observed live browser beats a recorded launch in progress', async () => {
  await withSteppedStore(async (store) => {
    await decideAdoption(store, 'regular', undefined);
    assert.equal(readBrowserRow(store.location, 'regular').state, 'starting');

    const decision = await decideAdoption(store, 'regular', RUNNING);
    assert.equal(decision.action, 'attach');
  });
});

test('the two browsers race independently — one starting does not block the other', async () => {
  await withSteppedStore(async (store) => {
    const regular = await decideAdoption(store, 'regular', undefined);
    const isolated = await decideAdoption(store, 'private', undefined);
    assert.equal(regular.action, 'launch');
    assert.equal(isolated.action, 'launch');
  });
});

test('recording a successful launch makes the browser running, with its process identifier', async () => {
  await withSteppedStore(async (store) => {
    await decideAdoption(store, 'regular', undefined);
    await recordLaunched(store, 'regular', {
      pid: 4321,
      endpoint: RUNNING.endpoint,
      browserUuid: RUNNING.browserUuid,
    });

    const row = readBrowserRow(store.location, 'regular');
    assert.equal(row.state, 'running');
    assert.equal(row.pid, 4321);
    assert.equal(row.endpoint, RUNNING.endpoint);
  });
});

// The mutation this catches: treating a failed launch as nothing to clean up.
// Without this, a caller that wins the race and then fails leaves the row at
// `starting` forever and EVERY later caller waits for a launch that is never
// coming — a machine that can never start a browser again.
test('a failed launch releases the race, so the next caller can take it', async () => {
  await withSteppedStore(async (store) => {
    await decideAdoption(store, 'regular', undefined);
    await recordLaunchFailed(store, 'regular');

    assert.equal(readBrowserRow(store.location, 'regular').state, 'stopped');

    const next = await decideAdoption(store, 'regular', undefined);
    assert.equal(next.action, 'launch', 'the race must be takeable again after a failure');
  });
});

test('a failed launch counts against the restart budget', async () => {
  await withSteppedStore(async (store) => {
    await decideAdoption(store, 'regular', undefined);
    await recordLaunchFailed(store, 'regular');

    const db = new Database(store.location, { readonly: true });
    try {
      const row = db
        .prepare<[], { restart_count: number }>(
          "SELECT restart_count FROM browsers WHERE id = 'regular'",
        )
        .get();
      assert.equal(row?.restart_count, 1);
    } finally {
      db.close();
    }
  });
});

// `arbitration.no_browser_io` (§7.3) is a build rule because the correct
// behaviour is that the call never happens. What this asserts is the
// structural half that IS checkable here: the decision function has no
// parameter through which a browser could reach it, so there is nothing to
// call inside the transaction even by mistake.
test('the arbitration decision is reachable with no driver at all', async () => {
  await withSteppedStore(async (store) => {
    // Three arguments: a store, a browser name, and an already-made
    // observation. No driver, no session, no endpoint to talk to.
    assert.equal(decideAdoption.length, 3);
    const decision: AdoptionDecision = await decideAdoption(store, 'private', undefined);
    assert.ok(decision.action === 'launch' || decision.action === 'wait');
  });
});
