import { PNG } from 'pngjs';

/**
 * A decoded image, and the two operations the comparison feature performs on
 * one: cutting a rectangle out of it, and drawing a rectangle onto it.
 *
 * **Why this file exists at all**, given that the comparison itself is a
 * library call: the library takes raw pixel buffers and returns a count. It
 * does not decode a file, it does not crop, and it does not draw. Those three
 * are what turn "how many pixels differ" into the paths §1.9 promises, and
 * they are small enough that a second dependency for them would be a larger
 * commitment than the code it saved.
 *
 * **Four channels, eight bits each, row-major from the top left**, which is
 * both what the decoder produces and the layout the comparison library
 * requires. §1.9 measures every region "in the capture's own pixels, measured
 * from the top left", and that is the same origin, so nothing here has to
 * flip a coordinate.
 */

/** How many bytes one pixel occupies. Red, green, blue, alpha. */
export const CHANNELS = 4;

/** A decoded image: its dimensions and its pixels. */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * CHANNELS` bytes, row-major, from the top left. */
  readonly data: Uint8Array;
}

/**
 * A rectangle in image pixels, measured from the top left — the shape §1.9
 * returns for every region.
 */
export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Decode PNG bytes. */
export function decodePng(bytes: Uint8Array): RasterImage {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

/** Encode an image as PNG bytes. */
export function encodePng(image: RasterImage): Uint8Array {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return new Uint8Array(PNG.sync.write(png));
}

/** A transparent image of the given size, which every drawing surface starts as. */
export function blankImage(width: number, height: number): RasterImage {
  return { width, height, data: new Uint8Array(width * height * CHANNELS) };
}

/**
 * Clamp a rectangle to an image's bounds.
 *
 * **This is what makes padding safe**, and it is the reason padding is applied
 * by widening a rectangle and then clamping rather than by checking first. A
 * region touching the top edge of a page — a header, which is the single most
 * likely thing to change — cannot be padded upwards, and §1.9 asks for "the
 * crop from the earlier capture and the crop from the new one, cut from the
 * same rectangle". Clamping keeps that sameness true: one rectangle is
 * computed, clamped once against the geometry both crops are taken at, and
 * used for both.
 *
 * Returns `null` when nothing survives, which happens only for a rectangle
 * entirely outside the image.
 */
export function clampToImage(
  rectangle: Rectangle,
  width: number,
  height: number,
): Rectangle | null {
  const left = Math.max(0, Math.min(rectangle.x, width));
  const top = Math.max(0, Math.min(rectangle.y, height));
  const right = Math.min(width, rectangle.x + rectangle.width);
  const bottom = Math.min(height, rectangle.y + rectangle.height);

  if (right <= left || bottom <= top) {
    return null;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Cut a rectangle out of an image.
 *
 * The rectangle must already be within the image; `clampToImage` is what puts
 * it there. Reading outside would produce a crop padded with whatever the
 * buffer happened to hold, which is a picture of nothing presented as a
 * picture of something.
 */
export function crop(image: RasterImage, rectangle: Rectangle): RasterImage {
  if (
    rectangle.x < 0 ||
    rectangle.y < 0 ||
    rectangle.x + rectangle.width > image.width ||
    rectangle.y + rectangle.height > image.height ||
    rectangle.width <= 0 ||
    rectangle.height <= 0
  ) {
    throw new Error(
      `A crop of ${String(rectangle.width)}x${String(rectangle.height)} at ` +
        `${String(rectangle.x)},${String(rectangle.y)} does not fit an image of ` +
        `${String(image.width)}x${String(image.height)}. Clamp the rectangle first.`,
    );
  }

  const out = blankImage(rectangle.width, rectangle.height);
  for (let row = 0; row < rectangle.height; row += 1) {
    const from = ((rectangle.y + row) * image.width + rectangle.x) * CHANNELS;
    out.data.set(
      image.data.subarray(from, from + rectangle.width * CHANNELS),
      row * rectangle.width * CHANNELS,
    );
  }
  return out;
}

/** A colour to draw with. */
export interface Colour {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

/** Set one pixel, ignoring anything outside the image. */
function setPixel(image: RasterImage, x: number, y: number, colour: Colour): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    return;
  }
  const at = (y * image.width + x) * CHANNELS;
  image.data[at] = colour.red;
  image.data[at + 1] = colour.green;
  image.data[at + 2] = colour.blue;
  image.data[at + 3] = colour.alpha;
}

/**
 * Draw a rectangle's outline, `thickness` pixels wide, growing inwards.
 *
 * **Inwards rather than centred on the edge**, so an outline around a region
 * flush with the image border is still fully visible. An outline drawn
 * outwards or centred loses half its width off the edge exactly where the
 * region is hardest to locate — the very top of a page.
 *
 * Mutates the image it is given, because the overlay is one image with a dozen
 * outlines on it and copying per outline would copy a full page a dozen times.
 */
export function outlineRectangle(
  image: RasterImage,
  rectangle: Rectangle,
  colour: Colour,
  thickness: number,
): void {
  const depth = Math.max(1, Math.floor(thickness));
  for (let ring = 0; ring < depth; ring += 1) {
    const left = rectangle.x + ring;
    const top = rectangle.y + ring;
    const right = rectangle.x + rectangle.width - 1 - ring;
    const bottom = rectangle.y + rectangle.height - 1 - ring;
    if (right < left || bottom < top) {
      break;
    }
    for (let x = left; x <= right; x += 1) {
      setPixel(image, x, top, colour);
      setPixel(image, x, bottom, colour);
    }
    for (let y = top; y <= bottom; y += 1) {
      setPixel(image, left, y, colour);
      setPixel(image, right, y, colour);
    }
  }
}

/** Copy an image, so a drawing operation does not alter what it drew onto. */
export function copyImage(image: RasterImage): RasterImage {
  return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
}
