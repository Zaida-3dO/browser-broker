import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { ArtifactStore } from '../../src/artifacts/store.ts';
import { decodePng } from '../../src/diff/image.ts';
import { DEFAULT_DIFF_SETTINGS } from '../../src/diff/settings.ts';
import {
  ARTIFACT_NOT_FOUND_MESSAGE,
  type CaptureLookup,
  fetchArtifact,
} from '../../src/service/artifacts.ts';
import { insertComparison } from '../../src/service/comparison-store.ts';
import { runComparison } from '../../src/service/comparison.ts';
import { prepareStore } from '../../src/store/open.ts';
import {
  insertCapture,
  insertClaim,
  insertTab,
  storeBackedCaptureSource,
} from '../helpers/comparison-fixtures.ts';
import { BLACK, WHITE, filled, withRectangle } from '../helpers/images.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * Delivering the images — one endpoint, one return shape (`MILESTONES.md` #49,
 * `SCHEMA.md` §1.9).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN OF THIS FILE MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **What it means:** the surface returns the same shape for a full capture and
 * for a crop, serves real bytes that decode as real images, and refuses
 * another lease's artifacts in the same words as ones that do not exist.
 *
 * **What it does not mean:** that traversal is impossible because these
 * refusals hold. §1.9 is explicit that the mechanism is the absence of a
 * path-shaped input rather than validation — "there is no traversal to defend
 * against: the only strings it can be asked for are identifiers of rows" — and
 * `scripts/check-artifact-path.mjs` is what enforces that absence as a build
 * rule. **These tests cannot express the traversal attempt at all**, because
 * the request type has no field to put a path in, and that is the point rather
 * than a gap in coverage.
 */

interface Harness {
  readonly rawDb: Parameters<typeof insertClaim>[0];
  readonly artifacts: ArtifactStore;
  readonly claimId: string;
  readonly tabId: string;
  readonly captures: CaptureLookup;
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const temp = makeTempStore();
  try {
    const store = await prepareStore(temp.environment);
    try {
      const artifacts = new ArtifactStore(temp.environment.artifactsRoot);
      const claimId = insertClaim(store.db);
      const tabId = insertTab(store.db, claimId);
      const source = storeBackedCaptureSource(store.db, artifacts);

      await fn({
        rawDb: store.db,
        artifacts,
        claimId,
        tabId,
        captures: {
          find: (captureId) => {
            const capture = source.find(captureId);
            return capture === null ? null : { claimId: capture.claimId, path: capture.path };
          },
        },
      });
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
}

/** Run a comparison and return the row identifier, for the crop cases. */
async function comparisonFor(harness: Harness): Promise<{
  comparisonId: string;
  regionCount: number;
  captureId: string;
}> {
  const before = filled(400, 300, WHITE);
  const after = withRectangle(before, { x: 100, y: 100, width: 80, height: 40 }, BLACK);
  const source = storeBackedCaptureSource(harness.rawDb, harness.artifacts);

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
    captureBytes: await source.readBytes(current),
    targetCaptureId: target.id,
    source,
    settings: DEFAULT_DIFF_SETTINGS,
    artifacts: harness.artifacts,
    writeRow: (row) => insertComparison(harness.rawDb, row),
  });

