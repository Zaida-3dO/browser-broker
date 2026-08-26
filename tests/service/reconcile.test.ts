import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyReconciliation,
  decideReconciliation,
  readRecordedTabs,
  VANISHED_TAB_REASON,
  type LivePage,
  type RecordedTab,
} from '../../src/service/reconcile.ts';
import { recordTabOpened, reserveTab } from '../../src/service/tabs.ts';
import { readClaimState, readTab, seedClaim } from '../helpers/leases.ts';
import { withSteppedStore } from '../helpers/temp-store.ts';

/**
 * Reconciliation against a live browser (`MILESTONES.md` #21a).
 *
 * ── How the fixtures here are built, and the trap they are built around ─
 *
 * This repository's recurring hollow-test shape is **a fixture in which the
 * correct and the incorrect behaviour coincide**. For reconciliation the
 * coinciding fixture is easy to write by accident and looks perfectly
 * reasonable: one live lease, owning one tab, which is also the one page the
 * browser reports. Against that, *every* implementation passes — closing
 * nothing, closing everything, matching on the wrong field, or comparing the
 * two lists by length. There is exactly one page and exactly one row, so any
 * answer is the right answer.
 *
 * So every fixture below is built so that the right answer and the wrong
 * answers **differ in what they name**, not merely in how many things they
 * name. Concretely: whenever a test asserts a page is closed, there is at
 * least one other page present that must **not** be closed, and the assertion
 * names which. A bug that closed the wrong one, or closed both, fails.
 */

function page(driverTabId: string): LivePage {
  return { driverTabId };
}

function recorded(tabId: string, driverTabId: string | null, claimId = 'claim-a'): RecordedTab {
  return { tabId, driverTabId, claimId };
}

test('a page no live lease owns is closed, and an owned page beside it is not', () => {
  // The fixture that makes this real: **two pages, one owned and one not.**
  // With only the unowned page present, an implementation that closed
  // everything it was shown would pass. Here it cannot — closing
  // `driver-owned` is a failure that a single-page fixture could not see.
  const plan = decideReconciliation(
    [page('driver-owned'), page('driver-stray')],
    [recorded('tab-1', 'driver-owned')],
  );

  assert.deepEqual(
    plan.unownedPages.map((unowned) => unowned.driverTabId),
    ['driver-stray'],
    'exactly the page no row named must be chosen, and the owned one left alone',
  );
  assert.deepEqual(plan.vanishedTabs, [], 'the owned row names a page that is present');
});

test('a row whose page is gone is settled, and a row whose page is present is not', () => {
  // The mirror fixture, and the same discipline: **two rows, one whose page
  // is listed and one whose page is not.** An implementation that settled
  // every row would pass against a single-row fixture and fails here.
  const plan = decideReconciliation(
    [page('driver-present')],
    [
      recorded('tab-present', 'driver-present', 'claim-a'),
      recorded('tab-gone', 'driver-gone', 'claim-b'),
    ],
  );

  assert.deepEqual(
    plan.vanishedTabs.map((tab) => tab.tabId),
    ['tab-gone'],
    'exactly the row naming an absent page must be settled',
  );
  assert.deepEqual(
    plan.vanishedTabs.map((tab) => tab.claimId),
    ['claim-b'],
    'the lease ended must be the one that held the vanished tab, not the other one',
  );
  assert.deepEqual(plan.unownedPages, [], 'the only page present is owned');
});

test('both disagreements are found in one pass, and neither is mistaken for the other', () => {
  // The combined fixture, which is the one that catches a swapped comparison.
  // An implementation that compared the lists the wrong way round would
  // report `driver-stray` as vanished and `tab-gone` as unowned — the same
  // *counts*, entirely wrong contents. Only naming them catches it.
  const plan = decideReconciliation(
    [page('driver-owned'), page('driver-stray')],
    [recorded('tab-1', 'driver-owned', 'claim-a'), recorded('tab-gone', 'driver-gone', 'claim-b')],
  );

  assert.deepEqual(
    plan.unownedPages.map((unowned) => unowned.driverTabId),
    ['driver-stray'],
  );
  assert.deepEqual(
    plan.vanishedTabs.map((tab) => tab.tabId),
    ['tab-gone'],
  );
});

