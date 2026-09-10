import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import type { BrowserDriver, BrowserSession, DiscoveryRecord } from '../../src/browser/driver.ts';
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

/**
 * ── The liveness discriminator: (observation × row state) → verdict ────────
 *
 * `liveness` answers one question — is the browser this lease names still
 * there — and it answers it by combining two things: what the running check
 * observed on disk, and what the store was told. The tests below pin that
 * combination, and only that combination.
 *
 * **What these do NOT cover, said plainly.** `isRunning` is faked here, so the
 * real `browserIsRunning` — the endpoint probe, the discovery record it reads,
 * and the identity match that catches a different browser answering on a
 * reused port — is not exercised by a single assertion in this block. Faking
 * that function fakes precisely its *result*. It follows that the case these
 * cannot reach is the one that matters most about liveness: the store and the
 * operating system genuinely disagreeing, because a fake driver has no
 * operating system to disagree with.
 *
 * That case is measured against a real browser in
 * `tests/browser/dead-browser-status.test.ts`, which is the only thing that
 * proves it and remains so. **This block is not a substitute for that file**
 * and a green run here says nothing about whether a killed browser is
 * detected. What it does say is that the mapping from an observation and a row
 * to a verdict is the intended one — a different claim from the one the real
 * browser proves, and the reason these are worth their lines: the mapping is
 * pure logic over a row and a result, so it can be pinned without a machine.
 */

/** Puts a browser row into a state, honouring the pid constraint on non-stopped states. */
function setBrowserState(store: StoreHandle, browser: 'regular' | 'private', state: string): void {
  store.db
    .prepare<[string, string | null, 'regular' | 'private']>(
      'UPDATE browsers SET state = ?, pid = ? WHERE id = ?',
    )
    .run(state, state === 'stopped' ? null : '4321', browser);
}

/** A provider whose observation is fixed, for asking the discriminator one question. */
function providerObserving(
  store: StoreHandle,
  isRunning: () => Promise<DiscoveryRecord | undefined>,
): ReturnType<typeof browserSessionProvider> {
  return browserSessionProvider({
    ...environmentFor(store),
    driver: new FakeBrowserDriver(),
    isRunning,
  });
}

test('a verified record is live, whatever the store believes about the row', async () => {
  await withStore(async (store) => {
    // The observation wins outright here: the browser answered and proved
    // which browser it was, so no row state can make that untrue.
    for (const state of ['stopped', 'starting', 'running', 'signing-in', 'failed']) {
      setBrowserState(store, 'private', state);
      const provider = providerObserving(store, () => Promise.resolve(RUNNING));

      assert.equal(
        await provider.liveness('private'),
        'live',
        `a browser that answered and identified itself is live with the row at ${state}`,
      );
    }
  });
});

test('a row that says running with nothing answering is a browser that died', async () => {
  await withStore(async (store) => {
    // `recordLaunched` is what moves a row to `running`, so this row is the
    // store having been told a browser started. Nothing answers now.
    setBrowserState(store, 'private', 'running');
    const provider = providerObserving(store, () => Promise.resolve(undefined));

    assert.equal(await provider.liveness('private'), 'gone');
  });
});

test('a row that says stopped with nothing answering was never started', async () => {
  await withStore(async (store) => {
    // A lease is granted before any browser exists — acquisition is lazy — so
    // this is the ordinary life of a fresh lease rather than an edge case, and
    // calling it `gone` would end leases that are merely waiting for a launch.
    const provider = providerObserving(store, () => Promise.resolve(undefined));

    assert.equal(await provider.liveness('private'), 'unknown');
  });
});

test('the states either side of a launch are not a death either', async () => {
  await withStore(async (store) => {
    // Only `running` means the store was told a browser is up. Every other
    // state is some flavour of not-yet or not-well, and none of them can
    // support the claim that a browser was there and has since died.
    for (const state of ['starting', 'signing-in', 'failed']) {
      setBrowserState(store, 'private', state);
      const provider = providerObserving(store, () => Promise.resolve(undefined));

      assert.equal(
        await provider.liveness('private'),
        'unknown',
        `a row at ${state} has not been told a browser is running`,
      );
    }
  });
});

test('a record that failed the identity half is not a live browser', async () => {
  await withStore(async (store) => {
    setBrowserState(store, 'private', 'running');
    // Something answered on the endpoint, but it did not say which browser it
    // is — the identity half of the check, which is what catches a different
    // process on a reused port. A half-passed check is a stale record, and
    // stale means not running.
    const provider = providerObserving(store, () =>
      Promise.resolve({ endpoint: 'http://127.0.0.1:9333' } as DiscoveryRecord),
    );

    assert.equal(await provider.liveness('private'), 'gone');
  });
});

test('an observation that could not be made reports unknown, never gone', async () => {
  await withStore(async (store) => {
    // The row says running, which is the one state that would otherwise
    // produce `gone` — so if the throw were swallowed into the ordinary path
    // this would say `gone` and end a working lease on the strength of a probe
    // that observed nothing at all.
    setBrowserState(store, 'private', 'running');
    const provider = providerObserving(store, () =>
      Promise.reject(new Error('the profile directory could not be read')),
    );

    assert.equal(await provider.liveness('private'), 'unknown');
  });
});

