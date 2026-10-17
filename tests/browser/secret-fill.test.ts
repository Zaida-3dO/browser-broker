import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type {
  BrowserSession,
  SecretScope,
  SecretUse,
  TabHandle,
} from '../../src/browser/driver.ts';
import { RealBrowserDriver } from '../../src/browser/real.ts';
import { decodePng } from '../../src/capture/image.ts';
import { BrokerError } from '../../src/errors.ts';
import { commandSecretResolver } from '../../src/secrets/resolver.ts';
import { REDACTION_MARK, spellingsOf } from '../../src/secrets/scrub.ts';
import { FAKE_VALUES } from '../fixtures/fake-secret-values.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { teardownBrowser, temporaryProfileRoot } from '../helpers/browser-fixture.ts';
import { fakeResolverCommand } from '../helpers/secrets.ts';

/**
 * Secrets on the real driver (`SCHEMA.md` §3.8a): resolved at the sink, bound
 * to an origin and a kind of field, and kept out of everything handed back.
 *
 * ── How "never reaches the caller" is measured ──────────────────────────
 *
 * By **searching every output for the fake value**: the snapshot file `act`
 * writes, every artefact `read` writes, the address and title `navigate`
 * reports, the pixels `capture` takes, and the text of every refusal. The
 * fixture page is built to leak — it logs the password to the console, copies
 * it into visible text, and submits it in a query string — and each scrubbed
 * read is paired with an **unscrubbed control read** of the same page that
 * does contain the value. Without the control, an output that simply never
 * held the value would pass, and the test would prove nothing about the
 * scrubbing.
 *
 * ── Where these run ─────────────────────────────────────────────────────
 *
 * They drive a real browser, so they skip — by name, with the reason — where
 * there is none, exactly as the neighbouring browser suites do. Continuous
 * integration cannot start one (`scripts/check-browser-tests.mjs`), so a
 * green pipeline is not evidence these ran; run them locally.
 */

const available = browserAvailable();
const skip = available ? false : skipReason();

const GOOD = FAKE_VALUES.good;

