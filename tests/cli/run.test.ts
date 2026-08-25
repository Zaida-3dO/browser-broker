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

test('login without a service refuses for its own reason, not as an unknown word', async () => {
  // **This assertion changed shape when `login` was built, and the reason is
  // worth keeping.** It used to assert that `login` reported itself "not
  // built yet" — the honest answer while nothing implemented it. Every
  // standalone command is now implemented, so there is no owed command left
  // to point it at, and re-pointing it at a working one would have made it
  // pass for the wrong reason.
  //
  // What it asserts instead is the property that actually matters and that
  // survived the change: a command driven **without a service** refuses,
  // names why, and is not mistaken for an unknown word. For `login`
  // specifically that refusal is load-bearing rather than incidental —
  // signing in claims the browser through the service so that a person is
  // never handed a window a caller is using, and a route that opened one
  // anyway when it could not claim it would defeat the whole of §5.5.1's
  // first step.
  const result = await drive(['login'], {});
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.err.join('\n'), /Unrecognised command/);
  assert.match(result.err.join('\n'), /service\.not_built/);
  // And it says what it would have risked, rather than only that it failed.
  assert.match(result.err.join('\n'), /window/);
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

/**
 * The no-browser note is conditional, and both sides of the condition matter.
 *
 * ── Why this test injects a service, when the operations check must not ──
 *
 * `scripts/check-operations.mjs` owns the `pageDriven: false` case and owns
 * it deliberately: it injects nothing, spawns the real binaries and proves
 * that the build a person installs tells the truth. That is the stronger
 * claim and it is not duplicated here.
 *
 * What it structurally cannot reach is the other branch. This build attaches
 * no session source anywhere, so **no binary can produce `pageDriven: true`**
 * — which means a renderer that printed the note unconditionally would look
 * identical to a correct one through every spawn-based gate. That gap is not
 * hypothetical: a condition of `pageDriven !== undefined` rather than
 * `pageDriven === false` is the one planted mutation the operations check
 * cannot kill, and it is a real defect — it would tell a person no page was
 * driven on a call where one was.
 *
 * So this reaches the unreachable state the only way it can be reached, at
 * the adapter's declared seam, and asserts the note is **absent**. It is
 * paired with the negative case below so that a renderer which simply never
 * prints the note fails too — one assertion without the other is satisfied by
 * deleting the feature.
 */
async function driveWithResult(value: Readonly<Record<string, unknown>>): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['capture', '--lease-key', 'a-key', '--tab-id', 'a-tab'], {
    env: {},
    streams: { out: (l) => out.push(l), err: (l) => err.push(l) },
    service: { perform: () => Promise.resolve({ outcome: 'accepted' as const, value }) },
  });
  return { code, out, err };
}

test('a page verb that did drive a browser carries no no-browser note', async () => {
  const result = await driveWithResult({
    claimId: 'a-claim',
    tabId: 'a-tab',
    expiresAt: '2026-01-01T00:00:00.000Z',
    fullPage: false,
    pageDriven: true,
  });

  assert.equal(result.code, 0);
  const printed = result.out.join('\n');
  assert.ok(printed.includes('pageDriven: true'), printed);
  assert.ok(!printed.includes('no browser was reached'), printed);
  assert.ok(!printed.includes('was not driven'), printed);
});

test('a page verb that drove no browser says so in words', async () => {
  const result = await driveWithResult({
    claimId: 'a-claim',
    tabId: 'a-tab',
    expiresAt: '2026-01-01T00:00:00.000Z',
    fullPage: false,
    pageDriven: false,
  });

  assert.equal(result.code, 0);
  const printed = result.out.join('\n');
  assert.ok(printed.includes('no browser was reached'), printed);
  assert.ok(printed.includes('was not driven'), printed);
});
