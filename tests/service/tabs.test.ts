import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import type { TabHandle } from '../../src/browser/driver.ts';
import {
  applyReconciliation,
  askBrowserWhatIsOpen,
  closeOrphanedPages,
  liveTabsIn,
  markTabClosing,
  planReconciliation,
  recordCloseFailed,
  recordTabClosed,
  recordTabOpened,
  reserveTab,
  resolveOwnedTab,
  type LiveTabRow,
} from '../../src/service/tabs.ts';
import { readClaimState, readTab, seedClaim } from '../helpers/leases.ts';
import { withSteppedStore } from '../helpers/temp-store.ts';

const RECORD = { endpoint: 'http://127.0.0.1:9000', browserUuid: 'fake-regular-uuid' };

/* ─────────────────── the identifier mapping (#21) ─────────────────── */

test('a caller is handed an opaque identifier, and the driver name is a separate value', async () => {
  await withSteppedStore(async (store) => {
    const claim = seedClaim(store.db);
    const driver = new FakeBrowserDriver();
    const session = await driver.attach('regular', RECORD);

    const tabId = reserveTab(store.db, claim.claimId, 'regular');
    const handle = await session.openTab();
    recordTabOpened(store.db, tabId, handle.driverTabId);

    // The two namespaces are genuinely two. If they were ever collapsed —
    // the opaque identifier set to the driver's name, or the reverse — this
    // is the assertion that fails.
    assert.notEqual(tabId, handle.driverTabId);

    const row = readTab(store.db, tabId);
    assert.equal(row.state, 'open');
    assert.equal(row.driverTabId, handle.driverTabId);
  });
});

test('a reserved tab has no driver name until it opens, which is what the schema requires', async () => {
  await withSteppedStore((store) => {
    const claim = seedClaim(store.db);
    const tabId = reserveTab(store.db, claim.claimId, 'regular');

    const row = readTab(store.db, tabId);
    assert.equal(row.state, 'opening');
    assert.equal(row.driverTabId, null);
  });
});

test('the row exists before the browser is asked, so a lost answer is not an unfindable page', async () => {
  await withSteppedStore(async (store) => {
    const claim = seedClaim(store.db);
    const driver = new FakeBrowserDriver();
    const session = await driver.attach('regular', RECORD);
    driver.clearCalls();

    const tabId = reserveTab(store.db, claim.claimId, 'regular');

    // Reserving writes a row and asks the browser nothing. If the order were
    // reversed — open first, write the row after — this assertion fails, and
    // a tab that opened and then lost its answer would be a page with no row
    // naming it, which nothing can later find.
    assert.deepEqual(driver.calls, []);
    assert.equal(readTab(store.db, tabId).state, 'opening');

    driver.failNext('openTab');
    await assert.rejects(session.openTab());

    // The failed open was attempted and is recorded as attempted, and the
    // reserved row still names the lease that was going to own it.
    assert.equal(driver.callsOf('openTab').length, 1);
    assert.equal(driver.callsOf('openTab')[0]?.failed, true);
    assert.equal(readTab(store.db, tabId).state, 'opening');
  });
});

test('recording an open twice is refused rather than overwriting the first driver name', async () => {
  await withSteppedStore((store) => {
    const claim = seedClaim(store.db);
    const tabId = reserveTab(store.db, claim.claimId, 'regular');
    recordTabOpened(store.db, tabId, 'driver-page-1');

    // The second name would leave the first page real and unnamed by any row.
    assert.throws(() => {
      recordTabOpened(store.db, tabId, 'driver-page-2');
    }, /not awaiting an open/);

    assert.equal(readTab(store.db, tabId).driverTabId, 'driver-page-1');
  });
});

/* ─────────────────── ownership, and the shared refusal ─────────────────── */

test("another lease's tab is indistinguishable from one that does not exist", async () => {
  await withSteppedStore((store) => {
    const mine = seedClaim(store.db);
    const theirs = seedClaim(store.db);

    const theirTab = reserveTab(store.db, theirs.claimId, 'regular');
    recordTabOpened(store.db, theirTab, 'driver-page-theirs');

    // §7.1: an unowned tab gets "the same refusal as an unknown tab, so
    // probing cannot discover another lease's tabs". Both answers are
    // `undefined` — not two different negatives a caller could tell apart.
    const unowned = resolveOwnedTab(store.db, theirTab, mine.claimId);
    const unknown = resolveOwnedTab(store.db, 'a-tab-that-was-never-minted', mine.claimId);

    assert.equal(unowned, undefined);
    assert.equal(unknown, undefined);

    // And the owner still resolves, so the check is refusing the right thing
    // rather than refusing everything.
    assert.notEqual(resolveOwnedTab(store.db, theirTab, theirs.claimId), undefined);
  });
});

