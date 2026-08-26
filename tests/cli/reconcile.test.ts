import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import type { BrowserSession } from '../../src/browser/driver.ts';
import { run } from '../../src/cli/index.ts';
import { COMMAND_EXIT } from '../../src/cli/operations-commands.ts';
import { recordTabOpened, reserveTab } from '../../src/service/tabs.ts';
import { prepareStore } from '../../src/store/open.ts';
import { readClaimState, readTab, seedClaim } from '../helpers/leases.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * `broker reconcile` driven **through the dispatcher with an argument
 * vector**, which is the shape §8's parity claim rests on and the reason
 * `run` returns an exit code rather than calling out to the process.
 *
 * ── What these tests are for, beyond the behaviour ──────────────────────
 *
 * This repository's most recurrent defect is **a feature that is documented,
 * tested, and called by nothing in `src/`** — which is precisely why #21a
 * exists as a leftover from #21. So these tests deliberately enter through
 * `run(['reconcile', …])` rather than by calling the command function
 * directly: what they prove is that the command table, the dispatcher and the
 * wiring all agree, and that a person typing the words gets the behaviour.
 *
 * The one link they cannot prove in process is `src/bin/broker.ts` handing
 * the runtime's session provider in. `scripts/check-operations.mjs` spawns
 * the real executable, and the assertion added there covers that link.
 */

interface Captured {
  readonly out: string[];
  readonly err: string[];
}

function capture(): {
  readonly streams: { out: (l: string) => void; err: (l: string) => void };
  readonly captured: Captured;
} {
  const out: string[] = [];
  const err: string[] = [];
  return { streams: { out: (l) => out.push(l), err: (l) => err.push(l) }, captured: { out, err } };
}

function envFor(directory: string): NodeJS.ProcessEnv {
  return {
    BROKER_DB: path.join(directory, 'broker.db'),
    BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
    BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
  };
}

