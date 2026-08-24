import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_IDS, PAGE_ACTIONS, type BrowserId } from '../../src/browser/driver.ts';
import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import { decodePng } from '../../src/capture/image.ts';

const RECORD = { endpoint: 'http://127.0.0.1:9222', browserUuid: 'expected-uuid' };

/**
 * The rejection-test shape this whole row exists to make possible.
 *
 * `DECISIONS.md` §5: a guard that returns "denied" after the tab has already
 * opened is worse than no guard. So the assertion is not "it threw" — it is
 * "it threw **and** the driver was never asked". These tests prove the fake
 * can carry that assertion; the guards that will lean on it arrive with the
 * rows that have something to refuse.
 */

test('a driver that was never called records nothing — the assertion a refusal rests on', () => {
  const driver = new FakeBrowserDriver();
  assert.deepEqual(driver.calls, []);
  assert.deepEqual(driver.callsOf('openTab'), []);
  assert.equal(driver.openTabCount('regular'), 0);
});

test('every operation is recorded, in the order it was made', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const tab = await session.openTab();
  await session.navigate(tab, 'https://example.com');
  await session.act(tab, { action: 'click', ref: 'e1' });
  await session.read(tab, ['snapshot', 'console']);
  await session.evaluate(tab, '1 + 1');
  await session.listTabs();
  await session.closeTab(tab);
  await session.detach();

  assert.deepEqual(
    driver.calls.map((call) => call.name),
    ['attach', 'openTab', 'navigate', 'act', 'read', 'evaluate', 'listTabs', 'closeTab', 'detach'],
  );
});

// The mutation this catches: recording a call after the work instead of
// before it. A log written on success is silent about the one case it exists
// to describe — an operation that was attempted and failed is still an
// operation that was attempted, and "nothing happened" must not be satisfied
// by something that happened and threw.
test('a call that throws is still recorded, and is marked as having failed', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const tab = await session.openTab();
  driver.clearCalls();

  driver.failNext('closeTab', new Error('the tab would not close'));
  await assert.rejects(session.closeTab(tab), /would not close/);

  const closes = driver.callsOf('closeTab');
  assert.equal(closes.length, 1, 'the attempted close must appear in the log');
  assert.equal(closes[0]?.failed, true);
  // And the distinction the log has to preserve: asked-and-refused is not the
  // same fact as never-asked, so a successful call must NOT carry the flag.
  assert.equal(driver.callsOf('openTab').length, 0);
});

// The mutation this catches: a `closeTab` that removes the tab before the
// close is confirmed. `SCHEMA.md` §2.4b — a close that fails is a leaked tab,
// not a leaked lease. A fake that dropped the tab regardless would let a
// service claiming the page was gone pass.
test('a close that fails leaves the tab open — a leaked tab, not a silent one', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const tab = await session.openTab();
  assert.equal(driver.openTabCount('regular'), 1);

  driver.failNext('closeTab');
  await assert.rejects(session.closeTab(tab));

  assert.equal(driver.openTabCount('regular'), 1, 'the page is still there');
  assert.deepEqual(
    (await session.listTabs()).map((handle) => handle.driverTabId),
    [tab.driverTabId],
  );
});

test('a close that succeeds removes the tab', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('private', RECORD);
  const tab = await session.openTab();
  await session.closeTab(tab);
  assert.equal(driver.openTabCount('private'), 0);
});

// The mutation this catches: counting the keeper tab against the budget.
// `SCHEMA.md` §3.15 — it is not capacity anybody can use, and counting it
// would mean the budget was one lower than the documentation says.
test('the keeper tab is open but is not counted as capacity', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  await session.ensureKeeperTab();

  assert.equal(driver.openTabCount('regular'), 1, 'the page really is open');
  assert.equal(driver.leasableTabCount('regular'), 0, 'and none of it is capacity');

  await session.openTab();
  assert.equal(driver.openTabCount('regular'), 2);
  assert.equal(driver.leasableTabCount('regular'), 1);
});

