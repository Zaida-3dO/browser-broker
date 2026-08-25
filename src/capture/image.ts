// The one place an image library is reached, for the same reason `open.ts` is
// the one place the database driver is. Decoding and re-encoding a PNG is the
// only image work this service does, and keeping it behind one module is what
// makes the choice reversible without touching the pipeline.
import { PNG } from 'pngjs';

/**
 * Decoding, downscaling and re-encoding a picture — and nothing about policy.
 *
 * **This module knows nothing about tiers.** It is told a target long edge and
 * it produces one; which number that is comes from `tiers.ts`, which is where
 * the resolution study (#34) can change it. That separation is the reason the
 * numbers are not hard-coded anywhere a study cannot reach.
 *
 * ── Why an image dependency, and why this one ───────────────────────────
 *
 * A downscale is not something to hand-roll end to end: PNG decoding is a
 * format with filters, interlacing and bit depths, and getting it subtly wrong
 * produces images that look fine until one does not. So a library decodes and
 * encodes.
 *
 * `pngjs` is chosen over a native imaging library on three counts, and the
 * first is the one that decides it:
 *
 * 1. **It has no dependencies of its own and no native build.** This repository
 *    installs from a lockfile on a clean image in CI and on whatever a
 *    contributor has; a native prebuild adds a per-platform binary to that
 *    path, and the failure mode is an install that works on the machine it was
 *    added on.
 * 2. **The whole surface needed here is decode and encode.** A general imaging
 *    library brings a large API to do one arithmetic operation on an array of
 *    bytes, and `CLAUDE.md` asks for the dependency the work needs and nothing
 *    else.
 * 3. **The resampling stays legible.** {@link downscale} below is about twenty
 *    lines of averaging that a reviewer can check against what it claims. A
 *    library's resampler is better, and it is also a black box in the one place
 *    this service's output is compared pixel to pixel by a later milestone.
 *
 * The cost is named: **box averaging is a worse resampler than a Lanczos or
 * bicubic filter**, and a downscaled screenshot here will look slightly softer
 * than the same shrink through an imaging library. For the job — a picture an
 * agent looks at to judge layout, at a long edge chosen to be legible — that is
 * an acceptable trade, and #34's study measures the tiers on the pipeline that
 * actually ships rather than on a hypothetical better one.
 */

/** A decoded picture: straight RGBA, four bytes per pixel, row by row. */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, RGBA. */
  readonly pixels: Uint8Array;
}

/** Decode an encoded PNG into pixels. */
export function decodePng(encoded: Uint8Array): RasterImage {
  const png = PNG.sync.read(Buffer.from(encoded));
  return { width: png.width, height: png.height, pixels: new Uint8Array(png.data) };
}

/** Encode pixels back into a PNG. */
export function encodePng(image: RasterImage): Uint8Array {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.pixels);
  return new Uint8Array(PNG.sync.write(png));
}

/**
 * What a picture becomes when its long edge is capped.
 *
 * **The aspect ratio is preserved and the short edge is never rounded to
 * zero.** A one-pixel-tall banner shrunk by a large factor would otherwise
 * produce a zero-height image, which is not an image; the schema's
 * `CHECK (height > 0)` would refuse the row, far away from the cause.
 */
export function scaledDimensions(
  width: number,
  height: number,
  longestEdge: number,
): { readonly width: number; readonly height: number } {
  const longest = Math.max(width, height);
  // **Never upscale.** A picture smaller than the rung is written as it is,
  // which is what makes `captures.width === captures.source_width` mean
  // "nothing was shrunk" (§1.7) rather than "nothing needed to be".
  if (longest <= longestEdge) return { width, height };
  const factor = longestEdge / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/**
 * Shrink a picture to a target size by averaging each destination pixel over
 * the source region it covers.
 *
 * A box filter rather than nearest-neighbour sampling, and the difference
 * matters for what this service is for: nearest-neighbour throws away every
 * source pixel but one, so a one-pixel rule or a thin line lands on a sampled
 * pixel or vanishes entirely depending on where it happened to fall.
 * Averaging keeps it as a fainter line, which is what a caller judging layout
 * needs to still be able to see. It is also what makes the later diff's
 * "smallest change reported" bound (§6.2) meaningful rather than a lottery.
 *
 * **Returns the same image when nothing needs shrinking**, so a caller cannot
 * tell "already small enough" from "shrunk by a factor of one" by looking at
 * the pixels — they are the same picture either way, which is the honest
 * answer.
 */
export function downscale(image: RasterImage, longestEdge: number): RasterImage {
  const target = scaledDimensions(image.width, image.height, longestEdge);
  if (target.width === image.width && target.height === image.height) return image;

  const pixels = new Uint8Array(target.width * target.height * 4);
  const xRatio = image.width / target.width;
  const yRatio = image.height / target.height;

  for (let y = 0; y < target.height; y++) {
    // The source rows this destination row covers. `Math.ceil` on the end and
    // a floor on the start means adjacent destination pixels tile the source
    // without gaps, so no source pixel is skipped by rounding.
    const yStart = Math.floor(y * yRatio);
    const yEnd = Math.min(image.height, Math.max(yStart + 1, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < target.width; x++) {
      const xStart = Math.floor(x * xRatio);
      const xEnd = Math.min(image.width, Math.max(xStart + 1, Math.ceil((x + 1) * xRatio)));

      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let counted = 0;
      for (let sourceY = yStart; sourceY < yEnd; sourceY++) {
        for (let sourceX = xStart; sourceX < xEnd; sourceX++) {
          const at = (sourceY * image.width + sourceX) * 4;
          red += image.pixels[at] ?? 0;
          green += image.pixels[at + 1] ?? 0;
          blue += image.pixels[at + 2] ?? 0;
          alpha += image.pixels[at + 3] ?? 0;
          counted++;
        }
      }

      const to = (y * target.width + x) * 4;
      pixels[to] = Math.round(red / counted);
      pixels[to + 1] = Math.round(green / counted);
      pixels[to + 2] = Math.round(blue / counted);
      pixels[to + 3] = Math.round(alpha / counted);
    }
  }

  return { width: target.width, height: target.height, pixels };
}

/**
 * A solid picture of a given size, encoded.
 *
 * Used by the fake driver so that a test's canned capture is something the
 * pipeline can genuinely decode, and by tests that need a picture of known
 * dimensions. It lives here rather than in the fake because the fake must not
 * be the only thing that knows how to make one.
 */
export function solidPng(
  width: number,
  height: number,
  colour: readonly [number, number, number, number] = [255, 255, 255, 255],
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let at = 0; at < pixels.length; at += 4) {
    pixels[at] = colour[0];
    pixels[at + 1] = colour[1];
    pixels[at + 2] = colour[2];
    pixels[at + 3] = colour[3];
  }
  return encodePng({ width, height, pixels });
}
