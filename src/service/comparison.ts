import { fileNameFrom, overlayFileName, regionCropFileName } from '../diff/artifact-path.ts';
import type { ArtifactStore } from '../artifacts/store.ts';
import { cutRegionCrops, drawOverlay, paddedRectangle } from '../diff/crops.ts';
import { reconcileGeometry } from '../diff/geometry.ts';
import { type RasterImage, decodePng, encodePng } from '../diff/image.ts';
import { computeMask } from '../diff/mask.ts';
import { extractRegions } from '../diff/regions.ts';
import type { DiffSettings } from '../diff/settings.ts';
import type { CaptureRecord, CaptureSource } from './capture-seam.ts';

/**
 * Running one comparison (`MILESTONES.md` #40 and #42, `SCHEMA.md` §1.9).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ONE RULE THAT SHAPES EVERY BRANCH IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **A diff is an optional argument on a capture, so it can never refuse the
 * capture.** §1.9, on the missing-target case, and it generalises to every
 * failure here:
 *
 * > The caller asked for a picture. A diff is an *optional argument on a
 * > capture* (§3.11), not a separate operation — so the request that fails to
 * > find its target is still, underneath, a request for a screenshot, and that
 * > part of it can always be satisfied. Refusing the whole call would withhold
 * > something that succeeded because something optional did not.
 *
 * **So nothing in this file throws a refusal.** Every way a comparison can fail
 * to happen — no such capture, another lease's capture, mismatched widths, a
 * file that will not decode — comes back as a result carrying an explanation
 * and no diff. The caller gets its picture either way, because the caller
 * already has its picture: this runs after the shutter.
 *
 * The one thing that does throw is a programming mistake — a stored path that
 * escapes the artifact root, say — because that is not a caller's problem and
 * reporting it as "could not diff" would bury it.
 */

/** One region as §1.9 returns it: where, how much, and two usable images. */
export interface ComparisonRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** How many pixels inside this region changed. */
  readonly changedPixels: number;
  /** That region as it was, in the capture the caller named. Relative to the root. */
  readonly beforePath: string;
  /** The same rectangle in the capture just taken. Relative to the root. */
  readonly afterPath: string;
}

/** The capture the caller named, echoed back (§1.9). */
export interface ComparedAgainst {
  readonly captureId: string;
  readonly path: string;
}

/**
 * What a comparison produced.
 *
 * **`diffed` is the field to branch on first**, and it is separate from
 * `changed` on purpose. `changed: false` means the comparison ran and found
 * nothing above the threshold; `diffed: false` means no comparison ran at all.
 * Collapsing them would make "could not find the capture you named" and
 * "nothing moved" the same answer, which is the exact confusion §1.9 spends a
 * section preventing.
 */
export interface ComparisonResult {
  /** Did a comparison actually run? */
  readonly diffed: boolean;
  /**
   * True when at least one region survives filtering — **not** when any pixel
   * differs (§1.9). Always false when `diffed` is false.
   */
  readonly changed: boolean;
  /** The raw count and its share, before regions are worked out (§1.9). */
  readonly changedPixels: number;
  readonly changedRatio: number;
  /** One entry per changed area, ordered largest first. */
  readonly regions: readonly ComparisonRegion[];
  /** The new capture with the changed regions outlined. Relative to the root. */
  readonly overlayPath: string | null;
  /** Whether regions were dropped by the cap — the smallest ones (§1.9). */
  readonly truncated: boolean;
  /** The capture the caller named, echoed back rather than assumed (§1.9). */
  readonly comparedAgainst: ComparedAgainst | null;
  /** The three values that decided the output (§1.9). */
  readonly settingsApplied: {
    readonly colourTolerance: number;
    readonly minimumRegionArea: number;
    readonly maximumRegions: number;
  };
  /**
   * The change in page length, in pixels, on a full page whose height differed
   * — **its own fact, never a region** (§3.11). `null` otherwise.
   */
  readonly pageLengthChange: number | null;
  /** True when the two captures were different widths (§1.9). */
  readonly widthMismatch: boolean;
  /**
   * In plain words: what happened, when anything needs saying. `null` on an
   * ordinary comparison of two matching captures.
   */
  readonly explanation: string | null;
  /** The row written, or `null` when no comparison ran. */
  readonly comparisonId: string | null;
}

