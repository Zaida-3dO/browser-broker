import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright-core';

import { connect } from '../../src/attach/session.ts';
import type { AttachedBridge } from '../../src/attach/session.ts';
import { FakeExtension } from './fake-extension.ts';

/**
 * Playwright's own client — not the test's — against the relay.
 *
 * Every `npm test` run carries the real `connectOverCDP` handshake against
 * this relay: the socket this package frames, the version call the relay
 * answers itself, the auto-attach the model drives, and a target the client
 * creates *through* the relay. It speaks to the pinned `playwright-core`, so
 * the pin the package ships is the pin the handshake is proven against, and a
 * bump that broke the copied relay's protocol half names itself here.
 *
 * The other end is the fake, not a browser — so this row needs neither a
 * binary nor a display, and it never skips. (Driving a real Chromium behind
 * the fake bridge is the advisory browser job the plan names; it belongs with
 * the gated suites in the browser-test script, not here.)
 */

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

async function connectedBridge(): Promise<{ bridge: AttachedBridge; ext: FakeExtension }> {
  const bridge = await connect({ clientName: 'over cdp', extensionId: EXTENSION_ID });
  const ext = await FakeExtension.connect(bridge.extensionEndpoint, {
    origin: EXTENSION_ORIGIN,
  });
  await ext.initialize();
  await bridge.waitForExtension(5_000);
  return { bridge, ext };
}

test('a real Playwright client connects through the relay and opens a tab', async () => {
  const { bridge, ext } = await connectedBridge();
  const browser = await chromium.connectOverCDP(bridge.cdpEndpoint, { timeout: 15_000 });
  try {
    assert.equal(browser.isConnected(), true);
    // The version the relay answers itself — the first frame of the handshake.
    assert.match(browser.version(), /Extension-Bridge/);

    const context = browser.contexts()[0];
    assert.ok(context, 'connectOverCDP lands on the default context');
    const page = await context.newPage();
    assert.equal(page.url(), 'https://example.com/fake', 'the page the fake answers on');

    // The tab the client asked for is in the ownership mirror — the guards
    // downstream (reconcile, foreign-tab) key their refusals on exactly this.
    await waitFor(() => bridge.tabs().length === 1, 'the created tab in the mirror');
    const ours = bridge.tabs()[0];
    assert.ok(ours && bridge.isOurs(ours.id as number));
    assert.equal(bridge.isOurs(999), false, 'a foreign tab is absent, not hidden');

    // Closing it through Playwright closes it in the mirror too — one
    // removal path, whoever asked.
    await page.close();
    await waitFor(() => bridge.tabs().length === 0, 'the tab out of the mirror');
    assert.ok(ext.sawCall('chrome.tabs.remove'), 'the close reached the extension side');
    assert.ok(ext.sawCall('chrome.tabs.create'), 'and so did the open');
  } finally {
    // No browser.close(): over this bridge the port itself is the connection,
    // and the lease ending is what closes it.
    bridge.close('test over');
  }
});

test('a per-tab command from the client reaches the extension on the right session', async () => {
  const { bridge, ext } = await connectedBridge();
  const browser = await chromium.connectOverCDP(bridge.cdpEndpoint, { timeout: 15_000 });
  try {
    const page = await browser.contexts()[0]!.newPage();
    // An ordinary per-tab command: the model must resolve the client's
    // sessionId to a tab and forward it as a debugger command for that tab.
    await page.setViewportSize({ width: 800, height: 600 });
    const tabCommands = ext.calls.filter(
      (call) =>
        call.method === 'chrome.debugger.sendCommand' &&
        (call.params[1] as string) === 'Emulation.setDeviceMetricsOverride',
    );
    assert.ok(tabCommands.length > 0, 'the act crossed the bridge');
    const source = tabCommands[0]?.params[0] as { tabId?: number } | undefined;
    assert.equal(
      bridge.isOurs(source?.tabId as number),
      true,
      'it was addressed to a tab this connection owns',
    );
  } finally {
    bridge.close('test over');
  }
});

/** The mirror and the call log update a turn after the socket carries the fact. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
