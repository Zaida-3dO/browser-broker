import assert from 'node:assert/strict';
import test from 'node:test';

import { connect } from '../../src/attach/session.ts';
import { AttachedError } from '../../src/attach/errors.ts';
import { connectWebSocket } from '../../src/attach/ws.ts';
import type { AttachedBridge } from '../../src/attach/session.ts';
import { FakeExtension } from './fake-extension.ts';

/**
 * The door tests: who the relay's loopback port admits, and who it sends
 * away.
 *
 * Each refusal row asserts the side effect too — not just that the caller got
 * a status code, but that **nothing behind the door happened**: no connection
 * object exists, no event fired, the tab mirror stayed empty, and the fake
 * extension's call log stayed empty. A guard that answers 403 after taking
 * the connection would pass a status-only suite and protect nothing.
 */

// 32 characters in a–p is the shape of a real extension id; this one is a
// fixture, not anybody's installation.
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

function startListeners(bridge: AttachedBridge, seen: string[]): void {
  bridge.on('extensionConnected', () => seen.push('extensionConnected'));
  bridge.on('extensionDisconnected', (reason) => seen.push(`extensionDisconnected:${reason}`));
  bridge.on('tabsChanged', (tabs) => seen.push(`tabsChanged:${tabs.length}`));
  bridge.on('debuggerDetached', (detail) => seen.push(`debuggerDetached:${detail.tabId}`));
}

async function statusCodeOf(url: string, headers: Record<string, string>): Promise<number> {
  try {
    const ws = await connectWebSocket(url, headers);
    ws.close();
    return 101;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined) return status;
    throw error;
  }
}

test('a wrong door is refused, and nothing behind the door happens', async () => {
  const bridge = await connect({ clientName: 'probe', extensionId: EXTENSION_ID });
  const seen: string[] = [];
  startListeners(bridge, seen);
  try {
    const rows: {
      name: string;
      url: string;
      headers: Record<string, string>;
      status: number;
    }[] = [
      {
        name: 'a Host that is not the loopback address',
        url: bridge.extensionEndpoint,
        headers: { Host: 'evil.example:1', Origin: EXTENSION_ORIGIN },
        status: 403,
      },
      {
        name: 'the loopback Host without a port',
        url: bridge.extensionEndpoint,
        headers: { Host: 'localhost', Origin: EXTENSION_ORIGIN },
        status: 403,
      },
      {
        name: 'a path nobody was given',
        url: bridge.cdpEndpoint.replace(
          /\/cdp\/[^/]+$/,
          '/cdp/00000000-0000-4000-8000-000000000000',
        ),
        headers: {},
        status: 404,
      },
      {
        name: 'the extension path from a web page origin',
        url: bridge.extensionEndpoint,
        headers: { Origin: 'https://example.com' },
        status: 403,
      },
      {
        name: 'the extension path from a different extension',
        url: bridge.extensionEndpoint,
        headers: { Origin: 'chrome-extension://pppppppppppppppppppppppppppppppp' },
        status: 403,
      },
      {
        name: 'the extension path with no origin at all',
        url: bridge.extensionEndpoint,
        headers: {},
        status: 403,
      },
      {
        name: 'an upgrade asking for a subprotocol',
        url: bridge.extensionEndpoint,
        headers: { Origin: EXTENSION_ORIGIN, 'Sec-WebSocket-Protocol': 'chat' },
        status: 400,
      },
    ];
    for (const row of rows) {
      const status = await statusCodeOf(row.url, row.headers);
      assert.equal(status, row.status, `row "${row.name}"`);
      // The side effects that must not have happened.
      assert.equal(
        bridge.extensionConnected(),
        false,
        `row "${row.name}": extension not connected`,
      );
      assert.equal(bridge.tabs().length, 0, `row "${row.name}": no tabs`);
      assert.deepEqual(seen, [], `row "${row.name}": no events`);
    }
    // The right door does open — the table is about refusals, not about a
    // relay that admits nothing.
    const ext = await FakeExtension.connect(bridge.extensionEndpoint, {
      origin: EXTENSION_ORIGIN,
    });
    assert.equal(bridge.extensionConnected(), true);
    assert.deepEqual(seen, ['extensionConnected']);
    assert.equal(ext.calls.length, 0);
    ext.close();
  } finally {
    bridge.close('test over');
  }
});

