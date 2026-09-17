import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright-core';

import { KEEPER_TAB_URL, RealBrowserDriver, modeFor } from '../../src/browser/real.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { teardownBrowser, temporaryProfileRoot } from '../helpers/browser-fixture.ts';

/**
 * **That closing a tab works across a process boundary, and that fixing it
 * did not make the keeper closable.**
 *
 * ── The defect ──────────────────────────────────────────────────────────
 *
 * `closeTab` resolved the page from the session's own `#pages` map and
 * **returned** on a miss, while every other page verb resolved through the
 * adoption path. So closing was the one operation that stopped working across
 * a process boundary — and this service is daemonless, spawned per caller, so
 * the process releasing a lease is routinely not the one that opened its tab.
 * Three pages from released leases sat visibly open while the store recorded
 * twelve rows `closed, close_failed = 0`.
 *
 * ── Why these need a real browser ───────────────────────────────────────
 *
 * Both claims are about what the **browser** has open, and only a browser can
 * be asked. A fake answers out of the same map the code under test writes,
 * which confirms its own convention rather than the fact — `fake.ts` says as
 * much, that it "proves what the service asked for, never that a browser
 * would have obliged".
 *
 * Each observation is therefore taken over an **independent CDP connection**,
 * held by neither party to the close. Asking the session under test whether it
 * closed a page lets an implementation that merely *forgot* the page report
 * success, and a page forgotten and a page closed look identical from inside
 * and completely different from outside — which is exactly the field defect.
 *
 * ── Where these run ─────────────────────────────────────────────────────
 *
 * They drive a real browser, so each skips by name when there is not one.
 * Continuous integration runs on hosted runners with no browser installed, so
 * this suite is local-only and **a green pipeline is not evidence it
 * executed**. Headless throughout: nothing here is about a window being drawn.
 */

const available = browserAvailable();

/**
 * The debugging protocol's own name for the keeper page.
 *
 * Read over an independent connection rather than out of the session under
 * test, so the value is the browser's answer rather than anything the code
 * being tested decided. The keeper is the blank page, which is what
 * `KEEPER_TAB_URL` makes it.
 *
 * Deliberately duplicated from `cross-process-tab.test.ts` rather than shared.
 * The point of this helper is to be an *independent* reading, and a shared
 * copy imported from a file whose own assertions depend on it is one edit away
 * from both tests agreeing with each other about something neither checked.
 */
