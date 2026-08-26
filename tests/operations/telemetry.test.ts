import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAXIMUM_ESCALATION_REASONS,
  readCaptureDiffActivity,
  readCaptureRollup,
  readMostDiffedTargets,
} from '../../src/operations/telemetry.ts';
import { estimateTokens } from '../../src/capture/tiers.ts';
import { seedCapture, seedClaim, seedComparison, seedTab } from '../helpers/seed.ts';
import { withSteppedStore } from '../helpers/temp-store.ts';

/**
 * The capture telemetry rollups (`MILESTONES.md` #37, `SCHEMA.md` §1.7, §1.9).
 *
 * ── Every fixture is built so a wrong answer is a *different* answer ────
 *
 * This is the discipline these tests are written to, and it is worth stating
 * because the failure it guards against is the one this repository keeps
 * meeting: **a fixture where correct and incorrect behaviour coincide.** A
 * rollup over one row, or over three rows that all cost the same, passes
 * whether or not the grouping works — the assertion is true by arithmetic
 * rather than by the code being right.
 *
 * So, concretely, throughout this file:
 *
 * - **Every group has a different size.** Sizes are chosen so that any
 *   mis-grouping — swapping two tiers, folding a kind into another, counting a
 *   row twice — lands on a number no correct grouping produces. Two tiers each
 *   costing 1000 bytes would make a swap invisible.
 * - **Group counts differ too**, so a rollup that grouped by the wrong column
 *   entirely cannot accidentally produce the right shape.
 * - **A row sits exactly on every window boundary**, because an off-by-one
 *   there is the classic miss and it is invisible unless something is standing
 *   on the line.
 * - **The two diff directions use different counts**, so a reader that
 *   answered the source question with the target index would return a number
 *   that is visibly not the one asked for.
 */

/** A lease and a tab to hang captures on. Neither is what is under test. */
function scaffold(db: Parameters<typeof seedClaim>[0]): { claimId: string; tabId: string } {
  const claimId = seedClaim(db, { state: 'active', expiresAt: '2026-02-01T00:00:00.000Z' });
  const tabId = seedTab(db, { claimId });
  return { claimId, tabId };
}

