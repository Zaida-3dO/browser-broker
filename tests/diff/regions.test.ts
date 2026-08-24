import assert from 'node:assert/strict';
import test from 'node:test';

import type { DiffMask } from '../../src/diff/mask.ts';
import {
  THIN_LINE_ASPECT_RATIO,
  THIN_LINE_MAXIMUM_THICKNESS,
  extractRegions,
  isThinLine,
  survivesSizeFilter,
} from '../../src/diff/regions.ts';

/**
 * Changed-region extraction, and the filter that is the point of #41.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN OF THIS FILE MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **What it means:** the filter has been asserted against the four shapes #41
 * and §6.2 name — a one-pixel line across a wide page, a short thin underline,
 * a speck, and an ordinary block — and against the rule the milestone forbids.
 * `filtersOnShorterSide` below is a **deliberately-failing control**: it is the
 * rejected rule, implemented, and a test asserts it disagrees with the shipped
 * filter on the exact fixture that matters. If somebody reverts the filter to
 * the shorter side, that test fails rather than passing quietly.
 *
 * **What it does not mean:** that the regions are correct on a real page. These
 * run over hand-built masks, where every changed pixel was placed on purpose.
 * `tests/diff/thresholds.test.ts` is what runs the same extraction over masks
 * produced by the real comparison of real fixture images.
 *
 * **The single-character changes each assertion catches** are named per test,
 * because "it would fail if the behaviour regressed" is not a claim anybody can
 * check without them.
 */

/** A mask with the given pixels set, so a test names its own input exactly. */
function maskWith(width: number, height: number, set: readonly [number, number][]): DiffMask {
  const changed = new Uint8Array(width * height);
  for (const [x, y] of set) {
    changed[y * width + x] = 1;
  }
  return { width, height, changed, changedPixels: set.length };
}

/** A mask with a solid rectangle of changed pixels. */
function maskWithRectangle(
  width: number,
  height: number,
  rectangle: { x: number; y: number; width: number; height: number },
): DiffMask {
  const points: [number, number][] = [];
  for (let y = rectangle.y; y < rectangle.y + rectangle.height; y += 1) {
    for (let x = rectangle.x; x < rectangle.x + rectangle.width; x += 1) {
      points.push([x, y]);
    }
  }
  return maskWith(width, height, points);
}

const DEFAULT_MINIMUM_AREA = 64;
const DEFAULT_MERGE_DISTANCE = 8;

// ══════════════════════════════════════════════════════════════════════════
// The filter — the rule, and the rule it must not be
// ══════════════════════════════════════════════════════════════════════════

/**
 * **The rejected rule, implemented as a control.**
 *
 * #41: filtered "on area with a thin-line allowance — **not on the shorter
 * side**, which discards a one-pixel line across a wide page". This is that
 * shorter-side rule, written out so a test can assert the shipped filter
 * differs from it rather than merely asserting the shipped filter's output.
 *
 * Without this control, every assertion below would pass on a filter that
 * happened to keep the fixture for the wrong reason.
 */
function filtersOnShorterSide(
  region: { width: number; height: number },
  minimumSide: number,
): boolean {
  return Math.min(region.width, region.height) >= minimumSide;
}

test('a one-pixel line across a wide page survives the shipped filter and fails the rejected one', () => {
  // The exact shape #41 names. 720 wide, 1 tall: area 720, shorter side 1.
  const rule = { x: 40, y: 70, width: 720, height: 1 };

  assert.equal(
    survivesSizeFilter(rule, DEFAULT_MINIMUM_AREA),
    true,
    'a one-pixel rule across a page must survive — it is a border, an underline or a horizontal rule',
  );
  // The control. A shorter-side filter with any minimum above one discards it,
  // which is the whole reason the row spells out what the rule must not be.
  assert.equal(
    filtersOnShorterSide(rule, 8),
    false,
    'the control is meant to reject this; if it accepts, the control is wrong and the test above proves nothing',
  );
});

test('a short thin underline survives only because of the thin-line allowance', () => {
  // Area 44, which is below the default minimum of 64. Area alone eats it.
  const underline = { x: 40, y: 122, width: 22, height: 2 };

  assert.ok(
    underline.width * underline.height < DEFAULT_MINIMUM_AREA,
    'the fixture must be below the minimum area, or this test does not exercise the allowance at all',
  );
  assert.equal(
    isThinLine(underline),
    true,
    'a 22x2 underline is a line; deleting the allowance makes this false and the next assertion fails with it',
  );
  assert.equal(survivesSizeFilter(underline, DEFAULT_MINIMUM_AREA), true);
});

test('a speck is discarded — the filter is not simply "keep everything"', () => {
  // 3x3: area 9, and square, so neither the area rule nor the allowance keeps
  // it. Without this, a filter that returned true unconditionally would pass
  // every other assertion in this file.
  const speck = { x: 10, y: 10, width: 3, height: 3 };

  assert.equal(isThinLine(speck), false);
  assert.equal(survivesSizeFilter(speck, DEFAULT_MINIMUM_AREA), false);
});

