import assert from 'node:assert/strict';
import test from 'node:test';

import { downscale } from '../../src/capture/image.ts';
import { formatLadder, sweepLadder } from '../../src/capture/ladder.ts';
import {
  bestSurvivingRow,
  countDistinctRuns,
  featureSurvives,
  strokeContrast,
} from '../../src/capture/legibility.ts';
import { TIER_LONGEST_EDGE, estimateTokens } from '../../src/capture/tiers.ts';
import {
  coarseTextComb,
  field,
  fineTextComb,
  hairlineRule,
  ladderFixtures,
  layoutBlock,
  paint,
} from '../helpers/ladder-fixtures.ts';

/**
 * The resolution-ladder study, arithmetic half (`MILESTONES.md` #34).
 *
 * **Everything here runs everywhere**, including on a hosted runner with no
 * browser: it measures the shipped downscale against drawn fixtures of known
 * geometry. The half that renders real letterforms is in
 * `tests/capture/ladder-rendered.test.ts` and skips where there is no browser.
 *
 * ── What this suite establishes, stated before the assertions ───────────
 *
 * The claim the tiers rest on is that **text legibility breaks at a higher
 * resolution than layout critique does**. These tests do not measure
 * legibility — nothing automated can — they measure the physical structure
 * legibility depends on, and they establish the **ordering**: the resolution
 * at which fine detail is destroyed is higher than the one at which a
 * block-scale feature is. See `legibility.ts` for what the proxies do not
 * establish.
 */

/** The ladder the study sweeps, spanning well below and above every rung. */
const STUDY_RUNGS = [512, 768, 1024, 1280, 1568, 1920, 2240, 2576, 3200] as const;

/**
 * The fraction of the original ink a mark must keep to count as present.
 *
 * Stated here rather than in the module, because "how faint is gone" is the
 * study's question and a constant hidden in the instrument would be the
 * instrument deciding the answer.
 */
const INK = 0.5;

// ── The harness reports what it claims to report ──────────────────────────

test('a rung records the dimensions, the bytes, the ratio and the token cost', () => {
  const source = layoutBlock().image;
  const [rung] = sweepLadder(source, [1600]);
  assert.ok(rung);

  // 3200 wide capped to 1600 is exactly half.
  assert.equal(rung.width, 1600);
  assert.equal(rung.height, 900);
  assert.equal(rung.ratio, 0.5);
  // The token estimate is the version's formula over the SHRUNK dimensions,
  // not the source ones — a rung that reported the source's cost would make
  // every rung look identically expensive, which is the whole quantity the
  // ladder exists to compare.
  assert.equal(rung.estimatedTokens, estimateTokens(1600, 900));
  assert.ok(rung.bytes > 0);
});

test('a picture already inside the rung is reported as unshrunk, at ratio one', () => {
  // Dies if the harness computes a ratio from the cap rather than from what
  // actually happened: 400px capped at 1024 is not a 2.56x upscale, it is
  // untouched, and `width === source_width` has to keep meaning that (§1.7).
  const small = field(400, 300);
  const [rung] = sweepLadder(small, [1024]);
  assert.ok(rung);
  assert.equal(rung.width, 400);
  assert.equal(rung.height, 300);
  assert.equal(rung.ratio, 1);
});

test('the ladder table is readable and quotes every rung it swept', () => {
  const table = formatLadder(sweepLadder(layoutBlock().image, [1024, 2576]));
  assert.match(table, /long edge/);
  assert.match(table, /\| 1024 \|/);
  assert.match(table, /\| 2576 \|/);
});

// ── The instruments measure what they say, and can report failure ─────────

test('stroke contrast is one for untouched ink and falls as a mark is averaged away', () => {
  const image = field(100, 20);
  paint(image, 50, 0, 1, 20);
  // Untouched: the mark is still fully black against white.
  assert.equal(strokeContrast(image, 10, 255, 0), 1);

  // Shrunk to a quarter: a one-pixel mark now covers a quarter of a
  // destination pixel, and the box filter averages the rest of the pixel's
  // white into it.
  const shrunk = downscale(image, 25);
  const faded = strokeContrast(shrunk, 2, 255, 0);
  assert.ok(faded < 1, `a shrunk hairline reported full contrast (${String(faded)})`);
  assert.ok(faded > 0, 'a shrunk hairline vanished entirely, which a box filter cannot do');
});

