import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { ArtifactStore } from '../../src/artifacts/store.ts';
import { decodePng } from '../../src/diff/image.ts';
import { DEFAULT_DIFF_SETTINGS } from '../../src/diff/settings.ts';
import { insertComparison, listComparisons } from '../../src/service/comparison-store.ts';
import { type ComparisonRow, runComparison } from '../../src/service/comparison.ts';
import type { CaptureSource } from '../../src/service/capture-seam.ts';
import { prepareStore } from '../../src/store/open.ts';
import {
  artifactExists,
  insertCapture,
  insertClaim,
  insertTab,
  readOnlyHandle,
  storeBackedCaptureSource,
} from '../helpers/comparison-fixtures.ts';
import {
  BLACK,
  GREY,
  WHITE,
  changedPairs,
  cleanPair,
  filled,
  withRectangle,
} from '../helpers/images.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * A comparison end to end (`MILESTONES.md` #40 and #42, `SCHEMA.md` §1.9).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN OF THIS FILE MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **What it means:** a comparison runs against the real schema — real foreign
 * keys, real check constraints — writes real PNG files under a real artifact
 * root, and the assertions read those files back and decode them rather than
 * asserting that a path string was returned. Every rejection asserts the
 * **physical consequence** as well as the response, which `CLAUDE.md` requires
 * of this codebase specifically: "a guard that returns 'denied' after the tab
 * has already opened is worse than no guard". Here the equivalent is a result
 * that says no diff was produced while crop files sit on disk, so the tests
 * that assert no diff also assert nothing was written.
 *
 * **What it does not mean:** that the capture pipeline works. It does not exist
 * (`src/service/capture-seam.ts`), and the rows these tests compare are written
 * by a helper that writes them the way the pipeline will. The seam is real; the
 * thing on the far side of it is not built yet.
 *
 * **Assertions about what committed go through a second, read-only
 * connection.** A read through the writing handle sees uncommitted work, so it
 * cannot tell a committed row from one about to roll back — a mistake already
 * shipped once in this repository.
 */

interface Harness {
  readonly artifacts: ArtifactStore;
  readonly source: CaptureSource;
  readonly claimId: string;
  readonly tabId: string;
  readonly writeRow: (row: ComparisonRow) => string;
  readonly location: string;
  readonly written: ComparisonRow[];
}

/** Set up a store, a lease and a tab, and tear it all down afterwards. */
async function withHarness(
  fn: (harness: Harness & { readonly rawDb: Parameters<typeof insertClaim>[0] }) => Promise<void>,
): Promise<void> {
  const temp = makeTempStore();
  try {
    const store = await prepareStore(temp.environment);
    try {
      const artifacts = new ArtifactStore(temp.environment.artifactsRoot);
      const claimId = insertClaim(store.db);
      const tabId = insertTab(store.db, claimId);
      const written: ComparisonRow[] = [];

      await fn({
        rawDb: store.db,
        artifacts,
        source: storeBackedCaptureSource(store.db, artifacts),
        claimId,
        tabId,
        written,
        location: store.location,
        writeRow: (row) => {
          written.push(row);
          return insertComparison(store.db, row);
        },
      });
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// The ordinary path: two captures, one changed region
// ══════════════════════════════════════════════════════════════════════════

test('a capture naming an earlier one gets regions, crops, an overlay and a row', async () => {
  await withHarness(async (harness) => {
    const before = filled(400, 300, WHITE);
    const after = withRectangle(before, { x: 100, y: 100, width: 80, height: 40 }, BLACK);

    const target = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: before,
      artifacts: harness.artifacts,
    });
    const current = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: after,
      artifacts: harness.artifacts,
    });

    const result = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: target.id,
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    assert.equal(result.diffed, true);
    assert.equal(result.changed, true);
    assert.equal(result.regions.length, 1);
    assert.equal(result.truncated, false);

    // The region covers where the change was drawn, named by geometry rather
    // than "a region exists".
    const region = result.regions[0];
    assert.ok(region !== undefined);
    assert.ok(region.x <= 100 && region.y <= 100);
    assert.ok(region.x + region.width >= 180 && region.y + region.height >= 140);

    // §1.9: "compared_against — the capture the caller named. Echoed back
    // rather than assumed, so a caller that passed the wrong identifier can
    // see that it did."
    assert.equal(result.comparedAgainst?.captureId, target.id);
    assert.equal(result.comparedAgainst?.path, target.path);

    // The three settings that decided the output.
    assert.deepEqual(result.settingsApplied, {
      colourTolerance: 0.1,
      minimumRegionArea: 64,
      maximumRegions: 12,
    });

    // **The files exist and decode**, which is the assertion that separates
    // "a path was returned" from "an image was written".
    assert.ok(await artifactExists(harness.artifacts, region.beforePath));
    assert.ok(await artifactExists(harness.artifacts, region.afterPath));
    assert.ok(result.overlayPath !== null);
    assert.ok(await artifactExists(harness.artifacts, result.overlayPath));
  });
});

