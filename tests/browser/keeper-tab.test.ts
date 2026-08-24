import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { RealBrowserDriver } from '../../src/browser/real.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { teardownBrowser, temporaryProfileRoot } from '../helpers/browser-fixture.ts';

/**
 * ⚠️ THIS SUITE RUNS **HEADED**, DELIBERATELY, AND MUST STAY THAT WAY. ⚠️
 *
 * ── Why, in full, because the comment is the guard ──────────────────────
 *
 * **Measured, on this browser, and re-measured while writing this row:**
 *
 * | Browser | Closing the last remaining tab |
 * |---|---|
 * | Headless | **The browser stays alive.** Nothing is lost |
 * | **Headed** | **The browser dies**, within about half a second |
 *
 * **The signed-in browser is headed.** So without a keeper tab the sequence
 * is: the last caller finishes, releases its lease, its tab closes, that was
 * the only tab, and **the browser exits — taking the shared authenticated
 * session with it.** The person who signed in by hand finds out at the least
 * convenient moment. The release path is the *ordinary* path, so this is not
 * an edge case; it is what happens every time the machine goes quiet.
 *
 * ── What that means for this file specifically ──────────────────────────
 *
 * **A headless version of this test passes with the keeper tab deleted.** The
 * behaviour it protects against does not occur headless, so every assertion
 * here would still be green with the mechanism removed. A future cleanup pass
 * would read the keeper tab as dead weight, remove it, get a green run, and
 * be *confirmed in the removal*.
 *
 * So:
 *
 * > **Running headed is what makes this test capable of failing. The comment
 * > is what stops somebody converting it to headless for speed and being
 * > rewarded with a tick.**
 *
 * **The single-character change that breaks this test is flipping the headed
 * flag on the browser it launches** — which is exactly the change this
 * comment exists to argue with. If you are here because the suite is slow or
 * because a runner has no display: the answer is to skip it, which it already
 * does by itself, and **never** to run it headless.
 *
 * ── Where it runs ──────────────────────────────────────────────────────
 *
 * It needs a real browser and a display, so it skips when either is absent
 * and **states the skip** rather than passing quietly. Continuous integration
 * runs on hosted runners with neither, so this is a test that runs locally
 * and is skipped there — recorded here so nobody reads a green pipeline as
 * evidence that it ran.
 */

const available = browserAvailable();

test(
  'HEADED: a browser survives its last leased tab closing, because the keeper tab remains',
  { skip: available ? false : skipReason() },
  async () => {
    const profileRoot = temporaryProfileRoot();
    const profileDirectory = path.join(profileRoot, 'regular');

    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    // `mode: 'headed'` is the whole point. See this file's header before
    // changing it — a headless run here asserts nothing at all.
    const session = await driver.coldStart({
      browser: 'regular',
      profileDirectory,
      mode: 'headed',
    });

    try {
      const description = session.describe();
      assert.equal(
        description.mode,
        'headed',
        'this test is meaningless unless the browser is headed',
      );

      // ── This test must NOT establish the keeper itself ────────────────
      //
      // `keeper.present` (§7.2) is a precondition the **service** owes on
      // every path that reaches a browser, so this test asserts the service
      // did it — it does not call `ensureKeeperTab` to make it true.
      //
      // That distinction is the difference between a real test and a hollow
      // one, and it was found the hard way: an earlier version of this test
      // called `ensureKeeperTab` here, which re-established the keeper even
      // with every production call site deleted. The mutation survived, the
      // suite stayed green, and the test proved only that a method it called
      // itself did what it said.
      //
      // ── Why every counted tab is closed, and not just the one leased ──
      //
      // A cold start leaves the browser on a blank page, so a run that
      // opened one lease and closed it would leave that startup page behind
      // — and the browser would survive on **its** account rather than the
      // keeper's. Verified while writing this row: with the keeper removed
      // entirely, such a test still passes, which makes it hollow.
      //
      // So the test drives the state the keeper actually exists for: the
      // moment when **every tab the budget counts is gone.** `listTabs`
      // excludes the keeper by definition, so closing everything it reports
      // is exactly "the last caller released its lease" — and without a
      // keeper there would now be nothing open at all.
      const leased = await session.openTab();
      await session.closeTab(leased);

      for (const remaining of await session.listTabs()) {
        await session.closeTab(remaining);
      }
      assert.deepEqual(
        await session.listTabs(),
        [],
        'every tab the budget counts must be closed for this test to be testing anything',
      );

      // Headed, the browser dies within about half a second of its final tab
      // closing. Waiting comfortably longer than that is what makes a pass
      // mean the browser survived rather than that the check was early.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const endpoint = description.discovery.endpoint;
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(
        response.ok,
        true,
        'the browser must still be alive and re-attachable after its last leased tab closed',
      );
    } finally {
      // Detached from and then ended, because this browser is a test fixture.
      // The service itself never ends a browser — see the seam.
      await teardownBrowser(session, profileRoot);
    }
  },
);

test(
  'HEADED: the keeper tab is not counted against the budget and is not addressable',
  { skip: available ? false : skipReason() },
  async () => {
    const profileRoot = temporaryProfileRoot();
    const profileDirectory = path.join(profileRoot, 'regular');
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    const session = await driver.coldStart({
      browser: 'regular',
      profileDirectory,
      mode: 'headed',
    });

    try {
      await session.ensureKeeperTab();

      // Nothing leased yet, so nothing is counted — even though a tab is
      // certainly open. Counting the keeper would make the tab budget one
      // lower than it says (§3.15).
      assert.deepEqual(await session.listTabs(), []);

      const leased = await session.openTab();
      const listed = await session.listTabs();
      assert.equal(listed.length, 1, 'only the leased tab counts against the budget');
      assert.equal(listed[0]?.driverTabId, leased.driverTabId);

      // A caller cannot close what it cannot name (§3.13): the keeper's
      // handle resolves to no page, so closing it is a no-op rather than a
      // destroyed keeper.
      const keeper = await session.ensureKeeperTab();
      await session.closeTab(keeper);
      await session.closeTab(leased);

      await new Promise((resolve) => setTimeout(resolve, 2000));
      const response = await fetch(`${session.describe().discovery.endpoint}/json/version`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.ok, true, 'closing the keeper by its handle must not have worked');
    } finally {
      // Detached from and then ended, because this browser is a test fixture.
      // The service itself never ends a browser — see the seam.
      await teardownBrowser(session, profileRoot);
    }
  },
);

test(
  'HEADED: establishing the keeper twice adopts the one already there',
  { skip: available ? false : skipReason() },
  async () => {
    const profileRoot = temporaryProfileRoot();
    const profileDirectory = path.join(profileRoot, 'regular');
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    const session = await driver.coldStart({
      browser: 'regular',
      profileDirectory,
      mode: 'headed',
    });

    try {
      // Idempotent: it runs on every spawn and before every grant, so a
      // second call must adopt rather than open another blank tab —
      // otherwise a browser accumulates one uncounted tab per spawn.
      const first = await session.ensureKeeperTab();
      const second = await session.ensureKeeperTab();
      assert.equal(first.driverTabId, second.driverTabId);
      assert.deepEqual(await session.listTabs(), []);
    } finally {
      // Detached from and then ended, because this browser is a test fixture.
      // The service itself never ends a browser — see the seam.
      await teardownBrowser(session, profileRoot);
    }
  },
);