describe('what captures cost', () => {
  it('totals volume, bytes and estimated tokens across every capture', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);

      // Three distinct sizes, so the total is a number no pair of them
      // reaches and no single one does either.
      seedCapture(store.db, { claimId, tabId, width: 100, height: 100, bytes: 11 });
      seedCapture(store.db, { claimId, tabId, width: 200, height: 200, bytes: 220 });
      seedCapture(store.db, { claimId, tabId, width: 400, height: 400, bytes: 4400 });

      const rollup = readCaptureRollup(store.db);

      assert.equal(rollup.total.captures, 3);
      assert.equal(rollup.total.bytes, 11 + 220 + 4400);
      // Summed per row, because the estimate is a per-picture ceiling. Written
      // as the three calls rather than as a literal so this asserts the
      // formula the capture path uses rather than a number copied from a run.
      assert.equal(
        rollup.total.estimatedTokens,
        estimateTokens(100, 100) + estimateTokens(200, 200) + estimateTokens(400, 400),
      );
      await Promise.resolve();
    });
  });

  it('groups by tier, and the tiers do not borrow each other’s numbers', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);

      // One `default`, two `detail`, three `max` — different counts *and*
      // different byte totals per tier, so neither a swapped label nor a
      // miscounted row can produce a correct-looking answer.
      seedCapture(store.db, { claimId, tabId, tier: 'default', width: 10, height: 10, bytes: 1 });
      seedCapture(store.db, { claimId, tabId, tier: 'detail', width: 20, height: 20, bytes: 20 });
      seedCapture(store.db, { claimId, tabId, tier: 'detail', width: 20, height: 20, bytes: 20 });
      for (let n = 0; n < 3; n += 1) {
        seedCapture(store.db, { claimId, tabId, tier: 'max', width: 30, height: 30, bytes: 300 });
      }

      const rollup = readCaptureRollup(store.db);
      const byTier = new Map(rollup.byTier.map((group) => [group.group, group]));

      assert.deepEqual(
        [...byTier.keys()].sort(),
        ['default', 'detail', 'max'],
        'every tier present appears, and no tier that is absent',
      );
      assert.equal(byTier.get('default')?.captures, 1);
      assert.equal(byTier.get('default')?.bytes, 1);
      assert.equal(byTier.get('detail')?.captures, 2);
      assert.equal(byTier.get('detail')?.bytes, 40);
      assert.equal(byTier.get('max')?.captures, 3);
      assert.equal(byTier.get('max')?.bytes, 900);

      // The breakdown adds back up to the total, which is computed by a
      // separate query — so this catches a grouping that drops or duplicates
      // a row even when each individual group looks plausible.
      assert.equal(
        rollup.byTier.reduce((sum, group) => sum + group.captures, 0),
        rollup.total.captures,
      );
      await Promise.resolve();
    });
  });

  it('groups by kind independently of tier, so neither column stands in for the other', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);

      // Tier and kind deliberately cross-cut: the `max` rows are two
      // different kinds, and the `full_page` rows are two different tiers.
      // A reader that grouped by the wrong column would produce a split that
      // matches neither expectation below.
      seedCapture(store.db, {
        claimId,
        tabId,
        tier: 'max',
        kind: 'viewport',
        width: 10,
        height: 10,
        bytes: 5,
      });
      seedCapture(store.db, {
        claimId,
        tabId,
        tier: 'max',
        kind: 'full_page',
        width: 10,
        height: 10,
        bytes: 50,
      });
      seedCapture(store.db, {
        claimId,
        tabId,
        tier: 'default',
        kind: 'full_page',
        width: 10,
        height: 10,
        bytes: 500,
      });

      const rollup = readCaptureRollup(store.db);
      const byKind = new Map(rollup.byKind.map((group) => [group.group, group]));
      const byTier = new Map(rollup.byTier.map((group) => [group.group, group]));

      assert.equal(byKind.get('viewport')?.captures, 1);
      assert.equal(byKind.get('viewport')?.bytes, 5);
      assert.equal(byKind.get('full_page')?.captures, 2);
      assert.equal(byKind.get('full_page')?.bytes, 550);
      assert.equal(byKind.get('element'), undefined, 'a kind with no captures is omitted');

      assert.equal(byTier.get('max')?.captures, 2);
      assert.equal(byTier.get('max')?.bytes, 55);
      assert.equal(byTier.get('default')?.captures, 1);
      assert.equal(byTier.get('default')?.bytes, 500);
      await Promise.resolve();
    });
  });

  it('counts a capture as downscaled only when the written size differs from the source', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);

      // Same written dimensions on all three, so `downscaled` cannot be read
      // off the size — only off the comparison with the source pair.
      seedCapture(store.db, { claimId, tabId, width: 400, height: 300 });
      seedCapture(store.db, {
        claimId,
        tabId,
        width: 400,
        height: 300,
        sourceWidth: 800,
        sourceHeight: 600,
      });
      seedCapture(store.db, {
        claimId,
        tabId,
        width: 400,
        height: 300,
        sourceWidth: 400,
        // Height alone differs: a check that compared only widths would miss this.
        sourceHeight: 900,
      });

      const rollup = readCaptureRollup(store.db);
      assert.equal(rollup.total.captures, 3);
      assert.equal(rollup.total.downscaled, 2);
      await Promise.resolve();
    });
  });

  it('counts the accounting warning separately from everything else', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);

      // Three captures, one warned — and the warned one is *not* the
      // downscaled one, so a reader that conflated the two flags would report
      // the wrong count for both.
      seedCapture(store.db, { claimId, tabId, width: 10, height: 10, warned: true });
      seedCapture(store.db, {
        claimId,
        tabId,
        width: 10,
        height: 10,
        sourceWidth: 20,
        sourceHeight: 20,
      });
      seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });

      const rollup = readCaptureRollup(store.db);
      assert.equal(rollup.total.warned, 1);
      assert.equal(rollup.total.downscaled, 1);
      await Promise.resolve();
    });
  });
});

