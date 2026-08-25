import {
  CHANNELS,
  type Colour,
  type RasterImage,
  type Rectangle,
  blankImage,
} from '../../src/diff/image.ts';

/**
 * Fixture images, built in code rather than checked in as files
 * (`MILESTONES.md` #43).
 *
 * **Why drawn rather than stored.** #43 asks for "a fixture set of known-clean
 * and known-changed pairs", built "from thin lines, border widths, focus rings
 * and underlines — the cases the size filter is most likely to eat". A checked-in
 * PNG can be *described* as a one-pixel underline; a drawn one **is** one, and
 * the assertion that a two-pixel change survives the threshold is only worth
 * anything if the fixture is provably a two-pixel change. A stored file also
 * cannot be regenerated at a second size, which is exactly what the
 * long-line-versus-short-line pair needs.
 *
 * These are helpers, not assertions. Nothing here decides whether the feature
 * works; they build the input that lets a test decide.
 */

export const WHITE: Colour = { red: 255, green: 255, blue: 255, alpha: 255 };
export const BLACK: Colour = { red: 0, green: 0, blue: 0, alpha: 255 };
export const GREY: Colour = { red: 128, green: 128, blue: 128, alpha: 255 };
/**
 * The faintest grey on white the **default** tolerance still reports.
 *
 * Measured rather than guessed, and the measurement is worth recording because
 * it is the single most surprising number in this feature. Sweeping a grey
 * block on a white field across tolerances gives:
 *
 * | Grey | 0.1 | 0.3 | 0.5 | 0.7 | 0.9 |
 * |---|---|---|---|---|---|
 * | 230 | — | — | — | — | — |
 * | **220** | **caught** | — | — | — | — |
 * | 160 | caught | caught | — | — | — |
 * | 100 | caught | caught | caught | — | — |
 * | 0 | caught | caught | caught | caught | caught |
 *
 * **So the shipped default is already fairly insensitive**: a change lighter
 * than about grey 225 on white is not reported at all. That is a real property
 * of the feature rather than a defect of these fixtures, and it is exactly the
 * kind of thing the `comparisons` table exists to let somebody revisit against
 * real captures (§1.9).
 *
 * This constant sits just inside that edge, which is what makes it useful for
 * the test that demonstrates a raised tolerance swallowing a real change.
 */
export const FAINT_GREY: Colour = { red: 220, green: 220, blue: 220, alpha: 255 };

/** An opaque field of one colour. What every fixture starts as. */
export function filled(width: number, height: number, colour: Colour = WHITE): RasterImage {
  const image = blankImage(width, height);
  for (let index = 0; index < width * height; index += 1) {
    image.data[index * CHANNELS] = colour.red;
    image.data[index * CHANNELS + 1] = colour.green;
    image.data[index * CHANNELS + 2] = colour.blue;
    image.data[index * CHANNELS + 3] = colour.alpha;
  }
  return image;
}

/** Paint a solid rectangle onto an image, in place. */
export function fillRectangle(image: RasterImage, rectangle: Rectangle, colour: Colour): void {
  for (let row = 0; row < rectangle.height; row += 1) {
    const y = rectangle.y + row;
    if (y < 0 || y >= image.height) continue;
    for (let column = 0; column < rectangle.width; column += 1) {
      const x = rectangle.x + column;
      if (x < 0 || x >= image.width) continue;
      const at = (y * image.width + x) * CHANNELS;
      image.data[at] = colour.red;
      image.data[at + 1] = colour.green;
      image.data[at + 2] = colour.blue;
      image.data[at + 3] = colour.alpha;
    }
  }
}

/** A copy of an image with one rectangle painted onto it. */
export function withRectangle(
  image: RasterImage,
  rectangle: Rectangle,
  colour: Colour,
): RasterImage {
  const copy: RasterImage = {
    width: image.width,
    height: image.height,
    data: new Uint8Array(image.data),
  };
  fillRectangle(copy, rectangle, colour);
  return copy;
}

/** Read one pixel back, for a test that needs to prove what was drawn. */
export function pixelAt(image: RasterImage, x: number, y: number): Colour {
  const at = (y * image.width + x) * CHANNELS;
  return {
    red: image.data[at] ?? 0,
    green: image.data[at + 1] ?? 0,
    blue: image.data[at + 2] ?? 0,
    alpha: image.data[at + 3] ?? 0,
  };
}

