import assert from 'node:assert/strict';
import test from 'node:test';

import { connect } from '../../src/attach/session.ts';
import type { AttachedBridge, DebuggerDetachedDetail } from '../../src/attach/session.ts';
import { connectWebSocket } from '../../src/attach/ws.ts';
import { FakeExtension } from './fake-extension.ts';

/**
 * The bridge while it is alive: the events the session layer is promised, the
 * ownership mirror's rules, and the promise that a configured token is used
 * without ever being written down.
 */

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

async function connectedBridge(
  options: { token?: string; log?: (line: string) => void } = {},
): Promise<{ bridge: AttachedBridge; ext: FakeExtension }> {
  const bridge = await connect({
    clientName: 'a lease',
    extensionId: EXTENSION_ID,
    ...options,
  });
  const ext = await FakeExtension.connect(bridge.extensionEndpoint, {
    origin: EXTENSION_ORIGIN,
  });
  await ext.initialize();
  await bridge.waitForExtension(5_000);
  return { bridge, ext };
}

/**
 * A sendEvent or close crosses a real socket, so the mirror and the events
 * land a turn later. Everything asserted about them waits for that turn
 * rather than pretending TCP is synchronous.
 */
async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('the handshake completes once the extension initializes, and its protocol version is kept', async () => {
  const bridge = await connect({ clientName: 'a lease', extensionId: EXTENSION_ID });
  try {
    // Before init: connected on the socket, not ready for commands.
    const ext = await FakeExtension.connect(bridge.extensionEndpoint, {
      origin: EXTENSION_ORIGIN,
      protocolVersion: 99,
    });
    assert.equal(bridge.extensionConnected(), true);
    let resolved = false;
    const wait = bridge.waitForExtension(5_000).then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(resolved, false, 'no handshake yet');
    await ext.initialize();
    await wait;
    // The version the extension *reported* is what the doctor will name;
    // 99 here is the mismatch case stated as data.
    assert.equal(bridge.extensionProtocolVersion(), 99);
    ext.close();
  } finally {
    bridge.close();
  }
});

test('the ownership mirror follows the extension, and only the extension', async () => {
  const { bridge, ext } = await connectedBridge();
  const events: string[] = [];
  bridge.on('tabsChanged', (tabs) => events.push(`changed:${tabs.map((t) => t.id).join(',')}`));
  try {
    // A tab the extension reports — one it created, or one he picked — is ours.
    ext.sendEvent('chrome.tabs.onCreated', [{ id: 5, url: 'https://example.com/a', title: 'A' }]);
    await waitUntil(() => bridge.isOurs(5), 'tab 5 in the mirror');
    assert.deepEqual(
      bridge.tabs().map((tab) => tab.id),
      [5],
    );
    assert.equal(bridge.isOurs(5), true);

    // A foreign tab is never listed: the extension never reports it, and the
    // mirror has no other source. Asking about it is the refusal test — the
    // answer is false with no round trip and no record.
    assert.equal(bridge.isOurs(6), false);
    assert.equal(bridge.isOursByTargetId('target-of-a-foreign-tab'), false);

    // Removed is removed, through the same event any other closer would send.
    ext.sendEvent('chrome.tabs.onRemoved', [5]);
    await waitUntil(() => !bridge.isOurs(5), 'tab 5 out of the mirror');
    assert.deepEqual(bridge.tabs(), []);
    assert.equal(bridge.isOurs(5), false);
    assert.deepEqual(events, ['changed:5', 'changed:']);

    // A tab created *through* the bridge also lands in the mirror — the
    // extension reports its own creations like any other.
    ext.sendEvent('chrome.tabs.onCreated', [{ id: 12, url: 'https://example.com/b' }]);
    await waitUntil(() => bridge.isOurs(12), 'tab 12 in the mirror');
    assert.equal(bridge.isOurs(12), true);
  } finally {
    bridge.close();
  }
});

test('a large reported title survives the framing intact', async () => {
  const { bridge, ext } = await connectedBridge();
  try {
    const title = 'x'.repeat(200_000);
    ext.sendEvent('chrome.tabs.onCreated', [{ id: 77, url: 'https://example.com/big', title }]);
    await waitUntil(() => bridge.tabs().length === 1, 'the whole big tab');
    const tabs = bridge.tabs();
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0]?.title, title, 'the whole payload arrived, reassembled');
  } finally {
    bridge.close();
  }
});

test('his Cancel on the debugger bar arrives as debuggerDetached', async () => {
  const { bridge, ext } = await connectedBridge();
  try {
    ext.sendEvent('chrome.tabs.onCreated', [{ id: 9, url: 'https://example.com/c' }]);
    const detail = await new Promise<DebuggerDetachedDetail>((resolve) => {
      bridge.on('debuggerDetached', resolve);
      ext.sendEvent('chrome.debugger.onDetach', [{ tabId: 9 }, { reason: 'canceled by the user' }]);
    });
    assert.deepEqual(detail, { tabId: 9, reason: 'canceled by the user' });
    // The tab itself is still a tab; only its debuggability ended.
    assert.equal(bridge.isOurs(9), true);
  } finally {
    bridge.close();
  }
});

