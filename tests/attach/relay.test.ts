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

test('cookie- and storage-writing commands are refused by name at the door, and the extension never sees them', async () => {
  // §7.1 `attached.no_cookie_write` (§13n). The relay forwards every CDP
  // method it is not told otherwise about, so the read-only promise has to
  // be kept here too — for **any** client that holds the port, not just
  // the one the service framed. Each row asserts both halves of a
  // rejection: the error frame the client got, **and** that the fake
  // extension's call log never saw the method. A gate that answers an
  // error after forwarding would pass the first half and protect nothing.
  const logs: string[] = [];
  const bridge = await connect({
    clientName: 'probe',
    extensionId: EXTENSION_ID,
    log: (line) => logs.push(line),
  });
  const ext = await FakeExtension.connect(bridge.extensionEndpoint, {
    origin: EXTENSION_ORIGIN,
  });
  await ext.initialize();

  const ws = await connectWebSocket(bridge.cdpEndpoint, {});
  try {
    let nextId = 1;
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    ws.onMessage = (text) => {
      const message = JSON.parse(text) as Record<string, unknown>;
      const at = waiting.get(message.id as number);
      if (at !== undefined) {
        waiting.delete(message.id as number);
        at(message);
      }
    };
    const ask = (
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const id = nextId;
        nextId += 1;
        waiting.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });

    const refused: { method: string; params: Record<string, unknown> }[] = [
      { method: 'Network.setCookie', params: { name: 'n', value: 'v' } },
      { method: 'Network.setCookies', params: { cookies: [{ name: 'n', value: 'v' }] } },
      { method: 'Network.deleteCookies', params: { name: 'n' } },
      { method: 'Network.clearBrowserCookies', params: {} },
      { method: 'Storage.setCookies', params: { cookies: [{ name: 'n', value: 'v' }] } },
      { method: 'Storage.clearCookies', params: {} },
      {
        method: 'Storage.clearDataForOrigin',
        params: { origin: 'https://example.com', storage_types: 'cookies' },
      },
    ];
    for (const { method, params } of refused) {
      const reply = await ask(method, params);
      const error = reply.error as { message?: string } | undefined;
      assert.ok(error?.message?.includes('attached.no_cookie_write'), `${method}: error frame`);
      assert.ok(error?.message?.includes(method), `${method}: names the method`);
      const crossed = ext.calls.filter(
        (call) =>
          call.method === 'chrome.debugger.sendCommand' && (call.params[1] as string) === method,
      );
      assert.equal(crossed.length, 0, `${method}: refused after it crossed — the guard is a lie`);
      assert.ok(
        logs.some((line) => line.includes(`refused by name: ${method}`)),
        `${method}: the refusal is visible in the session log`,
      );
    }

    // The control: reading cookies is the promise made, not broken. It is
    // not refused by the deny list — the answer here is whatever the
    // forwarding path says with no tab attached, and that answer is not
    // this rule.
    const read = await ask('Network.getCookies', { urls: ['https://example.com'] });
    const readError = read.error as { message?: string } | undefined;
    assert.ok(
      !readError?.message?.includes('attached.no_cookie_write'),
      'the deny list caught a read',
    );
  } finally {
    ws.close();
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
