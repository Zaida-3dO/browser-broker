import assert from 'node:assert/strict';
import test from 'node:test';

import type { BrowserSession, TabHandle } from '../../src/browser/driver.ts';
import { CAPTURES_BEFORE_WARNING } from '../../src/capture/tiers.ts';
import { blankImage, encodePng } from '../../src/diff/image.ts';
import { claimInput, withBroker, type BrokerFixture } from '../helpers/broker.ts';

/**
 * **`pageDriven` is a report of what happened, never a prediction of it.**
 *
 * ── The failure this file exists to catch, stated as a mechanism ─────────
 *
 * After-commit work is best effort and **every failure in it is swallowed**
 * (`SCHEMA.md` §2.4b). That is correct — the transaction has committed, the
 * capacity is taken and the lease is renewed, and a browser that will not
 * answer must not be able to unmake a durable decision.
 *
 * The consequence is that a browser which fails to launch, refuses to attach,
 * or dies partway through an operation produces **no error on any surface**.
 * So if `pageDriven` were computed from *whether a session was supplied*, it
 * would answer `true` for every one of those, and a caller would be told
 * `accepted` for a navigation that never happened — the same defect this field
 * was introduced to remove, told with more confidence.
 *
 * ── Why each test here fails the browser rather than omitting it ─────────
 *
 * A test that supplies no session proves only that the no-browser path is
 * still honest, and that path was honest before. The interesting state is
 * **a session that was supplied and then did not work**, because that is the
 * one where the report and the reality can disagree. Every test below
 * therefore hands in a real session source and makes the browser fail, and
 * asserts the operation is still `accepted`, still durable in the store, and
 * says `pageDriven: false`.
 */

/**
 * A session whose every page verb rejects, as a browser that has died does.
 *
 * ── `openTab` rejects too, and that is not incidental ───────────────────
 *
 * An earlier version of this fixture let `openTab` succeed while every other
 * verb threw, on the reasoning that opening a tab is not a page verb. It made
 * `tab_replace` report `pageDriven: true` — **correctly**, because the only
 * browser work that verb does on a tab that was never opened *is* opening the
 * replacement, and that had genuinely happened.
 *
 * So the fixture was describing a browser that is broken for some calls and
 * healthy for others, which is not what a dead browser is. A browser that has
 * stopped answering does not open tabs either, and with the fixture saying so
 * the assertion measures the failure rather than a gap between two verbs'
 * definitions of one.
 */
function brokenSession(failure = new Error('the browser stopped answering')): BrowserSession {
  const reject = (): never => {
    throw failure;
  };
  const handle: TabHandle = { browser: 'regular', driverTabId: 'driver-tab' };

  return {
    describe: () => ({
      browser: 'regular' as const,
      mode: 'headless' as const,
      pid: 1,
      discovery: { endpoint: 'endpoint' },
    }),
    openTab: reject,
    listTabs: () => Promise.resolve([handle]),
    ensureKeeperTab: () => Promise.resolve(handle),
    detach: () => Promise.resolve(),
    closeTab: reject,
    navigate: reject,
    seedStorage: reject,
    act: reject,
    read: reject,
    cookies: reject,
    evaluate: reject,
    settlePage: reject,
    capture: reject,
  };
}

/**
 * A session that works, for the positive half of each pair.
 *
 * ── Every `openTab` returns a DIFFERENT tab, and that is not decoration ──
 *
 * The store carries `CREATE UNIQUE INDEX one_row_per_physical_tab ON tabs
 * (browser_id, driver_tab_id)`, because two leases cannot hold one physical
 * tab. A fixture handing the same name to every caller therefore describes a
 * browser that cannot exist, and the second lease's tab collides on insert —
 * inside after-commit work, where the failure is swallowed, so it surfaces as
 * a mysterious `pageDriven: false` rather than as an error.
 *
 * Counting per session is exactly what a real browser does differently: it
 * assigns each page its own identity. Getting this wrong once cost an hour of
 * chasing a product defect that was a fixture describing an impossible world.
 */
function workingSession(): BrowserSession {
  const handle: TabHandle = { browser: 'regular', driverTabId: 'driver-tab' };
  let opened = 0;
  return {
    describe: () => ({
      browser: 'regular' as const,
      mode: 'headless' as const,
      pid: 1,
      discovery: { endpoint: 'endpoint' },
    }),
    openTab: () => {
      opened += 1;
      return Promise.resolve({
        browser: 'regular' as const,
        driverTabId: `driver-tab-${String(opened)}`,
      });
    },
    listTabs: () => Promise.resolve([handle]),
    ensureKeeperTab: () => Promise.resolve(handle),
    detach: () => Promise.resolve(),
    closeTab: () => Promise.resolve(),
    navigate: (_tab, url) => Promise.resolve({ url, title: 'a title', status: 200 }),
    seedStorage: () => Promise.resolve(),
    act: () =>
      Promise.resolve({
        artifact: 'snapshot' as const,
        path: 'a/path',
        bytes: 1,
        truncated: false,
      }),
    read: (_tab, artifacts) =>
      Promise.resolve(
        artifacts.map((artifact) => ({ artifact, path: 'a/path', bytes: 1, truncated: false })),
      ),
    cookies: () => Promise.resolve([]),
    evaluate: () => Promise.resolve({ value: { ok: true }, bytes: 13 }),
    settlePage: () => Promise.resolve(),
    capture: () =>
      Promise.resolve({
        image: encodePng(blankImage(8, 6)),
        width: 8,
        height: 6,
        viewportWidth: 8,
        url: 'https://example.com/',
      }),
  };
}

