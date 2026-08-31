import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { portFilePath, readDiscoveryRecord } from '../../src/browser/discovery.ts';
import { browserIsRunning, modeFor, RealBrowserDriver } from '../../src/browser/real.ts';
import { StartupRefusal } from '../../src/errors.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import {
  reapProcessesUsingProfile,
  teardownBrowser,
  temporaryProfileRoot,
} from '../helpers/browser-fixture.ts';

/**
 * The real driver: attaching, cold-starting, and refusing.
 *
 * ── Which of these need a browser, and which do not ─────────────────────
 *
 * The refusals do not: attaching to an unidentifiable record is a decision
 * made **before** anything is connected to, which is the whole point of it,
 * so it is provable with no browser anywhere. Those tests run everywhere,
 * including on a hosted runner.
 *
 * The rest do, and they **skip with a stated reason** rather than passing
 * quietly. Continuous integration has no browser, so those are local-only —
 * recorded here so a green pipeline is not read as evidence they ran.
 */

const available = browserAvailable();

test('the two browsers have fixed modes, and the signed-in one is the headed one', () => {
  // The fact the keeper tab exists for (§3.15): the regular browser is the
  // headed one, and headed is the mode in which closing the last tab kills it.
  assert.equal(modeFor('regular'), 'headed');
  assert.equal(modeFor('private'), 'headless');
});

// The mutation this catches: attaching on a record that carries only an
// address. A record read off disk has not been checked against a live
// browser, and attaching to a stranger is worse than failing to attach —
// because it succeeds.
test('attaching refuses a record with no browser identifier, before connecting to anything', async () => {
  const driver = new RealBrowserDriver();
  await assert.rejects(
    // No `browserUuid`: the ordinary state of a record read off disk.
    driver.attach('regular', { endpoint: 'http://127.0.0.1:1' }),
    StartupRefusal,
  );
});

// The reused-port case, driven through an injected endpoint so it is
// deterministic. A real browser cannot be made to hand its port to an
// unrelated process on demand.
test('attaching refuses when the endpoint answers as a different browser', async () => {
  const impostor = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/somebody-else',
        }),
        { status: 200 },
      ),
    )) as unknown as typeof fetch;

  const driver = new RealBrowserDriver({ fetchImpl: impostor });
  await assert.rejects(
    driver.attach('regular', {
      endpoint: 'http://127.0.0.1:1',
      browserUuid: 'the-one-we-recorded',
    }),
    (error: unknown) => error instanceof StartupRefusal && /different browser/i.test(error.message),
  );
});

test('attaching refuses when the endpoint does not answer at all', async () => {
  const dead = (() => Promise.reject(new Error('connection refused'))) as unknown as typeof fetch;
  const driver = new RealBrowserDriver({ fetchImpl: dead });
  await assert.rejects(
    driver.attach('regular', { endpoint: 'http://127.0.0.1:1', browserUuid: 'anything' }),
    StartupRefusal,
  );
});