test('both crops come from the same rectangle, and it is padded', async () => {
  await withHarness(async (harness) => {
    const before = filled(400, 300, WHITE);
    const change = { x: 100, y: 100, width: 80, height: 40 };
    const after = withRectangle(before, change, BLACK);

    const target = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: before,
      artifacts: harness.artifacts,
    });
    const current = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: after,
      artifacts: harness.artifacts,
    });

    const result = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: target.id,
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    const region = result.regions[0];
    assert.ok(region !== undefined);

    const beforeCrop = decodePng(await fs.readFile(harness.artifacts.resolve(region.beforePath)));
    const afterCrop = decodePng(await fs.readFile(harness.artifacts.resolve(region.afterPath)));

    // **From the same rectangle**, which is the property #42 names. Two crops
    // of different sizes, shown side by side, invite the reader to attribute
    // the framing difference to the change.
    assert.equal(beforeCrop.width, afterCrop.width);
    assert.equal(beforeCrop.height, afterCrop.height);

    // **With padding.** The crop is larger than the region by the padding on
    // each side — this region sits well inside the page, so nothing is
    // clamped away and the arithmetic is exact. Setting the padding to zero
    // fails this.
    assert.equal(beforeCrop.width, region.width + DEFAULT_DIFF_SETTINGS.cropPadding * 2);
    assert.equal(beforeCrop.height, region.height + DEFAULT_DIFF_SETTINGS.cropPadding * 2);

    // The two crops differ, which proves they were cut from the two different
    // images rather than the same one twice — the mistake that would produce
    // a perfectly-shaped, perfectly-useless before-and-after.
    assert.notDeepEqual(Array.from(beforeCrop.data), Array.from(afterCrop.data));
  });
});

test('a region flush against the page edge is clamped rather than overflowing', async () => {
  await withHarness(async (harness) => {
    const before = filled(400, 300, WHITE);
    // Hard against the top-left corner, where padding cannot be applied.
    const after = withRectangle(before, { x: 0, y: 0, width: 60, height: 30 }, BLACK);

    const target = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: before,
      artifacts: harness.artifacts,
    });
    const current = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: after,
      artifacts: harness.artifacts,
    });

    const result = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: target.id,
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    const region = result.regions[0];
    assert.ok(region !== undefined);
    const crop = decodePng(await fs.readFile(harness.artifacts.resolve(region.beforePath)));

    // Padding is applied on the sides where there is room and clamped where
    // there is not: no padding above or to the left, full padding below and
    // right.
    assert.equal(crop.width, region.width + DEFAULT_DIFF_SETTINGS.cropPadding);
    assert.equal(crop.height, region.height + DEFAULT_DIFF_SETTINGS.cropPadding);
  });
});

test('an unchanged pair reports changed false, and writes no crops', async () => {
  await withHarness(async (harness) => {
    const pair = cleanPair();
    const target = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: pair.earlier,
      artifacts: harness.artifacts,
    });
    const current = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: pair.current,
      artifacts: harness.artifacts,
    });

    const result = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: target.id,
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    // A comparison ran — which is the distinction that matters. `diffed` true
    // with `changed` false is "nothing moved"; `diffed` false would be "no
    // comparison happened", and collapsing them is what §1.9 spends a section
    // preventing.
    assert.equal(result.diffed, true);
    assert.equal(result.changed, false);
    assert.equal(result.changedPixels, 0);
    assert.equal(result.regions.length, 0);
    // The overlay is still written: it is the picture of where nothing was.
    assert.ok(result.overlayPath !== null);
    assert.ok(await artifactExists(harness.artifacts, result.overlayPath));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The failure mode that is the point: never a refusal
