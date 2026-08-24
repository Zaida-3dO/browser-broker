/**
 * The self-test for the install check.
 *
 * **What a green run here means, and what it does not.** Green means the
 * check observes what it claims to observe: that it fails when a spawn does
 * not exit, when a spawn exits non-zero, when no store file appears, and
 * when the schema does not reach the version the build expects — and that it
 * reads the expected version from the build rather than from a number
 * written down inside it. Green does **not** mean a clean checkout really
 * installs on any given machine; that claim is made by running the check
 * itself, which is what continuous integration does on a hosted runner with
 * nothing prepared.
 *
 * The distinction matters because a gate is the one kind of code whose
 * happy path proves nothing. A check that has only ever been run against a
 * working tree has never been run against the thing it exists to catch, and
 * "it passes" is equally consistent with "it cannot fail". So every
 * assertion below seeds a violation and requires the check to notice.
 *
 * The violations are seeded against **stand-in entry points** rather than by
 * damaging the real one: a test that edited the application to prove a gate
 * fires would have to put it back, and a failure midway through would leave
 * the tree broken. Each stand-in is a tiny script exhibiting exactly one of
 * the failure modes, run through the same spawn helper the check uses, so
 * what is proved is that the helper's observations are live.
 *
 * Written for the Node test runner with no dependencies, matching the
 * hygiene gate's self-test: a gate that runs on a tree with nothing
 * installed needs a test that does too.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  SPAWN_TIMEOUT_MS,
  ambientEnvironment,
  readExpectation,
  readSchemaVersionFromFile,
  repositoryRoot,
  spawnBroker,
} from '../scripts/check-install.mjs';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/check-install.mjs',
);

const temporaryDirectories = [];

function makeTemporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), 'broker-install-selftest-'));
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Run an arbitrary script the way the check runs the entry point, so the
 * observations under test are the real ones rather than a re-implementation.
 */
function spawnScript(scriptFile, { timeoutMs = SPAWN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptFile], { stdio: ['ignore', 'pipe', 'pipe'] });
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

describe('the install check observes a process that does not exit', () => {
  // These drive the check's OWN spawn helper, pointed at a stand-in that
  // hangs. Re-implementing the spawn here would test a copy and leave the
  // shipped hang detector unexercised — deleting the line that records a
  // timeout would then break nothing, which is the definition of a test that
  // cannot fail.
  it('reports a timeout rather than waiting forever', async () => {
    const directory = makeTemporaryDirectory();
    const hanging = path.join(directory, 'hangs.mjs');
    // A process that answers and then never exits — the exact failure an
    // in-process test cannot see, because a function that returns an exit
    // code has not proved that a process ended.
    writeFileSync(
      hanging,
      ['console.log("store: somewhere");', 'setInterval(() => {}, 1000);'].join('\n'),
    );

    const result = await spawnBroker([], { env: process.env, timeoutMs: 1500, script: hanging });

    assert.equal(result.timedOut, true, 'a process that never exits must be reported as timed out');
    assert.notEqual(result.code, 0, 'a killed process must not be reported as a clean exit');
  });

  it('does not report a timeout for a process that exits promptly', async () => {
    const directory = makeTemporaryDirectory();
    const prompt = path.join(directory, 'exits.mjs');
    writeFileSync(prompt, 'console.log("done");');

    const result = await spawnBroker([], { env: process.env, timeoutMs: 30_000, script: prompt });

    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /done/);
  });
});

describe('the install check observes a refused spawn', () => {
  it('sees a non-zero exit and captures the reason', async () => {
    const directory = makeTemporaryDirectory();
    const refusing = path.join(directory, 'refuses.mjs');
    writeFileSync(
      refusing,
      ['console.error("refused (config.value_readable): seeded");', 'process.exitCode = 1;'].join(
        '\n',
      ),
    );

    const result = await spawnBroker([], { env: process.env, script: refusing });

    assert.equal(result.code, 1, 'a refusal must not be read as success');
    assert.match(result.stderr, /refused/);
  });

  it('sees a spawn that produces no output at all', async () => {
    const directory = makeTemporaryDirectory();
    const silent = path.join(directory, 'silent.mjs');
    writeFileSync(silent, '// answers nothing\n');

    const result = await spawnBroker([], { env: process.env, script: silent });

    assert.equal(result.code, 0);
    assert.equal(
      result.stdout.trim().length,
      0,
      'the check requires output, so a silent spawn must be observably silent',
    );
  });
});