test('a thick region is not a line, however long it is', () => {
  // Thickness above the maximum. The allowance is for lines, and a block that
  // qualified "as a line" would make the allowance mean nothing — it would keep
  // every landscape rectangle regardless of area.
  const block = {
    x: 0,
    y: 0,
    width: (THIN_LINE_MAXIMUM_THICKNESS + 1) * THIN_LINE_ASPECT_RATIO * 4,
    height: THIN_LINE_MAXIMUM_THICKNESS + 1,
  };

  assert.equal(isThinLine(block), false);
  // It still survives, on area — which is the correct outcome by the other
  // route, and is why this test asserts `isThinLine` rather than the filter.
  assert.equal(survivesSizeFilter(block, DEFAULT_MINIMUM_AREA), true);
});

test('a vertical line is a line too, not only a horizontal one', () => {
  // A border down the side of a block: 1 wide, 32 tall, area 32 — below the
  // minimum. If the allowance compared width to height rather than the smaller
  // to the larger, this would be false and a border change would vanish.
  const border = { x: 160, y: 140, width: 1, height: 32 };

  assert.equal(isThinLine(border), true);
  assert.equal(survivesSizeFilter(border, DEFAULT_MINIMUM_AREA), true);
});

test('the aspect ratio is a threshold, and a region just under it is not a line', () => {
  const thickness = 2;
  // One shorter than the ratio requires. This pins the comparison as
  // "at least", so changing it to a strict inequality — a single character —
  // fails the pair of assertions below.
  const justUnder = {
    x: 0,
    y: 0,
    width: thickness * THIN_LINE_ASPECT_RATIO - 1,
    height: thickness,
  };
  const exactly = { x: 0, y: 0, width: thickness * THIN_LINE_ASPECT_RATIO, height: thickness };

  assert.equal(isThinLine(justUnder), false);
  assert.equal(isThinLine(exactly), true);
});

test('the minimum area is a threshold, and a region exactly at it survives', () => {
  // A square at exactly the default minimum area. Chosen square so the
  // allowance cannot be what keeps it — the assertion below pins that — which
  // makes this a test of the area comparison and nothing else.
  const exactly = { x: 0, y: 0, width: 8, height: 8 };
  assert.equal(isThinLine(exactly), false, 'a square is not a line, or this tests the wrong rule');
  assert.equal(survivesSizeFilter(exactly, 64), true);

  // One pixel of area smaller, and it goes. This is the pair that pins the
  // comparison as "at least": flipping it to a strict inequality fails the
  // assertion above, and dropping the comparison entirely fails this one.
  const justUnder = { x: 0, y: 0, width: 8, height: 7 };
  assert.equal(isThinLine(justUnder), false);
  assert.equal(survivesSizeFilter(justUnder, 64), false);
});

// ══════════════════════════════════════════════════════════════════════════
// Connected components and merging
// ══════════════════════════════════════════════════════════════════════════

test('two changed areas far apart are two regions', () => {
  const mask = maskWithRectangle(400, 200, { x: 10, y: 10, width: 20, height: 20 });
  for (let y = 150; y < 170; y += 1) {
    for (let x = 300; x < 320; x += 1) {
      mask.changed[y * 400 + x] = 1;
    }
  }

  const regions = extractRegions(mask, {
    mergeDistance: DEFAULT_MERGE_DISTANCE,
    minimumArea: DEFAULT_MINIMUM_AREA,
  });

  assert.equal(regions.length, 2);
});

test('two changed areas within the merge distance become one region', () => {
  // Two 20x20 blocks with a four-pixel gap, under a merge distance of eight.
  const mask = maskWithRectangle(400, 200, { x: 10, y: 10, width: 20, height: 20 });
  for (let y = 10; y < 30; y += 1) {
    for (let x = 34; x < 54; x += 1) {
      mask.changed[y * 400 + x] = 1;
    }
  }

  const regions = extractRegions(mask, { mergeDistance: 8, minimumArea: DEFAULT_MINIMUM_AREA });

  assert.equal(regions.length, 1);
  // The union spans both, which is what proves they merged rather than one
  // being filtered away — a length of one is satisfied by either.
  assert.deepEqual(
    { x: regions[0]?.x, y: regions[0]?.y, width: regions[0]?.width, height: regions[0]?.height },
    { x: 10, y: 10, width: 44, height: 20 },
  );
  // Changed pixels are summed across the merge: 400 + 400.
  assert.equal(regions[0]?.changedPixels, 800);
});

test('a merge distance of zero keeps two adjacent-but-separate areas apart', () => {
  const mask = maskWithRectangle(400, 200, { x: 10, y: 10, width: 20, height: 20 });
  for (let y = 10; y < 30; y += 1) {
    for (let x = 34; x < 54; x += 1) {
      mask.changed[y * 400 + x] = 1;
    }
  }

  // The same input as the test above under a different setting. Two tests over
  // one mask is what makes the merge distance demonstrably the thing doing the
  // work, rather than something else that happens to correlate with it.
  const regions = extractRegions(mask, { mergeDistance: 0, minimumArea: DEFAULT_MINIMUM_AREA });

  assert.equal(regions.length, 2);
});

