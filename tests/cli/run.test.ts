import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { run } from '../../src/cli/index.ts';
import { OPERATION_COMMANDS, STANDALONE_COMMANDS } from '../../src/cli/commands.ts';
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

/* ───────────── a caller cannot use what it cannot discover ───────────── */

test('every command the dispatcher accepts is listed in the top-level help', async () => {
  // ── Why the candidates come from OUTSIDE the command table ────────────
  //
  // The obvious spelling of this test — walk the command table, require each
  // entry in the help — **cannot fail for the defect it is named after.** The
  // help is rendered *from* that table, so a command missing from the table is
  // missing from both sides and the loop simply does not check it. Measured:
  // deleting the `events` entry left this suite green.
  //
  // So the candidate words are listed here deliberately, as a second opinion
  // about what this build accepts, and each is put to the dispatcher: a word
  // it does not know is answered `Unrecognised command`. Anything it *does*
  // accept must appear in the help. The duplication is the mechanism, not an
  // oversight — a rule derived entirely from the thing under test is not a
  // rule.
  //
  // The gap this catches: `events` was implemented, reachable and working, and
  // absent from the table, so it appeared in no help output at all. Nothing
  // failed; it was undiscoverable.
  const candidates = [
    'claim',
    'status',
    'release',
    'tab replace',
    'navigate',
    'act',
    'read',
    'evaluate',
    'capture',
    'feedback',
    'snapshot',
    'doctor',
    'login',
    'init',
    'diffs',
    'image',
    'events',
  ];

  const top = (await drive(['--help'], {})).out.join('\n');

  for (const name of candidates) {
    const attempt = await drive([...name.split(' '), '--help'], {});
    const answered = attempt.err.join('\n');
    assert.doesNotMatch(
      answered,
      /Unrecognised command/,
      `this test's candidate list disagrees with the dispatcher: it expects \`${name}\` to be a command and the dispatcher does not know it`,
    );

    assert.ok(
      top.includes(`broker ${name}`),
      `\`broker ${name}\` is dispatched but missing from the top-level help, so a caller has no way to find it`,
    );
  }
});

test('a command that documents options prints each of them in its own help', async () => {
  // The options live on the command table so that this can be derived too. A
  // documented option that the renderer drops is the same defect as an
  // undocumented one — `claim --wait` worked and appeared nowhere.
  for (const command of [...OPERATION_COMMANDS, ...STANDALONE_COMMANDS]) {
    const options = command.options ?? [];
    if (options.length === 0) {
      continue;
    }
    const help = (await drive([...command.words, '--help'], {})).out.join('\n');
    for (const option of options) {
      assert.ok(
        help.includes(option.flag),
        `\`broker ${command.words.join(' ')} --help\` does not mention ${option.flag}`,
      );
    }
  }
});

test('claim documents --wait, which changes what the command does', async () => {
  // Named explicitly as well as covered by the rule above, because this one is
  // not a convenience: without it a caller has no way to learn that `claim`
  // can hold its queue place rather than returning it.
  const help = (await drive(['claim', '--help'], {})).out.join('\n');
  assert.match(help, /--wait/);
  assert.match(help, /queued place|queue place/i);
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
 * **What it cannot reach reliably is the other branch**, which is why these
 * two tests exist. `src/bin/broker.ts:103` passes `session: runtime.session`,
 * so `pageDriven: true` is reachable through a real spawn, and the
 * justification for injecting here is therefore measured rather than assumed.
 * It holds, for a reason worth writing down.
 *
 * `scripts/check-operations.mjs` asserts this spawn-side, but its assertion
 * is a **biconditional** between the prose and `pageDriven: false`.
 * The contradiction it can detect — `pageDriven: true` printed beside "no
 * browser was reached" — only exists on a run where a browser was actually
 * reached. On a run with none, a note printed unconditionally is
 * indistinguishable from a correct one, and the gate passes.
 *
 * **The faithful mutation these kill**, named as the rule requires: the
 * no-browser note rendered on `pageDriven !== undefined` instead of
 * `pageDriven === false` (`src/cli/index.ts`), which tells a person no page
 * was driven on a call where one was.
 *
 * **Measured, not reasoned:** with that mutation planted, five consecutive
 * local runs of the operations check caught it twice. And continuous
 * integration has no browser at all, so there the gate never observes the
 * branch that would expose it — it would catch this essentially never.
 *
 * These two tests kill it on every run, on every machine, which is why they
 * stay rather than being folded into the gate and deleted.
 *
 * injected-test-ok: the operations gate only observes the no-browser branch on
 * a runner without a browser, so an unconditionally printed note survives it
 * there; these reach the driven branch deterministically at the adapter seam.
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
