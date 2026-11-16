/**
 * The inline read window: which slice of an artefact's text comes back.
 *
 * ── Why this exists as its own file ──────────────────────────────────────
 *
 * `pages.ts` is the guard layer — pure validation of what a caller *asked
 * for*, with no answer in sight. This is the other half of the same feature:
 * the pure function that turns the whole of a written artefact into the part
 * the caller asked to see. Keeping the two apart is the same boundary the
 * guards already keep, applied to the read window rather than to its
 * arguments: one decides whether a request is well formed, the other applies
 * a well formed one, and neither can reach a browser, the store, or a file.
 *
 * ── Why paging exists at all, stated in measurements ─────────────────────
 *
 * A 300-link page yields a snapshot of roughly 43 KB. The read surface's
 * founding rule (§3.9) is that artefacts land on disk and come back as paths
 * *because a full snapshot entering a conversation is paid for once in money
 * and on every later turn in context* — but a caller that must open the file
 * to learn anything pays the whole file anyway, and small models pay it in
 * full. The window is what makes "read one value out of a big page" cost one
 * page of the page: 4,000 characters by default, 16,000 at most, with the
 * rest reachable by asking again at the next offset.
 *
 * ── How `find` and the window compose, and what each half is for ─────────
 *
 * They narrow along different axes and the order is fixed: **`find` picks
 * which lines exist, the window picks how much of what exists comes back.**
 * The driver has already filtered before this sees anything, so the window
 * never learns, and never needs to learn, whether it is paging a whole
 * snapshot or a filtered one — it slices whatever text it is handed. That
 * is the composition property the table test pins: `find`-with-paging is
 * not a special case, it is the ordinary case over a smaller input, and a
 * caller who filtered first gets *all of the match, if it fits* and the
 * remainder by offset otherwise.
 *
 * ── The unit, stated so a caller can page without guessing ───────────────
 *
 * The window counts **characters of the artefact's text**, not lines, not
 * bytes, not tokens. It is the spelling the arguments use (`limit: 4000` is
 * four thousand of the same characters `offset` and the reported `end`
 * speak of), so a caller advances by reading `nextOffset` back out of the
 * answer rather than by counting anything itself. A slice can therefore cut
 * mid-word or mid-line at its edges — which is what "give me characters
 * 4,000 through 8,000" says, and a caller that needs a whole line starts
 * the next window early. Anchoring to line boundaries would move the
 * caller's own offset, and an answer that reports an offset the caller did
 * not ask for is a handle nobody can use.
 */

/**
 * A decided window: a start and a length, both already validated.
 *
 * The shape `resolveReadWindow` in `src/service/pages.ts` produces after
 * refusing anything malformed. Nothing here validates — by the time a
 * window reaches this file, "is this request well formed" has been answered
 * on the ledger, and re-asking it here would be a second answer that could
 * disagree with the first.
 */
export interface ReadWindow {
  /** Character index the window starts at. */
  readonly offset: number;
  /** Most characters the window returns. */
  readonly limit: number;
}

/**
 * A windowed answer: the slice, and the coordinates a caller pages with.
 *
 * Every field except `text` exists so the next window can be derived from
 * this answer alone. A caller that has to remember what it asked to work out
 * where it ended is a caller that re-asks the same range twice and believes
 * it saw two pages.
 */
export interface WindowedText {
  /** The slice itself. Empty exactly when the window started at or past the end. */
  readonly text: string;
  /** The character index `text` starts at — `min(offset, total)`. */
  readonly start: number;
  /** The character index just past the last character returned. */
  readonly end: number;
  /** The total characters in the artefact, so a caller can tell a full read from a page. */
  readonly total: number;
  /** True when characters remain after this slice. */
  readonly hasMore: boolean;
  /** The offset for the next window — `end`, spelled out because it is what it is used for. */
  readonly nextOffset: number;
}

/** First half of a surrogate pair — the only code units that start a non-BMP character. */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/** Second half of a surrogate pair — meaningless on its own, by construction. */
function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Cut the window out of the artefact's text.
 *
 * **Total, clamped, never refused.** An offset past the end of the artefact
 * is not a caller error worth a refusal — it is what paging past the last
 * page looks like, and the honest answer is an empty slice with `hasMore:
 * false` and the total that says where the end actually is. A refusal there
 * would send a caller that had simply paged once too far into an error
 * path, while these fields tell it, in the shape of the answer, that it is
 * done.
 *
 * `start` is the *effective* start, not the asked-for offset: when the
 * offset overshot, `start` is the total, and that is the whole of what an
 * empty slice needs to report about itself.
 */
export function applyReadWindow(text: string, window: ReadWindow): WindowedText {
  const total = text.length;
  let start = Math.min(window.offset, total);
  // **UTF-16 code units are not characters, and a slice boundary that falls
  // inside a surrogate pair corrupts the character on both sides of the
  // cut:** each half alone is a lone surrogate, which every renderer downstream
  // turns into the replacement character, and a caller stitching pages back
  // together at `nextOffset` receives `??` characters where an emoji, a
  // CJK-extension ideograph or a math symbol should be. So both edges back
  // off to the
  // character boundary:
  //
  // - An `end` that would fall between the halves moves back over the pair;
  //   the character arrives whole in the next window, one unit of slack
  //   against the limit — which the cap's bound on *source* text affords.
  // - An `offset` that lands on a pair's second half moves back over it,
  //   **overlapping one code unit** with the previous window. Overlap is
  //   recoverable by anyone stitching; a silently dropped character is not.
  //
  // The rule cannot hold where the window is too small to fit a whole pair
  // (a limit of one against non-BMP text); then the pair is cut, which is
  // the caller's degenerate configuration talking, not the reader's data.
  if (
    start > 0 &&
    start < total &&
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
  ) {
    start -= 1;
  }
  let end = Math.min(start + window.limit, total);
  if (
    end > start + 1 &&
    end < total &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
  }
  return {
    text: text.slice(start, end),
    start,
    end,
    total,
    hasMore: end < total,
    nextOffset: end,
  };
}
