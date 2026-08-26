import type { RasterImage } from '../../src/capture/image.ts';

/**
 * The fixtures the resolution study measures (`MILESTONES.md` #34).
 *
 * ── ⚠️ EVERY FIXTURE HERE MUST FAIL AT SOME RUNG ────────────────────────
 *
 * The most recurrent defect class in this project is **a fixture in which the
 * correct and incorrect behaviours coincide**. For a resolution study that has
 * one exact shape: *a test page where every rung looks fine proves nothing.*
 * If a page survives 1024 as well as it survives 2576, it cannot distinguish
 * the rungs and the study has measured nothing.
 *
 * So each fixture below is built at a known geometry chosen so that the
 * property it carries is **destroyed somewhere on the ladder**, and the tests
 * assert where. A fixture whose measurement is flat across every rung is a
 * broken fixture, and the suite has a test that says so.
 *
 * ── Why drawn rather than rendered, and what that costs ─────────────────
 *
 * These are drawn arithmetically: a mark of a stated width at a stated
 * position. That is what makes "a one-pixel feature" provably one pixel, and
 * what lets a test assert against the geometry rather than against an image
 * somebody described. The neighbouring diff fixtures are built the same way and
 * for the same reason.
 *
 * **The cost is named:** these are not letterforms. They carry the geometry
 * that legibility depends on — stroke width, the gap between strokes, x-height
 * — but a real font has hinting, antialiasing and shapes these do not model.
 * The study therefore also renders real text in a real browser, and those tests
 * skip where there is no browser. Neither half is sufficient alone: the drawn
 * fixtures are exact but synthetic, the rendered ones are real but only
 * available on a machine with a browser.
 */

const CHANNELS = 4;

export const WHITE_LUMA = 255;
export const BLACK_LUMA = 0;

/** A white field of a given size. */
export function field(width: number, height: number): RasterImage {
  const pixels = new Uint8Array(width * height * CHANNELS);
  pixels.fill(255);
  return { width, height, pixels };
}

/** Paint a solid black rectangle, in place. */
export function paint(
  image: RasterImage,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const data = image.pixels as Uint8Array;
  for (let row = 0; row < height; row++) {
    const atY = y + row;
    if (atY < 0 || atY >= image.height) continue;
    for (let column = 0; column < width; column++) {
      const atX = x + column;
      if (atX < 0 || atX >= image.width) continue;
      const at = (atY * image.width + atX) * CHANNELS;
      data[at] = 0;
      data[at + 1] = 0;
      data[at + 2] = 0;
      data[at + 3] = 255;
    }
  }
}

/**
 * A fixture and the row on which its property is measured.
 */
export interface LadderFixture {
  readonly name: string;
  readonly image: RasterImage;
  /** The row {@link strokeContrast} and the run count are read from. */
  readonly measureRow: number;
  /** What this fixture carries, for a failure message worth reading. */
  readonly describes: string;
}

/**
 * The page every fixture is drawn on.
 *
 * **Deliberately large** — a source picture must be bigger than the top rung,
 * or the upper rungs never shrink it at all and the ladder's top half measures
 * nothing. At 3200 wide, every rung in the study's sweep is a genuine
 * downscale.
 */
export const SOURCE_WIDTH = 3200;
export const SOURCE_HEIGHT = 1800;

/**
 * **The text-detail fixture: a comb of one-pixel strokes one pixel apart.**
 *
 * This is the study's stand-in for the finest detail in body copy — the gap
 * between two adjacent stems, which is what closes when text stops being
 * readable. At full size it is 40 separate marks; every shrink averages
 * neighbouring marks toward each other, and below a ratio of about one half the
 * gaps close and the comb becomes one grey band.
 *
 * The run count is the instrument, not the contrast: a merged comb still has
 * ink, so anything measuring only darkness would report it as surviving.
 */
export function fineTextComb(): LadderFixture {
  const image = field(SOURCE_WIDTH, SOURCE_HEIGHT);
  const row = 400;
  const strokes = 40;
  for (let index = 0; index < strokes; index++) {
    // One pixel of ink, one pixel of gap: the tightest structure a glyph has.
    paint(image, 100 + index * 2, row - 12, 1, 24);
  }
  return {
    name: 'fine text detail: one-pixel strokes one pixel apart',
    image,
    measureRow: row,
    describes:
      'the gap between adjacent stems in body copy, which closes into a grey band once neighbouring strokes average together',
  };
}

/**
 * **The layout fixture: a wide block edge, dozens of pixels thick.**
 *
 * A layout judgement — is this aligned, is the spacing even, is this element in
 * the right place — depends on features at the scale of blocks and gutters, not
 * at the scale of a stroke. This is that scale: a 60-pixel-wide bar, which
 * survives every shrink on the ladder with its edges intact.
 *
 * **This fixture is the control, and it is meant to survive.** It is what makes
 * the comb's failure mean something: if both failed together, the study would
 * have measured "shrinking destroys things" rather than the ordering the claim
 * is about.
 */
export function layoutBlock(): LadderFixture {
  const image = field(SOURCE_WIDTH, SOURCE_HEIGHT);
  const row = 800;
  paint(image, 200, row - 30, 900, 60);
  return {
    name: 'layout scale: a wide block',
    image,
    measureRow: row,
    describes:
      'a block-scale feature, the scale a layout judgement is made at, which no rung on this ladder destroys',
  };
}

/**
 * **The one-pixel border: the layout feature that is NOT safe.**
 *
 * A hairline rule is a layout feature by role — it separates sections, it is a
 * border, it is a focus ring — but it has the *physical* dimensions of text
 * detail. It is the fixture that stops "layout survives, text does not" being
 * stated too simply, and the study's most useful single case.
 *
 * It is drawn as a lone one-pixel row on white with nothing near it, so what is
 * measured is contrast rather than run-merging.
 */
export function hairlineRule(): LadderFixture {
  const image = field(SOURCE_WIDTH, SOURCE_HEIGHT);
  const row = 1200;
  paint(image, 100, row, 3000, 1);
  return {
    name: 'a one-pixel border rule',
    image,
    measureRow: row,
    describes:
      'a hairline: a layout feature by role with the physical size of text detail, which fades rather than vanishing',
  };
}

/**
 * **A coarse comb: strokes three pixels wide, three apart.**
 *
 * The same structure as {@link fineTextComb} at three times the scale — a
 * heading rather than body copy. It exists so the study can show the failure
 * point **moves with the feature size** rather than being a fixed property of
 * the ladder, which is what distinguishes a real measurement from a
 * coincidence of one fixture's geometry.
 */
export function coarseTextComb(): LadderFixture {
  const image = field(SOURCE_WIDTH, SOURCE_HEIGHT);
  const row = 1600;
  const strokes = 40;
  for (let index = 0; index < strokes; index++) {
    paint(image, 100 + index * 6, row - 30, 3, 60);
  }
  return {
    name: 'heading-scale text: three-pixel strokes three apart',
    image,
    measureRow: row,
    describes:
      'the same structure at three times the size, whose gaps close at a lower rung than the fine comb s',
  };
}

/** Every fixture, for a sweep that measures them all on the same ladder. */
export function ladderFixtures(): readonly LadderFixture[] {
  return [fineTextComb(), coarseTextComb(), hairlineRule(), layoutBlock()];
}
