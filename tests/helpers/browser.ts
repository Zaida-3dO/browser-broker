import fs from 'node:fs';

import { chromium } from 'playwright-core';

/**
 * Whether this machine can run a test that drives a real browser, and the
 * reason when it cannot.
 *
 * ── Why a skip is stated rather than silent ─────────────────────────────
 *
 * `CLAUDE.md`: a check that cannot fail is worse than no check. A test that
 * quietly does nothing on the machine where it is usually run is the same
 * problem wearing a green tick — so when these tests do not run, they say so
 * by name, and the reason appears in the output.
 *
 * **These suites are run locally. Continuous integration cannot cold-start a
 * browser, and that is a decision rather than a gap** — see
 * `scripts/check-browser-tests.mjs` for the measurement and the four options
 * weighed. In short: hosted runners forbid the sandbox the browser needs, and
 * the only way past it removes the browser's process isolation on a machine
 * that executes untrusted pull-request code. That trade was declined.
 *
 * So the practical rule for anyone changing the browser path: **run these
 * suites on your own machine before merging.** A green pipeline is not
 * evidence that they passed — the hosted job proves only that they were not
 * silently skipped, which is a weaker and different claim.
 */

/**
 * The browser binary, if one is installed.
 *
 * The path is resolved from the automation library rather than written down:
 * an absolute path in a tracked file names one machine, which this
 * repository's own hygiene gate refuses.
 */
export function browserExecutablePath(): string {
  return chromium.executablePath();
}

/**
 * Whether a headed browser can actually be driven here.
 *
 * Two conditions, and both are needed:
 *
 * - **A binary exists.** The library reports a path whether or not anything
 *   was ever downloaded to it, so the path is checked rather than trusted.
 * - **There is a display.** A headed browser needs somewhere to draw. On a
 *   platform whose windowing is part of the operating system this is always
 *   true; elsewhere it is an environment variable, and its absence is what a
 *   hosted runner looks like.
 */
export function browserAvailable(): boolean {
  let binaryPresent: boolean;
  try {
    binaryPresent = fs.existsSync(browserExecutablePath());
  } catch {
    binaryPresent = false;
  }
  if (!binaryPresent) {
    return false;
  }

  return hasDisplay();
}

function hasDisplay(): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return true;
  }
  // An X or Wayland session. A hosted runner has neither.
  return (process.env.DISPLAY ?? '') !== '' || (process.env.WAYLAND_DISPLAY ?? '') !== '';
}

/** The skip message, which names which of the two conditions failed. */
export function skipReason(): string {
  let binaryPresent: boolean;
  try {
    binaryPresent = fs.existsSync(browserExecutablePath());
  } catch {
    binaryPresent = false;
  }

  if (!binaryPresent) {
    return 'SKIPPED: no browser binary is installed on this machine, so a test that drives a real browser cannot run. This is the expected state on a hosted runner. Install one to run it.';
  }
  return 'SKIPPED: this machine has no display, and a headed browser needs somewhere to draw. This test must NEVER be converted to headless to make it run here — headless is exactly the mode in which it cannot fail. See the header of the keeper-tab suite.';
}