test('an off-picture row is REFUSED rather than read as a destroyed feature', () => {
  // The defect this guard was written for, and it was a real one found while
  // building this study: a scan over a row past the bottom edge finds no ink,
  // and "no ink" is indistinguishable from "the mark was averaged away". A
  // study whose row arithmetic drifted by one would have reported a destroyed
  // feature and been believed.
  //
  // Dies if `requireRow` is removed from either scanner: without it both calls
  // below return a number instead of throwing.
  const image = field(100, 20);
  paint(image, 50, 0, 1, 20);

  assert.throws(() => strokeContrast(image, 20, 255, 0), RangeError);
  assert.throws(() => countDistinctRuns(image, 20, 255, 0, INK), RangeError);
  assert.throws(() => strokeContrast(image, -1, 255, 0), RangeError);
  // The last row on the picture is still on it.
  assert.doesNotThrow(() => strokeContrast(image, 19, 255, 0));
});

test('the run count falls when neighbouring marks merge — the gap-closing mechanism', () => {
  // Ten marks, one pixel each, one pixel apart.
  const image = field(100, 10);
  for (let index = 0; index < 10; index++) paint(image, 10 + index * 2, 0, 1, 10);
  assert.equal(countDistinctRuns(image, 5, 255, 0, INK), 10);

  // Shrunk until each destination pixel spans a mark AND its gap: the ink is
  // still there, the gaps are not. This is the property the study turns on —
  // a measurement of darkness alone would call this survival.
  //
  // The row is found rather than computed, for the reason `bestSurvivingRow`
  // exists: a 100x10 picture capped at 25 is 25x3, so the row the marks were
  // drawn on is not the row they land on.
  const merged = downscale(image, 25);
  const runs = bestSurvivingRow(merged, 255, 0, INK).runs;
  assert.ok(runs < 10, `the gaps did not close (${String(runs)} runs survived a 4x shrink)`);
});

test('featureSurvives takes its threshold from the caller, not from the module', () => {
  const image = field(100, 20);
  paint(image, 50, 0, 1, 20);
  const shrunk = downscale(image, 50);
  const contrast = strokeContrast(shrunk, 5, 255, 0);

  // The same picture is "surviving" or not depending only on the bar asked
  // for. Dies if a constant is baked into the module, which would be the
  // instrument quietly deciding the study's result.
  assert.equal(featureSurvives(shrunk, 5, 255, 0, contrast - 0.01), true);
  assert.equal(featureSurvives(shrunk, 5, 255, 0, contrast + 0.01), false);
});

test('bestSurvivingRow finds the mark without being told which row it is on', () => {
  const image = field(200, 100);
  for (let index = 0; index < 8; index++) paint(image, 20 + index * 4, 60, 2, 20);
  // The marks are on rows 60-79 and nothing says so. A study that computed a
  // row from the ratio would read an empty row and report zero.
  const best = bestSurvivingRow(image, 255, 0, INK);
  assert.equal(best.runs, 8);
  assert.ok(best.row >= 60 && best.row < 80, `found the marks on row ${String(best.row)}`);
});

// ── ⚠️ THE FIXTURES MUST BE ABLE TO FAIL ──────────────────────────────────

test('EVERY fixture is destroyed somewhere on the ladder except the layout control', () => {
  // The house rule this study is most at risk from: a page that looks fine at
  // every rung proves nothing. This asserts each text-scale fixture genuinely
  // degrades, so a passing study cannot be a study that measured nothing.
  for (const fixture of [fineTextComb(), coarseTextComb(), hairlineRule()]) {
    const rungs = sweepLadder(fixture.image, [...STUDY_RUNGS]);
    const first = rungs[0];
    const last = rungs[rungs.length - 1];
    assert.ok(first && last);

    const worst = bestSurvivingRow(first.image, 255, 0, INK);
    const bestCase = bestSurvivingRow(last.image, 255, 0, INK);
    const degraded = worst.runs < bestCase.runs || worst.contrast < bestCase.contrast;
    assert.ok(
      degraded,
      `"${fixture.name}" measured identically at 512 and at 3200, so it cannot distinguish any rung`,
    );
  }
});

test('the layout control survives the WHOLE ladder, including the bottom of it', () => {
  // The control that makes the failures above mean something. If this also
  // degraded, the study would have measured "shrinking destroys things"
  // rather than the ordering the claim is about.
  const block = layoutBlock();
  for (const rung of sweepLadder(block.image, [...STUDY_RUNGS])) {
    const best = bestSurvivingRow(rung.image, 255, 0, INK);
    assert.equal(
      best.runs,
      1,
      `the block stopped being one solid feature at ${String(rung.longestEdge)}px`,
    );
    assert.ok(
      best.contrast > 0.6,
      `the block faded to ${best.contrast.toFixed(3)} at ${String(rung.longestEdge)}px`,
    );
  }
});