describe('the window a rollup is computed over', () => {
  /**
   * The boundary case, on its own, because it is the classic miss.
   *
   * A capture sits **exactly** on each edge. §1.7's window is half-open —
   * `since` includes its instant, `until` excludes it — so the row on `since`
   * is in and the row on `until` is out. Both `>` on the lower edge and `<=`
   * on the upper edge are single-character mistakes, and each changes exactly
   * one of the two assertions below.
   */
  it('includes a capture exactly on --since and excludes one exactly on --until', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);

      const before = seedCapture(store.db, {
        claimId,
        tabId,
        takenAt: '2026-01-09T23:59:59.999Z',
        width: 10,
        height: 10,
        bytes: 1,
      });
      const onSince = seedCapture(store.db, {
        claimId,
        tabId,
        takenAt: '2026-01-10T00:00:00.000Z',
        width: 10,
        height: 10,
        bytes: 20,
      });
      const inside = seedCapture(store.db, {
        claimId,
        tabId,
        takenAt: '2026-01-10T12:00:00.000Z',
        width: 10,
        height: 10,
        bytes: 300,
      });
      const onUntil = seedCapture(store.db, {
        claimId,
        tabId,
        takenAt: '2026-01-11T00:00:00.000Z',
        width: 10,
        height: 10,
        bytes: 4000,
      });

      // Every capture has a distinct byte count, so the total names exactly
      // which rows came back — a count of two would be satisfied by several
      // wrong pairs, and this is not.
      const rollup = readCaptureRollup(store.db, {
        since: '2026-01-10T00:00:00.000Z',
        until: '2026-01-11T00:00:00.000Z',
      });

      assert.equal(rollup.total.captures, 2);
      assert.equal(
        rollup.total.bytes,
        20 + 300,
        'the row on --since is in, the row on --until is out',
      );
      assert.notEqual(before, onSince);
      assert.notEqual(inside, onUntil);
      await Promise.resolve();
    });
  });

  it('partitions rather than double-counting when two windows share a boundary', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);

      for (const [takenAt, bytes] of [
        ['2026-01-10T00:00:00.000Z', 1],
        ['2026-01-10T23:59:59.999Z', 20],
        ['2026-01-11T00:00:00.000Z', 300],
        ['2026-01-11T06:00:00.000Z', 4000],
      ] as const) {
        seedCapture(store.db, { claimId, tabId, takenAt, width: 10, height: 10, bytes });
      }

      const first = readCaptureRollup(store.db, {
        since: '2026-01-10T00:00:00.000Z',
        until: '2026-01-11T00:00:00.000Z',
      });
      const second = readCaptureRollup(store.db, {
        since: '2026-01-11T00:00:00.000Z',
        until: '2026-01-12T00:00:00.000Z',
      });
      const whole = readCaptureRollup(store.db);

      assert.equal(first.total.bytes, 21);
      assert.equal(second.total.bytes, 4300);
      // The property that matters: adjacent windows add up to the lot, with
      // nothing counted twice and nothing dropped between them.
      assert.equal(first.total.captures + second.total.captures, whole.total.captures);
      assert.equal(first.total.bytes + second.total.bytes, whole.total.bytes);
      await Promise.resolve();
    });
  });

  it('narrows to one lease without narrowing the window', async () => {
    await withSteppedStore(async (store) => {
      const mine = scaffold(store.db);
      const theirs = scaffold(store.db);

      seedCapture(store.db, { ...mine, width: 10, height: 10, bytes: 7 });
      seedCapture(store.db, { ...theirs, width: 10, height: 10, bytes: 70 });
      seedCapture(store.db, { ...theirs, width: 10, height: 10, bytes: 700 });

      const rollup = readCaptureRollup(store.db, { claimId: mine.claimId });
      assert.equal(rollup.total.captures, 1);
      assert.equal(rollup.total.bytes, 7, 'the other lease’s captures are not in this number');
      await Promise.resolve();
    });
  });
});