test('while a tab is mid-open, no page is closed — but vanished rows are still settled', () => {
  // ── The race this row's design turns on ────────────────────────────────
  //
  // `reserveTab` writes an `opening` row before the browser is asked, so
  // between the commit and `recordTabOpened` there is a real window in which
  // a page exists that no row yet names. `driver-fresh` below is that page.
  //
  // **The fixture is built so that the wrong answer is destructive rather
  // than merely different**: `driver-fresh` is exactly what an implementation
  // that ignored `opening` rows would close, and closing it takes a tab away
  // from a lease that was granted seconds ago.
  const plan = decideReconciliation(
    [page('driver-owned'), page('driver-fresh')],
    [
      recorded('tab-1', 'driver-owned', 'claim-a'),
      recorded('tab-opening', null, 'claim-b'),
      recorded('tab-gone', 'driver-gone', 'claim-c'),
    ],
  );

  assert.deepEqual(
    plan.unownedPages,
    [],
    'a page cannot be proven unowned while any row is still being opened',
  );
  assert.deepEqual(
    plan.skippedOpening,
    ['tab-opening'],
    'and the declining is reported, not silent',
  );

  // The half that is unaffected. A row with no driver name cannot be found
  // vanished either, so `tab-opening` must not appear here — and `tab-gone`
  // must, because declining to close is not declining to settle.
  assert.deepEqual(
    plan.vanishedTabs.map((tab) => tab.tabId),
    ['tab-gone'],
    'an opening row is never settled, and the genuinely vanished row still is',
  );
});

test('an opening row is never itself settled, even with nothing else in play', () => {
  // The narrow version of the rule, isolated: a row with no driver name has
  // no name to look for, so it can never be "not there".
  const plan = decideReconciliation([], [recorded('tab-opening', null)]);

  assert.deepEqual(
    plan.vanishedTabs,
    [],
    'a row that has not been opened has no page to be missing',
  );
  assert.deepEqual(plan.skippedOpening, ['tab-opening']);
});

test('a browser with nothing open settles every live row and closes nothing', () => {
  // The gone-page case at its limit. Note what makes this non-vacuous: it
  // asserts `unownedPages` is empty *and* that both rows are settled, so an
  // implementation that simply returned two empty lists fails.
  const plan = decideReconciliation(
    [],
    [recorded('tab-1', 'driver-a', 'claim-a'), recorded('tab-2', 'driver-b', 'claim-b')],
  );

  assert.deepEqual(
    plan.vanishedTabs.map((tab) => tab.tabId),
    ['tab-1', 'tab-2'],
  );
  assert.deepEqual(plan.unownedPages, [], 'there are no pages, so there is nothing to close');
});

test('nothing the decider returns to a report carries the driver’s name for a tab', () => {
  // §1.4 as an assertion rather than a convention. `ReconciliationReport` is
  // the only shape a caller reads, and this checks the values that flow into
  // it — the settled identifiers — are the opaque ones.
  const plan = decideReconciliation([], [recorded('tab-1', 'driver-secret', 'claim-a')]);

  const settled = plan.vanishedTabs.map((tab) => tab.tabId);
  assert.deepEqual(settled, ['tab-1']);
  assert.equal(
    settled.some((tabId) => tabId.includes('driver')),
    false,
    'the identifiers a report carries must be tabs.id values, never driver names',
  );
});

