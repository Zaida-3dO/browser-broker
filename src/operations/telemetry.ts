import type { Database } from 'better-sqlite3';

import { estimateTokens } from '../capture/tiers.ts';
import { clampLimit } from './ledger.ts';

/**
 * The capture telemetry rollups (`MILESTONES.md` #37, `SCHEMA.md` §1.7, §1.9).
 *
 * What pictures cost, and what diffs did — read back from the two tables that
 * record it. This is the **reader** half of the measurement work. The study
 * that compares one policy against another over real review work is a
 * different thing and is not here (#37a): a study needs traffic to exist
 * before it can be run, whereas these reads are what make the capture policy's
 * effect legible at all, and they stand on their own the moment a single
 * capture has been taken.
 *
 * ── The shape of these queries was decided by the indexes ────────────────
 *
 * This is worth stating plainly, because it is the constraint that chose every
 * grouping below. `step-001-initial.ts` creates three indexes whose comments
 * name this row's job before this row existed:
 *
 * | Index | Its own comment |
 * |---|---|
 * | `captures_taken_at (taken_at)` | "Listing, and the rollup." |
 * | `comparisons_source (source_capture_id, at DESC)` | "The diffs run from one capture" |
 * | `comparisons_target (target_capture_id)` | "and the diffs run against one — which is what tuning reads." |
 *
 * So a window over `taken_at` is an index range scan, and both directions of
 * the diff question are single-key lookups. **A rollup that forced a full scan
 * when an index for it existed would be the wrong shape**, and a rollup that
 * needed an index that does not exist would be a reason to re-read the schema
 * rather than to add one.
 *
 * The two groupings — `tier` and `kind` — are deliberately *not* indexed and
 * are deliberately still here. Both are enum columns of three values each
 * (§1.7), so grouping them is a pass over rows the window has already narrowed
 * to, not a scan of the table. An index on a three-value column would be a
 * write cost on every capture buying nothing a range scan does not already
 * have.
 *
 * ── Read-only, and it does not sweep ────────────────────────────────────
 *
 * The same standing that `ledger.ts` claims and for the same reason: these
 * decide nothing, grant nothing and refuse nothing, so they are not
 * arbitration paths and are not entitled to expire anybody's lease (§5.2).
 * Both tables record things that happened at a moment that has passed, so
 * unlike `claims` there is nothing here to derive — a capture's size does not
 * change because a lease lapsed.
 *
 * ── Estimated tokens are computed, never stored ─────────────────────────
 *
 * §1.7 deletes an `estimated_tokens` column on purpose and says why: it "is a
 * calculation over two columns on the same row", and freezing it into a column
 * would let it disagree with the dimensions beside it. The same section then
 * requires it "appears on every capture response and **every rollup**". So it
 * is computed here, by {@link estimateTokens}, from the dimensions the rows
 * carry — one formula in `tiers.ts`, used by the capture path and by this
 * reader, with no second copy to drift.
 */

/** The resolution rungs, exactly as the schema's check constraint spells them (§1.7). */
export const CAPTURE_TIERS = ['default', 'detail', 'max'] as const;
export type CaptureTier = (typeof CAPTURE_TIERS)[number];