export interface RunComparisonOptions {
  /** The capture just taken — the one the diff is *of*. */
  readonly capture: CaptureRecord;
  /** Its bytes. Already in hand, since it was just written. */
  readonly captureBytes: Uint8Array;
  /** The identifier the caller passed as `diff_against` (§3.11). */
  readonly targetCaptureId: string;
  readonly source: CaptureSource;
  readonly settings: DiffSettings;
  /**
   * Where files are written and read.
   *
   * **The store rather than a root path**, so every join of a stored path to a
   * location goes through the one implementation that refuses an escape in
   * both path namespaces (`src/artifacts/store.ts`). A root string here would
   * have meant a second resolver, and the second one is the one that would be
   * missing a case.
   */
  readonly artifacts: ArtifactStore;
  /**
   * Write the `comparisons` row and return its identifier.
   *
   * **Injected rather than done here**, and the reason is `db.import_isolated`
   * (§7.3): only the service layer reaches the database, and a module reaching
   * it directly is a build failure rather than a review comment. More
   * practically, it is what lets the write happen inside whatever transaction
   * the caller is already in — a capture writes its own row and this row in one
   * unit, or neither.
   */
  readonly writeRow: (row: ComparisonRow) => string;
}

/** The row §1.9 specifies, as the writer receives it. */
export interface ComparisonRow {
  readonly sourceCaptureId: string;
  readonly targetCaptureId: string;
  readonly claimId: string;
  readonly colourTolerance: number;
  readonly minimumRegionArea: number;
  readonly maximumRegions: number;
  readonly changedPixels: number;
  readonly changedRatio: number;
  readonly changed: boolean;
  readonly regions: readonly ComparisonRegion[];
  readonly overlayPath: string;
  readonly truncated: boolean;
}

/** A result carrying no diff, with the sentence saying why. */
function noDiff(
  settings: DiffSettings,
  explanation: string,
  extra: Partial<ComparisonResult> = {},
): ComparisonResult {
  return {
    diffed: false,
    changed: false,
    changedPixels: 0,
    changedRatio: 0,
    regions: [],
    overlayPath: null,
    truncated: false,
    comparedAgainst: null,
    settingsApplied: {
      colourTolerance: settings.colourTolerance,
      minimumRegionArea: settings.minimumRegionArea,
      maximumRegions: settings.maximumRegions,
    },
    pageLengthChange: null,
    widthMismatch: false,
    explanation,
    comparisonId: null,
    ...extra,
  };
}

/**
 * Write a PNG into a lease's images directory and return its stored path.
 *
 * The store creates the directory, refuses a name that would land outside the
 * root, and hands back the relative path — which is the only form that goes in
 * a row (§1.7a).
 */
function writeImage(
  artifacts: ArtifactStore,
  claimId: string,
  fileName: string,
  image: RasterImage,
): string {
  return artifacts.write(claimId, 'images', fileName, encodePng(image)).relativePath;
}

/**
 * Run the comparison.
 *
 * The order of the checks is the order of §1.9's own reasoning, and each one
 * returns a picture with an explanation rather than a refusal.
 */