test('settling writes closed rows and revoked leases, and leaves other leases alone', async () => {
  await withSteppedStore((store) => {
    // **Two leases, and only one of them loses its page.** A fixture with one
    // lease would pass against an implementation whose UPDATE forgot its
    // WHERE clause and revoked every active lease in the store.
    const doomed = seedClaim(store.db, { browserId: 'regular' });
    const survivor = seedClaim(store.db, { browserId: 'regular' });

    const goneTab = reserveTab(store.db, doomed.claimId, 'regular');
    recordTabOpened(store.db, goneTab, 'driver-gone');
    const liveTab = reserveTab(store.db, survivor.claimId, 'regular');
    recordTabOpened(store.db, liveTab, 'driver-live');

    const rows = readRecordedTabs(store.db, 'regular');
    const plan = decideReconciliation([page('driver-live')], rows);

    const at = new Date().toISOString();
    applyReconciliation(store.db, plan.vanishedTabs, at);

    assert.equal(readTab(store.db, goneTab).state, 'closed', 'the vanished tab is closed');
    assert.equal(
      readClaimState(store.db, doomed.claimId),
      'revoked',
      'and the lease that held it is ended',
    );

    assert.equal(readTab(store.db, liveTab).state, 'open', 'the surviving tab is untouched');
    assert.equal(
      readClaimState(store.db, survivor.claimId),
      'active',
      'and its lease is still live — settling is scoped to the rows that vanished',
    );

    // §2.4a's neighbour: `closing` would claim a round trip is outstanding.
    // Nothing is going to be asked about a page that is already gone.
    assert.notEqual(
      readTab(store.db, goneTab).state,
      'closing',
      'a page that is already gone has no outstanding round trip to wait for',
    );

    const reason = store.db
      .prepare('SELECT revoke_reason AS reason FROM claims WHERE id = ?')
      .get(doomed.claimId) as { reason: string | null };
    assert.equal(
      reason.reason,
      VANISHED_TAB_REASON,
      'the schema requires a revoked lease to carry a sentence, and the caller is refused with it',
    );
    assert.equal(
      reason.reason?.includes('driver'),
      false,
      'and that sentence never names the driver’s identifier for the page (§1.4)',
    );
  });
});

test('readRecordedTabs reads only live rows of live leases on the browser it is asked about', async () => {
  await withSteppedStore((store) => {
    // Four leases, one of which is what we want back. **Every other row here
    // is a specific wrong answer**: an implementation missing the browser
    // filter returns the private one, missing the claim-state join returns
    // the expired one, and missing the tab-state filter returns the closed
    // one. A fixture with only the wanted row could not distinguish any of
    // them.
    const wanted = seedClaim(store.db, { browserId: 'regular' });
    const otherBrowser = seedClaim(store.db, { browserId: 'private' });
    const deadLease = seedClaim(store.db, { browserId: 'regular', state: 'expired' });
    const finishedTab = seedClaim(store.db, { browserId: 'regular' });

    const wantedTab = reserveTab(store.db, wanted.claimId, 'regular');
    recordTabOpened(store.db, wantedTab, 'driver-wanted');

    const privateTab = reserveTab(store.db, otherBrowser.claimId, 'private');
    recordTabOpened(store.db, privateTab, 'driver-private');

    const expiredTab = reserveTab(store.db, deadLease.claimId, 'regular');
    recordTabOpened(store.db, expiredTab, 'driver-expired');

    const closedTab = reserveTab(store.db, finishedTab.claimId, 'regular');
    recordTabOpened(store.db, closedTab, 'driver-closed');
    store.db
      .prepare(`UPDATE tabs SET state = 'closed', closed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), closedTab);

    const rows = readRecordedTabs(store.db, 'regular');

    assert.deepEqual(
      rows.map((row) => row.tabId),
      [wantedTab],
      'only the live tab of a live lease on this browser',
    );
  });
});

test('an opening row reaches the decider as a null driver name, from a real store', async () => {
  await withSteppedStore((store) => {
    // The race, end to end through the schema rather than through a
    // hand-written fixture — this is what proves §1.4's check constraint
    // means what `decideReconciliation` relies on it meaning.
    const claim = seedClaim(store.db, { browserId: 'regular' });
    const openingTab = reserveTab(store.db, claim.claimId, 'regular');

    const rows = readRecordedTabs(store.db, 'regular');
    assert.deepEqual(
      rows.map((row) => row.driverTabId),
      [null],
    );

    const plan = decideReconciliation([page('driver-fresh')], rows);
    assert.deepEqual(
      plan.unownedPages,
      [],
      'the page this lease is about to be handed must not be closed under it',
    );
    assert.deepEqual(plan.skippedOpening, [openingTab]);
  });
});