async function keeperTargetIdOf(endpoint: string): Promise<string | undefined> {
  const connection = await chromium.connectOverCDP(endpoint);
  try {
    const [context] = connection.contexts();
    if (context === undefined) return undefined;
    for (const page of context.pages()) {
      if (page.url() !== KEEPER_TAB_URL) continue;
      const cdp = await context.newCDPSession(page);
      try {
        const info = (await cdp.send('Target.getTargetInfo')) as {
          targetInfo: { targetId: string };
        };
        return info.targetInfo.targetId;
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    }
    return undefined;
  } finally {
    await connection.close();
  }
}

/** Every page the browser currently has open, asked of a third connection. */
async function openPages(endpoint: string): Promise<{ urls: string[]; titles: string[] }> {
  const connection = await chromium.connectOverCDP(endpoint);
  try {
    const [context] = connection.contexts();
    if (context === undefined) return { urls: [], titles: [] };
    const live = context.pages().filter((page) => !page.isClosed());
    const titles = await Promise.all(live.map(async (page) => await page.title().catch(() => '')));
    return { urls: live.map((page) => page.url()), titles };
  } finally {
    await connection.close();
  }
}

test(
  'A TAB OPENED BY ONE CONNECTION IS REALLY CLOSED BY ANOTHER',
  { skip: available ? false : skipReason() },
  async () => {
    const profileRoot = temporaryProfileRoot();
    const profileDirectory = path.join(profileRoot, 'private');
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    const first = await driver.coldStart({
      browser: 'private',
      profileDirectory,
      mode: modeFor('private'),
    });

    try {
      const opened = await first.openTab();
      await first.navigate(opened, 'data:text/html,<title>the page to be closed</title>');

      // The second connection is what the next spawned process is: it has
      // never seen this tab and holds nothing in its own map.
      const record = first.describe().discovery;
      const second = await driver.attach('private', record);

      let outcome: string;
      try {
        // **Closed by the connection that did not open it, without calling
        // `listTabs` first.** That ordering is load-bearing: `listTabs` runs
        // `#track()` and populates the map, so a test that listed first would
        // pass against the broken implementation. `reconcile` works today only
        // because it happens to list first — which is exactly how this defect
        // stayed hidden from the one command built to find leaked pages.
        outcome = await second.closeTab(opened);
      } finally {
        await second.detach();
      }

      assert.equal(
        outcome,
        'closed',
        'the connection that did not open the tab reported it had not closed it',
      );

      const after = await openPages(record.endpoint);
      assert.ok(
        !after.titles.includes('the page to be closed'),
        `the page survived a close that reported success — the browser still has it open (${after.titles.join(', ')})`,
      );
    } finally {
      await teardownBrowser(first, profileRoot);
    }
  },
);

test(
  'THE KEEPER SURVIVES A CLOSE NAMED BEFORE ensureKeeperTab HAS RUN',
  { skip: available ? false : skipReason() },
  async () => {
    // ── The hazard this test exists for, stated precisely ───────────────
    //
    // Keeper safety used to be **structural and accidental**: the keeper's
    // page was never in `#pages`, so the old `closeTab` could not resolve it.
    // The keeper survived because closing was broken. Fixing the close removes
    // that guarantee, and the obvious replacement — `#adopt`'s
    // `page === this.#keeper.page` check — **is not sufficient on its own**,
    // because `#keeper` initialises to `{ page: undefined }`.
    //
    // So a connection that has just attached to a running browser and has not
    // yet called `ensureKeeperTab` compares the keeper against `undefined`,
    // matches nothing, adopts it like any other page, and closes it. On the
    // shared signed-in browser — which is headed — that ends the browser
    // within about half a second, taking a session a person signed in to by
    // hand.
    //
    // **The ordering is the entire test.** `ensureKeeperTab` is deliberately
    // NOT called on the closing session before the close: calling it would
    // populate `#keeper.page`, the identity check would hold, and this would
    // pass against an implementation that protects the keeper by identity
    // alone — i.e. against the very hazard it is written for.
    const profileRoot = temporaryProfileRoot();
    const profileDirectory = path.join(profileRoot, 'private');
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    const first = await driver.coldStart({
      browser: 'private',
      profileDirectory,
      mode: modeFor('private'),
    });

    try {
      // Established on the FIRST connection, so a keeper genuinely exists in
      // the browser — the state any later process attaches into.
      await first.ensureKeeperTab();
      const record = first.describe().discovery;

      // The browser's own name for the keeper page. This is the only name that
      // could reach the keeper through the adoption path, so it is the name
      // the attack has to use: the sentinel handle `ensureKeeperTab` returns
      // would be turned away by a check on the handle alone, and would prove
      // nothing about whether the keeper is adoptable.
      const keeperTargetId = await keeperTargetIdOf(record.endpoint);
      assert.ok(keeperTargetId !== undefined, 'the keeper page was found to name');

      const fresh = await driver.attach('private', record);

      let outcome: string;
      try {
        // **No `ensureKeeperTab` on `fresh` before this line.** See above.
        outcome = await fresh.closeTab({ browser: 'private', driverTabId: keeperTargetId });
      } finally {
        await fresh.detach();
      }

      assert.notEqual(
        outcome,
        'closed',
        'a freshly attached session reported closing the keeper — this ends the shared signed-in browser',
      );

      // The returned outcome is the implementation's own account of what it
      // did; the keeper still being open is the fact. Both are asserted,
      // because an implementation could refuse in its report and close anyway
      // — and on a headed browser there is no second chance to notice.
      const after = await openPages(record.endpoint);
      assert.ok(
        after.urls.includes(KEEPER_TAB_URL),
        'THE KEEPER IS GONE: a session that had not established it closed it by the name the browser gave it',
      );
    } finally {
      await teardownBrowser(first, profileRoot);
    }
  },
);
