import assert from 'node:assert/strict';
import test from 'node:test';

import { applyReadWindow, type ReadWindow } from '../../src/service/snapshot-window.ts';
import {
  DEFAULT_READ_WINDOW_CHARS,
  MAX_READ_WINDOW_CHARS,
  PageRefusal,
  resolveReadWindow,
} from '../../src/service/pages.ts';

/**
 * The inline read window: paging, `find`-with-paging, and the limits —
 * the one table test §6 of the attached-browser plan asks for.
 *
 * ── Why this is a unit test and not a browser one ───────────────────────
 *
 * Same argument `snapshot-find.test.ts` makes and it applies unchanged: the
 * window is a pure function of text in, slice out. Everything the browser
 * contributes — `ariaSnapshot`, the write, the path — it contributed before
 * this code runs, and `decideRead`'s after-commit wiring is asserted against
 * the fake driver's call log where it needs to be. Here the mutations are
 * arithmetic, and a browser would only add flakiness to arithmetic.
 *
 * ── The mutations these kill ────────────────────────────────────────────
 *
 * - Starting at `offset + 1` (off-by-one) — the consecutive-pages test
 *   fails, because page two would drop page one's last character.
 * - Slicing by bytes rather than characters — the multi-byte test fails,
 *   which is the difference between an artefact in one language and a slice
 *   that splits a character.
 * - `hasMore` computed against the *asked* offset instead of the effective
 *   start — the overshoot test fails, reporting more to come past the end.
 * - Refusing an overshoot instead of answering it — the overshoot rows
 *   expect a value, not a throw, and that expectation is the point: paging
 *   one window past the end is how a caller *discovers* the end.
 * - Letting `limit` pass 16,000 — the ceiling row fails.
 * - Treating `offset`/`limit` as inert without `inline` — the inert-argument
 *   refusal rows fail, and that defect has name and history in this
 *   repository, which is why it gets a refusal and not a shrug.
 * - Defaulting the limit in the applying half — the default-row test pins
 *   the guard to hand back a complete window.
 */

/** A row of the application table: input, window, expected answer. */
interface ApplyRow {
  readonly name: string;
  readonly text: string;
  readonly window: ReadWindow;
  readonly expect: {
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly total: number;
    readonly hasMore: boolean;
    readonly nextOffset: number;
  };
}

/** A line-padded text of exactly `length` characters, numbered per line. */
function filler(lines: number, width: number): string {
  const line = (n: number) => `line ${String(n)}`.padEnd(width, '.');
  return Array.from({ length: lines }, (_, i) => line(i)).join('\n');
}

const APPLY_ROWS: readonly ApplyRow[] = [
  {
    name: 'the whole artefact fits in one window',
    text: 'short snapshot',
    window: { offset: 0, limit: 4_000 },
    expect: {
      text: 'short snapshot',
      start: 0,
      end: 14,
      total: 14,
      hasMore: false,
      nextOffset: 14,
    },
  },
  {
    name: 'first page of a longer artefact',
    text: filler(30, 10), // 30 lines of 10 chars, joined: 30*10 + 29 newlines
    window: { offset: 0, limit: 100 },
    expect: {
      text: filler(30, 10).slice(0, 100),
      start: 0,
      end: 100,
      total: 329,
      hasMore: true,
      nextOffset: 100,
    },
  },
  {
    name: 'last page, ending exactly at the end',
    text: filler(30, 10),
    window: { offset: 300, limit: 100 },
    expect: {
      text: filler(30, 10).slice(300),
      start: 300,
      end: 329,
      total: 329,
      hasMore: false,
      nextOffset: 329,
    },
  },
  {
    name: 'window past the end: empty, not refused',
    text: 'tiny',
    window: { offset: 100, limit: 4_000 },
    expect: { text: '', start: 4, end: 4, total: 4, hasMore: false, nextOffset: 4 },
  },
  {
    name: 'window starting exactly at the end',
    text: 'tiny',
    window: { offset: 4, limit: 10 },
    expect: { text: '', start: 4, end: 4, total: 4, hasMore: false, nextOffset: 4 },
  },
  {
    name: 'empty artefact',
    text: '',
    window: { offset: 0, limit: 4_000 },
    expect: { text: '', start: 0, end: 0, total: 0, hasMore: false, nextOffset: 0 },
  },
  {
    // The é is U+00E9 (the file pins the precomposed form), one character,
    // at index 3 of a 9-character text: a window landing on it must bring
    // back the whole character, never a split one.
    name: 'a window landing on a multi-byte character returns it whole',
    text: 'café rest',
    window: { offset: 3, limit: 1 },
    expect: {
      text: 'é',
      start: 3,
      end: 4,
      total: 9,
      hasMore: true,
      nextOffset: 4,
    },
  },
  {
    // The neighbour of the same character from the other side: the window
    // stops at it rather than taking half of it.
    name: 'a window ending at a multi-byte character stops short of it',
    text: 'café rest',
    window: { offset: 1, limit: 2 },
    expect: {
      text: 'af',
      start: 1,
      end: 3,
      total: 9,
      hasMore: true,
      nextOffset: 3,
    },
  },
];

