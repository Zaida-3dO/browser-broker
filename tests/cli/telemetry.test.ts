import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCapturesArguments, runCaptures } from '../../src/cli/telemetry.ts';
import { parseCommand, STANDALONE_COMMANDS } from '../../src/cli/commands.ts';
import { seedCapture, seedClaim, seedComparison, seedTab } from '../helpers/seed.ts';
import { withSteppedStore } from '../helpers/temp-store.ts';

/**
 * `broker captures` — the command surface for the rollups (`MILESTONES.md` #37).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REACHABILITY IS ASSERTED HERE, NOT DESCRIBED
 * ══════════════════════════════════════════════════════════════════════════
 *
 * This repository's most recurrent defect is a feature that is documented,
 * tested and called by nothing — five instances of it. A test file that
 * exercised {@link runCaptures} directly would reproduce it exactly: every
 * assertion would pass while `broker captures` did nothing, because the only
 * caller would be this file.
 *
 * So the first test below goes through {@link parseCommand} — the same table
 * the dispatcher and `broker --help` both read — and asserts the command is in
 * it. That is a test that **fails if the wiring is removed**, which a paragraph
 * claiming the wiring exists cannot do.
 *
 * The remaining tests drive {@link runCaptures} directly, which is the right
 * level for output and argument behaviour: the dispatcher's job is to route,
 * and routing is what the first test covers.
 */

/** A lease and a tab to hang captures on. Neither is what is under test. */
function scaffold(db: Parameters<typeof seedClaim>[0]): { claimId: string; tabId: string } {
  const claimId = seedClaim(db, { state: 'active', expiresAt: '2026-02-01T00:00:00.000Z' });
  const tabId = seedTab(db, { claimId });
  return { claimId, tabId };
}