async function grantedLease(
  fixture: BrokerFixture,
): Promise<{ key: string; tabId: string; claimId: string }> {
  const granted = await fixture.broker.claim(claimInput());
  assert.equal(granted.outcome, 'granted');
  if (granted.outcome !== 'granted') throw new Error('unreachable');
  return { key: granted.key, tabId: granted.tabId, claimId: granted.claimId };
}

test('a browser that fails mid-operation reports the page as NOT driven', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);

    const result = await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: 'https://example.com/',
      session: () => brokenSession(),
    });

    // The arbitration half genuinely happened, so the outcome is genuinely
    // accepted and the lease was genuinely extended. Reporting a refusal here
    // would be a second lie in the opposite direction (§5.6).
    assert.equal(result.url, 'https://example.com/');
    assert.equal(
      result.pageDriven,
      false,
      'the browser threw and the caller was told the page did not move',
    );
  });
});

test('a session that cannot be obtained at all reports the page as NOT driven', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);

    // The shape of a browser that is not installed, or lost its launch race:
    // resolving the session is itself what fails, before any verb is reached.
    const result = await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: 'https://example.com/',
      session: () => {
        throw new Error('no browser could be started');
      },
    });

    assert.equal(result.pageDriven, false);
  });
});

test('a browser that works reports the page as driven', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);

    const result = await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: 'https://example.com/',
      session: () => workingSession(),
    });

    // **The other half of the pair.** Without this, a `pageDriven` hard-wired
    // to `false` would satisfy every test above — which is exactly the shape
    // where correct and incorrect behaviour coincide.
    assert.equal(result.pageDriven, true);
  });
});

test('every page verb answers the same way, so none can be honest while another is not', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const broken = () => brokenSession();
    const working = () => workingSession();

    const failed = [
      (await fixture.broker.navigate({ ...lease, url: 'https://example.com/', session: broken }))
        .pageDriven,
      (
        await fixture.broker.act({
          ...lease,
          request: { action: 'click', ref: 'e1' },
          session: broken,
        })
      ).pageDriven,
      (await fixture.broker.read({ ...lease, session: broken })).pageDriven,
      (await fixture.broker.evaluate({ ...lease, expression: '1 + 1', session: broken }))
        .pageDriven,
      (await fixture.broker.capture({ ...lease, session: broken, artifacts: fixture.artifacts }))
        .pageDriven,
    ];

    assert.deepEqual(
      failed,
      [false, false, false, false, false],
      'no verb claimed a page it did not drive',
    );

    const drove = [
      (await fixture.broker.navigate({ ...lease, url: 'https://example.com/', session: working }))
        .pageDriven,
      (
        await fixture.broker.act({
          ...lease,
          request: { action: 'click', ref: 'e1' },
          session: working,
        })
      ).pageDriven,
      (await fixture.broker.read({ ...lease, session: working })).pageDriven,
      (await fixture.broker.evaluate({ ...lease, expression: '1 + 1', session: working }))
        .pageDriven,
      (await fixture.broker.capture({ ...lease, session: working, artifacts: fixture.artifacts }))
        .pageDriven,
    ];

    assert.deepEqual(drove, [true, true, true, true, true], 'and each reported the page it drove');
  });
});

test('tab_replace answers with the same expression as the other five', async () => {
  await withBroker(async (fixture) => {
    const first = await grantedLease(fixture);

    // **It matters more here than anywhere else.** This verb exchanges the tab
    // in the store whether or not a browser was reached, so a caller told only
    // that the swap succeeded would believe it holds a clean page — when what
    // it holds is a fresh identifier over a row still `opening` with nothing
    // under it.
    const failed = await fixture.broker.tab_replace({
      key: first.key,
      tabId: first.tabId,
      session: () => brokenSession(),
    });
    assert.notEqual(failed.tabId, first.tabId, 'the swap happened in the store regardless');
    assert.equal(failed.pageDriven, false, 'and the caller was told no page is under it');

    const second = await grantedLease(fixture);
    const drove = await fixture.broker.tab_replace({
      key: second.key,
      tabId: second.tabId,
      session: () => workingSession(),
    });
    assert.equal(drove.pageDriven, true);
  });
});