/**
 * The named fixture pairs (#43).
 *
 * Each is an earlier image and a current one, plus the rectangle that actually
 * changed — so a test can assert not merely that *something* was found but
 * that what was found is where the change was put.
 *
 * **The page is deliberately wide and short.** A one-pixel line across a wide
 * page is the shape #41 names as the one a shorter-side filter discards, and it
 * only *is* that shape if the page is wide.
 */
export interface FixturePair {
  readonly name: string;
  readonly earlier: RasterImage;
  readonly current: RasterImage;
  /** Where the change was drawn, or `null` for a known-clean pair. */
  readonly changedAt: Rectangle | null;
  /** What this fixture is testing, for a failure message worth reading. */
  readonly describes: string;
}

const PAGE_WIDTH = 800;
const PAGE_HEIGHT = 200;

function page(): RasterImage {
  const base = filled(PAGE_WIDTH, PAGE_HEIGHT, WHITE);
  // Some content, so the page is not a blank field. A comparison over two
  // blank fields is a comparison the anti-aliasing detection never sees, and
  // a fixture set that never exercises it is not the page anybody captures.
  fillRectangle(base, { x: 40, y: 30, width: 300, height: 24 }, GREY);
  fillRectangle(base, { x: 40, y: 90, width: 520, height: 16 }, GREY);
  fillRectangle(base, { x: 40, y: 140, width: 120, height: 32 }, BLACK);
  return base;
}

/**
 * Known-clean: the identical image compared against itself.
 *
 * The control every other fixture depends on. Without it, a comparison that
 * reported a change on everything would satisfy all the known-changed
 * assertions below.
 */
export function cleanPair(): FixturePair {
  const base = page();
  return {
    name: 'identical',
    earlier: base,
    current: {
      width: base.width,
      height: base.height,
      data: new Uint8Array(base.data),
    },
    changedAt: null,
    describes: 'the same page twice, which must report nothing changed',
  };
}

/**
 * The known-changed set, every entry a shape the size filter is most likely to
 * eat (#43).
 */
export function changedPairs(): readonly FixturePair[] {
  const base = page();

  /** A one-pixel rule across nearly the whole page. Area 720; shorter side 1. */
  const longThinRule: Rectangle = { x: 40, y: 70, width: 720, height: 1 };

  /**
   * An underline under one short word. Area 44; shorter side 2.
   *
   * **This is the fixture the thin-line allowance exists for**, and the one
   * that fails if the allowance is removed: 44 is below the default minimum
   * area of 64, so area alone discards it.
   */
  const shortUnderline: Rectangle = { x: 40, y: 122, width: 22, height: 2 };

  /** A border going from one pixel to two, down the side of a block. */
  const borderWidth: Rectangle = { x: 160, y: 140, width: 1, height: 32 };

  /** A focus ring: a thin outline. Represented as its top edge. */
  const focusRing: Rectangle = { x: 36, y: 136, width: 128, height: 2 };

  /** A whole element repainting — the change nothing could plausibly miss. */
  const block: Rectangle = { x: 400, y: 30, width: 200, height: 60 };

  return [
    {
      name: 'a one-pixel rule across the page',
      earlier: base,
      current: withRectangle(base, longThinRule, BLACK),
      changedAt: longThinRule,
      describes:
        'the shape #41 names outright: a one-pixel line across a wide page, which a filter on the shorter side discards',
    },
    {
      name: 'an underline under one short word',
      earlier: base,
      current: withRectangle(base, shortUnderline, BLACK),
      changedAt: shortUnderline,
      describes:
        'a thin line whose area is below the minimum, which only the thin-line allowance keeps',
    },
    {
      name: 'a border width changing',
      earlier: withRectangle(base, { x: 160, y: 140, width: 1, height: 32 }, WHITE),
      current: withRectangle(base, borderWidth, BLACK),
      changedAt: borderWidth,
      describes: 'a border going from one pixel wide to two',
    },
    {
      name: 'a focus ring appearing',
      earlier: base,
      current: withRectangle(base, focusRing, BLACK),
      changedAt: focusRing,
      describes: 'a two-pixel outline arriving around an element',
    },
    {
      name: 'a block repainting',
      earlier: base,
      current: withRectangle(base, block, BLACK),
      changedAt: block,
      describes: 'a whole element changing, which any threshold must catch',
    },
  ];
}
