/**
 * The seam between the comparison feature and the capture pipeline.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS A SEAM, NOT AN IMPLEMENTATION. READ THIS BEFORE USING IT.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **The capture pipeline is a separate row and does not exist in this build.**
 * `MILESTONES.md` #40 lists #31 among its prerequisites, and nothing in this
 * tree writes a `captures` row or a capture file. So this milestone defines the
 * two things it needs from capture — **look up a capture** and **read its
 * bytes** — as an interface, and ships no production implementation of either.
 *
 * **What that means for anyone reading this:**
 *
 * - Everything in `src/diff/` is real and complete. The comparison, the region
 *   extraction, the crops, the overlay and the filter are not stubbed.
 * - Everything in `src/service/comparison.ts` is real: it writes a genuine
 *   `comparisons` row through the real store, writes genuine PNG files to the
 *   artifact root, and produces the response shape §1.9 specifies.
 * - **What is stubbed is one narrow thing:** where the two images come from.
 *   The comparison is handed a `CaptureSource`, and the only implementation in
 *   this build is the store-backed one below, which reads a row that something
 *   else must have written and a file that something else must have put there.
 * - **There is no fake or in-memory capture pipeline in `src/`.** The tests
 *   supply their own source, and the store-backed implementation is the one
 *   the capture row will use unchanged.
 *
 * ── Why this shape and not a direct query ───────────────────────────────
 *
 * The direction of the dependency is the whole point. §7.3 carries
 * `capture.no_diff_dependency`: "**no capture path reads anything belonging to
 * the diff feature**. This is what keeps the sequencing property real rather
 * than intended: diffing is built last, so a capture that consulted it would
 * make the earlier work depend on the later."
 *
 * That rule points one way, and this interface is what makes the other way
 * explicit: **the diff reads capture, capture never reads the diff.** A capture
 * row can hand this a source and get a diff back without capture knowing what a
 * comparison is.
 */

import type { CaptureKind } from '../diff/geometry.ts';

/** What the comparison needs to know about a capture. A subset of §1.7. */
export interface CaptureRecord {
  readonly id: string;
  /** Whose lease it belongs to. What §1.9's ownership check is made against. */
  readonly claimId: string;
  /** Relative to the artifact root, never absolute (§1.7a). */
  readonly path: string;
  readonly kind: CaptureKind;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the comparison gets its images.
 *
 * Two operations, deliberately separate. Looking a capture up is a store read
 * and answering "was it found" needs no file at all — which matters because
 * §1.9's missing-target path has to distinguish "no such row" from "the row is
 * there", and reading bytes to find out would be a wasted file read on the
 * ordinary path and a confusing error on the failure one.
 */
export interface CaptureSource {
  /**
   * Find a capture by identifier, or `null` if there is no such row.
   *
   * **`null` rather than a throw**, because "not found" is the ordinary case
   * §1.9 builds its entire failure mode around: "the ordinary reason it does
   * not [find it] is that the caller named the wrong thing". A throw would put
   * the expected case on the exceptional path.
   */
  readonly find: (captureId: string) => CaptureRecord | null;
  /** Read a capture's bytes from disk. */
  readonly readBytes: (capture: CaptureRecord) => Promise<Uint8Array>;
}