/** Collect what a run wrote, so assertions read the output rather than a mock. */
function capture(): {
  streams: { out: (line: string) => void; err: (line: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { streams: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

describe('the command is reachable', () => {
  it('is in the command table the dispatcher and --help both read', () => {
    const parsed = parseCommand(['captures']);

    assert.equal(parsed.kind, 'standalone');
    assert.deepEqual(parsed.kind === 'standalone' ? parsed.command.words : [], ['captures']);
  });

  it('carries its options in the table, so --help documents them', () => {
    const command = STANDALONE_COMMANDS.find((entry) => entry.words.join(' ') === 'captures');

    assert.ok(command, 'broker captures is registered');
    const flags = (command.options ?? []).map((option) => option.flag);
    // Each of these is a flag `parseCapturesArguments` accepts. A flag that
    // works and is undocumented does not exist for most callers.
    for (const flag of ['--since <t>', '--until <t>', '--lease <id>', '--targets']) {
      assert.ok(flags.includes(flag), `${flag} is documented`);
    }
  });

  it('passes the arguments the parser accepts, so the table and the parser agree', () => {
    const command = STANDALONE_COMMANDS.find((entry) => entry.words.join(' ') === 'captures');
    assert.ok(command);

    for (const option of command.options ?? []) {
      // The flag as typed, with its value placeholder removed. The placeholder
      // itself decides what a plausible value looks like — `<n>` is a number
      // and everything else is an identifier — because `--limit a-value` is
      // correctly refused and would otherwise read as a wiring failure.
      const flag = option.flag.split(' ')[0] ?? '';
      const argv = option.flag.includes('<n>')
        ? [flag, '5']
        : option.flag.includes('<')
          ? [flag, 'a-value']
          : [flag];
      const parsed = parseCapturesArguments(argv);
      assert.equal(parsed.ok, true, `${flag} is accepted by the parser`);
    }
  });
});

describe('parsing the arguments', () => {
  it('refuses an unrecognised flag rather than ignoring it', () => {
    const parsed = parseCapturesArguments(['--nonsense']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.message, /Unrecognised option/);
  });

  it('refuses a value-taking flag with nothing after it', () => {
    for (const flag of ['--since', '--until', '--lease', '--capture', '--limit']) {
      const parsed = parseCapturesArguments([flag]);
      assert.equal(parsed.ok, false, `${flag} alone is refused`);
    }
  });

  it('refuses a window beside --targets rather than silently dropping it', () => {
    // The specific failure this prevents: printing a number labelled with a
    // restriction that was never applied.
    const parsed = parseCapturesArguments(['--targets', '--since', '2026-01-01T00:00:00.000Z']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.message, /takes no window/);
  });

  it('refuses a window beside --capture, and refuses the two modes together', () => {
    assert.equal(parseCapturesArguments(['--capture', 'an-id', '--lease', 'x']).ok, false);
    assert.equal(parseCapturesArguments(['--capture', 'an-id', '--targets']).ok, false);
  });

  it('reads the window into the query it will run', () => {
    const parsed = parseCapturesArguments([
      '--since',
      '2026-01-10T00:00:00.000Z',
      '--until',
      '2026-01-11T00:00:00.000Z',
      '--lease',
      'a-lease',
    ]);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.mode, 'rollup');
    assert.deepEqual(parsed.ok && parsed.mode === 'rollup' ? parsed.window : undefined, {
      since: '2026-01-10T00:00:00.000Z',
      until: '2026-01-11T00:00:00.000Z',
      claimId: 'a-lease',
    });
  });
});

describe('what it prints', () => {
  it('reports the totals and the breakdown a caller asked for', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);
      seedCapture(store.db, { claimId, tabId, tier: 'default', width: 10, height: 10, bytes: 7 });
      seedCapture(store.db, { claimId, tabId, tier: 'max', width: 10, height: 10, bytes: 700 });

      const sink = capture();
      const code = runCaptures([], { db: store.db, streams: sink.streams });

      assert.equal(code, 0);
      const text = sink.out.join('\n');
      assert.match(text, /2 captures/);
      // The distinct byte totals appear, which a rollup that lost a row could
      // not produce.
      assert.match(text, /707 bytes/);
      assert.match(text, /By tier:/);
      await Promise.resolve();
    });
  });

  it('says so plainly when the window holds nothing, rather than printing a zero table', async () => {
    await withSteppedStore(async (store) => {
      const sink = capture();
      const code = runCaptures([], { db: store.db, streams: sink.streams });

      assert.equal(code, 0);
      assert.match(sink.out.join('\n'), /No captures/);
      await Promise.resolve();
    });
  });

  it('emits one JSON document under --json, carrying the same numbers', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);
      seedCapture(store.db, { claimId, tabId, width: 10, height: 10, bytes: 42 });

      const sink = capture();
      runCaptures(['--json'], { db: store.db, streams: sink.streams });

      assert.equal(sink.out.length, 1, 'one document, not a stream of lines');
      const parsed = JSON.parse(sink.out[0] ?? '{}') as {
        total: { captures: number; bytes: number };
      };
      assert.equal(parsed.total.captures, 1);
      assert.equal(parsed.total.bytes, 42);
      await Promise.resolve();
    });
  });

  it('reports both diff directions for one capture', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);
      const subject = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });
      const other = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });

      seedComparison(store.db, { claimId, sourceCaptureId: subject, targetCaptureId: other });
      seedComparison(store.db, { claimId, sourceCaptureId: other, targetCaptureId: subject });
      seedComparison(store.db, {
        claimId,
        sourceCaptureId: other,
        targetCaptureId: subject,
        at: '2026-01-01T00:00:05.000Z',
      });

      const sink = capture();
      const code = runCaptures(['--capture', subject, '--json'], {
        db: store.db,
        streams: sink.streams,
      });

      assert.equal(code, 0);
      const parsed = JSON.parse(sink.out[0] ?? '{}') as {
        asSource: { comparisons: number };
        asTarget: { comparisons: number };
      };
      // Different numbers in the two directions, so the output cannot be right
      // by accident if the two were transposed.
      assert.equal(parsed.asSource.comparisons, 1);
      assert.equal(parsed.asTarget.comparisons, 2);
      await Promise.resolve();
    });
  });

  it('refuses with a non-zero code and prints the usage', async () => {
    await withSteppedStore(async (store) => {
      const sink = capture();
      const code = runCaptures(['--nonsense'], { db: store.db, streams: sink.streams });

      assert.notEqual(code, 0, 'a refusal is not a success');
      assert.match(sink.err.join('\n'), /Unrecognised option/);
      assert.match(sink.err.join('\n'), /broker captures/);
      assert.equal(sink.out.length, 0, 'nothing that looks like an answer on the output stream');
      await Promise.resolve();
    });
  });
});
