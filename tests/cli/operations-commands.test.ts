import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { run } from '../../src/cli/index.ts';
import { COMMAND_EXIT, parseFlags } from '../../src/cli/operations-commands.ts';
import { DOCTOR_EXIT } from '../../src/doctor/checks.ts';
import { seedEvent } from '../helpers/seed.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * The three commands this row wires (`SCHEMA.md` §5.4, §5.5).
 *
 * Driven **through the dispatcher with an argument vector, in process**,
 * which is the shape the parity suite asks for and the reason the dispatcher
 * returns an exit code rather than calling out to the process.
 */

interface Captured {
  readonly out: string[];
  readonly err: string[];
}

function capture(): {
  readonly streams: { out: (l: string) => void; err: (l: string) => void };
  readonly captured: Captured;
} {
  const out: string[] = [];
  const err: string[] = [];
  return { streams: { out: (l) => out.push(l), err: (l) => err.push(l) }, captured: { out, err } };
}

/** The environment a command reads, pointed at a temporary store. */
function envFor(directory: string): NodeJS.ProcessEnv {
  return {
    BROKER_DB: path.join(directory, 'broker.db'),
    BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
    BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
  };
}

describe('broker snapshot', () => {
  it('writes the file and reports the path', async () => {
    const temp = makeTempStore();
    try {
      const target = path.join(temp.directory, 'snapshot.html');
      const { streams, captured } = capture();

      const code = await run(['snapshot', '--out', target], {
        streams,
        env: envFor(temp.directory),
      });

      assert.equal(code, COMMAND_EXIT.accepted);
      assert.equal(fs.existsSync(target), true);
      assert.ok(captured.out.some((line) => line.includes(target)));
    } finally {
      temp.remove();
    }
  });

  it('says on every run that the document does not refresh', async () => {
    // §4.1's rule protects a reader from mistaking a photograph for a window,
    // and the person most likely to make that mistake is the one who just
    // generated it. Said always, not only when something is wrong.
    const temp = makeTempStore();
    try {
      const { streams, captured } = capture();
      await run(['snapshot', '--out', path.join(temp.directory, 's.html')], {
        streams,
        env: envFor(temp.directory),
      });
      assert.ok(captured.out.some((line) => /photograph, not a window/i.test(line)));
    } finally {
      temp.remove();
    }
  });

  it('refuses with the malformed code when told nowhere to write', async () => {
    // §5.6: "malformed command" is a distinct code, because a caller can
    // retry a refusal intelligently and cannot retry a typo.
    const temp = makeTempStore();
    try {
      const { streams, captured } = capture();
      const code = await run(['snapshot'], { streams, env: envFor(temp.directory) });

      assert.equal(code, COMMAND_EXIT.malformed);
      assert.ok(captured.err.some((line) => line.includes('--out')));
      assert.deepEqual(captured.out, []);
    } finally {
      temp.remove();
    }
  });

  it('produces one machine-readable document with --json', async () => {
    const temp = makeTempStore();
    try {
      const target = path.join(temp.directory, 'snapshot.html');
      const { streams, captured } = capture();

      await run(['snapshot', '--out', target, '--json'], {
        streams,
        env: envFor(temp.directory),
      });

      assert.equal(captured.out.length, 1);
      const first = captured.out[0];
      assert.ok(first);
      const parsed = JSON.parse(first) as { path: string; at: string };
      assert.equal(parsed.path, path.resolve(target));
      assert.match(parsed.at, /^\d{4}-/);
    } finally {
      temp.remove();
    }
  });
});

// Pinned to `present: true` throughout this suite. None of these cases are
// about the automation-tool check itself — they are about the store, the
// schema, side effects and the --json shape — so what they need is a doctor
// run that evaluates every OTHER check on its merits, on any machine,
// regardless of whether a browser binary happens to be resolvable where the
// suite runs. Without this pin, a checkout with no browser fetched (a bare
// `npm ci`, exactly what continuous integration does) would fail every one
// of these on the real automation check now genuinely finding nothing — the
// correct behaviour for that check, but not what any of these cases assert
// against. The automation check's own behaviour, including exit code 11
// firing on a genuine absence, is exercised separately below.
const AUTOMATION_PRESENT = { present: true } as const;

