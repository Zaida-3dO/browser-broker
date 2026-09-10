import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { BrowserSession, TabHandle } from '../../src/browser/driver.ts';
import { RealBrowserDriver } from '../../src/browser/real.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { teardownBrowser, temporaryProfileRoot } from '../helpers/browser-fixture.ts';

/**
 * A REAL browser following a REAL redirect, reported by the real driver.
 *
 * ── Why the fake was not enough, stated as the risk it leaves ────────────
 *
 * The service-level proof of this behaviour
 * (`tests/service/navigate-final-url.test.ts`) runs against a fake whose
 * redirect is a function this repository wrote. That proves the handler
 * reports whatever the driver hands it — which is the half that was broken —
 * but it cannot prove the *driver's* answer is the post-redirect address,
 * because the fake's answer is true by construction.
 *
 * **A wrong assumption about the browser would hide there and nowhere else.**
 * If `page.url()` in fact returned the requested address, or returned the
 * final one only after some additional wait, every fake-based test would stay
 * green and the shipped binary would keep reporting the defect this work
 * exists to remove. So one test follows a redirect a browser actually
 * performed, and reads the address back out of the page as well as off the
 * result — the page being the mechanism, the result being the claim.
 *
 * ── Why a local server and not a public redirect service ────────────────
 *
 * The defect was originally measured against a public one. A test cannot use
 * it: it makes the suite depend on a third party's uptime and on network
 * access, and naming a real external host in a tracked file is what this
 * repository's own hygiene gate refuses. A server on a loopback port issues
 * the same 302 with none of that, and the redirect is genuine — the browser
 * receives the status, reads the location header, and makes a second request,
 * which is the whole of what is being tested.
 *
 * ── Where this runs ─────────────────────────────────────────────────────
 *
 * It drives a real browser, so it **skips with a stated reason** when there
 * is not one. Continuous integration has no browser, so this is local-only
 * and a green pipeline is not evidence it executed — the same arrangement,
 * recorded for the same reason, as the neighbouring browser suites.
 *
 * It runs headless, which is honest here: a redirect is followed identically
 * in both modes and there is no assertion a headed run would strengthen.
 */

const available = browserAvailable();

/** The path that redirects, and the path it lands on. */
const START = '/start-here';
const LANDING = '/arrived-somewhere-else';

/**
 * A loopback server that answers `START` with a 302 to `LANDING`.
 *
 * Bound to port 0 so the operating system picks a free one — a fixed port
 * would collide with whatever else is running on the machine, which is a
 * flake that looks like a failure of the thing under test.
 */
async function redirectingServer(): Promise<{
  readonly origin: string;
  readonly close: () => Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    if (request.url === START) {
      response.writeHead(302, { location: LANDING });
      response.end();
      return;
    }
    if (request.url === LANDING) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>The Landing Page</title><h1>Arrived</h1>');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Not Found</title>');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the test server reported no port');

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** One browser and one tab, torn down whatever the assertions do. */
async function withTab(
  fn: (session: BrowserSession, tab: TabHandle) => Promise<void>,
): Promise<void> {
  const profileRoot = temporaryProfileRoot();
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-nav-redirect-'));
  const driver = new RealBrowserDriver({
    executablePath: browserExecutablePath(),
    outputDirectory,
  });
  const session = await driver.coldStart({
    browser: 'private',
    profileDirectory: path.join(profileRoot, 'private'),
    mode: 'headless',
  });

  try {
    const tab = await session.openTab();
    await fn(session, tab);
  } finally {
    await teardownBrowser(session, profileRoot);
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
}

/**
 * THE MUTATION THIS CATCHES: `real.ts` answering with the address it was
 * handed instead of `page.url()`. That change passes every fake-based test in
 * the repository and fails only here.
 */
test(
  'the real driver reports the address a real redirect landed on',
  { skip: !available && skipReason() },
  async () => {
    const server = await redirectingServer();

    try {
      await withTab(async (session, tab) => {
        const requested = `${server.origin}${START}`;
        const expected = `${server.origin}${LANDING}`;

        const result = await session.navigate(tab, requested, 20_000);

        // The claim: the driver says where it ended up.
        assert.notEqual(
          result.url,
          requested,
          'the driver echoed the requested address after a genuine 302 — the browser moved and the report did not',
        );
        assert.equal(result.url, expected);

        // The mechanism: the page agrees, read out of the browser rather than
        // off the value being asserted. A driver that fabricated a plausible
        // address would satisfy the assertion above and fail this one.
        const fromThePage = await session.evaluate(tab, 'location.href');
        assert.equal(fromThePage.value, expected);

        // The two fields that travel with it, from the page that was ARRIVED at
        // — the redirect's own response is a 302 with no title.
        assert.equal(result.title, 'The Landing Page');
        assert.equal(result.status, 200);
      });
    } finally {
      await server.close();
    }
  },
);

/**
 * The control: no redirect, and the same fields still describe the page.
 *
 * This is what makes the test above mean something. A driver that reported a
 * constant, or the last address it saw, would pass a redirect assertion and
 * fail here — and a status that was hard-coded to 200 would fail on the 404.
 */
test(
  'the real driver reports the requested address when nothing redirects',
  { skip: !available && skipReason() },
  async () => {
    const server = await redirectingServer();

    try {
      await withTab(async (session, tab) => {
        const requested = `${server.origin}/no-such-page`;

        const result = await session.navigate(tab, requested, 20_000);

        assert.equal(result.url, requested);
        assert.equal(result.status, 404);
        assert.equal(result.title, 'Not Found');
      });
    } finally {
      await server.close();
    }
  },
);
