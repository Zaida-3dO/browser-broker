import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compareVersions,
  LAST_BROWSER_FILE,
  LAST_VERSION_FILE,
  profileCompatibility,
  readLastBrowser,
  readLastVersion,
} from '../../src/browser/profile-marker.ts';

/**
 * ── What these tests are guarding, and why the fixtures are written as bytes ──
 *
 * Chromium writes `Last Browser` as **UTF-16LE with no byte-order mark**. A
 * decode that assumes UTF-8 does not throw and does not look broken: it
 * returns the path with a NUL between every character, which compares unequal
 * to every real path. The guard built on it would refuse **every** correctly
 * configured launch while appearing to work.
 *
 * That makes the fixture the load-bearing part of this file. Writing the
 * expected path with `fs.writeFileSync(file, text)` would produce an ASCII
 * file, and an ASCII file decodes identically under either encoding — so the
 * test would pass with the bug present and prove nothing. Every fixture below
 * is therefore written as genuine UTF-16LE bytes, which is what makes
 * switching the decode back to `'utf8'` turn these red.
 *
 * Nothing here launches a browser or touches a real profile. A profile
 * directory is a directory with two small files in it, so these are temporary
 * directories of the test's own.
 */

function temporaryProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'broker-marker-'));
}

/** Write `Last Browser` the way Chromium does: UTF-16LE, no byte-order mark. */
function writeLastBrowser(profile: string, value: string): void {
  fs.writeFileSync(path.join(profile, LAST_BROWSER_FILE), Buffer.from(value, 'utf16le'));
}

function writeLastVersion(profile: string, value: string): void {
  fs.writeFileSync(path.join(profile, LAST_VERSION_FILE), value, 'utf8');
}

// ── The encoding (the item's AC5) ───────────────────────────────────────

// The mutation this catches: decoding `Last Browser` as 'utf8'. Under that
// change the returned string carries a NUL between every character, so the
// equality below fails — and, more importantly, so does every real path
// comparison in `profileCompatibility`.
test('`Last Browser` is decoded as UTF-16LE, which is what Chromium writes', () => {
  const profile = temporaryProfile();
  const binary = path.join(profile, 'Application', 'browser.exe');
  writeLastBrowser(profile, binary);

  assert.equal(readLastBrowser(profile), binary);
});

// A second, blunter statement of the same property: the decoded value must
// contain no NUL at all. This is what a UTF-8 decode of UTF-16LE bytes
// actually produces, and asserting its absence names the failure directly
// rather than only by inequality.
test('a UTF-8 decode of the marker would carry interleaved NULs — the decoded value has none', () => {
  const profile = temporaryProfile();
  writeLastBrowser(profile, path.join(profile, 'browser.exe'));

  const decoded = readLastBrowser(profile);
  assert.ok(decoded !== undefined);
  assert.ok(!decoded.includes('\0'), 'the decoded marker must not contain a NUL byte');
  // And it must not merely be non-empty: the naive decode is non-empty too.
  assert.ok(decoded.endsWith('browser.exe'));
});

test('an odd-length marker is reported as absent rather than decoded to half a path', () => {
  const profile = temporaryProfile();
  // Three bytes cannot be UTF-16LE. Decoding anyway would silently drop the
  // last byte and produce a plausible-looking path, which is worse than
  // reporting nothing.
  fs.writeFileSync(path.join(profile, LAST_BROWSER_FILE), Buffer.from([0x41, 0x00, 0x42]));

  assert.equal(readLastBrowser(profile), undefined);
});

test('a profile with no markers reports both as absent', () => {
  const profile = temporaryProfile();
  assert.equal(readLastBrowser(profile), undefined);
  assert.equal(readLastVersion(profile), undefined);
});

test('a version that is not dotted digits is reported as absent rather than guessed at', () => {
  const profile = temporaryProfile();
  writeLastVersion(profile, 'not-a-version');
  assert.equal(readLastVersion(profile), undefined);
});

// ── Version comparison ──────────────────────────────────────────────────

// The mutation this catches: comparing versions as strings, or through
// parseFloat. Both get this pair backwards — '98' sorts after '151' as a
// string, and parseFloat reads `151.0.7922.34` as 151.
test('versions compare component by component as numbers, not as strings', () => {
  assert.ok(compareVersions('151.0.7922.34', '98.0.4758.102') > 0);
  assert.ok(compareVersions('98.0.4758.102', '151.0.7922.34') < 0);
  assert.equal(compareVersions('151.0.7922.34', '151.0.7922.34'), 0);
  // A missing component is zero, so these are one version.
  assert.equal(compareVersions('151.0', '151.0.0'), 0);
});

