import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright-core';

import { coldStartDetached } from '../../src/browser/launch.ts';
import { COOKIE_STORE_RELATIVE, inspectProfileSession } from '../../src/doctor/session.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { temporaryProfileRoot } from '../helpers/browser-fixture.ts';

/**
 * ⚠️ THIS SUITE IS THE EVIDENCE BEHIND THE DOCTOR'S SESSION CHECK. ⚠️
 *
 * ── What it exists to prove, and why a unit test cannot ─────────────────
 *
 * `session.ts` claims something specific about a real browser: that **the
 * cookie file exists in a profile nobody has signed into**, so checking for
 * its presence is a check that cannot fail, and that **the row count is the
 * observable that carries the fact**. Those are claims about a browser's
 * behaviour, not about this repository's code.
 *
 * The unit tests around this one inject a reader and assert the *reporting*
 * is honest. They would all still pass if the browser's actual layout were
 * different — the claim they rest on would simply be wrong, and nothing would
 * say so. **This is the test that can tell.**
 *
 * ── Where it runs ──────────────────────────────────────────────────────
 *
 * It needs a real browser. It does **not** need a display — the measurement
 * is about what is written to a profile directory, which is identical in both
 * modes — so it runs headless and skips only when no browser is installed,
 * which is the state of a hosted runner. The skip states itself rather than
 * passing quietly.
 *
 * ── The one thing that must not be "fixed" ─────────────────────────────
 *
 * **The browser is closed cleanly, not killed**, and that is load-bearing
 * rather than tidiness. Measured while writing this: with the browser ended
 * abruptly the signed-in profile read **zero rows**, identical to the fresh
 * one, because the cookie store is flushed on a clean shutdown. Converting
 * the teardown here to a kill would make the signed-in assertion fail — and
 * the tempting "fix" would be to weaken the assertion, which would delete the
 * only evidence that the doctor's check works at all.
 */

const available = browserAvailable();

/**
 * Build a profile with a real browser, optionally storing a cookie in it, and
 * shut the browser down cleanly.
 */
async function buildProfile(root: string, withCookie: boolean): Promise<string> {
  const directory = path.join(root, 'regular');

  const outcome = await coldStartDetached({
    profileDirectory: directory,
    // Headless: the measurement is about files on disk, which does not differ
    // by mode, and this keeps the suite runnable without a display.
    mode: 'headless',
    executablePath: browserExecutablePath(),
  });

  const connection = await chromium.connectOverCDP(outcome.record.endpoint);
  const [context] = connection.contexts();
  assert.ok(context, 'the browser exposed no context to work in');

  if (withCookie) {
    // What a sign-in leaves behind, produced the way a site would: a cookie
    // in the browser's own store.
    await context.addCookies([
      {
        name: 'signed_in_probe',
        value: 'a-session-value',
        domain: 'example.com',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 86_400,
        httpOnly: true,
        secure: true,
      },
    ]);
    assert.equal((await context.cookies()).length, 1, 'the fixture did not store a cookie');
  }

  // **Cleanly.** See the header: a kill loses the unflushed store and would
  // make this test unable to distinguish the two profiles at all.
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Browser.close').catch(() => undefined);
  await connection.close().catch(() => undefined);

  // The handles are released when the process finishes exiting, which is a
  // moment after the close call returns.
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  return directory;
}

test(
  'MEASURED: the cookie FILE exists in a profile nobody signed into, so its presence proves nothing',
  { skip: available ? false : skipReason() },
  async () => {
    const root = temporaryProfileRoot();
    try {
      const directory = await buildProfile(root, false);
      const store = path.join(directory, ...COOKIE_STORE_RELATIVE);

      // **The claim `session.ts` is built on.** If this ever fails, the
      // obvious check became viable and the module's long explanation of why
      // it is not should be revisited — but until then, a check for the
      // file's presence would report every fresh install as signed in.
      assert.ok(
        fs.existsSync(store),
        'the cookie store was absent from a fresh profile — the doctor could have used presence after all',
      );

      // And the check reports it honestly rather than as a session.
      const probe = inspectProfileSession(root, 'regular', { browserRunning: false });
      assert.notEqual(
        probe.evidence,
        'session-present',
        'a profile nobody signed into was reported as carrying a session',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'MEASURED: a stored cookie is what distinguishes a signed-in profile, and the doctor sees it',
  { skip: available ? false : skipReason() },
  async () => {
    const root = temporaryProfileRoot();
    try {
      await buildProfile(root, true);

      // The whole of the doctor's positive answer, against a real browser's
      // real cookie store — not an injected reader.
      const probe = inspectProfileSession(root, 'regular', { browserRunning: false });

      assert.equal(
        probe.evidence,
        'session-present',
        'a profile with a stored cookie was not recognised as carrying a session',
      );
      assert.ok((probe.cookieCount ?? 0) > 0, 'the cookie count came back empty');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
