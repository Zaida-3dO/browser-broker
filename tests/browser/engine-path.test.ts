import assert from 'node:assert/strict';
import type { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LAST_BROWSER_FILE } from '../../src/browser/profile-marker.ts';
import { RealBrowserDriver } from '../../src/browser/real.ts';
import { StartupRefusal } from '../../src/errors.ts';

/**
 * The per-browser binary actually reaching the launch — asserted at the spawn
 * seam, not at a browser.
 *
 * ── Why this file exists rather than trusting the config test ────────────
 *
 * `tests/config/browser-path.test.ts` proves the environment *resolves* a
 * path. That is a different claim from the path *being launched*, and the two
 * came apart once already: `#executablePath()` took no browser argument and
 * fell straight through to the bundled Chromium, so a configuration could be
 * read, validated and then dropped on the floor — which is the
 * validated-but-inert shape this project deleted a whole setting over.
 *
 * So the assertion here is on the first argument handed to `spawn`. It is the
 * last point at which the answer is still this service's, and a test that
 * checked anything earlier would keep passing through exactly the regression
 * it exists to catch.
 *
 * **Nothing here starts a browser.** The spawn seam is injected, which is
 * both the safe choice and the strong one: a real launch would prove the
 * arguments were *acceptable*, whereas the recorded argument proves they were
 * *right*. It also means these tests cannot leak a browser process, which is
 * a defect this repository has already paid for once.
 */

interface Spawned {
  readonly executablePath: string;
}

/**
 * A spawn seam that records what it was asked to start and then behaves as a
 * browser that never opens an endpoint.
 *
 * The launch therefore always fails, and that is deliberate: the assertion is
 * on **what was asked for**, which is recorded before the failure, so the test
 * needs no browser and no endpoint. The refusal is expected and swallowed.
 */
function recordingSpawn(record: Spawned[]): typeof spawn {
  return ((executablePath: string) => {
    record.push({ executablePath });
    return { pid: 4242, once: () => undefined, unref: () => undefined };
  }) as unknown as typeof spawn;
}

function temporaryProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'broker-engine-'));
}

/** A launch bound low enough that a failing launch fails quickly. */
const FAST = { readinessTimeoutMs: 20, pollIntervalMs: 5, killImpl: () => undefined } as const;

async function attemptColdStart(
  driver: RealBrowserDriver,
  browser: string,
  profileDirectory: string,
): Promise<unknown> {
  try {
    await driver.coldStart({ browser, profileDirectory, mode: 'headless' });
    return undefined;
  } catch (error) {
    // Every launch here fails, because the fake browser opens no endpoint.
    // The failure is not what is being asserted on.
    return error;
  }
}

// ── The negative control the item asks for (its AC7) ─────────────────────

// THE MUTATION THIS CATCHES: dropping the browser argument from
// `#executablePath`, so it falls through to the bundled Chromium. That is
// precisely the state of the code before this row, and under it the recorded
// path is playwright's bundled build rather than the configured one.
test('a cold start launches the binary configured for THAT browser', async () => {
  const spawned: Spawned[] = [];
  const configured = path.join(path.sep, 'opt', 'private-browser', 'browser');
  const driver = new RealBrowserDriver({
    executablePathFor: (browser) => (browser === 'private' ? configured : undefined),
    launch: { ...FAST, spawnImpl: recordingSpawn(spawned) },
  });

  await attemptColdStart(driver, 'private', temporaryProfile());

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.executablePath, configured);
});

// The same property from the other side: the browser that was NOT configured
// must not be handed the other one's binary. A per-process path — the shape
// the driver had — passes the test above and fails this one.
test('two browsers with different binaries each launch their own', async () => {
  const spawned: Spawned[] = [];
  const regular = path.join(path.sep, 'opt', 'regular-browser', 'browser');
  const private_ = path.join(path.sep, 'opt', 'private-browser', 'browser');
  const driver = new RealBrowserDriver({
    executablePathFor: (browser) =>
      browser === 'regular' ? regular : browser === 'private' ? private_ : undefined,
    launch: { ...FAST, spawnImpl: recordingSpawn(spawned) },
  });

  await attemptColdStart(driver, 'regular', temporaryProfile());
  await attemptColdStart(driver, 'private', temporaryProfile());

  assert.equal(spawned[0]?.executablePath, regular);
  assert.equal(spawned[1]?.executablePath, private_);
  assert.notEqual(spawned[0]?.executablePath, spawned[1]?.executablePath);
});

test('a browser with no configured binary falls back to the flat injected one', async () => {
  const spawned: Spawned[] = [];
  const fallback = path.join(path.sep, 'opt', 'bundled', 'browser');
  const driver = new RealBrowserDriver({
    executablePath: fallback,
    executablePathFor: () => undefined,
    launch: { ...FAST, spawnImpl: recordingSpawn(spawned) },
  });

  await attemptColdStart(driver, 'regular', temporaryProfile());

  assert.equal(spawned[0]?.executablePath, fallback);
});

// ── The profile guard refuses BEFORE the spawn (the item's AC4 and AC6) ──

// THE MUTATION THIS CATCHES: moving the `profileCompatibility` check after
// `coldStartDetached`, or deleting it. Either way a browser process is
// started against a profile it may corrupt — and the assertion that the
// recorder stayed empty is the only thing that can tell "refused" from
// "started and then refused".
test('a binary swap is refused before anything is spawned', async () => {
  const spawned: Spawned[] = [];
  const profile = temporaryProfile();
  // Chromium's own marker, written the way Chromium writes it: UTF-16LE.
  fs.writeFileSync(
    path.join(profile, LAST_BROWSER_FILE),
    Buffer.from(path.join(path.sep, 'opt', 'brave', 'brave'), 'utf16le'),
  );

  const driver = new RealBrowserDriver({
    executablePathFor: () => path.join(path.sep, 'opt', 'chrome', 'chrome'),
    launch: { ...FAST, spawnImpl: recordingSpawn(spawned) },
  });

  const error = await attemptColdStart(driver, 'regular', profile);

  assert.ok(error instanceof StartupRefusal);
  assert.match(error.message, /brave/);
  // The whole point: nothing was started, so there is no orphaned browser and
  // no readiness timeout was spent.
  assert.equal(spawned.length, 0, 'the spawn seam must never have been called');
});

test('a profile with no marker is spawned against — a first launch is not refused', async () => {
  const spawned: Spawned[] = [];
  const driver = new RealBrowserDriver({
    executablePathFor: () => path.join(path.sep, 'opt', 'chrome', 'chrome'),
    launch: { ...FAST, spawnImpl: recordingSpawn(spawned) },
  });

  await attemptColdStart(driver, 'regular', temporaryProfile());

  // A guard that refused on absent evidence would refuse every first launch.
  assert.equal(spawned.length, 1);
});

test('the same binary reopening its own profile is spawned against', async () => {
  const spawned: Spawned[] = [];
  const profile = temporaryProfile();
  const binary = path.join(path.sep, 'opt', 'chrome', 'chrome');
  fs.writeFileSync(path.join(profile, LAST_BROWSER_FILE), Buffer.from(binary, 'utf16le'));

  const driver = new RealBrowserDriver({
    executablePathFor: () => binary,
    launch: { ...FAST, spawnImpl: recordingSpawn(spawned) },
  });

  await attemptColdStart(driver, 'regular', profile);

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.executablePath, binary);
});
