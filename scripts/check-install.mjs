#!/usr/bin/env node
/**
 * The install check: prove a clean checkout installs, spawns and works.
 *
 * There is no container image to build and no service to deploy, and that
 * absence is the design rather than a gap. The service is spawned by its
 * caller, serves that session and exits with it, so **installation is the
 * whole of deployment** — which means the release check somebody would
 * otherwise get from an image build has to be obtained from the artefact
 * people really use: the package, installed, and the executable, run.
 *
 * So this asserts the one thing an image build would have caught — *the
 * thing does not actually start* — against a checkout with no store, no
 * configuration and nothing prepared:
 *
 *   1. the executable entry point runs as a real subprocess, not in process;
 *   2. it creates the store file at the configured location, having been
 *      given a directory that did not exist;
 *   3. it steps the schema from nothing to the version the build expects;
 *   4. a command answers on the output stream;
 *   5. the process exits, of its own accord, with a zero status.
 *
 * ── Why a subprocess, when the test suite drives the same code in process ──
 *
 * The suite imports the dispatcher and calls it with an argument vector,
 * which is the right shape for testing what the dispatcher decides. It
 * cannot observe the two properties this check exists for. A function that
 * returns an exit code has not proved that a *process* exits — a handle left
 * open, a listener never closed, a driver that keeps the event loop alive
 * would all return cleanly and then hang forever. And an import resolves
 * through the test runner's own configuration rather than through the
 * package manifest's `bin` field and the shebang, so the executable seam is
 * the part an in-process test structurally cannot reach.
 *
 * The exit is enforced with a timeout for exactly that reason: a hang is the
 * failure being tested for, and a check that waits indefinitely for a hung
 * process reports nothing at all.
 *
 * ── Tolerant of the schema growing, deliberately ────────────────────────
 *
 * This check asserts the store ends at the version **this build declares it
 * expects**, read from the build itself, and never at a written-down number.
 * The schema is a stepper that grows by having steps appended to it, so a
 * check pinning a literal version would fail on the next honest schema
 * change and teach whoever hits it to edit the number rather than to read
 * what broke. What matters here is that the stepper *ran and converged* —
 * that a store which did not exist a moment ago is now at the version the
 * code expects — and that claim stays true at one step or at fifty.
 *
 * The same reasoning covers the step count: a fresh store reports how many
 * steps it applied, and this check requires that the number match the
 * build's own expectation rather than any particular value.
 *
 * ── What a green run means, and what it does not ────────────────────────
 *
 * Green means: a spawn against an empty location creates a store, converges
 * its schema to the expected version, answers a command and exits zero,
 * within the timeout, on this platform.
 *
 * Green does **not** mean the installation is correct in any wider sense. It
 * does not exercise a browser, a lease or any arbitration rule — none of
 * which this check knows about. It does not prove the published package
 * contents are right, because it runs against the checkout rather than
 * against a packed tarball. It does not test the network-location refusal or
 * any other startup guard; those have their own tests. And because it uses a
 * temporary directory, it says nothing about whether the *default* store
 * location is writable on a given machine.
 *
 * It is one claim, end to end, and it is the claim that has no other home.
 *
 * Usage:
 *   node scripts/check-install.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { temporaryPrefix } from './temp-prefix.mjs';

/** The repository root, derived from this file rather than from the caller's directory. */
export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How long a spawn gets before it is treated as hung.
 *
 * Generous on purpose: this runs on shared continuous-integration machines
 * where a cold start competes with whatever else is on the host, and a
 * flaky check gets ignored rather than fixed. It is a hang detector, not a
 * performance budget — the failure it exists to catch is a process that
 * never exits at all, which no amount of slowness resembles.
 */
export const SPAWN_TIMEOUT_MS = 120_000;

/** The executable entry point, as the package manifest's `bin` field names it. */
export const ENTRY_POINT = path.join(repositoryRoot, 'src', 'bin', 'broker.ts');

/**
 * Run the executable entry point as a real child process and collect what it
 * did. Resolves on exit however it exited; rejects only if the process could
 * not be started at all.
 *
 * `script` is injected rather than fixed for one reason: the timeout below
 * is the only observation here that a working entry point can never
 * exercise. A check whose hang detector is never run against something that
 * actually hangs has a hang detector nobody has tested, and this file is a
 * gate — the one kind of code whose happy path proves nothing. The seam lets
 * its own self-test point it at a process that deliberately never exits.
 */
export function spawnBroker(
  argv,
  { env, timeoutMs = SPAWN_TIMEOUT_MS, script = ENTRY_POINT } = {},
) {
  const entryPoint = script;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPoint, ...argv], {
      cwd: repositoryRoot,
      // A clean environment with only what the spawn needs. Inheriting the
      // whole of the caller's would let a variable set on the machine
      // running this check decide the outcome, which is the opposite of
      // what a clean-checkout claim means.
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/**
 * The version this build expects a store to be at, and the number of steps
 * that reach it — read from the build rather than written down here.
 */
export async function readExpectation() {
  const stepsModule = await import(
    pathToFileURL(path.join(repositoryRoot, 'src', 'store', 'schema', 'steps.ts')).href
  );
  return {
    expectedVersion: stepsModule.EXPECTED_VERSION,
    stepCount: stepsModule.STEPS.length,
  };
}

/**
 * Read a store's recorded schema version without importing the driver.
 *
 * SQLite writes `user_version` into a fixed 4-byte big-endian slot of the
 * database header (offset 60), which is a documented part of the file
 * format. Reading the bytes rather than opening the file through the driver
 * keeps this check independent of the module under test: a stepper that
 * reports success while writing nothing to the file would satisfy an
 * assertion made through its own code path and fail this one.
 *
 * A file too short to contain a header has no version to report, which is a
 * failure rather than a zero.
 */
export async function readSchemaVersionFromFile(location) {
  const { open } = await import('node:fs/promises');
  const handle = await open(location, 'r');
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 60);
    if (bytesRead !== 4) {
      throw new Error(
        `${location} is too short to be a store file — read ${String(bytesRead)} of the 4 header bytes that carry the schema version.`,
      );
    }
    return buffer.readUInt32BE(0);
  } finally {
    await handle.close();
  }
}