test('applyReadWindow pages an artefact exactly as the window says', async (t) => {
  for (const row of APPLY_ROWS) {
    await t.test(row.name, () => {
      const out = applyReadWindow(row.text, row.window);
      assert.deepEqual(out, row.expect);
    });
  }
});

test('consecutive windows tile the artefact with no gap and no overlap', () => {
  const text = filler(50, 40);
  const limit = 337; // deliberately not a divisor, so edges must be checked
  const seen: string[] = [];
  let offset = 0;
  for (let guard = 0; ; guard += 1) {
    assert.ok(guard < 100, 'the paging loop did not terminate');
    const page = applyReadWindow(text, { offset, limit });
    seen.push(page.text);
    if (!page.hasMore) {
      break;
    }
    offset = page.nextOffset;
  }
  assert.equal(seen.join(''), text, 'windows must tile the whole artefact');
  // Every window but the last is exactly `limit` characters: the gap the
  // off-by-one mutation would leave shows up here as a shorter page.
  for (const page of seen.slice(0, -1)) {
    assert.equal(page.length, limit);
  }
});

/**
 * `find`-with-paging.
 *
 * The driver has already narrowed the artefact by the time the window sees
 * it (`session.read` writes the filtered file), so this composes the two by
 * what they are: the filtered text goes in, the window slices it. The two
 * rows are the two outcomes a caller meets — the matches fit in one window,
 * and they do not.
 */
test('the window pages a filtered snapshot with no special case', () => {
  const whole = [
    '- navigation [ref=e1]:',
    '  - list "Products" [ref=e2]:',
    Array.from(
      { length: 40 },
      (_, i) => `    - link "Widget ${String(i)}" [ref=e${String(i + 3)}]`,
    ).join('\n'),
    '  - status [ref=e43]: 40 results',
  ].join('\n');

  // A `find`-shaped narrowing: matching lines plus their parents — the
  // shape `filterSnapshot` emits, produced here in miniature rather than
  // imported, because this test is about what happens *after* that.
  const filtered = whole
    .split('\n')
    .filter((line) => line.includes('link "Widget') || line.includes('list "Products'))
    .join('\n');
  assert.ok(filtered.length > 500, 'fixture must be big enough to need several windows');

  const limit = 250;
  const seen: string[] = [];
  let offset = 0;
  for (let guard = 0; ; guard += 1) {
    assert.ok(guard < 50, 'the paging loop did not terminate');
    const page = applyReadWindow(filtered, { offset, limit });
    // Every window reports the total of the **same** file, whatever its
    // offset — a per-page assertion, not one against the last page, so a
    // window that reported its own length as the total cannot slip through.
    assert.equal(page.total, filtered.length);
    seen.push(page.text);
    if (!page.hasMore) break;
    offset = page.nextOffset;
  }
  assert.ok(seen.length >= 2, 'the filtered text must have needed more than one window');
  for (const page of seen.slice(0, -1)) {
    assert.equal(page.length, limit, 'every full window must be exactly `limit` long');
  }
  assert.equal(seen.join(''), filtered, 'the windows tile the filtered text');
  assert.ok(
    filtered.length < whole.length,
    'filtering must have shrunk the input the window pages',
  );
});

