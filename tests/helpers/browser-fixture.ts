import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BrowserSession } from '../../src/browser/driver.ts';

/**
 * Tearing down a browser a test started.
 *
 * ── Why this is a helper and not four lines in each test ────────────────
 *
 * A browser is a real process holding a real directory open, and removing
 * that directory is **not instantaneous after the process is killed**: the
 * operating system releases the handles when the process actually finishes
 * exiting, which is a moment later than the signal returning. Removing it
 * immediately fails with a permission error — observed on every run of the
 * keeper-tab suite while building this row, and it failed the *cleanup* while
 * every assertion in the test had already passed, which is the most
 * misleading possible way for a test to go red.
 *
 * So teardown retries, briefly, and then gives up **without failing the
 * test**: a temporary directory that outlives one run is litter in the
 * platform's own temporary location, and reporting it as a test failure would
 * mean a green suite depends on the operating system's timing rather than on
 * the behaviour under test.
 */

/** A profile root under the platform's temporary directory. */
export function temporaryProfileRoot(): string {
  // Computed rather than written down: an absolute path in a tracked file
  // names one machine.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'broker-browser-'));
}

/**
 * Detach, end the browser this test started, and remove its profile.
 *
 * The browser is killed because it is a **test fixture**. This service never
 * ends a browser — attaching and detaching are non-destructive and there is
 * no close-browser operation on the seam — but a test that left one running
 * would leak a process per run.
 */
export async function teardownBrowser(session: BrowserSession, profileRoot: string): Promise<void> {
  const pid = session.describe().pid;

  try {
    await session.detach();
  } catch {
    // The browser may already be gone, which is what the assertions are for.
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already exited.
  }

  await removeWhenReleased(profileRoot);
}

/**
 * Remove a directory once the process holding it has let go.
 *
 * Gives up quietly rather than throwing — see this file's header for why a
 * cleanup failure must not turn a passing test red.
 */
async function removeWhenReleased(directory: string): Promise<void> {
  const attempts = 20;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * End any browser process still running against a profile directory that
 * {@link teardownBrowser} cannot reach by PID.
 *
 * ── Why this exists alongside `teardownBrowser`, covering a narrower case ──
 *
 * `teardownBrowser` kills the one process identifier a `coldStart` handed
 * back. That covers every browser this suite actually adopted. It does not
 * cover the **profile-collision** path in `launch.ts`: the second `coldStart`
 * against a directory already in use is documented and measured there to
 * "hand its address to the first and exit zero" — a claim `launch.ts` treats
 * as a fact about the platform, and builds a deliberate "never kill on
 * collision" rule on top of (see its kill-condition table). `coldStartDetached`
 * therefore throws `StartupRefusal` on that path without a PID in it: by its
 * own model there is nothing left to end.
 *
 * **Measured on Windows: that premise does not hold.** The collision test in
 * `real-driver.test.ts` leaked one root `chrome.exe` (plus its renderer
 * children) on every run — the losing spawn stays alive, headless, forever,
 * because nothing holds its identifier and the production sweep reconciles
 * claims and tabs, not orphaned OS processes. `launch.ts`'s own kill-condition
 * table is not touched here — reversing "never kill on collision" would risk
 * ending a genuine *other caller's* browser, including the signed-in one, on
 * every platform where the exit-zero premise is true. This helper is narrower
 * than that: it is scoped to a single test's own profile directory, used only
 * where a test has just forced a collision on a directory nothing else in the
 * suite would ever touch.
 *
 * Matches by profile directory rather than by PID, because a PID was never
 * assigned to this caller — the whole reason the collision refuses instead of
 * returning one. Never matches by image name alone: an unscoped `chrome.exe`
 * match would reap unrelated Chrome, this machine's own Playwright MCP pool,
 * and any other running suite's browsers.
 */
export function reapProcessesUsingProfile(profileDirectory: string): void {
  if (process.platform !== 'win32') {
    // No Windows-only workaround is needed elsewhere: this file's own header
    // measurement and `launch.ts`'s "exits zero" claim are unqualified by
    // platform, and this repository has no evidence either way for a
    // collision leak on POSIX. Extending an unverified fix to a platform CI
    // never runs these suites on would be a guess wearing a fix's costume.
    return;
  }

  const script = [
    "$dir = $env:REAP_PROFILE_DIR -replace '\\\\', '\\\\\\\\'",
    'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.CommandLine -and $_.CommandLine -match $dir } |',
    '  ForEach-Object { taskkill.exe /F /T /PID $_.ProcessId 2>$null | Out-Null }',
  ].join('\n');

  spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    env: { ...process.env, REAP_PROFILE_DIR: profileDirectory },
    // Best effort, matching `teardownBrowser`: cleanup must never fail a
    // passing test, so neither a non-zero exit nor a thrown spawn is
    // inspected here.
    stdio: 'ignore',
  });
}
