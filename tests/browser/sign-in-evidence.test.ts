import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { Browser } from 'playwright-core';
import { chromium } from 'playwright-core';

import { coldStartDetached } from '../../src/browser/launch.ts';
import { COOKIE_STORE_RELATIVE, inspectProfileSession } from '../../src/doctor/session.ts';
import { processIsRunning } from '../../src/service/signin-recovery.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { temporaryProfileRoot } from '../helpers/browser-fixture.ts';
import { removeDirectory } from '../helpers/remove-directory.ts';

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
 *
 * ── Why teardown retries, and the intermittent failure it explains ──────
 *
 * This suite was sighted failing once during an unrelated build and could not
 * be reproduced in isolation, which is the shape that gets blamed on whatever
 * diff is in front of it. It is a **teardown** fault, and the reason it hides
 * from a single-file run is that it needs the machine to be busy.
 *
 * The close call above returns before the operating system has released the
 * browser's handles on the profile directory. `fs.rmSync` with
 * `{ force: true }` does **not** wait for that: `force` suppresses `ENOENT`
 * and nothing else, so a live handle surfaces as `EPERM`. Thrown from a
 * `finally`, that error is attributed by `node --test` to the **file** rather
 * than to any test — every assertion reads as passed and the file reads as
 * failed, which is a fixture fault wearing a test fault's costume.
 *
 * Measured: launch a persistent context, send `Browser.close`, then remove
 * the root immediately. Bare `rmSync` failed **5 times in 5**; the retrying
 * {@link removeDirectory} failed **0 times in 5** over the same race in the
 * same loop. The bare arm is the control — it is what shows the race was
 * genuinely present on every trial, so the passing arm is survival rather
 * than a window that happened not to open.
 *
 * Teardown is made patient rather than hasty, because a cleanup failure must
 * never turn a passing test red.
 *
 * ── The wait after the close is a poll, not a sleep ─────────────────────
 *
 * A fixed pause here would be a guess at how long an asynchronous event
 * takes, and such a guess fails in both directions: set it too short and the
 * removal hits `EPERM` when the browser takes longer than expected to release
 * its handles; set it too long and every run pays the difference. So the wait
 * is a **bounded poll on the condition itself** — the browser's process
 * actually exiting — which is the event the handle release hangs off. It
 * returns as soon as that is true, and bounds how long it will wait for it.
 * See {@link endBrowser}.
 *
 * ── The leak that used to hide behind it ────────────────────────────────
 *
 * Measured on this file: an assertion failure *inside the fixture* skipped
 * the close entirely and left a detached browser alive forever, and its live
 * connection also stopped `node --test` from exiting at all. The browser's
 * lifetime is now in a `finally`, so a failing run ends its browser exactly
 * as a passing one does. **This is the reason `endBrowser` may kill as a last
 * resort, and the reason it still closes cleanly first** — the clean close is
 * what the signed-in assertion above depends on, and it is preserved.
 */

const available = browserAvailable();

/**
 * How long the clean shutdown is given to complete before the process is
 * ended outright.
 *
 * **A bound on a condition, not a guess at a duration.** This is how long the
 * exit is *waited for* while being checked, rather than how long the teardown
 * pauses regardless. A pause long enough to cover a busy machine would be
 * paid in full on every quiet one, and would still be a fixed number standing
 * in for an asynchronous event — so lengthening it makes it fail less often
 * and fail the same way. The wait polls {@link processIsRunning} instead and
 * returns the moment the browser is actually gone, which on a quiet machine
 * is a small fraction of this budget.
 */
const CLEAN_CLOSE_BUDGET_MS = 10_000;

/** How often the exit is re-checked while waiting for it. */
const EXIT_POLL_INTERVAL_MS = 50;

