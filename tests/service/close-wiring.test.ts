import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Database } from 'better-sqlite3';

import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import { runDoctor } from '../../src/doctor/report.ts';
import { createRuntime, type Runtime } from '../../src/service/runtime.ts';
import { removeDirectory } from '../helpers/remove-directory.ts';

/**
 * **That releasing a lease actually writes down what happened to its tab.**
 *
 * ── Why this file exists rather than another case beside the SQL ────────
 *
 * `arbitration.test.ts` calls `recordTabClosed` directly and proves the
 * statement does what it says. That is worth having and it is not this: it
 * proves the writer works, never that anything *calls* it. Deleting the call
 * from `runtime.ts` left the whole suite green — 1484 tests — while
 * restoring the field defect exactly.
 *
 * This repository names that failure shape itself: a feature that is
 * documented, tested, and called by nothing in `src`. The only way to
 * exclude it is to drive the seam a caller drives, so this builds the real
 * runtime, takes a real lease, releases it, and reads the row.
 *
 * ── What the row said when this was broken ──────────────────────────────
 *
 * `state = 'closing'`, `close_attempts = 0` — the tool never asked, and the
 * row waits for an answer nobody is coming to give. Twenty-two of those
 * accumulated in a real store over two days, and eight pages sat open on a
 * person's browser owned by no lease.
 */
test('RELEASING A LEASE RECORDS THE CLOSE — the wiring, not the statement', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-close-wiring-'));
  const driver = new FakeBrowserDriver();
  const runtime = await createRuntime({
    adapter: 'cli',
    driver,
    env: {
      BROKER_DB: path.join(directory, 'broker.db'),
      BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
      BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
    },
  });

  try {
    const claimed = await runtime.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: {
        session_id: 'close-wiring',
        browser: 'regular',
        purpose: 'Proving a release writes down what became of its tab.',
      },
    });
    assert.equal(claimed.outcome, 'accepted');
    const granted = (claimed as { value: Record<string, unknown> }).value;
    assert.equal(granted['outcome'], 'granted', 'the lease queued rather than taking a tab');
    const key = String(granted['key']);
    const tabId = String(granted['tabId']);

    // A navigate, so the tab is genuinely opened by the driver rather than
    // being a reservation that never became a page. A row that never opened
    // takes a different branch entirely, and testing that one would leave
    // the branch this file is about untouched.
    const navigated = await runtime.service.perform({
      operation: 'navigate',
      adapter: 'cli',
      arguments: { key, url: 'https://example.com/' },
    });
    assert.equal(navigated.outcome, 'accepted', JSON.stringify(navigated));

    const released = await runtime.service.perform({
      operation: 'release',
      adapter: 'cli',
      arguments: { key },
    });
    assert.equal(released.outcome, 'accepted', JSON.stringify(released));

    const row = runtime.store.db
      .prepare(
        `SELECT state, closed_at AS closedAt, close_attempts AS closeAttempts,
                close_failed AS closeFailed
           FROM tabs WHERE id = ?`,
      )
      .get(tabId) as {
      state: string;
      closedAt: string | null;
      closeAttempts: number;
      closeFailed: number;
    };

    assert.equal(
      row.state,
      'closed',
      'THE FIELD BUG: the row was left waiting on a close nobody was coming to answer',
    );
    assert.notEqual(row.closedAt, null, 'a closed tab with no close time');
    // The count is the diagnostic that made the field investigation possible:
    // zero means never asked, which is a different fault from asked-and-refused.
    assert.equal(row.closeAttempts, 1);
    assert.equal(row.closeFailed, 0);
  } finally {
    runtime.close();
    removeDirectory(directory);
  }
});