// ══════════════════════════════════════════════════════════════════════════

test('a capture identifier that does not exist returns an explanation, never a refusal', async () => {
  await withHarness(async (harness) => {
    const image = filled(400, 300, WHITE);
    const current = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image,
      artifacts: harness.artifacts,
    });

    // No throw, which is the whole assertion — §1.9: "It never refuses."
    const result = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: 'a-capture-that-was-never-taken',
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    assert.equal(result.diffed, false);
    assert.equal(result.changed, false);
    assert.notEqual(result.explanation, null);
    assert.match(result.explanation ?? '', /a-capture-that-was-never-taken/);

    // **The physical consequence.** No row was written and no file appeared —
    // a result saying "no diff" while crops sat on disk would be the same
    // class of bug as a guard that refuses after the tab has opened.
    assert.equal(harness.written.length, 0);
    assert.equal(result.comparisonId, null);
    assert.equal(result.overlayPath, null);
  });
});

test("another lease's capture is refused in the same words as one that does not exist", async () => {
  await withHarness(async (harness) => {
    const otherClaim = insertClaim(harness.rawDb);
    const otherTab = insertTab(harness.rawDb, otherClaim);
    const image = filled(400, 300, WHITE);

    const theirs = await insertCapture(harness.rawDb, {
      claimId: otherClaim,
      tabId: otherTab,
      image,
      artifacts: harness.artifacts,
    });
    const mine = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image,
      artifacts: harness.artifacts,
    });

    const theirsResult = await runComparison({
      capture: mine,
      captureBytes: await harness.source.readBytes(mine),
      targetCaptureId: theirs.id,
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    const missingResult = await runComparison({
      capture: mine,
      captureBytes: await harness.source.readBytes(mine),
      targetCaptureId: theirs.id.split('').reverse().join(''),
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    assert.equal(theirsResult.diffed, false);
    assert.equal(missingResult.diffed, false);

    // **The sentences must be identical once the identifier is removed.**
    // §1.9 and §7.1: a caller able to tell "not yours" from "does not exist"
    // is a caller able to enumerate another lease's captures by watching which
    // identifiers produce a different message.
    const shape = (message: string | null, id: string): string =>
      (message ?? '').replaceAll(id, '<id>');
    assert.equal(
      shape(theirsResult.explanation, theirs.id),
      shape(missingResult.explanation, theirs.id.split('').reverse().join('')),
    );

    // And no diff was run against a capture this lease does not own.
    assert.equal(harness.written.length, 0);
  });
});

test('a capture whose file is missing returns an explanation, not a throw', async () => {
  await withHarness(async (harness) => {
    const image = filled(400, 300, WHITE);
    const target = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image,
      artifacts: harness.artifacts,
    });
    const current = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image,
      artifacts: harness.artifacts,
    });

    // Deleted by hand. §6.2 says nothing sweeps a capture file, so this is the
    // only way it happens — and it must not take the capture down with it.
    await fs.rm(harness.artifacts.resolve(target.path));

    const result = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: target.id,
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    assert.equal(result.diffed, false);
    assert.notEqual(result.explanation, null);
    // The target is still echoed back: the caller named something real, and
    // knowing which row it was is what makes this diagnosable.
    assert.equal(result.comparedAgainst?.captureId, target.id);
    assert.equal(harness.written.length, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Geometry, through the whole path (#40)
// ══════════════════════════════════════════════════════════════════════════

test('two captures of different widths report the mismatch and produce no diff', async () => {
  await withHarness(async (harness) => {
    const target = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: filled(400, 300, WHITE),
      artifacts: harness.artifacts,
    });
    const current = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: filled(600, 300, WHITE),
      artifacts: harness.artifacts,
    });

    const result = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: target.id,
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    // Reported in the result, per #40 — not pre-empted and not thrown.
    assert.equal(result.widthMismatch, true);
    assert.equal(result.diffed, false);
    assert.match(result.explanation ?? '', /400/);
    assert.match(result.explanation ?? '', /600/);
    // The target is echoed even here, so the caller can see which pair it was.
    assert.equal(result.comparedAgainst?.captureId, target.id);
    assert.equal(harness.written.length, 0);
  });
});