test('extension disconnect is an event, and the bridge stays refused while off', async () => {
  const bridge = await connect({ clientName: 'a lease', extensionId: EXTENSION_ID });
  const events: string[] = [];
  startAll(bridge, events);
  const ext = await FakeExtension.connect(bridge.extensionEndpoint, { origin: EXTENSION_ORIGIN });
  await ext.initialize();
  await bridge.waitForExtension(5_000);
  try {
    ext.close('he closed the browser');
    const reason = await ext.onceClosed();
    assert.equal(reason, 'he closed the browser');
    await waitUntil(
      () => events.includes('extensionDisconnected:he closed the browser'),
      'the relay to see the socket end',
    );
    assert.equal(
      events.includes('extensionDisconnected:he closed the browser'),
      true,
      'the disconnect event carried the reason',
    );
    assert.equal(bridge.extensionConnected(), false);

    // Refused while off: a second extension connection gets the door but is
    // closed with the reason the session layer turns into "not connected,
    // refused not queued" — and it never reaches the protocol.
    const second = await FakeExtension.connect(bridge.extensionEndpoint, {
      origin: EXTENSION_ORIGIN,
    });
    const closedReason = await second.onceClosed();
    assert.match(closedReason, /Bridge ended/);
    assert.equal(bridge.extensionConnected(), false);
    assert.equal(second.calls.length, 0, 'the rejected extension was never served');
    assert.equal(events.filter((e) => e === 'extensionConnected').length, 1);
  } finally {
    bridge.close();
  }
});

function startAll(bridge: AttachedBridge, events: string[]): void {
  bridge.on('extensionConnected', () => events.push('extensionConnected'));
  bridge.on('extensionDisconnected', (reason) => events.push(`extensionDisconnected:${reason}`));
  bridge.on('tabsChanged', () => events.push('tabsChanged'));
  bridge.on('debuggerDetached', () => events.push('debuggerDetached'));
}

test('one Playwright client at a time: the second is closed, the first undisturbed', async () => {
  const { bridge } = await connectedBridge();
  try {
    const first = await connectWebSocket(bridge.cdpEndpoint);
    const second = await connectWebSocket(bridge.cdpEndpoint);
    assert.match(await second.onceClosed(), /Another CDP client already connected/);
    assert.equal(first.readyState, 'open', 'the first client kept its connection');
    first.close();
  } finally {
    bridge.close();
  }
});

test('a Playwright client leaving ends the extension connection too', async () => {
  const { bridge, ext } = await connectedBridge();
  const events: string[] = [];
  startAll(bridge, events);
  try {
    const client = await connectWebSocket(bridge.cdpEndpoint);
    assert.equal(bridge.extensionConnected(), true);
    client.close();
    assert.match(await ext.onceClosed(), /Playwright client disconnected/);
    await waitUntil(() => !bridge.extensionConnected(), 'the relay to end the extension side');
    assert.equal(bridge.extensionConnected(), false);
    assert.ok(
      events.some((event) => event.startsWith('extensionDisconnected:')),
      'the session layer hears it as a disconnect too',
    );
  } finally {
    bridge.close();
  }
});

test('the token rides the connect URL but never the log', async () => {
  const token = 'sekrit-token-value';
  const lines: string[] = [];
  const bridge = await connect({
    clientName: 'a lease',
    extensionId: EXTENSION_ID,
    token,
    log: (line) => lines.push(line),
  });
  try {
    // Used: the connect URL carries it, and the extension skips its page with it.
    assert.match(bridge.connectUrl(), new RegExp(`token=${token}`));
    // Exercised: a whole session's worth of log lines — start, connect,
    // CDP refusals, tabs, close.
    const ext = await FakeExtension.connect(bridge.extensionEndpoint, {
      origin: EXTENSION_ORIGIN,
    });
    await ext.initialize();
    await bridge.waitForExtension(5_000);
    ext.sendEvent('chrome.tabs.onCreated', [{ id: 1, url: 'https://example.com/one' }]);
    const client = await connectWebSocket(bridge.cdpEndpoint);
    client.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      client.onMessage = (text) => resolve(JSON.parse(text) as Record<string, unknown>);
    });
    assert.equal(
      (reply.result as { product?: string } | undefined)?.product,
      'Chrome/Extension-Bridge',
    );
    client.close();
    ext.close();
    await ext.onceClosed();
    bridge.close('lease released');
    const logged = lines.join('\n');
    assert.ok(logged.length > 0, 'the log actually ran');
    assert.ok(!logged.includes(token), `no log line carries the token: ${logged}`);
  } catch (error) {
    bridge.close();
    throw error;
  }
});