describe('broker reconcile', () => {
  it('closes the page no lease owns, leaves the owned one, and settles the vanished row', async () => {
    const temp = makeTempStore();
    try {
      const store = await prepareStore(temp.environment);
      const driver = new FakeBrowserDriver();
      const session = await driver.coldStart({
        browser: 'regular',
        profileDirectory: path.join(temp.directory, 'profiles', 'regular'),
        mode: 'headless',
      });

      // ── The fixture, built so right and wrong differ in *what* they name ──
      //
      // Three distinct situations at once, on one browser:
      //
      //   owned    — a live lease, and the browser has the page. Must survive.
      //   vanished — a live lease whose page the browser does not have. Must
      //              be settled, and its lease ended.
      //   stray    — a page the browser has that no row names. Must be closed.
      //
      // An implementation that closed every page passes a one-page fixture
      // and fails this one, because `owned` would go. An implementation that
      // settled every row likewise fails, because `owned`'s lease would end.
      const ownedLease = seedClaim(store.db, { browserId: 'regular' });
      const vanishedLease = seedClaim(store.db, { browserId: 'regular' });

      const ownedPage = await session.openTab();
      const ownedTab = reserveTab(store.db, ownedLease.claimId, 'regular');
      recordTabOpened(store.db, ownedTab, ownedPage.driverTabId);

      // Opened in the browser, recorded, then closed **behind the store's
      // back** — which is what a crash or a person closing a tab by hand
      // looks like from here.
      const doomedPage = await session.openTab();
      const vanishedTab = reserveTab(store.db, vanishedLease.claimId, 'regular');
      recordTabOpened(store.db, vanishedTab, doomedPage.driverTabId);
      await session.closeTab(doomedPage);

      // A page nothing ever recorded a row for.
      const strayPage = await session.openTab();

      store.close();

      const { streams, captured } = capture();
      const code = await run(['reconcile', 'regular', '--json'], {
        streams,
        env: envFor(temp.directory),
        session: () => Promise.resolve(session),
      });

      assert.equal(code, COMMAND_EXIT.accepted, captured.err.join('\n'));

      const report = JSON.parse(captured.out.join('')) as {
        browser: string;
        pages_seen: number;
        settled: string[];
        closed: number;
        close_failures: number;
        skipped_opening: number;
      };

      assert.equal(report.browser, 'regular');
      assert.equal(report.closed, 1, 'exactly one page was closed');
      assert.deepEqual(
        report.settled,
        [vanishedTab],
        'and exactly the row whose page was gone was settled',
      );
      assert.equal(report.close_failures, 0);
      assert.equal(report.skipped_opening, 0);

      // **Which page was closed, not how many.** This is the assertion a
      // count cannot make: closing the owned page instead of the stray one
      // produces the same `closed: 1`.
      const remaining = (await session.listTabs()).map((tab) => tab.driverTabId);
      assert.equal(
        remaining.includes(ownedPage.driverTabId),
        true,
        'the page a live lease owns must still be open',
      );
      assert.equal(
        remaining.includes(strayPage.driverTabId),
        false,
        'and the page no lease owned must be gone',
      );

      const after = await prepareStore(temp.environment);
      try {
        assert.equal(readTab(after.db, vanishedTab).state, 'closed');
        assert.equal(readClaimState(after.db, vanishedLease.claimId), 'revoked');
        assert.equal(readTab(after.db, ownedTab).state, 'open', 'the owned tab row is untouched');
        assert.equal(
          readClaimState(after.db, ownedLease.claimId),
          'active',
          'and its lease is still live',
        );

        // §1.6: the ledger records the decision, and records that it came in
        // through the command line because a person ran it (§4.3).
        const ledger = after.db
          .prepare(
            `SELECT adapter, claim_id AS claimId FROM events
              WHERE kind = 'claim_revoked' ORDER BY id`,
          )
          .all() as { adapter: string; claimId: string }[];
        assert.deepEqual(
          ledger.map((row) => row.claimId),
          [vanishedLease.claimId],
          'one row, for the one lease that was ended',
        );
        assert.equal(ledger[0]?.adapter, 'cli');
      } finally {
        after.close();
      }
    } finally {
      temp.remove();
    }
  });

  it('closes nothing while a tab is mid-open, and says why', async () => {
    const temp = makeTempStore();
    try {
      const store = await prepareStore(temp.environment);
      const driver = new FakeBrowserDriver();
      const session = await driver.coldStart({
        browser: 'regular',
        profileDirectory: path.join(temp.directory, 'profiles', 'regular'),
        mode: 'headless',
      });

      // The race, through the command: a lease has reserved its row and the
      // browser already has a page that nothing names yet. Closing it would
      // take a tab away from a lease granted moments ago.
      const claim = seedClaim(store.db, { browserId: 'regular' });
      reserveTab(store.db, claim.claimId, 'regular');
      const freshPage = await session.openTab();

      store.close();

      const { streams, captured } = capture();
      const code = await run(['reconcile', 'regular'], {
        streams,
        env: envFor(temp.directory),
        session: () => Promise.resolve(session),
      });

      assert.equal(code, COMMAND_EXIT.accepted, captured.err.join('\n'));

      const stillOpen = (await session.listTabs()).map((tab) => tab.driverTabId);
      assert.equal(
        stillOpen.includes(freshPage.driverTabId),
        true,
        'the page a mid-open lease is about to be handed must survive reconciliation',
      );

      const printed = captured.out.join('\n');
      assert.match(
        printed,
        /still being opened/,
        'and declining must be reported, so "0 closed" is not read as "nothing to close"',
      );
    } finally {
      temp.remove();
    }
  });

  it('refuses when there is no browser to ask, rather than settling every lease', async () => {
    const temp = makeTempStore();
    try {
      const store = await prepareStore(temp.environment);
      const claim = seedClaim(store.db, { browserId: 'regular' });
      const tab = reserveTab(store.db, claim.claimId, 'regular');
      recordTabOpened(store.db, tab, 'driver-a');
      store.close();

      const { streams, captured } = capture();
      // No `session` supplied. The destructive outcome this refusal exists to
      // prevent is exactly what a "clean run" would do here: with nothing to
      // ask, every recorded page looks absent.
      const code = await run(['reconcile', 'regular'], {
        streams,
        env: envFor(temp.directory),
      });

      assert.equal(code, COMMAND_EXIT.refused);
      assert.match(captured.err.join('\n'), /browser\.unreachable/);

      const after = await prepareStore(temp.environment);
      try {
        assert.equal(
          readClaimState(after.db, claim.claimId),
          'active',
          'a reconciliation that asked nothing must end no lease',
        );
        assert.equal(readTab(after.db, tab).state, 'open');
      } finally {
        after.close();
      }
    } finally {
      temp.remove();
    }
  });

  it('refuses a browser it does not manage, and one it was not given', async () => {
    const temp = makeTempStore();
    try {
      const store = await prepareStore(temp.environment);
      store.close();

      const unknown = capture();
      assert.equal(
        await run(['reconcile', 'chromium'], {
          streams: unknown.streams,
          env: envFor(temp.directory),
        }),
        COMMAND_EXIT.malformed,
      );
      assert.match(unknown.captured.err.join('\n'), /no browser named/i);

      const missing = capture();
      assert.equal(
        await run(['reconcile'], { streams: missing.streams, env: envFor(temp.directory) }),
        COMMAND_EXIT.malformed,
      );
      assert.match(missing.captured.err.join('\n'), /which browser/i);
    } finally {
      temp.remove();
    }
  });

  it('reports a page that would not close as a leaked page, and still succeeds', async () => {
    const temp = makeTempStore();
    try {
      const store = await prepareStore(temp.environment);
      const driver = new FakeBrowserDriver();
      const session = await driver.coldStart({
        browser: 'regular',
        profileDirectory: path.join(temp.directory, 'profiles', 'regular'),
        mode: 'headless',
      });
      const stray = await session.openTab();
      store.close();

      // §2.4b: best effort, and failure is tolerated. A wrapper that refuses
      // the close is the smallest way to drive the path.
      const refusing: BrowserSession = {
        ...session,
        closeTab: () => Promise.reject(new Error('the page would not close')),
      };

      const { streams, captured } = capture();
      const code = await run(['reconcile', 'regular', '--json'], {
        streams,
        env: envFor(temp.directory),
        session: () => Promise.resolve(refusing),
      });

      assert.equal(
        code,
        COMMAND_EXIT.accepted,
        'a page that will not close is a leaked page, not a failed run',
      );
      const report = JSON.parse(captured.out.join('')) as {
        closed: number;
        close_failures: number;
      };
      assert.equal(report.close_failures, 1);
      assert.equal(report.closed, 0);

      // The page is still there, which is what makes the count mean
      // something rather than being a number the command chose.
      assert.equal(
        (await session.listTabs()).some((tab) => tab.driverTabId === stray.driverTabId),
        true,
      );
    } finally {
      temp.remove();
    }
  });

  it('never closes the keeper tab, because listTabs does not offer it', async () => {
    const temp = makeTempStore();
    try {
      const store = await prepareStore(temp.environment);
      const driver = new FakeBrowserDriver();
      const session = await driver.coldStart({
        browser: 'regular',
        profileDirectory: path.join(temp.directory, 'profiles', 'regular'),
        mode: 'headed',
      });

      // ── The most expensive coinciding fixture this feature could have ──
      //
      // The keeper is owned by no lease, by construction (§3.15). So to any
      // reconciliation it looks exactly like the thing reconciliation exists
      // to close — and closing it kills the shared signed-in session, because
      // a headed browser dies within about half a second of its final tab
      // closing.
      //
      // What keeps it safe is that `listTabs` excludes it, which is a
      // property of the **seam** rather than of the decider. `real.ts`
      // excludes it and says so; this asserts the fake agrees, because a fake
      // that listed it would make every other test in this file agree with a
      // service that closes the keeper — evidence *for* the destructive
      // behaviour, with nothing headed in continuous integration to
      // contradict it.
      const keeper = await session.ensureKeeperTab();
      await session.openTab();
      store.close();

      const { streams, captured } = capture();
      const code = await run(['reconcile', 'regular', '--json'], {
        streams,
        env: envFor(temp.directory),
        session: () => Promise.resolve(session),
      });
      assert.equal(code, COMMAND_EXIT.accepted, captured.err.join('\n'));

      // The stray went, so reconciliation genuinely ran and genuinely closed
      // something — without this the keeper assertion below would pass
      // against a command that closed nothing at all.
      const report = JSON.parse(captured.out.join('')) as { closed: number; pages_seen: number };
      assert.equal(report.closed, 1, 'the stray page must actually have been closed');
      assert.equal(
        report.pages_seen,
        1,
        'and the keeper must not even be counted among the pages seen (§3.15)',
      );

      const openCount = driver.openTabCount('regular');
      const leasable = driver.leasableTabCount('regular');
      assert.equal(
        leasable,
        0,
        'the stray was the only page counting against the budget, and it is gone',
      );
      assert.equal(
        openCount,
        1,
        'one page remains open — the keeper, which reconciliation must never close',
      );

      assert.equal(
        (await session.listTabs()).some((tab) => tab.driverTabId === keeper.driverTabId),
        false,
        'and it remains unaddressable: listTabs still does not offer it',
      );
    } finally {
      temp.remove();
    }
  });

  it('is discoverable: the command table lists it, so `broker --help` prints it', async () => {
    // The reachability assertion made at the surface a person actually
    // touches. A command wired into the dispatcher but absent from the table
    // works and cannot be found, which §5.4's own note calls a command a
    // caller has no way to discover.
    const { streams, captured } = capture();
    const code = await run(['--help'], { streams });
    assert.equal(code, COMMAND_EXIT.accepted);
    assert.match(captured.out.join('\n'), /reconcile/);
  });
});
