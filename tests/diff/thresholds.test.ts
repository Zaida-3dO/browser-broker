import assert from 'node:assert/strict';
import test from 'node:test';

import { computeMask } from '../../src/diff/mask.ts';
import { extractRegions } from '../../src/diff/regions.ts';
import { DEFAULT_DIFF_SETTINGS } from '../../src/diff/settings.ts';
import {
  BLACK,
  FAINT_GREY,
  WHITE,
  changedPairs,
  cleanPair,
  filled,
  withRectangle,
} from '../helpers/images.ts';

/**
 * Threshold tuning (`MILESTONES.md` #43): a fixture set of known-clean and
 * known-changed pairs, and **a test proving a real change is not swallowed**.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN OF THIS FILE MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * #43's own words on why this file is written the way it is:
 *
 * > **Any threshold can be raised until nothing ever fails, and a comparison
 * > that reports "nothing changed" is indistinguishable from one that is
 * > working.** The fixture set has to contain a change small enough to be
 * > interesting and prove it survives the threshold in force.
 *
 * **What it means:** the comparison and the extraction have been run end to
 * end, at the shipped default settings, over five changes built from the four
 * shapes #43 names — thin lines, border widths, focus rings and underlines —
 * and each one produced a region **at the place the change was drawn**. The
 * clean pair produced none. Every fixture is drawn in code, so "this is a
 * two-pixel underline" is a fact about the input rather than a claim in a
 * comment.
 *
 * **What it does not mean:** that the defaults are right for real browser
 * output. These fixtures are flat colour on flat colour, which is the easy
 * case — real page pixels carry sub-pixel text rendering and image compression
 * that these do not. The `comparisons` table exists precisely because that
 * question is answered by reading what real diffs did (§1.9), and `broker
 * diffs` is what reads it. This suite proves the numbers are not *obviously*
 * wrong; it cannot prove they are right.
 *
 * **It also cannot prove a threshold nobody has raised yet is safe.** The
 * assertions below are at the shipped defaults. The final test in this file is
 * the one that fails when somebody raises the tolerance far enough to swallow
 * a real change — it is the negative direction #43 says is the one that
 * matters.
 */

const SETTINGS = DEFAULT_DIFF_SETTINGS;