/** Assert a refusal under a given §7 rule. */
function refusesWith(rule: string, fn: () => unknown): PageRefusal {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PageRefusal, `expected a PageRefusal, got ${String(caught)}`);
  assert.equal(caught.rule, rule, `refusal carried ${caught.rule}, expected ${rule}`);
  return caught;
}

test('resolveReadWindow defaults, bounds, and refusals', async (t) => {
  const rows: readonly {
    readonly name: string;
    readonly inline: unknown;
    readonly offset?: unknown;
    readonly limit?: unknown;
    readonly expect?: { readonly offset: number; readonly limit: number };
    readonly messageMustSay?: string;
  }[] = [
    { name: 'no window asked at all', inline: undefined, expect: undefined },
    { name: 'inline false is the path read of before', inline: false, expect: undefined },
    {
      name: 'inline true takes the default page',
      inline: true,
      expect: { offset: 0, limit: 4_000 },
    },
    {
      name: 'an explicit limit is honoured',
      inline: true,
      limit: 250,
      expect: { offset: 0, limit: 250 },
    },
    {
      name: 'an explicit offset is honoured',
      inline: true,
      offset: 8_000,
      expect: { offset: 8_000, limit: 4_000 },
    },
    {
      name: 'the ceiling is inclusive',
      inline: true,
      limit: MAX_READ_WINDOW_CHARS,
      expect: { offset: 0, limit: MAX_READ_WINDOW_CHARS },
    },
    {
      name: 'a limit past the ceiling is refused',
      inline: true,
      limit: MAX_READ_WINDOW_CHARS + 1,
      messageMustSay: String(MAX_READ_WINDOW_CHARS),
    },
    { name: 'a zero limit is refused', inline: true, limit: 0, messageMustSay: '1 to' },
    { name: 'a fractional offset is refused', inline: true, offset: 1.5, messageMustSay: 'whole' },
    { name: 'a negative offset is refused', inline: true, offset: -1, messageMustSay: 'from 0' },
    {
      name: 'offset without inline is refused, not ignored',
      inline: undefined,
      offset: 4_000,
      messageMustSay: 'inline',
    },
    {
      name: 'limit without inline is refused, not ignored',
      inline: false,
      limit: 10,
      messageMustSay: 'inline',
    },
    { name: 'a non-boolean inline is refused', inline: 'yes', messageMustSay: 'yes or no' },
  ];

  for (const row of rows) {
    await t.test(row.name, () => {
      if (row.expect === undefined && !('expect' in row)) {
        const refusal = refusesWith('read.window_shape', () =>
          resolveReadWindow(row.inline, row.offset, row.limit),
        );
        if (row.messageMustSay !== undefined) {
          assert.ok(
            refusal.message.includes(row.messageMustSay),
            `refusal message must name the fix (${row.messageMustSay}): ${refusal.message}`,
          );
        }
        return;
      }
      if (row.expect === undefined) {
        assert.equal(resolveReadWindow(row.inline, row.offset, row.limit), undefined);
        return;
      }
      assert.deepEqual(resolveReadWindow(row.inline, row.offset, row.limit), row.expect);
    });
  }

  await t.test('the default constant is the plan page size, and the ceiling is four pages', () => {
    assert.equal(DEFAULT_READ_WINDOW_CHARS, 4_000);
    assert.equal(MAX_READ_WINDOW_CHARS, 4 * DEFAULT_READ_WINDOW_CHARS);
  });
});