// ── THE CLAIM ITSELF ──────────────────────────────────────────────────────

test('THE CLAIM: fine text detail is destroyed at a rung where layout is untouched', () => {
  // `tiers.ts`: "text legibility breaks at a higher resolution than layout
  // critique does." This is that ordering, measured on one ladder with one
  // instrument.
  const fine = fineTextComb();
  const block = layoutBlock();

  const atDefault = TIER_LONGEST_EDGE.default;
  const [fineRung] = sweepLadder(fine.image, [atDefault]);
  const [blockRung] = sweepLadder(block.image, [atDefault]);
  assert.ok(fineRung && blockRung);

  const fineAt = bestSurvivingRow(fineRung.image, 255, 0, INK);
  const blockAt = bestSurvivingRow(blockRung.image, 255, 0, INK);

  // The fine comb has lost most of its 40 marks; the block is untouched.
  assert.ok(
    fineAt.runs < 40 * 0.5,
    `fine detail kept ${String(fineAt.runs)} of 40 marks at the default rung, so the two scales did not come apart`,
  );
  assert.equal(blockAt.runs, 1, 'the layout block did not survive the default rung');
  assert.equal(blockAt.contrast, 1, 'the layout block lost contrast at the default rung');
});

test('THE MECHANISM: the failure point moves with feature size, not with the rung', () => {
  // The difference between a measurement and a coincidence of one fixture's
  // geometry. The coarse comb is the same structure three times larger, and it
  // survives rungs the fine one does not.
  const fine = fineTextComb();
  const coarse = coarseTextComb();

  for (const edge of [1280, 1568, 1920, 2240, 2576]) {
    const [fineRung] = sweepLadder(fine.image, [edge]);
    const [coarseRung] = sweepLadder(coarse.image, [edge]);
    assert.ok(fineRung && coarseRung);

    const fineRuns = bestSurvivingRow(fineRung.image, 255, 0, INK).runs;
    const coarseRuns = bestSurvivingRow(coarseRung.image, 255, 0, INK).runs;
    assert.ok(
      coarseRuns > fineRuns,
      `at ${String(edge)}px the coarse comb (${String(coarseRuns)}) did not outlast the fine one (${String(fineRuns)})`,
    );
  }
});

test('THE LAW: structure is retained when a feature keeps about two and a half destination pixels per period', () => {
  // Swept across stroke widths, the threshold is a property of the DESTINATION
  // PERIOD rather than of any rung: a feature whose period survives as ~2.4
  // destination pixels keeps its structure, and one below ~1.6 does not,
  // whatever its source size. That is what makes the ordering above a sampling
  // law rather than an artefact of two chosen fixtures.
  //
  // Asserted as two bounds with a deliberate gap between them, and the gap is a
  // finding rather than a hedge. **Retention is not monotonic in the ratio**:
  // a 2px stroke keeps 100% at a destination period of 2.8 and 3.0, drops to
  // 80% at 3.2, and returns to 100% at 3.6. That is the phase between the marks
  // and the sample grid, not resolution — so pinning an exact count anywhere
  // near the transition would assert an incidental label, which is the failure
  // this project has hit before. The bounds below are therefore stated where
  // the property holds regardless of phase.
  const marks = 30;
  for (const strokeWidth of [1, 2, 3, 4, 6]) {
    const period = strokeWidth * 2;
    const source = field(2400, 200);
    for (let index = 0; index < marks; index++) {
      paint(source, 100 + index * period, 50, strokeWidth, 100);
    }

    for (const ratio of [0.2, 0.25, 0.3, 0.4, 0.5, 0.8]) {
      const [rung] = sweepLadder(source, [Math.round(2400 * ratio)]);
      assert.ok(rung);
      const destinationPeriod = period * rung.ratio;
      const retained = bestSurvivingRow(rung.image, 255, 0, INK).runs / marks;

      // Comfortably above the limit: most of the structure is always kept,
      // whatever the phase. Below 0.75 would mean the filter is destroying
      // detail it has the resolution to carry.
      if (destinationPeriod >= 2.4) {
        assert.ok(
          retained >= 0.75,
          `a ${String(strokeWidth)}px stroke at ${destinationPeriod.toFixed(2)} destination pixels per period kept only ${(retained * 100).toFixed(0)}%`,
        );
      }
      // Comfortably below it: structure is always lost, whatever the phase.
      if (destinationPeriod <= 1.5) {
        assert.ok(
          retained < 1,
          `a ${String(strokeWidth)}px stroke kept ALL its structure at ${destinationPeriod.toFixed(2)} destination pixels per period, which is below the sampling limit`,
        );
      }
    }
  }
});