test('a tab that is not open does not resolve, however owned it is', async () => {
  await withSteppedStore((store) => {
    const claim = seedClaim(store.db);
    const tabId = reserveTab(store.db, claim.claimId, 'regular');
    recordTabOpened(store.db, tabId, 'driver-page-1');

    assert.notEqual(resolveOwnedTab(store.db, tabId, claim.claimId), undefined);

    recordTabClosed(store.db, tabId);
    assert.equal(resolveOwnedTab(store.db, tabId, claim.claimId), undefined);
  });
});

test('resolving returns the browser the tab is actually in', async () => {
  await withSteppedStore((store) => {
    const claim = seedClaim(store.db, { browserId: 'private' });
    const tabId = reserveTab(store.db, claim.claimId, 'private');
    recordTabOpened(store.db, tabId, 'driver-page-private');

    const handle = resolveOwnedTab(store.db, tabId, claim.claimId);
    // Capacity is one total across both browsers, so an operation landing on
    // the wrong one is a failure no count would show.
    assert.deepEqual(handle, { browser: 'private', driverTabId: 'driver-page-private' });
  });
});

/* ─────────────────── closing, and the leak that is not a leak ─────────────────── */

test('a close that has been asked for and not answered is "closing", not free', async () => {
  await withSteppedStore((store) => {
    const claim = seedClaim(store.db);
    const tabId = reserveTab(store.db, claim.claimId, 'regular');
    recordTabOpened(store.db, tabId, 'driver-page-1');

    markTabClosing(store.db, tabId);

    const row = readTab(store.db, tabId);
    // 'closing' is what stops a page that may still exist being counted as
    // free. If this were 'closed', the page would be countable as gone before
    // anything confirmed it was.
    assert.equal(row.state, 'closing');
    assert.equal(row.closeAttempts, 1);
  });
});

test('a tab the browser would not close is a leaked tab, flagged so it can be found', async () => {
  await withSteppedStore(async (store) => {
    const claim = seedClaim(store.db);
    const driver = new FakeBrowserDriver();
    const session = await driver.attach('regular', RECORD);
    const handle = await session.openTab();

    const tabId = reserveTab(store.db, claim.claimId, 'regular');
    recordTabOpened(store.db, tabId, handle.driverTabId);

    markTabClosing(store.db, tabId);
    driver.failNext('closeTab');
    await assert.rejects(session.closeTab(handle));

    recordCloseFailed(store.db, tabId);

    const row = readTab(store.db, tabId);
    assert.equal(row.state, 'failed');
    // The flag, not merely the state: the administrative clear-a-leaked-tab
    // operation selects on it, and a leaked tab is by definition one no live
    // lease points at, so nothing else identifies it.
    assert.equal(row.closeFailed, 1);

    // And the page really is still there — the fake keeps a tab it could not
    // close, which is what makes "leaked tab, not leaked lease" observable
    // rather than asserted.
    assert.equal(driver.openTabCount('regular'), 1);
  });
});

/* ─────────────────── reconciliation: the browser is gone ─────────────────── */

function storedTab(overrides: Partial<LiveTabRow> = {}): LiveTabRow {
  return {
    tabId: 'tab-1',
    claimId: 'claim-1',
    browserId: 'regular',
    driverTabId: 'driver-page-1',
    claimLive: true,
    ...overrides,
  };
}

test('a browser that fails a discovery check is gone, and every tab row in it closes', () => {
  const plan = planReconciliation({
    browserId: 'regular',
    browserAlive: false,
    openInBrowser: [],
    storedTabs: [
      storedTab({ tabId: 'tab-1', claimId: 'claim-1' }),
      storedTab({ tabId: 'tab-2', claimId: 'claim-2' }),
    ],
  });

  // A tab inside a process that has exited is closed by definition, so this
  // is every row rather than a selection of them.
  assert.deepEqual([...plan.tabsToClose].sort(), ['tab-1', 'tab-2']);
  // A browser dying ends every lease in it at once. That is reported as what
  // it is rather than hidden — with two browsers and no third there is no
  // capacity to fail over to.
  assert.deepEqual([...plan.claimsToEnd].sort(), ['claim-1', 'claim-2']);
  // Nothing is closed in a browser that is gone: there is nothing to close it
  // in, and asking would be a round trip to an endpoint that answers nothing.
  assert.deepEqual(plan.pagesToClose, []);
});