test('a failed page verb still commits its decision, its renewal and its ledger row', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);

    const result = await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: 'https://example.com/',
      session: () => brokenSession(),
    });

    // Read through the second, read-only connection: the durability is the
    // claim being made, and a read through the writing handle could see a
    // write that had not committed.
    const kinds = fixture
      .readCommitted<{ kind: string }>('SELECT kind FROM events ORDER BY id')
      .map((row) => row.kind);
    assert.ok(
      kinds.includes('navigate'),
      'the ledger records the decision, which is what makes it a decision',
    );

    // The renewal is the other durable half, and it is why a refusal would be
    // wrong here: the lease has already been extended by this call.
    const rows = fixture.readCommitted<{ expiresAt: string }>(
      'SELECT expires_at AS expiresAt FROM claims WHERE id = @id',
      { id: lease.claimId },
    );
    assert.equal(rows[0]?.expiresAt, result.expiresAt);
  });
});

test('a capture whose browser failed writes no row and no file', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);

    const result = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => brokenSession(),
      artifacts: fixture.artifacts,
    });

    assert.equal(result.pageDriven, false);
    assert.equal(result.capture, undefined, 'no path was reported for a picture that is not there');

    // **The measurement the honest-outcomes row was written against.** A
    // capture reporting `accepted` while this count is zero is the exact
    // observation `pageDriven` exists to describe, so the count and the field
    // have to agree.
    const [count] = fixture.readCommitted<{ taken: number }>(
      'SELECT count(*) AS taken FROM captures',
    );
    assert.equal(count?.taken, 0);
  });
});

test('a capture that worked writes exactly one row, and the row describes the file', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);

    const result = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => workingSession(),
      artifacts: fixture.artifacts,
    });

    assert.equal(result.pageDriven, true);
    assert.ok(result.capture !== undefined, 'the caller was told where the picture went');

    const rows = fixture.readCommitted<{
      id: string;
      path: string;
      bytes: number;
      width: number;
      height: number;
    }>('SELECT id, path, bytes, width, height FROM captures');

    assert.equal(rows.length, 1);
    // The row and the answer are the same picture rather than two accounts of
    // one, which is what makes the count a usable check on the answer.
    assert.equal(rows[0]?.id, result.capture.captureId);
    assert.equal(rows[0]?.path, result.capture.path);
    assert.equal(rows[0]?.bytes, result.capture.bytes);
    // **Never absolute** (§1.7a): a stored path names one machine otherwise.
    assert.ok(!rows[0].path.startsWith('/') && !/^[A-Za-z]:/u.test(rows[0].path));
  });
});

test('a session with nowhere to put a picture does not press the shutter', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const asked: string[] = [];
    const session = workingSession();
    const watched: BrowserSession = {
      ...session,
      capture: (tab, request) => {
        asked.push('capture');
        return session.capture(tab, request);
      },
    };

    const result = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => watched,
      // No artifact store, which is the whole variable being tested.
    });

    // Taking a picture and dropping it is the behaviour being prevented: it
    // costs a round trip and produces nothing anybody can look at.
    assert.deepEqual(asked, [], 'the browser was never asked for a picture');
    assert.equal(result.pageDriven, false, 'and the caller was told so');
  });
});

test('the count of a lease’s captures is what drives the accounting warning', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    // **One session for the whole test**, which is what the runtime supplies:
    // it memoises one connection per browser per process. A fresh session per
    // call would restart the tab numbering and hand two leases the same tab.
    const one = workingSession();
    const session = () => one;

    // Up to and including the threshold, nothing is warned about. The
    // boundary is asserted from both sides deliberately: a `warned` hard-wired
    // either way satisfies one side and fails the other, and a count read from
    // the wrong lease would drift off the boundary rather than sit on it.
    for (let taken = 0; taken < CAPTURES_BEFORE_WARNING; taken += 1) {
      await fixture.broker.capture({ ...lease, session, artifacts: fixture.artifacts });
    }

    const upToThreshold = fixture.readCommitted<{ warned: number }>('SELECT warned FROM captures');
    assert.equal(upToThreshold.length, CAPTURES_BEFORE_WARNING);
    assert.ok(
      upToThreshold.every((row) => row.warned === 0),
      'nothing up to the threshold was recorded as warned',
    );

    // The next one is past it, and the row says so. **Recorded rather than
    // only returned**: the column is what a later study of how callers use
    // captures reads, and a warning that fired without being written down is
    // invisible to it.
    await fixture.broker.capture({ ...lease, session, artifacts: fixture.artifacts });

    const afterThreshold = fixture.readCommitted<{ warned: number }>(
      'SELECT warned FROM captures ORDER BY rowid',
    );
    assert.equal(afterThreshold.length, CAPTURES_BEFORE_WARNING + 1);
    assert.equal(
      afterThreshold[CAPTURES_BEFORE_WARNING]?.warned,
      1,
      'the capture past the threshold was recorded as warned',
    );

    // **And the count is per lease, not per store.** A fresh lease starts at
    // zero, so a global count would warn it immediately on its first capture.
    const other = await grantedLease(fixture);
    await fixture.broker.capture({ ...other, session, artifacts: fixture.artifacts });
    const [fresh] = fixture.readCommitted<{ warned: number }>(
      'SELECT warned FROM captures WHERE claim_id = @id',
      { id: other.claimId },
    );
    assert.equal(fresh?.warned, 0, 'a new lease’s first capture is not past anybody’s threshold');
  });
});
