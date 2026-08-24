import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDiffsArguments, runDiffs } from '../../src/cli/diffs.ts';
import { DEFAULT_DIFF_SETTINGS } from '../../src/diff/settings.ts';
import { insertComparison } from '../../src/service/comparison-store.ts';
import { runComparison } from '../../src/service/comparison.ts';
import { prepareStore } from '../../src/store/open.ts';
import {
  insertCapture,
  insertClaim,
  insertTab,
  readOnlyHandle,
  storeBackedCaptureSource,
} from '../helpers/comparison-fixtures.ts';
import { BLACK, WHITE, filled, withRectangle } from '../helpers/images.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * `broker diffs` — the read surface (`MILESTONES.md` #48).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN OF THIS FILE MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **What it means:** the command reads real rows written by real comparisons,
 * each of the three filters narrows to the right rows, and the three settings
 * that decided each output appear in the listing — which is #48's entire
 * justification: "the table's entire justification is that tuning reads it, so
 * a version with nothing reading it has a justification and no evidence".
 *
 * **What it does not mean:** that `broker diffs` is reachable from the command
 * line yet. `src/cli/index.ts` belongs to the row that fills the command
 * surface, and this milestone deliberately does not edit it — so the dispatch
 * from the noun `diffs` to `runDiffs` is one line that has not been written.
 * The command's behaviour is complete and tested; its wiring is not, and that
 * is recorded in the handoff rather than left to be discovered.
 */

interface Recorded {
  readonly lines: string[];
  readonly errors: string[];
}

function capture(): { streams: { out: (l: string) => void; err: (l: string) => void } } & Recorded {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    streams: {
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Argument parsing
// ══════════════════════════════════════════════════════════════════════════

test('no arguments means no filters', () => {
  const parsed = parseDiffsArguments([]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.query, {});
  assert.equal(parsed.json, false);
});

test('each filter maps to its own field', () => {
  // One assertion per flag rather than one call setting all three: a parse
  // that mapped every flag to the same field would pass a combined test.
  const byCapture = parseDiffsArguments(['--capture', 'c1']);
  const byTarget = parseDiffsArguments(['--target', 't1']);
  const byLease = parseDiffsArguments(['--lease', 'l1']);

  assert.deepEqual(byCapture.ok && byCapture.query, { sourceCaptureId: 'c1' });
  assert.deepEqual(byTarget.ok && byTarget.query, { targetCaptureId: 't1' });
  assert.deepEqual(byLease.ok && byLease.query, { claimId: 'l1' });
});

test('filters combine, which is what makes the surface useful', () => {
  // #48 lists three filters; the question tuning asks needs two at once.
  const parsed = parseDiffsArguments(['--lease', 'l1', '--target', 't1']);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.query, { claimId: 'l1', targetCaptureId: 't1' });
});

test('an unrecognised option refuses rather than being ignored', () => {
  // Ignoring it would run a query nobody asked for and print a result that
  // looks like an answer.
  const parsed = parseDiffsArguments(['--everything']);

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.message, /--everything/);
});

test('a filter with nothing after it refuses', () => {
  for (const flag of ['--capture', '--target', '--lease', '--limit']) {
    const parsed = parseDiffsArguments([flag]);
    assert.equal(parsed.ok, false, `${flag} with no value must refuse`);
  }
});

test('a filter followed by another flag refuses rather than eating it', () => {
  // `--capture --json` would otherwise set the capture filter to the string
  // "--json" and silently return nothing.
  const parsed = parseDiffsArguments(['--capture', '--json']);

  assert.equal(parsed.ok, false);
});

test('a limit must be a whole number of at least one', () => {
  for (const value of ['0', '-3', '2.5', 'lots']) {
    const parsed = parseDiffsArguments(['--limit', value]);
    assert.equal(parsed.ok, false, `--limit ${value} must refuse`);
  }
  const good = parseDiffsArguments(['--limit', '5']);
  assert.equal(good.ok && good.query.limit, 5);
});

// ══════════════════════════════════════════════════════════════════════════
// Listing real rows
// ══════════════════════════════════════════════════════════════════════════

interface Fixture {
  readonly location: string;
  readonly claimA: string;
  readonly claimB: string;
  readonly targetOne: string;
  readonly sourceOne: string;
}

