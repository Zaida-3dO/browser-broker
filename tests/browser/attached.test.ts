import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { connect } from '../../src/attach/session.ts';
import type { AttachedBridge } from '../../src/attach/session.ts';
import { AttachedError } from '../../src/attach/errors.ts';
import {
  attachOverBridge,
  focusChainHoldsFormControl,
  isViewMovingAction,
  openAttachedSession,
  SECRET_FIELD_SELECTOR,
  type AttachedSessionOptions,
  type FocusChainElement,
} from '../../src/browser/attached.ts';
import type { ActionRequest, SecretScope, TabHandle } from '../../src/browser/driver.ts';
import { NAVIGATION_KEYS, grantValueDigest } from '../../src/attach/gate.ts';
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

async function live(overrides: Partial<AttachedSessionOptions> = {}): Promise<Live> {
  const bridge = await connect({ clientName: 'attached test', extensionId: EXTENSION_ID });
  const ext = await FakeExtension.connect(bridge.extensionEndpoint, {
    origin: EXTENSION_ORIGIN,
  });
  await ext.initialize();
  const session = await attachOverBridge(bridge, {
    browser: BROWSER,
    clientName: 'attached test',
    extensionId: EXTENSION_ID,
    ...overrides,
  });
  return { bridge, ext, session };
}

/**
 * Mint an owner grant exactly as `verifyOwnerGrant` expects to check one:
 * the HMAC over the escaped `|`-joined tuple, sent as
 * `<issued-at-seconds>.<tag>`. Mirroring the wire here is deliberate —
 * `gate.test.ts` pins the minting and checking against each other, and
 * these session tests pin that **the session builds the same tuple from a
 * live call**, lease key and host included.
 */