describe('why callers escalated', () => {
  it('returns the written reasons as written, most recent first', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);

      seedCapture(store.db, {
        claimId,
        tabId,
        tier: 'max',
        reason: 'the earlier one',
        takenAt: '2026-01-01T00:00:00.000Z',
        width: 10,
        height: 10,
      });
      seedCapture(store.db, {
        claimId,
        tabId,
        tier: 'max',
        reason: 'the later one',
        takenAt: '2026-01-02T00:00:00.000Z',
        width: 10,
        height: 10,
      });
      // A `default` capture carries no reason and must not appear.
      seedCapture(store.db, { claimId, tabId, tier: 'default', width: 10, height: 10 });

      const rollup = readCaptureRollup(store.db);

      assert.deepEqual(
        rollup.escalationReasons.map((entry) => entry.reason),
        ['the later one', 'the earlier one'],
      );
      await Promise.resolve();
    });
  });

  it('bounds the reasons it returns, because the table grows without limit', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);

      const total = MAXIMUM_ESCALATION_REASONS + 5;
      for (let n = 0; n < total; n += 1) {
        seedCapture(store.db, {
          claimId,
          tabId,
          tier: 'max',
          reason: `escalation ${String(n)}`,
          takenAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
          width: 10,
          height: 10,
        });
      }

      const rollup = readCaptureRollup(store.db);

      assert.equal(rollup.escalationReasons.length, MAXIMUM_ESCALATION_REASONS);
      // The counts stay whole even though the list is cut: a bound on a
      // listing is not a bound on the arithmetic.
      assert.equal(rollup.total.captures, total);
      await Promise.resolve();
    });
  });
});