describe('broker doctor', () => {
  it('reports every precondition and exits zero on a clean install', async () => {
    const temp = makeTempStore();
    try {
      const { streams, captured } = capture();
      const code = await run(['doctor'], {
        streams,
        env: envFor(temp.directory),
        automationProbe: AUTOMATION_PRESENT,
      });

      assert.equal(code, DOCTOR_EXIT.ok);
      const text = captured.out.join('\n');
      // Named, not counted.
      assert.match(text, /network filesystem/);
      assert.match(text, /keeper tab/);
      assert.match(text, /tab budget/);
    } finally {
      temp.remove();
    }
  });

  it('answers before anything has ever run, without creating a store', async () => {
    // The state where the answer is most useful. Breaks if the command opens
    // and steps like the others.
    const temp = makeTempStore();
    try {
      const { streams } = capture();
      const databasePath = path.join(temp.directory, 'nested', 'broker.db');

      const code = await run(['doctor'], {
        streams,
        env: {
          BROKER_DB: databasePath,
          BROKER_ARTIFACTS_ROOT: path.join(temp.directory, 'artefacts'),
          BROKER_PROFILE_ROOT: path.join(temp.directory, 'profiles'),
        },
        automationProbe: AUTOMATION_PRESENT,
      });

      assert.equal(code, DOCTOR_EXIT.ok);
      // It reports and changes nothing — including not creating the file it
      // is reporting on.
      assert.equal(fs.existsSync(databasePath), false);
    } finally {
      temp.remove();
    }
  });

  it('does not step the schema', async () => {
    // A doctor that migrated would make the store's version depend on having
    // been asked about it.
    const temp = makeTempStore();
    try {
      const { streams } = capture();
      await run(['doctor'], {
        streams,
        env: envFor(temp.directory),
        automationProbe: AUTOMATION_PRESENT,
      });
      assert.equal(fs.existsSync(path.join(temp.directory, 'broker.db')), false);
    } finally {
      temp.remove();
    }
  });

  it('does not report a fault it caused by running', async () => {
    // A real defect this test was written against, and the reason it earns a
    // case of its own rather than being folded into the one above.
    //
    // `openStore` creates the directory and the file. A doctor that opened
    // unconditionally therefore *created* an empty store at version zero and
    // then truthfully reported it as being at the wrong version — a failure
    // the command had itself produced, on an installation that was fine a
    // moment earlier, with a remedy telling the person to go and run a spawn.
    //
    // Breaks if the existence check before the open is removed: the exit code
    // becomes the store group's rather than zero.
    const temp = makeTempStore();
    try {
      const { streams, captured } = capture();

      const code = await run(['doctor'], {
        streams,
        env: envFor(temp.directory),
        automationProbe: AUTOMATION_PRESENT,
      });

      assert.equal(code, DOCTOR_EXIT.ok);
      assert.ok(
        !captured.out.some((line) => line.includes('FAIL')),
        'the doctor reported a failure on an installation nothing had run against',
      );
    } finally {
      temp.remove();
    }
  });

  it('produces one document with --json, carrying the exit code', async () => {
    const temp = makeTempStore();
    try {
      const { streams, captured } = capture();
      await run(['doctor', '--json'], {
        streams,
        env: envFor(temp.directory),
        automationProbe: AUTOMATION_PRESENT,
      });

      assert.equal(captured.out.length, 1);
      const first = captured.out[0];
      assert.ok(first);
      const parsed = JSON.parse(first) as {
        exit_code: number;
        checks: { id: string; status: string }[];
      };
      assert.equal(parsed.exit_code, DOCTOR_EXIT.ok);
      assert.ok(parsed.checks.some((check) => check.id === 'config.tab_budget_agrees'));
    } finally {
      temp.remove();
    }
  });

  it('evaluates the automation check with the real probe, so it answers rather than reading unknown always', async () => {
    // Asserts that the check evaluates to a real answer — `ok` or `failed`,
    // never `unknown` — rather than asserting which one: whether a browser
    // binary is resolvable is a fact about the environment running this
    // test, not a fact this suite should assume either way. What is under
    // test is that `runDoctorCommand()` supplies a probe at all, so this
    // check is never permanently unevaluated the way it was before the
    // call site passed one through.
    const temp = makeTempStore();
    try {
      const { streams, captured } = capture();
      const code = await run(['doctor', '--json'], { streams, env: envFor(temp.directory) });

      assert.ok(code === DOCTOR_EXIT.ok || code === DOCTOR_EXIT.automation);
      const first = captured.out[0];
      assert.ok(first);
      const parsed = JSON.parse(first) as { checks: { id: string; status: string }[] };
      const automation = parsed.checks.find((check) => check.id === 'automation.present');
      assert.ok(automation, 'the automation check is missing from the report');
      assert.notEqual(
        automation.status,
        'unknown',
        'the automation check must actually evaluate, not report unknown regardless of the environment',
      );
    } finally {
      temp.remove();
    }
  });

  it('EXITS 11 when the automation probe reports no browser resolvable — proving the code is reachable', async () => {
    // Exit code 11 is documented in `docs/ROLLOUT.md` as one of the doctor's
    // distinct failure codes. It was unreachable because nothing ever
    // supplied a probe that could report `present: false`. This drives the
    // real call site (`runDoctorCommand`), through the real `runDoctor` and
    // `exitCodeFor`, with only the automation answer stubbed — so a revert
    // of the wiring at the `runDoctorCommand` call site (passing no
    // `automationProbe` through to `runDoctor`) makes this fail, and a
    // revert of `checkAutomation`'s `present: false → failed` branch makes
    // it fail too.
    //
    // Not run through `broker doctor`'s CLI dispatch, deliberately: that
    // path always resolves the real `playwright-core` probe, and this
    // machine has a browser — exercising the failure path there would mean
    // uninstalling one, which the task rules out.
    const { runDoctorCommand } = await import('../../src/cli/operations-commands.ts');
    const { readEnvironment } = await import('../../src/config/environment.ts');
    const temp = makeTempStore();
    try {
      const environment = readEnvironment({ env: envFor(temp.directory) });
      const { streams, captured } = capture();

      const code = runDoctorCommand({
        db: undefined,
        environment,
        streams,
        json: true,
        automationProbe: {
          present: false,
          detail: 'no browser binary at the stubbed path',
        },
      });

      assert.equal(code, DOCTOR_EXIT.automation);
      assert.equal(
        code,
        11,
        'exit code 11 is the contract docs/ROLLOUT.md documents for this group',
      );

      const first = captured.out[0];
      assert.ok(first);
      const parsed = JSON.parse(first) as { checks: { id: string; status: string }[] };
      const automation = parsed.checks.find((check) => check.id === 'automation.present');
      assert.ok(automation);
      assert.equal(automation.status, 'failed');
    } finally {
      temp.remove();
    }
  });

  it('a check with nothing to examine still reports [--] and does not affect the exit code', async () => {
    // The contract this fix must not disturb: an explicit `present:
    // undefined` (nobody asked) stays `unknown` and does not fail the
    // command, even though `present: false` (asked, and the answer is no)
    // now does. Folding the two together in either direction would either
    // make exit 11 unreachable again or turn a fresh, unevaluated install
    // into a reported failure.
    const { runDoctorCommand } = await import('../../src/cli/operations-commands.ts');
    const { readEnvironment } = await import('../../src/config/environment.ts');
    const temp = makeTempStore();
    try {
      const environment = readEnvironment({ env: envFor(temp.directory) });
      const { streams, captured } = capture();

      const code = runDoctorCommand({
        db: undefined,
        environment,
        streams,
        json: true,
        automationProbe: { present: undefined },
      });

      assert.equal(code, DOCTOR_EXIT.ok);
      const first = captured.out[0];
      assert.ok(first);
      const parsed = JSON.parse(first) as { checks: { id: string; status: string }[] };
      const automation = parsed.checks.find((check) => check.id === 'automation.present');
      assert.ok(automation);
      assert.equal(automation.status, 'unknown');
    } finally {
      temp.remove();
    }
  });
});

