/**
 * Objective, OCR-free proxies for what survives a downscale — the instruments
 * the resolution study (`MILESTONES.md` #34) measures the rungs with.
 *
 * ── Why proxies, and what they are honestly worth ───────────────────────
 *
 * The claim the tiers rest on is a claim about **a reader**: *text legibility
 * breaks at a higher resolution than layout critique does.* Settling that
 * directly would mean asking somebody whether they can read a picture, at
 * every rung, on every page — a judgement no test can make and no assertion
 * can hold.
 *
 * So this module does not attempt it. It measures **physical properties of the
 * pixels** that legibility depends on, and it is deliberate that each one is
 * arithmetic over an array rather than an opinion:
 *
 * - {@link strokeContrast} — how much of a glyph's ink survives. A stroke
 *   thinner than a destination pixel is averaged into its background by the
 *   box filter, and what is left is a fainter mark on a lighter field. This
 *   reports how far the darkest ink moved toward the page.
 * - {@link featureSurvives} — whether a **known** one-pixel feature is still
 *   distinguishable from the field around it at all. This is the layout-side
 *   instrument: a hairline rule, a border, a focus ring.
 * - {@link countDistinctRuns} — how many separate dark runs remain along a
 *   line. Two glyphs that merge into one blob have lost the gap between them,
 *   and a merged gap is the mechanism by which text stops being readable
 *   before it stops being visible.
 *
 * ── ⚠️ WHAT THESE DO NOT ESTABLISH — read before quoting a number ───────
 *
 * **None of these is a legibility measurement, and no number here should be
 * reported as one.** A proxy presented as an answer is worse than an honest
 * gap. Specifically:
 *
 * 1. **A surviving stroke is not a readable glyph.** {@link strokeContrast}
 *    can report healthy contrast on a letter whose distinguishing feature —
 *    the gap that separates an `e` from a `c` — has closed. Contrast is
 *    necessary for legibility and nowhere near sufficient.
 * 2. **These say nothing about a model's vision.** What an agent looking at a
 *    picture can actually resolve is a property of that model, not of the
 *    pixels. These measure what the *pipeline* destroys, which bounds what any
 *    reader could recover but does not predict what one will.
 * 3. **They are measured on synthetic marks of known geometry**, not on
 *    rendered prose. That is what makes them arithmetic rather than opinion,
 *    and it is also why they cannot speak to font hinting, subpixel rendering
 *    or the shapes of real letterforms.
 *
 * They are, within those limits, enough to answer the *comparative* question
 * the study asks — whether the resolution at which fine text detail is
 * destroyed is higher than the one at which a layout-scale feature is — because
 * both sides are measured with the same instrument on the same ladder.
 *
 * ── This is orthogonal to the differ's tolerance ────────────────────────
 *
 * A separate measured limit exists in this repository: at the default
 * tolerance a change fainter than roughly grey 225 on white is not reported.
 * **That is a property of the comparison, not of resolution** — it says what
 * the differ can see, and this module says what the downscale leaves behind.
 * They are different questions and their numbers do not combine.
 */

import type { RasterImage } from './image.ts';

/**
 * Whether a row is actually on the picture.
 *
 * **A row off the end must refuse rather than read as blank.** A scan over a
 * row that does not exist finds no ink, and "no ink" is indistinguishable from
 * "the mark was averaged away" — so an off-by-one in a caller's row arithmetic
 * would report a *destroyed feature* instead of a mistake, which is the study
 * measuring nothing and saying so confidently. This was a real defect here: a
 * shrink that moved a mark off the sampled row reported full contrast from an
 * empty scan.
 */
function requireRow(image: RasterImage, row: number): void {
  if (!Number.isInteger(row) || row < 0 || row >= image.height) {
    throw new RangeError(
      `row ${String(row)} is not on a picture ${String(image.width)}x${String(image.height)}: an off-picture row finds no ink, which would be misread as a destroyed feature`,
    );
  }
}

/** Luminance of one pixel, 0 (black) to 255 (white). */
function luminanceAt(image: RasterImage, x: number, y: number): number {
  const at = (y * image.width + x) * 4;
  const red = image.pixels[at] ?? 0;
  const green = image.pixels[at + 1] ?? 0;
  const blue = image.pixels[at + 2] ?? 0;
  // Rec. 601 luma. The weights matter for coloured text; for the black-on-white
  // marks this study uses, any reasonable weighting gives the same answer.
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}

