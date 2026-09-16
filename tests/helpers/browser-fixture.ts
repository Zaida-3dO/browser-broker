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
 * Browsers **this run** started and has not yet torn down.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A REGISTRY AND NOT JUST THE `finally` BELOW
 * ══════════════════════════════════════════════════════════════════════════
 *
 * {@link teardownBrowser} runs in a per-test `finally`, which covers a test
 * that fails or throws. **It does not cover a run that dies mid-test** — a
 * Ctrl-C, a killed process, a CI timeout. Nothing reaches the `finally`, and
 * the browser survives the run that started it.
 *
 * That compounds rather than merely littering: every leaked root is a live
 * Chromium on the CPU, the real-browser suites already sit on a thin timing
 * margin against Playwright's 30-second screenshot bound, and each leak makes
 * the next run likelier to cross it. Seven stale roots from earlier crews were
 * found on this machine at once, and a leak of this family once reached 1,637
 * processes and froze the box.
 *
 * ── The safety rule, which is the whole design constraint ───────────────
 *
 * **Only ever what this process started.** Entries are added when a browser is
 * handed to {@link registerBrowserForReaping} with the pid the driver
 * reported, and removed the moment it is torn down. The sweep below kills
 * those pids and nothing else — it never matches on an image name, never
 * enumerates processes, and never reasons about a temp prefix to decide what
 * to kill. Ope's own Chrome and other agents' browsers are not merely spared
 * by a filter; they are never candidates, because they were never registered.
 *
 * The profile root is carried alongside so the directory can be removed too,
 * but the *kill* is keyed on the pid alone.
 */
const ownedBrowsers = new Map<number, string>();

let reaperInstalled = false;

/**
 * Register a browser this run started, so an interrupted run still ends it.
 *
 * Idempotent, and safe to call before any assertion: the handlers are
 * installed on first use rather than at import, so a suite that never starts a
 * browser installs nothing.
 */
export function registerBrowserForReaping(pid: number, profileRoot: string): void {
  ownedBrowsers.set(pid, profileRoot);
  installReaper();
}

/** Forget a browser that has been torn down the ordinary way. */
function forgetBrowser(pid: number): void {
  ownedBrowsers.delete(pid);
}

/**
 * Kill every browser still registered, synchronously.
 *
 * **Synchronous on purpose.** This runs from `process.on('exit')` and from
 * signal handlers, where the event loop is either gone or about to be — an
 * `await` here would be scheduled and never run, which is precisely the shape
 * of failure this whole registry exists to remove.
 *
 * Directory removal is attempted once and abandoned on failure: the operating
 * system releases a profile's handles a moment after the process actually
 * exits, so at this instant it is usually still held. A directory that
 * outlives the run is litter in the platform's temporary location, and the
 * `pretest` sweep clears it before the next run; a browser that outlives the
 * run is the defect.
 */
export function reapOwnedBrowsers(): void {
  for (const [pid, profileRoot] of ownedBrowsers) {
    try {
      // The pid this run was handed when it started this browser. Never an
      // image name, never a match over the process table.
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, which is the outcome wanted anyway.
    }
    try {
      fs.rmSync(profileRoot, { recursive: true, force: true });
    } catch {
      // Still held. See above: not worth blocking an exit over.
    }
  }
  ownedBrowsers.clear();
}

/**
 * Install the handlers that make an interrupted run clean up after itself.
 *
 * `exit` covers a normal end and an uncaught throw. The three signals cover
 * the interruptions that actually happen: Ctrl-C, a `kill`, and a closed
 * terminal. **`SIGKILL` is deliberately absent** — it runs nothing, by
 * definition, and listing it would read as a guarantee this cannot make. That
 * remaining case is what the `pretest` sweep is for.
 *
 * Each signal handler re-raises after reaping rather than swallowing the
 * signal: a test runner interrupted by Ctrl-C should still exit as an
 * interrupted process, not as a successful one.
 */
function installReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;

  process.on('exit', reapOwnedBrowsers);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      reapOwnedBrowsers();
      // Remove this handler and re-send, so the process ends the way it would
      // have without it rather than exiting 0 on an interrupt.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
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

  // This one is dealt with, so the exit sweep must not consider it again. Done
  // after the kill rather than before: a throw between the two would otherwise
  // drop it from the registry while it was still running, turning the safety
  // net off for the one browser that still needed it.
  forgetBrowser(pid);

  await removeWhenReleased(profileRoot);
}

/**
 * Adopt a browser this run started: it is reaped on teardown **and** if the run
 * is interrupted before teardown is reached.
 *
 * Sugar over {@link registerBrowserForReaping} that reads the pid off the
 * session, so a caller states the two things it has rather than the three the
 * registry needs.
 */
export function adoptBrowser(session: BrowserSession, profileRoot: string): void {
  registerBrowserForReaping(session.describe().pid, profileRoot);
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
