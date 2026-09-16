#!/usr/bin/env node
/**
 * Runs the real-browser suites and fails unless they actually RAN.
 *
 * ── The defect this exists for ──────────────────────────────────────────
 *
 * Every suite that drives a real browser gates itself on
 * `browserAvailable()` from `tests/helpers/browser.ts`, and a hosted runner
 * has neither a browser binary nor a display — so on continuous integration
 * all of them skipped, and `node --test` reported that as a **green run**.
 * Forty-seven tests rendered as a pass by not executing.
 *
 * That is not a hypothetical. It is why the defect behind
 * `tests/browser/dead-connection-live-browser.test.ts` shipped to review:
 * `RealBrowserSession` never implemented `isConnected`, every real call took
 * the assume-usable branch, and sixteen hosted jobs were green throughout,
 * because the only tests that could see it never ran.
 *
 * Installing a browser in the workflow is half the fix. This script is the
 * other half, and it is the half that cannot rot: **if the install step is
 * ever removed, renamed, or silently fails, the suites go back to skipping —
 * and a skip must not be able to look like a pass.** So this does not merely
 * run the tests and trust the exit code. It reads the runner's own summary
 * and refuses unless:
 *
 *   - `fail` is zero, and
 *   - `skipped` is **zero** — the assertion the exit code cannot make, since
 *     `node --test` exits 0 for a run in which every test skipped, and
 *   - `pass` is at least {@link MINIMUM_EXPECTED_TESTS} — so deleting the
 *     suites, or narrowing the file list until nothing runs, fails here
 *     instead of quietly shrinking the gate to nothing.
 *
 * The counts are printed on success as well as on failure, because the
 * acceptance this was written against is that the job *reports the count it
 * actually ran*. A number nobody can see is a number nobody checks.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS SUBSET, AND NOT ALL FORTY-SEVEN
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A gate that is flaky gets ignored, then disabled, and that is worse than
 * not having one. So the list below is the subset that was **measured**
 * stable, and one suite is deliberately excluded:
 *
 * **`tests/browser/cross-process-act.test.ts` is excluded because it is
 * flaky, measured at roughly one failure in four runs *in isolation* on an
 * idle machine** — `browserType.connectOverCDP: Timeout 30000ms exceeded`,
 * where the websocket connects and the handshake then never completes. A
 * hosted runner is slower and more contended than the machine that rate was
 * measured on, so it would be no better there. It is named here rather than
 * dropped silently, because an excluded test that nobody can see excluded is
 * the same invisible-hole problem in a new place. Fixing that flake is
 * separate work; when it is fixed, add the file here and raise the minimum.
 *
 * This subset is therefore an honest floor, not a complete claim. What a
 * green run here means is stated below — and what it does not mean is stated
 * with it, because this repository's own gates are written that way.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **What it means:** a real Chromium was launched, headed, against a real
 * display, and the listed suites executed with nothing skipped.
 *
 * **What it does not mean:**
 * - That every real-browser test in the repository ran. It does not — see
 *   the exclusion above, and `npm test` continues to run the whole suite
 *   with its own skip behaviour unchanged.
 * - That the browser is the one a user has. It is the pinned build the
 *   automation library resolves, which is the point: the pin is what makes
 *   the run reproducible.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The suites this gate runs.
 *
 * Every one drives a real browser. They are listed explicitly rather than
 * globbed so that adding a browser suite is a deliberate act with a visible
 * diff — a glob would silently absorb a new flaky suite into a required
 * gate, which is the failure this file's header argues against.
 */
export const BROWSER_TEST_FILES = [
  // The suite written for the `isConnected` defect itself: a real session
  // whose connection ended must not be handed back. A fake driver cannot
  // catch this, because the subject IS the delegation.
  'tests/browser/dead-connection-live-browser.test.ts',
  'tests/browser/dead-browser-status.test.ts',
  'tests/browser/navigate-redirect.test.ts',
  'tests/browser/real-driver.test.ts',
  'tests/browser/sign-in-evidence.test.ts',
  // Headed behaviour that does not occur headless, so these are the tests
  // that make the display real rather than decorative.
  'tests/browser/keeper-tab.test.ts',
  'tests/browser/foreground.test.ts',
  'tests/browser/capture-surface.test.ts',
  'tests/browser/capture-tall-page.test.ts',
  'tests/browser/cross-process-tab.test.ts',
  'tests/capture/ladder-rendered.test.ts',
];

