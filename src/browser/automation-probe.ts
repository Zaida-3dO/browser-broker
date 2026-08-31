// This is the browser module reaching the automation library for a doctor
// probe — the one exception `driver.import_isolated` (`SCHEMA.md` §7.3)
// already carves out is "only the browser module reaches the automation
// library", and this file is that module doing so for a read rather than a
// launch. It never opens a browser: it only asks the library where the
// binary it would launch is supposed to be, and checks that path exists.
import fs from 'node:fs';

import { chromium } from 'playwright-core';

import type { AutomationProbe } from '../doctor/checks.ts';

/**
 * What the real automation probe resolves against, injected so a test can
 * substitute a path that does or does not exist without needing (or lacking)
 * a real Chromium install.
 */
export interface AutomationProbeDependencies {
  /** Where the automation library says its browser binary should be. */
  readonly resolveExecutablePath: () => string;
  /** Whether that path exists. Injected for the same reason as above. */
  readonly pathExists: (candidate: string) => boolean;
  /** The automation library's own version, echoed on success. */
  readonly libraryVersion?: string;
}

const REAL_DEPENDENCIES: AutomationProbeDependencies = {
  resolveExecutablePath: () => chromium.executablePath(),
  pathExists: (candidate) => fs.existsSync(candidate),
};

/**
 * Resolve the doctor's automation probe for real.
 *
 * **This does not launch anything.** `chromium.executablePath()` only
 * computes where the automation library expects its browser binary to sit —
 * it neither downloads one nor verifies one is there, which is why the
 * existence check is a second, separate step here rather than trusted as
 * part of the first. A computed path that resolves to nothing is exactly the
 * state a fresh machine following `docs/ROLLOUT.md` without ever having
 * installed a browser binary would be in, and that state must report
 * `present: false` — not throw, and not silently read as `unknown`.
 *
 * `resolveExecutablePath()` itself is not expected to throw on the versions
 * this build pins, but a caller asking "is the automation tool present" is
 * the last place that question should go unanswered because of an
 * unexpected library error, so a thrown error is caught and reported as
 * `present: false` with the error's message as the detail — rather than
 * propagating and turning `broker doctor` itself into the failure.
 */
export function resolveAutomationProbe(
  dependencies: AutomationProbeDependencies = REAL_DEPENDENCIES,
): AutomationProbe {
  let executablePath: string;
  try {
    executablePath = dependencies.resolveExecutablePath();
  } catch (error) {
    return {
      present: false,
      detail: `Could not resolve where the automation tool's browser binary should be: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!dependencies.pathExists(executablePath)) {
    return {
      present: false,
      detail: `No browser binary at the path the automation tool resolved (${executablePath}). This build depends on playwright-core, which does not download a browser on install.`,
    };
  }

  return {
    present: true,
    version: dependencies.libraryVersion,
    detail: `Present at ${executablePath}.`,
  };
}
