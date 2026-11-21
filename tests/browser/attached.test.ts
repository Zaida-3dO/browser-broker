import assert from 'node:assert/strict';
import test from 'node:test';

import { connect } from '../../src/attach/session.ts';
import type { AttachedBridge } from '../../src/attach/session.ts';
import { AttachedError } from '../../src/attach/errors.ts';
import {
  attachOverBridge,
  focusChainHoldsFormControl,
  openAttachedSession,
  type FocusChainElement,
} from '../../src/browser/attached.ts';
import type { ActionRequest, SecretScope, TabHandle } from '../../src/browser/driver.ts';
import { FakeExtension } from '../attach/fake-extension.ts';

/**
 * The attached session, over the relay and the fake extension.
 *
 * The point of these tests is the rule every one of them shares: **a refused
 * verb is a verb the extension was never asked to perform.** The response
 * half is easy to fake and proves nothing on its own — a guard that refuses
 * *after* `Input.dispatchMouseEvent` crossed the bridge would report a
 * refusal that did not happen, and his page would have been clicked. So every
 * rejection here reads the fake's call log as well as the error, and the
 * refusals are all decided before any page is resolved.
 *
 * The fake cannot answer an accessibility render, a screenshot, or a
 * navigation completion — it answers commands and nothing else — so the
 * happy-path halves those verbs depend on are not provable on it; where a
 * test is pinning a gate rather than a completed verb, it says so. The bridge
 * handshake itself (Playwright's real client through the relay) is pinned by
 * `tests/attach/over-cdp.test.ts`, which these tests lean on rather than
 * re-prove.
 */

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const BROWSER = 'his';

interface Live {
  bridge: AttachedBridge;
  ext: FakeExtension;
  session: Awaited<ReturnType<typeof attachOverBridge>>;
}

async function live(focusProbe?: () => Promise<readonly FocusChainElement[]>): Promise<Live> {
  const bridge = await connect({ clientName: 'attached test', extensionId: EXTENSION_ID });
  const ext = await FakeExtension.connect(bridge.extensionEndpoint, {
    origin: EXTENSION_ORIGIN,
  });
  await ext.initialize();
  const session = await attachOverBridge(bridge, {
    browser: BROWSER,
    clientName: 'attached test',
    extensionId: EXTENSION_ID,
    ...(focusProbe === undefined ? {} : { focusProbe }),
  });
  return { bridge, ext, session };
}

/** CDP methods the extension was asked to run on a tab. */
function cdpCalls(ext: FakeExtension, cdpMethod: string): unknown[] {
  return ext.calls.filter(
    (call) => call.method === 'chrome.debugger.sendCommand' && call.params[1] === cdpMethod,
  );
}

function sawCdp(ext: FakeExtension, cdpMethod: string): boolean {
  return cdpCalls(ext, cdpMethod).length > 0;
}

async function openedTab(live: Live): Promise<TabHandle> {
  return await live.session.openTab();
}