function signGrant(
  secret: string,
  tuple: {
    leaseKey: string;
    ref: string;
    accessibleName: string;
    urlHost: string;
    issuedAtSeconds: number;
    /** The verb and value the grant is for; every grant row here is for a press of Enter. */
    verb?: string;
    value?: string;
  },
): string {
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  const payload = [
    esc(tuple.leaseKey),
    esc(tuple.ref),
    esc(tuple.accessibleName),
    esc(tuple.urlHost),
    String(tuple.issuedAtSeconds),
    esc(tuple.verb ?? 'press'),
    esc(grantValueDigest(tuple.value ?? 'Enter')),
  ].join('|');
  const tag = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${String(tuple.issuedAtSeconds)}.${tag}`;
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

/** Every CDP call that touches the page's input side, whatever method it names. */
function inputCalls(ext: FakeExtension): number {
  return ext.calls.filter(
    (call) =>
      call.method === 'chrome.debugger.sendCommand' &&
      typeof call.params[1] === 'string' &&
      call.params[1].startsWith('Input.'),
  ).length;
}

/**
 * Raise a page dialog the way Chromium does: as a `Page.javascriptDialogOpening`
 * debugger event on the tab, forwarded through the same route the real one
 * takes. What answers it — or fails to — shows up as a
 * `Page.handleJavaScriptDialog` command in the call log.
 */
function raiseDialog(
  ext: FakeExtension,
  tabId: number,
  message = 'Do you want to continue?',
): void {
  ext.sendEvent('chrome.debugger.onEvent', [
    { tabId },
    'Page.javascriptDialogOpening',
    { type: 'confirm', message, hasInputBox: false, defaultPrompt: '' },
  ]);
}

/**
 * The page moves **by itself** — a clicked link, a submitted form, a script's
 * redirect — as Chromium reports it: a main-frame `Page.frameNavigated`. The
 * session never asked for it, which is the case the broker's own `navigate`
 * hook does not cover.
 */
function pageNavigatesItself(ext: FakeExtension, tabId: number, url: string): void {
  ext.sendEvent('chrome.debugger.onEvent', [
    { tabId },
    'Page.frameNavigated',
    {
      frame: {
        id: ext.targetIdOf(tabId),
        loaderId: 'loader-after-click',
        url,
        securityOrigin: new URL(url).origin,
        mimeType: 'text/html',
      },
    },
  ]);
}

/** What a press with no ref reaches when the cursor sits in a plain text box. */
const TEXT_BOX_FOCUS = {
  tag: 'input',
  inputType: 'text',
  accessibleName: 'Notes',
  editable: true,
} as const;

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
    // Escape included: it clears a focused search field, so it asks the
    // same read, and an unread focus refuses it the same way.
    const keysBeforePress = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    for (const key of ['ArrowDown', 'PageDown', 'Escape']) {
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

test('Escape is refused while a focused field could clear, and the key never crosses', async () => {
  // Escape is on the allow-list because it dismisses overlays, but
  // dismissing is not always harmless: over a focused search input,
  // Escape clears the field and fires the input and search events that
  // live-search pages act on, so the dismissal is an edit. Escape runs
  // through the same focus read as the arrows for exactly that reason.
  // The answer arrives through the injected seam (the fake cannot
  // complete the page's own read), and the refusal carries its call-log
  // half: no key event crossed, so no field's text changed.
  const probe = (): Promise<readonly FocusChainElement[]> =>
    Promise.resolve([
      {
        tagName: 'INPUT',
        isContentEditable: false,
        hasShadowRoot: false,
        role: null,
        hasAriaValue: false,
      },
    ]);
  const { bridge, ext, session } = await live({ focusProbe: probe });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const keysBefore = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    await assert.rejects(
      session.act(tab, { action: 'press', value: 'Escape' }),
      (error: unknown) =>
        error instanceof AttachedError &&
        error.rule === 'attached.read_only' &&
        error.message.includes("a form control holds the page's focus") &&
        !error.message.includes('could not be asked'),
      'Escape over a focused input must refuse with the focused-control refusal',
    );
    assert.equal(
      cdpCalls(ext, 'Input.dispatchKeyEvent').length,
      keysBefore,
      'the Escape key crossed into the focused field: the refusal is a sentence, not a fact',
    );
  } finally {
    session.detach().catch(() => undefined);
  }
});

// ── Acting on a listed site (S2) ─────────────────────────────────────────
//
// Same rule as every refusal above, and harder to satisfy now that the
// session can act: the call-log half. Where a gate refuses, no `Input.*`
// command crossed; where it allows, the key that crossed **is** the proof.
// The fake still cannot complete the accessibility render a locator verb
// resolves through, so the allowed-and-performed rows run through `press`
// with no ref — `page.keyboard`, which crosses — and the locator verbs'
// performed half rides on the service tests' fake session plus the gated
// browser job. The gate's own row table lives in `gate.test.ts`; these rows
// pin that **the session builds the inputs the gate is told it will get**,
// host included, and spends the grant exactly once.

/** A caller identified the way the service identifies one acting call. */
const CALLER = { claimId: 'claim-wire', leaseKey: 'lease-wire' } as const;

test('an acting verb on a site the list does not name refuses by the site rule, and the browser is not asked', async () => {
  const { bridge, ext, session } = await live({ attachedActSites: ['other.example.net'] });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const before = cdpCalls(ext, 'Input.dispatchMouseEvent').length;
    await assert.rejects(
      session.act(tab, { action: 'click', ref: 'e1' }),
      (error: unknown) =>
        error instanceof AttachedError &&
        error.rule === 'attached.act_site_off_list' &&
        error.message.includes('BROKER_ATTACHED_ACT_SITES'),
      'off-list must name the variable to set, not just refuse',
    );
    assert.equal(cdpCalls(ext, 'Input.dispatchMouseEvent').length, before);
    assert.equal(sawCdp(ext, 'Page.navigate'), false);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('the never-acted verbs refuse even on a listed site, and their commands never cross', async () => {
  const { bridge, ext, session } = await live({ attachedActSites: ['example.com'] });
  try {
    const tab = await openedTab({ bridge, ext, session });
    for (const { request, forbidden } of [
      {
        request: { action: 'resize', viewport: { width: 8, height: 6 } } as ActionRequest,
        forbidden: ['Emulation.setDeviceMetricsOverride'],
      },
      {
        request: { action: 'emulate', preferences: {} } as ActionRequest,
        forbidden: ['Emulation.setEmulatedMedia'],
      },
    ]) {
      const before = forbidden.map((method) => cdpCalls(ext, method).length);
      await assert.rejects(
        session.act(tab, request),
        (error: unknown) =>
          error instanceof AttachedError &&
          error.rule === 'attached.read_only' &&
          error.message.includes('never acts'),
      );
      forbidden.forEach((method, at) => {
        assert.equal(cdpCalls(ext, method).length, before[at], `${method} never asked`);
      });
    }
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('a control the page will not describe refuses the act, and nothing is attempted on trust', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    elementFactsProbe: () => Promise.resolve(null),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const before = cdpCalls(ext, 'Input.dispatchMouseEvent').length;
    await assert.rejects(
      session.act(tab, { action: 'click', ref: 'e1' }),
      (error: unknown) =>
        error instanceof AttachedError &&
        error.rule === 'attached.field_forbidden' &&
        error.message.includes('could not be asked'),
      'an unread control is a refusal, not a guess',
    );
    assert.equal(cdpCalls(ext, 'Input.dispatchMouseEvent').length, before);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('the field guard: a password ref refuses fill, and the text never reaches the page', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    elementFactsProbe: (ref: string) =>
      Promise.resolve(
        ref === 'e1' ? { tag: 'input', inputType: 'password', accessibleName: 'Password' } : null,
      ),
    pageSecretProbe: () => Promise.resolve(true),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const before = cdpCalls(ext, 'Input.insertText').length;
    await assert.rejects(
      session.act(tab, { action: 'fill', ref: 'e1', value: 'hunter2' }),
      (error: unknown) =>
        error instanceof AttachedError &&
        error.rule === 'attached.field_forbidden' &&
        error.message.includes('browser_sign_in'),
      'the refusal names who does the step',
    );
    assert.equal(cdpCalls(ext, 'Input.insertText').length, before);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('a consequential step without a grant comes back needs_owner, pointing at browser_sign_in, with no key crossing', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    focusedControlProbe: () => Promise.resolve({ tag: 'button', accessibleName: 'Pay' }),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const before = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    await assert.rejects(
      session.act(tab, { action: 'press', value: 'Enter' }, undefined, CALLER),
      (error: unknown) =>
        error instanceof AttachedError &&
        error.rule === 'attached.needs_owner' &&
        error.message.includes('browser_sign_in'),
    );
    assert.equal(cdpCalls(ext, 'Input.dispatchKeyEvent').length, before);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('key strings that are not keys refuse at the host-free preflight, and no Input call crosses', async () => {
  // Every spelling below reaches the page as a real Enter press on a real
  // Chromium (`Enter+Tab` holds Enter while Tab lands, and a bare carriage
  // return is the automation library's own alias for Enter), so the session
  // must refuse them **as not keys at all** — before the page is even
  // resolved, and with no `Input.*` of any kind on the call log.
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    focusedControlProbe: () => Promise.resolve(TEXT_BOX_FOCUS),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    for (const value of ['Enter+Tab', 'Enter+a', '\n', '\r', 'Shift+\r', 'Tab+Enter']) {
      const before = inputCalls(ext);
      await assert.rejects(
        session.act(tab, { action: 'press', value }, undefined, CALLER),
        (error: unknown) =>
          error instanceof AttachedError &&
          error.rule === 'attached.key_unparseable' &&
          error.message.includes('is not a key'),
        `${JSON.stringify(value)} refused as not a key`,
      );
      assert.equal(inputCalls(ext), before, `no Input call for ${JSON.stringify(value)}`);
    }
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('a valid owner grant lets the one step through once; the same token again is refused as replayed', async () => {
  const secret = 'fixture-grant-secret';
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    ownerGrantSecret: secret,
    focusedControlProbe: () => Promise.resolve({ tag: 'button', accessibleName: 'Pay' }),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const token = signGrant(secret, {
      leaseKey: CALLER.leaseKey,
      ref: '',
      accessibleName: 'Pay',
      urlHost: 'example.com',
      issuedAtSeconds: Math.floor(Date.now() / 1_000),
    });
    // First call: the gate lets it, and the key event **crosses** — the
    // allowed half of the rejection rule, stated as a physical fact. The
    // follow-on snapshot the fake cannot render is swallowed, as in the
    // Escape row above; the crossing is the proof.
    const keysBefore = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    const failures: unknown[] = [];
    void session
      .act(tab, { action: 'press', value: 'Enter' }, undefined, { ...CALLER, ownerGrant: token })
      .catch((error: unknown) => failures.push(error));
    await waitFor(
      () => cdpCalls(ext, 'Input.dispatchKeyEvent').length > keysBefore,
      'the granted key press crossing',
    );
    // What the granted press put over the bridge, counted **after** it
    // crossed and after the pair settles: a key is a down and an up, so the
    // honest baseline for "no more keys" is wherever the count stood once
    // the press was complete — not a hard-coded event count, and not a
    // mid-pair snapshot.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterGrant = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    for (const failure of failures) {
      assert.ok(
        !(failure instanceof AttachedError && failure.rule.startsWith('attached.')),
        'the granted press was never refused by a gate rule',
      );
    }
    // Second call, same token: spent. Refused, and the key count does not
    // move again.
    await assert.rejects(
      session.act(tab, { action: 'press', value: 'Enter' }, undefined, {
        ...CALLER,
        ownerGrant: token,
      }),
      (error: unknown) =>
        error instanceof AttachedError &&
        error.rule === 'attached.grant_invalid' &&
        error.message.includes('replayed') &&
        // The token itself appears nowhere in what the caller is told.
        !error.message.includes(token),
    );
    assert.equal(cdpCalls(ext, 'Input.dispatchKeyEvent').length, afterGrant);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('a grant signed for a different control is forged against the live page, and never retries as another verdict', async () => {
  const secret = 'fixture-grant-secret';
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    ownerGrantSecret: secret,
    focusedControlProbe: () => Promise.resolve({ tag: 'button', accessibleName: 'Pay' }),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const token = signGrant(secret, {
      leaseKey: CALLER.leaseKey,
      ref: '',
      accessibleName: 'Buy',
      urlHost: 'example.com',
      issuedAtSeconds: Math.floor(Date.now() / 1_000),
    });
    const before = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    await assert.rejects(
      session.act(tab, { action: 'press', value: 'Enter' }, undefined, {
        ...CALLER,
        ownerGrant: token,
      }),
      (error: unknown) =>
        error instanceof AttachedError &&
        error.rule === 'attached.grant_invalid' &&
        error.message.includes('forged'),
    );
    assert.equal(cdpCalls(ext, 'Input.dispatchKeyEvent').length, before);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('with no signing secret configured the seam is inert: a carried token answers no_grant, never allow', async () => {
  const token = `${String(Math.floor(Date.now() / 1_000))}.ZmFrZS10YWctbm90LWEtY3J5cHRvZ3JhcGhpYy10YWc`;
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    focusedControlProbe: () => Promise.resolve({ tag: 'button', accessibleName: 'Pay' }),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const before = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    await assert.rejects(
      session.act(tab, { action: 'press', value: 'Enter' }, undefined, {
        ...CALLER,
        ownerGrant: token,
      }),
      (error: unknown) =>
        error instanceof AttachedError &&
        error.rule === 'attached.no_grant' &&
        !error.message.includes(token),
      'an uncheckable token is not a pass, and never an echo',
    );
    assert.equal(cdpCalls(ext, 'Input.dispatchKeyEvent').length, before);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('the repeat guard: the same press again after a navigation refuses, and the second key never crosses', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    focusedControlProbe: () => Promise.resolve(TEXT_BOX_FOCUS),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const keysBefore = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    void session
      .act(tab, { action: 'press', value: 'a' }, undefined, CALLER)
      .catch(() => undefined);
    await waitFor(
      () => cdpCalls(ext, 'Input.dispatchKeyEvent').length > keysBefore,
      'the first press crossing',
    );
    // Settle the down/up pair before taking the baseline, as in the grant
    // row: the claim is about the **replay**, and a mid-pair snapshot would
    // confuse the first press's own second event for a second press.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterFirst = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    // A navigation asked for — the fake bounds it unfinalised, but the page
    // has moved as far as this session can know, and that is what the
    // guard's generation counter records before the goto.
    await session.navigate(tab, 'https://example.com/next', 300).catch(() => undefined);
    await assert.rejects(
      session.act(tab, { action: 'press', value: 'a' }, undefined, CALLER),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.act_repeat',
    );
    assert.equal(
      cdpCalls(ext, 'Input.dispatchKeyEvent').length,
      afterFirst,
      'the replayed press never went out',
    );
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('a different acting key after a navigation is not the same act, and the repeat guard stays out of it', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    focusedControlProbe: () => Promise.resolve(TEXT_BOX_FOCUS),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const keysBefore = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    void session
      .act(tab, { action: 'press', value: 'a' }, undefined, CALLER)
      .catch(() => undefined);
    await waitFor(
      () => cdpCalls(ext, 'Input.dispatchKeyEvent').length > keysBefore,
      'the first press crossing',
    );
    await new Promise((resolve) => setTimeout(resolve, 100)); // settle the down/up pair
    await session.navigate(tab, 'https://example.com/next', 300).catch(() => undefined);
    const afterFirst = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    // Same tab, same verb, same (empty) refs, **different key**: the row
    // §6 calls an "identical act" is identical in the key it presses too,
    // and this one is not. It goes out — the physical half of the row.
    void session
      .act(tab, { action: 'press', value: 'b' }, undefined, CALLER)
      .catch(() => undefined);
    await waitFor(
      () => cdpCalls(ext, 'Input.dispatchKeyEvent').length > afterFirst,
      'the different-key press crossing',
    );
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('the page secret-field scan names every secret token the gate reads on a control', () => {
  // gate.fieldKind calls a control secret by these `autocomplete` tokens;
  // the page scan must name the same set, or a page holding only a card
  // **expiry** field passes the "any submit over a card page" rule.
  for (const token of [
    'password',
    'current-password',
    'new-password',
    'one-time-code',
    'cc-number',
    'cc-exp',
    'cc-exp-month',
    'cc-exp-year',
    'cc-csc',
  ]) {
    assert.ok(
      SECRET_FIELD_SELECTOR.includes(`autocomplete~="${token}"`),
      `fieldKind treats autocomplete "${token}" as a secret; the page scan must name it too`,
    );
  }
});

// ── drag: both endpoints are decided ───────────────────────────────────────
//
// A drag moves a value *into* the drop target and drops *onto* it. Deciding
// only the source would let a value land in a password field and let a
// control named by a consequence word serve as a drop target — so every
// drag row here names the endpoint that is dangerous and pins that the
// pair is refused because of it, with the `Input.*` count unmoved. The
// allowed row pins the decision half only: the fake cannot render the
// snapshot the reference resolver reads, so the drag itself waits out the
// snapshot timeout, never reaching a browser call — the drag's physical
// completion rides the gated browser job, as §3.5's completions do.

test('drag into a password input is refused at the drop target, and no Input call is asked for', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    elementFactsProbe: (ref: string) =>
      Promise.resolve(
        ref === 'e2'
          ? { tag: 'input', inputType: 'password', accessibleName: 'Confirm password' }
          : { tag: 'li', accessibleName: 'Widget' },
      ),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const tabsBefore = (await session.listTabs()).length;
    const before = inputCalls(ext);
    await assert.rejects(
      session.act(tab, { action: 'drag', ref: 'e1', targetRef: 'e2' }),
      (error: unknown) =>
        error instanceof AttachedError && error.rule === 'attached.field_forbidden',
      'a value dropped into a password field is the fill the field guard exists to stop',
    );
    assert.equal(inputCalls(ext), before, 'no input call was ever sent to the page');
    assert.equal((await session.listTabs()).length, tabsBefore, 'no tab opened or closed');
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('drag onto a target named "Pay now" answers needs_owner — consequence on either end asks the owner', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    elementFactsProbe: (ref: string) =>
      Promise.resolve(
        ref === 'e2'
          ? { tag: 'button', accessibleName: 'Pay now', role: 'button' }
          : { tag: 'li', accessibleName: 'Widget' },
      ),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const tabsBefore = (await session.listTabs()).length;
    const before = inputCalls(ext);
    // No grant engages a two-ref call, so the consequential target is the
    // agent's path: needs_owner, pointing at browser_sign_in.
    await assert.rejects(
      session.act(tab, { action: 'drag', ref: 'e1', targetRef: 'e2' }, undefined, CALLER),
      (error: unknown) =>
        error instanceof AttachedError &&
        error.rule === 'attached.needs_owner' &&
        error.message.includes('browser_sign_in'),
    );
    assert.equal(inputCalls(ext), before, 'the drop was never attempted');
    assert.equal((await session.listTabs()).length, tabsBefore, 'no tab opened or closed');
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('a clean drag is allowed on both endpoints; its physical completion rides the gated browser job', async () => {
  const rows: string[] = [];
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    elementFactsProbe: (ref: string) =>
      Promise.resolve(
        ref === 'e1'
          ? { tag: 'li', accessibleName: 'Widget' }
          : { tag: 'div', accessibleName: 'Inbox' },
      ),
    pageSecretProbe: () => Promise.resolve(false),
    actionLog: (entry) => {
      rows.push(entry.outcome);
    },
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    let failure: unknown;
    const attempted = session
      .act(tab, { action: 'drag', ref: 'e1', targetRef: 'e2' }, undefined, CALLER)
      .catch((error: unknown) => {
        failure = error;
      });
    // The gate's answer comes **before** the reference snapshot the fake
    // cannot render, so a rule refusal surfaces in milliseconds while an
    // allow sits waiting in that snapshot's timeout. A short beat tells
    // the two apart without waiting the timeout out.
    for (let beat = 0; beat < 250 && failure === undefined; beat += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      failure,
      undefined,
      `the gate refused a clean pair: ${failure instanceof AttachedError ? failure.rule : String(failure)}`,
    );
    assert.deepEqual(rows, [], 'no gate rule refused either endpoint');
    void attempted;
  } finally {
    session.detach().catch(() => undefined);
  }
});

// ── dialog dispositions are bound to the page that armed them ──────────────
//
// The `dialog` verb arms a disposition behind the gate; the page's dialog
// event spends it once. Navigation is free, so a disposition that survived
// it would be a standing answer handed to whatever page the navigation
// reaches — including one the act list does not name, where acting verbs
// never run. The control row first proves the route works at all through
// the fake (arm spends on the arming page, once); the second row pins the
// navigation case against the call log.

test('an armed dialog answer is spent by the page that armed it, and only once', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const handleCalls = (): number => cdpCalls(ext, 'Page.handleJavaScriptDialog').length;
    const armed = session.act(
      tab,
      { action: 'dialog', response: { accept: true } },
      undefined,
      CALLER,
    );
    armed.catch(() => undefined); // the follow-on snapshot is the fake's limit
    await new Promise((resolve) => setTimeout(resolve, 100));
    raiseDialog(ext, ext.lastCreatedTabId);
    await waitFor(() => handleCalls() > 0, 'the armed accept crossing as a dialog answer');
    const answer = ext.calls.find(
      (call) =>
        call.method === 'chrome.debugger.sendCommand' &&
        call.params[1] === 'Page.handleJavaScriptDialog',
    );
    assert.equal(
      (answer?.params[2] as { accept?: boolean } | undefined)?.accept,
      true,
      'the disposition was spent as the caller armed it',
    );
    // Spent: the next dialog on the same page is the person's to answer.
    const spent = handleCalls();
    await new Promise((resolve) => setTimeout(resolve, 300));
    raiseDialog(ext, ext.lastCreatedTabId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(handleCalls(), spent, 'no disposition is left standing to spend twice');
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('a dialog disposition armed on a listed site does not survive navigation to an off-list one', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const tabId = ext.lastCreatedTabId;
    const handleCalls = (): number => cdpCalls(ext, 'Page.handleJavaScriptDialog').length;
    const before = handleCalls();
    const armed = session.act(
      tab,
      { action: 'dialog', response: { accept: true } },
      undefined,
      CALLER,
    );
    armed.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Navigation itself is free — that is the rule. The arm is not, and it
    // must not ride along with it: the page that raised the dialog is
    // gone, and the address now named is on no list.
    await session.navigate(tab, 'https://example.net/confirm', 300).catch(() => undefined);
    raiseDialog(ext, tabId);
    await new Promise((resolve) => setTimeout(resolve, 400));
    raiseDialog(ext, tabId);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      handleCalls(),
      before,
      "the off-list page's dialog was never answered on the owner's behalf",
    );
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('every acting decision the session makes lands one audit row, and no row carries the grant', async () => {
  const secret = 'fixture-grant-secret';
  const rows: { verb: string; outcome: string; host: string; claimId: string }[] = [];
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    ownerGrantSecret: secret,
    focusedControlProbe: () => Promise.resolve({ tag: 'button', accessibleName: 'Pay' }),
    pageSecretProbe: () => Promise.resolve(false),
    actionLog: (entry) => {
      rows.push({
        verb: entry.verb,
        outcome: entry.outcome,
        host: entry.host,
        claimId: entry.claimId,
      });
    },
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const token = signGrant(secret, {
      leaseKey: CALLER.leaseKey,
      ref: '',
      accessibleName: 'Pay',
      urlHost: 'example.com',
      issuedAtSeconds: Math.floor(Date.now() / 1_000),
    });
    // refused row: no grant.
    await session
      .act(tab, { action: 'press', value: 'Enter' }, undefined, CALLER)
      .catch(() => undefined);
    // acted row: valid grant (the snapshot after is the fake's limit; the
    // decision row is written before it).
    void session
      .act(tab, { action: 'press', value: 'Enter' }, undefined, { ...CALLER, ownerGrant: token })
      .catch(() => undefined);
    await waitFor(() => rows.some((row) => row.outcome === 'acted'), 'the acted row');
    // replayed row.
    await session
      .act(tab, { action: 'press', value: 'Enter' }, undefined, { ...CALLER, ownerGrant: token })
      .catch(() => undefined);
    assert.deepEqual(
      rows.map((row) => row.outcome),
      ['attached.needs_owner', 'acted', 'attached.grant_invalid'],
    );
    assert.ok(rows.every((row) => row.host === 'example.com'));
    assert.ok(rows.every((row) => row.claimId === CALLER.claimId));
  } finally {
    session.detach().catch(() => undefined);
  }
});

// ── the review's hunt list, at the session ──────────────────────────────────
//
// What these rows add to the gate's table is the **physical half** of each
// refusal: the call log. A gate that says "needs the owner" after the key was
// sent is the failure this codebase is organised against, so every row here
// reads the extension's call log, not only the answer.

/** The `Input.*` commands the extension was asked for — a typed key, an inserted text, a click. */
function inputCountOf(ext: FakeExtension): number {
  return inputCalls(ext);
}

test('B1: a ref-less press into a focused password field is refused, and not one key crosses', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    focusedControlProbe: () =>
      Promise.resolve({ tag: 'input', inputType: 'password', accessibleName: 'Password' }),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const before = inputCountOf(ext);
    for (const key of ['h', 'p', 'Enter']) {
      await assert.rejects(
        session.act(tab, { action: 'press', value: key }, undefined, CALLER),
        (error: unknown) =>
          error instanceof AttachedError &&
          error.rule === 'attached.field_forbidden' &&
          error.message.includes('password'),
      );
    }
    assert.equal(inputCountOf(ext), before, 'no key reached the password field');
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('B2: Enter, a chord and a site shortcut each ask the owner, and no key crosses', async () => {
  for (const { focus, key } of [
    { focus: TEXT_BOX_FOCUS, key: 'Enter' },
    { focus: TEXT_BOX_FOCUS, key: 'NumpadEnter' },
    {
      focus: { tag: 'div', role: 'textbox', editable: true, accessibleName: 'Message body' },
      key: 'Control+Enter',
    },
    { focus: { tag: 'body' }, key: '#' },
    { focus: { tag: 'body' }, key: 'Shift+3' },
  ] as const) {
    const { bridge, ext, session } = await live({
      attachedActSites: ['example.com'],
      focusedControlProbe: () => Promise.resolve(focus),
      pageSecretProbe: () => Promise.resolve(false),
    });
    try {
      const tab = await openedTab({ bridge, ext, session });
      const before = inputCountOf(ext);
      await assert.rejects(
        session.act(tab, { action: 'press', value: key }, undefined, CALLER),
        (error: unknown) =>
          error instanceof AttachedError &&
          error.rule === 'attached.needs_owner' &&
          error.message.includes('browser_sign_in'),
        `${key} with ${focus.tag} focused is the owner's`,
      );
      assert.equal(inputCountOf(ext), before, `${key} never crossed`);
    } finally {
      session.detach().catch(() => undefined);
    }
  }
});

