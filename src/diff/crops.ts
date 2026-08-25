import {
  type Colour,
  type RasterImage,
  type Rectangle,
  clampToImage,
  copyImage,
  crop,
  outlineRectangle,
} from './image.ts';
import type { ChangedRegion } from './regions.ts';

/**
 * Cutting the crops and drawing the overlay (`MILESTONES.md` #42).
 *
 * §1.9 is unusually specific about what a diff returns, and it is worth
 * quoting because it decides three things in this file at once:
 *
 * > It is **not** a set of coordinates you then have to go and cut out of a
 * > picture yourself. The service does the cutting. For each region that
 * > changed it writes **two** small images — that region as it was in the
 * > capture you named, and as it is now, cut from the same rectangle with a
 * > little padding so the crop is identifiable — and returns their paths
 * > alongside the numbers. It also writes one full-frame image with the
 * > changed regions outlined.
 *
 * ── Both crops come from one rectangle, and that is load-bearing ────────
 *
 * The rectangle is computed once — padded once, clamped once — and both crops
 * are cut from it. Padding each crop against its own image would produce two
 * pictures of subtly different areas whenever the two images differ in height,
 * which is precisely the full-page case §3.11 allows. Two crops of different
 * areas, presented side by side as before-and-after, invite the reader to
 * attribute the framing difference to the change.
 *
 * ── Why padding at all ──────────────────────────────────────────────────
 *
 * §6.2: "a tight box with nothing around it can be genuinely unidentifiable".
 * A tight crop of a changed word is a picture of a word on a blank field; the
 * same crop with sixteen pixels of context around it usually contains the
 * label beside it, which is what tells a reader which word it is.
 */

/** The colour a region is outlined in on the overlay. */
export const OUTLINE_COLOUR: Colour = { red: 255, green: 0, blue: 0, alpha: 255 };

/**
 * How thick that outline is.
 *
 * Two pixels rather than one: a single-pixel outline around a single-pixel
 * change is a three-pixel mark on a full page, and at the scale a full page is
 * usually looked at, it disappears. The overlay's whole job is answering
 * "where", so it has to be visible without zooming.
 */
export const OUTLINE_THICKNESS = 2;

/** A region's rectangle, padded and clamped, ready to cut both crops from. */
export interface CropRectangle {
  /** The region as extracted, unpadded — what the caller is told changed. */
  readonly region: Rectangle;
  /** The rectangle both crops are actually cut from. */
  readonly padded: Rectangle;
}

/**
 * Pad a region and clamp it to the area both images share.
 *
 * The width and height passed in must be the geometry the comparison ran over,
 * **not** either image's own. On a full page that grew, the new image is taller
 * than the earlier one, and a rectangle clamped against the new image's height
 * could fall outside the earlier one entirely — producing a crop that throws,
 * or worse, a crop of whatever the buffer held.
 *
 * Returns `null` only when nothing survives clamping, which cannot happen for a
 * region that came from a mask of this size and is kept as a guard rather than
 * as a case anybody expects.
 */
export function paddedRectangle(
  region: Rectangle,
  padding: number,
  comparableWidth: number,
  comparableHeight: number,
): CropRectangle | null {
  const grown: Rectangle = {
    x: region.x - padding,
    y: region.y - padding,
    width: region.width + padding * 2,
    height: region.height + padding * 2,
  };
  const padded = clampToImage(grown, comparableWidth, comparableHeight);
  if (padded === null) {
    return null;
  }
  return { region, padded };
}

/** The pair of crops for one region, cut from one rectangle. */
export interface RegionCrops {
  readonly rectangle: CropRectangle;
  /** That rectangle in the capture the caller named. */
  readonly before: RasterImage;
  /** The same rectangle in the capture just taken. */
  readonly after: RasterImage;
}

/**
 * Cut both crops for one region.
 *
 * Order of arguments mirrors the order §1.9 returns them in — the earlier
 * capture first, "as it was", then "as it is now".
 */
export function cutRegionCrops(
  earlier: RasterImage,
  current: RasterImage,
  rectangle: CropRectangle,
): RegionCrops {
  return {
    rectangle,
    before: crop(earlier, rectangle.padded),
    after: crop(current, rectangle.padded),
  };
}

/**
 * Draw the overlay: the new capture with every changed region outlined.
 *
 * **The new capture rather than the earlier one**, because the caller is
 * looking at what it just produced and wants to know where on *that* to look.
 * And **the full new capture, not the compared sub-rectangle** — a full page
 * that grew is still the page the caller took a picture of, and cropping the
 * overlay to the shared rows would silently hide the part that grew.
 *
 * **The unpadded region is outlined, not the padded rectangle**, so the mark
 * on the page is the size of the thing that changed. The padding exists to
 * make a crop readable; drawing it would overstate the change by sixteen
 * pixels in every direction.
 */
export function drawOverlay(current: RasterImage, regions: readonly ChangedRegion[]): RasterImage {
  const overlay = copyImage(current);
  for (const region of regions) {
    outlineRectangle(overlay, region, OUTLINE_COLOUR, OUTLINE_THICKNESS);
  }
  return overlay;
}
