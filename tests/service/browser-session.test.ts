import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import type { DiscoveryRecord } from '../../src/browser/driver.ts';
import { StartupRefusal } from '../../src/errors.ts';
import { browserSessionProvider } from '../../src/service/browser-session.ts';
import { prepareStore, type StoreHandle } from '../../src/store/open.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * A clock and a sleep that advance together, with no real wall-clock wait.
 *
 * Row #55's readiness bound must be provably deterministic: a test that
 * proved "refuses at the bound" by actually waiting out a real timeout would
 * be a slow, flaky proxy for the same assertion this makes instantly and
 * exactly. `sleepImpl` moves the fake clock forward by the requested amount
 * before resolving, so `now() >= deadline` in `waitForWinner` becomes true on
 * exactly the poll where real time would have crossed it — no jitter, no
 * scheduling dependency, no elapsed wall-clock time at all.
 */
function fakeClock(startedAt = 0): {
  readonly nowImpl: () => number;
  readonly sleepImpl: (ms: number) => Promise<void>;
} {
  let time = startedAt;
  return {
    nowImpl: () => time,
    sleepImpl: (ms: number) => {
      time += ms;
      return Promise.resolve();
    },
  };
}

/**
 * The join between the adoption arbitration and the driver that performs it.
 *
 * ── Why the fake driver is the right instrument here, and where it is not ──
 *
 * What is under test is **which of the driver's two acts this module performs,
 * and what it writes to the store either side of them** — a launch when nothing
 * is running, an attach when something is, a wait when somebody else won the
 * race, and the recorded outcome in every case. None of that is a claim about
 * a browser's behaviour, so none of it needs one; the fake's call log is the
 * observation, and `fake.ts` is explicit that this is the boundary of what it
 * can prove.
 *
 * What a fake cannot show is that a browser started this way is genuinely
 * reachable, or that a page opened in one process can be driven from the next.
 * Those are measured against a real browser in `tests/browser/`.
 */

/** A verified record, as the running check hands one back. */
const RUNNING: DiscoveryRecord = {
  endpoint: 'http://127.0.0.1:9333',
  browserUuid: 'a-browser-that-answered',
};

async function withStore(fn: (store: StoreHandle) => Promise<void> | void): Promise<void> {
  const temp = makeTempStore();
  const store = await prepareStore(temp.environment);
  try {
    await fn(store);
  } finally {
    store.close();
    temp.remove();
  }
}

/** The environment a provider is built against, with this store's paths. */
function environmentFor(store: StoreHandle): Parameters<typeof browserSessionProvider>[0] {
  return {
    store,
    environment: {
      databasePath: store.location,
      configuredDatabasePath: undefined,
      artifactsRoot: 'artifacts',
      profileRoot: 'profiles',
      tabBudget: 4,
      leaseSeconds: 600,
      queueSeconds: 300,
      // The declared default (§6.2, row #55). Tests that need to exercise the
      // launch-readiness bound itself override `waitTimeoutMs` directly
      // rather than this field, which mirrors how `tabBudget` above is a
      // provider-level default that individual tests already override.
      launchReadinessTimeoutSeconds: 30,
      regularBrowsers: ['regular'],
      privateBrowsers: ['private'],
      regularBrowserEngine: 'msedge',
      privateBrowserEngine: 'msedge',
    },
  };
}

test('nothing reaches a browser until a session is actually asked for', async () => {
  await withStore((store) => {
    const driver = new FakeBrowserDriver();

    browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(undefined),
    });

    // **Building the provider is not connecting.** Every command that never
    // drives a page — a claim, a release, a refusal, the doctor — goes through
    // a runtime that built one of these, and none of them may depend on a
    // browser being installed.
    assert.deepEqual(driver.calls, []);
  });
});

test('a browser that is not running is cold-started, detached, and recorded', async () => {
  await withStore(async (store) => {
    const driver = new FakeBrowserDriver();
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(undefined),
    });

    await provider.session('private');

    const starts = driver.callsOf('coldStart');
    assert.equal(starts.length, 1, 'exactly one browser was started');
    assert.equal(driver.callsOf('attach').length, 0, 'nothing was attached to');

    // The row is the durable half, and it is what a *later* process reads to
    // decide it should attach rather than start a second browser.
    const row = store.db
      .prepare<[], { state: string; endpoint: string | null }>(
        "SELECT state, endpoint FROM browsers WHERE id = 'private'",
      )
      .get();
    assert.equal(row?.state, 'running');
    assert.ok(
      row?.endpoint !== null && row?.endpoint !== undefined,
      'the endpoint was recorded, which is the whole point of recording the launch',
    );
  });
});

test('a browser that IS running is attached to rather than started again', async () => {
  await withStore(async (store) => {
    const driver = new FakeBrowserDriver();
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(RUNNING),
    });

    await provider.session('regular');

    assert.equal(driver.callsOf('attach').length, 1, 'it attached');
    // **The assertion that matters.** A second browser against one profile
    // directory hands its address to the first, opening no
    // endpoint — so starting one here would fail silently rather than loudly.
    assert.equal(driver.callsOf('coldStart').length, 0, 'and started nothing');
  });
});