  assert.notEqual(result.comparisonId, null);
  return {
    comparisonId: result.comparisonId ?? '',
    regionCount: result.regions.length,
    captureId: current.id,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// One return shape
// ══════════════════════════════════════════════════════════════════════════

test('a capture and a crop come back in the identical shape', async () => {
  await withHarness(async (harness) => {
    const { comparisonId, captureId } = await comparisonFor(harness);

    const capture = await fetchArtifact({
      db: harness.rawDb,
      artifacts: harness.artifacts,
      claimId: harness.claimId,
      captures: harness.captures,
      request: { kind: 'capture', captureId },
    });
    const crop = await fetchArtifact({
      db: harness.rawDb,
      artifacts: harness.artifacts,
      claimId: harness.claimId,
      captures: harness.captures,
      request: { kind: 'region', comparisonId, index: 0, side: 'before' },
    });

    assert.equal(capture.served, true);
    assert.equal(crop.served, true);
    if (!capture.served || !crop.served) return;

    // **The same keys, in both cases.** §1.9: "An image request always returns
    // an image, the same way, every time." A response whose shape depended on
    // what was asked for is the design this row exists to refuse.
    assert.deepEqual(Object.keys(capture.artifact).sort(), Object.keys(crop.artifact).sort());
    assert.deepEqual(Object.keys(capture.artifact).sort(), ['bytes', 'path']);

    // Real bytes, both times, decoding as real images of the sizes they should
    // be — the full page and a padded crop.
    const wholePage = decodePng(capture.artifact.bytes);
    const region = decodePng(crop.artifact.bytes);
    assert.equal(wholePage.width, 400);
    assert.equal(wholePage.height, 300);
    assert.ok(region.width < wholePage.width);
    assert.ok(region.height < wholePage.height);
  });
});

test('there is no size cap and no inline branch — a large artifact serves the same way', async () => {
  await withHarness(async (harness) => {
    // The rejected design returned small crops inline and paths for large ones.
    // #49: "you cannot know a diff is small". This asserts the shape does not
    // vary with size: a big capture and a small crop return the same keys.
    const big = filled(1200, 900, WHITE);
    const capture = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: big,
      artifacts: harness.artifacts,
    });

    const outcome = await fetchArtifact({
      db: harness.rawDb,
      artifacts: harness.artifacts,
      claimId: harness.claimId,
      captures: harness.captures,
      request: { kind: 'capture', captureId: capture.id },
    });

    assert.equal(outcome.served, true);
    if (!outcome.served) return;
    assert.deepEqual(Object.keys(outcome.artifact).sort(), ['bytes', 'path']);
    assert.equal(decodePng(outcome.artifact.bytes).width, 1200);
  });
});

test('the overlay is served by naming the comparison, and it decodes at the full page size', async () => {
  await withHarness(async (harness) => {
    const { comparisonId } = await comparisonFor(harness);

    const outcome = await fetchArtifact({
      db: harness.rawDb,
      artifacts: harness.artifacts,
      claimId: harness.claimId,
      captures: harness.captures,
      request: { kind: 'overlay', comparisonId },
    });

    assert.equal(outcome.served, true);
    if (!outcome.served) return;
    // §1.9: the overlay answers "where on the page", so it is the page.
    const overlay = decodePng(outcome.artifact.bytes);
    assert.equal(overlay.width, 400);
    assert.equal(overlay.height, 300);
  });
});