/** Two loopback servers: two origins, each serving the same pages. */
interface Site {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

function loginPage(otherOrigin: string): string {
  return `<!doctype html><html><head><title>Sign in</title></head><body>
<form method="get" action="/landing">
  <label>Email <input id="user" name="username" type="text"></label>
  <label>Password <input id="pw" name="pw" type="password"></label>
  <label>Comment <input id="note" name="comment" type="text"></label>
  <label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
  <button type="submit">Sign in</button>
</form>
<p id="echo">nothing typed</p>
<iframe src="${otherOrigin}/frame" title="other" width="400" height="80"></iframe>
<script>
  const pw = document.getElementById('pw');
  pw.addEventListener('input', () => {
    console.log('typed ' + pw.value);
    document.getElementById('echo').textContent = 'You typed ' + pw.value;
  });
</script>
</body></html>`;
}

const FRAME_PAGE = `<!doctype html><html><body>
<label>Other password <input id="pw2" type="password"></label>
</body></html>`;

const LANDING_PAGE = `<!doctype html><html><head><title>Landing</title></head><body>
<h1>Welcome</h1>
<script>
  const sent = new URLSearchParams(location.search).get('pw');
  if (sent) document.title = 'Welcome ' + sent;
</script>
</body></html>`;

async function startSite(routes: (path: string) => string | undefined): Promise<Site> {
  const server = http.createServer((request, response) => {
    const body = routes((request.url ?? '/').split('?')[0] ?? '/');
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Not Found</title>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

interface World {
  readonly session: BrowserSession;
  readonly profileRoot: string;
  readonly outputDirectory: string;
  readonly a: Site;
  readonly b: Site;
}

let world: World | undefined;

before(async () => {
  if (!available) return;
  // Each site's iframe points at the other, so the origins are needed first;
  // the route table reads them lazily.
  const origins: { a?: string; b?: string } = {};
  const routes = (other: () => string | undefined) => (route: string) => {
    if (route === '/login') return loginPage(other() ?? '');
    if (route === '/frame') return FRAME_PAGE;
    if (route === '/landing') return LANDING_PAGE;
    return undefined;
  };
  const a = await startSite(routes(() => origins.b));
  const b = await startSite(routes(() => origins.a));
  origins.a = a.origin;
  origins.b = b.origin;

  const profileRoot = temporaryProfileRoot();
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-secret-'));
  const driver = new RealBrowserDriver({
    executablePath: browserExecutablePath(),
    outputDirectory,
  });
  const session = await driver.coldStart({
    browser: 'private',
    profileDirectory: path.join(profileRoot, 'private'),
    mode: 'headless',
  });
  world = { session, profileRoot, outputDirectory, a, b };
});

after(async () => {
  if (world === undefined) return;
  await teardownBrowser(world.session, world.profileRoot);
  fs.rmSync(world.outputDirectory, { recursive: true, force: true });
  await world.a.close();
  await world.b.close();
});

function the(): World {
  assert.ok(world !== undefined, 'the browser fixture did not start');
  return world;
}

/** A scope over the fake resolver, binding every secret to `origins`, recording uses. */
function scopeFor(
  origins: readonly string[],
  received: readonly string[] = [],
  timeoutMs?: number,
): { scope: SecretScope; uses: SecretUse[] } {
  const uses: SecretUse[] = [];
  const resolve = commandSecretResolver(
    fakeResolverCommand(origins),
    timeoutMs === undefined ? {} : { timeoutMs },
  );
  return {
    scope: {
      resolve,
      received,
      record: (use) => {
        uses.push(use);
      },
    },
    uses,
  };
}

async function openAt(url: string): Promise<TabHandle> {
  const tab = await the().session.openTab();
  await the().session.navigate(tab, url);
  return tab;
}

/** The current snapshot, read with no scope — the unscrubbed control. */
async function rawSnapshot(tab: TabHandle): Promise<string> {
  const [result] = await the().session.read(tab, ['snapshot']);
  assert.ok(result);
  return fs.readFileSync(result.path, 'utf8');
}

function referenceFor(snapshot: string, needle: string): string {
  const line = snapshot.split('\n').find((candidate) => candidate.includes(needle));
  assert.ok(line, `the snapshot must name ${needle}; it did not:\n${snapshot}`);
  const found = /\[ref=([^\]]+)\]/u.exec(line);
  assert.ok(found?.[1], `no reference for ${needle} in: ${line}`);
  return found[1];
}

/** A value read out of the page by the test itself, never through a scoped call. */
async function inPage(tab: TabHandle, expression: string): Promise<unknown> {
  return (await the().session.evaluate(tab, expression)).value;
}

function assertAbsent(text: string, value: string, where: string): void {
  for (const spelling of spellingsOf(value)) {
    assert.ok(
      !text.includes(spelling),
      `${where} contains the secret (as ${JSON.stringify(spelling)}):\n${text}`,
    );
  }
}

function refusal(rule: string, value = GOOD): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof BrokerError, `expected a refusal, got ${String(error)}`);
    assert.equal(error.rule, rule, error.message);
    assertAbsent(error.message, value, 'the refusal');
    return true;
  };
}

/* ─────────────── the right field, on the right origin ─────────────── */