export async function runComparison(options: RunComparisonOptions): Promise<ComparisonResult> {
  const { capture, targetCaptureId, source, settings, artifacts } = options;

  // ── 1. The capture the caller named ───────────────────────────────────
  const target = source.find(targetCaptureId);
  if (target === null) {
    return noDiff(
      settings,
      `No diff was produced: there is no capture with the identifier ${JSON.stringify(targetCaptureId)}, so there was nothing to compare against. The picture you asked for is above. Check the identifier — it is the one returned by the earlier capture you meant to compare with.`,
    );
  }

  // ── 2. It has to belong to this lease ─────────────────────────────────
  //
  // §1.9 on the bytes surface: it "serves only artifacts belonging to the
  // asking lease, checked the same way every other tab-addressed operation is
  // checked, and refusing with the same non-disclosing wording as an unknown
  // tab (§7.1) so probing cannot discover another lease's files".
  //
  // **The same non-disclosing wording is used here**, and that is the decision
  // in this branch: a caller that named another lease's capture is told the
  // identical sentence as a caller that named nothing at all. Distinguishing
  // them would turn `diff_against` into a way to enumerate other leases'
  // captures by watching which identifiers produce a different message.
  if (target.claimId !== capture.claimId) {
    return noDiff(
      settings,
      `No diff was produced: there is no capture with the identifier ${JSON.stringify(targetCaptureId)}, so there was nothing to compare against. The picture you asked for is above. Check the identifier — it is the one returned by the earlier capture you meant to compare with.`,
    );
  }

  const comparedAgainst: ComparedAgainst = { captureId: target.id, path: target.path };

  // ── 3. Both files have to be readable and decodable ───────────────────
  let earlier: RasterImage;
  let current: RasterImage;
  try {
    earlier = decodePng(await source.readBytes(target));
    current = decodePng(options.captureBytes);
  } catch (error) {
    return noDiff(
      settings,
      `No diff was produced: the image for capture ${JSON.stringify(targetCaptureId)} could not be read (${error instanceof Error ? error.message : String(error)}). The picture you asked for is above.`,
      { comparedAgainst },
    );
  }

  // ── 4. Geometry, reported rather than pre-empted (#40) ────────────────
  const geometry = reconcileGeometry(
    { width: earlier.width, height: earlier.height },
    { width: current.width, height: current.height },
    capture.kind,
  );

  if (!geometry.comparable || geometry.width === null || geometry.comparableHeight === null) {
    return noDiff(settings, geometry.explanation ?? 'No diff was produced.', {
      comparedAgainst,
      widthMismatch: geometry.widthMismatch,
      pageLengthChange: geometry.pageLengthChange,
    });
  }

  // ── 5. The comparison itself ──────────────────────────────────────────
  const mask = computeMask(earlier, current, {
    colourTolerance: settings.colourTolerance,
    height: geometry.comparableHeight,
  });

  const allRegions = extractRegions(mask, {
    mergeDistance: settings.regionMergeDistance,
    minimumArea: settings.minimumRegionArea,
  });

  // The cap bites here, and only here. The list is ordered largest first, so
  // taking the first N drops the smallest — which is what §1.9 promises, and
  // `truncated` is what stops the shortened list being "a lie about
  // completeness".
  const truncated = allRegions.length > settings.maximumRegions;
  const kept = truncated ? allRegions.slice(0, settings.maximumRegions) : allRegions;

  // ── 6. The crops and the overlay (#42) ────────────────────────────────
  const captureFileName = fileNameFrom(capture.path);
  const regions: ComparisonRegion[] = [];

  for (const [index, region] of kept.entries()) {
    // One rectangle, padded and clamped once, both crops cut from it. The
    // clamp is against the *compared* geometry rather than either image's own,
    // so the rectangle is guaranteed to fit both — which is what makes "from
    // the same rectangle" true on a full page whose height changed.
    const rectangle = paddedRectangle(
      region,
      settings.cropPadding,
      geometry.width,
      geometry.comparableHeight,
    );
    if (rectangle === null) {
      continue;
    }

    const crops = cutRegionCrops(earlier, current, rectangle);
    const beforePath = writeImage(
      artifacts,
      capture.claimId,
      regionCropFileName(captureFileName, index, 'before'),
      crops.before,
    );
    const afterPath = writeImage(
      artifacts,
      capture.claimId,
      regionCropFileName(captureFileName, index, 'after'),
      crops.after,
    );

    regions.push({
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      changedPixels: region.changedPixels,
      beforePath,
      afterPath,
    });
  }

  const storedOverlayPath = writeImage(
    artifacts,
    capture.claimId,
    overlayFileName(captureFileName),
    drawOverlay(current, kept),
  );

  // ── 7. The row (§1.9) ─────────────────────────────────────────────────
  //
  // `changed` is written rather than derived, because §1.9 fixes its
  // definition — "true when at least one region survives filtering, not when
  // any pixel differs" — and it "has to have one answer rather than two".
  const comparedPixels = geometry.width * geometry.comparableHeight;
  const changedRatio = comparedPixels === 0 ? 0 : mask.changedPixels / comparedPixels;
  const changed = regions.length > 0;

  const comparisonId = options.writeRow({
    sourceCaptureId: capture.id,
    targetCaptureId: target.id,
    claimId: capture.claimId,
    colourTolerance: settings.colourTolerance,
    minimumRegionArea: settings.minimumRegionArea,
    maximumRegions: settings.maximumRegions,
    changedPixels: mask.changedPixels,
    changedRatio,
    changed,
    regions,
    overlayPath: storedOverlayPath,
    truncated,
  });

  return {
    diffed: true,
    changed,
    changedPixels: mask.changedPixels,
    changedRatio,
    regions,
    overlayPath: storedOverlayPath,
    truncated,
    comparedAgainst,
    settingsApplied: {
      colourTolerance: settings.colourTolerance,
      minimumRegionArea: settings.minimumRegionArea,
      maximumRegions: settings.maximumRegions,
    },
    pageLengthChange: geometry.pageLengthChange,
    widthMismatch: false,
    // Present on an ordinary comparison only when the page length changed —
    // the one comparable case that still needs a sentence, because a length
    // change the caller cannot see is one it will attribute to something else.
    explanation: geometry.explanation,
    comparisonId,
  };
}