test('a full page that got longer is compared over the shared rows, and the growth is its own fact', async () => {
  await withHarness(async (harness) => {
    const shorter = filled(400, 300, WHITE);
    // The taller page: the same content in the top 300 rows, plus 200 more.
    const taller = filled(400, 500, WHITE);
    // One change inside the shared rows, so there is something to find.
    const change = { x: 50, y: 50, width: 80, height: 40 };
    const tallerWithChange = withRectangle(taller, change, BLACK);
    // And content below the shared rows, which must not be reported as a
    // region — it is page growth, not a change.
    const tallerFinal = withRectangle(
      tallerWithChange,
      { x: 20, y: 380, width: 300, height: 60 },
      GREY,
    );

    const target = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: shorter,
      kind: 'full_page',
      artifacts: harness.artifacts,
    });
    const current = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: tallerFinal,
      kind: 'full_page',
      artifacts: harness.artifacts,
    });

    const result = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: target.id,
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    // §3.11: the height is allowed to differ on a full page.
    assert.equal(result.diffed, true);
    assert.equal(result.pageLengthChange, 200);
    assert.equal(result.changed, true);

    // **The growth is not a region.** Every region reported sits inside the
    // shared rows; the content below row 300 is described by the length change
    // and nothing else. Reporting it as a region would drown the actual change.
    for (const region of result.regions) {
      assert.ok(
        region.y + region.height <= 300,
        `a region at y=${String(region.y)} height=${String(region.height)} extends past the shared rows, so page growth was reported as a change`,
      );
    }
    // And the real change inside the shared rows was found.
    assert.ok(result.regions.some((region) => region.y <= 50 && region.y + region.height >= 90));
  });
});

test('a viewport capture whose height differs produces no diff', async () => {
  await withHarness(async (harness) => {
    const target = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: filled(400, 300, WHITE),
      kind: 'viewport',
      artifacts: harness.artifacts,
    });
    const current = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: filled(400, 500, WHITE),
      kind: 'viewport',
      artifacts: harness.artifacts,
    });

    const result = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: target.id,
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    // The allowance is for a full page and nothing else — the pairing with the
    // test above is what proves `kind` is actually consulted rather than the
    // height difference being tolerated everywhere.
    assert.equal(result.diffed, false);
    assert.equal(result.widthMismatch, false);
    assert.equal(harness.written.length, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The region cap, and truncation (#42)
// ══════════════════════════════════════════════════════════════════════════

test('past the region cap the result is truncated, smallest dropped, and it says so', async () => {
  await withHarness(async (harness) => {
    const before = filled(600, 600, WHITE);
    // Six well-separated changes of clearly different sizes, so "largest
    // first" and "smallest dropped" are both observable.
    const sizes = [80, 70, 60, 50, 40, 30];
    let after = before;
    sizes.forEach((size, index) => {
      after = withRectangle(
        after,
        {
          x: 20 + (index % 3) * 190,
          y: 20 + Math.floor(index / 3) * 250,
          width: size,
          height: size,
        },
        BLACK,
      );
    });

    const target = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: before,
      artifacts: harness.artifacts,
    });
    const current = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: after,
      artifacts: harness.artifacts,
    });

    const uncapped = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: target.id,
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    assert.equal(uncapped.regions.length, 6);
    assert.equal(uncapped.truncated, false);

    const capped = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: target.id,
      source: harness.source,
      settings: { ...DEFAULT_DIFF_SETTINGS, maximumRegions: 3 },
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    assert.equal(capped.regions.length, 3);
    // §1.9: "A truncated result that does not say so is a lie about
    // completeness."
    assert.equal(capped.truncated, true);

    // **The three largest survived.** Named by their sizes rather than by
    // comparing the list to itself: the three kept must be the 80, 70 and 60,
    // which is what "the smallest ones are dropped" means.
    const keptSizes = capped.regions.map((region) => region.width).sort((a, b) => b - a);
    assert.deepEqual(keptSizes, [80, 70, 60]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The row, read back through a second connection
// ══════════════════════════════════════════════════════════════════════════

test('the comparison row records the three settings that were actually applied', async () => {
  await withHarness(async (harness) => {
    const before = filled(400, 300, WHITE);
    const after = withRectangle(before, { x: 100, y: 100, width: 80, height: 40 }, BLACK);

    const target = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: before,
      artifacts: harness.artifacts,
    });
    const current = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: after,
      artifacts: harness.artifacts,
    });

    // Deliberately not the defaults, so the row proves it copied what was
    // applied rather than writing the defaults back.
    const applied = {
      ...DEFAULT_DIFF_SETTINGS,
      colourTolerance: 0.25,
      minimumRegionArea: 32,
      maximumRegions: 5,
    };

    const result = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: target.id,
      source: harness.source,
      settings: applied,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    assert.notEqual(result.comparisonId, null);

    // **A second, read-only connection.** A read through the writing handle
    // sees uncommitted work and cannot tell a committed row from one about to
    // roll back.
    const reader = readOnlyHandle(harness.location);
    try {
      const rows = listComparisons(reader, { sourceCaptureId: current.id });
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.ok(row !== undefined);

      // All three, copied. §1.9: "snapshotting one and referencing the others
      // would be a record that is half-true."
      assert.equal(row.colourTolerance, 0.25);
      assert.equal(row.minimumRegionArea, 32);
      assert.equal(row.maximumRegions, 5);

      assert.equal(row.targetCaptureId, target.id);
      assert.equal(row.claimId, harness.claimId);
      assert.equal(row.changed, true);
      assert.equal(row.regions.length, result.regions.length);
      assert.equal(row.overlayPath, result.overlayPath);
      // The crop paths survive the round trip through the stored document.
      assert.equal(row.regions[0]?.beforePath, result.regions[0]?.beforePath);
    } finally {
      reader.close();
    }
  });
});