// The mutation this catches: dropping the idempotence check in
// `ensureKeeperTab`, so every spawn adds another keeper tab. It is a
// precondition checked on every spawn (`SCHEMA.md` §7.2), so establishing it
// twice must not produce two tabs.
test('establishing the keeper tab twice produces one tab and two recorded checks', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const first = await session.ensureKeeperTab();
  const second = await session.ensureKeeperTab();

  assert.equal(first.driverTabId, second.driverTabId);
  assert.equal(driver.openTabCount('regular'), 1);
  assert.equal(driver.callsOf('ensureKeeperTab').length, 2, 'both checks are visible');
});

// The mutation this catches: a `detach` that closes tabs. Attaching and
// detaching were measured non-destructive (`SCHEMA.md` §1.2a), and that is
// the property the shared-session design rests on — a fake that dropped its
// tabs on detach would let a driver that killed the browser pass.
test('detaching leaves every tab where it was', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  await session.openTab();
  await session.openTab();
  await session.detach();

  assert.equal(driver.openTabCount('regular'), 2);

  // And the browser is still reachable afterwards, which is the whole model:
  // it outlives every process that touched it.
  const second = await driver.attach('regular', RECORD);
  assert.equal((await second.listTabs()).length, 2);
});

test('the two browsers keep separate tabs, so an operation cannot land on the wrong one', async () => {
  const driver = new FakeBrowserDriver();
  const regular = await driver.attach('regular', RECORD);
  const isolated = await driver.attach('private', RECORD);
  await regular.openTab();

  assert.equal(driver.openTabCount('regular'), 1);
  assert.equal(driver.openTabCount('private'), 0);
  assert.deepEqual(await isolated.listTabs(), []);
});

test('every recorded call names the browser it touched', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('private', RECORD);
  const tab = await session.openTab();
  await session.navigate(tab, 'https://example.com');

  assert.ok(driver.calls.length > 0);
  for (const call of driver.calls) {
    assert.equal(call.browser, 'private');
  }
});

test('a cold start records the profile directory it was given', async () => {
  const driver = new FakeBrowserDriver();
  await driver.coldStart({
    browser: 'regular',
    profileDirectory: 'profiles/regular',
    mode: 'headed',
  });

  const starts = driver.callsOf('coldStart');
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.detail?.['profileDirectory'], 'profiles/regular');
});

// `SCHEMA.md` §1.2 and §3.15: the signed-in browser is headed, and that is
// the entire reason the keeper tab is a correctness mechanism. A fake that
// reported both as headless would make #56's test unable to see the
// difference it exists to assert.
test('the signed-in browser reports as headed and the isolated one as headless', async () => {
  const driver = new FakeBrowserDriver();
  const regular = await driver.attach('regular', RECORD);
  const isolated = await driver.attach('private', RECORD);

  assert.equal(regular.describe().mode, 'headed');
  assert.equal(isolated.describe().mode, 'headless');
});

test('the call log handed out cannot be used to edit the log', async () => {
  const driver = new FakeBrowserDriver();
  await driver.attach('regular', RECORD);
  const snapshot = driver.calls as unknown as unknown[];
  snapshot.length = 0;

  assert.equal(driver.calls.length, 1, 'the driver kept its own record');
});

test('the tab-scoped calls record which tab they addressed', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const one = await session.openTab();
  const two = await session.openTab();
  await session.navigate(two, 'https://example.com');

  const navigations = driver.callsOf('navigate');
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0]?.tab?.driverTabId, two.driverTabId);
  assert.notEqual(one.driverTabId, two.driverTabId);
});

test('a read records every artefact it was asked for, and returns one result each', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const tab = await session.openTab();
  const results = await session.read(tab, ['snapshot', 'network', 'cookies']);

  assert.deepEqual(
    results.map((result) => result.artifact),
    ['snapshot', 'network', 'cookies'],
  );
  assert.deepEqual(driver.callsOf('read')[0]?.detail?.['artifacts'], [
    'snapshot',
    'network',
    'cookies',
  ]);
});

