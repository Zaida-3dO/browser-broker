import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatNetworkEntry,
  readPngDimensions,
  renderNetworkLog,
  type NetworkEntry,
} from '../../src/browser/render.ts';

/**
 * **One copy of the renderers, pinned at the copy.**
 *
 * ── Why this file exists at the shared module, when the live suites already
 * read these lines through a real browser ──────────────────────────────────
 *
 * `network-outcomes.test.ts` pins the log format as a caller sees it, but
 * over a real browser — the slowest, flakiest tier in the repository. The
 * extraction moved the format from two module-private copies into one shared
 * module, and the failure mode an extraction has is silent: the call sites
 * compile, the live suite still passes, and only the *unit* of the format is
 * gone. These tests hold the format itself, in milliseconds, and pin the one
 * **behaviour change** the extraction carries: the PNG reader now refuses a
 * header whose first chunk is not `IHDR` (the attached copy's safer guard,
 * unified here), where the real copy read offsets 16 and 20 whatever the
 * chunk was. That case has no live-browser test because nothing in a live
 * browser produces a PNG that starts with a different chunk — so if it is
 * pinned anywhere, it is pinned here.
 */

test('the network line format: one line per state, one token per line, index outside the scanned column', () => {
  const base = { method: 'GET', url: 'https://example.com/a', startedAt: 1 };
  const rows: { name: string; entry: NetworkEntry; want: string }[] = [
    {
      name: 'settled',
      entry: { ...base, outcome: { kind: 'response', status: 404, elapsedMs: 250 } },
      want: '[1] 404     GET https://example.com/a (250ms)',
    },
    {
      name: 'failed',
      entry: { ...base, outcome: { kind: 'failed', reason: 'net::ERR_FAILED', elapsedMs: 5 } },
      want: '[1] FAILED  GET https://example.com/a (net::ERR_FAILED, 5ms)',
    },
    {
      name: 'in flight',
      entry: { ...base },
      want: '[1] PENDING GET https://example.com/a (in flight when this log was written)',
    },
  ];
  for (const row of rows) {
    assert.equal(formatNetworkEntry(row.entry, 0), row.want, `the ${row.name} line drifted`);
  }

  // One-based, because the number is quoted by people.
  assert.match(formatNetworkEntry({ ...base }, 7), /^\[8\] /);
});

test('the log header counts, calls out pending separately, and the indices are contiguous', () => {
  const settled: NetworkEntry = {
    method: 'GET',
    url: 'https://example.com/a',
    startedAt: 1,
    outcome: { kind: 'response', status: 200, elapsedMs: 1 },
  };
  const inFlight: NetworkEntry = { method: 'POST', url: 'https://example.com/b', startedAt: 2 };

  assert.equal(renderNetworkLog([]), 'No requests were observed on this tab.');
  assert.equal(renderNetworkLog([settled]).split('\n')[0], '1 request, all settled.');
  const mixed = renderNetworkLog([settled, inFlight, settled]);
  assert.equal(mixed.split('\n')[0], '3 requests, 1 still in flight when this was written.');
  // The last index equals the header's count — the correspondence a caller
  // uses to tell a whole log from a window onto one.
  assert.equal(mixed.split('\n').at(-1), '[3] 200     GET https://example.com/a (1ms)');
});

/** A PNG header with the given chunk type and dimensions. */
function png(chunkType: string, width: number, height: number, length = 32): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  for (let at = 0; at < 4; at += 1) {
    bytes[12 + at] = chunkType.charCodeAt(at);
  }
  // The short-buffer row truncates below the point where the dimensions live;
  // everything the reader is supposed to have looked at still exists.
  if (length >= 24) {
    view.setUint32(16, width);
    view.setUint32(20, height);
  }
  return bytes;
}

test('the PNG reader takes dimensions from IHDR only, and nothing else from anywhere', () => {
  const rows: {
    name: string;
    image: Uint8Array;
    want: { width: number; height: number } | undefined;
  }[] = [
    { name: 'a real header', image: png('IHDR', 1280, 4320), want: { width: 1280, height: 4320 } },
    {
      // The unification: the first chunk is legal PNG framing but is not
      // IHDR, so the integers at 16 and 20 are somebody else's data. The
      // old `real.ts` copy returned them as a size; the shared reader
      // returns `undefined` and the caller keeps its page-measured fallback.
      name: 'a valid PNG that does not open with IHDR',
      image: png('tEXt', 1280, 4320),
      want: undefined,
    },
    { name: 'not a PNG', image: new Uint8Array(64).fill(0x41), want: undefined },
    { name: 'a short buffer', image: png('IHDR', 1, 1, 20), want: undefined },
  ];
  for (const row of rows) {
    assert.deepEqual(readPngDimensions(row.image), row.want, `the ${row.name} case misread`);
  }
});