// ── The decision table ──────────────────────────────────────────────────

const REQUEST = {
  browser: 'regular',
  profileDirectory: 'a-profile-directory',
  executablePath: path.join(path.sep, 'binaries', 'chrome'),
} as const;

// The mutation this catches: dropping the binary-path comparison, or
// inverting it. This is the cross-vendor case — the one that starts fine,
// runs fine, and reads as silently signed out.
test('a different binary than the one that wrote the profile is refused', () => {
  const outcome = profileCompatibility({
    ...REQUEST,
    platform: 'linux',
    readMarker: () => ({
      version: '151.0.7922.34',
      browserPath: path.join(path.sep, 'binaries', 'brave'),
    }),
  });

  assert.equal(outcome.ok, false);
  // The refusal has to name both binaries, because the whole of what the
  // person must fix is which one they meant.
  assert.match(outcome.detail ?? '', /brave/);
  assert.match(outcome.detail ?? '', /chrome/);
});

// The mutation this catches: allowing a downgrade, or comparing the versions
// the wrong way round.
test('an older binary opening a newer profile is refused', () => {
  const outcome = profileCompatibility({
    ...REQUEST,
    platform: 'linux',
    executableVersion: '98.0.4758.102',
    readMarker: () => ({ version: '151.0.7922.34', browserPath: REQUEST.executablePath }),
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.detail ?? '', /151\.0\.7922\.34/);
  assert.match(outcome.detail ?? '', /98\.0\.4758\.102/);
});

// The safe direction. The mutation this catches: refusing on any version
// difference rather than only on a downgrade, which would make every routine
// browser update refuse to start.
test('a newer binary on an older profile proceeds — migration is one-way and documented', () => {
  const outcome = profileCompatibility({
    ...REQUEST,
    platform: 'linux',
    executableVersion: '151.0.7922.34',
    readMarker: () => ({ version: '98.0.4758.102', browserPath: REQUEST.executablePath }),
  });

  assert.equal(outcome.ok, true);
});

// The mutation this catches: refusing when the markers are absent. That
// change would refuse **every first launch**, because a profile directory
// that has never been opened has no markers at all — a guard against the
// service working.
test('a profile with no markers proceeds — absent evidence is not evidence of danger', () => {
  const outcome = profileCompatibility({
    ...REQUEST,
    platform: 'linux',
    readMarker: () => ({ version: undefined, browserPath: undefined }),
  });

  assert.equal(outcome.ok, true);
});

test('an unknown binary version skips the version half rather than refusing', () => {
  // The ordinary case: the version of the configured binary is not portably
  // knowable without running it. The path still matches, so this proceeds.
  const outcome = profileCompatibility({
    ...REQUEST,
    platform: 'linux',
    readMarker: () => ({ version: '151.0.7922.34', browserPath: REQUEST.executablePath }),
  });

  assert.equal(outcome.ok, true);
});

test('on Windows the same binary in different letter case is one binary', () => {
  const outcome = profileCompatibility({
    browser: 'regular',
    profileDirectory: 'a-profile-directory',
    executablePath: path.join('C:', 'Binaries', 'Chrome.exe'),
    platform: 'win32',
    readMarker: () => ({
      version: undefined,
      browserPath: path.join('c:', 'binaries', 'chrome.exe'),
    }),
  });

  assert.equal(outcome.ok, true);
});

// The end-to-end shape: markers written as real bytes on disk, read by the
// real reader, driving the real decision. This is the one that would have
// caught the UTF-16LE defect even if the unit tests above had been written
// against ASCII fixtures.
test('the guard reads real on-disk markers and refuses a genuine binary swap', () => {
  const profile = temporaryProfile();
  const wrote = path.join(path.sep, 'binaries', 'brave');
  writeLastBrowser(profile, wrote);
  writeLastVersion(profile, '151.0.7922.34');

  const outcome = profileCompatibility({
    browser: 'regular',
    profileDirectory: profile,
    executablePath: path.join(path.sep, 'binaries', 'chrome'),
    platform: 'linux',
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.detail ?? '', /brave/);
});