/**
 * The floor for `pass`.
 *
 * Measured at 33 across the files above. The floor sits just under it rather
 * than at it, so that adding a test does not fail the gate while deleting a
 * suite still does. It is a floor against the list collapsing, not a
 * fingerprint of the current count.
 */
export const MINIMUM_EXPECTED_TESTS = 30;

/**
 * The counts in `node --test`'s summary.
 *
 * The summary lines look like `ℹ pass 33`, emitted on the default reporter
 * when it is not a terminal as well as when it is. Parsed with an anchored
 * pattern per field rather than by position, so an added summary line does
 * not shift anything.
 *
 * Returns `undefined` for a field the output never stated — which is itself
 * a failure the caller reports, because a summary this cannot read is a
 * summary this cannot make assertions about, and guessing zero would invent
 * a pass.
 */
export function parseTestCounts(output) {
  const read = (field) => {
    const match = output.match(new RegExp(`^\\s*(?:ℹ|#)?\\s*${field}\\s+(\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : undefined;
  };
  return {
    tests: read('tests'),
    pass: read('pass'),
    fail: read('fail'),
    skipped: read('skipped'),
  };
}

/**
 * Every reason `counts` is not an acceptable run, in the order a reader
 * should hear them. Empty means the run is good.
 *
 * Separated from the spawn so the rules can be exercised without launching a
 * browser — the repository's own injected-test rule asks for exactly this
 * seam.
 */
export function failuresIn(counts, { minimumExpected = MINIMUM_EXPECTED_TESTS } = {}) {
  const failures = [];
  const { tests, pass, fail, skipped } = counts;

  if (pass === undefined || fail === undefined || skipped === undefined) {
    failures.push(
      'the test runner printed no summary this check could read, so nothing can be ' +
        'asserted about what ran. Refusing rather than assuming a pass.',
    );
    return failures;
  }

  if (fail > 0) {
    failures.push(`${fail} test${fail === 1 ? '' : 's'} failed.`);
  }

  if (skipped > 0) {
    failures.push(
      `${skipped} test${skipped === 1 ? '' : 's'} SKIPPED. This job exists to run the ` +
        'real-browser suites, so a skip here means the browser was not installed, not ' +
        'found, or had no display — and the whole point of this gate is that such a run ' +
        'must not be able to report itself green. Check the install step and that ' +
        'DISPLAY is set (the suites need a real, headed display; never make them pass ' +
        'by running headless).',
    );
  }

  if (pass < minimumExpected) {
    failures.push(
      `only ${pass} test${pass === 1 ? '' : 's'} passed, but at least ${minimumExpected} ` +
        'were expected. Either a suite is missing or the file list does not reach the ' +
        'tests; a gate that silently shrinks to nothing would still be green.',
    );
  }

  if (tests !== undefined && tests === 0) {
    failures.push('the runner matched no tests at all.');
  }

  return failures;
}

function main() {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...BROWSER_TEST_FILES],
    {
      cwd: ROOT,
      encoding: 'utf8',
      // Inherited so the run is visible in the log as it happens, and piped
      // so the summary can be read. `spawnSync` cannot do both, so the
      // output is captured and echoed.
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);

  if (result.error) {
    console.error(`Browser-test check failed to start the runner: ${result.error.message}`);
    return 1;
  }

  const counts = parseTestCounts(output);
  const failures = failuresIn(counts);

  // Reported on every path, pass or fail: the acceptance this was written
  // against is that the job states the count it actually ran.
  console.log(
    `\nBrowser tests: ${counts.pass ?? '?'} passed, ${counts.fail ?? '?'} failed, ` +
      `${counts.skipped ?? '?'} skipped, of ${counts.tests ?? '?'} in ` +
      `${BROWSER_TEST_FILES.length} suites.`,
  );

  if (failures.length > 0) {
    console.error('\nBrowser-test check FAILED:');
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    return 1;
  }

  console.log(
    'A real, headed browser ran every listed suite with nothing skipped. This does not ' +
      'cover every real-browser test in the repository — see this script’s header for the ' +
      'suite deliberately excluded as flaky, and why.',
  );
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
