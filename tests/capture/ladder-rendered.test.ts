import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright-core';

import { decodePng, type RasterImage } from '../../src/capture/image.ts';
import { sweepLadder } from '../../src/capture/ladder.ts';
import { bestSurvivingRow } from '../../src/capture/legibility.ts';
import { TIER_LONGEST_EDGE } from '../../src/capture/tiers.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';

/**
 * The resolution study against **real rendered letterforms** (`MILESTONES.md`
 * #34).
 *
 * ── Where these run, stated so a green pipeline is not misread ──────────
 *
 * Every test here drives a real browser, so **every one of them skips when
 * there is not one** — per-test, with the reason named, never as a silent
 * `describe.skip`. Continuous integration runs on hosted runners with no
 * browser binary, so this whole file is local-only and **a green pipeline is
 * not evidence that any of it executed.** The arithmetic half of the study, in
 * `ladder.test.ts`, runs everywhere and carries the load-bearing assertions.
 *
 * ── Why this file exists when the drawn fixtures are exact ──────────────
 *
 * The drawn fixtures are provably one pixel wide, which is what lets a test
 * assert against geometry — but they are not letters. They model stroke width
 * and the gap between strokes, and they cannot speak to hinting, antialiasing
 * or the shapes real glyphs have. So this file renders actual prose at actual
 * font sizes and measures the **same instrument on the same ladder**, to check
 * that the synthetic result is not an artefact of drawn marks.
 *
 * Neither half is sufficient alone: the drawn fixtures are exact but
 * synthetic, these are real but only available where a browser is.
 *
 * ── Every browser this file starts is reaped, including on failure ──────
 *
 * A browser is a real process, and a suite that leaks one per run fills a
 * machine quietly. {@link render} closes the browser it started **in a
 * `finally`**, which is what makes a failing assertion above still reap it —
 * the ordinary reason a test leaks a process is that it only closed on the
 * success path.
 *
 * The close is scoped to the handle this file created, so it ends that browser
 * and its child processes and touches nothing else: no name match, no sweep
 * over every browser on the machine, nothing that could reach one somebody else
 * is using.
 */

const available = browserAvailable();

/**
 * A page of text at a stated size, rendered on a white field.
 *
 * **The word is chosen for its vertical stems.** A run of `l`, `i`, `m` and `n`
 * is the densest arrangement of near-identical vertical strokes that real prose
 * contains, which makes it the case where the gap between stems closes first —
 * the same structure the drawn comb models, in a real typeface.
 */
function textPage(fontSize: number): string {
  return [
    '<html><body style="margin:0;background:#fff">',
    `<div style="font:${String(fontSize)}px/1.5 Georgia,serif;padding:16px;color:#000">`,
    'Illinium milling illicit minimum',
    '</div></body></html>',
  ].join('');
}

/** Render one page at one viewport width and decode what the browser produced. */
async function render(html: string, viewportWidth: number): Promise<RasterImage> {
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutablePath(),
  });
  try {
    const page = await browser.newPage({ viewport: { width: viewportWidth, height: 220 } });
    await page.setContent(html);
    const shot = await page.screenshot({ type: 'png' });
    await page.close();
    return decodePng(new Uint8Array(shot));
  } finally {
    // Closing the browser ends the process tree it started. The `finally` is
    // what makes a failing assertion above still reap it.
    await browser.close();
  }
}

/** The fraction of the original ink a mark must keep to count as present. */
const INK = 0.5;

/** A page wide enough that all three shipped rungs are genuine downscales. */
const WIDE_VIEWPORT = 2560;

test(
  'rendered body copy loses stem separation at the default rung while a heading keeps it',
  { skip: available ? false : skipReason() },
  async () => {
    // The claim, on real letterforms rather than drawn marks: at one rung, the
    // fine scale is damaged and the coarse scale is not.
    const body = await render(textPage(12), WIDE_VIEWPORT);
    const heading = await render(textPage(32), WIDE_VIEWPORT);

    const bodySource = bestSurvivingRow(body, 255, 0, INK).runs;
    const headingSource = bestSurvivingRow(heading, 255, 0, INK).runs;
    assert.ok(bodySource > 10, `the body fixture rendered only ${String(bodySource)} stems`);
    assert.ok(
      headingSource > 10,
      `the heading fixture rendered only ${String(headingSource)} stems`,
    );

    const [bodyRung] = sweepLadder(body, [TIER_LONGEST_EDGE.default]);
    const [headingRung] = sweepLadder(heading, [TIER_LONGEST_EDGE.default]);
    assert.ok(bodyRung && headingRung);

    const bodyKept = bestSurvivingRow(bodyRung.image, 255, 0, INK).runs / bodySource;
    const headingKept = bestSurvivingRow(headingRung.image, 255, 0, INK).runs / headingSource;

    // Dies if the two scales stop coming apart — which is the whole claim.
    assert.ok(
      headingKept > bodyKept,
      `at the default rung the heading kept ${(headingKept * 100).toFixed(0)}% and the body ${(bodyKept * 100).toFixed(0)}%: the scales did not come apart`,
    );
    assert.ok(
      bodyKept < 0.9,
      `body copy kept ${(bodyKept * 100).toFixed(0)}% of its stems at the default rung, so this fixture cannot distinguish the rungs`,
    );
  },
);

