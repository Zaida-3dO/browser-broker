import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import { recordTabOpened, reserveTab } from '../../src/service/tabs.ts';
import { readTab, seedClaim } from '../helpers/leases.ts';
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

test('recording an open against a tab that was never reserved is refused', async () => {
  await withSteppedStore((store) => {
    // Nothing reserved this identifier, so there is no row in `opening` for
    // the update to match. Silently doing nothing here would leave a real
    // page in a browser with no row naming it — the leak `reserveTab`'s
    // ordering exists to prevent — so the zero-row update has to throw.
    assert.throws(() => {
      recordTabOpened(store.db, 'a-tab-that-was-never-minted', 'driver-page-1');
    }, /not awaiting an open/);
  });
});

/* ─────────────────── §1.4's namespace rule ─────────────────── */

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

    // `reserveTab` returns the opaque identifier and `recordTabOpened`
    // returns nothing at all, so after this module's deletion of the
    // reconciliation design there is no function here that hands a driver
    // name back to anything.
    assert.equal(typeof tabId, 'string');
    assert.equal(
      recordTabOpened(store.db, reserveTab(store.db, claim.claimId, 'regular'), 'd2'),
      undefined,
    );
  });
});
