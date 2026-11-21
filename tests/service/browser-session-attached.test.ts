import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import type { AttachedSessionOptions } from '../../src/browser/attached.ts';
import type { BrowserSession, TabHandle } from '../../src/browser/driver.ts';
import { StartupRefusal } from '../../src/errors.ts';
import { browserSessionProvider } from '../../src/service/browser-session.ts';
import { prepareStore } from '../../src/store/open.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * **The provider's attached branch: opened by the bridge, never by adoption.**
 *
 * ── What is under test, and what is deliberately not ─────────────────────
 *
 * `browser-session.test.ts` covers the adoption join — the race, the launch
 * bookkeeping, the wait — over the fake **driver**. None of that can show
 * what matters for `attached` (§13n): that none of it runs. An attached
 * browser is a person's own; this service never launches it, never adopts
 * it, never writes a pid or a state for it, and the relay's loopback port
 * exists only while its session lives. So these tests hold the driver
 * still — the same `FakeBrowserDriver` the neighbour file uses, with an
 * empty call list as an assertion, not as a fixture detail — and watch the
 * `attachedOpener` the seam injects.
 *
 * What the opener *does* when it really runs — waiting for the extension,
 * attaching over the bridge, refusing without one — is the attached
 * session's own conformance subject, not this file's.
 *
 * ── The mutations these kill ────────────────────────────────────────────
 *
 * - Letting `acquire` run adoption over an attached browser: the driver's
 *   call list stops being empty, and the row-state test sees `starting`.
 * - Answering `liveness` for an attached browser from the discovery-record
 *   probe: `gone` would end a person's lease on a probe that was never
 *   carried out, which is the exact lie §13n forbids about a browser this
 *   service does not own.
 * - Dropping a dead attached session **without** detaching it: the relay's
 *   port outlives the session that owned it, and the drop test counts zero
 *   detaches.
 * - Caching the attached opener's rejection: the retry test would get the
 *   same rejection twice from the memo instead of a second attempt.
 */

/** A stand-in attached session whose connection state the test controls. */
function fakeAttachedSession(browser: string): BrowserSession & {
  setConnected(connected: boolean): void;
  detachCount(): number;
} {
  const handle: TabHandle = { browser, driverTabId: 'tab-1' };
  let connected = true;
  let detaches = 0;
  const reject = (): never => {
    throw new Error('an attached session refuses to write; this test never exercises that half');
  };
  return {
    // The same convention `attached.ts`'s own describe uses: headed, and
    // pid 0 for "not this process's child to know".
    describe: () => ({
      browser,
      mode: 'headed' as const,
      pid: 0,
      discovery: { endpoint: 'ws://127.0.0.1:1/cdp/x' },
    }),
    isConnected: () => connected,
    openTab: () => Promise.resolve(handle),
    listTabs: () => Promise.resolve([handle]),
    ensureKeeperTab: () => Promise.resolve(handle),
    detach: () => {
      detaches += 1;
      connected = false;
      return Promise.resolve();
    },
    closeTab: () => Promise.resolve('closed'),
    navigate: reject,
    seedStorage: reject,
    act: reject,
    read: reject,
    cookies: reject,
    evaluate: reject,
    settlePage: reject,
    capture: reject,
    setConnected: (value: boolean) => {
      connected = value;
    },
    detachCount: () => detaches,
  };
}

async function withAttachedStore(
  fn: (
    store: Awaited<ReturnType<typeof prepareStore>>,
    temp: {
      environment: ReturnType<typeof makeTempStore>['environment'];
      remove: () => void;
    },
  ) => Promise<void>,
): Promise<void> {
  const temp = makeTempStore({
    attachedBrowsers: ['chrome'],
    attachedTabs: 3,
    // A syntactically valid 32-character extension id, invented for this
    // file: what is under test is plumbing, and no real extension exists
    // here or could.
    attachedExtensionId: 'abcdefghijklmnopqrstuvwxyz012345',
    attachedToken: 'a-token-never-logged',
    attachedActSites: [],
    ownerGrantSecret: undefined,
    // A configured binary for the attached name — the open path needs it to
    // run the connect page. It is never executed here: the opener is always
    // injected, so no spawn happens and no file has to exist.
    browserPaths: new Map([['chrome', 'the-configured-binary']]),
  });
  const store = await prepareStore(temp.environment);
  try {
    await fn(store, temp);
  } finally {
    store.close();
    temp.remove();
  }
}

test('an attached browser is opened by the opener, and the driver is never asked anything', async () => {
  await withAttachedStore(async (store, temp) => {
    const driver = new FakeBrowserDriver();
    const openers: AttachedSessionOptions[] = [];
    const opened = fakeAttachedSession('chrome');
    const provider = browserSessionProvider({
      store,
      environment: temp.environment,
      driver,
      isRunning: () => Promise.resolve(undefined),
      attachedOpener: (options) => {
        openers.push(options);
        return Promise.resolve(opened);
      },
    });

    const session = await provider.session('chrome');
    assert.equal(session, opened, 'the provider handed back the attached session');
    assert.equal(openers.length, 1, 'the opener ran exactly once');
    const options = openers[0];
    assert.ok(options !== undefined);
    assert.equal(options.browser, 'chrome');
    assert.equal(options.extensionId, 'abcdefghijklmnopqrstuvwxyz012345');
    assert.equal(options.token, 'a-token-never-logged');
    // The group title is the configured name: true of every lease against
    // this browser, and carrying nothing any caller sent.
    assert.equal(options.clientName, 'chrome');
    // The configured binary rides through to the opener — it is what the
    // open path runs on the connect URL, the only thing that can carry the
    // relay's random endpoint to the extension. Without this line the
    // doctor's binary check checks a value nothing uses.
    assert.equal(options.browserPath, 'the-configured-binary');

    // **The physical half: adoption never ran.** No launch, no attach, and
    // nothing recorded in the store about a process this service does not
    // own — the row for `chrome` is whatever the claim left it, and this
    // file never claimed, so it is simply absent.
    assert.deepEqual(driver.calls, [], 'adoption ran over an attached browser');
    const row = store.db
      .prepare<[string], { state: string; pid: number | null }>(
        'SELECT state, pid FROM browsers WHERE id = ?',
      )
      .get('chrome');
    assert.ok(row === undefined || (row.state === 'stopped' && row.pid === null));
  });
});

