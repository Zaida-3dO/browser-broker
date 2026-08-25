import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { run } from '../../src/cli/index.ts';
import { makeTempStore } from '../helpers/temp-store.ts';
import { sharePath } from '../helpers/paths.ts';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entryPoint = path.join(repositoryRoot, 'src', 'bin', 'broker.ts');

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

/** Drive the command line in process, with an argument vector. */
async function drive(argv: string[], env: NodeJS.ProcessEnv): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    env,
    streams: { out: (l) => out.push(l), err: (l) => err.push(l) },
  });
  return { code, out, err };
}

test('the bare invocation opens the store, steps the schema and exits zero', async () => {
  const temp = makeTempStore();
  try {
    const result = await drive([], { BROKER_DB: temp.environment.databasePath });
    assert.equal(result.code, 0);
    assert.ok(fs.existsSync(temp.environment.databasePath));
    assert.ok(result.out.some((line) => line.startsWith('schema:')));
  } finally {
    temp.remove();
  }
});

test('running twice is idempotent — every spawn runs the handshake', async () => {
  const temp = makeTempStore();
  try {
    const first = await drive([], { BROKER_DB: temp.environment.databasePath });
    const second = await drive([], { BROKER_DB: temp.environment.databasePath });
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
  } finally {
    temp.remove();
  }
});

test('the version flag prints a version and exits zero', async () => {
  const result = await drive(['--version'], {});
  assert.equal(result.code, 0);
  assert.match(result.out.join('\n'), /\d+\.\d+\.\d+/);
});

test('the help flag prints usage and exits zero', async () => {
  const result = await drive(['--help'], {});
  assert.equal(result.code, 0);
  assert.match(result.out.join('\n'), /Usage:/);
});

test('an unrecognised option is refused with a non-zero code', async () => {
  const result = await drive(['--nonsense'], {});
  assert.equal(result.code, 2);
  assert.match(result.err.join('\n'), /Unrecognised option/);
});

test('a command noun this build does not define is refused rather than guessed at', async () => {
  // The example was `init` while the command surface was empty. `init` is now
  // one of the four commands with no operation behind them (`SCHEMA.md`
  // §5.5), so it is a *defined* command that reports it is not built — a
  // different answer, and the right one. The assertion this test exists to
  // make is about a noun the build genuinely does not have, so it takes one.
  const result = await drive(['teleport'], {});
  assert.equal(result.code, 2);
  assert.match(result.err.join('\n'), /Unrecognised command/);
});

test('a command that is still owed is named, and says it is not built', async () => {
  // The other half of the change above: `login` is refused, but for its own
  // reason rather than as an unknown word. A command that silently did
  // nothing, or that reported success, would be worse than either.
  //
  // **`login` rather than `init`**, because `init` now runs the setup
  // handshake. This assertion needs a command the build genuinely does not
  // have; pointing it at one that works would make it pass for the wrong
  // reason and stop testing anything.
  const result = await drive(['login'], {});
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.err.join('\n'), /Unrecognised command/);
  assert.match(result.err.join('\n'), /not built yet/);
});

test('a refusal exits non-zero and names the rule on the error stream', async () => {
  const result = await drive([], { BROKER_DB: '' });
  assert.equal(result.code, 1);
  assert.match(result.err.join('\n'), /config\.value_readable/);
  assert.match(result.err.join('\n'), /BROKER_DB/);
});

test('a network store location refuses the spawn', async () => {
  const result = await drive([], { BROKER_DB: sharePath('host', 'share', 'broker.db') });
  assert.equal(result.code, 1);
  assert.match(result.err.join('\n'), /store\.not_on_network_filesystem/);
});

test('the executable entry point spawns, creates the store and exits zero', async () => {
  // The one spawned test, and the seed of the clean-checkout install-and-run
  // row: a real process, with only the store location set, proving the wiring
  // rather than the logic.
  const temp = makeTempStore();
  try {
    const { stdout } = await execFileAsync(process.execPath, [entryPoint], {
      env: { ...process.env, BROKER_DB: temp.environment.databasePath },
    });
    assert.ok(fs.existsSync(temp.environment.databasePath));
    assert.match(stdout, /schema:/);
  } finally {
    temp.remove();
  }
});
