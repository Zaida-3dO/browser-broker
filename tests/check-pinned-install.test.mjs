import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SCANNED_FILES,
  driftedInstallInvocations,
  installInvocationsIn,
  pinnedPlaywrightCoreVersion,
} from '../scripts/check-pinned-install.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * The self-test for the pinned-install-version build rule.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN OF THIS FILE MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `CLAUDE.md`: a script used as a gate "must ship a test proving it fails on a
 * seeded violation, not merely that it passes on clean input", and must "state
 * plainly what a green result does, and does not, mean".
 *
 * **What it means:** the scan has been run against text that violates it —
 * both an unversioned invocation and one naming the wrong version, including
 * the *real* line that motivated the rule, taken verbatim from this
 * repository's own history rather than invented — and refused each one. It
 * has also been run against the actual shipped `README.md` and
 * `docs/ROLLOUT.md` and found them clean, so this is not only a test of the
 * pattern in isolation.
 *
 * **What it does not mean:** that the install command actually installs a
 * working browser, that every install instruction in the repository is
 * covered (only the two files in `SCANNED_FILES` are scanned — see the
 * script's header for why that is a named list rather than an inference),
 * or that `package.json`'s own pin is the *right* version to depend on. It
 * only proves the documented number cannot silently drift from the pinned
 * one.
 */

/* ─────────────────── it fails on a seeded violation ─────────────────── */

test('an install command naming no version at all is refused', () => {
  const found = driftedInstallInvocations(
    { 'README.md': 'Run:\n\n```bash\nnpx playwright-core install chromium\n```\n' },
    '1.62.1',
  );

  assert.equal(found.length, 1);
  assert.equal(found[0]?.version, undefined);
  assert.equal(found[0]?.file, 'README.md');
});

test('THE REAL DEFECT THIS RULE EXISTS FOR IS CAUGHT, on the text that carried it', () => {
  // Not a synthetic seed: this is the exact line that shipped in both
  // README.md and docs/ROLLOUT.md before this rule existed, verified at
  // HEAD ca53f43 (see the task this script's header cites). It names no
  // version, so a pinned library resolves whatever Chromium build `npx`
  // happened to fetch as latest that day.
  const found = driftedInstallInvocations(
    {
      'docs/ROLLOUT.md': 'Fetch one with:\n\n```bash\nnpx playwright-core install chromium\n```\n',
    },
    '1.62.1',
  );

  assert.equal(found.length, 1);
  assert.equal(found[0]?.invocation, 'npx playwright-core install chromium');
});

test('an install command naming a version that disagrees with the pin is refused', () => {
  // The shape a future version bump produces if only package.json is
  // touched: the docs still read correctly as *a* pinned command, but the
  // pin they name is stale.
  const found = driftedInstallInvocations(
    {
      'README.md': '```bash\nnpx -p playwright-core@1.61.0 playwright-core install chromium\n```\n',
    },
    '1.62.1',
  );

  assert.equal(found.length, 1);
  assert.equal(found[0]?.version, '1.61.0');
});

test('several drifted invocations across files are all reported, not just the first', () => {
  const found = driftedInstallInvocations(
    {
      'README.md': 'npx playwright-core install chromium',
      'docs/ROLLOUT.md': 'npx -p playwright-core@9.9.9 playwright-core install chromium',
    },
    '1.62.1',
  );

  assert.deepEqual(found.map((failure) => failure.file).sort(), ['README.md', 'docs/ROLLOUT.md']);
});

/* ─────────────────── it passes on a correct invocation ─────────────────── */

test('an install command naming the expected version is not reported', () => {
  const found = driftedInstallInvocations(
    {
      'README.md': '```bash\nnpx -p playwright-core@1.62.1 playwright-core install chromium\n```\n',
    },
    '1.62.1',
  );

  assert.deepEqual(found, []);
});

test('text with no install invocation at all reports nothing', () => {
  assert.deepEqual(
    driftedInstallInvocations({ 'README.md': 'Nothing to see here.' }, '1.62.1'),
    [],
  );
});

/* ─────────────────── the manifest's pin is read correctly ─────────────────── */

test('pinnedPlaywrightCoreVersion reads the exact version out of dependencies', () => {
  assert.equal(
    pinnedPlaywrightCoreVersion({ dependencies: { 'playwright-core': '1.62.1' } }),
    '1.62.1',
  );
});

test('pinnedPlaywrightCoreVersion refuses a caret range — there is no single version to document', () => {
  assert.throws(
    () => pinnedPlaywrightCoreVersion({ dependencies: { 'playwright-core': '^1.62.1' } }),
    /not an exact/,
  );
});

test('pinnedPlaywrightCoreVersion refuses a missing dependency rather than reporting undefined as a version', () => {
  assert.throws(
    () => pinnedPlaywrightCoreVersion({ dependencies: {} }),
    /no "playwright-core" entry/,
  );
});

/* ─────────────────── the invocation pattern itself ─────────────────── */

test('installInvocationsIn resolves the version out of the -p form', () => {
  const found = installInvocationsIn(
    'npx -p playwright-core@2.0.0 playwright-core install chromium',
  );

  assert.deepEqual(found, [
    { text: 'npx -p playwright-core@2.0.0 playwright-core install chromium', version: '2.0.0' },
  ]);
});

test('installInvocationsIn reports the bare form as version undefined, not as no match', () => {
  const found = installInvocationsIn('npx playwright-core install chromium');

  assert.equal(found.length, 1);
  assert.equal(found[0]?.version, undefined);
});

/* ─────────────────── and it passes on the real, shipped docs ─────────────────── */

test('every install command in the shipped docs names the version package.json pins', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
  const expected = pinnedPlaywrightCoreVersion(manifest);

  const sources = {};
  for (const file of SCANNED_FILES) {
    sources[file] = readFileSync(join(ROOT_DIR, file), 'utf8');
  }

  // A tree with no install invocation at all would make the assertion below
  // vacuous — passing not because the docs are correct but because there was
  // nothing there to check.
  const total = Object.values(sources).reduce(
    (sum, text) => sum + installInvocationsIn(text).length,
    0,
  );
  assert.ok(total >= 2, `expected at least one install command per scanned file, found ${total}`);

  assert.deepEqual(driftedInstallInvocations(sources, expected), []);
});