test('B2: a type whose text carries a newline is an Enter, and nothing is typed', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    elementFactsProbe: () => Promise.resolve({ ...TEXT_BOX_FOCUS }),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const before = inputCountOf(ext);
    await assert.rejects(
      session.act(tab, { action: 'type', ref: 'e1', value: 'hello\n' }, undefined, CALLER),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.needs_owner',
    );
    assert.equal(inputCountOf(ext), before);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('B2: with the cursor in a text box, a letter is typing and crosses', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    focusedControlProbe: () => Promise.resolve(TEXT_BOX_FOCUS),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const before = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    void session
      .act(tab, { action: 'press', value: 'a' }, undefined, CALLER)
      .catch(() => undefined);
    await waitFor(
      () => cdpCalls(ext, 'Input.dispatchKeyEvent').length > before,
      'the allowed letter crossing',
    );
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('H3: an armed dialog answer does not survive a navigation the page made by itself', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const tabId = ext.lastCreatedTabId;
    const handleCalls = (): number => cdpCalls(ext, 'Page.handleJavaScriptDialog').length;
    const armed = session.act(
      tab,
      { action: 'dialog', response: { accept: true } },
      undefined,
      CALLER,
    );
    armed.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A click on a link, a submit, a redirect: the page moves and the broker's
    // own `navigate` is never called.
    pageNavigatesItself(ext, tabId, 'https://example.net/next');
    await new Promise((resolve) => setTimeout(resolve, 200));
    raiseDialog(ext, tabId);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(handleCalls(), 0, "the next page's dialog was never answered for the owner");
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('H3: a dialog whose message names a consequence is left to the owner, armed or not', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const tabId = ext.lastCreatedTabId;
    const handleCalls = (): number => cdpCalls(ext, 'Page.handleJavaScriptDialog').length;
    session
      .act(tab, { action: 'dialog', response: { accept: true } }, undefined, CALLER)
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    raiseDialog(ext, tabId, 'Permanently delete your account?');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(handleCalls(), 0, 'a consequential confirm is the owner to answer');
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('M2: the repeat guard sees a navigation the page made itself', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    focusedControlProbe: () => Promise.resolve(TEXT_BOX_FOCUS),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const keysBefore = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    void session
      .act(tab, { action: 'press', value: 'a' }, undefined, CALLER)
      .catch(() => undefined);
    await waitFor(
      () => cdpCalls(ext, 'Input.dispatchKeyEvent').length > keysBefore,
      'the first press crossing',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterFirst = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    pageNavigatesItself(ext, ext.lastCreatedTabId, 'https://example.com/after-the-click');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(
      session.act(tab, { action: 'press', value: 'a' }, undefined, CALLER),
      (error: unknown) => error instanceof AttachedError && error.rule === 'attached.act_repeat',
    );
    assert.equal(cdpCalls(ext, 'Input.dispatchKeyEvent').length, afterFirst);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('H5: a grant signed for a click does not verify for a press, whatever the control and host', async () => {
  const secret = 'fixture-grant-secret';
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    ownerGrantSecret: secret,
    focusedControlProbe: () => Promise.resolve({ tag: 'button', accessibleName: 'Pay' }),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const before = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    const wrongVerb = signGrant(secret, {
      leaseKey: CALLER.leaseKey,
      ref: '',
      accessibleName: 'Pay',
      urlHost: 'example.com',
      issuedAtSeconds: Math.floor(Date.now() / 1_000),
      verb: 'click',
      value: '',
    });
    await assert.rejects(
      session.act(tab, { action: 'press', value: 'Enter' }, undefined, {
        ...CALLER,
        ownerGrant: wrongVerb,
      }),
      (error: unknown) =>
        error instanceof AttachedError &&
        error.rule === 'attached.grant_invalid' &&
        error.message.includes('forged'),
    );
    const otherKey = signGrant(secret, {
      leaseKey: CALLER.leaseKey,
      ref: '',
      accessibleName: 'Pay',
      urlHost: 'example.com',
      issuedAtSeconds: Math.floor(Date.now() / 1_000),
      verb: 'press',
      value: 'Space',
    });
    await assert.rejects(
      session.act(tab, { action: 'press', value: 'Enter' }, undefined, {
        ...CALLER,
        ownerGrant: otherKey,
      }),
      (error: unknown) =>
        error instanceof AttachedError &&
        error.rule === 'attached.grant_invalid' &&
        error.message.includes('forged'),
    );
    assert.equal(cdpCalls(ext, 'Input.dispatchKeyEvent').length, before);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('L1: an audit write that fails after the act does not turn a performed act into an error', async () => {
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    focusedControlProbe: () => Promise.resolve(TEXT_BOX_FOCUS),
    pageSecretProbe: () => Promise.resolve(false),
    actionLog: () => {
      throw new Error('SQLITE_BUSY: database is locked');
    },
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const keysBefore = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
    const outcome = session.act(tab, { action: 'press', value: 'a' }, undefined, CALLER).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );
    await waitFor(
      () => cdpCalls(ext, 'Input.dispatchKeyEvent').length > keysBefore,
      'the press crossing',
    );
    const settled = await Promise.race([
      outcome,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 500)),
    ]);
    assert.ok(
      !(settled instanceof Error && settled.message.includes('SQLITE_BUSY')),
      'the caller was not handed the log failure for an act that happened',
    );
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('L4: the control name the log keeps is capped, so a hostile page cannot bloat the store', async () => {
  const names: (string | undefined)[] = [];
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    elementFactsProbe: () =>
      Promise.resolve({ tag: 'button', accessibleName: `Pay ${'x'.repeat(5_000)}` }),
    pageSecretProbe: () => Promise.resolve(false),
    actionLog: (entry) => names.push(entry.accessibleName),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    await session
      .act(tab, { action: 'click', ref: 'e1' }, undefined, CALLER)
      .catch(() => undefined);
    assert.equal(names.length, 1);
    assert.ok((names[0] ?? '').length <= 200, 'the stored name is bounded');
    assert.ok((names[0] ?? '').startsWith('Pay '));
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('L2: one spelling of the movement keys — a lower-cased name is no movement key at either door', async () => {
  assert.equal(isViewMovingAction({ action: 'press', value: 'arrowdown' }), false);
  for (const key of NAVIGATION_KEYS) {
    assert.equal(
      isViewMovingAction({ action: 'press', value: key }),
      true,
      `${key} moves the view`,
    );
  }
  // With acting off, the lower-cased spelling is refused at the door and
  // never reaches the performer — and since the strict grammar it is
  // refused as **not a key at all**, the same answer a wrong-cased spelling
  // gets on a listed site.
  const { bridge, ext, session } = await live({ attachedActSites: [] });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const before = inputCountOf(ext);
    await assert.rejects(
      session.act(tab, { action: 'press', value: 'arrowdown' }),
      (error: unknown) =>
        error instanceof AttachedError && error.rule === 'attached.key_unparseable',
    );
    assert.equal(inputCountOf(ext), before);
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('F2: keys the library cannot press and wrong-case modifiers refuse at the grammar — the page is never half-pressed', async () => {
  // The library's `press` holds each modifier of a combination down before
  // it tries the next token, releases nothing on a throw, and knows a
  // single character only inside printable ASCII. So `é` after a modifier,
  // or a wrong-case `control`, is not a spelling to canonicalise — it is a
  // chord that would arrive modified with a stuck Shift or Control behind
  // it. Every one of these refuses as **not a key**, on a listed site,
  // before a single `Input.*` crosses.
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    focusedControlProbe: () => Promise.resolve(TEXT_BOX_FOCUS),
    pageSecretProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    for (const key of [
      'Shift+é',
      'Control+é',
      'é',
      '\u0000',
      '\u007f',
      'shift+a',
      'Shift+control+a',
    ]) {
      const before = inputCountOf(ext);
      await assert.rejects(
        session.act(tab, { action: 'press', value: key }, undefined, CALLER),
        (error: unknown) =>
          error instanceof AttachedError && error.rule === 'attached.key_unparseable',
        `${JSON.stringify(key)} is not a key the grammar admits`,
      );
      assert.equal(inputCountOf(ext), before, `${JSON.stringify(key)} never reached the page`);
    }
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('F3: a control that will not take focus refuses a type at its ref, and no key crosses', async () => {
  // The gate answered from the control's facts; this is the physical half
  // of the focus proof — before any key the session proves the named
  // control *is* the focused element. A control the page will not let take
  // focus
  // (a disabled input, a hidden one, one that hands focus elsewhere on
  // focus) gets the keys nowhere but where they were forbidden to go, so
  // it refuses as field_forbidden and the relay was never asked for an
  // Input command.
  const { bridge, ext, session } = await live({
    attachedActSites: ['example.com'],
    elementFactsProbe: () =>
      Promise.resolve({ tag: 'input', inputType: 'text', accessibleName: 'Notes', editable: true }),
    pageSecretProbe: () => Promise.resolve(false),
    focusHoldsProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab({ bridge, ext, session });
    const before = inputCountOf(ext);
    await assert.rejects(
      session.act(tab, { action: 'type', ref: 'e1', value: 'hello' }, undefined, CALLER),
      (error: unknown) =>
        error instanceof AttachedError && error.rule === 'attached.field_forbidden',
      'a type at a control that would not take focus refuses',
    );
    assert.equal(inputCountOf(ext), before, 'not one key crossed');
  } finally {
    session.detach().catch(() => undefined);
  }
});

test('F3: a control that will not take focus refuses a press at its ref too — and a control that takes it receives the key', async () => {
  const refusal = await live({
    attachedActSites: ['example.com'],
    elementFactsProbe: () =>
      Promise.resolve({ tag: 'input', inputType: 'text', accessibleName: 'Notes', editable: true }),
    pageSecretProbe: () => Promise.resolve(false),
    focusHoldsProbe: () => Promise.resolve(false),
  });
  try {
    const tab = await openedTab(refusal);
    const before = inputCountOf(refusal.ext);
    await assert.rejects(
      refusal.session.act(tab, { action: 'press', ref: 'e1', value: 'h' }, undefined, CALLER),
      (error: unknown) =>
        error instanceof AttachedError && error.rule === 'attached.field_forbidden',
      'a press at a control that would not take focus refuses',
    );
    assert.equal(inputCountOf(refusal.ext), before, 'not one key crossed');
  } finally {
    refusal.session.detach().catch(() => undefined);
  }
  // The other half: with the proof saying the control holds focus, the
  // keys cross. The act's own snapshot step cannot complete on the fake
  // (the same fixture limit as every other acting row), so the row reads
  // the call log, not the response.
  const pass = await live({
    attachedActSites: ['example.com'],
    elementFactsProbe: () =>
      Promise.resolve({ tag: 'input', inputType: 'text', accessibleName: 'Notes', editable: true }),
    pageSecretProbe: () => Promise.resolve(false),
    focusHoldsProbe: () => Promise.resolve(true),
  });
  try {
    const tab = await openedTab(pass);
    const before = inputCountOf(pass.ext);
    void pass.session
      .act(tab, { action: 'press', ref: 'e1', value: 'h' }, undefined, CALLER)
      .catch(() => undefined);
    await waitFor(() => inputCountOf(pass.ext) > before, 'the proved press crossing');
  } finally {
    pass.session.detach().catch(() => undefined);
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

test('the press gate, answered: a focused control refuses and the key never crosses; plain focus lets it through, and Escape asks the same read', async () => {
  // The true branch the unread fixture can never show. The fake relay
  // cannot complete the page's own evaluate — the same isolated-world
  // limit the scroll row above pins — so the read is answered through the
  // seam's own injection and both branches become provable: the refusal
  // **and its call-log half**, the key crossing when there is nothing to
  // reach, and Escape asking the same read before it dismisses. The real read's answer
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
    const { bridge, ext, session } = await live({ focusProbe: probe });
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
    const { bridge, ext, session } = await live({ focusProbe: probe });
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
      // Escape over plain focus: the moving counter is one half of the
      // proof that it asked the same read, and the crossing is the other —
      // with nothing focused it goes out as the dismissal it is allowed
      // for.
      const escapeKeys = cdpCalls(ext, 'Input.dispatchKeyEvent').length;
      void session
        .act(tab, { action: 'press', value: 'Escape' })
        .catch((error: unknown) => failures.push(error));
      await waitFor(
        () => cdpCalls(ext, 'Input.dispatchKeyEvent').length > escapeKeys,
        'the Escape key crossing',
      );
      assert.equal(probed, 2, 'Escape did not ask the page before dismissing over it');
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
    const { bridge, ext, session } = await live({ focusProbe: probe });
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
