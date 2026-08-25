import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright-core';

import { KEEPER_TAB_URL } from '../../src/browser/real.ts';
import { RealBrowserDriver, modeFor } from '../../src/browser/real.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { teardownBrowser, temporaryProfileRoot } from '../helpers/browser-fixture.ts';

/**
 * **A tab is addressable by a connection that did not open it.**
 *
 * ── Why this needs a real browser, and cannot be faked ──────────────────
 *
 * The claim is about identity *as the browser assigns it*: that two
 * independent connections to one browser name the same page identically. A
 * fake decides both names itself, so it can only ever confirm its own
 * convention — `fake.ts` says as much, that it "proves what the service asked
 * for, never that a browser would have obliged".
 *
 * ── Why the claim matters, stated as the state it rules out ─────────────
 *
 * This service is **daemonless**: it is spawned by its caller, serves that
 * session and exits with it. So a command line running one command per process
 * is the ordinary arrangement, and every command after the first reaches a
 * browser it did not start and a page it did not open.
 *
 * A name minted per connection — an ordinal, a counter — describes the order
 * one connection happened to enumerate pages in, which is a fact about the
 * connection. Two connections then disagree, and the store's own
 * `one_row_per_physical_tab` index becomes a rule about nothing: it would
 * cheerfully hold while two rows named two different physical tabs the same
 * thing, or one physical tab went by two names.
 *
 * ── Where these run ─────────────────────────────────────────────────────
 *
 * They drive a real browser, so each skips by name when there is not one.
 * Continuous integration runs on hosted runners with no browser installed, so
 * this suite is local-only and a green pipeline is not evidence it executed.
 * Headless throughout: nothing here is about a window being drawn.
 */

const available = browserAvailable();

/**
 * The debugging protocol's own name for the keeper page.
 *
 * Read through an independent connection rather than out of the session under
 * test, so the value is the browser's answer rather than anything the code
 * being tested decided. The keeper is the blank page, which is what
 * `KEEPER_TAB_URL` makes it.
 */
async function keeperTargetIdOf(
  profileDirectory: string,
  session: { describe: () => { discovery: { endpoint: string } } },
): Promise<string | undefined> {
  void profileDirectory;
  const connection = await chromium.connectOverCDP(session.describe().discovery.endpoint);
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

test(
  'two connections give the same page the same name',
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
      await first.navigate(opened, 'data:text/html,<title>the page under test</title>');

      // A second, entirely separate connection to the same browser — which is
      // what the next spawned process is.
      const record = first.describe().discovery;
      const second = await driver.attach('private', record);

      try {
        const seen = await second.listTabs();
        assert.ok(
          seen.some((tab) => tab.driverTabId === opened.driverTabId),
          'the second connection knows the first connection’s tab by the same name',
        );

        // **The assertion that would pass on a coincidence, made unable to.**
        // With one tab open, a per-connection counter gives both connections
        // "1" and this would hold while proving nothing. So a second tab is
        // opened from the second connection and the names must still be
        // distinct and stable across both.
        const extra = await second.openTab();
        assert.notEqual(extra.driverTabId, opened.driverTabId);

        const fromFirst = await first.listTabs();
        const namesFromFirst = fromFirst.map((tab) => tab.driverTabId).sort();
        const namesFromSecond = (await second.listTabs()).map((tab) => tab.driverTabId).sort();
        assert.deepEqual(
          namesFromFirst,
          namesFromSecond,
          'both connections report the same set of names for the same set of pages',
        );

        await second.closeTab(extra);
      } finally {
        await second.detach();
      }
    } finally {
      await teardownBrowser(first, profileRoot);
    }
  },
);