test('a gone browser does not consult what it supposedly had open', () => {
  const plan = planReconciliation({
    browserId: 'regular',
    browserAlive: false,
    // A list from before, which is the only kind a gone browser can have
    // produced. Acting on it would be acting on a browser that is not there.
    // **It names the same page the stored row does**, which is the case that
    // separates "ignored the list" from "consulted it": a branch that
    // intersected the two would spare this row, and a browser that is gone
    // has no pages to spare it for.
    openInBrowser: [{ browser: 'regular', driverTabId: 'driver-page-1' }],
    storedTabs: [storedTab({ tabId: 'tab-1', driverTabId: 'driver-page-1' })],
  });

  // The row closes **despite** appearing in that list, because the list
  // describes a browser that has exited.
  assert.deepEqual(plan.tabsToClose, ['tab-1']);
  assert.deepEqual(plan.claimsToEnd, ['claim-1']);
  assert.deepEqual(plan.pagesToClose, []);
});

test('a gone browser ends only the leases that were still live', () => {
  const plan = planReconciliation({
    browserId: 'regular',
    browserAlive: false,
    openInBrowser: [],
    storedTabs: [
      storedTab({ tabId: 'tab-1', claimId: 'claim-live', claimLive: true }),
      storedTab({ tabId: 'tab-2', claimId: 'claim-done', claimLive: false }),
    ],
  });

  // Both rows close — the pages are gone either way. Only the live lease is
  // ended, because ending one that has already ended would restamp a lease
  // that finished at a different moment for a different reason.
  assert.deepEqual([...plan.tabsToClose].sort(), ['tab-1', 'tab-2']);
  assert.deepEqual(plan.claimsToEnd, ['claim-live']);
});

/* ─────────────────── reconciliation: the browser is alive ─────────────────── */

test('a page no live lease owns is closed in the browser', () => {
  const plan = planReconciliation({
    browserId: 'regular',
    browserAlive: true,
    openInBrowser: [
      { browser: 'regular', driverTabId: 'driver-page-owned' },
      { browser: 'regular', driverTabId: 'driver-page-orphan' },
    ],
    storedTabs: [storedTab({ driverTabId: 'driver-page-owned', claimLive: true })],
  });

  assert.deepEqual(plan.pagesToClose, [{ browser: 'regular', driverTabId: 'driver-page-orphan' }]);
  // The owned page is left entirely alone — no row closed, no lease ended.
  assert.deepEqual(plan.tabsToClose, []);
  assert.deepEqual(plan.claimsToEnd, []);
});

test('a page owned by a lease that has ended is an orphan, and closes', () => {
  const plan = planReconciliation({
    browserId: 'regular',
    browserAlive: true,
    openInBrowser: [{ browser: 'regular', driverTabId: 'driver-page-1' }],
    // The row exists and names this page, and its lease is over. "No *live*
    // lease owns it" is the test, so a dead lease's page is an orphan.
    storedTabs: [storedTab({ driverTabId: 'driver-page-1', claimLive: false })],
  });

  assert.deepEqual(plan.pagesToClose, [{ browser: 'regular', driverTabId: 'driver-page-1' }]);
});

test('a row a live lease believes it owns that the browser does not have is closed, and its lease ends', () => {
  const plan = planReconciliation({
    browserId: 'regular',
    browserAlive: true,
    openInBrowser: [{ browser: 'regular', driverTabId: 'driver-page-present' }],
    storedTabs: [
      storedTab({ tabId: 'tab-present', driverTabId: 'driver-page-present', claimId: 'claim-ok' }),
      storedTab({ tabId: 'tab-gone', driverTabId: 'driver-page-gone', claimId: 'claim-gone' }),
    ],
  });

  assert.deepEqual(plan.tabsToClose, ['tab-gone']);
  assert.deepEqual(plan.claimsToEnd, ['claim-gone']);
  // Nothing to close in the browser: the present page is owned, and the
  // missing one is already not there.
  assert.deepEqual(plan.pagesToClose, []);
});

test('a tab still opening is not treated as missing, because it is not there yet on purpose', () => {
  const plan = planReconciliation({
    browserId: 'regular',
    browserAlive: true,
    openInBrowser: [],
    // No driver name, because the open is in flight. Reading "not there" as
    // "gone" would close a tab that was about to exist and end the lease of
    // the caller waiting for it.
    storedTabs: [storedTab({ driverTabId: null })],
  });

  assert.deepEqual(plan.tabsToClose, []);
  assert.deepEqual(plan.claimsToEnd, []);
});