test('a seeded failure is spent once, so the next call answers normally', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  driver.failNext('openTab');
  await assert.rejects(session.openTab());

  const tab = await session.openTab();
  assert.equal(driver.openTabCount('regular'), 1);
  assert.equal(tab.browser, 'regular');
  // Both attempts are on the record: one failed, one did not.
  const opens = driver.callsOf('openTab');
  assert.deepEqual(
    opens.map((call) => call.failed ?? false),
    [true, false],
  );
});

// The mutation this catches: an `openTab` that adds the tab before the
// failure check. A capacity refusal's assertion is that the tab count did not
// move, and a fake that opened the tab and then threw would report a count of
// one for an operation that failed.
test('an open that fails does not leave a tab behind', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  driver.failNext('openTab');
  await assert.rejects(session.openTab());

  assert.equal(driver.openTabCount('regular'), 0);
  assert.deepEqual(await session.listTabs(), []);
});

test('clearing the log leaves the browser state alone', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  await session.openTab();
  driver.clearCalls();

  assert.deepEqual(driver.calls, []);
  assert.equal(driver.openTabCount('regular'), 1, 'a cleared log is not a closed tab');
});

test('there are exactly two browsers and the fake serves both', () => {
  assert.deepEqual([...BROWSER_IDS], ['regular', 'private']);
  // Typed as the union, so a third is a compile error rather than a runtime
  // check. This asserts the runtime list agrees with it.
  const ids: BrowserId[] = [...BROWSER_IDS];
  assert.equal(ids.length, 2);
});

test('the action list is the fixed set §3.8 names, with no way to move the foreground', () => {
  assert.deepEqual(
    [...PAGE_ACTIONS],
    [
      'click',
      'type',
      'fill',
      'press',
      'select',
      'hover',
      'check',
      'scroll',
      'resize',
      'emulate',
      'dialog',
    ],
  );
  // `foreground.never_moved` (`SCHEMA.md` §7.3) is a build rule and not this
  // list's job, but the verb must not be here to be reached by accident.
  assert.equal(
    PAGE_ACTIONS.some((action) => /front|focus|activate|raise/i.test(action)),
    false,
  );
});

// ── The capture operations added for the capture pipeline (#31, #45) ────────

test('the fake records a settle and a shutter, with the mask it was given', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const tab = await session.openTab();
  driver.clearCalls();

  const mask = [{ x: 1, y: 2, width: 3, height: 4 }];
  await session.settlePage(tab);
  await session.capture(tab, { fullPage: false, mask });

  assert.deepEqual(
    driver.calls.map((call) => call.name),
    ['settlePage', 'capture'],
  );
  // The rectangles themselves, so a pipeline that dropped the mask on the way
  // through is caught rather than merely a pipeline that passed nothing.
  assert.deepEqual(driver.callsOf('capture')[0]?.detail?.['mask'], mask);
});

test('the fake hands back a real, decodable picture at the geometry it was given', async () => {
  const driver = new FakeBrowserDriver({
    capture: { width: 300, height: 200, viewportWidth: 375, url: 'https://example.com/x' },
  });
  const session = await driver.attach('regular', RECORD);
  const tab = await session.openTab();

  const raw = await session.capture(tab, { fullPage: false });
  assert.equal(raw.width, 300);
  assert.equal(raw.height, 200);
  assert.equal(raw.viewportWidth, 375);
  assert.equal(raw.url, 'https://example.com/x');
  // Decodable, because a pipeline that decodes what it was handed must be
  // handed something decodable — otherwise every downscale test becomes a test
  // of the decoder's error path.
  const decoded = decodePng(raw.image);
  assert.equal(decoded.width, 300);
  assert.equal(decoded.height, 200);
});

test('a seeded capture failure is still RECORDED, so "asked and refused" is not "never asked"', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const tab = await session.openTab();
  driver.clearCalls();

  driver.failNext('capture');
  await assert.rejects(() => session.capture(tab, { fullPage: false }));
  assert.equal(driver.callsOf('capture').length, 1, 'the failed shutter left no trace');
  assert.equal(driver.callsOf('capture')[0]?.failed, true);
});