describe('broker events', () => {
  it('reads a slice of the ledger', async () => {
    const temp = makeTempStore();
    try {
      // The store has to exist before events can be seeded into it, so the
      // command is run once to create and step it.
      const first = capture();
      await run([], { streams: first.streams, env: envFor(temp.directory) });

      const { prepareStore } = await import('../../src/store/open.ts');
      // Spread from the shared fixture rather than rebuilt field by field, so
      // a variable added to the registry reaches every store a test opens
      // instead of six literals drifting apart one rebase at a time.
      const environment = { ...temp.environment };
      const store = await prepareStore(environment);
      seedEvent(store.db, { kind: 'claim_granted', sessionId: 'session-a' });
      seedEvent(store.db, { kind: 'navigate', outcome: 'deny', guard: 'lease.required' });
      store.close();

      const { streams, captured } = capture();
      const code = await run(['events'], { streams, env: envFor(temp.directory) });

      assert.equal(code, COMMAND_EXIT.accepted);
      const text = captured.out.join('\n');
      assert.match(text, /claim_granted/);
      assert.match(text, /lease\.required/);
      assert.match(text, /Read on with --since/);
    } finally {
      temp.remove();
    }
  });

  it('filters by rule, returning that entry and not the other', async () => {
    const temp = makeTempStore();
    try {
      const first = capture();
      await run([], { streams: first.streams, env: envFor(temp.directory) });

      const { prepareStore } = await import('../../src/store/open.ts');
      const store = await prepareStore({ ...temp.environment });
      seedEvent(store.db, { kind: 'navigate', outcome: 'deny', guard: 'lease.required' });
      seedEvent(store.db, { kind: 'claim_requested', outcome: 'deny', guard: 'capacity.bounded' });
      store.close();

      const { streams, captured } = capture();
      await run(['events', '--guard', 'capacity.bounded'], {
        streams,
        env: envFor(temp.directory),
      });

      const text = captured.out.join('\n');
      assert.match(text, /capacity\.bounded/);
      assert.ok(
        !text.includes('lease.required'),
        'the filter returned an entry it should not have',
      );
    } finally {
      temp.remove();
    }
  });

  it('says so plainly when nothing matches', async () => {
    const temp = makeTempStore();
    try {
      const { streams, captured } = capture();
      const code = await run(['events'], { streams, env: envFor(temp.directory) });
      assert.equal(code, COMMAND_EXIT.accepted);
      assert.ok(captured.out.some((line) => /No ledger entries match/.test(line)));
    } finally {
      temp.remove();
    }
  });
});