describe('what diffs did', () => {
  it('separates diffs run FROM a capture from diffs run AGAINST it', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);
      const subject = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });
      const other = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });
      const third = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });

      // One diff from the subject; two against it. The counts differ on
      // purpose: a reader that answered one direction with the other index
      // would return 2 where 1 is correct, and the assertion would catch it.
      seedComparison(store.db, {
        claimId,
        sourceCaptureId: subject,
        targetCaptureId: other,
      });
      seedComparison(store.db, {
        claimId,
        sourceCaptureId: other,
        targetCaptureId: subject,
      });
      seedComparison(store.db, {
        claimId,
        sourceCaptureId: third,
        targetCaptureId: subject,
      });

      const activity = readCaptureDiffActivity(store.db, subject);

      assert.equal(activity.asSource.comparisons, 1);
      assert.equal(activity.asTarget.comparisons, 2);
      await Promise.resolve();
    });
  });

  it('counts what changed and what was truncated, which are different questions', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);
      const subject = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });
      const other = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });

      // Five diffs, and the two counts are deliberately **different** (three
      // changed, two truncated). An earlier version of this fixture used four
      // rows split two-and-two, and a mutant that counted `changed` where it
      // should count `truncated` survived it: both assertions read 2, so the
      // wrong column gave the right number. The counts must not coincide.
      const flags = [
        { changed: true, truncated: false },
        { changed: true, truncated: true },
        { changed: true, truncated: false },
        { changed: false, truncated: true },
        { changed: false, truncated: false },
      ];
      for (const flag of flags) {
        seedComparison(store.db, {
          claimId,
          sourceCaptureId: subject,
          targetCaptureId: other,
          ...flag,
        });
      }

      const activity = readCaptureDiffActivity(store.db, subject);

      assert.equal(activity.asSource.comparisons, 5);
      assert.equal(activity.asSource.changed, 3);
      assert.equal(
        activity.asSource.truncated,
        2,
        'a different number from `changed`, so one column cannot answer for the other',
      );
      await Promise.resolve();
    });
  });

  it('reports the three settings together, never recombined across runs', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);
      const subject = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });
      const other = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });

      // Three rows over two distinct triples, and **the tolerance is the same
      // on all three**. That is the point: a reader keyed on tolerance alone
      // would fold the two triples into one and report a single settings
      // entry. An earlier fixture varied the tolerance alongside the area,
      // which let exactly that mutant survive — the tolerance was accidentally
      // a unique key, so keying on it gave the right answer for the wrong
      // reason. The triples here differ only in the last two settings.
      seedComparison(store.db, {
        claimId,
        sourceCaptureId: subject,
        targetCaptureId: other,
        colourTolerance: 0.5,
        minimumRegionArea: 4,
        maximumRegions: 10,
        at: '2026-01-01T00:00:01.000Z',
        changed: true,
      });
      seedComparison(store.db, {
        claimId,
        sourceCaptureId: subject,
        targetCaptureId: other,
        colourTolerance: 0.5,
        minimumRegionArea: 4,
        maximumRegions: 10,
        at: '2026-01-01T00:00:02.000Z',
        changed: false,
      });
      seedComparison(store.db, {
        claimId,
        sourceCaptureId: subject,
        targetCaptureId: other,
        colourTolerance: 0.5,
        minimumRegionArea: 64,
        maximumRegions: 25,
        at: '2026-01-01T00:00:03.000Z',
        changed: true,
      });

      const activity = readCaptureDiffActivity(store.db, subject);
      const settings = activity.asSource.settings;

      assert.equal(
        settings.length,
        2,
        'two distinct triples, distinguished by the settings the tolerance does not tell apart',
      );

      const loose = settings.find((use) => use.minimumRegionArea === 64);
      const tight = settings.find((use) => use.minimumRegionArea === 4);

      assert.equal(loose?.colourTolerance, 0.5);
      assert.equal(loose?.maximumRegions, 25);
      assert.equal(loose?.comparisons, 1);
      assert.equal(tight?.colourTolerance, 0.5);
      assert.equal(tight?.maximumRegions, 10);
      assert.equal(tight?.comparisons, 2);
      assert.equal(tight?.changed, 1, 'one of the two runs at this triple found a change');
      await Promise.resolve();
    });
  });

  it('bounds each direction by the shared clamp', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);
      const subject = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });
      const other = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });

      for (let n = 0; n < 5; n += 1) {
        seedComparison(store.db, {
          claimId,
          sourceCaptureId: subject,
          targetCaptureId: other,
          at: `2026-01-01T00:00:0${String(n)}.000Z`,
        });
      }

      assert.equal(readCaptureDiffActivity(store.db, subject, 2).asSource.comparisons, 2);
      assert.equal(readCaptureDiffActivity(store.db, subject, 5).asSource.comparisons, 5);
      await Promise.resolve();
    });
  });
});

describe('which captures get diffed against', () => {
  it('ranks targets by how often they were compared to, most first', async () => {
    await withSteppedStore(async (store) => {
      const { claimId, tabId } = scaffold(store.db);
      const popular = seedCapture(store.db, {
        claimId,
        tabId,
        width: 10,
        height: 10,
        url: 'https://example.com/popular',
      });
      const occasional = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });
      const source = seedCapture(store.db, { claimId, tabId, width: 10, height: 10 });

      // Three against one, one against the other — different counts, so the
      // ordering is a real ordering rather than two equal rows in any order.
      for (let n = 0; n < 3; n += 1) {
        seedComparison(store.db, {
          claimId,
          sourceCaptureId: source,
          targetCaptureId: popular,
          changed: n === 0,
          at: `2026-01-01T00:00:0${String(n)}.000Z`,
        });
      }
      seedComparison(store.db, {
        claimId,
        sourceCaptureId: source,
        targetCaptureId: occasional,
        changed: true,
      });

      const targets = readMostDiffedTargets(store.db);

      assert.deepEqual(
        targets.map((target) => target.captureId),
        [popular, occasional],
      );
      assert.equal(targets[0]?.comparisons, 3);
      assert.equal(targets[0]?.changed, 1, 'one of the three found a change');
      assert.equal(targets[0]?.url, 'https://example.com/popular');
      assert.equal(targets[1]?.comparisons, 1);
      await Promise.resolve();
    });
  });
});
