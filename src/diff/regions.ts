import type { DiffMask } from './mask.ts';
import type { Rectangle } from './image.ts';

/**
 * Changed-region extraction (`MILESTONES.md` #41).
 *
 * Three steps, in order, and each one is a decision the milestone names:
 *
 * 1. **Connected components** over the mask, into bounding boxes.
 * 2. **Merged at a configurable distance** (§6.2, default 8 pixels), because
 *    two words changing in one sentence are one change to a person.
 * 3. **Filtered on area with a thin-line allowance** — and the negative half
 *    of that is the point of the row.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE FILTER, AND THE SHAPE IT MUST NOT DISCARD
 * ══════════════════════════════════════════════════════════════════════════
 *
 * #41: filtered "**on area with a thin-line allowance** — not on the shorter
 * side, which discards a one-pixel line across a wide page". §6.2 says the
 * same from the other direction: "the size filter is on area with a thin-line
 * allowance, so a one-pixel line across a page survives it".
 *
 * **The rejected rule and why it is so tempting.** Filtering on the shorter
 * side — the smaller of width and height against a minimum — reads as
 * obviously right: it drops specks, and a speck is small in both directions.
 * It is wrong because the changes most worth catching in a visual review are
 * thin by nature:
 *
 * | Change | Shape | Shorter side |
 * |---|---|---|
 * | A border width going from one pixel to two | a line the width of an element | **1** |
 * | A focus ring appearing | a thin rectangle outline | **1–2** |
 * | An underline added or removed | a line the width of a word | **1** |
 * | A horizontal rule moving | a line the width of a page | **1** |
 *
 * Every one of those is invisible to a shorter-side filter and every one is a
 * real regression somebody wants to see. A one-pixel line across a page a
 * thousand pixels wide has an area of a thousand, which is many times the
 * default minimum — so **area alone already keeps it**, and the shorter-side
 * rule is strictly worse than the simpler thing.
 *
 * **So what is the allowance for, if area alone keeps the long line?** For the
 * *short* thin line — a two-pixel-tall underline beneath a single short word,
 * area perhaps forty against a minimum of sixty-four. Area alone eats that,
 * and it is the same class of change as the long one. The allowance is a
 * second way to survive: **a region that is thin and long relative to its
 * thickness is kept whatever its area**, because being line-shaped is itself
 * evidence that it is a deliberate piece of a layout rather than a rendering
 * speck. A speck is small in both directions and roughly square; a line is
 * not.
 *
 * The two tests that pin this are the ones to read before touching the
 * numbers: a one-pixel line across a wide page survives, and a short thin
 * underline survives, and both fail if the filter reverts to the shorter side.
 */

/**
 * How long a thin region must be, as a multiple of its thickness, to be kept
 * regardless of area.
 *
 * **Six rather than a larger number**, because the shortest change worth
 * keeping is an underline beneath one short word: two pixels tall and perhaps
 * twenty long is a ratio of ten, and a two-by-three speck is a ratio of one
 * and a half. Six sits between them with room on both sides, and the cost of
 * it being slightly too low is an extra small region in a list that is ordered
 * largest first and capped anyway.
 */
export const THIN_LINE_ASPECT_RATIO = 6;

/**
 * The thickest a region can be and still be judged a line, in pixels.
 *
 * Without this, a large block on a wide page whose sides happen to sit at a
 * ratio of six would be kept "as a line" — which is harmless, since a region
 * that size passes on area many times over, but it makes the allowance mean
 * something it does not. Four pixels covers a border, a focus ring, an
 * underline and a rule at the device pixel ratios a capture is taken at.
 */
export const THIN_LINE_MAXIMUM_THICKNESS = 4;

/** One extracted region: where it is, and how much of it actually changed. */
export interface ChangedRegion extends Rectangle {
  /** How many pixels inside this box changed. Used to order the list. */
  readonly changedPixels: number;
}

export interface ExtractionOptions {
  /** Two changed areas closer than this become one region. §6.2, default 8. */
  readonly mergeDistance: number;
  /** The smallest area reported, in square pixels. §6.2, default 64. */
  readonly minimumArea: number;
}

/**
 * Connected components over the mask, four-connected.
 *
 * **Four rather than eight**, and the difference matters here in one
 * direction: eight-connectivity joins two areas touching only at a corner,
 * which is how two separate one-pixel changes a diagonal apart become one box
 * spanning both. Merging is a separate, configurable step immediately below,
 * so the conservative connectivity loses nothing — anything that should have
 * been joined is joined by distance, under a number somebody can see and
 * change.
 *
 * Iterative rather than recursive: a full-page region can be a million pixels,
 * and a recursive flood fill on one is a stack overflow rather than a slow
 * answer.
 */
