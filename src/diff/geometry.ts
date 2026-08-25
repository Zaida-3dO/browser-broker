/**
 * Geometry reconciliation — what happens when the two pictures are not the
 * same size (`SCHEMA.md` §1.9, §3.11, `MILESTONES.md` #40).
 *
 * ── The coupling this file exists to keep cut ───────────────────────────
 *
 * §3.11 records an arrangement that was deliberately deleted: a capture that
 * consulted a canonical picture for the view it named and **took the picture
 * at that picture's geometry**. That made the ordinary capture path depend on
 * the comparison feature's data model, and gave every capture a reason to fail
 * that had nothing to do with capturing.
 *
 * **So geometry is handled here, at diff time, where both images are already
 * in hand.** Nothing constrains a capture, and a mismatch is reported against
 * the specific pair that mismatched rather than pre-empted by a rule.
 *
 * ── The two mismatches are not the same fact, and that is the design ────
 *
 * - **A width mismatch is reported in the result.** Two pictures of the same
 *   page at different widths are pictures of different layouts, and a diff
 *   over them is close to meaningless — nearly every pixel moves. It is still
 *   not a refusal: the caller gets its picture and the fact, per §1.9's
 *   standing rule that a diff is an optional argument whose failure cannot
 *   withhold a screenshot that succeeded.
 * - **A full page's height is allowed to differ**, because "two full-page
 *   pictures of one page legitimately differ in height when the content gets
 *   longer" (§3.11). The change in page length is reported **as its own fact
 *   rather than as a region** — a page that grew by two hundred pixels has not
 *   changed in two hundred places, and reporting the growth as a region would
 *   drown the actual change.
 *
 * **The comparison runs over the height they share** (§3.11), which is the
 * only region where the question "did this pixel change" has an answer at all.
 */

/** Which kind of capture this is, which decides how a height mismatch reads. */
export type CaptureKind = 'viewport' | 'element' | 'full_page';

export interface ImageGeometry {
  readonly width: number;
  readonly height: number;
}

/**
 * What reconciliation concluded, and what the caller is told.
 *
 * `comparableHeight` is `null` exactly when there is nothing to compare, which
 * is the one shape a caller must branch on before reading a pixel count.
 */
export interface ReconciledGeometry {
  /** The width both images share, or `null` when they do not share one. */
  readonly width: number | null;
  /** The height the comparison runs over, or `null` when there is none. */
  readonly comparableHeight: number | null;
  /** True when the two widths differ. */
  readonly widthMismatch: boolean;
  /**
   * The change in page length, in pixels, **and only on a full page** — new
   * height minus earlier height. `null` on any other kind, and `null` when
   * the heights agree.
   *
   * Its own fact rather than a region: §3.11.
   */
  readonly pageLengthChange: number | null;
  /**
   * True when the images differ in a way that stops the comparison being
   * meaningful, and the result must say so instead of reporting pixels.
   */
  readonly comparable: boolean;
  /**
   * A sentence for the caller, or `null` when nothing needed saying.
   *
   * Present whenever anything differed — including the comparable case of a
   * full page that grew — because a length change the caller cannot see is a
   * length change it will attribute to something else.
   */
  readonly explanation: string | null;
}

/**
 * Reconcile the two geometries.
 *
 * Takes the kind of the **new** capture. The earlier capture's own kind is
 * deliberately not consulted: what a caller can act on is what it just asked
 * for, and a full-page picture compared against a viewport one is a caller
 * mistake that the page-length fact describes perfectly well without a second
 * enumeration of which-kind-against-which-kind.
 */
export function reconcileGeometry(
  earlier: ImageGeometry,
  current: ImageGeometry,
  kind: CaptureKind,
): ReconciledGeometry {
  const widthMismatch = earlier.width !== current.width;

  // A width mismatch stops the comparison outright. There is no honest
  // sub-rectangle to fall back to: content reflows across a width change, so
  // the leftmost shared column of a 1024-wide page is not the same content as
  // the leftmost shared column of a 1440-wide one. Comparing the overlap
  // would produce a confident number about two different layouts.
  if (widthMismatch) {
    return {
      width: null,
      comparableHeight: null,
      widthMismatch: true,
      pageLengthChange: null,
      comparable: false,
      explanation:
        `The two captures are different widths — the earlier one is ${String(earlier.width)} pixels ` +
        `wide and this one is ${String(current.width)}. No diff was produced: content reflows across a ` +
        'width change, so comparing them would report a difference at nearly every pixel. Capture both at ' +
        'the same viewport width to compare them.',
    };
  }

  const heightMismatch = earlier.height !== current.height;
  const fullPage = kind === 'full_page';

  if (!heightMismatch) {
    return {
      width: current.width,
      comparableHeight: current.height,
      widthMismatch: false,
      pageLengthChange: null,
      comparable: true,
      explanation: null,
    };
  }

  // A height mismatch on anything but a full page is the same situation a
  // width mismatch is: a viewport is a fixed rectangle, so two viewport
  // pictures of different heights were taken at different viewport sizes, and
  // an element that changed height changed shape rather than grew a page.
  if (!fullPage) {
    return {
      width: null,
      comparableHeight: null,
      widthMismatch: false,
      pageLengthChange: null,
      comparable: false,
      explanation:
        `The two captures are different heights — the earlier one is ${String(earlier.height)} pixels ` +
        `tall and this one is ${String(current.height)} — and this is a ${kind} capture, whose height is ` +
        'fixed by what was captured rather than by how much content there was. No diff was produced. A ' +
        'full-page capture is the one whose height is allowed to differ.',
    };
  }

  const shared = Math.min(earlier.height, current.height);
  const change = current.height - earlier.height;

  // Two full pages that share no rows at all. Vanishingly unlikely in
  // practice and still a real shape — a page that failed to render is one
  // pixel tall — and a comparison over zero rows would report zero changed
  // pixels, which reads as "nothing changed".
  if (shared <= 0) {
    return {
      width: null,
      comparableHeight: null,
      widthMismatch: false,
      pageLengthChange: change,
      comparable: false,
      explanation:
        `The two full-page captures share no rows to compare — the earlier one is ` +
        `${String(earlier.height)} pixels tall and this one is ${String(current.height)}. No diff was ` +
        'produced.',
    };
  }

  return {
    width: current.width,
    comparableHeight: shared,
    widthMismatch: false,
    pageLengthChange: change,
    comparable: true,
    explanation:
      `The page got ${change > 0 ? 'longer' : 'shorter'} by ${String(Math.abs(change))} pixels — the ` +
      `earlier capture is ${String(earlier.height)} tall and this one is ${String(current.height)}. That ` +
      `is reported as a change in page length rather than as a changed region. The comparison ran over ` +
      `the top ${String(shared)} rows they share.`,
  };
}