test('the keeper tab is never closed by reconciliation, which would otherwise kill the signed-in browser', () => {
  const withKeeper = planReconciliation({
    browserId: 'regular',
    browserAlive: true,
    openInBrowser: [{ browser: 'regular', driverTabId: 'driver-keeper' }],
    storedTabs: [],
    keeperTabId: 'driver-keeper',
  });

  // The keeper tab is owned by no lease by design (§3.15), which is exactly
  // the test for a page to close. Closing the last tab in a headed browser
  // kills it within about half a second, taking the shared authenticated
  // session with it — so the mechanism that exists to prevent that failure
  // would have been its cause.
  assert.deepEqual(withKeeper.pagesToClose, []);

  // Naming a *different* tab as the keeper leaves this one an orphan again,
  // which is what proves the exclusion is the keeper identity rather than a
  // blanket "close nothing".
  const withOtherKeeper = planReconciliation({
    browserId: 'regular',
    browserAlive: true,
    openInBrowser: [{ browser: 'regular', driverTabId: 'driver-keeper' }],
    storedTabs: [],
    keeperTabId: 'driver-some-other-tab',
  });
  assert.deepEqual(withOtherKeeper.pagesToClose, [
    { browser: 'regular', driverTabId: 'driver-keeper' },
  ]);
});

/* ─────────────────── reconciliation writes, and where it must not ─────────────────── */

test('applying a plan closes the rows and ends the leases, as committed state', async () => {
  await withSteppedStore(async (store) => {
    const claim = seedClaim(store.db);
    const tabId = reserveTab(store.db, claim.claimId, 'regular');
    recordTabOpened(store.db, tabId, 'driver-page-1');

    await store.immediate(({ db }) => {
      applyReconciliation(db, {
        tabsToClose: [tabId],
        claimsToEnd: [claim.claimId],
        pagesToClose: [],
      });
      return { value: undefined };
    });

    // Read on a **second connection**, which sees only what committed. A read
    // through the writing handle would pass whether or not the transaction
    // ever committed, and that is how a test in this repository once stayed
    // green with the violation present.
    const observer = new Database(store.location, { readonly: true });
    try {
      assert.equal(readTab(observer, tabId).state, 'closed');
      assert.equal(readClaimState(observer, claim.claimId), 'expired');
    } finally {
      observer.close();
    }
  });
});

test('applying a plan does no browser work, because it cannot reach a browser', async () => {
  await withSteppedStore(async (store) => {
    const claim = seedClaim(store.db);
    const driver = new FakeBrowserDriver();
    const session = await driver.attach('regular', RECORD);
    const orphan = await session.openTab();
    const tabId = reserveTab(store.db, claim.claimId, 'regular');
    recordTabOpened(store.db, tabId, 'driver-page-1');
    driver.clearCalls();

    await store.immediate(({ db }) => {
      applyReconciliation(db, {
        tabsToClose: [tabId],
        claimsToEnd: [claim.claimId],
        // A plan naming a page to close, applied inside a transaction. §2.4b
        // is the rule this asserts: no browser call happens in here, because
        // a wedged browser inside the transaction blocks every arbitration
        // call on the machine.
        pagesToClose: [orphan],
      });
      return { value: undefined };
    });

    assert.deepEqual(driver.calls, []);
    assert.equal(driver.openTabCount('regular'), 1, 'the orphan is still open, uncontacted');
  });
});

test('the orphaned pages are closed after the transaction, and a failure is tolerated', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const first = await session.openTab();
  const second = await session.openTab();
  driver.clearCalls();

  driver.failNext('closeTab');
  const failed = await closeOrphanedPages(session, [first, second]);

  // Best effort: the one that would not close is reported rather than thrown,
  // because the capacity is already back and a tab that will not close is a
  // leaked tab rather than a leaked lease.
  assert.deepEqual(failed, [first]);
  // And the second was still attempted — a loop that stopped at the first
  // failure would leave pages open that would have closed fine.
  assert.equal(driver.callsOf('closeTab').length, 2);
  assert.equal(driver.openTabCount('regular'), 1);
});

test('asking a browser what is open is a browser call, and it is a separate step', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const opened = await session.openTab();
  driver.clearCalls();

  const open = await askBrowserWhatIsOpen(session);

  assert.deepEqual([...open], [opened]);
  assert.equal(driver.callsOf('listTabs').length, 1);
});

/* ─────────────────── the store's view of what is live ─────────────────── */

