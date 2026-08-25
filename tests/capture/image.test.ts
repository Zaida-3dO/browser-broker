import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePng,
  downscale,
  encodePng,
  scaledDimensions,
  solidPng,
  type RasterImage,
} from '../../src/capture/image.ts';

/** A picture whose pixels are known, so a resample can be checked arithmetically. */
function image(width: number, height: number, at: (x: number, y: number) => number): RasterImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4;
      const value = at(x, y);
      pixels[to] = value;
      pixels[to + 1] = value;
      pixels[to + 2] = value;
      pixels[to + 3] = 255;
    }
  }
  return { width, height, pixels };
}

test('the long edge is capped and the aspect ratio is kept', () => {
  assert.deepEqual(scaledDimensions(2000, 1000, 1000), { width: 1000, height: 500 });
  // Portrait: the long edge is the height, so that is what is capped.
  assert.deepEqual(scaledDimensions(1000, 2000, 1000), { width: 500, height: 1000 });
});

test('a picture inside the cap is never upscaled', () => {
  // Dies if the `longest <= longestEdge` early return is removed: without it a
  // 400px picture would be blown up to 1000px, and `width === source_width`
  // would stop meaning "nothing was shrunk".
  assert.deepEqual(scaledDimensions(400, 300, 1000), { width: 400, height: 300 });
});

test('the short edge never rounds to zero', () => {
  // A one-pixel-tall banner shrunk by a large factor. Zero height is not an
  // image, and the schema's CHECK (height > 0) would refuse the row far away
  // from the cause.
  const scaled = scaledDimensions(10000, 1, 100);
  assert.equal(scaled.height, 1);
  assert.ok(scaled.height > 0);
});

test('downscale returns the SAME object when nothing needs shrinking', () => {
  const source = image(50, 50, () => 128);
  // Identity rather than equality: the pipeline relies on this to decide
  // whether to re-encode, so a copy would silently change the bytes under the
  // claim that nothing was shrunk.
  assert.equal(downscale(source, 1000), source);
});

test('downscale AVERAGES rather than sampling — a halved image is the mean of each block', () => {
  // A 2x2 of known values shrunk to 1x1. Nearest-neighbour would give one of
  // the four corners; the mean of 0, 100, 200, 255 is 139 (rounded).
  const source = image(2, 2, (x, y) => [0, 100, 200, 255][y * 2 + x] ?? 0);
  const shrunk = downscale(source, 1);
  assert.equal(shrunk.width, 1);
  assert.equal(shrunk.height, 1);
  // Dies if the box filter is replaced with nearest-neighbour sampling, which
  // would return 0, 100, 200 or 255 — never 139. That is the mutation that
  // matters: sampling makes a one-pixel line land or vanish by luck.
  assert.equal(shrunk.pixels[0], Math.round((0 + 100 + 200 + 255) / 4));
});

test('a thin line survives a downscale as a fainter line rather than vanishing', () => {
  // One dark row in a white 8-row picture, halved. Averaging keeps it as a
  // mid-grey; sampling would drop it entirely half the time.
  const source = image(8, 8, (_x, y) => (y === 3 ? 0 : 255));
  const shrunk = downscale(source, 4);
  const rows = Array.from(
    { length: shrunk.height },
    (_unused, y) => shrunk.pixels[y * shrunk.width * 4] ?? 0,
  );
  assert.ok(
    rows.some((value) => value > 0 && value < 255),
    `the line vanished or stayed hard-edged: ${rows.join(',')}`,
  );
});

test('every destination pixel is covered — no channel is left at zero by accident', () => {
  const source = image(9, 7, () => 200);
  const shrunk = downscale(source, 4);
  assert.equal(shrunk.pixels.length, shrunk.width * shrunk.height * 4);
  for (let at = 0; at < shrunk.pixels.length; at += 4) {
    assert.equal(shrunk.pixels[at], 200, `pixel at ${String(at)} was not filled`);
    assert.equal(shrunk.pixels[at + 3], 255, 'alpha was not carried through');
  }
});

test('alpha is resampled alongside the colour channels', () => {
  const pixels = new Uint8Array(2 * 1 * 4);
  pixels.set([255, 255, 255, 0], 0);
  pixels.set([255, 255, 255, 255], 4);
  const shrunk = downscale({ width: 2, height: 1, pixels }, 1);
  // Dies if alpha is hard-coded to 255, which is the plausible shortcut and
  // would make every transparent region opaque.
  assert.equal(shrunk.pixels[3], Math.round((0 + 255) / 2));
});

test('a PNG survives a decode and re-encode round trip', () => {
  const encoded = solidPng(7, 5, [10, 20, 30, 255]);
  const decoded = decodePng(encoded);
  assert.equal(decoded.width, 7);
  assert.equal(decoded.height, 5);
  assert.equal(decoded.pixels[0], 10);
  assert.equal(decoded.pixels[1], 20);
  assert.equal(decoded.pixels[2], 30);

  const again = decodePng(encodePng(decoded));
  assert.equal(again.width, 7);
  assert.deepEqual([...again.pixels], [...decoded.pixels]);
});

test('an encoded picture really is at the dimensions it claims', () => {
  const shrunk = downscale(
    image(1000, 500, () => 90),
    100,
  );
  const round = decodePng(encodePng(shrunk));
  assert.equal(round.width, 100);
  assert.equal(round.height, 50);
});