test(
  'a secret is typed into a password field on its origin, and no output carries it',
  { skip },
  async () => {
    const { a } = the();
    const tab = await openAt(`${a.origin}/login`);
    const ref = referenceFor(await rawSnapshot(tab), 'textbox "Password"');
    const { scope, uses } = scopeFor([a.origin]);

    const result = await the().session.act(
      tab,
      { action: 'fill', ref, value: '{{secret:good}}' },
      scope,
    );

    // It really was typed: read out of the page, not out of the call.
    assert.equal(await inPage(tab, "document.getElementById('pw').value"), GOOD);
    assert.deepEqual(uses, [
      { name: 'good', origin: a.origin, field: 'password', outcome: 'allow' },
    ]);

    // The snapshot `act` hands back: the page copied the value into visible
    // text, and the snapshot shows that text redacted.
    const after = fs.readFileSync(result.path, 'utf8');
    assertAbsent(after, GOOD, "act's snapshot");
    assert.ok(after.includes(REDACTION_MARK), `the copy was not redacted:\n${after}`);

    // Every later read, scoped as the service scopes a secret-bearing tab.
    const later = scopeFor([a.origin], ['good']).scope;
    const reads = await the().session.read(tab, ['snapshot', 'console', 'network', 'cookies'], {
      secrets: later,
    });
    for (const written of reads) {
      assertAbsent(fs.readFileSync(written.path, 'utf8'), GOOD, `the ${written.artifact} read`);
    }
    const consoleText = fs.readFileSync(
      reads.find((r) => r.artifact === 'console')?.path ?? '',
      'utf8',
    );
    assert.match(consoleText, /typed \[secret redacted\]/u);

    // **The control.** The same reads with no scope DO carry the value — so the
    // page really leaks it, and the scrubbing is what kept it out above.
    const [rawConsole] = await the().session.read(tab, ['console']);
    assert.ok(
      fs.readFileSync(rawConsole?.path ?? '', 'utf8').includes(GOOD),
      'the fixture did not leak',
    );
    assert.ok(
      (await rawSnapshot(tab)).includes(GOOD),
      'the unscrubbed snapshot did not show the field',
    );
  },
);

test('typing keystroke by keystroke goes through the same binding', { skip }, async () => {
  const { a } = the();
  const tab = await openAt(`${a.origin}/login`);
  const ref = referenceFor(await rawSnapshot(tab), 'textbox "Password"');
  const { scope, uses } = scopeFor([a.origin]);

  const result = await the().session.act(
    tab,
    { action: 'type', ref, value: '{{secret:good}}' },
    scope,
  );
  assert.equal(await inPage(tab, "document.getElementById('pw').value"), GOOD);
  assert.equal(uses[0]?.outcome, 'allow');
  assertAbsent(fs.readFileSync(result.path, 'utf8'), GOOD, "type's snapshot");
});

test(
  'a value submitted in an address is scrubbed from the network log and from navigate',
  { skip },
  async () => {
    const { a } = the();
    const tab = await openAt(`${a.origin}/login`);
    const ref = referenceFor(await rawSnapshot(tab), 'textbox "Password"');
    await the().session.act(
      tab,
      { action: 'fill', ref, value: '{{secret:good}}' },
      scopeFor([a.origin]).scope,
    );

    // Submit the GET form: the password is now in the address and the title.
    const later = scopeFor([a.origin], ['good']).scope;
    // No reference: the key goes to the focused field, which the fill left focused.
    await the().session.act(tab, { action: 'press', value: 'Enter' }, later);
    await the()
      .session.navigate(tab, `${a.origin}/landing?pw=${GOOD}`, undefined, later)
      .then((arrived) => {
        assertAbsent(arrived.url, GOOD, "navigate's address");
        assertAbsent(arrived.title, GOOD, "navigate's title");
        assert.ok(arrived.title.includes(REDACTION_MARK));
      });

    const [network] = await the().session.read(tab, ['network'], { secrets: later });
    assertAbsent(fs.readFileSync(network?.path ?? '', 'utf8'), GOOD, 'the network log');

    // The control: unscrubbed, the log does carry it.
    const [raw] = await the().session.read(tab, ['network']);
    assert.ok(
      fs.readFileSync(raw?.path ?? '', 'utf8').includes(GOOD),
      'the form did not submit the value',
    );
  },
);

