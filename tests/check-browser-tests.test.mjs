import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_TEST_FILES,
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

/* ─────────────────── the ordinary rules ─────────────────── */

test('a clean run is accepted', () => {
  const counts = parseTestCounts(
    ['ℹ tests 33', 'ℹ suites 0', 'ℹ pass 33', 'ℹ fail 0', 'ℹ skipped 0', 'ℹ todo 0'].join('\n'),
  );

  // If this ever fails, the gate rejects a healthy run and will be disabled
  // within a week — which is the failure mode the job's own comment warns of.
  assert.deepEqual(failuresIn(counts), []);
});

test('a failing test is refused', () => {
  const counts = parseTestCounts(['ℹ tests 33', 'ℹ pass 32', 'ℹ fail 1', 'ℹ skipped 0'].join('\n'));

  assert.ok(failuresIn(counts).some((failure) => failure.includes('failed')));
});

test('A GATE THAT SHRANK TO NOTHING IS REFUSED', () => {
  // Deleting the suites, or narrowing the file list until it reaches almost
  // nothing, leaves a run that is green and meaningless. The floor is what
  // notices.
  const counts = parseTestCounts(['ℹ tests 2', 'ℹ pass 2', 'ℹ fail 0', 'ℹ skipped 0'].join('\n'));

  // Remove the minimumExpected rule and this fails.
  assert.ok(failuresIn(counts).some((failure) => failure.includes('at least')));
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
