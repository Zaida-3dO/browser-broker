import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_TEST_FILES,
  MAXIMUM_EXPECTED_FAILURES,
  MINIMUM_EXPECTED_TESTS,
  failuresIn,
  parseTestCounts,
} from '../scripts/check-browser-tests.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The rules of the browser-test gate, exercised WITHOUT launching a browser.
 *
 * ── What is being protected ────────────────────────────────────────────
 *
 * The gate exists because `node --test` **exits 0 for a run in which every
 * test skipped**. That is not a quirk; it is the precise mechanism by which
 * forty-seven real-browser tests reported themselves green on every hosted
 * run while never executing, and by which an absent `isConnected`
 * delegation survived sixteen green jobs.
 *
 * So the single most important assertion in this file is that a summary
 * reading `pass 0 / fail 0 / skipped 33` is REFUSED. If that ever starts
 * passing, the gate has become the thing it was built to detect.
 *
 * ── Why these tests can fail ───────────────────────────────────────────
 *
 * Each test below names the change that breaks it. That is the repository's
 * standard: a test whose failure mode cannot be stated is a test that has
 * not been shown to work.
 *
 * ── What a green result here does NOT mean ─────────────────────────────
 *
 * It does not mean a browser ran. These tests drive the gate's decision
 * logic against synthetic summaries, deliberately, so that the rules are
 * covered on every machine including ones with no browser at all. Whether a
 * real browser actually launches is what the `browser-tests` job itself
 * proves, and it can only be proved on a runner that has one.
 */

/* ─────────────────── the defect the gate exists for ─────────────────── */

test('A RUN IN WHICH EVERYTHING SKIPPED IS REFUSED, though the runner exits 0', () => {
  // The exact shape of a hosted run with no browser installed.
  const counts = parseTestCounts(
    ['ℹ tests 33', 'ℹ pass 0', 'ℹ fail 0', 'ℹ skipped 33', 'ℹ todo 0'].join('\n'),
  );

  const failures = failuresIn(counts);

  // Delete the `skipped > 0` rule in failuresIn and this test fails.
  assert.ok(
    failures.some((failure) => failure.includes('SKIPPED')),
    'a fully skipped run must be refused by name',
  );
  assert.ok(failures.length > 0);
});

test('a SINGLE skipped test is enough to refuse, not merely a majority', () => {
  const counts = parseTestCounts(['ℹ tests 33', 'ℹ pass 32', 'ℹ fail 0', 'ℹ skipped 1'].join('\n'));

  // Change `skipped > 0` to `skipped > 1` and this fails.
  assert.ok(failuresIn(counts).some((failure) => failure.includes('SKIPPED')));
});

test('a skip is refused EVEN WHEN the failure count is within its ceiling', () => {
  // The two rules are independent. A run that skipped some tests and failed
  // an acceptable number of the rest must still be refused for the skip —
  // otherwise the ceiling would become a way to launder a silent skip, which
  // is precisely what this gate exists to prevent.
  const counts = parseTestCounts(['ℹ tests 33', 'ℹ pass 4', 'ℹ fail 24', 'ℹ skipped 5'].join('\n'));

  assert.ok(failuresIn(counts).some((failure) => failure.includes('SKIPPED')));
});

/* ─────────────────── the ordinary rules ─────────────────── */

test('a fully passing run is accepted', () => {
  // The state the repository reaches once the launch path is fixed. If this
  // ever fails, the gate rejects a healthy run and will be disabled within a
  // week — the failure mode the job's own comment warns of.
  const counts = parseTestCounts(
    ['ℹ tests 33', 'ℹ suites 0', 'ℹ pass 33', 'ℹ fail 0', 'ℹ skipped 0', 'ℹ todo 0'].join('\n'),
  );

  assert.deepEqual(failuresIn(counts), []);
});

test('THE KNOWN HOSTED-RUNNER FAILURE COUNT IS ACCEPTED, and a worse one is NOT', () => {
  // The honest current state: the suites run, and the ones that cold-start a
  // browser fail on the sandbox restriction. That is tolerated at exactly the
  // measured count and no higher, so the gate still says something true.
  const known = parseTestCounts(['ℹ tests 33', 'ℹ pass 9', 'ℹ fail 24', 'ℹ skipped 0'].join('\n'));
  assert.deepEqual(failuresIn(known), [], 'the measured state must not be reported as a failure');

  // One more failure is a REGRESSION and must be caught. Raise
  // MAXIMUM_EXPECTED_FAILURES and this test fails, which is the point: the
  // ceiling is a ratchet, and loosening it should not be quiet.
  const worse = parseTestCounts(['ℹ tests 33', 'ℹ pass 8', 'ℹ fail 25', 'ℹ skipped 0'].join('\n'));
  assert.ok(
    failuresIn(worse).some((failure) => failure.includes('at most')),
    'a failure count above the ceiling must be refused',
  );
});