function regionsFor(
  earlier: Parameters<typeof computeMask>[0],
  current: Parameters<typeof computeMask>[1],
  tolerance = SETTINGS.colourTolerance,
) {
  const mask = computeMask(earlier, current, { colourTolerance: tolerance });
  return {
    mask,
    regions: extractRegions(mask, {
      mergeDistance: SETTINGS.regionMergeDistance,
      minimumArea: SETTINGS.minimumRegionArea,
    }),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// The control: known-clean
// ══════════════════════════════════════════════════════════════════════════

test('the same page twice reports no changed pixels and no regions', () => {
  const pair = cleanPair();
  const { mask, regions } = regionsFor(pair.earlier, pair.current);

  // Both halves. A comparison that reported changed pixels but filtered them
  // all away would satisfy the region assertion alone, and it is a different
  // bug — it would show up as a non-zero `changed_ratio` on every clean diff.
  assert.equal(mask.changedPixels, 0, pair.describes);
  assert.deepEqual(regions, []);
});

// ══════════════════════════════════════════════════════════════════════════
// Known-changed: every shape the size filter is most likely to eat
// ══════════════════════════════════════════════════════════════════════════

for (const pair of changedPairs()) {
  test(`a real change survives the threshold in force: ${pair.name}`, () => {
    const { mask, regions } = regionsFor(pair.earlier, pair.current);
    const changedAt = pair.changedAt;
    assert.notEqual(changedAt, null, 'a known-changed fixture must say where it changed');
    if (changedAt === null) return;

    assert.ok(
      mask.changedPixels > 0,
      `${pair.name}: the comparison found no changed pixels at all. ${pair.describes}`,
    );
    assert.ok(
      regions.length > 0,
      `${pair.name}: pixels changed but no region survived filtering, which is the threshold swallowing a real change. ${pair.describes}`,
    );

    // **Where**, not merely whether. A test asserting only "a region was
    // found" passes on a comparison that reports a region in the wrong place,
    // which is the failure a person reviewing crops would waste the most time
    // on. The region must contain the rectangle the fixture drew.
    const covering = regions.find(
      (region) =>
        region.x <= changedAt.x &&
        region.y <= changedAt.y &&
        region.x + region.width >= changedAt.x + changedAt.width &&
        region.y + region.height >= changedAt.y + changedAt.height,
    );
    assert.notEqual(
      covering,
      undefined,
      `${pair.name}: a region was reported but none of them covers where the change was drawn ` +
        `(${JSON.stringify(changedAt)}); got ${JSON.stringify(regions.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })))}`,
    );
  });
}

test('the fixture set contains a change below the default minimum area', () => {
  // #43 asks for "a change small enough to be interesting". This asserts the
  // fixture set actually has one — without it, every assertion above could be
  // satisfied by five large blocks and the suite would prove nothing about the
  // size filter it exists to exercise.
  const small = changedPairs().filter(
    (pair) =>
      pair.changedAt !== null &&
      pair.changedAt.width * pair.changedAt.height < SETTINGS.minimumRegionArea,
  );

  assert.ok(
    small.length > 0,
    'no fixture is below the minimum area, so nothing here exercises the thin-line allowance',
  );
});

// ══════════════════════════════════════════════════════════════════════════
// The negative direction — the one #43 says matters
// ══════════════════════════════════════════════════════════════════════════

test('a raised tolerance swallows a low-contrast change that the default catches', () => {
  // The mechanism #43 warns about, demonstrated rather than described: a faint
  // grey block on white, at the contrast the default still reports. At the
  // default it is a change; one step of tolerance up it is not, and the
  // comparison reports a clean page.
  //
  // **This test is what makes every assertion above mean something.** Without
  // it, "the defaults catch every fixture" is a claim that would be equally
  // true of a tolerance of zero, and a raised one would go unnoticed until a
  // real regression went unreported. The single-character change it catches is
  // raising `colourTolerance` in `DEFAULT_DIFF_SETTINGS`: the first assertion
  // fails the moment the default stops catching this.
  const page = filled(400, 200, WHITE);
  const faint = withRectangle(page, { x: 50, y: 50, width: 100, height: 40 }, FAINT_GREY);

  const atDefault = regionsFor(page, faint);
  assert.ok(
    atDefault.regions.length > 0,
    'the default tolerance must catch this contrast, or the fixture is not low-contrast enough to be interesting',
  );

  const raised = regionsFor(page, faint, 0.3);
  assert.equal(
    raised.regions.length,
    0,
    'a tolerance of 0.3 is expected to swallow this; if it does not, this test is not demonstrating the failure it claims to',
  );
});

test('a high-contrast change survives even a raised tolerance', () => {
  // The other side of the same coin, and the reason the test above is not an
  // argument for a tolerance of zero. A black block on white is caught at
  // almost any setting, so the tolerance is a dial for faint changes rather
  // than a switch that turns the feature off.
  const page = filled(400, 200, WHITE);
  const solid = withRectangle(page, { x: 50, y: 50, width: 100, height: 40 }, BLACK);

  const raised = regionsFor(page, solid, 0.9);
  assert.ok(raised.regions.length > 0);
});

test('the default tolerance does not report a change fainter than roughly grey 225 on white', () => {
  // **A limitation, asserted rather than described**, and the honest
  // counterweight to every "a real change survives" test above.
  //
  // Measured while building these fixtures (the table on `FAINT_GREY` records
  // the sweep): at the shipped default, a grey-230 block on white produces no
  // changed pixels at all. So the feature does not catch every visible change
  // — a faint tint, a very light hover state, a near-white border — and a
  // caller reading `changed: false` is reading "nothing above this threshold
  // moved" rather than "nothing moved".
  //
  // Written as a test rather than a comment so that if somebody lowers the
  // default to catch these, this fails and the claim gets corrected with it.
  const page = filled(400, 200, WHITE);
  const veryFaint = withRectangle(
    page,
    { x: 50, y: 50, width: 100, height: 40 },
    { red: 230, green: 230, blue: 230, alpha: 255 },
  );

  const { mask } = regionsFor(page, veryFaint);
  assert.equal(mask.changedPixels, 0);
});

test('the shipped default tolerance is the comparison library own default', () => {
  // §6.2: the tolerance "is the diff library's own default, which is a better
  // starting position than a number invented here precisely because it is not
  // one". Pinned, so changing it is a decision taken in a diff with this
  // sentence attached rather than a number somebody nudged.
  assert.equal(SETTINGS.colourTolerance, 0.1);
});