function components(mask: DiffMask): ChangedRegion[] {
  const { width, height, changed } = mask;
  const seen = new Uint8Array(width * height);
  const found: ChangedRegion[] = [];
  // Reused across components. A per-component array would allocate once per
  // region, and a page-wide re-render produces a lot of them.
  const stack: number[] = [];

  for (let start = 0; start < changed.length; start += 1) {
    if (changed[start] === 0 || seen[start] === 1) {
      continue;
    }

    seen[start] = 1;
    stack.length = 0;
    stack.push(start);

    let left = width;
    let right = -1;
    let top = height;
    let bottom = -1;
    let count = 0;

    while (stack.length > 0) {
      // `pop` on a non-empty array, which the loop condition guarantees.
      const at = stack.pop() as number;
      const x = at % width;
      const y = (at - x) / width;

      count += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;

      if (x > 0 && changed[at - 1] === 1 && seen[at - 1] === 0) {
        seen[at - 1] = 1;
        stack.push(at - 1);
      }
      if (x + 1 < width && changed[at + 1] === 1 && seen[at + 1] === 0) {
        seen[at + 1] = 1;
        stack.push(at + 1);
      }
      if (y > 0 && changed[at - width] === 1 && seen[at - width] === 0) {
        seen[at - width] = 1;
        stack.push(at - width);
      }
      if (y + 1 < height && changed[at + width] === 1 && seen[at + width] === 0) {
        seen[at + width] = 1;
        stack.push(at + width);
      }
    }

    found.push({
      x: left,
      y: top,
      width: right - left + 1,
      height: bottom - top + 1,
      changedPixels: count,
    });
  }

  return found;
}

/** Do two boxes come within `distance` of each other, in both axes? */
function within(a: Rectangle, b: Rectangle, distance: number): boolean {
  const horizontalGap = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)));
  const verticalGap = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)));
  return horizontalGap <= distance && verticalGap <= distance;
}

/** The smallest box containing both. */
function union(a: ChangedRegion, b: ChangedRegion): ChangedRegion {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
    // Summed rather than recounted from the mask. The two components are
    // disjoint by construction, so the sum is exact, and recounting would mean
    // a second pass over the union's area for every merge.
    changedPixels: a.changedPixels + b.changedPixels,
  };
}

/**
 * Merge boxes that come within `distance` of one another, repeatedly.
 *
 * **Repeatedly, until nothing moves**, and that is not an optimisation detail:
 * merging one box into another can bring the union within reach of a third
 * that was too far from either alone. A single pass would report two regions
 * where a person sees one, and which two would depend on the order the
 * components happened to be found in.
 */
function merge(regions: ChangedRegion[], distance: number): ChangedRegion[] {
  let current = regions;
  let moved = true;

  while (moved) {
    moved = false;
    const next: ChangedRegion[] = [];

    for (const region of current) {
      let merged = region;
      let index = 0;
      while (index < next.length) {
        // Indexed inside the bound the loop condition establishes; the local
        // is what lets the compiler see that.
        const candidate = next[index] as ChangedRegion;
        if (within(merged, candidate, distance)) {
          merged = union(merged, candidate);
          next.splice(index, 1);
          moved = true;
          // Not advancing: the widened box has to be retried against
          // everything already passed, because it now reaches further.
          index = 0;
          continue;
        }
        index += 1;
      }
      next.push(merged);
    }

    current = next;
  }

  return current;
}

/**
 * Is this region a thin line — kept whatever its area?
 *
 * Exported because the filter is the row's whole point, and a test that
 * asserted it only through the end-to-end result would pass just as well with
 * the allowance deleted, so long as the fixture happened to be large.
 */
export function isThinLine(region: Rectangle): boolean {
  const thickness = Math.min(region.width, region.height);
  const length = Math.max(region.width, region.height);
  if (thickness > THIN_LINE_MAXIMUM_THICKNESS) {
    return false;
  }
  return length >= thickness * THIN_LINE_ASPECT_RATIO;
}

/**
 * Does this region survive the size filter?
 *
 * **Area, or the thin-line allowance. Never the shorter side.** The header of
 * this file is the argument; this is the one line it is about.
 */
export function survivesSizeFilter(region: Rectangle, minimumArea: number): boolean {
  return region.width * region.height >= minimumArea || isThinLine(region);
}

/**
 * Extract the changed regions from a mask.
 *
 * Ordered **largest first by area**, which is the order §1.9 promises and the
 * order the region cap depends on: a truncated result drops the smallest ones,
 * since the list is ordered largest first.
 *
 * The cap itself is deliberately **not** applied here. Truncation is a fact
 * about what the caller was given, and it belongs beside the crops that were
 * actually written — otherwise a region could be dropped here and the count
 * reported downstream would describe a list nobody has.
 */
export function extractRegions(mask: DiffMask, options: ExtractionOptions): ChangedRegion[] {
  const merged = merge(components(mask), options.mergeDistance);
  const kept = merged.filter((region) => survivesSizeFilter(region, options.minimumArea));

  return kept.sort((a, b) => {
    const byArea = b.width * b.height - a.width * a.height;
    // Ties broken by position, so the order is the same on two runs over the
    // same mask. Without it the order is whatever the flood fill happened to
    // produce, and a test asserting "the first region" would be flaky.
    if (byArea !== 0) return byArea;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });
}