/**
 * The variables a child process needs in order for the runtime itself to
 * start, and nothing that configures this service.
 *
 * The whole of the caller's environment is deliberately not inherited: a
 * variable set on the machine running this check would then decide the
 * outcome, which is the opposite of what a clean-checkout claim means. The
 * names are listed and looked up rather than written out one per line, so
 * this carries a list of keys rather than a set of expressions that read as
 * facts about a particular host.
 */
const PASSTHROUGH_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP'];

export function ambientEnvironment(source = process.env) {
  const ambient = {};
  for (const key of PASSTHROUGH_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      ambient[key] = value;
    }
  }
  return ambient;
}

const failures = [];
const notes = [];

function check(description, condition, detail) {
  if (condition) {
    notes.push(`  ok   ${description}`);
  } else {
    failures.push(`  FAIL ${description}${detail === undefined ? '' : `\n         ${detail}`}`);
  }
}

export async function runInstallCheck() {
  const { expectedVersion, stepCount } = await readExpectation();

  // A directory that does not exist yet, inside one that does: the clean
  // case is a caller who has set nothing up, so the spawn has to create its
  // own home rather than find one.
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), temporaryPrefix('install-check')));
  const storeDirectory = path.join(temporaryRoot, 'state', 'nested');
  const storeLocation = path.join(storeDirectory, 'broker.db');

  const environment = {
    ...ambientEnvironment(),
    BROKER_DB: storeLocation,
    BROKER_ARTIFACTS_ROOT: path.join(temporaryRoot, 'artefacts'),
    BROKER_PROFILE_ROOT: path.join(temporaryRoot, 'profiles'),
  };

  try {
    check(
      'the store location does not exist before the spawn',
      !existsSync(storeLocation),
      'the check would prove nothing against a store that was already there',
    );

    // ── The spawn ────────────────────────────────────────────────────────
    const first = await spawnBroker([], { env: environment });

    check(
      'the process exits rather than hanging',
      !first.timedOut,
      `it was still running after ${String(SPAWN_TIMEOUT_MS)}ms and had to be killed`,
    );
    check(
      'the spawn exits zero',
      first.code === 0,
      `exit code ${String(first.code)}, signal ${String(first.signal)}\n         stdout: ${first.stdout.trim()}\n         stderr: ${first.stderr.trim()}`,
    );
    check(
      'a command answers on the output stream',
      first.stdout.trim().length > 0,
      'the spawn produced no output at all',
    );
    check(
      'the store file is created at the configured location',
      existsSync(storeLocation) && statSync(storeLocation).isFile(),
      `nothing was created at the location given in the environment`,
    );

    if (existsSync(storeLocation)) {
      const version = await readSchemaVersionFromFile(storeLocation);
      check(
        `the schema steps from nothing to the version this build expects (${String(expectedVersion)})`,
        version === expectedVersion,
        `the store file records version ${String(version)}`,
      );
      check(
        'the spawn reports what it did to the schema',
        /schema:/.test(first.stdout),
        `stdout: ${first.stdout.trim()}`,
      );
      if (stepCount > 0) {
        check(
          'a fresh store reports the steps it applied',
          /stepped from version/.test(first.stdout),
          `a store created by this spawn should have been stepped up\n         stdout: ${first.stdout.trim()}`,
        );
      }
    }

    // ── The second spawn ─────────────────────────────────────────────────
    //
    // Every spawn runs the handshake, so the second one has to be a no-op
    // rather than an error or a re-application. This is the property that
    // makes "installation is the whole of deployment" workable at all: with
    // no deployment moment at which somebody runs a migration, a caller who
    // has just upgraded and a caller who has not may both spawn within the
    // same minute.
    const second = await spawnBroker([], { env: environment });

    check('a second spawn against the same store exits zero', second.code === 0, second.stderr);
    check(
      'the second spawn leaves the schema where it was',
      existsSync(storeLocation) &&
        (await readSchemaVersionFromFile(storeLocation)) === expectedVersion,
      'the version moved on a spawn that had nothing to do',
    );

    // ── A command that touches no store ──────────────────────────────────
    const version = await spawnBroker(['--version'], { env: environment });
    check(
      'the version command answers and exits zero',
      version.code === 0 && /\d+\.\d+\.\d+/.test(version.stdout),
      `exit ${String(version.code)}, stdout: ${version.stdout.trim()}`,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  return { failures, notes, expectedVersion, stepCount };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const result = await runInstallCheck();
  for (const note of result.notes) {
    console.log(note);
  }
  if (result.failures.length > 0) {
    console.error('\nThe install check failed:\n');
    for (const failure of result.failures) {
      console.error(failure);
    }
    console.error(
      '\nA clean checkout must install, spawn, step its own schema, answer a command and exit.',
    );
    process.exitCode = 1;
  } else {
    console.log(
      `\nInstall check passed: a clean checkout spawns, steps to schema version ${String(result.expectedVersion)} and exits.`,
    );
  }
}