test('merging is transitive: a chain of three closes into one region', () => {
  // Three blocks, each within the distance of the next but the outer two well
  // outside each other's reach. A single-pass merge reports two.
  const mask = maskWithRectangle(400, 200, { x: 10, y: 10, width: 20, height: 20 });
  const paint = (left: number): void => {
    for (let y = 10; y < 30; y += 1) {
      for (let x = left; x < left + 20; x += 1) {
        mask.changed[y * 400 + x] = 1;
      }
    }
  };
  paint(34);
  paint(58);

  const regions = extractRegions(mask, { mergeDistance: 8, minimumArea: DEFAULT_MINIMUM_AREA });

  assert.equal(regions.length, 1);
  assert.equal(regions[0]?.width, 68);
});

test('regions come back largest first', () => {
  const mask = maskWithRectangle(400, 200, { x: 10, y: 10, width: 12, height: 12 });
  for (let y = 100; y < 160; y += 1) {
    for (let x = 200; x < 300; x += 1) {
      mask.changed[y * 400 + x] = 1;
    }
  }

  const regions = extractRegions(mask, {
    mergeDistance: DEFAULT_MERGE_DISTANCE,
    minimumArea: DEFAULT_MINIMUM_AREA,
  });

  assert.equal(regions.length, 2);
  // Named by their actual geometry rather than compared to each other: an
  // assertion that region 0 is bigger than region 1 passes on a list of one
  // and on a list sorted by anything correlated with size.
  assert.equal(regions[0]?.width, 100);
  assert.equal(regions[0]?.height, 60);
  assert.equal(regions[1]?.width, 12);
  assert.equal(regions[1]?.height, 12);
});

test('an unchanged mask yields no regions', () => {
  const regions = extractRegions(maskWith(400, 200, []), {
    mergeDistance: DEFAULT_MERGE_DISTANCE,
    minimumArea: DEFAULT_MINIMUM_AREA,
  });
  assert.deepEqual(regions, []);
});

test('a single changed pixel is found as a component and then filtered away', () => {
  // Both halves matter. Extraction must see it — a flood fill that skipped
  // isolated pixels would silently lose one-pixel changes at the component
  // stage, where no filter setting could bring them back.
  const mask = maskWith(400, 200, [[100, 50]]);

  assert.deepEqual(
    extractRegions(mask, { mergeDistance: 0, minimumArea: DEFAULT_MINIMUM_AREA }),
    [],
    'a lone pixel is a speck and is filtered',
  );
  // With the filter off, the same mask yields exactly the one-pixel box —
  // which proves the component was found rather than never existing.
  const unfiltered = extractRegions(mask, { mergeDistance: 0, minimumArea: 0 });
  assert.equal(unfiltered.length, 1);
  assert.deepEqual(
    {
      x: unfiltered[0]?.x,
      y: unfiltered[0]?.y,
      width: unfiltered[0]?.width,
      height: unfiltered[0]?.height,
    },
    { x: 100, y: 50, width: 1, height: 1 },
  );
});

test('a diagonal chain of pixels is one region, and its box spans the whole chain', () => {
  // Four pixels stepping diagonally. Under four-connectivity these are four
  // components; the merge step at any distance of one or more closes them into
  // one, which is the arrangement described in `regions.ts`: conservative
  // connectivity plus a configurable merge, so joining is decided by a number
  // somebody can see rather than by the connectivity constant.
  const mask = maskWith(400, 200, [
    [100, 50],
    [101, 51],
    [102, 52],
    [103, 53],
  ]);

  const regions = extractRegions(mask, { mergeDistance: 1, minimumArea: 0 });

  assert.equal(regions.length, 1);
  // The box spans the chain rather than one step of it. A merge that stopped
  // after a single pass would report the first two joined and the rest apart.
  assert.deepEqual(
    { x: regions[0]?.x, y: regions[0]?.y, width: regions[0]?.width, height: regions[0]?.height },
    { x: 100, y: 50, width: 4, height: 4 },
  );
  // Every changed pixel is accounted for in the merged total, so nothing was
  // dropped on the way through the merge.
  assert.equal(regions[0]?.changedPixels, 4);
});

test('a region touching the image edge is bounded by the image, not beyond it', () => {
  const mask = maskWithRectangle(400, 200, { x: 0, y: 0, width: 30, height: 30 });

  const regions = extractRegions(mask, { mergeDistance: 0, minimumArea: DEFAULT_MINIMUM_AREA });

  assert.equal(regions.length, 1);
  assert.deepEqual(
    { x: regions[0]?.x, y: regions[0]?.y, width: regions[0]?.width, height: regions[0]?.height },
    { x: 0, y: 0, width: 30, height: 30 },
  );
});