test('a launch that fails gives the race back, so the next caller is not stranded', async () => {
  await withStore(async (store) => {
    const driver = new FakeBrowserDriver();
    driver.failNext('coldStart', new Error('this browser refused to start'));

    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(undefined),
    });

    await assert.rejects(async () => await provider.session('private'));

    // Without this the row stays `starting` for ever and **every later caller
    // waits for a launch that is never coming** — a machine-wide stall caused
    // by one process failing once.
    const row = store.db
      .prepare<[], { state: string }>("SELECT state FROM browsers WHERE id = 'private'")
      .get();
    assert.equal(row?.state, 'stopped', 'the race was released rather than held');
  });
});

test('a failed acquisition is not remembered, so the next call tries again', async () => {
  await withStore(async (store) => {
    const driver = new FakeBrowserDriver();
    driver.failNext('coldStart', new Error('a transient failure'));

    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(undefined),
    });

    await assert.rejects(async () => await provider.session('private'));

    // Caching the rejection would end this process's ability to drive a page
    // for the rest of its life, over one transient failure — and a process
    // serves a whole session.
    await provider.session('private');
    assert.equal(driver.callsOf('coldStart').length, 2, 'it tried a second time');
  });
});

test('one session per browser, however many verbs ask for one', async () => {
  await withStore(async (store) => {
    const driver = new FakeBrowserDriver();
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(undefined),
    });

    const first = await provider.session('private');
    const second = await provider.session('private');

    assert.equal(first, second, 'the same session came back');
    // Re-acquiring would re-enter a race the store has already decided, and
    // open a second connection per page verb.
    assert.equal(driver.callsOf('coldStart').length, 1);
  });
});

test('two verbs racing in one process await one acquisition, not two', async () => {
  await withStore(async (store) => {
    const driver = new FakeBrowserDriver();
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(undefined),
    });

    // Started together and never awaited in between, which is the shape the
    // memo has to hold for: caching the *promise* rather than the resolved
    // session is what makes this one launch instead of two.
    const [a, b] = await Promise.all([provider.session('private'), provider.session('private')]);

    assert.equal(a, b);
    assert.equal(driver.callsOf('coldStart').length, 1);
  });
});

test('the two browsers are acquired separately, and neither stands in for the other', async () => {
  await withStore(async (store) => {
    const driver = new FakeBrowserDriver();
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(undefined),
    });

    const regular = await provider.session('regular');
    const priv = await provider.session('private');

    assert.notEqual(regular, priv, 'they are different browsers and different sessions');
    assert.deepEqual(
      driver.callsOf('coldStart').map((call) => call.browser),
      ['regular', 'private'],
      'each was started as itself',
    );
  });
});

test('a launch-race loser waits for the winner and attaches to what it started', async () => {
  await withStore(async (store) => {
    // Somebody else has already taken the race, which is what `starting` means.
    store.db
      .prepare("UPDATE browsers SET state = 'starting', pid = 4321 WHERE id = 'private'")
      .run();

    const driver = new FakeBrowserDriver();
    const clock = fakeClock();
    let looks = 0;
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      // Not there yet, then there — which is the whole of what winning a race
      // and being reachable being different moments looks like from outside.
      // `isRunning` is `browserIsRunning`'s seam: this fakes its *result*,
      // which is exactly what §1.2c's liveness-and-identity check produces
      // once it has run, without needing a real endpoint to poll.
      isRunning: () => {
        looks += 1;
        return Promise.resolve(looks < 3 ? undefined : RUNNING);
      },
      waitPollIntervalMs: 1,
      waitTimeoutMs: 5_000,
      ...clock,
    });

    await provider.session('private');

    assert.equal(driver.callsOf('attach').length, 1, 'it attached to the winner’s browser');
    // **The loser launches nothing.** A second browser against one profile
    // directory is the silent-collision failure the race exists to prevent —
    // this is the assertion #55's acceptance criteria calls out by name.
    assert.equal(
      driver.callsOf('coldStart').length,
      0,
      'a loser that successfully waited must never have started its own browser',
    );
  });
});

test('a loser that waits too long refuses, and still launches nothing', async () => {
  await withStore(async (store) => {
    store.db
      .prepare("UPDATE browsers SET state = 'starting', pid = 4321 WHERE id = 'private'")
      .run();

    const driver = new FakeBrowserDriver();
    const clock = fakeClock();
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(undefined),
      waitPollIntervalMs: 1,
      waitTimeoutMs: 20,
      ...clock,
    });

    await assert.rejects(
      async () => await provider.session('private'),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal, 'it refused rather than throwing anything');
        // Reported as *this caller stopped waiting*, never as *the winner
        // failed* — nothing here observed the winner failing. The message
        // must be distinguishable from "the browser died": it names a
        // caller that is still starting, not a browser that crashed.
        assert.match(error.message, /did not become reachable/u);
        assert.match(
          error.message,
          /still starting, not a browser that has died/u,
          'declare-failed must read differently from "the browser died" — this loser observed no failure, only a bound',
        );
        return true;
      },
    );

    assert.equal(driver.callsOf('coldStart').length, 0, 'still nothing was launched');

    // And the winner keeps its race: this caller writes nothing to the row, so
    // the next caller asks the same question rather than finding it answered.
    const row = store.db
      .prepare<[], { state: string }>("SELECT state FROM browsers WHERE id = 'private'")
      .get();
    assert.equal(row?.state, 'starting');
  });
});