test('the changed ratio is the changed pixels over the area actually compared', async () => {
  await withHarness(async (harness) => {
    const before = filled(200, 100, WHITE);
    // Exactly 1000 pixels changed out of 20000, so the ratio is exactly 0.05
    // — an arithmetic assertion rather than a range, which is what makes a
    // wrong denominator visible.
    const after = withRectangle(before, { x: 10, y: 10, width: 50, height: 20 }, BLACK);

    const target = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: before,
      artifacts: harness.artifacts,
    });
    const current = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: after,
      artifacts: harness.artifacts,
    });

    const result = await runComparison({
      capture: current,
      captureBytes: await harness.source.readBytes(current),
      targetCaptureId: target.id,
      source: harness.source,
      settings: DEFAULT_DIFF_SETTINGS,
      artifacts: harness.artifacts,
      writeRow: harness.writeRow,
    });

    assert.equal(result.changedPixels, 1000);
    assert.equal(result.changedRatio, 1000 / (200 * 100));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The fixture set, through the whole path
// ══════════════════════════════════════════════════════════════════════════

test('every known-changed fixture produces at least one region end to end', async () => {
  await withHarness(async (harness) => {
    for (const pair of changedPairs()) {
      const target = await insertCapture(harness.rawDb, {
        claimId: harness.claimId,
        tabId: harness.tabId,
        image: pair.earlier,
        artifacts: harness.artifacts,
      });
      const current = await insertCapture(harness.rawDb, {
        claimId: harness.claimId,
        tabId: harness.tabId,
        image: pair.current,
        artifacts: harness.artifacts,
      });

      const result = await runComparison({
        capture: current,
        captureBytes: await harness.source.readBytes(current),
        targetCaptureId: target.id,
        source: harness.source,
        settings: DEFAULT_DIFF_SETTINGS,
        artifacts: harness.artifacts,
        writeRow: harness.writeRow,
      });

      assert.equal(result.changed, true, `${pair.name}: ${pair.describes}`);
      // And the crops for it are on disk, decodable — the fixture suite in
      // `thresholds.test.ts` stops at the region list, and this is where the
      // images it implies are proved to exist.
      const region = result.regions[0];
      assert.ok(region !== undefined);
      assert.ok(await artifactExists(harness.artifacts, region.beforePath));
      assert.ok(await artifactExists(harness.artifacts, region.afterPath));
    }
  });
});