test('THE DOCTOR COUNTS A STRANDED ROW — the query, not the sentence', async () => {
  // `checks.test.ts` exercises `checkStrandedTabs(22, 600)`, which is the
  // formatting of a number it is handed. The query that *produces* the
  // number has its own test here, because a body that answers zero without
  // looking sends the whole suite green while "doctor exits 0 while tabs
  // strand" holds — the precise defect the check exists to kill, invisible.
  //
  // So this drives the real report against a real store holding a row aged
  // past a lease's lifetime, and asserts the failure is reported.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-stranded-count-'));
  const driver = new FakeBrowserDriver();
  const runtime = await createRuntime({
    adapter: 'cli',
    driver,
    env: {
      BROKER_DB: path.join(directory, 'broker.db'),
      BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
      BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
    },
  });

  try {
    const claimed = await runtime.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: {
        session_id: 'stranded-count',
        browser: 'regular',
        purpose: 'Aging a row into the state the doctor is meant to notice.',
      },
    });
    const granted = (claimed as { value: Record<string, unknown> }).value;
    const tabId = String(granted['tabId']);
    await runtime.service.perform({
      operation: 'navigate',
      adapter: 'cli',
      arguments: { key: String(granted['key']), url: 'https://example.com/' },
    });

    // Aged past any plausible lease: the row is asserted to be stranded by
    // its clock rather than by its state alone, which is the distinction the
    // check is built on — a close still in flight must not be reported.
    const longAgo = new Date(Date.now() - 86_400_000).toISOString();
    // `close_failed = 1` is set deliberately, and it is what makes this the
    // escalating population: a browser was asked and said the page is still
    // there. Without it this row is one nobody ever asked about, which the
    // check now reports as `unknown` — the case immediately below.
    runtime.store.db
      .prepare(
        "UPDATE tabs SET state = 'closing', updated_at = ?, close_failed = 1, close_attempts = 1 WHERE id = ?",
      )
      .run(longAgo, tabId);

    const report = runDoctor(runtime.environment, runtime.store.db);
    const stranded = report.checks.find((check) => check.id === 'store.stranded_tabs');

    assert.ok(stranded !== undefined, 'the report carries no stranded-tab row at all');
    assert.equal(
      stranded.status,
      'failed',
      'a row waiting a day on a close was reported as healthy',
    );
    assert.notEqual(report.exitCode, 0, 'the report exited clean with a tab stranded');

    // The other population, through the same real query. A row nobody ever
    // asked about says only that a record is unsettled — the permanent red
    // floor this split exists to end.
    runtime.store.db
      .prepare('UPDATE tabs SET close_failed = 0, close_attempts = 0, updated_at = ? WHERE id = ?')
      .run(longAgo, tabId);

    const second = runDoctor(runtime.environment, runtime.store.db);
    const neverAsked = second.checks.find((check) => check.id === 'store.stranded_tabs');

    assert.ok(neverAsked !== undefined, 'the report carries no stranded-tab row at all');
    assert.equal(
      neverAsked.status,
      'unknown',
      'a record nobody ever asked about was escalated as a probably-open page',
    );
    assert.equal(
      second.exitCode,
      0,
      'a health gate stayed red on records whose subject was never looked at',
    );
  } finally {
    runtime.close();
    removeDirectory(directory);
  }
});

/**
 * **That the stranded backlog drains without a person running a command.**
 *
 * ── The defect these cover ──────────────────────────────────────────────
 *
 * A store was reporting eleven stranded tabs on a browser holding one page.
 * The count was a permanent floor: unchanged across two days, multiple
 * sessions and clean releases. Every row was pre-existing residue under a
 * lease that had already ended, and `readRecordedTabs` reads only *active*
 * leases — so the only thing in the build that could reach them was
 * `broker reconcile <browser>`, a shell command a person has to run.
 *
 * `settleStrandedTabs` was already correct and already tested. What was
 * missing was anything calling it outside the command-line path, and
 * `reconcile.test.ts` cannot see that gap for the reason the header above
 * gives: a writer proven to work is not a writer proven to be called.
 *
 * So these drive the real runtime and assert on rows nothing asked them to
 * touch.
 */
