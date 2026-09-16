#!/usr/bin/env node
/**
 * Clear browsers leaked by an EARLIER run, before this one starts.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE HALF OF THE LEAK THAT NO HANDLER CAN CLOSE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `tests/helpers/browser-fixture.ts` reaps the browsers a run started, both on
 * teardown and — since item 7befc327 — on `exit`, `SIGINT`, `SIGTERM` and
 * `SIGHUP`. That covers every interruption **that runs code**.
 *
 * `SIGKILL`, a power cut and a bluescreen run nothing, by definition. No
 * in-process handler can ever cover them, and writing one that claimed to
 * would be worse than leaving the gap visible. So the remaining case is closed
 * from the *other* side: the next run sweeps before it starts, which is the
 * one moment the previous run's leftovers are unambiguously garbage.
 *
 * Why it matters that this runs at all: each leaked root is a live Chromium,
 * the real-browser suites sit on a thin margin against Playwright's 30-second
 * screenshot bound, and every leak makes the next run likelier to cross it. A
 * leak of this family once reached 1,637 processes and froze a machine.
 *
 * ── Why this never fails the test run ───────────────────────────────────
 *
 * It exits 0 whatever happens. This is housekeeping that runs *before* the
 * thing anybody asked for, and a sweeper that cannot sweep must not stand
 * between a developer and their tests — a red `npm test` that means "the
 * cleaner is unhappy" trains people to stop reading the output.
 *
 * Non-Windows is a clean no-op rather than an error: the sweeper is
 * PowerShell, the leak it addresses is the Windows one, and the fixture's own
 * handlers are platform-neutral and cover every signal case on every platform.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

if (process.platform !== 'win32') {
  // Nothing to do, and saying so is better than silence: a reader wondering
  // whether the sweep ran gets an answer either way.
  console.log('pretest sweep: not Windows, nothing to sweep.');
  process.exit(0);
}

const script = path.join(here, 'reap-broker-browsers.ps1');

// `-Execute` because a dry run here would print a report nobody reads and
// clear nothing, which is the failure mode this hook exists to end.
//
// **`-PruneDirs -OlderThanHours 2` and not a bare prune.** The directories of
// a run that is happening RIGHT NOW are not garbage — two suites can run at
// once on this machine, and a sweep that removed a live run's profile would
// manufacture exactly the failure it is meant to prevent. Two hours is well
// past the longest browser suite and well short of "tomorrow morning".
//
// The kill half is already safe without an age bound: it only ever terminates
// processes whose command line carries the `broker-` stem AND whose profile
// lives under this user's TEMP, it filters out Windows zombies by `HasExited`,
// and it kills by explicit pid rather than by image name — so a developer's
// own Chrome and another agent's browsers are not candidates.
const result = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Execute',
    '-PruneDirs',
    '-OlderThanHours',
    '2',
  ],
  { encoding: 'utf8' },
);

if (result.error !== undefined) {
  console.log(`pretest sweep: could not run the sweeper (${result.error.message}). Continuing.`);
  process.exit(0);
}

// Printed rather than swallowed. The sweeper names the prefixes it found, and
// that line is the only way an unknown prefix ever becomes visible — the
// failure that let three separate leaks hide in a row.
if (typeof result.stdout === 'string' && result.stdout.trim().length > 0) {
  console.log(result.stdout.trim());
}
if (typeof result.stderr === 'string' && result.stderr.trim().length > 0) {
  console.log(`pretest sweep stderr: ${result.stderr.trim()}`);
}

process.exit(0);