/**
 * How dark the darkest ink on a row still is, as a fraction of the original
 * ink-to-background contrast.
 *
 * `1` means the mark survived at full strength; `0` means it was averaged away
 * into the background entirely. A thin stroke shrunk past the point where it
 * covers a whole destination pixel loses contrast in proportion to the fraction
 * of that pixel it covers, which is exactly what a box filter does and exactly
 * what this reports.
 *
 * @param background the field's luminance, which the mark is measured against.
 * @param ink the mark's original luminance, before any shrinking.
 */
export function strokeContrast(
  image: RasterImage,
  row: number,
  background: number,
  ink: number,
): number {
  requireRow(image, row);
  const full = Math.abs(background - ink);
  if (full === 0) return 0;

  // The pixel on this row furthest from the background is the surviving ink.
  let furthest = 0;
  for (let x = 0; x < image.width; x++) {
    const distance = Math.abs(luminanceAt(image, x, row) - background);
    if (distance > furthest) furthest = distance;
  }

  return Math.min(1, furthest / full);
}

/**
 * Whether a known feature is still distinguishable from its background.
 *
 * **The threshold is stated as an argument rather than chosen here**, because
 * "distinguishable" is the thing under study: a caller sweeping the ladder
 * decides what fraction of the original contrast it is willing to call
 * survival, and the sweep reports the answer at each. A constant baked in here
 * would be this module quietly deciding the study's result.
 */
export function featureSurvives(
  image: RasterImage,
  row: number,
  background: number,
  ink: number,
  minimumContrast: number,
): boolean {
  return strokeContrast(image, row, background, ink) >= minimumContrast;
}

/**
 * The strongest measurement anywhere in the picture, rather than on a row a
 * caller had to predict.
 *
 * **This exists because mapping a source row to a destination row is not a
 * measurement, it is a guess.** A mark 24 source pixels tall shrunk by 0.32
 * lands across some 7 destination rows, and which of them carries the most ink
 * depends on where the box filter's boundaries fell — so a study that computed
 * `sourceRow * ratio` and read that one row would report a number that swings
 * with rounding rather than with resolution. Scanning every row and taking the
 * best removes that artefact entirely: the answer is *"the most that survived
 * anywhere"*, which is the generous reading and therefore the honest one for a
 * claim about what is destroyed.
 *
 * Returns the best run count and the contrast on the row that achieved it.
 */
export function bestSurvivingRow(
  image: RasterImage,
  background: number,
  ink: number,
  minimumContrast: number,
): { readonly runs: number; readonly contrast: number; readonly row: number } {
  let runs = 0;
  let contrast = 0;
  let row = 0;
  for (let y = 0; y < image.height; y++) {
    const here = countDistinctRuns(image, y, background, ink, minimumContrast);
    if (here > runs) {
      runs = here;
      contrast = strokeContrast(image, y, background, ink);
      row = y;
    }
  }
  // A picture whose marks all fell below the ink threshold has no run anywhere;
  // report the strongest contrast that survived, which is the fading a hairline
  // shows before it disappears.
  if (runs === 0) {
    for (let y = 0; y < image.height; y++) {
      const here = strokeContrast(image, y, background, ink);
      if (here > contrast) {
        contrast = here;
        row = y;
      }
    }
  }
  return { runs, contrast, row };
}

/**
 * How many separate dark runs remain along a row.
 *
 * This is the gap-closing instrument. A row of alternating one-pixel ink and
 * one-pixel space has as many runs as it has marks; once the shrink averages
 * neighbouring marks together the runs merge, and the count falls. **The count
 * falling is the mechanism by which text becomes unreadable while remaining
 * visible** — the ink is still there, the spaces between letters are not.
 *
 * A pixel counts as ink when it is at least `minimumContrast` of the way from
 * the background toward the original ink, using the same scale
 * {@link strokeContrast} reports on.
 */
export function countDistinctRuns(
  image: RasterImage,
  row: number,
  background: number,
  ink: number,
  minimumContrast: number,
): number {
  requireRow(image, row);
  const full = Math.abs(background - ink);
  if (full === 0) return 0;

  let runs = 0;
  let inRun = false;
  for (let x = 0; x < image.width; x++) {
    const isInk = Math.abs(luminanceAt(image, x, row) - background) / full >= minimumContrast;
    if (isInk && !inRun) runs++;
    inRun = isInk;
  }
  return runs;
}
