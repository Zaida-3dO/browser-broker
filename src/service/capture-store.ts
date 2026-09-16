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

/**
 * The most recent earlier capture of **this same page at this same viewport**
 * by this lease, or nothing.
 *
 * ── What this is for, and the measurement that asked for it ─────────────
 *
 * A diff against a prior capture costs a few hundred tokens; opening the new
 * picture with `Read` costs around ninety thousand. The response has carried a
 * pre-filled `compare_to` argument on every capture since the hint shipped —
 * and it was **measured not to work**: over four clean days, 36 expensive
 * image reads happened in sessions that had already been handed the exact
 * argument that would have made them cheap.
 *
 * The diagnosis in that measurement is the design constraint here, and it is
 * worth carrying rather than citing: **the hint arrives on capture N
 * describing what capture N+1 could do.** At that moment the caller's intent
 * is *"record this"*. The diff intent forms on capture N+1, by which time the
 * hint has scrolled out of attention. The pointer was correctly placed for the
 * **id** and misplaced for the **intent**.
 *
 * So this query exists to move the pointer to the moment of the repeat: the
 * caller who has just taken the same picture twice is the caller who wants a
 * diff, and this is what lets the response say so *then*.
 *
 * ── Three properties that are not incidental ────────────────────────────
 *
 * **Scoped to the lease**, not global. The `strandedBacklog` note on `claim`
 * (PR #74) is the pattern: computed from data the call already has, on the
 * connection it already holds, so an informational nudge never costs a round
 * trip and can never be the reason a capture is slow.
 *
 * **A NULL `url` never matches.** The column is nullable, and SQL's `=` is
 * already unknown against NULL — but it is written out below rather than left
 * to that, because "two captures whose page is unrecorded" is not a repeat and
 * an implementation relying on three-valued logic to express that reads as an
 * accident.
 *
 * **Never a refusal, and structurally incapable of becoming one.** The return
 * is an id or nothing. There is no count, no threshold and no boolean a caller
 * upstream could branch on to deny a capture — a caller with a good reason to
 * retake a picture must not have to argue with the tool, which is the same
 * posture `accounting.ts` takes and for the same reason.
 *
 * @param excludingCaptureId the capture just taken. **Required, because this
 *   is called after the pipeline has run** — it needs the settled URL, which
 *   is only known once the page has loaded. Whether this runs before or after
 *   that capture's own row is written, passing its id means the answer cannot
 *   be the capture itself, so the ordering of the two statements stops being
 *   load-bearing.
 */
export interface CaptureRepeat {
  /** The earlier capture of this same view, ready to pass as `compare_to`. */
  readonly captureId: string;
  /**
   * The nudge in words, naming the cheaper call and the argument to give it.
   *
   * Spelled out rather than left to be assembled, for the reason the
   * measurement gives: the argument being *available* was never the gap. A
   * caller reading one line has to be able to act on it without composing
   * anything.
   */
  readonly hint: string;
}

export function priorCaptureOfSameView(
  db: Database,
  claimId: string,
  view: { readonly url: string | undefined; readonly viewportWidth: number },
  excludingCaptureId: string,
): string | undefined {
  if (view.url === undefined) return undefined;
  const row = db
    .prepare<[string, string, number, string], { id: string }>(
      `SELECT id
         FROM captures
        WHERE claim_id = ?
          AND url = ?
          AND url IS NOT NULL
          AND viewport_width = ?
          AND id <> ?
        ORDER BY taken_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(claimId, view.url, view.viewportWidth, excludingCaptureId);
  return row?.id;
}