describe('the argument parser', () => {
  it('reads both spellings of a named value', () => {
    assert.deepEqual(parseFlags(['--out', 'a.html']), { out: 'a.html' });
    assert.deepEqual(parseFlags(['--out=a.html']), { out: 'a.html' });
  });

  it('reads a bare flag as true', () => {
    assert.deepEqual(parseFlags(['--json']), { json: true });
  });

  it('does not swallow the next flag as a value', () => {
    assert.deepEqual(parseFlags(['--json', '--out', 'a.html']), { json: true, out: 'a.html' });
  });

  it('keeps a value that begins with a digit or a dash inside an equals form', () => {
    assert.deepEqual(parseFlags(['--since=-1']), { since: '-1' });
  });
});

describe('the exit codes', () => {
  it('are §5.6’s five, and no two share a number', () => {
    // These commands re-export the adapter's own constant rather than
    // restating it, so this asserts the numbers themselves rather than that
    // two copies agree — there is only one copy to be wrong.
    assert.equal(COMMAND_EXIT.accepted, 0);
    assert.equal(COMMAND_EXIT.unexpected, 1);
    assert.equal(COMMAND_EXIT.malformed, 2);
    assert.equal(COMMAND_EXIT.refused, 3);
    assert.equal(COMMAND_EXIT.notConfigured, 4);
    const codes = Object.values(COMMAND_EXIT);
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe('the usage text', () => {
  it('lists the commands this row builds', async () => {
    // Assembled from the command table rather than written out beside it, so
    // this asserts the entries are present rather than pinning a layout that
    // the table owns.
    const { streams, captured } = capture();
    await run(['--help'], { streams });
    const text = captured.out.join('\n');
    assert.match(text, /broker snapshot/);
    assert.match(text, /broker doctor/);
  });

  it('describes what each of them does', async () => {
    const { streams, captured } = capture();
    await run(['--help'], { streams });
    const text = captured.out.join('\n');
    assert.match(text, /operations document/i);
    assert.match(text, /every precondition/i);
  });
});

describe('help asked of a command', () => {
  /**
   * A global flag match answers every per-command request with the top-level
   * table, so the caller who asked what one command does is handed the list of
   * all of them — the one answer they already had. These pin the flag to the
   * command it was typed after.
   */

  it('describes that command rather than printing the whole table', async () => {
    const { streams, captured } = capture();
    const code = await run(['doctor', '--help'], { streams });
    const text = captured.out.join('\n');

    assert.equal(code, 0);
    assert.match(
      text,
      /^broker doctor —/m,
      'Asking a command for help must describe that command, naming it on the first line.',
    );

    // The discriminating assertion. The top-level table lists every command,
    // so a per-command help that still contained them all would be the global
    // usage wearing a different first line — which is the defect.
    assert.doesNotMatch(
      text,
      /broker snapshot/,
      'Per-command help must not list the other commands: printing the full table is exactly the behaviour of a global flag match, which is what this asserts against.',
    );
  });

  it('resolves a two-word command rather than stopping at the first word', async () => {
    // `tab replace` is the only multi-word command, so it is the one that
    // catches help matched against a single leading word.
    const { streams, captured } = capture();
    await run(['tab', 'replace', '--help'], { streams });

    assert.match(captured.out.join('\n'), /^broker tab replace —/m);
  });

  it('still prints the whole table when no command is named', async () => {
    // The global behaviour is the point of the flag when it stands alone, and
    // narrowing it to commands must not cost that.
    const { streams, captured } = capture();
    const code = await run(['--help'], { streams });

    assert.equal(code, 0);
    assert.match(captured.out.join('\n'), /broker snapshot/);
  });

  it('falls back to the whole table when the command is not one this build has', async () => {
    // An unrecognised word is not a command whose help could be printed, so
    // the list of real commands is the useful answer.
    const { streams, captured } = capture();
    await run(['nosuchcommand', '--help'], { streams });

    assert.match(captured.out.join('\n'), /broker snapshot/);
  });
});
