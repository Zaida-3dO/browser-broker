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
