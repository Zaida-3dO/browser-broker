import type { Database } from 'better-sqlite3';

import type { CaptureTelemetry } from '../capture/pipeline.ts';

/**
 * The `captures` row (§1.7), written by the layer that owns the transaction.
 *
 * ── Why this is a module and not two lines inside the capture handler ────
 *
 * `capture/pipeline.ts` says outright what it will not do: *"It does not write
 * a database row"*, and gives the reason — keeping the split means the
 * pipeline is testable against the fake driver with no store at all. So the
 * pipeline computes {@link CaptureTelemetry} and somebody else writes it, and
 * this is that somebody.
 *
 * ── The gap this closes, stated as the thing that was true ──────────────
 *
 * `takeCapture` had **no caller anywhere in `src/`**. `decideCapture` reached
 * the browser directly and threw the picture away: no downscaling, no file,
 * no row. The consequence was measurable and was measured — a caller driving
 * the shipped binary got `capture -> {"outcome":"accepted",…}` while `SELECT
 * count(*) FROM captures` returned **0**, which is the exact observation
 * `TabOperationResult.pageDriven` was added to describe. `pageDriven` made the
 * silence honest; this makes the picture exist.
 *
 * ── Written after the commit, and why that is correct rather than a compromise ──
 *
 * A capture is browser work: it settles the page, takes a picture and writes a
 * file, none of which may happen inside the arbitration transaction (§2.4b).
 * So the row is written on its own short statement afterwards, the same way
 * `recordTabOpened` writes a driver name after a page is opened.
 *
 * **The row is the record that a file exists**, so writing it before the file
 * would be the same class of error this whole area keeps producing: a store
 * asserting something that did not happen. It is written last, from telemetry
 * describing a file that is already on disk.
 */

/**
 * Append one capture row.
 *
 * `taken_at`, `created_at` and `updated_at` are left to their defaults except
 * `taken_at`, which carries the pipeline's own instant: the pipeline stamps
 * the file name from it, and a row whose timestamp disagreed with the name of
 * the file it points at would be unreadable as a pair.
 */
export function recordCapture(
  db: Database,
  claimId: string,
  tabId: string,
  telemetry: CaptureTelemetry,
): void {
  db.prepare(
    `INSERT INTO captures (
       id, claim_id, tab_id, taken_at, kind, tier, reason,
       source_width, source_height, width, height, bytes,
       path, selector, viewport_width, url, warned
     ) VALUES (
       @id, @claimId, @tabId, @takenAt, @kind, @tier, @reason,
       @sourceWidth, @sourceHeight, @width, @height, @bytes,
       @path, @selector, @viewportWidth, @url, @warned
     )`,
  ).run({
    id: telemetry.id,
    claimId,
    tabId,
    takenAt: telemetry.takenAt.toISOString(),
    kind: telemetry.kind,
    tier: telemetry.tier,
    // `null` rather than `undefined`: the driver refuses a bound parameter
    // that is undefined, and the column is nullable precisely because a reason
    // is owed only on the top tier.
    reason: telemetry.reason ?? null,
    sourceWidth: telemetry.sourceWidth,
    sourceHeight: telemetry.sourceHeight,
    width: telemetry.width,
    height: telemetry.height,
    bytes: telemetry.bytes,
    path: telemetry.path,
    selector: telemetry.selector ?? null,
    viewportWidth: telemetry.viewportWidth,
    url: telemetry.url,
    // The column is an integer with a check constraint on (0, 1); the store is
    // STRICT, so a boolean would be refused rather than coerced.
    warned: telemetry.warned ? 1 : 0,
  });
}

/**
 * How many captures this lease has already taken.
 *
 * `takeCapture` takes this as an argument because *"counting is a query
 * against the store and this module reaches no store"* — so the count is made
 * here and handed in. It decides only the accounting warning, which is
 * guidance and never a refusal (`capture/accounting.ts`), so a count read a
 * moment before another process writes its own row costs a warning that fires
 * one capture late. It is not a budget and nothing is denied on it.
 */
export function capturesTakenBy(db: Database, claimId: string): number {
  const row = db
    .prepare<[string], { taken: number }>(
      'SELECT count(*) AS taken FROM captures WHERE claim_id = ?',
    )
    .get(claimId);
  return row?.taken ?? 0;
}
