import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConnectArgs, buildConnectUrl } from '../../src/attach/connect-launcher.ts';
import { openConnectPage } from '../../src/attach/connect-launcher.ts';
import { AttachedError } from '../../src/attach/errors.ts';

/**
 * The launcher's argv and URL, built and asserted without running anything:
 * the only spawn this module does is on a **configured** binary, and the test
 * asserts the shape it would hand over — and that a missing binary is a
 * refusal, not a guess at a path.
 */

const CONNECT_URL = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/connect.html';

test('the connect URL carries what the extension needs, and the token only when given', () => {
  const base = {
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    extensionEndpoint: 'ws://127.0.0.1:1/extension/uuid-1',
    clientName: 'read the dashboard',
    protocolVersion: 2,
  };
  const without = new URL(buildConnectUrl(base));
  assert.equal(without.searchParams.get('mcpRelayUrl'), 'ws://127.0.0.1:1/extension/uuid-1');
  const client = JSON.parse(without.searchParams.get('client') ?? '{}') as { name?: string };
  assert.equal(client.name, 'read the dashboard');
  assert.equal(without.searchParams.get('protocolVersion'), '2');
  assert.equal(without.searchParams.has('token'), false, 'no token, no token in the URL');
  assert.equal(without.searchParams.has('background'), false);

  const withAll = new URL(
    buildConnectUrl({ ...base, token: 't0ken', background: true, tabGroup: false }),
  );
  assert.equal(withAll.searchParams.get('token'), 't0ken');
  assert.equal(withAll.searchParams.get('background'), 'true');
  assert.equal(withAll.searchParams.get('tabGroup'), 'false');
});

test('the launch argv puts the URL last and adds only the flags it was given', () => {
  const plain = buildConnectArgs({ browserPath: 'the-configured-binary', connectUrl: CONNECT_URL });
  assert.deepEqual(plain, [CONNECT_URL], 'a plain launch is just the URL');

  const profiled = buildConnectArgs({
    browserPath: 'the-configured-binary',
    connectUrl: CONNECT_URL,
    profileDirectory: 'Profile 1',
  });
  assert.deepEqual(profiled, ['--profile-directory=Profile 1', CONNECT_URL]);

  const backgrounded = buildConnectArgs({
    browserPath: 'the-configured-binary',
    connectUrl: CONNECT_URL,
    background: true,
    token: 't0ken',
  });
  assert.deepEqual(backgrounded, ['--open-in-background', CONNECT_URL]);

  // Background without a token is asking for a page nobody can see and nobody
  // approved: the background flag rides with the token, never alone.
  const backgroundAlone = buildConnectArgs({
    browserPath: 'the-configured-binary',
    connectUrl: CONNECT_URL,
    background: true,
  });
  assert.deepEqual(backgroundAlone, [CONNECT_URL]);
});

test('a missing browser binary is refused, never guessed at', () => {
  for (const browserPath of ['', '   ']) {
    assert.throws(
      () => openConnectPage({ browserPath, connectUrl: CONNECT_URL }),
      (error: unknown) => {
        assert.ok(error instanceof AttachedError);
        assert.equal(error.rule, 'attached.no_binary');
        return true;
      },
      `path ${JSON.stringify(browserPath)}`,
    );
  }
});
