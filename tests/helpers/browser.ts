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
 * **Continuous integration runs on hosted runners with no browser installed
 * and no display**, so the browser suites are skipped there and run locally.
 * That is recorded plainly here and in each suite, because the failure mode
 * this avoids is somebody reading a green pipeline as evidence that the
 * keeper-tab test passed when it never executed.
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
