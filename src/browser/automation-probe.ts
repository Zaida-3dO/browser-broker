// This is the browser module reaching the automation library for a doctor
// probe — the one exception `driver.import_isolated` (`SCHEMA.md` §7.3)
// already carves out is "only the browser module reaches the automation
// library", and this file is that module doing so for a read rather than a
// launch. It never opens a browser: it only asks the library where the
// binary it would launch is supposed to be, and checks that path exists.
import fs from 'node:fs';
import { createRequire } from 'node:module';

import { chromium } from 'playwright-core';

import type { AutomationProbe } from '../doctor/checks.ts';

const require = createRequire(import.meta.url);

/**
 * `playwright-core`'s own version, read from its installed `package.json`
 * rather than duplicated as a string constant here — a pin in `package.json`
 * and a constant beside this code are two places that could disagree, and
 * `node_modules` is the one that is actually running. Resolved once at
 * module load: it cannot change without a fresh install, which this process
 * would not observe anyway.
 *
 * Exported so a test can assert this specifically, independent of whether a
 * browser binary has been fetched: resolving the *library's own* version
 * from its `package.json` cannot depend on that, but reaching this value
 * through {@link resolveAutomationProbe}'s `present: true` branch would —
 * that branch requires `pathExists` to hold, which is exactly the thing a
 * CI runner with no Chromium fetched cannot provide.
 */
export function resolvePlaywrightCoreVersion(): string | undefined {
  try {
    const manifestPath = require.resolve('playwright-core/package.json');
    const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const version = (manifest as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    // The version is informational only — a failure to resolve it should not
    // turn "is the automation tool present" into a thrown error.
    return undefined;
  }
}

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

/**
 * Exported so a test can assert `libraryVersion` is actually wired into the
 * dependency object the default resolution uses — not just that
 * {@link resolvePlaywrightCoreVersion} works in isolation, which would not
 * catch the two being disconnected again. Asserting through this constant
 * needs no browser binary fetched, unlike asserting through
 * {@link resolveAutomationProbe}'s `present: true` branch, which does.
 */
export const REAL_DEPENDENCIES: AutomationProbeDependencies = {
  resolveExecutablePath: () => chromium.executablePath(),
  pathExists: (candidate) => fs.existsSync(candidate),
  libraryVersion: resolvePlaywrightCoreVersion(),
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
  // `BROKER_DOCTOR_AUTOMATION_OVERRIDE` is **not** a documented configuration
  // variable — it is not in `Environment` (`src/config/environment.ts`) or
  // `.env.example`, and no operator should ever set it. It exists only so
  // that a test spawning the real `broker` binary as a child process — with
  // no seam to inject `AutomationProbeDependencies` through — can still pin
  // this probe's answer deterministically, on a machine with or without a
  // browser binary fetched. `present` and (optionally) `detail` come from the
  // override, verbatim; unset, this branch is not taken and the real
  // resolution below runs exactly as it always has.
  const override = process.env.BROKER_DOCTOR_AUTOMATION_OVERRIDE;
  if (override === 'present') {
    return {
      present: true,
      version: dependencies.libraryVersion,
      detail: 'Forced present for a test.',
    };
  }
  if (override === 'absent') {
    return { present: false, detail: 'Forced absent for a test.' };
  }

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