test('a profile with no record reports no browser running', async () => {
  const root = temporaryProfileRoot();
  try {
    assert.equal(await browserIsRunning(path.join(root, 'regular')), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The measured case, stated as a test: a record whose endpoint is dead means
// the browser is NOT running, so whichever caller notices takes the launch
// race rather than attaching to nothing.
test('a stale record whose endpoint is dead reports no browser running', async () => {
  const root = temporaryProfileRoot();
  try {
    const profile = path.join(root, 'regular');
    fs.mkdirSync(profile, { recursive: true });
    // Port 1 answers nothing, which is what a killed browser leaves behind.
    fs.writeFileSync(portFilePath(profile), '1\n/devtools/browser/long-gone');

    assert.equal(await browserIsRunning(profile), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'a cold start writes a record, and it names a browser that actually answers',
  { skip: available ? false : skipReason() },
  async () => {
    const root = temporaryProfileRoot();
    const profileDirectory = path.join(root, 'private');
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    const session = await driver.coldStart({
      browser: 'private',
      profileDirectory,
      mode: 'headless',
    });

    try {
      // The record lives inside the profile directory that IS the identity,
      // so it cannot drift from what it describes (§1.2c).
      const found = readDiscoveryRecord(profileDirectory);
      assert.ok(found, 'the browser must have recorded where it can be reached');

      // Success is an endpoint that answers, asserted positively — never
      // inferred from the launch command not failing.
      const verified = await browserIsRunning(profileDirectory);
      assert.ok(verified, 'the recorded endpoint must actually answer');
      assert.ok(verified.browserUuid, 'and it must identify itself');

      // The process identifier is the isolation fact: the service acts on
      // the process it recorded and on nothing else.
      assert.ok(session.describe().pid > 0);
    } finally {
      await teardownBrowser(session, root);
    }
  },
);

test(
  'a second caller ATTACHES to the running browser rather than starting another',
  { skip: available ? false : skipReason() },
  async () => {
    const root = temporaryProfileRoot();
    const profileDirectory = path.join(root, 'private');
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    const first = await driver.coldStart({
      browser: 'private',
      profileDirectory,
      mode: 'headless',
    });

    try {
      const record = await browserIsRunning(profileDirectory);
      assert.ok(record);

      // The ordinary case: everyone after the first attaches.
      const second = await driver.attach('private', record);
      try {
        // Attaching and detaching are non-destructive — the property the
        // whole shared-session design rests on (§1.2a). A tab opened by the
        // first caller is still there for the second.
        //
        // The assertion is on the COUNT rather than on the identifier, and
        // the distinction is real: `driverTabId` is the driver's own name for
        // a page, minted per session, so two sessions naming the same page
        // will not agree on what to call it. Comparing the names across
        // sessions would be asserting something this design never promised —
        // §1.4 puts the stable identifier in the store, and mapping between
        // the two is row #21's.
        const before = (await second.listTabs()).length;
        await first.openTab();

        // ── Measured, and worth writing down rather than sleeping blindly ──
        //
        // A page one connection opens becomes visible to another **a moment
        // later**, not synchronously: the second connection learns about it
        // over the debugging protocol, so an immediate read still sees the
        // count from before. Measured while building this row — zero
        // immediately after the open, one a fraction of a second later.
        //
        // This polls to a deadline instead of pausing for a fixed time,
        // because a fixed pause is a number that is too long on every fast
        // machine and too short on the one slow machine where it matters. It
        // fails by timing out rather than by asserting on a stale read, so
        // a genuine regression still fails rather than becoming flaky.
        const deadline = Date.now() + 10_000;
        let after = (await second.listTabs()).length;
        while (after !== before + 1 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          after = (await second.listTabs()).length;
        }

        assert.equal(
          after,
          before + 1,
          'a tab opened by one caller is visible to another attached to the same browser',
        );

        await second.detach();

        // Detaching ends this process's connection and nothing else: the
        // browser outlives it, which is the entire model.
        const stillThere = await browserIsRunning(profileDirectory);
        assert.ok(stillThere, 'detaching must not have ended the browser');
      } finally {
        // Already detached above on the success path; a second detach on a
        // closed connection is harmless and keeps the failure path tidy.
        await second.detach().catch(() => undefined);
      }
    } finally {
      await teardownBrowser(first, root);
    }
  },
);

// THE inward-isolation assertion this row owes. "Do not disturb the wrong
// browser" cannot be tested; "starts while something else already holds the
// default profile" can, and that is the one that is written down.
test(
  'a browser starts cleanly while an UNRELATED browser already holds another profile',
  { skip: available ? false : skipReason() },
  async () => {
    const root = temporaryProfileRoot();
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    // Stands in for whatever else on the machine got there first. It is a
    // separate profile directory, which is exactly the arrangement that makes
    // the two independent: without an explicit path they would collide.
    const unrelated = await driver.coldStart({
      browser: 'private',
      profileDirectory: path.join(root, 'somebody-elses-browser'),
      mode: 'headless',
    });

    try {
      const ours = await driver.coldStart({
        browser: 'private',
        profileDirectory: path.join(root, 'private'),
        mode: 'headless',
      });

      try {
        // Both are up at once, and neither disturbed the other.
        assert.ok(await browserIsRunning(path.join(root, 'private')));
        assert.ok(await browserIsRunning(path.join(root, 'somebody-elses-browser')));
        assert.notEqual(ours.describe().pid, unrelated.describe().pid);
      } finally {
        await teardownBrowser(ours, path.join(root, 'private'));
      }
    } finally {
      await teardownBrowser(unrelated, root);
    }
  },
);

// The measured silent-collision case: a second browser against a profile
// already in use hands its address to the first and EXITS ZERO, opening no
// endpoint of its own. A launcher that inferred success from the command
// returning would report a browser it never started.
test(
  'a second cold start against a profile already in use is REFUSED, not reported as a launch',
  { skip: available ? false : skipReason() },
  async () => {
    const root = temporaryProfileRoot();
    const profileDirectory = path.join(root, 'private');
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    const first = await driver.coldStart({
      browser: 'private',
      profileDirectory,
      mode: 'headless',
    });

    try {
      await assert.rejects(
        driver.coldStart({ browser: 'private', profileDirectory, mode: 'headless' }),
        (error: unknown) =>
          error instanceof StartupRefusal && /already running|already in use/i.test(error.message),
        'a launch must never be inferred from the command exiting',
      );

      // And the browser that was already there is untouched.
      assert.ok(await browserIsRunning(profileDirectory));
    } finally {
      // `launch.ts` deliberately never kills the losing spawn on this path —
      // its whole model of a collision is that the second process "hands its
      // address to the first and exits zero" on its own, so `coldStartDetached`
      // throws with no PID for anything to reap. Measured here: on Windows
      // that spawn does NOT exit on its own, and nothing else in the
      // production sweep reconciles orphaned OS processes — only claims and
      // tabs. See `reapProcessesUsingProfile` for why this is scoped to this
      // test's own directory rather than a change to `launch.ts`'s kill rule.
      reapProcessesUsingProfile(profileDirectory);
      await teardownBrowser(first, root);
    }
  },
);