test('the attached session is memoised like every other — one bridge per browser per process', async () => {
  await withAttachedStore(async (store, temp) => {
    let opens = 0;
    const provider = browserSessionProvider({
      store,
      environment: temp.environment,
      driver: new FakeBrowserDriver(),
      isRunning: () => Promise.resolve(undefined),
      attachedOpener: () => {
        opens += 1;
        return Promise.resolve(fakeAttachedSession('chrome'));
      },
    });

    const first = await provider.session('chrome');
    const second = await provider.session('chrome');
    assert.equal(first, second);
    assert.equal(opens, 1, 'a second page verb must not open a second bridge');
  });
});

test('a dead attached session is detached before it is dropped: its port must not outlive it', async () => {
  await withAttachedStore(async (store, temp) => {
    const sessions: ReturnType<typeof fakeAttachedSession>[] = [];
    const provider = browserSessionProvider({
      store,
      environment: temp.environment,
      driver: new FakeBrowserDriver(),
      isRunning: () => Promise.resolve(undefined),
      attachedOpener: () => {
        const s = fakeAttachedSession('chrome');
        sessions.push(s);
        return Promise.resolve(s);
      },
    });

    const first = (await provider.session('chrome')) as ReturnType<typeof fakeAttachedSession>;
    first.setConnected(false); // the extension went away — isConnected is false

    const second = (await provider.session('chrome')) as ReturnType<typeof fakeAttachedSession>;
    assert.notEqual(first, second, 'the dead session must not be handed out again');
    assert.equal(first.detachCount(), 1, 'the dead session must close its bridge');
    assert.equal(second.detachCount(), 0, 'the fresh session stays open');
  });
});

test('liveness never guesses at an attached browser: unknown, not gone', async () => {
  await withAttachedStore(async (store, temp) => {
    // Even with a row that looks dead — `running` with nothing behind it,
    // which for an OWN browser means `gone` — an attached browser answers
    // `unknown`: `gone` downgrades leases, and this service has no probe
    // that could honestly call a person's browser dead.
    store.db
      .prepare(`INSERT INTO browsers (id, kind, state) VALUES ('chrome', 'attached', 'stopped')`)
      .run();

    const provider = browserSessionProvider({
      store,
      environment: temp.environment,
      driver: new FakeBrowserDriver(),
      isRunning: () => Promise.resolve(undefined),
      attachedOpener: () => Promise.resolve(fakeAttachedSession('chrome')),
    });

    assert.equal(await provider.liveness('chrome'), 'unknown');
    // And the ordinary browsers still answer through the probe — the
    // attached branch did not take the probe away from the kinds that own
    // their processes.
    assert.equal(await provider.liveness('regular'), 'unknown');
  });
});

test('a configured attached browser with no extension id refuses by name, before any opener', async () => {
  const temp = makeTempStore({ attachedBrowsers: ['chrome'] });
  // The environment read by `readEnvironment` refuses this pairing at
  // startup; this fixture reaches it by construction, which is exactly the
  // defensive half the acquire comment promises.
  const environment = { ...temp.environment, attachedExtensionId: undefined };
  const store = await prepareStore(temp.environment);
  try {
    let opened = 0;
    const provider = browserSessionProvider({
      store,
      environment,
      driver: new FakeBrowserDriver(),
      isRunning: () => Promise.resolve(undefined),
      attachedOpener: () => {
        opened += 1;
        return Promise.resolve(fakeAttachedSession('chrome'));
      },
    });

    await assert.rejects(
      () => provider.session('chrome'),
      (error: unknown) =>
        error instanceof StartupRefusal && error.rule === 'attached.bad_extension_id',
    );
    assert.equal(opened, 0, 'the opener ran for a browser with nothing to route to');
  } finally {
    store.close();
    temp.remove();
  }
});

test('a failed attached open is not cached: the next caller tries again', async () => {
  await withAttachedStore(async (store, temp) => {
    let attempts = 0;
    const provider = browserSessionProvider({
      store,
      environment: temp.environment,
      driver: new FakeBrowserDriver(),
      isRunning: () => Promise.resolve(undefined),
      attachedOpener: () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('the extension was not there yet'));
        return Promise.resolve(fakeAttachedSession('chrome'));
      },
    });

    await assert.rejects(() => provider.session('chrome'));
    const session = await provider.session('chrome');
    assert.ok(session, 'the second caller got a session after the first failed');
    assert.equal(attempts, 2, 'the rejection must not poison the memo');
  });
});