test(
  'each rung up the ladder recovers more of the rendered text than the one below',
  { skip: available ? false : skipReason() },
  async () => {
    // The ordering that makes an escalation ladder worth having: a caller that
    // escalates because it could not read something must actually get more.
    const body = await render(textPage(12), WIDE_VIEWPORT);
    const source = bestSurvivingRow(body, 255, 0, INK).runs;
    assert.ok(source > 10);

    const kept = sweepLadder(body, [
      TIER_LONGEST_EDGE.default,
      TIER_LONGEST_EDGE.detail,
      TIER_LONGEST_EDGE.max,
    ]).map((rung) => bestSurvivingRow(rung.image, 255, 0, INK).runs / source);

    const [atDefault, atDetail, atMax] = kept;
    assert.ok(atDefault !== undefined && atDetail !== undefined && atMax !== undefined);

    assert.ok(
      atDetail > atDefault,
      `the detail rung (${(atDetail * 100).toFixed(0)}%) recovered no more than the default (${(atDefault * 100).toFixed(0)}%)`,
    );
    assert.ok(
      atMax >= atDetail,
      `the max rung (${(atMax * 100).toFixed(0)}%) recovered less than the detail rung (${(atDetail * 100).toFixed(0)}%)`,
    );
    // The top rung is the one that is meant to cost a reason because it gives
    // back everything.
    assert.equal(atMax, 1, `the max rung kept only ${(atMax * 100).toFixed(0)}% of the stems`);
  },
);

test(
  'a block-scale feature survives every rung on rendered output',
  { skip: available ? false : skipReason() },
  async () => {
    // The layout-side control, on real output: the scale a layout judgement is
    // made at is untouched by the whole ladder, which is what makes a low
    // default safe for the job the default is for.
    const page = [
      '<html><body style="margin:0;background:#fff">',
      '<div style="width:1200px;height:80px;background:#000;margin:40px"></div>',
      '</body></html>',
    ].join('');
    const block = await render(page, WIDE_VIEWPORT);

    for (const rung of sweepLadder(block, [512, 1024, 1568, 2576])) {
      const best = bestSurvivingRow(rung.image, 255, 0, INK);
      assert.equal(
        best.runs,
        1,
        `the block stopped being one solid feature at ${String(rung.longestEdge)}px`,
      );
      assert.ok(
        best.contrast > 0.9,
        `the block faded to ${best.contrast.toFixed(3)} at ${String(rung.longestEdge)}px`,
      );
    }
  },
);

test(
  'the damage to rendered text tracks the font size, not the rung alone',
  { skip: available ? false : skipReason() },
  async () => {
    // The mechanism, on real letterforms: at one fixed rung, smaller text is
    // damaged more. If this failed, the ordering in the first test would be a
    // property of one font size rather than of scale.
    const kept: number[] = [];
    for (const fontSize of [12, 20, 32]) {
      const rendered = await render(textPage(fontSize), WIDE_VIEWPORT);
      const source = bestSurvivingRow(rendered, 255, 0, INK).runs;
      assert.ok(source > 10, `the ${String(fontSize)}px fixture rendered too few stems`);
      const [rung] = sweepLadder(rendered, [TIER_LONGEST_EDGE.default]);
      assert.ok(rung);
      kept.push(bestSurvivingRow(rung.image, 255, 0, INK).runs / source);
    }

    const [small, medium, large] = kept;
    assert.ok(small !== undefined && medium !== undefined && large !== undefined);
    assert.ok(
      large >= medium && medium >= small,
      `retention did not rise with font size: ${kept.map((value) => (value * 100).toFixed(0) + '%').join(', ')}`,
    );
    assert.ok(
      large > small,
      'the largest and smallest text were damaged identically, so font size did not matter',
    );
  },
);
