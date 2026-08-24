import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import type { ComparisonRegion, ComparisonRow } from './comparison.ts';

/**
 * Reading and writing `comparisons` (`SCHEMA.md` §1.9, `MILESTONES.md` #40 and
 * #48).
 *
 * ── Why this table exists at all, given the rule against storing what can be
 *    computed ─────────────────────────────────────────────────────────────
 *
 * §1.9 answers it, and the first reason is the one that decides the shape of
 * everything here:
 *
 * > **It cannot be reproduced from a rerun.** The three filtering numbers are
 * > configuration, so re-running a diff after any of them moves answers a
 * > different question from the one that was asked. What an earlier call *did*,
 * > under the numbers in force at the time, is exactly what tuning needs to
 * > know and is not recoverable afterwards.
 *
 * So **all three settings are copied onto the row**, not referenced — §1.9:
 * "snapshotting one and referencing the others would be a record that is
 * half-true".
 *
 * ── The regions are stored as a document, and that is a deliberate exception
 *
 * Every other relationship in this schema is a foreign key. The region list is
 * not, and the reason is that a region has no identity: it is not referenced by
 * anything, never updated, and only ever read back as the whole list belonging
 * to one comparison. A `comparison_regions` table would add a second write per
 * region and a join to every read, to model something that is always fetched
 * and discarded together.
 *
 * **What that costs is stated rather than hidden:** the crop paths inside the
 * document are not enforceable as references the way the three identifiers on
 * the row are. §1.9 names exactly that property as one of the table's
 * justifications — "which capture, which target and which lease are real
 * foreign keys in a table" — and those three *are* columns. The region paths
 * are not in that set, and nothing checks that a crop file still exists.
 */

/** A comparison as it is read back. */
export interface StoredComparison {
  readonly id: string;
  readonly sourceCaptureId: string;
  readonly targetCaptureId: string;
  readonly claimId: string;
  readonly at: string;
  readonly colourTolerance: number;
  readonly minimumRegionArea: number;
  readonly maximumRegions: number;
  readonly changedPixels: number;
  readonly changedRatio: number;
  readonly changed: boolean;
  readonly regions: readonly ComparisonRegion[];
  readonly overlayPath: string;
  readonly truncated: boolean;
}

const INSERT = `
INSERT INTO comparisons (
  id, source_capture_id, target_capture_id, claim_id,
  colour_tolerance, minimum_region_area, maximum_regions,
  changed_pixels, changed_ratio, changed, regions, overlay_path, truncated
) VALUES (
  @id, @sourceCaptureId, @targetCaptureId, @claimId,
  @colourTolerance, @minimumRegionArea, @maximumRegions,
  @changedPixels, @changedRatio, @changed, @regions, @overlayPath, @truncated
)
`;

/**
 * Write one comparison and return its identifier.
 *
 * Synchronous, because the driver is, and because this is called from inside a
 * transaction the caller opened — an `await` in there would let another
 * operation interleave with a write that is meant to be one unit.
 */
export function insertComparison(db: Database, row: ComparisonRow): string {
  const id = randomUUID();
  db.prepare(INSERT).run({
    id,
    sourceCaptureId: row.sourceCaptureId,
    targetCaptureId: row.targetCaptureId,
    claimId: row.claimId,
    colourTolerance: row.colourTolerance,
    minimumRegionArea: row.minimumRegionArea,
    maximumRegions: row.maximumRegions,
    changedPixels: row.changedPixels,
    changedRatio: row.changedRatio,
    // The column is an integer with a check constraint on nought-or-one, per
    // the schema's own convention for a boolean.
    changed: row.changed ? 1 : 0,
    regions: JSON.stringify(row.regions),
    overlayPath: row.overlayPath,
    truncated: row.truncated ? 1 : 0,
  });
  return id;
}

interface ComparisonColumns {
  readonly id: string;
  readonly source_capture_id: string;
  readonly target_capture_id: string;
  readonly claim_id: string;
  readonly at: string;
  readonly colour_tolerance: number;
  readonly minimum_region_area: number;
  readonly maximum_regions: number;
  readonly changed_pixels: number;
  readonly changed_ratio: number;
  readonly changed: number;
  readonly regions: string;
  readonly overlay_path: string;
  readonly truncated: number;
}

function hydrate(columns: ComparisonColumns): StoredComparison {
  return {
    id: columns.id,
    sourceCaptureId: columns.source_capture_id,
    targetCaptureId: columns.target_capture_id,
    claimId: columns.claim_id,
    at: columns.at,
    colourTolerance: columns.colour_tolerance,
    minimumRegionArea: columns.minimum_region_area,
    maximumRegions: columns.maximum_regions,
    changedPixels: columns.changed_pixels,
    changedRatio: columns.changed_ratio,
    changed: columns.changed === 1,
    regions: JSON.parse(columns.regions) as ComparisonRegion[],
    overlayPath: columns.overlay_path,
    truncated: columns.truncated === 1,
  };
}

const SELECT = `
SELECT id, source_capture_id, target_capture_id, claim_id, at,
       colour_tolerance, minimum_region_area, maximum_regions,
       changed_pixels, changed_ratio, changed, regions, overlay_path, truncated
  FROM comparisons
`;

/**
 * How a listing is narrowed (#48): "listing them by capture, by target or by
 * lease".
 *
 * All three are optional and they combine, which is what makes the surface
 * useful for tuning rather than merely present: *"the diffs this lease ran
 * against that capture"* is the question somebody actually asks, and it needs
 * two of them at once.
 */
export interface ComparisonQuery {
  /** Diffs run **from** this capture. */
  readonly sourceCaptureId?: string;
  /** Diffs run **against** this capture. */
  readonly targetCaptureId?: string;
  /** Diffs run by this lease. */
  readonly claimId?: string;
  readonly limit?: number;
}

/**
 * List comparisons, most recent first.
 *
 * **Most recent first** because the reason this surface exists is tuning, and
 * the question tuning asks is what the current numbers have been doing. The
 * indexes on the table are `(source_capture_id, at DESC)` and
 * `(target_capture_id)`, so the first ordering is the one already paid for.
 */
export function listComparisons(db: Database, query: ComparisonQuery = {}): StoredComparison[] {
  const conditions: string[] = [];
  const parameters: Record<string, unknown> = {};

  if (query.sourceCaptureId !== undefined) {
    conditions.push('source_capture_id = @sourceCaptureId');
    parameters['sourceCaptureId'] = query.sourceCaptureId;
  }
  if (query.targetCaptureId !== undefined) {
    conditions.push('target_capture_id = @targetCaptureId');
    parameters['targetCaptureId'] = query.targetCaptureId;
  }
  if (query.claimId !== undefined) {
    conditions.push('claim_id = @claimId');
    parameters['claimId'] = query.claimId;
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  // The limit is interpolated as a validated integer rather than bound,
  // because the driver does not accept a parameter in this position. Coerced
  // through `Math.trunc` and a floor of one so nothing but a number reaches
  // the statement.
  const limit =
    query.limit === undefined ? '' : ` LIMIT ${String(Math.max(1, Math.trunc(query.limit)))}`;

  const rows = db.prepare(`${SELECT}${where} ORDER BY at DESC, id DESC${limit}`).all(parameters);
  return (rows as ComparisonColumns[]).map(hydrate);
}

/** One comparison by identifier, or `null`. */
export function findComparison(db: Database, id: string): StoredComparison | null {
  const row = db.prepare(`${SELECT} WHERE id = @id`).get({ id });
  return row === undefined ? null : hydrate(row as ComparisonColumns);
}