/** The kinds of picture, exactly as the schema's check constraint spells them (§1.7). */
export const CAPTURE_KINDS = ['viewport', 'element', 'full_page'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/**
 * How to bound a rollup.
 *
 * Every field is optional and an absent field filters nothing, so the empty
 * query is "everything this store has recorded" — which is the honest default
 * for a rollup, in a way it is not for a listing. A slice of rows has to pick
 * *some* rows and the most recent are the useful ones; a total has no such
 * excuse, and one silently computed over the last twenty rows would be a
 * number that reads as an answer about the installation while being an answer
 * about a page.
 */
export interface CaptureWindow {
  /** Captures taken at or after this moment. Absent means from the beginning. */
  readonly since?: string;
  /**
   * Captures taken strictly **before** this moment. Absent means up to now.
   *
   * Half-open on purpose, and it is the boundary rule for every window in this
   * module: `since` includes its instant and `until` excludes it. Two adjacent
   * windows sharing a boundary therefore partition the rows rather than
   * double-counting the one that landed exactly on it — which is the arithmetic
   * a caller doing "this week against last week" is relying on without saying so.
   */
  readonly until?: string;
  /** Only captures taken under this lease. */
  readonly claimId?: string;
}

interface Condition {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * Build the `WHERE` clause for a capture window.
 *
 * **Every caller value is a bound parameter and none is interpolated**, on the
 * same structural argument `ledger.ts` makes: the only strings reaching the SQL
 * text are column names written in this file, so there is no path that
 * concatenates a caller's string into a statement and nothing to review for
 * whether a particular value was escaped.
 */
function buildCaptureConditions(window: CaptureWindow): Condition {
  const clauses: string[] = [];
  const parameters: unknown[] = [];

  if (window.since !== undefined) {
    clauses.push('taken_at >= ?');
    parameters.push(window.since);
  }
  if (window.until !== undefined) {
    clauses.push('taken_at < ?');
    parameters.push(window.until);
  }
  if (window.claimId !== undefined) {
    clauses.push('claim_id = ?');
    parameters.push(window.claimId);
  }

  return {
    sql: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`,
    parameters,
  };
}

/** What a group of captures cost, whether the group is a tier, a kind or the lot. */
export interface CaptureCost {
  /** How many pictures. */
  readonly captures: number;
  /** What they take up on disk, summed from the stored sizes. */
  readonly bytes: number;
  /**
   * What they would cost to look at, summed from {@link estimateTokens}.
   *
   * Computed per row and then added, rather than estimated from the totals:
   * the formula is per-picture and a sum of ceilings is not the ceiling of a
   * sum. Adding first would under-report by up to one token per capture, which
   * is small and would still be wrong in a number whose whole purpose is to be
   * compared against another one.
   */
  readonly estimatedTokens: number;
  /**
   * How many were shrunk on the way to disk.
   *
   * §1.7 stores the source dimensions beside the written ones precisely "so
   * 'was this downscaled' is answered without a flag that could disagree with
   * the numbers beside it" — so this counts rows where the two differ rather
   * than reading a column that says so.
   */
  readonly downscaled: number;
  /**
   * How many carried the accounting warning.
   *
   * §1.7: "The only way to find out whether the warning changes behaviour is
   * to know which captures carried one and look at what that caller did next."
   * This is the first half of that — the count that says whether it fires at all.
   */
  readonly warned: number;
}

/** One row of a rollup grouped by a column, with the group's name on it. */
export interface CaptureGroup extends CaptureCost {
  /** The tier or the kind this group is. */
  readonly group: string;
}

/** What the captures in a window cost, whole and broken down. */
export interface CaptureRollup {
  /** The window this was computed over, echoed back so a report can label itself. */
  readonly window: CaptureWindow;
  /** Every capture in the window, as one total. */
  readonly total: CaptureCost;
  /** The same window split by resolution rung (§1.7), rungs with no captures omitted. */
  readonly byTier: readonly CaptureGroup[];
  /** The same window split by kind of picture (§1.7), kinds with no captures omitted. */
  readonly byKind: readonly CaptureGroup[];
  /**
   * The written reasons callers gave for escalating to the top rung.
   *
   * §1.7 calls `reason` "**the entire mechanism** by which anyone learns why
   * callers escalate", and §3.11 is why it is free text rather than an enum —
   * an enum "could only report which of the author's guesses somebody picked".
   * So these are returned as written and are never counted into categories:
   * categorising them here would rebuild exactly the enum the schema refused.
   */
  readonly escalationReasons: readonly EscalationReason[];
}

/** One caller's written reason for going to the top rung, with when. */
export interface EscalationReason {
  readonly captureId: string;
  readonly takenAt: string;
  readonly reason: string;
}

/**
 * The columns a cost is summed from.
 *
 * The dimensions come back per row rather than pre-summed by SQLite because
 * the token estimate is a per-row ceiling — see {@link CaptureCost.estimatedTokens}.
 */
interface CaptureCostRow {
  readonly width: number;
  readonly height: number;
  readonly source_width: number;
  readonly source_height: number;
  readonly bytes: number;
  readonly warned: number;
  readonly grouped: string;
}

/** Fold rows into a cost, applying the per-row token formula as it goes. */
function toCost(rows: readonly CaptureCostRow[]): CaptureCost {
  let bytes = 0;
  let estimatedTokens = 0;
  let downscaled = 0;
  let warned = 0;

  for (const row of rows) {
    bytes += row.bytes;
    estimatedTokens += estimateTokens(row.width, row.height);
    if (row.width !== row.source_width || row.height !== row.source_height) {
      downscaled += 1;
    }
    if (row.warned === 1) {
      warned += 1;
    }
  }

  return { captures: rows.length, bytes, estimatedTokens, downscaled, warned };
}

/** Split rows by their grouping column, preserving the order SQLite returned. */
function toGroups(rows: readonly CaptureCostRow[]): readonly CaptureGroup[] {
  const buckets = new Map<string, CaptureCostRow[]>();
  for (const row of rows) {
    const bucket = buckets.get(row.grouped);
    if (bucket === undefined) {
      buckets.set(row.grouped, [row]);
    } else {
      bucket.push(row);
    }
  }

  return (
    [...buckets.entries()]
      .map(([group, groupRows]) => ({ group, ...toCost(groupRows) }))
      // Biggest first, because the question a breakdown answers is "what is this
      // costing me" and the answer is at the top. Ties break by name so the
      // ordering is total and two runs over the same data render identically.
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.group.localeCompare(b.group))
  );
}

/**
 * The most escalation reasons one rollup will return.
 *
 * Bounded for the reason `ledger.ts` bounds its slice: both tables grow without
 * limit and one consumer of this is assembling output a person reads. The
 * counts above are unbounded because a count of a million rows is still one
 * number; a *list* of a million reasons is not.
 */
export const MAXIMUM_ESCALATION_REASONS = 50;

/**
 * What the captures in a window cost.
 *
 * Three statements over one table, all sharing the window's predicate and the
 * `captures_taken_at` index the schema created for "the rollup". Three rather
 * than one because they answer three shapes of question — a total, two
 * breakdowns, and a list of written reasons — and a single query returning all
 * of them would either be a union of incompatible row shapes or a cross join
 * that multiplies the totals by the number of groups.
 *
 * **The totals are not derived from the breakdowns**, though they could be.
 * Summing `byTier` would give the same number for one query less. It is
 * computed separately because the two are then independent readings of the
 * same rows: if a tier ever appears that the breakdown does not know about,
 * the total still counts it and the two disagree visibly, rather than the row
 * disappearing from both.
 */
export function readCaptureRollup(db: Database, window: CaptureWindow = {}): CaptureRollup {
  const conditions = buildCaptureConditions(window);

  const totalRows = db
    .prepare(
      `SELECT width, height, source_width, source_height, bytes, warned, '' AS grouped
         FROM captures${conditions.sql}`,
    )
    .all(...conditions.parameters) as CaptureCostRow[];

  const tierRows = db
    .prepare(
      `SELECT width, height, source_width, source_height, bytes, warned, tier AS grouped
         FROM captures${conditions.sql}`,
    )
    .all(...conditions.parameters) as CaptureCostRow[];

  const kindRows = db
    .prepare(
      `SELECT width, height, source_width, source_height, bytes, warned, kind AS grouped
         FROM captures${conditions.sql}`,
    )
    .all(...conditions.parameters) as CaptureCostRow[];

  const reasonWhere =
    conditions.sql === ''
      ? ' WHERE reason IS NOT NULL'
      : `${conditions.sql} AND reason IS NOT NULL`;

  const reasonRows = db
    .prepare(
      `SELECT id, taken_at, reason FROM captures${reasonWhere}
       ORDER BY taken_at DESC, id DESC LIMIT ?`,
    )
    .all(...conditions.parameters, MAXIMUM_ESCALATION_REASONS) as {
    readonly id: string;
    readonly taken_at: string;
    readonly reason: string;
  }[];

  return {
    window,
    total: toCost(totalRows),
    byTier: toGroups(tierRows),
    byKind: toGroups(kindRows),
    escalationReasons: reasonRows.map((row) => ({
      captureId: row.id,
      takenAt: row.taken_at,
      reason: row.reason,
    })),
  };
}

/**
 * What the diffs run from or against one capture did.
 *
 * The two directions are separate fields rather than one total, because they
 * are different questions and the schema built a separate index for each:
 * `comparisons_source` answers "what did I compare this against", and
 * `comparisons_target` answers "what has been compared against this" — the
 * second being the one §1.9's own index comment calls "what tuning reads".
 */
export interface CaptureDiffActivity {
  readonly captureId: string;
  /** Diffs run **from** this capture — it was the newer picture. */
  readonly asSource: DiffOutcomes;
  /** Diffs run **against** this capture — it was the earlier picture. */
  readonly asTarget: DiffOutcomes;
}

/** What a set of comparisons found, and under what settings. */
export interface DiffOutcomes {
  /** How many diffs. */
  readonly comparisons: number;
  /**
   * How many found something, by the stored definition of "changed".
   *
   * §1.9 stores `changed` rather than deriving it from the region list because
   * "the definition is the thing every caller branches on and it has to have
   * one answer". So this counts that column and does not re-derive it.
   */
  readonly changed: number;
  /**
   * How many had their region list cut short.
   *
   * §1.9: "A truncated result that does not say so is a lie about
   * completeness." A rollup that omitted this would be the same lie one level up.
   */
  readonly truncated: number;
  /**
   * The distinct settings these diffs ran under, most recent first.
   *
   * **All three, together, on every entry.** §1.9 copies all three onto the row
   * rather than referencing them because "all three are mutable and all three
   * determined the output", so reporting them separately — a list of
   * tolerances beside a list of areas — would recombine into pairs that never
   * ran. A settings entry is therefore a triple or it is nothing.
   */
  readonly settings: readonly DiffSettingsUse[];
}

/** One combination of the three settings, and how much ran under it. */
export interface DiffSettingsUse {
  readonly colourTolerance: number;
  readonly minimumRegionArea: number;
  readonly maximumRegions: number;
  readonly comparisons: number;
  readonly changed: number;
}

interface DiffOutcomeRow {
  readonly colour_tolerance: number;
  readonly minimum_region_area: number;
  readonly maximum_regions: number;
  readonly changed: number;
  readonly truncated: number;
  readonly at: string;
}

/** Fold comparison rows into outcomes plus their distinct settings triples. */
function toOutcomes(rows: readonly DiffOutcomeRow[]): DiffOutcomes {
  let changed = 0;
  let truncated = 0;
  // Insertion-ordered, and the query returns most recent first, so the
  // settings come out in the order they were last used.
  const settings = new Map<string, { row: DiffOutcomeRow; comparisons: number; changed: number }>();

  for (const row of rows) {
    if (row.changed === 1) {
      changed += 1;
    }
    if (row.truncated === 1) {
      truncated += 1;
    }

    const key = `${String(row.colour_tolerance)}|${String(row.minimum_region_area)}|${String(row.maximum_regions)}`;
    const existing = settings.get(key);
    if (existing === undefined) {
      settings.set(key, { row, comparisons: 1, changed: row.changed === 1 ? 1 : 0 });
    } else {
      existing.comparisons += 1;
      existing.changed += row.changed === 1 ? 1 : 0;
    }
  }

  return {
    comparisons: rows.length,
    changed,
    truncated,
    settings: [...settings.values()].map((entry) => ({
      colourTolerance: entry.row.colour_tolerance,
      minimumRegionArea: entry.row.minimum_region_area,
      maximumRegions: entry.row.maximum_regions,
      comparisons: entry.comparisons,
      changed: entry.changed,
    })),
  };
}

const DIFF_COLUMNS =
  'colour_tolerance, minimum_region_area, maximum_regions, changed, truncated, at';

/**
 * What diffs did around one capture, in both directions.
 *
 * **Two single-key lookups, one per index.** `comparisons_source` is
 * `(source_capture_id, at DESC)`, so the source side gets its ordering from
 * the index rather than from a sort; `comparisons_target` is the target key
 * alone, so that side is a key lookup and an ordering the query asks for.
 * Reading both directions in one statement would mean an `OR` across two
 * different indexes, which is the shape that turns two lookups into a scan.
 *
 * `limit` bounds the rows each direction folds, defaulted and clamped by
 * `ledger.ts`'s {@link clampLimit} — reused rather than restated, so the page
 * sizes of the two readers in this directory cannot drift apart.
 */
export function readCaptureDiffActivity(
  db: Database,
  captureId: string,
  limit?: number,
): CaptureDiffActivity {
  const bound = clampLimit(limit);

  const sourceRows = db
    .prepare(
      `SELECT ${DIFF_COLUMNS} FROM comparisons WHERE source_capture_id = ?
       ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(captureId, bound) as DiffOutcomeRow[];

  const targetRows = db
    .prepare(
      `SELECT ${DIFF_COLUMNS} FROM comparisons WHERE target_capture_id = ?
       ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(captureId, bound) as DiffOutcomeRow[];

  return {
    captureId,
    asSource: toOutcomes(sourceRows),
    asTarget: toOutcomes(targetRows),
  };
}

/**
 * The captures most often diffed against, most first.
 *
 * This is the one question in this module that is a rollup *of* the target
 * index rather than a lookup *through* it: it groups `comparisons` by
 * `target_capture_id`, which `comparisons_target` covers. It answers "which
 * pictures are people actually treating as the thing to compare to" — which
 * §1.8 makes worth asking, because there are no baselines and so nothing
 * declares a picture to be one. If a handful of captures accumulate most of
 * the targeting, that is a baseline in behaviour rather than in the schema, and
 * it is only visible by counting.
 */
export interface DiffTarget {
  readonly captureId: string;
  readonly comparisons: number;
  readonly changed: number;
  /** Null when the comparison rows outlive the capture they name. */
  readonly url: string | null;
  readonly takenAt: string | null;
}

export function readMostDiffedTargets(db: Database, limit?: number): readonly DiffTarget[] {
  const bound = clampLimit(limit);

  const rows = db
    .prepare(
      `SELECT c.target_capture_id AS capture_id,
              COUNT(*) AS comparisons,
              SUM(c.changed) AS changed,
              p.url AS url,
              p.taken_at AS taken_at
         FROM comparisons c
         -- A left join, not an inner one: a comparison naming a capture whose
         -- row is gone is still a comparison that happened, and dropping it
         -- would quietly shrink a count whose whole purpose is to be compared
         -- against another count.
         LEFT JOIN captures p ON p.id = c.target_capture_id
        GROUP BY c.target_capture_id
        ORDER BY comparisons DESC, c.target_capture_id ASC
        LIMIT ?`,
    )
    .all(bound) as {
    readonly capture_id: string;
    readonly comparisons: number;
    readonly changed: number;
    readonly url: string | null;
    readonly taken_at: string | null;
  }[];

  return rows.map((row) => ({
    captureId: row.capture_id,
    comparisons: row.comparisons,
    changed: row.changed,
    url: row.url,
    takenAt: row.taken_at,
  }));
}