test('the wait is bounded by no real elapsed time — the deadline is the injected clock alone', async () => {
  await withStore(async (store) => {
    store.db
      .prepare("UPDATE browsers SET state = 'starting', pid = 4321 WHERE id = 'private'")
      .run();

    const driver = new FakeBrowserDriver();
    // A ten-minute bound, polled every ten seconds. If this were a real sleep
    // the test would hang for the full ten minutes; with the fake clock it
    // resolves in a handful of iterations, proving "bounded, not a fixed
    // pause you have to wait out" rather than asserting it in prose.
    const clock = fakeClock();
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(undefined),
      waitPollIntervalMs: 10_000,
      waitTimeoutMs: 10 * 60 * 1000,
      ...clock,
    });

    const startedAt = Date.now();
    await assert.rejects(async () => await provider.session('private'));
    const elapsedRealMs = Date.now() - startedAt;

    assert.ok(
      elapsedRealMs < 2_000,
      `a ten-minute bound resolved using ${String(elapsedRealMs)}ms of real time — the clock injection is not being used`,
    );
  });
});

test('a stale discovery record — endpoint answers, wrong browser — is not mistaken for the winner', async () => {
  await withStore(async (store) => {
    store.db
      .prepare("UPDATE browsers SET state = 'starting', pid = 4321 WHERE id = 'private'")
      .run();

    const driver = new FakeBrowserDriver();
    const clock = fakeClock();
    // **`isRunning` here returns a record, not `undefined`** — the case
    // `browserIsRunning`'s own contract names as "read off disk but not yet
    // checked against a live browser" (`src/browser/discovery.ts`): the
    // endpoint is present, `browserUuid` is not. That is what stale-but-
    // reachable looks like, and it is a different fake outcome from the
    // "nothing there yet" timeout test above — that one fakes `undefined`
    // throughout, which exercises "record absent", not "record present but
    // unverified". This is the case the loop's own identity guard
    // (`record.browserUuid !== undefined`) exists to reject: a record could
    // read as ready on liveness alone if the guard were ever removed, which
    // is exactly the reused-port collision §1.2c forbids trusting.
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve({ endpoint: 'http://127.0.0.1:9333' }),
      waitPollIntervalMs: 1,
      waitTimeoutMs: 20,
      ...clock,
    });

    await assert.rejects(async () => await provider.session('private'));

    assert.equal(
      driver.callsOf('attach').length,
      0,
      'a record present but missing browserUuid must never be attached to — presence alone is a claim, not a proof',
    );
    assert.equal(
      driver.callsOf('coldStart').length,
      0,
      'and must not be treated as licence to launch a second browser either',
    );
  });
});

test('the wait bound actually comes from environment.launchReadinessTimeoutSeconds, not just from waitTimeoutMs', async () => {
  await withStore(async (store) => {
    store.db
      .prepare("UPDATE browsers SET state = 'starting', pid = 4321 WHERE id = 'private'")
      .run();

    const driver = new FakeBrowserDriver();
    const clock = fakeClock();
    const base = environmentFor(store);

    // **No `waitTimeoutMs` here.** Every other test in this file overrides
    // the bound directly, which proves the loop honours an injected override
    // but never proves it reads `environment.launchReadinessTimeoutSeconds`
    // at all — a regression that hardcoded `WAIT_TIMEOUT_MS` in its place
    // would pass every one of them. This is the production construction
    // path: the only bound supplied is the environment field itself, set
    // small enough here to reach without a real wait.
    const provider = browserSessionProvider({
      ...base,
      environment: { ...base.environment, launchReadinessTimeoutSeconds: 0.02 },
      driver,
      isRunning: () => Promise.resolve(undefined),
      waitPollIntervalMs: 1,
      ...clock,
    });

    await assert.rejects(
      async () => await provider.session('private'),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal);
        // 0.02s * 1000 = 20ms — the bound only reaches this message if the
        // environment field, not some hardcoded fallback, set the deadline.
        assert.match(error.message, /did not become reachable within 20ms/u);
        return true;
      },
    );

    assert.equal(driver.callsOf('coldStart').length, 0, 'still nothing was launched');
  });
});

test('closing detaches from what was opened, and does not close the browser', async () => {
  await withStore(async (store) => {
    const driver = new FakeBrowserDriver();
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(undefined),
    });

    await provider.session('private');
    await provider.close();

    assert.equal(driver.callsOf('detach').length, 1, 'it let go of the connection');
    // **Browsers are adopted, not owned.** There is deliberately no
    // close-browser call on the seam to make, and a process exiting must leave
    // the browser exactly where it found it.
    assert.equal(
      driver.calls.filter((call) => call.name === 'closeTab').length,
      0,
      'and closed nothing on the way out',
    );
  });
});