/** Two leases, three comparisons, so the filters have something to narrow. */
async function withComparisons(fn: (fixture: Fixture) => Promise<void> | void): Promise<void> {
  const temp = makeTempStore();
  try {
    const store = await prepareStore(temp.environment);
    try {
      const source = storeBackedCaptureSource(store.db, temp.environment.artifactsRoot);
      const before = filled(300, 200, WHITE);
      const after = withRectangle(before, { x: 40, y: 40, width: 60, height: 40 }, BLACK);

      const claimA = insertClaim(store.db);
      const tabA = insertTab(store.db, claimA);
      const claimB = insertClaim(store.db);
      const tabB = insertTab(store.db, claimB);

      const run = async (claimId: string, tabId: string): Promise<[string, string]> => {
        const target = await insertCapture(store.db, {
          claimId,
          tabId,
          image: before,
          artifactsRoot: temp.environment.artifactsRoot,
        });
        const current = await insertCapture(store.db, {
          claimId,
          tabId,
          image: after,
          artifactsRoot: temp.environment.artifactsRoot,
        });
        await runComparison({
          capture: current,
          captureBytes: await source.readBytes(current),
          targetCaptureId: target.id,
          source,
          settings: DEFAULT_DIFF_SETTINGS,
          artifactsRoot: temp.environment.artifactsRoot,
          writeRow: (row) => insertComparison(store.db, row),
        });
        return [target.id, current.id];
      };

      const [targetOne, sourceOne] = await run(claimA, tabA);
      await run(claimA, tabA);
      await run(claimB, tabB);

      await fn({ location: store.location, claimA, claimB, targetOne, sourceOne });
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
}

test('with no filters it lists every comparison', async () => {
  await withComparisons((fixture) => {
    // Read through a second, read-only connection: an assertion about what
    // committed made through the writing handle cannot tell a committed row
    // from one about to roll back.
    const reader = readOnlyHandle(fixture.location);
    try {
      const recorder = capture();
      const code = runDiffs([], { db: reader, streams: recorder.streams });

      assert.equal(code, 0);
      assert.equal(recorder.errors.length, 0);
      // Three comparisons were run. Naming the number rather than asserting
      // "some output" — a listing that printed one row would otherwise pass.
      assert.ok(recorder.lines.some((line) => line === '3 comparisons.'));
    } finally {
      reader.close();
    }
  });
});

test('the lease filter narrows to that lease', async () => {
  await withComparisons((fixture) => {
    const reader = readOnlyHandle(fixture.location);
    try {
      const forA = capture();
      runDiffs(['--lease', fixture.claimA], { db: reader, streams: forA.streams });
      const forB = capture();
      runDiffs(['--lease', fixture.claimB], { db: reader, streams: forB.streams });

      // Two for the first lease, one for the second — the split the fixture
      // set up. Both halves asserted, so a filter that returned everything
      // fails on the second and one that returned nothing fails on the first.
      assert.ok(forA.lines.some((line) => line === '2 comparisons.'));
      assert.ok(forB.lines.some((line) => line === '1 comparison.'));
      // And the rows really belong to that lease.
      assert.ok(forB.lines.some((line) => line.includes(fixture.claimB)));
      assert.ok(!forB.lines.some((line) => line.includes(fixture.claimA)));
    } finally {
      reader.close();
    }
  });
});

test('the capture and target filters narrow to one comparison each', async () => {
  await withComparisons((fixture) => {
    const reader = readOnlyHandle(fixture.location);
    try {
      const bySource = capture();
      runDiffs(['--capture', fixture.sourceOne], { db: reader, streams: bySource.streams });
      const byTarget = capture();
      runDiffs(['--target', fixture.targetOne], { db: reader, streams: byTarget.streams });

      assert.ok(bySource.lines.some((line) => line === '1 comparison.'));
      assert.ok(byTarget.lines.some((line) => line === '1 comparison.'));
      // The same comparison, reached from both directions — which is what
      // proves the two filters address the two different columns rather than
      // one of them being wired to the wrong one.
      assert.ok(bySource.lines.some((line) => line.includes(fixture.targetOne)));
      assert.ok(byTarget.lines.some((line) => line.includes(fixture.sourceOne)));
    } finally {
      reader.close();
    }
  });
});

test('the listing shows the three settings that decided each output', async () => {
  await withComparisons((fixture) => {
    const reader = readOnlyHandle(fixture.location);
    try {
      const recorder = capture();
      runDiffs(['--limit', '1'], { db: reader, streams: recorder.streams });

      // **This is the line #48 exists for.** A listing showing the outcome
      // without the settings answers half the question tuning asks, and the
      // half it omits is the one that cannot be recovered afterwards.
      const settings = recorder.lines.find((line) => line.includes('settings:'));
      assert.notEqual(settings, undefined);
      assert.match(settings ?? '', /tolerance 0\.1/);
      assert.match(settings ?? '', /minimum area 64/);
      assert.match(settings ?? '', /at most 12 regions/);
    } finally {
      reader.close();
    }
  });
});

test('the limit caps the listing', async () => {
  await withComparisons((fixture) => {
    const reader = readOnlyHandle(fixture.location);
    try {
      const recorder = capture();
      runDiffs(['--limit', '2'], { db: reader, streams: recorder.streams });

      assert.ok(recorder.lines.some((line) => line === '2 comparisons.'));
    } finally {
      reader.close();
    }
  });
});

test('an empty listing says what was asked for, not merely that there was nothing', async () => {
  await withComparisons((fixture) => {
    const reader = readOnlyHandle(fixture.location);
    try {
      const recorder = capture();
      const code = runDiffs(['--lease', 'a-lease-that-never-existed'], {
        db: reader,
        streams: recorder.streams,
      });

      // Not an error: asking a question with no answer is a valid question.
      assert.equal(code, 0);
      // But it echoes the filter, because an empty listing after a mistyped
      // identifier looks identical to one after a correct identifier with no
      // diffs behind it — and the first is far more likely.
      assert.ok(recorder.lines.some((line) => line.includes('a-lease-that-never-existed')));
    } finally {
      reader.close();
    }
  });
});

test('an empty store explains why there is nothing rather than looking broken', async () => {
  const temp = makeTempStore();
  try {
    const store = await prepareStore(temp.environment);
    try {
      const recorder = capture();
      const code = runDiffs([], { db: store.db, streams: recorder.streams });

      assert.equal(code, 0);
      // A diff is an optional argument, so an empty table is the ordinary
      // state of a store nobody has asked for a diff on — and saying so is
      // what stops somebody debugging a feature that is working.
      assert.ok(recorder.lines.some((line) => line.includes('optional argument')));
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
});

test('the json form is a parseable document carrying the settings', async () => {
  await withComparisons((fixture) => {
    const reader = readOnlyHandle(fixture.location);
    try {
      const recorder = capture();
      const code = runDiffs(['--json', '--limit', '1'], { db: reader, streams: recorder.streams });

      assert.equal(code, 0);
      const parsed: unknown = JSON.parse(recorder.lines.join('\n'));
      assert.ok(Array.isArray(parsed));
      const first = parsed[0] as Record<string, unknown>;
      // The same three settings, in the machine-readable form — which is the
      // form anything doing the tuning at scale would actually read.
      assert.equal(first['colourTolerance'], 0.1);
      assert.equal(first['minimumRegionArea'], 64);
      assert.equal(first['maximumRegions'], 12);
      assert.ok(Array.isArray(first['regions']));
    } finally {
      reader.close();
    }
  });
});

test('a bad argument refuses with a non-zero code and prints the usage', async () => {
  await withComparisons((fixture) => {
    const reader = readOnlyHandle(fixture.location);
    try {
      const recorder = capture();
      const code = runDiffs(['--nonsense'], { db: reader, streams: recorder.streams });

      assert.equal(code, 2);
      assert.ok(recorder.errors.some((line) => line.includes('--nonsense')));
      // The usage goes to the error stream with it, so somebody who mistyped
      // sees what the options are without a second command.
      assert.ok(recorder.errors.some((line) => line.includes('broker diffs')));
      // And nothing was printed as though it were a result.
      assert.equal(recorder.lines.length, 0);
    } finally {
      reader.close();
    }
  });
});
