/**
 * The resolution-ladder harness (`MILESTONES.md` #34).
 *
 * Sweeps one picture down a ladder of longest-edge caps and records, per rung,
 * what the study needs to compare rungs against each other: **the dimensions,
 * the bytes, the downscale ratio, and the estimated token cost.**
 *
 * ── It measures the pipeline that ships, not a better one ───────────────
 *
 * Every rung here goes through {@link downscale} and {@link encodePng} — the
 * same box filter and the same encoder the capture pipeline uses. That is the
 * point rather than an economy: `image.ts` names its resampler's cost outright
 * (box averaging is softer than a bicubic or Lanczos filter), and a study run
 * on a hypothetical better resampler would settle rungs this service does not
 * have. **The numbers this produces are only claims about this pipeline.**
 *
 * ── Where the fields come from ──────────────────────────────────────────
 *
 * `bytes` is the length of the re-encoded PNG, which is what `captures.bytes`
 * records (§1.7) and therefore comparable with a real capture's telemetry.
 * `estimatedTokens` comes from {@link estimateTokens} — the formula §6.4 fixes
 * by the version, taking dimensions and nothing else, so a rung's cost here is
 * computed exactly as a live capture's is.
 *
 * **This harness reaches no store and no browser.** It takes decoded pixels and
 * returns numbers, which is what lets the study run its arithmetic rungs in
 * continuous integration with no browser binary while the rendered-text rungs
 * skip.
 */

import { downscale, encodePng, scaledDimensions, type RasterImage } from './image.ts';
import { estimateTokens } from './tiers.ts';

/** What one rung of the ladder cost, and what it produced. */
export interface LadderRung {
  /** The longest-edge cap this rung applies, in pixels. */
  readonly longestEdge: number;
  /** What the picture became. Equal to the source when nothing was shrunk. */
  readonly width: number;
  readonly height: number;
  /** The re-encoded size, comparable with `captures.bytes` (§1.7). */
  readonly bytes: number;
  /**
   * Destination pixels per source pixel along one edge — `1` when nothing was
   * shrunk, `0.5` when the picture was halved.
   *
   * Reported as a linear ratio rather than an area one because it is the linear
   * figure that predicts what happens to a stroke: a mark one source pixel wide
   * survives at this fraction of its original contrast.
   */
  readonly ratio: number;
  /** By the formula the version fixes (§6.4). */
  readonly estimatedTokens: number;
  /** The shrunk pixels, for a caller measuring what survived. */
  readonly image: RasterImage;
}

/**
 * Sweep one picture down a ladder of caps.
 *
 * The rungs are given rather than read from {@link TIER_LONGEST_EDGE}, because
 * a study that could only measure the three numbers already shipped could never
 * discover that a fourth is better. The shipped rungs are one input among
 * several.
 */
export function sweepLadder(source: RasterImage, rungs: readonly number[]): readonly LadderRung[] {
  return rungs.map((longestEdge) => {
    const shrunk = downscale(source, longestEdge);
    const target = scaledDimensions(source.width, source.height, longestEdge);
    const longest = Math.max(source.width, source.height);
    return {
      longestEdge,
      width: shrunk.width,
      height: shrunk.height,
      bytes: encodePng(shrunk).length,
      // Guarded against a zero-size source, which is not an image but is also
      // not this function's business to refuse.
      ratio: longest === 0 ? 1 : Math.min(1, target.width / Math.max(1, source.width)),
      estimatedTokens: estimateTokens(shrunk.width, shrunk.height),
      image: shrunk,
    };
  });
}

/**
 * Render a sweep as a table, for the study's own report.
 *
 * Plain text rather than anything structured: this exists so a measurement can
 * be **read** in a pull request body and checked against the assertions that
 * quote it, which is the whole difference between publishing evidence and
 * publishing numbers.
 */
export function formatLadder(rungs: readonly LadderRung[]): string {
  const header = '| long edge | dimensions | ratio | bytes | est. tokens |';
  const rule = '|---|---|---|---|---|';
  const rows = rungs.map(
    (rung) =>
      `| ${String(rung.longestEdge)} | ${String(rung.width)}x${String(rung.height)} | ` +
      `${rung.ratio.toFixed(3)} | ${String(rung.bytes)} | ${String(rung.estimatedTokens)} |`,
  );
  return [header, rule, ...rows].join('\n');
}
