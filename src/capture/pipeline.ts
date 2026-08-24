import { randomUUID } from 'node:crypto';

import type { ArtifactStore } from '../artifacts/store.ts';
import { captureFileName } from '../artifacts/names.ts';
import type { CaptureMask, TabHandle, TabOperations } from '../browser/driver.ts';
import { BrokerError } from '../errors.ts';
import { captureWarning } from './accounting.ts';
import { decodePng, downscale, encodePng } from './image.ts';
import {
  DEFAULT_TIER,
  REASON_MAXIMUM_LENGTH,
  REASON_MINIMUM_LENGTH,
  TIER_LONGEST_EDGE,
  TIER_REQUIRING_REASON,
  estimateTokens,
  type CaptureTier,
  type RequestableTier,
} from './tiers.ts';

/**
 * The capture pipeline: **settle, take, downscale, write, and hand back a path
 * and its dimensions — never the image** (`MILESTONES.md` #31, #32, #33).
 *
 * ── The cost argument this whole module is shaped by ────────────────────
 *
 * **A screenshot in a conversation is re-ingested on every subsequent turn.**
 * That is the fact everything here follows from. Returning a path rather than
 * an image is what makes a capture cost **once instead of N times**, and it is
 * why `SCHEMA.md` §3.11 is emphatic that what comes back is *"a path, the
 * dimensions written, the dimensions before shrinking, the file size, the
 * tier, an estimated token cost … **Never the image.**"* The caller opens the
 * file only when it genuinely needs to *look*.
 *
 * {@link CaptureResult} has no field that could carry pixels. That is the
 * enforcement — not a rule in a document, a shape with nowhere to put them.
 *
 * ── IT CONSULTS NOTHING BELONGING TO THE DIFF FEATURE ───────────────────
 *
 * This module imports the artifact store, the browser seam, the image
 * routines, the tiers and the accounting — and **nothing from a comparison,
 * a baseline, a region or an overlay**, because none of those exist yet and
 * nothing here may make them a prerequisite.
 *
 * `SCHEMA.md` §3.11 states the sequencing property: *"Capture must not depend
 * on diffing. Diffing is the last thing built, and nothing earlier may require
 * it."* An earlier arrangement had a capture consult a canonical picture for
 * the view it named and take the picture **at that picture's geometry**, which
 * made the ordinary capture path depend on the comparison feature's data model
 * — every capture then carried a reason to fail that had nothing to do with
 * capturing. **There is no such rule now: a capture is taken at the tier the
 * caller asked for, always.**
 *
 * That is an *absence*, and an absence is only checkable by a build rule —
 * which is what `scripts/check-capture-isolation.mjs` is
 * (`capture.no_diff_dependency`, §7.3). Read that script's header for what it
 * can and cannot prove.
 *
 * ── What this module does NOT do ────────────────────────────────────────
 *
 * **It does not write a database row**, and it does not resolve a tab
 * identifier to a tab. It takes a {@link TabHandle} and returns everything
 * `captures` (§1.7) needs recorded, as {@link CaptureTelemetry}. The service
 * operation that owns the store transaction is the layer above, and keeping
 * the split here means the pipeline is testable against the fake driver with
 * no store at all — and means `db.import_isolated` (§7.3) holds without this
 * module being an exception to it.
 */

/** What a caller asked for. `tier` absent is the whole lever — see `tiers.ts`. */
export interface CaptureRequestOptions {
  /**
   * **Absent means the cheapest rung** (`SCHEMA.md` §3.11). Typed as
   * {@link RequestableTier}, which excludes `default`, so *"there is
   * deliberately no way to ask for the default explicitly"* is a compile error
   * rather than a line in a document.
   */
  readonly tier?: RequestableTier;
  /** Required on the top tier, free text, 8–200 characters. Recorded. */
  readonly reason?: string;
  /** Off by default: unbounded page height crosses the expensive threshold far more often than width. */
  readonly fullPage?: boolean;
  /** One element. Cannot be combined with a full page. */
  readonly selector?: string;
  /** A caller's own name for this. **Goes in the file name and nothing else.** */
  readonly label?: string;
  /** Painted over **before** the shutter, never filtered afterwards. */
  readonly mask?: readonly CaptureMask[];
}

/**
 * Everything `captures` (§1.7) records, computed here and written by the layer
 * that owns the transaction.
 *
 * **`estimatedTokens` is on the result and not in this list of columns for a
 * reason** (§1.7): there is no `estimated_tokens` column, because it is width
 * times height over a fixed constant — a calculation over two columns on the
 * same row — and freezing it into a column would let it disagree with the
 * dimensions beside it.
 */