test('finding a browser gone lets go of the session, and finding it live does not', async () => {
  await withStore(async (store) => {
    let answer: DiscoveryRecord | undefined = RUNNING;
    const provider = providerObserving(store, () => Promise.resolve(answer));

    await provider.session('private');
    assert.equal(provider.holds('private'), true, 'a session was acquired and memoised');

    // Still live: there is nothing to recover from, so the memoised session is
    // the one that keeps being handed out.
    assert.equal(await provider.liveness('private'), 'live');
    assert.equal(provider.holds('private'), true, 'a live browser keeps its session');

    // Now it has died under the memo. Dropping the entry is what makes
    // release-and-claim-again work: without it every page verb for the life of
    // this process gets the same dead attachment.
    answer = undefined;
    setBrowserState(store, 'private', 'running');

    assert.equal(await provider.liveness('private'), 'gone');
    assert.equal(provider.holds('private'), false, 'the dead session was forgotten');
  });
});

/**
 * A connection that ended under a memo that never revalidated it.
 *
 * ── The state these four tests are about ────────────────────────────────
 *
 * A session is a connection, and a connection can end while the browser it
 * points at carries on. That asymmetry is the whole subject: the browser
 * answers every liveness question truthfully with `live`, so
 * {@link BrowserSessions.liveness} correctly evicts nothing, while every page
 * verb performed over the held connection fails.
 *
 * It is reachable only from a process that outlives one verb. The command
 * line is one process per command, so its memo dies with the verb that made
 * it; the tool surface serves a whole session from one process, which is why
 * that surface is where this is not merely possible but eventually certain.
 * `FakeBrowserDriver.disconnect` is what lets the state be produced at all —
 * seeding a failure makes an operation *reject*, which is the different thing
 * the `.catch` eviction already handles.
 */

test('a memoised session whose connection has ended is not handed back', async () => {
  await withStore(async (store) => {
    const driver = new FakeBrowserDriver();
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      // Nothing is running, so each acquisition cold-starts and the count of
      // cold starts is a direct reading of how many times the memo was missed.
      isRunning: () => Promise.resolve(undefined),
    });

    const first = await provider.session('private');
    assert.equal(driver.callsOf('coldStart').length, 1);

    // The browser is untouched; only this process's connection to it ends.
    driver.disconnect('private');

    const second = await provider.session('private');

    // Delete the `isConnected()` check in `session` and this fails: the same
    // dead object comes back and `coldStart` stays at 1.
    assert.notEqual(second, first, 'a fresh session replaced the dead one');
    assert.equal(second.isConnected?.(), true, 'and the replacement is usable');
    assert.equal(driver.callsOf('coldStart').length, 2, 'it was genuinely re-acquired');
  });
});

test('a live memoised session is still handed back, so nothing re-acquires per verb', async () => {
  await withStore(async (store) => {
    const driver = new FakeBrowserDriver();
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(undefined),
    });

    const first = await provider.session('private');
    const second = await provider.session('private');

    // The guard against over-correcting: invert the `isConnected()` condition
    // and this fails. Re-acquiring per verb would re-enter a race the store
    // has already decided and open a connection per page call.
    assert.equal(second, first, 'the same session came back');
    assert.equal(driver.callsOf('coldStart').length, 1);
  });
});

test('a session source that cannot report its connection is assumed usable', async () => {
  await withStore(async (store) => {
    // A driver whose sessions predate `isConnected` — which is the reason the
    // member is optional. Such a session has **observed nothing** about its
    // connection, and the standing rule in this module is that an
    // observation which could not be made never concludes the negative:
    // `liveness` returns `unknown` rather than `gone` for exactly this
    // reason.
    const inner = new FakeBrowserDriver();
    const stripped: BrowserDriver = {
      attach: async (browser, record) => withoutIsConnected(await inner.attach(browser, record)),
      coldStart: async (request) => withoutIsConnected(await inner.coldStart(request)),
    };
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver: stripped,
      isRunning: () => Promise.resolve(undefined),
    });

    const acquired = await provider.session('private');
    assert.equal(acquired.isConnected, undefined, 'this source cannot answer the question');

    // Treat absence as disconnected and this fails: every call re-acquires,
    // for a source that never said anything was wrong.
    const again = await provider.session('private');
    assert.equal(again, acquired, 'the memo was kept');
    assert.equal(inner.callsOf('coldStart').length, 1, 'nothing re-acquired');
  });
});

/** The same session with the optional member absent, as a source may leave it. */
function withoutIsConnected(session: BrowserSession): BrowserSession {
  const { isConnected, ...rest } = session;
  // Read so that dropping it is a decision the compiler can see rather than
  // an unused-variable warning somebody silences later.
  void isConnected;
  return rest;
}

test('the dead connection is dropped for that browser alone', async () => {
  await withStore(async (store) => {
    const driver = new FakeBrowserDriver();
    const provider = browserSessionProvider({
      ...environmentFor(store),
      driver,
      isRunning: () => Promise.resolve(undefined),
    });

    const privateFirst = await provider.session('private');
    const regularFirst = await provider.session('regular');

    driver.disconnect('private');

    // Keyed per browser, which is what the field reports observed: one
    // browser served pages over the tool surface while the other was inert in
    // the same process, seconds apart. Drop both entries unconditionally here
    // and the second assertion fails.
    assert.notEqual(await provider.session('private'), privateFirst);
    assert.equal(await provider.session('regular'), regularFirst);
  });
});
