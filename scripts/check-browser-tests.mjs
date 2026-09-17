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
 *   - `skipped` is **zero** — the assertion the exit code cannot make, since
 *     `node --test` exits 0 for a run in which every test skipped;
 *   - the runner actually executed the tests, rather than matching no files;
 *   - and no *more* than {@link MAXIMUM_EXPECTED_FAILURES} failed, which is
 *     the honest expression of the state measured below.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ THE SUITES DO NOT PASS ON A HOSTED RUNNER, AND THE REASON IS PROVEN
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **They run, and most of them fail.** This is stated here rather than hidden
 * behind a narrowed file list, because an excluded failure nobody can see is
 * the same invisible hole this whole file exists to close.
 *
 * Measured on `ubuntu-latest`, by launching the pinned binary by hand under
 * `xvfb` — with and without one argument, changing nothing else:
 *
 * | Launch | Result |
 * |---|---|
 * | As `launchArguments()` builds it | `FATAL … No usable sandbox!`, `Trace/breakpoint trap (core dumped)`, exit 133, **no endpoint** |
 * | Identical, plus `--no-sandbox` | `DevTools listening on ws://127.0.0.1:44415/…`, **endpoint written** |
 *
 * The kernel on that image reports
 * `kernel.apparmor_restrict_unprivileged_userns = 1`, which is exactly the
 * restriction the browser's own message names. So every test that cold-starts
 * a browser fails with `StartupRefusal`, and the ones that pass are the ones
 * that never launch one.
 *
 * **The fix is not available from here, and should not be taken lightly.**
 * `src/browser/launch.ts` refuses `--no-sandbox` from a caller's extras by
 * design, listing it as a subtractive argument, so no workflow, helper or
 * test can supply it — it needs a deliberate change where the launch
 * arguments are built. And it is a real trade rather than a formality:
 * `--no-sandbox` removes the browser's own process isolation on a runner
 * that executes untrusted pull-request code. That decision belongs to
 * whoever owns the launch path, recorded as a decision.
 *
 * **So what is this gate worth?** It is worth the thing that was
 * missing: a hosted runner that *installs a browser, runs these
 * tests, and states what happened*. Before it, the same suites reported a
 * silent green while executing nothing. A red job that names its cause is
 * strictly better than a green one that ran nothing — and the moment the
 * launch path is fixed, this job goes green with no change here beyond
 * lowering the number below.
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
 * stable, and two suites are deliberately excluded:
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
 * **`tests/browser/cross-process-close.test.ts` is excluded because both of
 * its tests cold-start a browser, which cannot succeed on a hosted runner for
 * the sandbox reason set out above.** Adding it would push `fail` from 24 to
 * 26 and force {@link MAXIMUM_EXPECTED_FAILURES} upward — and that number is a
 * ratchet that should only ever go down. Raising a safety ceiling to
 * accommodate tests that are *known* to fail in this environment would convert
 * this gate back into the thing it was built to replace, so the exclusion is
 * recorded here instead.
 *
 * ⚠️ **Read that as "requires a local browser", never as "optional".** These
 * are the tests that prove a page opened by one connection is really gone
 * after another closes it, and that **the keeper survives being named to
 * `closeTab` by a session that has not established it** — the case that ends a
 * shared signed-in browser, since a headed browser dies within about half a
 * second of its last tab closing. They must be run locally, on a machine with
 * a browser, before a change to the close path is merged. A green run of this
 * gate says nothing whatsoever about them.
 *
 * This subset is therefore an honest floor, not a complete claim. What a
 * green run here means is stated below — and what it does not mean is stated
 * with it, because this repository's own gates are written that way.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **What it means:** a real browser binary was installed and found, a real
 * display was present, the listed suites **executed** rather than skipping,
 * and no more of them failed than the known, named launch limitation
 * accounts for.
 *
 * **What it does not mean:**
 * - **That the real-browser behaviour is verified.** On a hosted runner most
 *   of these tests fail to launch at all, for the proven reason
 *   above. A green run here is evidence that the suites RAN and that the
 *   failure count has not grown — not that the browser behaviour is sound.
 *   The local run, on a machine whose kernel permits the sandbox, is what
 *   verifies that.
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
 * The floor for how many tests must have RUN.
 *
 * Measured at 33 across the files above. The floor sits under it rather than
 * at it, so adding a test does not fail the gate while deleting a suite
 * still does. It is a guard against the list collapsing to nothing, not a
 * fingerprint of the current count.
 *
 * Note this counts `pass + fail`, not `pass`. What it protects is that the
 * runner *reached* these tests — which is the property that silently
 * disappeared before this gate existed.
 */
export const MINIMUM_EXPECTED_TESTS = 30;

/**
 * The ceiling for `fail`, and a number that should only ever go DOWN.
 *
 * Every test that cold-starts a browser fails on a hosted runner,
 * for the sandbox reason set out in this file's header — 24 of 33, measured.
 * The ceiling is that measurement, so the gate states something true
 * while still failing if the situation gets *worse*: a twenty-fifth failure
 * is a regression this catches.
 *
 * **This is a ratchet, not a tolerance.** When the launch path is fixed, this
 * drops — ideally to zero. Raising it to make a red run green would convert
 * this gate back into the thing it was built to replace, so a change that
 * raises it needs to say why in the same breath.
 */
export const MAXIMUM_EXPECTED_FAILURES = 24;

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
export function failuresIn(
  counts,
  { minimumExpected = MINIMUM_EXPECTED_TESTS, maximumFailures = MAXIMUM_EXPECTED_FAILURES } = {},
) {
  const failures = [];
  const { tests, pass, fail, skipped } = counts;

  if (pass === undefined || fail === undefined || skipped === undefined) {
    failures.push(
      'the test runner printed no summary this check could read, so nothing can be ' +
        'asserted about what ran. Refusing rather than assuming a pass.',
    );
    return failures;
  }

  if (fail > maximumFailures) {
    failures.push(
      `${fail} tests failed, but at most ${maximumFailures} were expected. That ceiling is ` +
        'the known hosted-runner launch limitation (see this file’s header), so exceeding ' +
        'it is a NEW failure rather than the familiar one. Raising the ceiling to make ' +
        'this green would rebuild the false pass this gate replaced — find out what broke.',
    );
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

  const executed = pass + fail;
  if (executed < minimumExpected) {
    failures.push(
      `only ${executed} test${executed === 1 ? '' : 's'} ran, but at least ${minimumExpected} ` +
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
    'The suites RAN: a browser was installed and found, a display was present, and nothing ' +
      'skipped. This is not a statement that the browser behaviour is verified — on a hosted ' +
      'runner most of these tests still fail to launch at all, for the sandbox reason in this ' +
      'script’s header, and that known failure count is what the ceiling above encodes.',
  );
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