test('live tabs are the unfinished ones, and each carries whether its lease is live', async () => {
  await withSteppedStore((store) => {
    const live = seedClaim(store.db, { state: 'active' });
    const ended = seedClaim(store.db, { state: 'released' });

    const openTab = reserveTab(store.db, live.claimId, 'regular');
    recordTabOpened(store.db, openTab, 'driver-page-open');

    const orphanTab = reserveTab(store.db, ended.claimId, 'regular');
    recordTabOpened(store.db, orphanTab, 'driver-page-orphan');

    const closedTab = reserveTab(store.db, live.claimId, 'regular');
    recordTabOpened(store.db, closedTab, 'driver-page-closed');
    recordTabClosed(store.db, closedTab);

    const rows = liveTabsIn(store.db, 'regular');
    const byId = new Map(rows.map((row) => [row.tabId, row]));

    // The closed one is finished with and is not here. If it were,
    // reconciliation would keep asking a browser about a page it already
    // closed, forever.
    assert.equal(byId.size, 2);
    assert.equal(byId.get(openTab)?.claimLive, true);
    assert.equal(byId.get(orphanTab)?.claimLive, false);
    assert.equal(byId.has(closedTab), false);
  });
});

test('a tab asked to close but not confirmed is still live, so it is not counted as free', async () => {
  // ── Why `closing` gets its own test ─────────────────────────────────
  //
  // `closing` is "the honest representation of *the tool was asked and has
  // not answered*, and it is what stops a page that may still exist being
  // counted as free" (§1.4). A page in that state may still exist in the
  // browser, so reconciliation must keep seeing it: treating it as finished
  // means a real page nobody is tracking, and the administrative operation
  // that clears leaked tabs selects on rows.
  //
  // **The single-character change this catches** is dropping `'closing'`
  // from `LIVE_TAB_STATES`. Seeding only `opening`, `open` and `closed`
  // leaves that mutation alive: every assertion still holds, because no test
  // ever puts a tab into the one state the mutation removes.
  //
  // The state is reached through `markTabClosing` rather than written with
  // SQL, so this exercises the transition the service actually performs
  // instead of a shape a test invented.
  await withSteppedStore((store) => {
    const claim = seedClaim(store.db, { state: 'active' });

    const closingTab = reserveTab(store.db, claim.claimId, 'regular');
    recordTabOpened(store.db, closingTab, 'driver-page-closing');
    markTabClosing(store.db, closingTab);

    assert.equal(
      readTab(store.db, closingTab).state,
      'closing',
      'the fixture did not reach the state under test, so the assertion below would not exercise it',
    );

    const rows = liveTabsIn(store.db, 'regular');
    assert.deepEqual(
      rows.map((row) => row.tabId),
      [closingTab],
      'a tab asked to close and not yet confirmed was treated as finished with, so a page that may still exist is counted as free',
    );
  });
});

test('live tabs are scoped to one browser, so reconciling one cannot touch the other', async () => {
  await withSteppedStore((store) => {
    const regular = seedClaim(store.db, { browserId: 'regular' });
    const priv = seedClaim(store.db, { browserId: 'private' });

    const regularTab = reserveTab(store.db, regular.claimId, 'regular');
    recordTabOpened(store.db, regularTab, 'driver-page-regular');
    const privateTab = reserveTab(store.db, priv.claimId, 'private');
    recordTabOpened(store.db, privateTab, 'driver-page-private');

    assert.deepEqual(
      liveTabsIn(store.db, 'regular').map((row) => row.tabId),
      [regularTab],
    );
    assert.deepEqual(
      liveTabsIn(store.db, 'private').map((row) => row.tabId),
      [privateTab],
    );
  });
});

/* ─────────────────── the rule this file exists to keep ─────────────────── */

test('nothing this module returns to a surface carries the driver name', async () => {
  await withSteppedStore(async (store) => {
    const claim = seedClaim(store.db);
    const driver = new FakeBrowserDriver();
    const session = await driver.attach('regular', RECORD);
    const handle = await session.openTab();

    const tabId = reserveTab(store.db, claim.claimId, 'regular');
    recordTabOpened(store.db, tabId, handle.driverTabId);

    // The value a caller is handed is the opaque one, and it does not contain
    // the driver's name anywhere in it. §1.4: exposing the driver's name
    // "hands callers a second, non-opaque way to name a tab, which is the
    // addressing bug arriving through a different door".
    assert.equal(tabId.includes(handle.driverTabId), false);
    assert.equal(handle.driverTabId.includes(tabId), false);

    // And the only function here that produces a driver name is the one that
    // exists to feed the driver — its result is a `TabHandle`, which is the
    // type `driver.ts` keeps below the service layer.
    const resolved = resolveOwnedTab(store.db, tabId, claim.claimId) as TabHandle;
    assert.equal(resolved.driverTabId, handle.driverTabId);
  });
});