export interface CaptureTelemetry {
  readonly id: string;
  readonly kind: 'viewport' | 'element' | 'full_page';
  readonly tier: CaptureTier;
  /** Free text, and **only ever present on the top tier**. */
  readonly reason: string | undefined;
  /** What the browser produced, before any shrinking. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** What was written. Equal to the pair above when nothing was shrunk. */
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** **Relative to the artifact root, never absolute** (§1.7a). */
  readonly path: string;
  readonly selector: string | undefined;
  /** The breakpoint (§1.7). */
  readonly viewportWidth: number;
  readonly url: string;
  /** Whether the accounting warning fired on this capture (§1.7). */
  readonly warned: boolean;
  readonly takenAt: Date;
}

/**
 * What comes back to a caller.
 *
 * **A path and its dimensions. There is no field here that could hold an
 * image**, and that is the shape the cost argument at the top of this file
 * reduces to.
 */
export interface CaptureResult {
  readonly captureId: string;
  /** **Relative to the artifact root** — the caller resolves it or asks the service to serve it. */
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** What the browser produced, so "was this downscaled" is answerable without a flag. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly tier: CaptureTier;
  /** Estimated, from the dimensions, by the formula the version fixes (§6.4). */
  readonly estimatedTokens: number;
  /** How many captures this lease has now taken (§3.11). */
  readonly capturesThisLease: number;
  /**
   * **How to escalate — present exactly when the capture landed on the default
   * tier** (§3.11). Never a refusal and never a warning; it is guidance a
   * caller cannot be expected to have read a specification for.
   */
  readonly escalation?: string;
  /**
   * The accounting warning, when this capture was past the threshold (#33).
   * **Never a refusal** — see `accounting.ts`.
   */
  readonly warning?: string;
  /** Everything the `captures` row needs. */
  readonly telemetry: CaptureTelemetry;
}

/**
 * The escalation guidance, built from the tier names themselves.
 *
 * `SCHEMA.md` §3.11 is specific about what this must say, and the specificity
 * is the point: *"Not merely that higher tiers exist — **which fields to
 * pass**, naming `tier` and its two values, **and that the top tier requires a
 * written reason.**"* A caller that cannot read the fine print out of a
 * specification it does not have open is a caller that either never escalates
 * or escalates by trial and error, and both waste a call.
 *
 * Composed from {@link TIER_LONGEST_EDGE} and {@link TIER_REQUIRING_REASON}
 * rather than written out, so a rung the study moves (#34) cannot leave this
 * text quoting a number that is no longer true.
 */
function escalationGuidance(): string {
  return (
    `This is the default resolution (about ${String(TIER_LONGEST_EDGE.default)}px on the long ` +
    `edge), which is what you get for passing no tier. For more detail pass ` +
    `tier="detail" (about ${String(TIER_LONGEST_EDGE.detail)}px). For the most, pass ` +
    `tier="max" (about ${String(TIER_LONGEST_EDGE.max)}px) — and note that "max" additionally ` +
    `requires reason, a written explanation of ${String(REASON_MINIMUM_LENGTH)}–` +
    `${String(REASON_MAXIMUM_LENGTH)} characters in your own words. The reason is recorded for ` +
    `review rather than used to decide anything: escalating is allowed, and saying why is how ` +
    `the default gets tuned.`
  );
}

/**
 * The three argument mistakes §3.11 names, and **the only refusals here.**
 *
 * *"The only refusals are argument mistakes: an unknown or closed tab, the top
 * tier without a reason, and a selector combined with a full page."* The first
 * belongs to the layer that resolves a tab identifier; the other two are this
 * module's.
 *
 * **Nothing in this function considers cost, budget, count or resolution**,
 * and that absence is what `capture.never_refused_for_cost` (§7.3) asserts.
 * Every refusal it can make is about the arguments disagreeing with each
 * other, never about how many pictures anybody has taken.
 */
function refuseArgumentMistakes(options: CaptureRequestOptions): void {
  if (options.fullPage === true && options.selector !== undefined) {
    throw new BrokerError(
      'capture.arguments_consistent',
      'A selector cannot be combined with a full page: one asks for a single element and the other for the whole document. Pass one or the other.',
    );
  }

  const tier: CaptureTier = options.tier ?? DEFAULT_TIER;
  if (tier !== TIER_REQUIRING_REASON) {
    return;
  }

  const reason = options.reason?.trim() ?? '';
  if (reason.length < REASON_MINIMUM_LENGTH || reason.length > REASON_MAXIMUM_LENGTH) {
    throw new BrokerError(
      'capture.reason_required',
      `tier="${TIER_REQUIRING_REASON}" requires reason: a written explanation of ${String(REASON_MINIMUM_LENGTH)}–${String(REASON_MAXIMUM_LENGTH)} characters, in your own words rather than chosen from a list. It is recorded for review, not used to decide whether to serve the capture — nothing here is refused on cost grounds.`,
    );
  }
}