test('retention is NOT monotonic near the sampling limit — the phase effect, pinned', () => {
  // Recorded as its own test because it is the single most misleading thing
  // about these measurements: a study that swept a few ratios and drew a line
  // through them would report a threshold that moves depending on which ratios
  // it happened to pick.
  //
  // A two-pixel stroke, four-pixel period, swept across ratios that put the
  // destination period on both sides of 3. If this ever becomes monotonic the
  // resampler has changed and the study's bounds need re-deriving.
  const marks = 30;
  const period = 4;
  const source = field(2400, 200);
  for (let index = 0; index < marks; index++) paint(source, 100 + index * period, 50, 2, 100);

  const retained = [0.7, 0.8, 0.9].map((ratio) => {
    const [rung] = sweepLadder(source, [Math.round(2400 * ratio)]);
    assert.ok(rung);
    return bestSurvivingRow(rung.image, 255, 0, INK).runs / marks;
  });

  const [lower, middle, upper] = retained;
  assert.ok(lower !== undefined && middle !== undefined && upper !== undefined);
  // The dip: more resolution retained LESS structure. Dies if the resampler
  // stops aliasing, which would be a real and welcome change worth noticing.
  assert.ok(
    middle < lower && middle < upper,
    `expected a phase dip at 0.8, got ${lower.toFixed(2)}, ${middle.toFixed(2)}, ${upper.toFixed(2)}`,
  );
});

test('a hairline fades rather than vanishing, monotonically with the rung', () => {
  // The case that stops "layout survives" being stated too simply: a one-pixel
  // border is a layout feature by role with the physical size of text detail.
  // It never disappears — the box filter cannot discard it — but it is a
  // progressively fainter grey, and below the ink threshold it stops counting
  // as a mark at all.
  const rule = hairlineRule();
  const contrasts = sweepLadder(rule.image, [...STUDY_RUNGS]).map(
    (rung) => bestSurvivingRow(rung.image, 255, 0, INK).contrast,
  );

  for (let index = 1; index < contrasts.length; index++) {
    const previous = contrasts[index - 1] ?? 0;
    const current = contrasts[index] ?? 0;
    assert.ok(
      current >= previous - 1e-9,
      `contrast fell from ${previous.toFixed(3)} to ${current.toFixed(3)} while the rung went UP`,
    );
  }

  const [lowest] = contrasts;
  assert.ok(lowest !== undefined && lowest > 0, 'the hairline vanished, which averaging cannot do');
  assert.ok(lowest < INK, `the hairline kept ${lowest.toFixed(3)} of its ink at the bottom rung`);
});

// ── What the rungs cost, which is the other half of choosing them ─────────

test('each rung up the ladder costs materially more than the one below it', () => {
  // The reason a low default is the lever: the cost is quadratic in the long
  // edge, so a rung is not a small increment. Asserted as a ratio rather than
  // as figures, so it survives the rungs moving.
  const rungs = sweepLadder(
    layoutBlock().image,
    [TIER_LONGEST_EDGE.default, TIER_LONGEST_EDGE.detail, TIER_LONGEST_EDGE.max],
  );
  const [cheap, middle, dear] = rungs;
  assert.ok(cheap && middle && dear);

  assert.ok(
    middle.estimatedTokens > cheap.estimatedTokens * 1.5,
    `the detail rung costs ${String(middle.estimatedTokens)} against the default's ${String(cheap.estimatedTokens)}`,
  );
  assert.ok(
    dear.estimatedTokens > middle.estimatedTokens * 1.5,
    `the max rung costs ${String(dear.estimatedTokens)} against the detail rung's ${String(middle.estimatedTokens)}`,
  );
});

test('every study fixture sweeps every rung without the harness refusing anything', () => {
  // The harness must not be the thing that fails: a study whose measurement
  // throws on one fixture silently measures a smaller set than it reports.
  for (const fixture of ladderFixtures()) {
    const rungs = sweepLadder(fixture.image, [...STUDY_RUNGS]);
    assert.equal(rungs.length, STUDY_RUNGS.length, `${fixture.name} did not sweep every rung`);
    for (const rung of rungs) {
      assert.ok(rung.width > 0 && rung.height > 0, `${fixture.name} produced a zero dimension`);
      assert.ok(rung.bytes > 0, `${fixture.name} produced an empty file at ${String(rung.longestEdge)}`);
    }
  }
});