function seedLegacyResidue(db: Database): void {
  // Residue under an ENDED lease, aged past any plausible round trip, with
  // `close_attempts = 0`: the exact fingerprint of the field population.
  const longAgo = new Date(Date.now() - 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO claims
       (id, key_hash, session_id, browser_id, state, purpose, expires_at,
        ttl_seconds, activated_at, ended_at, revoke_reason)
     VALUES ('legacy-claim', 'hash-legacy', 'legacy-session', 'regular', 'released',
             'Residue from before the close answer was written back.', ?, 600, ?, ?, NULL)`,
  ).run(longAgo, longAgo, longAgo);

  // ── Why there is no `closing` row with a null driver name here ──────────
  //
  // There cannot be one. `step-004-tab-never-opened.ts` carries a CHECK that
  // a live row must say whether it has a driver name:
  //
  //   state NOT IN ('opening','open','closing')
  //   OR (state = 'opening') = (driver_tab_id IS NULL)
  //
  // so `closing` with a null name is rejected by the store, measured rather
  // than assumed — the first version of this fixture tried it and SQLite
  // refused the insert. `opening` is the state that carries a null name, and
  // `updateSweptTabs` settles that one straight to `closed` without ever
  // passing through `closing`.
  const rows: readonly (readonly [string, string])[] = [
    ['legacy-a', 'gone-page-a'],
    ['legacy-b', 'gone-page-b'],
  ];
  for (const [tabId, driverTabId] of rows) {
    db.prepare(
      `INSERT INTO tabs
         (id, claim_id, browser_id, driver_tab_id, state, opened_at, updated_at,
          close_attempts, close_failed)
       VALUES (?, 'legacy-claim', 'regular', ?, 'closing', ?, ?, 0, 0)`,
    ).run(tabId, driverTabId, longAgo, longAgo);
  }
}

function runtimeIn(directory: string): Promise<Runtime> {
  return createRuntime({
    adapter: 'cli',
    driver: new FakeBrowserDriver(),
    env: {
      BROKER_DB: path.join(directory, 'broker.db'),
      BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
      BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
    },
  });
}

async function takeAndRelease(runtime: Runtime, sessionId: string, url: string): Promise<void> {
  const claimed = await runtime.service.perform({
    operation: 'claim',
    adapter: 'cli',
    arguments: {
      session_id: sessionId,
      browser: 'regular',
      purpose: 'An ordinary lease, whose close is what puts a live tab list in hand.',
    },
  });
  const granted = (claimed as { value: Record<string, unknown> }).value;
  await runtime.service.perform({
    operation: 'navigate',
    adapter: 'cli',
    arguments: { key: String(granted['key']), url },
  });
  await runtime.service.perform({
    operation: 'release',
    adapter: 'cli',
    arguments: { key: String(granted['key']) },
  });
}

function legacyRows(runtime: Runtime): unknown[] {
  return runtime.store.db
    .prepare(
      `SELECT id, state, closed_at AS closedAt, updated_at AS updatedAt
         FROM tabs WHERE claim_id = 'legacy-claim' ORDER BY id`,
    )
    .all();
}

test('LEGACY RESIDUE DRAINS ON AN ORDINARY CLOSE — nothing asked it to', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-stranded-drain-'));
  const runtime = await runtimeIn(directory);

  try {
    seedLegacyResidue(runtime.store.db);

    // An ordinary lease, taken and released. Its own close is the event that
    // puts a live tab list in the service's hands; the legacy rows drain as a
    // side effect. The fixture's driver names were never opened in this
    // browser, so the live list cannot contain them.
    await takeAndRelease(runtime, 'drain-session', 'https://example.com/');

    const states = runtime.store.db
      .prepare("SELECT id, state FROM tabs WHERE claim_id = 'legacy-claim' ORDER BY id")
      .all();

    assert.deepEqual(
      states,
      [
        { id: 'legacy-a', state: 'closed' },
        { id: 'legacy-b', state: 'closed' },
      ],
      'legacy residue survived an ordinary close, so the backlog is still a permanent floor',
    );

    // And the doctor, which is where the floor was visible, now reads clean.
    const report = runDoctor(runtime.environment, runtime.store.db);
    const stranded = report.checks.find((check) => check.id === 'store.stranded_tabs');
    assert.ok(stranded !== undefined, 'the report carries no stranded-tab row at all');
    assert.equal(stranded.status, 'ok');
    assert.equal(report.exitCode, 0);
  } finally {
    runtime.close();
    removeDirectory(directory);
  }
});

test('THE DRAIN IS IDEMPOTENT — a second pass settles nothing and writes nothing', async () => {
  // A pass that rewrote rows it had already settled would move `updated_at`
  // on every close forever, and that is the column the stranded count is
  // measured against. Asserting "writes nothing" rather than only "settles
  // nothing" is what makes the difference observable: the settle statement
  // carries `AND state = 'closing'`, and a version without it passes a
  // count-only assertion while rewriting closed rows.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-stranded-idempotent-'));
  const runtime = await runtimeIn(directory);

  try {
    seedLegacyResidue(runtime.store.db);
    await takeAndRelease(runtime, 'idempotent-first', 'https://example.com/first');
    const afterFirst = legacyRows(runtime);

    await takeAndRelease(runtime, 'idempotent-second', 'https://example.com/second');
    const afterSecond = legacyRows(runtime);

    assert.deepEqual(
      afterSecond,
      afterFirst,
      'the second pass rewrote rows it had already settled',
    );
  } finally {
    runtime.close();
    removeDirectory(directory);
  }
});

test('A ROW NAMING A PAGE THE BROWSER STILL HAS IS NEVER SETTLED BY THE DRAIN', async () => {
  // The non-negotiable guard, driven through the real runtime rather than
  // through `settleStrandedTabs` directly. `reconcile.test.ts` already pins
  // the function against a list it is handed; what is unproven there is that
  // the list *this* path hands it is a live reading of the browser. A drain
  // that settled on age, or that passed an empty list, would mark the record
  // of a page that is still open as closed and free its slot in the partial
  // unique index while the page is right there.
  //
  // So the fixture is built the way this repository's reconciliation fixtures
  // are: the right and wrong answers differ in WHICH row they name. One
  // stranded row names a page the browser genuinely has open, one names a
  // page it does not. Both are the same age and both sit under ended leases,
  // so nothing but the live list can tell them apart.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-stranded-live-'));
  const runtime = await runtimeIn(directory);

  try {
    // A lease that stays open for the whole test, holding a real page.
    const held = await runtime.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: {
        session_id: 'live-holder',
        browser: 'regular',
        purpose: 'Holding a page whose record the drain must not settle.',
      },
    });
    const holder = (held as { value: Record<string, unknown> }).value;
    await runtime.service.perform({
      operation: 'navigate',
      adapter: 'cli',
      arguments: { key: String(holder['key']), url: 'https://example.com/held' },
    });
    const liveDriverTabId = String(
      (
        runtime.store.db
          .prepare('SELECT driver_tab_id AS driverTabId FROM tabs WHERE id = ?')
          .get(String(holder['tabId'])) as { driverTabId: string }
      ).driverTabId,
    );

    // Now the stranded pair under an ended lease. `live-page` names the page
    // the holder above has open; `dead-page` names nothing the browser has.
    const longAgo = new Date(Date.now() - 86_400_000).toISOString();
    runtime.store.db
      .prepare(
        `INSERT INTO claims
           (id, key_hash, session_id, browser_id, state, purpose, expires_at,
            ttl_seconds, activated_at, ended_at, revoke_reason)
         VALUES ('stale-claim', 'hash-stale', 'stale-session', 'regular', 'released',
                 'An ended lease whose rows are the two populations.', ?, 600, ?, ?, NULL)`,
      )
      .run(longAgo, longAgo, longAgo);
    runtime.store.db
      .prepare(
        `INSERT INTO tabs
           (id, claim_id, browser_id, driver_tab_id, state, opened_at, updated_at,
            close_attempts, close_failed)
         VALUES ('names-dead-page', 'stale-claim', 'regular', 'no-such-page', 'closing', ?, ?, 0, 0)`,
      )
      .run(longAgo, longAgo);

    // ── Why the holder's own row is retired first ───────────────────────
    //
    // `one_row_per_physical_tab` is UNIQUE on `(browser_id, driver_tab_id)`
    // WHERE the state is live — so two live rows may not name the same page,
    // and the first version of this fixture was refused by that index for
    // trying. That refusal is the schema working: it is exactly the
    // "capacity pinned by nothing" shape the index exists to prevent.
    //
    // So the holder's row is moved out of the live states, leaving the
    // stranded row as the only live record naming a page the browser still
    // has open. That is a faithful model of the field case rather than a
    // convenience: a lease ends, its row is left at `closing`, and the page
    // it names outlives it.
    runtime.store.db
      .prepare("UPDATE tabs SET state = 'closed', closed_at = ? WHERE id = ?")
      .run(longAgo, String(holder['tabId']));
    runtime.store.db
      .prepare(
        `INSERT INTO tabs
           (id, claim_id, browser_id, driver_tab_id, state, opened_at, updated_at,
            close_attempts, close_failed)
         VALUES ('names-live-page', 'stale-claim', 'regular', ?, 'closing', ?, ?, 0, 0)`,
      )
      .run(liveDriverTabId, longAgo, longAgo);
    // Read back, so the fixture proves it built what it claims rather than
    // having been silently rewritten by a constraint.
    assert.equal(
      (
        runtime.store.db
          .prepare("SELECT driver_tab_id AS driverTabId FROM tabs WHERE id = 'names-live-page'")
          .get() as { driverTabId: string }
      ).driverTabId,
      liveDriverTabId,
      'the fixture did not actually point a stranded row at the live page',
    );

    // A second lease, taken and released, to drive the drain.
    await takeAndRelease(runtime, 'drain-driver', 'https://example.com/other');

    const after = runtime.store.db
      .prepare("SELECT id, state FROM tabs WHERE claim_id = 'stale-claim' ORDER BY id")
      .all();

    assert.deepEqual(
      after,
      [
        { id: 'names-dead-page', state: 'closed' },
        { id: 'names-live-page', state: 'closing' },
      ],
      'the drain did not tell the two populations apart by the live tab list',
    );

    // And the page really is still open in the browser — which is what makes
    // the assertion above a guard against closing a live page rather than a
    // statement about two database rows. If the drain had settled
    // `names-live-page`, it would have marked closed the record of this page.
    const stillOpen = await (await runtime.session('regular')).listTabs();
    assert.ok(
      stillOpen.some((tab) => tab.driverTabId === liveDriverTabId),
      'the fixture page was gone, so the left-alone row proves nothing',
    );
  } finally {
    runtime.close();
    removeDirectory(directory);
  }
});