/** What the pipeline needs to take one picture. */
export interface CapturePipelineDependencies {
  readonly tabs: TabOperations;
  readonly artifacts: ArtifactStore;
  /** Injected so a test can pin the stamp in a file name. */
  readonly now?: () => Date;
  /** Injected so a test can pin the identifier in a file name. */
  readonly newId?: () => string;
}

/**
 * Take one capture.
 *
 * @param capturesTakenBefore how many captures this lease had already taken.
 *   Supplied by the layer that counts them, because counting is a query
 *   against the store and this module reaches no store.
 *
 * The order below is the specification and is not incidental:
 *
 * 1. **Refuse the argument mistakes first**, before anything physical happens.
 *    `DECISIONS.md` §5: *a guard that returns "denied" after the tab has
 *    already opened is worse than no guard.* The refusals above run before the
 *    driver is touched at all, and the test for each asserts the driver's call
 *    log is empty rather than merely that an error was thrown.
 * 2. **Settle the page, then take the picture** (§3.11). Two calls in that
 *    order, on the seam, so the ordering is assertable from outside.
 * 3. **Downscale to the tier**, never up.
 * 4. **Write it**, through the artifact store, which is the only thing that
 *    decides where a file may go.
 */
export async function takeCapture(
  dependencies: CapturePipelineDependencies,
  claimId: string,
  tab: TabHandle,
  options: CaptureRequestOptions,
  capturesTakenBefore: number,
): Promise<CaptureResult> {
  refuseArgumentMistakes(options);

  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? randomUUID;
  const tier: CaptureTier = options.tier ?? DEFAULT_TIER;
  const fullPage = options.fullPage ?? false;

  // Settling comes before the shutter and is a separate call, so that "every
  // capture settles the page first" is one assertion on the driver's call log
  // rather than a claim about a driver's internals (§3.11).
  await dependencies.tabs.settlePage(tab);

  const raw = await dependencies.tabs.capture(tab, {
    fullPage,
    selector: options.selector,
    // Passed straight through to the driver, because masking *before* the
    // pixels exist beats filtering afterwards: a region that was never
    // captured cannot be reported as changed (§3.11).
    mask: options.mask,
  });

  const decoded = decodePng(raw.image);
  const shrunk = downscale(decoded, TIER_LONGEST_EDGE[tier]);
  // Re-encoded only when the pixels actually changed. A picture already inside
  // the rung is written as the browser produced it, which keeps
  // `width === source_width` meaning "nothing was shrunk" without a re-encode
  // silently changing the bytes underneath that claim.
  const encoded = shrunk === decoded ? raw.image : encodePng(shrunk);

  const takenAt = now();
  const id = newId();
  const stored = dependencies.artifacts.write(
    claimId,
    'images',
    captureFileName({
      // Derived from the address, with the query string stripped first — see
      // `names.ts` for why a file name is held to a stricter rule than a
      // column is.
      url: raw.url,
      label: options.label,
      viewportWidth: raw.viewportWidth,
      takenAt,
      id,
    }),
    encoded,
  );

  const warning = captureWarning(capturesTakenBefore);
  const kind = options.selector !== undefined ? 'element' : fullPage ? 'full_page' : 'viewport';

  const telemetry: CaptureTelemetry = {
    id,
    kind,
    tier,
    // Only ever recorded on the tier that requires it: a reason attached to a
    // capture nobody had to justify would put noise into the one column the
    // resolution study reads (§1.7).
    reason: tier === TIER_REQUIRING_REASON ? options.reason?.trim() : undefined,
    sourceWidth: raw.width,
    sourceHeight: raw.height,
    width: shrunk.width,
    height: shrunk.height,
    bytes: stored.bytes,
    path: stored.relativePath,
    selector: options.selector,
    viewportWidth: raw.viewportWidth,
    url: raw.url,
    warned: warning !== undefined,
    takenAt,
  };

  return {
    captureId: id,
    path: stored.relativePath,
    width: shrunk.width,
    height: shrunk.height,
    bytes: stored.bytes,
    sourceWidth: raw.width,
    sourceHeight: raw.height,
    tier,
    estimatedTokens: estimateTokens(shrunk.width, shrunk.height),
    capturesThisLease: capturesTakenBefore + 1,
    // Present exactly when the caller landed on the default rung, because that
    // is exactly the caller who has not been told what the alternatives are.
    ...(tier === DEFAULT_TIER ? { escalation: escalationGuidance() } : {}),
    ...(warning !== undefined ? { warning } : {}),
    telemetry,
  };
}
