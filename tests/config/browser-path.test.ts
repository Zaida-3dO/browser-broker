import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { browserPathVariable, readEnvironment } from '../../src/config/environment.ts';
import { absolutePath } from '../helpers/paths.ts';
import { StartupRefusal } from '../../src/errors.ts';

/**
 * `BROKER_BROWSER_<NAME>_PATH` — pointing a configured browser at a binary
 * the machine already has.
 *
 * ── The defect every test here is aimed at ──────────────────────────────
 *
 * A **silent fallback**. A configured path that cannot be used, quietly
 * replaced by the bundled Chromium, is a launch that succeeds while giving
 * the caller something other than what they asked for — and there is nothing
 * for them to notice it by, because a working browser appears. `DECISIONS.md`
 * pre-specified this exact case when it declined engine resolution: *"If
 * resolution is built, the fallback must not be silent."*
 *
 * So the assertions below are mostly about **refusing**, and each one names
 * the mutation that would make it fire.
 *
 * Nothing here touches the filesystem: existence is asked through the
 * injected `fileExists`, so these assert on the rule rather than on what
 * happens to be installed on the machine running them — in either direction.
 */

const home = (): string => absolutePath('home', 'someone');

/** Every path is there. */
const anythingExists = (): boolean => true;
/** Nothing is there. */
const nothingExists = (): boolean => false;

const base = { homedir: home, platform: 'linux' } as const;

test('the variable name is the browser name upper-cased, with hyphens as underscores', () => {
  assert.equal(browserPathVariable('regular'), 'BROKER_BROWSER_REGULAR_PATH');
  assert.equal(browserPathVariable('private'), 'BROKER_BROWSER_PRIVATE_PATH');
  // A hyphen is legal in a browser name and illegal in an environment
  // variable, so it collapses to an underscore.
  assert.equal(browserPathVariable('clean-room'), 'BROKER_BROWSER_CLEAN_ROOM_PATH');
});

test('an unset path leaves the browser absent from the map — it takes the bundled build', () => {
  const environment = readEnvironment({ ...base, env: {}, fileExists: anythingExists });

  assert.equal(environment.browserPaths.size, 0);
  assert.equal(environment.browserPaths.get('regular'), undefined);
});

// The mutation this catches: dropping the assignment into the map, or keying
// it on something other than the browser name. Either way the configured
// binary never reaches a launch and the bundled one is used silently — the
// whole defect, in the form it would actually take.
test('a configured path is resolved and keyed by the browser it names', () => {
  const binary = absolutePath('opt', 'a-browser', 'browser');
  const environment = readEnvironment({
    ...base,
    env: { BROKER_BROWSER_REGULAR_PATH: binary },
    fileExists: anythingExists,
  });

  assert.equal(environment.browserPaths.get('regular'), binary);
});

// Acceptance criterion 2 of the item: two configured browsers with DIFFERENT
// binaries coexist. The mutation this catches: resolving one path for the
// whole process rather than one per browser, which is the shape the driver
// had before this row and the reason `#executablePath` took no argument.
test('two browsers can be pointed at two different binaries at once', () => {
  const chrome = absolutePath('opt', 'chrome', 'chrome');
  const edge = absolutePath('opt', 'edge', 'edge');
  const environment = readEnvironment({
    ...base,
    env: { BROKER_BROWSER_REGULAR_PATH: chrome, BROKER_BROWSER_PRIVATE_PATH: edge },
    fileExists: anythingExists,
  });

  assert.equal(environment.browserPaths.get('regular'), chrome);
  assert.equal(environment.browserPaths.get('private'), edge);
});

test('a browser named in a configured list gets its own variable', () => {
  const binary = absolutePath('opt', 'a-browser', 'browser');
  const environment = readEnvironment({
    ...base,
    env: {
      BROKER_REGULAR_BROWSERS: 'work,clean-room',
      BROKER_BROWSER_CLEAN_ROOM_PATH: binary,
    },
    fileExists: anythingExists,
  });

  assert.equal(environment.browserPaths.get('clean-room'), binary);
  assert.equal(environment.browserPaths.get('work'), undefined);
});

// ── The loud failure (the item's AC3, and this row's whole reason) ───────

