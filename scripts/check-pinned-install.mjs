#!/usr/bin/env node
/**
 * Fails when a documented `playwright-core` install command names no
 * version, or names one that disagrees with the exact pin in
 * `package.json`.
 *
 * ── The defect this exists for ──────────────────────────────────────────
 *
 * `package.json` pins `playwright-core` to an exact version — no caret, no
 * range — because the browser binary this service spawns is resolved by
 * that library's own `executablePath()`, and a binary fetched for a
 * *different* version of the library is not guaranteed to be one that
 * version resolves correctly. `README.md` and `docs/ROLLOUT.md` each carry
 * an install command telling a newcomer how to fetch that binary. Both used
 * to read `npx playwright-core install chromium` — no version — which lets
 * `npx` resolve latest, fetch a Chromium build the pinned library was never
 * tested against, and fail `broker doctor`'s automation check with no clue
 * in the error that an unpinned fetch was the cause. The doctor remedy
 * pointed back at the same README section, closing a loop with no exit: see
 * `src/doctor/checks.ts`'s `checkAutomation` and the pull request this
 * script shipped with.
 *
 * A comment next to the pin asking a human to remember to update the docs
 * on a bump is exactly the mechanism that let the two drift apart the first
 * time — nothing forces anyone to read it. This script is the alternative:
 * it reads the pin itself and fails the build the moment a documented
 * command disagrees with it, whether that happens because the docs were
 * never fixed or because a future bump changed the pin and nobody touched
 * the docs.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **What it means:** every `npx ... playwright-core install chromium`
 * invocation in the scanned docs names a version, and that version is the
 * one `package.json`'s `dependencies` pins.
 *
 * **What it does not mean:**
 * - That the command actually installs a working browser — this is a text
 *   check against two files, not a spawn of `npx`. `check:install` and a
 *   real cold-start are what prove the command runs; this only proves the
 *   number in it cannot silently go stale.
 * - That every install instruction anywhere in the repository is covered.
 *   It scans a fixed, named list of files (`SCANNED_FILES` below), because
 *   the install command lives in exactly those places and nowhere else;
 *   a further copy added elsewhere would need adding to that list, the same
 *   way `check-doc-links.mjs`'s `LINK_KEYWORDS` is a pinned, named set
 *   rather than something the script infers. That is precisely what happened
 *   when continuous integration gained a job that installs the browser: the
 *   workflow became a third place the command lives, so it was added below.
 *   An unpinned install in the workflow is in fact WORSE than an unpinned
 *   one in the docs — the docs mislead a newcomer who can then read the
 *   error, while the workflow would fetch a mismatched Chromium on every run
 *   and attribute the resulting failure to the tests.
 * - That `package.json`'s pin itself is a *caret* range would still be
 *   silently accepted by a lot of tooling; this script additionally refuses
 *   that, on the grounds that a range pin makes "the version" a moving
 *   target this check could never state a single correct answer for.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The places this repository states the install command.
 *
 * The first two document it for a human. The third RUNS it: the
 * `browser-tests` job installs the browser it then drives, and a drifted pin
 * there would silently fetch a Chromium the pinned library was never tested
 * against on every continuous-integration run.
 */
export const SCANNED_FILES = ['README.md', 'docs/ROLLOUT.md', '.github/workflows/ci.yml'];

/**
 * `npx` invocations that end up running `playwright-core install
 * chromium`, however they get there. Captures the whole match so a failure
 * can quote it back, and a trailing capture group for an `@version` on the
 * bare `playwright-core` form so an unpinned invocation is distinguishable
 * from one this pattern does not recognise at all.
 *
 * Flags between `install` and `chromium` are tolerated because the workflow
 * passes `--with-deps` (the shared libraries a Chromium needs on a bare
 * runner image). A pattern that did not allow them would fail to MATCH that
 * invocation rather than fail to approve it — so an unpinned install in the
 * workflow would sail through a green gate, which is the exact shape of
 * defect this script exists to prevent.
 */
const NPX_INSTALL_PATTERN =
  /npx\s+(?:-p\s+playwright-core@([\w.-]+)\s+playwright-core|playwright-core)\s+install\s+(?:--[\w-]+\s+)*chromium/g;

/**
 * The exact version pinned for `playwright-core` in `dependencies`.
 *
 * Refuses — rather than silently picking one — if the manifest names a
 * range instead of an exact version. A range has no single "the pinned
 * version" for a documented command to name, and a script that picked the
 * range's lower or upper bound would be inventing an answer the manifest
 * itself does not give.
 */
export function pinnedPlaywrightCoreVersion(manifest) {
  const declared = manifest.dependencies?.['playwright-core'];
  if (declared === undefined) {
    throw new Error('package.json has no "playwright-core" entry under "dependencies"');
  }
  if (!/^\d+\.\d+\.\d+$/.test(declared)) {
    throw new Error(
      `package.json pins "playwright-core": "${declared}", which is not an exact ` +
        'major.minor.patch version. This check only knows how to state a single ' +
        'correct documented version for an exact pin — widen it deliberately, or ' +
        'pin exactly.',
    );
  }
  return declared;
}

/**
 * Every `npx ... install chromium` invocation found in `source`, each
 * reported against the exact version it names — `undefined` when the
 * invocation names none at all.
 */
export function installInvocationsIn(source) {
  const found = [];
  for (const match of source.matchAll(NPX_INSTALL_PATTERN)) {
    found.push({ text: match[0], version: match[1] });
  }
  return found;
}

/**
 * Every invocation in `sources` that either names no version or names one
 * that disagrees with `expectedVersion`. `sources` maps a file path to its
 * text, mirroring `check-doc-links.mjs`'s `danglingLinks` shape so both
 * gates are driven the same way from their own self-tests.
 */
export function driftedInstallInvocations(sources, expectedVersion) {
  const failures = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const { text: invocation, version } of installInvocationsIn(text)) {
      if (version !== expectedVersion) failures.push({ file, invocation, version });
    }
  }
  return failures;
}

function main() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let expectedVersion;
  try {
    expectedVersion = pinnedPlaywrightCoreVersion(manifest);
  } catch (error) {
    console.error(`Pinned-install check failed: ${error.message}`);
    return 1;
  }

  const sources = {};
  for (const file of SCANNED_FILES) {
    sources[file] = readFileSync(path.join(ROOT, file), 'utf8');
  }

  const failures = driftedInstallInvocations(sources, expectedVersion);

  if (failures.length > 0) {
    for (const failure of failures) {
      const named =
        failure.version === undefined ? 'names no version at all' : `names ${failure.version}`;
      console.error(
        `${failure.file}: \`${failure.invocation}\` ${named}, but package.json pins ` +
          `playwright-core to ${expectedVersion}.\n` +
          `    An unpinned or mismatched install command can fetch a Chromium build the pinned\n` +
          `    library was never tested against. Use: npx -p playwright-core@${expectedVersion} ` +
          `playwright-core install chromium\n`,
      );
    }
    console.error(
      `${failures.length} documented install command${failures.length === 1 ? '' : 's'} ` +
        `disagreeing with the playwright-core pin in package.json.`,
    );
    return 1;
  }

  console.log(
    `Every install command in ${SCANNED_FILES.join(', ')} names playwright-core@${expectedVersion}, ` +
      `matching the pin in package.json. This does not prove the command installs a working ` +
      `browser — see check:install and this script's header for what it does and does not cover.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