/**
 * End the browser this suite started, and **do not return while it is still
 * running.**
 *
 * ── Why this is unconditional, and what it is defending against ─────────
 *
 * Measured on this file before this helper existed: an assertion failure
 * inside the fixture — the cookie-count check, which is one of the two lines
 * this suite has actually been seen failing on — skipped the close entirely
 * and **left a browser alive forever**. It is a detached browser by
 * construction (see `launch.ts`: that is the whole point of the module), so
 * nothing reaps it: not the test runner exiting, not the operating system,
 * not the service's own sweeps, which reconcile claims and tabs rather than
 * orphaned processes. One failing run, one browser, permanently.
 *
 * It was also worse than a leak. The live connection kept the event loop
 * alive, so `node --test` did not exit at all — a failing run wedged the
 * runner rather than reporting. Both symptoms have the same cause and the
 * same fix: the browser's lifetime belongs in a `finally`.
 *
 * ── Why the clean close is still first, and still matters ───────────────
 *
 * The header of this file explains at length that the browser is closed
 * cleanly rather than killed, because the cookie store is flushed on a clean
 * shutdown and a kill loses it — which would make the signed-in assertion
 * unable to distinguish the two profiles. **That is preserved exactly.** The
 * clean close is attempted first and given a real budget, and on every
 * passing run it is what ends the browser.
 *
 * ── Why a kill is nonetheless the last resort, and why it is safe here ───
 *
 * If the clean close has not completed within the budget, the choice is
 * between ending the process and leaking it. The reason to prefer a clean
 * close — preserving the cookie store — **does not apply on this path**: the
 * budget is only exceeded when the browser is wedged or the run has already
 * thrown, and in both cases nothing is going to read that store. A flushed
 * cookie store in a browser nobody can reach is worth less than a machine
 * with no orphaned browsers on it. So the trade is: keep the store when the
 * store can still matter, and end the process when it cannot.
 *
 * The kill is **by process identifier only** — the identifier this launch
 * returned — and never by image name. This machine runs unrelated browsers
 * and other suites' browsers concurrently; a name matches all of them.
 */
async function endBrowser(connection: Browser | undefined, pid: number): Promise<void> {
  // The clean close, exactly as it was: `Browser.close` over the protocol so
  // the browser shuts itself down and flushes its cookie store.
  if (connection !== undefined) {
    try {
      const [context] = connection.contexts();
      if (context !== undefined) {
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Browser.close').catch(() => undefined);
      }
    } catch {
      // The browser may already be gone, or too wedged to accept a new page.
      // Either way the wait below decides what happens next, and the kill
      // after it is what makes this safe to ignore.
    }
    await connection.close().catch(() => undefined);
  }

  // Wait for the *actual* condition — the process exiting — rather than for a
  // fixed duration. This is what releases the profile's handles, so polling it
  // is also what makes the directory removal below reliable.
  const deadline = Date.now() + CLEAN_CLOSE_BUDGET_MS;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_INTERVAL_MS));
  }

  // Budget exhausted: the clean close did not finish. See this function's
  // header — on this path nothing will read the cookie store, and a leaked
  // browser is the cost of protecting it.
  try {
    process.kill(pid);
  } catch {
    // Already exited between the last poll and here, or not ours to signal.
    // Both mean there is nothing further this can do, and neither is worth
    // failing a teardown over.
  }
}

/**
 * Build a profile with a real browser, optionally storing a cookie in it, and
 * shut the browser down cleanly.
 *
 * The browser's lifetime is wrapped in a `finally` so that **an assertion
 * failure anywhere in here still ends it** — see {@link endBrowser} for the
 * measurement that made this necessary.
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

  // Declared outside the `try` so the teardown can reach it whether or not
  // the connection was ever established.
  let connection: Browser | undefined;
  try {
    connection = await chromium.connectOverCDP(outcome.record.endpoint);
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
  } finally {
    // **Unconditional.** A passing run reaches here having asserted what it
    // came to assert; a failing one reaches here mid-throw. Both end the
    // browser, and the clean close inside is what keeps the passing run's
    // cookie store intact.
    await endBrowser(connection, outcome.pid);
  }

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
      // **Not `fs.rmSync` directly.** The browser has been asked to close but
      // the operating system releases its handles on the profile a moment
      // later, and `force` suppresses only `ENOENT` — an open handle comes
      // back as `EPERM`, which escapes this `finally` and is attributed by
      // `node --test` to the *file* rather than to any test. See this file's
      // teardown note for the measurement.
      removeDirectory(root);
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
      // **Not `fs.rmSync` directly.** The browser has been asked to close but
      // the operating system releases its handles on the profile a moment
      // later, and `force` suppresses only `ENOENT` — an open handle comes
      // back as `EPERM`, which escapes this `finally` and is attributed by
      // `node --test` to the *file* rather than to any test. See this file's
      // teardown note for the measurement.
      removeDirectory(root);
    }
  },
);