// THE MUTATION THIS CATCHES, stated exactly: turn the `throw` in
// `readBrowserPath` into a `return`/`continue` that leaves the browser out of
// the map. That is the silent fallback — the browser would launch the bundled
// Chromium and nothing would say so. Under that change this test goes red.
test('a configured path with no file at it REFUSES — it never falls back to the bundled build', () => {
  const missing = absolutePath('opt', 'not-installed', 'browser');

  assert.throws(
    () =>
      readEnvironment({
        ...base,
        env: { BROKER_BROWSER_REGULAR_PATH: missing },
        fileExists: nothingExists,
      }),
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.equal(error.rule, 'config.value_readable');
      // Naming the variable alone is not enough: the caller has already read
      // that value once and believed it. The path it actually tried is the
      // other half of what they have to fix.
      assert.match(error.message, /BROKER_BROWSER_REGULAR_PATH/);
      assert.match(error.message, /not-installed/);
      return true;
    },
  );
});

test('the refusal says in so many words that it is not using the bundled build instead', () => {
  try {
    readEnvironment({
      ...base,
      env: { BROKER_BROWSER_PRIVATE_PATH: absolutePath('nope') },
      fileExists: nothingExists,
    });
    assert.fail('a path with no file at it must refuse');
  } catch (error) {
    assert.ok(error instanceof StartupRefusal);
    // The sentence a person reads has to rule out the thing they would
    // otherwise assume happened.
    assert.match(error.message, /bundled Chromium/);
    assert.match(error.message, /"private"/);
  }
});

test('a path that exists but is a directory rather than a file refuses', () => {
  // `fileExists` is `statSync(...).isFile()` in the real implementation, so a
  // directory answers false here — the same refusal, and the test states the
  // case so the intent survives a change of implementation.
  assert.throws(
    () =>
      readEnvironment({
        ...base,
        env: { BROKER_BROWSER_REGULAR_PATH: absolutePath('opt', 'a-directory') },
        fileExists: (candidate) => !candidate.endsWith('a-directory'),
      }),
    StartupRefusal,
  );
});

test('a blank path refuses rather than reading as unset', () => {
  // Somebody wrote the variable and meant something by it, and no binary is
  // the one thing it cannot mean. Reading it as unset would silently run the
  // bundled build.
  assert.throws(
    () =>
      readEnvironment({
        ...base,
        env: { BROKER_BROWSER_REGULAR_PATH: '   ' },
        fileExists: anythingExists,
      }),
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.match(error.message, /BROKER_BROWSER_REGULAR_PATH/);
      return true;
    },
  );
});

test('a path containing a null byte refuses, naming the variable', () => {
  assert.throws(
    () =>
      readEnvironment({
        ...base,
        env: { BROKER_BROWSER_REGULAR_PATH: `browser${String.fromCharCode(0)}x` },
        fileExists: anythingExists,
      }),
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.match(error.message, /BROKER_BROWSER_REGULAR_PATH/);
      return true;
    },
  );
});

test('a variable naming a browser nothing configured is ignored, not refused', () => {
  // §6.3: a process cannot tell an unrecognised variable of its own from any
  // other variable in an environment it shares with the whole machine. A
  // leftover from a renamed browser is not a reason to refuse to start — and
  // it must not be validated either, or removing a browser from the list
  // would start failing on a stale value.
  const environment = readEnvironment({
    ...base,
    env: { BROKER_BROWSER_NOTCONFIGURED_PATH: absolutePath('nowhere') },
    fileExists: nothingExists,
  });

  assert.equal(environment.browserPaths.size, 0);
});

test('.env.example documents the family with a placeholder, never a real machine path', () => {
  // The registry rule (§1.10) applies to this family as much as to the fixed
  // keys, and the hygiene gate refuses a literal machine path in the tree —
  // rightly, since one would name somebody's installation in a public repo.
  const registry = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', '.env.example'),
    'utf8',
  );

  assert.match(registry, /^#\s*BROKER_BROWSER_REGULAR_PATH=/m);
  assert.match(registry, /^#\s*BROKER_BROWSER_PRIVATE_PATH=/m);
  assert.match(registry, /Default: unset/m);
});