/** Wait for a condition the socket updates a turn after the request. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ── Opening ────────────────────────────────────────────────────────────────

test('a session against an extension that never connects is refused, not queued, and leaves nothing listening', async () => {
  const bridge = await connect({ clientName: 'attached test', extensionId: EXTENSION_ID });
  const endpoint = bridge.extensionEndpoint;
  await assert.rejects(
    attachOverBridge(bridge, {
      browser: BROWSER,
      clientName: 'attached test',
      extensionId: EXTENSION_ID,
      connectTimeoutMs: 500,
    }),
    (error: unknown) => error instanceof AttachedError && error.rule === 'attached.not_connected',
  );
  // The refusal closed the bridge: the contract's own rule is that nothing
  // listens after close, and "not queued" means the next command can bind
  // this very port again — which it cannot while a listener is open.
  await assert.rejects(FakeExtension.connect(endpoint, { origin: EXTENSION_ORIGIN }));
});

test('the one-shot open path refuses an extension that never arrives', async () => {
  // `openAttachedSession` is the production entry: bind, open the connect
  // page, wait, attach. With no extension on the other end it must say so —
  // and the relay contract's rule is that a failed open closes the bridge
  // again (asserted concretely in the test below it, where the bridge handle
  // is in reach).
  await assert.rejects(
    openAttachedSession({
      browser: BROWSER,
      clientName: 'attached test',
      extensionId: EXTENSION_ID,
      browserPath: 'the-configured-binary',
      launchConnectPage: () => undefined,
      connectTimeoutMs: 400,
    }),
    (error: unknown) => error instanceof AttachedError && error.rule === 'attached.not_connected',
  );
});

test('the open shows the connect page exactly once before it waits, and the URL carries the relay endpoint', async () => {
  // The defect this pins: nothing ever opened the connect page, so the
  // extension could never learn the relay's random per-lease endpoint and
  // `attached.not_connected` was a permanent answer. The page is the wire
  // that carries the endpoint; an open that refused had to have opened it
  // first, or the refusal would be a promise nobody could keep.
  const launched: { connectUrl: string; browserPath: string; token?: string }[] = [];
  const error = await openAttachedSession({
    browser: BROWSER,
    clientName: 'read the dashboard',
    extensionId: EXTENSION_ID,
    browserPath: 'the-configured-binary',
    launchConnectPage: (request) => {
      launched.push(request);
    },
    connectTimeoutMs: 300,
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof AttachedError);
  assert.equal(error.rule, 'attached.not_connected');

  assert.equal(launched.length, 1, 'the connect page opened exactly once');
  const request = launched[0];
  assert.ok(request !== undefined);
  assert.equal(request.browserPath, 'the-configured-binary');
  const url = new URL(request.connectUrl);
  assert.equal(url.protocol, 'chrome-extension:');
  assert.equal(url.host, EXTENSION_ID);
  assert.equal(url.pathname, '/connect.html');
  const relay = url.searchParams.get('mcpRelayUrl') ?? '';
  assert.match(relay, /^ws:\/\/(127\.0\.0\.1|localhost):\d+\/extension\/.+$/, 'the endpoint rides');
  const client = JSON.parse(url.searchParams.get('client') ?? '{}') as { name?: string };
  assert.equal(client.name, 'read the dashboard');
  assert.equal(url.searchParams.get('protocolVersion'), '2');
  // No token configured: no token on the URL, and the approval page stays a
  // page — no background flag, because a background page nobody approved is
  // a connect that happened without consent.
  assert.equal(url.searchParams.has('token'), false);
  assert.equal(request.token, undefined);
});

test('a configured token rides the connect URL, permits the background open, and never reaches the log', async () => {
  const log: string[] = [];
  const launched: { connectUrl: string; token?: string; background?: boolean }[] = [];
  const token = 'a-token-never-quoted';
  const error = await openAttachedSession({
    browser: BROWSER,
    clientName: 'attached test',
    extensionId: EXTENSION_ID,
    token,
    browserPath: 'the-configured-binary',
    launchConnectPage: (request) => {
      launched.push(request);
    },
    log: (line) => log.push(line),
    connectTimeoutMs: 300,
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof AttachedError);
  assert.equal(error.rule, 'attached.not_connected');
  assert.equal(launched.length, 1);
  const request = launched[0];
  assert.ok(request !== undefined);
  const url = new URL(request.connectUrl);
  assert.equal(url.searchParams.get('token'), token, 'the extension needs it to skip the click');
  assert.equal(url.searchParams.get('background'), 'true');
  // The token also travels to the launcher — as the partner of the
  // background flag in `buildConnectArgs` — but the URL is its only wire.
  assert.equal(request.token, token);
  assert.ok(
    log.every((line) => !line.includes(token)),
    'a log line carried the token',
  );
});

test('an attached open without a configured binary refuses by name and binds no port', async () => {
  // Without the binary the connect page cannot open, the extension can
  // never learn the endpoint, and the open would be a listener nobody can
  // point a browser at. The refusal sits before the bind.
  let launched = 0;
  await assert.rejects(
    openAttachedSession({
      browser: BROWSER,
      clientName: 'attached test',
      extensionId: EXTENSION_ID,
      launchConnectPage: () => {
        launched += 1;
      },
      connectTimeoutMs: 100,
    }),
    (error: unknown) => error instanceof AttachedError && error.rule === 'attached.no_binary',
  );
  assert.equal(launched, 0, 'the launcher ran for an open that could not name a browser');
});

test('a configured binary that will not spawn refuses as attached.no_binary at once — and the process is still alive to say so', async () => {
  // The rest of this file injects the launcher; this test must not, because
  // the defect is in the real spawn: a *configured* path — present to the
  // before-bind check — that names a deleted or non-executable file. The
  // spawn returns a child and fails later, as an `error` event; unhandled,
  // that event ends this process with every lease in it, which a test
  // cannot come back from — the run dying is itself the failure signal.
  // Handled, it is a clean refusal, and it must be the **right** refusal:
  // `attached.no_binary`, the configuration family — not the retryable
  // `not_connected` advice — and it must arrive in the moment the spawn is
  // known impossible, not after the whole tokenless bound is spent waiting
  // for a person whose browser cannot start.
  const log: string[] = [];
  const started = Date.now();
  const error = await openAttachedSession({
    browser: BROWSER,
    clientName: 'attached test',
    extensionId: EXTENSION_ID,
    browserPath: 'broker-no-such-binary-anywhere',
    log: (line) => log.push(line),
    connectTimeoutMs: 30_000,
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof AttachedError);
  assert.equal(error.rule, 'attached.no_binary');
  assert.match(error.message, /could not be started/);
  assert.ok(
    Date.now() - started < 5_000,
    'the unusable binary sat out the full wait and was attributed to the extension',
  );
  assert.ok(
    log.some((line) => line.includes('could not be started')),
    'the spawn reason never reached the bridge log',
  );
});

test('the not-connected wait is seconds with a token and the relay default without one', async () => {
  // The widened bound, pinned at the number: the token does the clicking, so
  // the wait covers a launch; without it the wait covers a person, and five
  // seconds could never fit one. An explicit `connectTimeoutMs` still wins.
  const bounds: (number | undefined)[] = [];
  const waitsForNothingBridge = (): AttachedBridge => {
    const bridge: AttachedBridge = {
      cdpEndpoint: 'ws://127.0.0.1:1/cdp/x',
      extensionEndpoint: 'ws://127.0.0.1:1/extension/x',
      connectUrl: () => 'chrome-extension://x/connect.html',
      extensionConnected: () => false,
      extensionProtocolVersion: () => undefined,
      waitForExtension: (timeoutMs?: number) => {
        bounds.push(timeoutMs);
        return Promise.reject(new AttachedError('attached.not_connected', 'never arrives'));
      },
      openConnectPage: () => undefined,
      tabs: () => [],
      isOurs: () => false,
      isOursByTargetId: () => false,
      on: () => () => undefined,
      close: () => undefined,
    };
    return bridge;
  };

  for (const [options, expected] of [
    // No token: a person is the thing being waited for — the widened bound.
    [{ browser: BROWSER, clientName: 'attached test', extensionId: EXTENSION_ID }, 30_000],
    // Token: the extension skips the click — seconds.
    [
      { browser: BROWSER, clientName: 'attached test', extensionId: EXTENSION_ID, token: 't' },
      5_000,
    ],
    // An override outranks both.
    [
      {
        browser: BROWSER,
        clientName: 'attached test',
        extensionId: EXTENSION_ID,
        connectTimeoutMs: 10,
      },
      10,
    ],
  ] as const) {
    await assert.rejects(
      attachOverBridge(waitsForNothingBridge(), options),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.not_connected',
    );
    // Asserted row by row, so a failing case names itself rather than
    // pointing at whichever index first differed.
    assert.equal(bounds[bounds.length - 1], expected);
  }
});

test('a refused open does not reach the browser at all: the extension never connected, and no client did either', async () => {
  // The stronger half of the same claim: open the socket but never send the
  // handshake, so the wait times out, and check nothing browser-side happened.
  const bridge = await connect({ clientName: 'attached test', extensionId: EXTENSION_ID });
  const ext = await FakeExtension.connect(bridge.extensionEndpoint, {
    origin: EXTENSION_ORIGIN,
  });
  // The extension is connected but has not finished its handshake, so
  // waitForExtension must be the thing that times out — not a hang.
  const error = await attachOverBridge(bridge, {
    browser: BROWSER,
    clientName: 'attached test',
    extensionId: EXTENSION_ID,
    connectTimeoutMs: 300,
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof AttachedError);
  assert.equal(error.rule, 'attached.not_connected');
  assert.equal(ext.sawCall('chrome.tabs.create'), false, 'no tab was ever asked for');
  bridge.close('test over');
});

// ── Tab lifecycle over the bridge ──────────────────────────────────────────

test("openTab goes through the bridge, and the handle is the bridge's own name for the tab", async () => {
  const { bridge, ext, session } = await live();
  try {
    const tab = await openedTab({ bridge, ext, session });
    assert.match(tab.driverTabId, /^tab-\d+$/);
    assert.ok(ext.sawCall('chrome.tabs.create'), 'the open crossed the bridge');
    assert.equal(bridge.isOurs(Number(tab.driverTabId.slice(4))), true);
    const listed = await session.listTabs();
    assert.deepEqual(listed, [tab]);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('listTabs reports exactly the ownership mirror: a tab the extension did not report is absent, not hidden', async () => {
  const { bridge, ext, session } = await live();
  try {
    await openedTab({ bridge, ext, session });
    await openedTab({ bridge, ext, session });
    const listed = await session.listTabs();
    assert.equal(listed.length, 2);
    // There is no third tab anywhere in the mirror — `isOurs` says the next
    // id up is disowned, and listTabs is built from the mirror itself.
    assert.equal(bridge.isOurs(999_999), false);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('two opens racing through one session bind two handles, not one handle twice', async () => {
  // The mirror is the address book here, so "which fresh entry is mine"
  // is decided by a snapshot diff — and an unserialised pair of opens
  // takes the same snapshot, creates two pages, and both claim the same
  // first fresh id: identical handles, one page bound over the other,
  // and a tab in the person's own window nothing can address or close.
  // Two leases' first-touch verbs through one memoised provider is a
  // production shape (parallel tool calls), not a hypothetical.
  const { bridge, ext, session } = await live();
  try {
    const [first, second] = await Promise.all([session.openTab(), session.openTab()]);
    assert.notEqual(
      first.driverTabId,
      second.driverTabId,
      'both opens bound the same physical tab',
    );
    assert.equal(
      ext.calls.filter((call) => call.method === 'chrome.tabs.create').length,
      2,
      'both opens asked the extension for a tab',
    );
    assert.deepEqual(
      (await session.listTabs()).map((tab) => tab.driverTabId).sort(),
      [first.driverTabId, second.driverTabId].sort(),
      'the mirror holds both and only both',
    );
    assert.equal(bridge.tabs().length, 2);
    // The physical fact that "bound to different pages" buys: each
    // handle closes **its own** tab, and the person's window ends with
    // neither in it. A page overwritten by the second bind would be a
    // tab nothing can address — it would still be sitting in the mirror
    // after both closes.
    assert.equal(await session.closeTab(first), 'closed');
    assert.equal(await session.closeTab(second), 'closed');
    await waitFor(() => bridge.tabs().length === 0, 'both tabs out of the mirror');
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('closeTab closes one of our tabs and ends it in the mirror', async () => {
  const { bridge, ext, session } = await live();
  try {
    const tab = await openedTab({ bridge, ext, session });
    assert.equal(await session.closeTab(tab), 'closed');
    assert.ok(ext.sawCall('chrome.tabs.remove'), 'the close crossed the bridge');
    await waitFor(() => bridge.tabs().length === 0, 'the tab out of the mirror');
    const second = await session.closeTab(tab);
    assert.equal(second, 'not_found', 'closing it again finds nothing');
  } finally {
    session.detach().catch(() => undefined);
  }
});

// ── Ownership: the foreign-tab refusals ────────────────────────────────────

test('closing a handle the mirror disowns is refused, and the extension is never asked to remove anything', async () => {
  const { bridge, ext, session } = await live();
  try {
    await openedTab({ bridge, ext, session });
    const foreign: TabHandle = { browser: BROWSER, driverTabId: 'tab-999999' };
    assert.equal(await session.closeTab(foreign), 'refused');
    assert.equal(ext.sawCall('chrome.tabs.remove'), false, 'and nothing was removed');
    // A foreign handle cannot be laundered through the other verbs either.
    for (const call of [
      () => session.navigate(foreign, 'https://example.com/page', 300),
      () => session.act(foreign, { action: 'scroll' }),
      () => session.read(foreign, ['console']),
      () => session.cookies(foreign),
      () => session.capture(foreign, { fullPage: false }),
      () => session.evaluate(foreign, '1 + 1'),
      () => session.settlePage(foreign),
      () =>
        session.seedStorage(foreign, [
          { origin: 'https://example.com', area: 'local', key: 'auth', value: 'a-value' },
        ]),
    ]) {
      await assert.rejects(call(), (error: unknown) => {
        return error instanceof AttachedError && error.rule === 'attached.foreign_tab';
      });
    }
    assert.equal(ext.sawCall('chrome.tabs.remove'), false);
    assert.equal(sawCdp(ext, 'Page.navigate'), false);
  } finally {
    session.detach().catch(() => undefined);
  }
});

// ── The read-only rule ─────────────────────────────────────────────────────

test('every write verb is refused and its browser-side command is never sent', async () => {
  const { bridge, ext, session } = await live();
  try {
    const tab = await openedTab({ bridge, ext, session });
    // `countCdp` before/after rather than absence: the Playwright handshake
    // itself puts a few domain commands on the log at attach time (media
    // emulation is one), and the claim this test makes is **no new one after
    // the refused act**, which is what "the browser was not asked" means.
    const refused: readonly { request: ActionRequest; forbidden: readonly string[] }[] = [
      { request: { action: 'click', ref: 'e1' }, forbidden: ['Input.dispatchMouseEvent'] },
      { request: { action: 'check', ref: 'e1' }, forbidden: ['Input.dispatchMouseEvent'] },
      { request: { action: 'type', ref: 'e1', value: 'text' }, forbidden: ['Input.insertText'] },
      { request: { action: 'fill', ref: 'e1', value: 'text' }, forbidden: ['Input.insertText'] },
      {
        request: { action: 'select', ref: 'e1', value: 'x' },
        forbidden: ['Input.dispatchMouseEvent'],
      },
      { request: { action: 'press', value: 'a' }, forbidden: ['Input.dispatchKeyEvent'] },
      {
        request: { action: 'resize', viewport: { width: 800, height: 600 } },
        forbidden: ['Emulation.setDeviceMetricsOverride'],
      },
      {
        request: { action: 'emulate', preferences: { colourScheme: 'dark' } },
        forbidden: ['Emulation.setEmulatedMedia'],
      },
      {
        request: { action: 'dialog', response: { accept: true } },
        forbidden: ['Page.handleJavaScriptDialog'],
      },
      {
        request: { action: 'fill_form', fields: [{ ref: 'e1', value: 'v' }] },
        forbidden: ['Input.insertText'],
      },
      {
        request: { action: 'drag', ref: 'e1', targetRef: 'e2' },
        forbidden: ['Input.dispatchMouseEvent'],
      },
      { request: { action: 'upload', ref: 'e1', files: [] }, forbidden: ['DOM.setFileInputFiles'] },
    ];
    for (const { request, forbidden } of refused) {
      const before = forbidden.map((method) => cdpCalls(ext, method).length);
      await assert.rejects(
        session.act(tab, request),
        (error: unknown) =>
          error instanceof AttachedError &&
          error.rule === 'attached.read_only' &&
          error.message.includes(request.action),
        `${request.action} must refuse by name`,
      );
      forbidden.forEach((method, at) => {
        assert.equal(
          cdpCalls(ext, method).length,
          before[at],
          `${method} was never asked for by ${request.action}`,
        );
      });
    }
    // The tab itself is undisturbed: creating it is the only tabs call, and no
    // navigation of any kind ran.
    assert.equal(ext.calls.filter((call) => call.method === 'chrome.tabs.create').length, 1);
    assert.equal(sawCdp(ext, 'Page.navigate'), false);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('hover passes the read-only gate, and a non-movement press does not', async () => {
  // Pins the gate itself: the fake cannot answer the accessibility render
  // `hover` resolves through, so the honest probe is to send hover to a
  // **foreign** handle — the gate lets it through and the ownership rule is
  // what refuses, proving hover is not on the refused side of the gate.
  const { bridge, ext, session } = await live();
  try {
    await openedTab({ bridge, ext, session });
    const foreign: TabHandle = { browser: BROWSER, driverTabId: 'tab-999999' };
    await assert.rejects(
      session.act(foreign, { action: 'hover', ref: 'e1' }),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.foreign_tab',
    );
    // Presses that could reach a field are refused by the gate before any
    // page or ownership question is even asked.
    await assert.rejects(
      session.act(foreign, { action: 'press', value: 'Enter' }),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.read_only',
    );
    assert.equal(sawCdp(ext, 'Input.dispatchKeyEvent'), false);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('scroll reaches the bridge; a movement key refuses when the focus read cannot answer, and the key never crosses', async () => {
  // Whether a movement key moves the view or moves a value is the page's
  // fact — a focused select, radio group or range input moves under the
  // arrows — so the session asks the page what holds focus before it presses.
  // This fixture cannot complete that read (the same fake-side limit as the
  // accessibility render: the evaluate machinery starts and the expression
  // never finishes), and the bounded wait turns "cannot ask" into what a
  // wedged page gets: **a refusal** — not a hang, and not a pressed key.
  const { bridge, ext, session } = await live();
  try {
    const tab = await openedTab({ bridge, ext, session });
    const failures: unknown[] = [];
    // The scroll's fixed expression runs through Playwright's isolated-world
    // machinery, and the fake answers `Page.createIsolatedWorld` without an
    // execution context — so the expression itself never completes on it.
    // What is provable is the gate: the evaluate machinery was engaged, i.e.
    // the world creation crossed the bridge. The scroll fires alone so its
    // crossing is unambiguous.
    const worldsBeforeScroll = cdpCalls(ext, 'Page.createIsolatedWorld').length;
    void session.act(tab, { action: 'scroll' }).catch((error: unknown) => failures.push(error));
    await waitFor(
      () => cdpCalls(ext, 'Page.createIsolatedWorld').length > worldsBeforeScroll,
      'the scroll evaluate machinery crossing',
    );
    // The press: the gate let the key through (§7.1's own row calls it a
    // movement key), the read could not answer, and the refusal says **so** —
    // not "not available", which is the allow-list's words. The call-log half
    // is the one the rejection rule demands: the value never moved because no
    // key event ever crossed.
    const keysBeforePress = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    for (const key of ['ArrowDown', 'PageDown']) {
      await assert.rejects(
        session.act(tab, { action: 'press', value: key }),
        (error: unknown) =>
          error instanceof AttachedError &&
          error.rule === 'attached.read_only' &&
          error.message.includes('could not be asked') &&
          !error.message.includes('not available'),
        `press of ${key} must refuse on the unread focus, not on the allow-list`,
      );
    }
    assert.equal(
      cdpCalls(ext, 'Input.dispatchKeyEvent').length,
      keysBeforePress,
      'no key event crossed: the refusal is a physical fact, not just a sentence',
    );
    for (const failure of failures) {
      assert.ok(
        !(failure instanceof AttachedError && failure.message.includes('not available')),
        'the scroll was never refused as a write',
      );
    }
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('Escape never waits for the focus read: dismissing is not editing', async () => {
  // Escape is on the allow-list precisely because it cannot edit a value, so
  // it is exempt from the focus read — and the crossing proves the exemption:
  // had the read run first, the fixture could not complete it and no key
  // would ever have gone out. The act then settles on the fake's inability to
  // render the follow-on snapshot, exactly as the other allowed verbs do.
  const { bridge, ext, session } = await live();
  try {
    const tab = await openedTab({ bridge, ext, session });
    const keysBefore = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    const failures: unknown[] = [];
    void session
      .act(tab, { action: 'press', value: 'Escape' })
      .catch((error: unknown) => failures.push(error));
    await waitFor(
      () => cdpCalls(ext, 'Input.dispatchKeyEvent').length > keysBefore,
      'the Escape key events crossing',
    );
    // The crossing itself is the proof the read was skipped: had the read run,
    // this fixture could not complete it and no key would have been dispatched.
    for (const failure of failures) {
      assert.ok(
        !(failure instanceof AttachedError && failure.message.includes('could not be asked')),
        'Escape was never refused for an unread focus',
      );
    }
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('the focus decision is table-driven: only plain page focus passes — controls, editables, frames, shadow hosts, role widgets, aria values and custom elements all hold focus', () => {
  // The predicate half of the gate, with no page anywhere: what the read
  // learns is data, and this is where the answer is decided. The shape is
  // an allow-list: a row passes only when every fact that could hide a
  // value is proved absent. The rows that are not plain controls are the
  // fail-safe halves — focus the top-document read cannot see *through*
  // (a frame's interior, a shadow tree's, a closed custom element's)
  // counts as a focused control, because the alternative is pressing a
  // key blind.
  const element = (tagName: string, extra: Partial<FocusChainElement> = {}): FocusChainElement => ({
    tagName,
    isContentEditable: false,
    hasShadowRoot: false,
    role: null,
    hasAriaValue: false,
    ...extra,
  });
  const rows: [readonly FocusChainElement[], boolean][] = [
    [[], false],
    [[element('BODY')], false],
    [[element('DIV')], false],
    [[element('A')], false],
    // A non-widget role is still plain focus: the arrows move the view,
    // not a value, over a plain link.
    [[element('A', { role: 'link' })], false],
    [[element('INPUT')], true],
    [[element('SELECT')], true],
    [[element('TEXTAREA')], true],
    [[element('DIV', { isContentEditable: true })], true],
    [[element('IFRAME')], true],
    [[element('DIV', { hasShadowRoot: true })], true],
    // ARIA value widgets move their own value under the arrows even when
    // the tag is a plain div — the role is the fact, not the tag.
    [[element('DIV', { role: 'spinbutton' })], true],
    [[element('DIV', { role: 'slider' })], true],
    [[element('DIV', { role: 'listbox' })], true],
    [[element('DIV', { role: 'combobox' })], true],
    // A value named by `aria-valuenow` is refused even without a role.
    [[element('DIV', { hasAriaValue: true })], true],
    // A custom element's controls live in a shadow root, and a **closed**
    // one reports nothing to anyone outside it — the host is refused
    // rather than read blind.
    [[element('QTY-PICK')], true],
    // A chain where any one element holds a control holds the answer.
    [[element('BODY'), element('SELECT')], true],
  ];
  for (const [chain, expected] of rows) {
    assert.equal(
      focusChainHoldsFormControl(chain),
      expected,
      `chain ${JSON.stringify(chain)} must answer ${String(expected)}`,
    );
  }
});

test('the press gate, answered: a focused control refuses and the key never crosses; plain focus lets it through, and Escape never asks', async () => {
  // The true branch the unread fixture can never show. The fake relay
  // cannot complete the page's own evaluate — the same isolated-world
  // limit the scroll row above pins — so the read is answered through the
  // seam's own injection and both branches become provable: the refusal
  // **and its call-log half**, the key crossing when there is nothing to
  // reach, and Escape skipping the read outright. The real read's answer
  // over the bridge stays what the bounded-wait row pins: unfinished, and
  // unfinished is refused, not pressed.
  {
    // Plain promise returns, not async bodies: an `async` with no `await`
    // is this repository's lint error, as in the service fixtures.
    const probe = (): Promise<readonly FocusChainElement[]> =>
      Promise.resolve([
        {
          tagName: 'SELECT',
          isContentEditable: false,
          hasShadowRoot: false,
          role: null,
          hasAriaValue: false,
        },
      ]);
    const { bridge, ext, session } = await live(probe);
    try {
      const tab = await openedTab({ bridge, ext, session });
      const keysBefore = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
      await assert.rejects(
        session.act(tab, { action: 'press', value: 'ArrowDown' }),
        (error: unknown) =>
          error instanceof AttachedError &&
          error.rule === 'attached.read_only' &&
          error.message.includes("a form control holds the page's focus") &&
          !error.message.includes('could not be asked'),
        'a focused select must refuse the movement key with the focused-control refusal',
      );
      assert.equal(
        cdpCalls(ext, 'Input.dispatchKeyEvent').length,
        keysBefore,
        'the key crossed into the focused control: the refusal is a sentence, not a fact',
      );
    } finally {
      session.detach().catch(() => undefined);
    }
  }
  {
    let probed = 0;
    const probe = (): Promise<readonly FocusChainElement[]> => {
      probed += 1;
      return Promise.resolve([
        {
          tagName: 'BODY',
          isContentEditable: false,
          hasShadowRoot: false,
          role: null,
          hasAriaValue: false,
        },
      ]);
    };
    const { bridge, ext, session } = await live(probe);
    try {
      const tab = await openedTab({ bridge, ext, session });
      const keysBefore = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
      const failures: unknown[] = [];
      void session
        .act(tab, { action: 'press', value: 'PageDown' })
        .catch((error: unknown) => failures.push(error));
      await waitFor(
        () => cdpCalls(ext, 'Input.dispatchKeyEvent').length > keysBefore,
        'the answered press crossing',
      );
      assert.equal(probed, 1, 'the gate did not ask the page before pressing');
      // The other half of the Escape exemption, told directly: had the read
      // run, the counter would have moved.
      const escapeKeys = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
      void session
        .act(tab, { action: 'press', value: 'Escape' })
        .catch((error: unknown) => failures.push(error));
      await waitFor(
        () => cdpCalls(ext, 'Input.dispatchKeyEvent').length > escapeKeys,
        'the Escape key crossing',
      );
      assert.equal(probed, 1, 'Escape waited on the focus read');
      for (const failure of failures) {
        assert.ok(
          !(failure instanceof AttachedError && failure.rule === 'attached.read_only'),
          'a press with nothing focused was refused',
        );
      }
    } finally {
      session.detach().catch(() => undefined);
    }
  }
});

test('the press gate refuses an ARIA value widget and a custom element, and the key never crosses either', async () => {
  // The two states whose value lives where a **tag** cannot name it: an
  // ARIA value widget — a div whose `role` says `spinbutton` and whose own
  // keydown moves its value under the arrows, the shape of a quantity
  // stepper that saves on change — and a custom element whose focused
  // control sits in a **closed** shadow root the top-document read cannot
  // see into at all. The focus answer arrives through the same injected
  // seam as the select row above (the fake cannot complete the page's own
  // read), and each refusal is pinned by its call-log half: no key event
  // crossed, so no value moved.
  for (const row of [
    { tagName: 'DIV', role: 'spinbutton' },
    { tagName: 'QTY-PICK', role: null },
  ] as const) {
    const probe = (): Promise<readonly FocusChainElement[]> =>
      Promise.resolve([
        {
          tagName: row.tagName,
          isContentEditable: false,
          hasShadowRoot: false,
          role: row.role,
          hasAriaValue: false,
        },
      ]);
    const { bridge, ext, session } = await live(probe);
    try {
      const tab = await openedTab({ bridge, ext, session });
      const keysBefore = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
      await assert.rejects(
        session.act(tab, { action: 'press', value: 'ArrowDown' }),
        (error: unknown) =>
          error instanceof AttachedError &&
          error.rule === 'attached.read_only' &&
          error.message.includes("a form control holds the page's focus") &&
          !error.message.includes('could not be asked'),
        `focus on ${row.tagName}${row.role === null ? '' : ` role=${row.role}`} must refuse the arrow`,
      );
      assert.equal(
        cdpCalls(ext, 'Input.dispatchKeyEvent').length,
        keysBefore,
        `an arrow crossed while ${row.tagName} held focus: the refusal is a sentence, not a fact`,
      );
    } finally {
      session.detach().catch(() => undefined);
    }
  }
});

// ── Secrets, seeds, expressions, pictures ──────────────────────────────────

test('a secret scope reaching any verb is refused unopened; the sentinel is never resolved', async () => {
  const { bridge, ext, session } = await live();
  try {
    const tab = await openedTab({ bridge, ext, session });
    let resolved = 0;
    const scope: SecretScope = {
      resolve: () => {
        resolved += 1;
        return Promise.reject(new Error('unreachable'));
      },
      received: [],
      record: () => undefined,
    };
    await assert.rejects(
      session.navigate(tab, 'https://example.com/page', 300, scope),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.no_secrets',
    );
    await assert.rejects(
      session.act(tab, { action: 'scroll' }, scope),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.no_secrets',
    );
    await assert.rejects(
      session.read(tab, ['snapshot'], { secrets: scope }),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.no_secrets',
    );
    await assert.rejects(
      session.capture(tab, { fullPage: false, secrets: scope }),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.no_secrets',
    );
    assert.equal(resolved, 0, 'the scope was never opened');
    // A sentinel spelled in a value is refused at the same door.
    await assert.rejects(
      session.act(tab, { action: 'press', value: '{{secret:token}}' }),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.no_secrets',
    );
    assert.equal(sawCdp(ext, 'Input.dispatchKeyEvent'), false, 'nothing typed');
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('a storage seed is refused, and no navigation to any origin was asked for', async () => {
  const { bridge, ext, session } = await live();
  try {
    const tab = await openedTab({ bridge, ext, session });
    await assert.rejects(
      session.seedStorage(tab, [
        { origin: 'https://example.com', area: 'local', key: 'auth', value: 'a-value' },
      ]),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.no_seed',
    );
    assert.equal(sawCdp(ext, 'Page.navigate'), false, 'the seed never reached an origin');
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('an expression is refused at the door and no runtime call is made for it', async () => {
  const { bridge, ext, session } = await live();
  try {
    const tab = await openedTab({ bridge, ext, session });
    await assert.rejects(
      session.evaluate(tab, 'document.title'),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.no_evaluate',
    );
    assert.equal(cdpCalls(ext, 'Runtime.evaluate').length, 0, 'no expression ran in his browser');
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('a full-page or masked capture is refused, and the shutter never opened', async () => {
  const { bridge, ext, session } = await live();
  try {
    const tab = await openedTab({ bridge, ext, session });
    await assert.rejects(
      session.capture(tab, { fullPage: true }),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.no_full_page',
    );
    await assert.rejects(
      session.capture(tab, { fullPage: false, mask: [{ x: 0, y: 0, width: 10, height: 10 }] }),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.read_only',
    );
    assert.equal(sawCdp(ext, 'Page.captureScreenshot'), false, 'no picture was taken');
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('there is no keeper tab, and asking for one opens nothing', async () => {
  const { ext, session } = await live();
  try {
    await assert.rejects(
      session.ensureKeeperTab(),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.no_keeper',
    );
    assert.equal(ext.sawCall('chrome.tabs.create'), false, 'no blank tab entered his window');
  } finally {
    session.detach().catch(() => undefined);
  }
});

// ── Navigation plumbing and Cancel ─────────────────────────────────────────

test('navigate sends the address across the bridge and is bounded by waitMs', async () => {
  // The fake answers Page.navigate and never completes it, so the commit wait
  // can only ever end in its own bound here — which is exactly the bound the
  // seam asks for. That the bound bites, and that the exact address crossed,
  // is what this pins; the commit resolving on a real browser belongs to the
  // gated browser job.
  const { bridge, ext, session } = await live();
  try {
    const tab = await openedTab({ bridge, ext, session });
    const started = Date.now();
    await assert.rejects(session.navigate(tab, 'https://example.com/other', 1_000));
    assert.ok(Date.now() - started < 20_000, 'the bound, not the library default');
    const navigates = cdpCalls(ext, 'Page.navigate');
    assert.equal(navigates.length, 1);
    const navParams = (navigates[0] as { params: unknown[] }).params[2] as { url?: string };
    assert.equal(
      navParams.url,
      'https://example.com/other',
      'the address reached the browser side verbatim',
    );
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('his Cancel on the debugger bar makes the tab undrivable without closing anything', async () => {
  const { bridge, ext, session } = await live();
  try {
    const tab = await openedTab({ bridge, ext, session });
    const tabId = Number(tab.driverTabId.slice(4));
    const delivered = new Promise<void>((resolve) => {
      bridge.on('debuggerDetached', () => resolve());
    });
    ext.sendEvent('chrome.debugger.onDetach', [{ tabId }, { reason: 'canceled' }]);
    await delivered;
    // The session drops its binding when the bridge reports the detach, and
    // the detached tab is never paired again — the next verb must say so
    // rather than pretend the page is drivable.
    await assert.rejects(
      session.read(tab, ['console']),
      (error: unknown) => error instanceof Error && error.message.includes('canceled'),
    );
    assert.equal(ext.sawCall('chrome.tabs.remove'), false, 'his tab stays his');
    // And it is still listed: the tab is open on his screen, merely no
    // longer debuggable by this connection.
    assert.deepEqual(
      (await session.listTabs()).map((handle) => handle.driverTabId),
      [tab.driverTabId],
    );
  } finally {
    session.detach().catch(() => undefined);
  }
});

// ── Connection bookkeeping ─────────────────────────────────────────────────

test('describe reports a headed adopted browser at the bridge address', async () => {
  const { bridge, session } = await live();
  try {
    const description = session.describe();
    assert.equal(description.browser, BROWSER);
    assert.equal(description.mode, 'headed');
    assert.equal(description.pid, 0, 'his process is not ours to know');
    assert.equal(description.discovery.endpoint, bridge.cdpEndpoint);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('detach ends the bridge and the connection, and closes no tab on the way out', async () => {
  const { bridge, ext, session } = await live();
  // Open a real tab first: the claim under test is what detach does *not* do
  // to a live lease, and that only means something with a tab open.
  await openedTab({ bridge, ext, session });
  assert.equal(session.isConnected(), true);
  await session.detach();
  assert.equal(bridge.extensionConnected(), false, 'the bridge stopped listening');
  assert.equal(session.isConnected(), false);
  assert.equal(
    ext.sawCall('chrome.tabs.remove'),
    false,
    'the tab stays open — the lease ended, not the browser',
  );
});

test('the fake bridge survives a second session over it only after the first released it', async () => {
  // The relay admits one CDP client at a time; a released bridge still serves
  // its extension, but a *fresh* bridge — which is what a new lease means —
  // binds its own port. What this pins is that open→detach→reopen cycles do
  // not leak listeners, the fact the not-connected refusal also relies on.
  const first = await live();
  await first.session.detach();
  const second = await live();
  try {
    await openedTab(second);
    assert.equal((await second.session.listTabs()).length, 1);
  } finally {
    second.session.detach().catch(() => undefined);
  }
});

// ── modeFor, widened for the attached kind ─────────────────────────────────

test('modeFor: the kind decides when the caller knows it; the name fallback stands without it', async () => {
  const { modeFor } = await import('../../src/browser/real.ts');
  // An attached browser always has a window on it, but its name is whatever
  // the operator configured, so a name-only rule would label it headless —
  // the label that decides the keeper-tab rule (§3.15) — and a keeper tab
  // belongs to this design only for browsers this service starts.
  assert.equal(modeFor('his', 'attached'), 'headed');
  assert.equal(modeFor('his', 'private'), 'headless');
  assert.equal(modeFor('his', 'regular'), 'headed');
  // Name-only callers keep the behaviour they had.
  assert.equal(modeFor('regular'), 'headed');
  assert.equal(modeFor('anything-else'), 'headless');
});