test('a configured token rides the connect URL only — the door admits without it and refuses without it alike', async () => {
  // The token's honest scope, pinned at the door it was once said to
  // guard. Two halves:
  //
  // - **The door does not check it.** With a token configured, the
  //   extension upgrades with no token anywhere in sight (there is no
  //   place in the handshake to carry one) and is admitted; and the
  //   impostors the table above turns away are turned away the same way
  //   with the token set. The token changes nothing at admission.
  // - **Where it does ride** is the connect URL — the one place the
  //   extension reads it, to skip its own approval page.
  const token = 'sekrit-token-value';
  const bridge = await connect({ clientName: 'probe', extensionId: EXTENSION_ID, token });
  try {
    assert.match(bridge.connectUrl(), new RegExp(`token=${token}`));

    const impostor = await statusCodeOf(bridge.extensionEndpoint, {
      Origin: 'https://example.com',
    });
    assert.equal(impostor, 403, 'a set token did not make the Origin door more forgiving');
    assert.equal(bridge.extensionConnected(), false);

    const ext = await FakeExtension.connect(bridge.extensionEndpoint, {
      origin: EXTENSION_ORIGIN,
    });
    assert.equal(
      bridge.extensionConnected(),
      true,
      'the token was never presented, and was not asked for',
    );
    ext.close();
  } finally {
    bridge.close('test over');
  }
});

test('the bridge refuses a shape it cannot mean: bad ids, empty names', async () => {
  for (const extensionId of [
    '',
    'short',
    'abcdefghijklmnopqrstuvwxyz123456',
    'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP',
  ]) {
    await assert.rejects(
      connect({ clientName: 'probe', extensionId }),
      (error: unknown) => {
        assert.ok(error instanceof AttachedError);
        assert.equal(error.rule, 'attached.bad_extension_id');
        return true;
      },
      `id ${JSON.stringify(extensionId)}`,
    );
  }
  await assert.rejects(
    connect({ clientName: '   ', extensionId: EXTENSION_ID }),
    (error: unknown) => {
      assert.ok(error instanceof AttachedError);
      assert.equal(error.rule, 'attached.no_client_name');
      return true;
    },
  );
});

test('nothing listens once the bridge closes', async () => {
  const bridge = await connect({ clientName: 'probe', extensionId: EXTENSION_ID });
  const endpoint = bridge.cdpEndpoint;
  bridge.close('lease released');
  await assert.rejects(connectWebSocket(endpoint), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'ECONNREFUSED');
    return true;
  });
});

test('a Playwright client arriving before the extension is closed, not half-accepted', async () => {
  const logs: string[] = [];
  const bridge = await connect({
    clientName: 'probe',
    extensionId: EXTENSION_ID,
    log: (line) => logs.push(line),
  });
  try {
    const ws = await connectWebSocket(bridge.cdpEndpoint);
    const reason = await ws.onceClosed();
    assert.equal(reason, 'Extension not connected');
    assert.equal(bridge.extensionConnected(), false);
    assert.ok(
      logs.some((line) => line.includes('rejecting Playwright connection')),
      'the refusal is logged as a refusal',
    );
    // And nothing browser-side was ever asked: the tab mirror is empty and
    // no fake extension ever connected, so the call log is empty by absence.
    assert.equal(bridge.tabs().length, 0);
  } finally {
    bridge.close();
  }
});

test('waitForExtension refuses instead of hanging, by name', async () => {
  const bridge = await connect({ clientName: 'probe', extensionId: EXTENSION_ID });
  try {
    await assert.rejects(bridge.waitForExtension(150), (error: unknown) => {
      assert.ok(error instanceof AttachedError);
      assert.equal(error.rule, 'attached.not_connected');
      assert.match(error.message, /did not connect/);
      return true;
    });
    // The refusal is about the wait, and the state says the same thing.
    assert.equal(bridge.extensionConnected(), false);
  } finally {
    bridge.close();
  }
});