test('A GATE THAT SHRANK TO NOTHING IS REFUSED', () => {
  // Deleting the suites, or narrowing the file list until it reaches almost
  // nothing, leaves a run that is green and meaningless. The floor is what
  // notices — and it counts tests that RAN, so it cannot be satisfied by a
  // run that merely failed everything.
  const counts = parseTestCounts(['ℹ tests 2', 'ℹ pass 2', 'ℹ fail 0', 'ℹ skipped 0'].join('\n'));

  // Remove the minimumExpected rule and this fails.
  assert.ok(failuresIn(counts).some((failure) => failure.includes('at least')));
});

test('the floor counts tests that RAN, not merely ones that passed', () => {
  // A run where everything executed and most failed has still reached the
  // tests, which is the property the floor protects. Were the floor to count
  // `pass` alone, the measured state above would trip it and the gate would
  // report the wrong problem.
  const counts = parseTestCounts(['ℹ tests 33', 'ℹ pass 9', 'ℹ fail 24', 'ℹ skipped 0'].join('\n'));

  assert.ok(!failuresIn(counts).some((failure) => failure.includes('at least')));
});

test('an unreadable summary is refused rather than assumed to be a pass', () => {
  // A runner that crashed before printing a summary, or a future version that
  // changes the format, must not be read as success. Guessing zero here would
  // manufacture exactly the false green this gate exists to prevent.
  const failures = failuresIn(parseTestCounts('the runner exploded'));

  assert.equal(failures.length, 1);
  assert.ok(failures[0].includes('no summary'));
});

/* ─────────────────── the parser, against real output ─────────────────── */

test('the summary parser reads the real format node --test emits', () => {
  // Captured verbatim from an actual run of tests/browser/dead-browser-status
  // rather than invented, so the parser is tested against the thing it must
  // read and not against a guess at it.
  const real = [
    '✔ a lease whose browser was killed is NOT reported active, and reclaiming recovers (958.1635ms)',
    'ℹ tests 1',
    'ℹ suites 0',
    'ℹ pass 1',
    'ℹ fail 0',
    'ℹ cancelled 0',
    'ℹ todo 0',
    'ℹ skipped 0',
    'ℹ duration_ms 2044.6055',
  ].join('\n');

  assert.deepEqual(parseTestCounts(real), { tests: 1, pass: 1, fail: 0, skipped: 0 });
});

test('the parser does not confuse one count for another', () => {
  // `pass` must not match inside `duration_ms`, and `tests` must not be read
  // off the `suites` line. Anchoring is what prevents it.
  const counts = parseTestCounts(
    ['ℹ tests 33', 'ℹ suites 4', 'ℹ pass 30', 'ℹ fail 3', 'ℹ skipped 0'].join('\n'),
  );

  assert.deepEqual(counts, { tests: 33, pass: 30, fail: 3, skipped: 0 });
});

/* ─────────────────── the file list is real ─────────────────── */

test('every suite the gate names actually exists', () => {
  // A typo in the list would mean the runner silently matches fewer files.
  // Rename any entry in BROWSER_TEST_FILES and this fails.
  for (const file of BROWSER_TEST_FILES) {
    assert.doesNotThrow(
      () => readFileSync(join(ROOT_DIR, file), 'utf8'),
      `${file} is named by the gate but is not on disk`,
    );
  }
  assert.ok(BROWSER_TEST_FILES.length >= 10, 'the gate should cover a meaningful set of suites');
});

test('THE KNOWN-FLAKY SUITE IS NOT IN THE GATE', () => {
  // tests/browser/cross-process-act.test.ts fails roughly one run in four in
  // isolation (a connectOverCDP timeout). Adding it back without fixing the
  // flake would make this gate unreliable, and an unreliable required gate
  // gets disabled — which is worse than not having one. If the flake is
  // genuinely fixed, delete this test in the same change that adds the file,
  // so the removal is deliberate and reviewed.
  assert.ok(
    !BROWSER_TEST_FILES.includes('tests/browser/cross-process-act.test.ts'),
    'the flaky cross-process-act suite must stay out of the gate until it is fixed',
  );
});

test('the expected floor sits below the measured count, not at it', () => {
  // At the floor, adding a single test would fail the gate and teach the next
  // person to edit the number rather than read what broke.
  assert.ok(MINIMUM_EXPECTED_TESTS >= 1);
  assert.ok(MINIMUM_EXPECTED_TESTS <= 33);
});

test('THE FAILURE CEILING IS A RATCHET THAT SHOULD ONLY EVER FALL', () => {
  // It encodes a known limitation, not a budget for new breakage. If the
  // launch path is fixed it goes to zero; if someone raises it, this test is
  // the thing that makes them look at it deliberately rather than nudging a
  // number until the job turns green.
  assert.ok(
    MAXIMUM_EXPECTED_FAILURES <= 24,
    'the ceiling must not rise above the count measured when this gate was written',
  );
});
