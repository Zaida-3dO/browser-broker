import pixelmatch from 'pixelmatch';

import { CHANNELS, type RasterImage } from './image.ts';

/**
 * The pixel comparison (`MILESTONES.md` #40).
 *
 * ── Reuse a diff library; do not write a differ ─────────────────────────
 *
 * #40 says that outright, and §6.2 gives the reason the default tolerance is
 * the library's own: it "is a better starting position than a number invented
 * here precisely because it is not one". So the comparison itself is one call,
 * and this file is the twenty lines around it.
 *
 * **What the library does that a hand-written comparison would not**, and why
 * that is worth a dependency rather than a loop over two buffers:
 *
 * - It compares in a perceptual colour space rather than by channel distance,
 *   so one tolerance number means roughly the same thing on a dark page as on
 *   a light one. A channel-distance comparison needs a different threshold per
 *   palette, which is a tuning problem with no end.
 * - **It detects anti-aliasing and excludes it by default.** Text rendered
 *   twice on the same page is not pixel-identical — sub-pixel positioning and
 *   hinting move edge pixels — and a comparison that reported every glyph edge
 *   would report a change on every run of an unchanged page. §3.11 names that
 *   exact failure as the one that "either burns the tokens it exists to save
 *   or teaches its callers to ignore it".
 *
 * ── What this file adds ─────────────────────────────────────────────────
 *
 * A **mask**, which the library produces directly when asked: a picture whose
 * changed pixels are opaque and whose unchanged pixels are transparent. That
 * is the input the region extraction wants — one bit per pixel, already
 * decided — rather than the annotated side-by-side a person would look at.
 */

/** The result of comparing two equally-sized images. */
export interface DiffMask {
  readonly width: number;
  readonly height: number;
  /**
   * One byte per pixel: 1 where the pixel changed, 0 where it did not.
   *
   * A byte per pixel rather than a bitfield. A full page at the top rung is
   * roughly two and a half million pixels, so this is a few megabytes held for
   * the length of one comparison — against the alternative of bit arithmetic
   * at every one of the four reads the region extraction makes per pixel.
   */
  readonly changed: Uint8Array;
  /** How many pixels changed. The library's own count, not a recount. */
  readonly changedPixels: number;
}

export interface MaskOptions {
  /** From 0 to 1; smaller is more sensitive. §6.2's colour tolerance. */
  readonly colourTolerance: number;
  /**
   * The height to compare over, when it is less than the images' own.
   *
   * This is how a full page whose length changed is compared over the rows the
   * two share (§3.11) **without cropping either image first**. Cropping would
   * copy a full page twice to answer a question about a sub-rectangle of it.
   */
  readonly height?: number;
}

/**
 * Compare two images and return the mask.
 *
 * Both images must be the same width, and the compared height must fit in
 * both. `geometry.ts` is what establishes that; this throws rather than
 * guessing, because a silent adjustment here would produce a confident mask of
 * two misaligned pictures.
 */
export function computeMask(
  earlier: RasterImage,
  current: RasterImage,
  options: MaskOptions,
): DiffMask {
  if (earlier.width !== current.width) {
    throw new Error(
      `A mask needs two images of one width; got ${String(earlier.width)} and ${String(current.width)}. ` +
        'Reconcile the geometry first.',
    );
  }

  const width = current.width;
  const height = options.height ?? Math.min(earlier.height, current.height);
  if (height > earlier.height || height > current.height) {
    throw new Error(
      `A mask over ${String(height)} rows does not fit images of ${String(earlier.height)} and ` +
        `${String(current.height)} rows.`,
    );
  }

  const pixels = width * height;
  // The library writes its output as four channels, and `diffMask` makes the
  // unchanged ones transparent — which is what turns "an image a person looks
  // at" into "a bitmap something iterates".
  const output = new Uint8Array(pixels * CHANNELS);

  const changedPixels = pixelmatch(
    earlier.data.subarray(0, pixels * CHANNELS),
    current.data.subarray(0, pixels * CHANNELS),
    output,
    width,
    height,
    {
      threshold: options.colourTolerance,
      // Transparent background, opaque where something changed. Without this
      // the output is the original image dimmed underneath the differences,
      // and every pixel is non-zero.
      diffMask: true,
      // Anti-aliased pixels are excluded from the count rather than coloured
      // in, which is the default and is the behaviour §3.11's settling
      // requirement depends on.
      includeAA: false,
    },
  );

  const changed = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    // The alpha channel is the decision. With `diffMask` set, an unchanged
    // pixel is fully transparent and a changed one is not — so any non-zero
    // alpha is a change, whatever colour the library chose to mark it with.
    changed[index] = output[index * CHANNELS + 3] === 0 ? 0 : 1;
  }

  return { width, height, changed, changedPixels };
}