test('the two sides of one region are different images', async () => {
  await withHarness(async (harness) => {
    const { comparisonId } = await comparisonFor(harness);

    const before = await fetchArtifact({
      db: harness.rawDb,
      artifacts: harness.artifacts,
      claimId: harness.claimId,
      captures: harness.captures,
      request: { kind: 'region', comparisonId, index: 0, side: 'before' },
    });
    const after = await fetchArtifact({
      db: harness.rawDb,
      artifacts: harness.artifacts,
      claimId: harness.claimId,
      captures: harness.captures,
      request: { kind: 'region', comparisonId, index: 0, side: 'after' },
    });

    assert.equal(before.served, true);
    assert.equal(after.served, true);
    if (!before.served || !after.served) return;

    // Different bytes, same dimensions. A surface that served the same file
    // for both sides would satisfy every other assertion here.
    assert.notDeepEqual(
      Array.from(before.artifact.bytes),
      Array.from(after.artifact.bytes),
      'the two sides served identical bytes, so the side argument is not being read',
    );
    assert.equal(before.artifact.path.endsWith('-before.png'), true);
    assert.equal(after.artifact.path.endsWith('-after.png'), true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Only artifacts belonging to the asking lease
// ══════════════════════════════════════════════════════════════════════════

test("another lease's capture is refused, in the same words as one that does not exist", async () => {
  await withHarness(async (harness) => {
    const otherClaim = insertClaim(harness.rawDb);
    const otherTab = insertTab(harness.rawDb, otherClaim);
    const theirs = await insertCapture(harness.rawDb, {
      claimId: otherClaim,
      tabId: otherTab,
      image: filled(400, 300, WHITE),
      artifacts: harness.artifacts,
    });

    const notMine = await fetchArtifact({
      db: harness.rawDb,
      artifacts: harness.artifacts,
      claimId: harness.claimId,
      captures: harness.captures,
      request: { kind: 'capture', captureId: theirs.id },
    });
    const notThere = await fetchArtifact({
      db: harness.rawDb,
      artifacts: harness.artifacts,
      claimId: harness.claimId,
      captures: harness.captures,
      request: { kind: 'capture', captureId: 'no-such-capture' },
    });

    assert.equal(notMine.served, false);
    assert.equal(notThere.served, false);
    if (notMine.served || notThere.served) return;

    // **Byte-identical.** §1.9: refused "with the same non-disclosing wording
    // as an unknown tab so probing cannot discover another lease's files".
    // Two rules, one message — the collapse §7.1 makes for `tab.owned` and
    // `tab.open`, for the same reason.
    assert.equal(notMine.refusal.message, notThere.refusal.message);
    assert.equal(notMine.refusal.message, ARTIFACT_NOT_FOUND_MESSAGE);
    assert.equal(notMine.refusal.reason, notThere.refusal.reason);
  });
});

test("another lease's comparison is refused for its overlay and for its crops", async () => {
  await withHarness(async (harness) => {
    const { comparisonId } = await comparisonFor(harness);
    const stranger = insertClaim(harness.rawDb);

    // Both variants that address a comparison. A check on one and not the
    // other is the shape this pair exists to catch.
    for (const request of [
      { kind: 'overlay' as const, comparisonId },
      { kind: 'region' as const, comparisonId, index: 0, side: 'before' as const },
    ]) {
      const outcome = await fetchArtifact({
        db: harness.rawDb,
        artifacts: harness.artifacts,
        claimId: stranger,
        captures: harness.captures,
        request,
      });
      assert.equal(
        outcome.served,
        false,
        `${request.kind} was served to a lease that does not own it`,
      );
      if (outcome.served) continue;
      assert.equal(outcome.refusal.message, ARTIFACT_NOT_FOUND_MESSAGE);
    }
  });
});

test('a region index past the end is refused rather than serving something else', async () => {
  await withHarness(async (harness) => {
    const { comparisonId, regionCount } = await comparisonFor(harness);

    const outcome = await fetchArtifact({
      db: harness.rawDb,
      artifacts: harness.artifacts,
      claimId: harness.claimId,
      captures: harness.captures,
      request: { kind: 'region', comparisonId, index: regionCount + 5, side: 'before' },
    });

    // An out-of-range index that fell back to the first region would serve a
    // picture of the wrong thing, which is worse than serving nothing.
    assert.equal(outcome.served, false);
    if (outcome.served) return;
    assert.equal(outcome.refusal.reason, 'not_found');
  });
});

test('a negative region index is refused', async () => {
  await withHarness(async (harness) => {
    const { comparisonId } = await comparisonFor(harness);

    const outcome = await fetchArtifact({
      db: harness.rawDb,
      artifacts: harness.artifacts,
      claimId: harness.claimId,
      captures: harness.captures,
      request: { kind: 'region', comparisonId, index: -1, side: 'before' },
    });

    assert.equal(outcome.served, false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// A row whose file is gone
// ══════════════════════════════════════════════════════════════════════════

test('a recorded artifact whose file is missing says so, distinctly from not found', async () => {
  await withHarness(async (harness) => {
    const capture = await insertCapture(harness.rawDb, {
      claimId: harness.claimId,
      tabId: harness.tabId,
      image: filled(400, 300, WHITE),
      artifacts: harness.artifacts,
    });
    await fs.rm(harness.artifacts.resolve(capture.path));

    const outcome = await fetchArtifact({
      db: harness.rawDb,
      artifacts: harness.artifacts,
      claimId: harness.claimId,
      captures: harness.captures,
      request: { kind: 'capture', captureId: capture.id },
    });

    assert.equal(outcome.served, false);
    if (outcome.served) return;
    // A *different* reason from not-found, and deliberately so: the caller
    // named something real and there is nothing it can do differently, which
    // is a different situation from having named the wrong thing. The
    // non-disclosure argument does not apply — this row belongs to the asking
    // lease, so nothing is revealed that it could not already see.
    assert.equal(outcome.refusal.reason, 'unreadable');
    assert.notEqual(outcome.refusal.message, ARTIFACT_NOT_FOUND_MESSAGE);
  });
});