test(
  'a capture of a secret-bearing tab masks the password field and the copied text',
  { skip },
  async () => {
    const { a } = the();
    const tab = await openAt(`${a.origin}/login`);
    const ref = referenceFor(await rawSnapshot(tab), 'textbox "Password"');
    await the().session.act(
      tab,
      { action: 'fill', ref, value: '{{secret:good}}' },
      scopeFor([a.origin]).scope,
    );

    const centre = async (id: string): Promise<{ x: number; y: number }> =>
      (await inPage(
        tab,
        `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      )) as { x: number; y: number };
    const magentaAt = (image: Uint8Array, point: { x: number; y: number }): boolean => {
      const decoded = decodePng(image);
      const at = (Math.round(point.y) * decoded.width + Math.round(point.x)) * 4;
      const [r, g, b] = [
        decoded.pixels[at] ?? 0,
        decoded.pixels[at + 1] ?? 0,
        decoded.pixels[at + 2] ?? 0,
      ];
      return r > 200 && g < 60 && b > 200;
    };
    const field = await centre('pw');
    const copy = await centre('echo');

    const masked = await the().session.capture(tab, {
      fullPage: false,
      secrets: scopeFor([a.origin], ['good']).scope,
    });
    assert.ok(magentaAt(masked.image, field), 'the password field was not masked');
    assert.ok(magentaAt(masked.image, copy), 'the copied text was not masked');

    // The control: unscoped, neither is painted over.
    const plain = await the().session.capture(tab, { fullPage: false });
    assert.ok(
      !magentaAt(plain.image, field) && !magentaAt(plain.image, copy),
      'the control was masked',
    );
  },
);

/* ─────────────── refused: wrong place, and nothing typed ─────────────── */

test(
  'a cross-origin iframe is refused, even when the secret is bound to the frame',
  { skip },
  async () => {
    const { a, b } = the();
    const tab = await openAt(`${a.origin}/login`);
    const ref = referenceFor(await rawSnapshot(tab), 'textbox "Other password"');

    // Bound to the top page's origin only: the frame is elsewhere.
    const onlyTop = scopeFor([a.origin]);
    await assert.rejects(
      the().session.act(tab, { action: 'fill', ref, value: '{{secret:good}}' }, onlyTop.scope),
      refusal('act.secret_origin_bound'),
    );
    // Bound to the frame's origin only: the page around it is elsewhere.
    const onlyFrame = scopeFor([b.origin]);
    await assert.rejects(
      the().session.act(tab, { action: 'fill', ref, value: '{{secret:good}}' }, onlyFrame.scope),
      refusal('act.secret_origin_bound'),
    );
    assert.deepEqual(
      [...onlyTop.uses, ...onlyFrame.uses].map((use) => [use.outcome, use.rule, use.origin]),
      [
        ['deny', 'act.secret_origin_bound', b.origin],
        ['deny', 'act.secret_origin_bound', b.origin],
      ],
    );
    // Nothing was typed: the unscrubbed snapshot shows field values in clear,
    // and it does not show this one.
    assert.ok(!(await rawSnapshot(tab)).includes(GOOD), 'the value reached the frame');
  },
);

test('a page at another origin is refused', { skip }, async () => {
  const { a, b } = the();
  const tab = await openAt(`${b.origin}/login`);
  const ref = referenceFor(await rawSnapshot(tab), 'textbox "Password"');
  await assert.rejects(
    the().session.act(
      tab,
      { action: 'fill', ref, value: '{{secret:good}}' },
      scopeFor([a.origin]).scope,
    ),
    refusal('act.secret_origin_bound'),
  );
  assert.equal(await inPage(tab, "document.getElementById('pw').value"), '');
});

test(
  'a field of an undeclared kind is refused; declared kinds are accepted',
  { skip },
  async () => {
    const { a } = the();
    const tab = await openAt(`${a.origin}/login`);
    const snapshot = await rawSnapshot(tab);
    const comment = referenceFor(snapshot, 'textbox "Comment"');
    const email = referenceFor(snapshot, 'textbox "Email"');
    const password = referenceFor(snapshot, 'textbox "Password"');
    const code = referenceFor(snapshot, 'textbox "Code"');
    const { scope, uses } = scopeFor([a.origin]);

    // A password into a plain text field.
    await assert.rejects(
      the().session.act(tab, { action: 'fill', ref: comment, value: '{{secret:good}}' }, scope),
      refusal('act.secret_field_bound'),
    );
    assert.equal(await inPage(tab, "document.getElementById('note').value"), '');

    // A username into a password field: declared for usernames only.
    await assert.rejects(
      the().session.act(tab, { action: 'fill', ref: password, value: '{{secret:user}}' }, scope),
      refusal('act.secret_field_bound', FAKE_VALUES.user),
    );
    assert.equal(await inPage(tab, "document.getElementById('pw').value"), '');

    // And the declared kinds go where they belong.
    await the().session.act(
      tab,
      {
        action: 'fill_form',
        fields: [
          { ref: email, value: '{{secret:user}}' },
          { ref: code, value: '{{secret:otp}}' },
        ],
      },
      scope,
    );
    assert.equal(await inPage(tab, "document.getElementById('user').value"), FAKE_VALUES.user);
    assert.equal(await inPage(tab, "document.getElementById('code').value"), FAKE_VALUES.otp);
    assert.deepEqual(
      uses.map((use) => [use.name, use.outcome, use.field]),
      [
        ['good', 'deny', undefined],
        ['user', 'deny', undefined],
        ['user', 'allow', 'username'],
        ['otp', 'allow', 'otp'],
      ],
    );
  },
);

test(
  'a resolver that fails or stalls types nothing and says nothing of the value',
  { skip },
  async () => {
    const { a } = the();
    const tab = await openAt(`${a.origin}/login`);
    const ref = referenceFor(await rawSnapshot(tab), 'textbox "Password"');
    const { scope, uses } = scopeFor([a.origin], [], 1_500);

    for (const name of ['fail', 'slow', 'junk']) {
      await assert.rejects(
        the().session.act(tab, { action: 'fill', ref, value: `{{secret:${name}}}` }, scope),
        refusal('act.secret_resolved'),
        name,
      );
    }
    assert.equal(await inPage(tab, "document.getElementById('pw').value"), '');
    assert.deepEqual(
      uses.map((use) => [use.name, use.outcome, use.rule]),
      [
        ['fail', 'deny', 'act.secret_resolved'],
        ['slow', 'deny', 'act.secret_resolved'],
        ['junk', 'deny', 'act.secret_resolved'],
      ],
    );
  },
);

test('a sentinel the driver cannot resolve is refused, never typed as text', { skip }, async () => {
  const { a } = the();
  const tab = await openAt(`${a.origin}/login`);
  const ref = referenceFor(await rawSnapshot(tab), 'textbox "Comment"');
  await assert.rejects(
    the().session.act(tab, { action: 'fill', ref, value: '{{secret:good}}' }),
    refusal('act.secret_resolver_configured'),
  );
  assert.equal(await inPage(tab, "document.getElementById('note').value"), '');
});

test(
  'a value that needs escaping is scrubbed in every spelling the snapshot uses',
  { skip },
  async () => {
    const { a } = the();
    const tab = await openAt(`${a.origin}/login`);
    const ref = referenceFor(await rawSnapshot(tab), 'textbox "Password"');
    const result = await the().session.act(
      tab,
      { action: 'fill', ref, value: '{{secret:special}}' },
      scopeFor([a.origin]).scope,
    );
    assert.equal(await inPage(tab, "document.getElementById('pw').value"), FAKE_VALUES.special);
    assertAbsent(fs.readFileSync(result.path, 'utf8'), FAKE_VALUES.special, "act's snapshot");

    // The control: the unscrubbed snapshot carries it in some spelling.
    const raw = await rawSnapshot(tab);
    assert.ok(
      spellingsOf(FAKE_VALUES.special).some((spelling) => raw.includes(spelling)),
      `the unscrubbed snapshot did not carry the value in any known spelling:\n${raw}`,
    );
  },
);