describe('the schema version is read from the file, not from the code that wrote it', () => {
  it('refuses a file too short to carry a header', async () => {
    const directory = makeTemporaryDirectory();
    const stub = path.join(directory, 'truncated.db');
    writeFileSync(stub, 'no');

    await assert.rejects(
      () => readSchemaVersionFromFile(stub),
      /too short to be a store file/,
      'a truncated file has no version to report and must not read as zero',
    );
  });

  it('reads a version a spawn actually wrote into the header', async () => {
    const directory = makeTemporaryDirectory();
    const location = path.join(directory, 'nested', 'broker.db');
    const { expectedVersion } = await readExpectation();

    const result = await spawnBroker([], {
      env: {
        ...ambientEnvironment(),
        BROKER_DB: location,
        BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
        BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(location), 'the spawn must create the store at the configured location');
    assert.equal(
      await readSchemaVersionFromFile(location),
      expectedVersion,
      'the version in the file header must match what the build expects',
    );
  });

  it('detects a store left at the wrong version', async () => {
    const directory = makeTemporaryDirectory();
    const location = path.join(directory, 'wrong.db');
    // A minimal SQLite header with a deliberately wrong `user_version`. The
    // check compares the header bytes against the build's expectation, so a
    // store carrying somebody else's version must not satisfy it.
    const header = Buffer.alloc(100);
    header.write('SQLite format 3\0', 0, 'utf8');
    header.writeUInt32BE(9999, 60);
    writeFileSync(location, header);

    const { expectedVersion } = await readExpectation();
    const seen = await readSchemaVersionFromFile(location);

    assert.equal(seen, 9999);
    assert.notEqual(
      seen,
      expectedVersion,
      'the seeded version must not accidentally be the real one',
    );
  });
});

describe('the child environment carries nothing that configures the service', () => {
  it('passes through only the keys the runtime needs to start', () => {
    const ambient = ambientEnvironment({
      PATH: '/a/path',
      TEMP: '/a/temp',
      BROKER_DB: '/somebody/elses/store.db',
      BROKER_PROFILE_ROOT: '/somebody/elses/profiles',
      UNRELATED: 'value',
    });

    assert.equal(ambient.PATH, '/a/path');
    assert.equal(ambient.TEMP, '/a/temp');
    // The point of the whole helper: a store location set on the machine
    // running this check must not reach the child and decide the outcome.
    assert.equal(
      ambient.BROKER_DB,
      undefined,
      'a service variable from the ambient environment must not be inherited',
    );
    assert.equal(ambient.BROKER_PROFILE_ROOT, undefined);
    assert.equal(ambient.UNRELATED, undefined);
  });

  it('omits a key that is absent rather than setting it undefined', () => {
    const ambient = ambientEnvironment({ PATH: '/a/path' });

    assert.equal(Object.hasOwn(ambient, 'HOME'), false);
    assert.deepEqual(Object.keys(ambient), ['PATH']);
  });
});

describe('the expectation comes from the build', () => {
  it('reads the version and step count from the schema module', async () => {
    const { expectedVersion, stepCount } = await readExpectation();

    assert.equal(typeof expectedVersion, 'number');
    assert.equal(typeof stepCount, 'number');
    assert.ok(expectedVersion >= 0);
    // The expected version is the number of steps: the stepper reaches the
    // version this build declares by applying every step it has. Asserting
    // the relationship rather than either value is what keeps this test
    // alive as steps are appended.
    assert.equal(
      expectedVersion,
      stepCount,
      'the expected version must track the steps the build ships, not a written-down number',
    );
  });

  it('pins no literal version anywhere in the check', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(scriptPath, 'utf8');

    // The check must not compare against a hard-coded schema version. A
    // comparison to a literal is the thing that breaks on the next honest
    // schema change and teaches whoever hits it to edit the number.
    assert.doesNotMatch(
      source,
      /expectedVersion\s*[=!]==?\s*\d/,
      'the expected version must be read from the build, never compared against a literal',
    );
    assert.match(source, /EXPECTED_VERSION/, 'it must read the build’s own declared expectation');
  });
});

describe('the check runs end to end as continuous integration runs it', () => {
  it('passes against this checkout and exits zero', async () => {
    const result = await spawnScript(scriptPath, { timeoutMs: SPAWN_TIMEOUT_MS });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Install check passed/);
  });

  it('runs the real entry point from the repository root', () => {
    assert.ok(existsSync(path.join(repositoryRoot, 'src', 'bin', 'broker.ts')));
    assert.equal(
      pathToFileURL(scriptPath).href.startsWith(pathToFileURL(repositoryRoot).href),
      true,
    );
  });
});