test(
  'a page opened by one connection is DRIVEN by another',
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
      await first.navigate(opened, 'data:text/html,<title>first</title><p id=where>first</p>');

      const second = await driver.attach('private', first.describe().discovery);
      try {
        // **Driven, not merely named.** The previous test proves the name
        // travels; this proves the page does. Navigating from the second
        // connection and then reading the result back **out of the page**
        // through the first is what distinguishes "the call returned" from
        // "the page moved" — a lookup that resolved to the wrong page, or to
        // nothing, cannot satisfy both halves.
        await second.navigate(opened, 'data:text/html,<title>second</title><p id=where>second</p>');

        const observed = await first.evaluate(opened, 'document.title');
        assert.equal(
          observed.value,
          'second',
          'the connection that opened the page sees the change the other one made to it',
        );
      } finally {
        await second.detach();
      }
    } finally {
      await teardownBrowser(first, profileRoot);
    }
  },
);

test(
  'a name that matches no live page is refused rather than resolved to some other page',
  { skip: available ? false : skipReason() },
  async () => {
    const profileRoot = temporaryProfileRoot();
    const profileDirectory = path.join(profileRoot, 'private');
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    const session = await driver.coldStart({
      browser: 'private',
      profileDirectory,
      mode: modeFor('private'),
    });

    try {
      // A real tab exists, so "there is a page to accidentally pick" is true —
      // which is the condition under which adopting-by-search could go wrong.
      const real = await session.openTab();
      await session.navigate(real, 'data:text/html,<title>a real page</title>');

      await assert.rejects(
        async () =>
          await session.navigate(
            { browser: 'private', driverTabId: 'a-name-no-page-has' },
            'data:text/html,<title>should never happen</title>',
          ),
        /No page is open/u,
        'an unknown name resolves to nothing rather than to whatever page was to hand',
      );

      // And the page that does exist was left alone by the failed lookup.
      const title = await session.evaluate(real, 'document.title');
      assert.equal(title.value, 'a real page');
    } finally {
      await teardownBrowser(session, profileRoot);
    }
  },
);

test(
  'the keeper tab stays unaddressable, even by name',
  { skip: available ? false : skipReason() },
  async () => {
    const profileRoot = temporaryProfileRoot();
    const profileDirectory = path.join(profileRoot, 'private');
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    const session = await driver.coldStart({
      browser: 'private',
      profileDirectory,
      mode: modeFor('private'),
    });

    try {
      const keeper = await session.ensureKeeperTab();

      // **A caller cannot drive what it cannot name** (§3.13). Adopting pages
      // by the browser's own name is a new way to reach a page, so the keeper
      // has to be excluded from it explicitly — otherwise the mechanism that
      // makes a tab addressable across processes would quietly make the keeper
      // addressable too.
      await assert.rejects(
        async () => await session.navigate(keeper, 'data:text/html,<title>no</title>'),
        /No page is open/u,
      );

      // It is also absent from the list capacity is derived from.
      const listed = await session.listTabs();
      assert.ok(!listed.some((tab) => tab.driverTabId === keeper.driverTabId));

      // ── The assertion above is not sufficient on its own ────────────────
      //
      // The keeper's handle carries a **sentinel** name rather than a page's
      // one, so the rejection above is satisfied by the name simply matching
      // no page — it would still hold if the keeper were freely adoptable.
      // Measured: deleting the keeper check from the adoption search leaves
      // that assertion passing.
      //
      // So the keeper is asked for **the browser's own name for it**, which is
      // the only name that could reach it through the adoption path, and the
      // refusal is required against that. This is what actually pins the
      // exclusion.
      const keeperTargetId = await keeperTargetIdOf(profileDirectory, session);
      assert.ok(keeperTargetId !== undefined, 'the keeper page was found to name');
      await assert.rejects(
        async () =>
          await session.navigate(
            { browser: 'private', driverTabId: keeperTargetId },
            'data:text/html,<title>no</title>',
          ),
        /No page is open/u,
        'the keeper is unreachable even by the name the browser gives it',
      );
    } finally {
      await teardownBrowser(session, profileRoot);
    }
  },
);
