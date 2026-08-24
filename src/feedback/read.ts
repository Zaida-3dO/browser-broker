import type { Database } from 'better-sqlite3';

import {
  FEEDBACK_CATEGORY_NAMES,
  isFeedbackCategory,
  RATING_MAXIMUM,
  RATING_MINIMUM,
  type FeedbackCategory,
} from './record.ts';

/**
 * `broker feedback` with no arguments — **the one command whose reading half
 * has no tool behind it.**
 *
 * `SCHEMA.md` §5.3: "That is the one command whose reading half has no tool
 * behind it, because a caller writes feedback and a person reads it." The
 * asymmetry is the design rather than an oversight. An agent has no use for
 * other callers' feedback — it cannot act on it, and a tool returning it
 * would be a tenth-and-a-half description costing every session on every turn
 * to serve nobody. A person deciding what to fix has exactly that use.
 *
 * **`broker feedback --category no-path` is the query that says what callers
 * came for and did not find**, and it is the one that would otherwise have
 * been a search through transcripts by hand.
 *
 * ── It is part of the deletion, not part of the service ─────────────────
 *
 * This file goes when the tool goes. Nothing else reads the table, so
 * removing the mechanism is deleting this file, the writer beside it, the
 * tool, the command and the table — and nothing else moves (§3.16).
 */

/** One row, as a person reads it. */
export interface FeedbackRow {
  readonly id: number;
  readonly at: string;
  readonly sessionId: string | null;
  readonly claimId: string | null;
  /** The caller's last operation, from the ledger. */
  readonly lastEventId: number | null;
  /** The refusal it hit, if its last event was a denial. */
  readonly lastGuard: string | null;
  readonly rating: number;
  readonly category: FeedbackCategory;
  readonly note: string;
}

/** What to narrow the reading to. Absent means unnarrowed. */
export interface FeedbackFilters {
  readonly rating?: number;
  readonly category?: FeedbackCategory;
  /** How many rows at most. A person reading by hand wants a screenful. */
  readonly limit?: number;
}

export const DEFAULT_LIMIT = 50;

/** Why a reading was refused. */
export interface FilterRefusal {
  readonly code: string;
  readonly message: string;
}

/**
 * Check the filters a person typed.
 *
 * A filter naming a category that does not exist would silently return no
 * rows, and **no rows is the reading this whole mechanism's exit condition
 * turns on** — silence means "nothing to report". A typo that produced
 * silence would be read as the success condition, so it is refused with the
 * list instead.
 */
export function refuseFilters(filters: {
  readonly rating?: unknown;
  readonly category?: unknown;
  readonly limit?: unknown;
}): FilterRefusal | undefined {
  if (filters.rating !== undefined) {
    const { rating } = filters;
    if (
      typeof rating !== 'number' ||
      !Number.isInteger(rating) ||
      rating < RATING_MINIMUM ||
      rating > RATING_MAXIMUM
    ) {
      return {
        code: 'rating_out_of_range',
        message: `--rating takes a whole number from ${String(RATING_MINIMUM)} to ${String(RATING_MAXIMUM)}.`,
      };
    }
  }

  if (filters.category !== undefined) {
    const { category } = filters;
    if (typeof category !== 'string' || !isFeedbackCategory(category)) {
      return {
        code: 'unknown_category',
        message: `--category takes one of these five: ${FEEDBACK_CATEGORY_NAMES.join(', ')}. An unrecognised one is refused rather than matching nothing, because no rows is also what "nothing to report" looks like.`,
      };
    }
  }

  if (filters.limit !== undefined) {
    const { limit } = filters;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      return { code: 'bad_limit', message: '--limit takes a whole number of at least 1.' };
    }
  }

  return undefined;
}

/**
 * Read the rows back, **most recent first**.
 *
 * Ordered by the counter rather than by the timestamp: two rows written in
 * the same second are ordered by the counter and are not ordered by the
 * clock, so "most recent first" is a claim about order that only the counter
 * can actually make.
 */
export function readFeedback(db: Database, filters: FeedbackFilters = {}): readonly FeedbackRow[] {
  const where: string[] = [];
  const parameters: (string | number)[] = [];

  if (filters.rating !== undefined) {
    where.push('rating = ?');
    parameters.push(filters.rating);
  }
  if (filters.category !== undefined) {
    where.push('category = ?');
    parameters.push(filters.category);
  }

  const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
  parameters.push(filters.limit ?? DEFAULT_LIMIT);

  const rows = db
    .prepare(
      `SELECT id, at, session_id, claim_id, last_event_id, last_guard, rating, category, note
       FROM feedback${clause}
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(...parameters) as {
    id: number;
    at: string;
    session_id: string | null;
    claim_id: string | null;
    last_event_id: number | null;
    last_guard: string | null;
    rating: number;
    category: string;
    note: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    sessionId: row.session_id,
    claimId: row.claim_id,
    lastEventId: row.last_event_id,
    lastGuard: row.last_guard,
    rating: row.rating,
    category: row.category as FeedbackCategory,
    note: row.note,
  }));
}

/**
 * Render the rows for a terminal.
 *
 * **Silence is reported as silence, in words.** An empty reading is the exit
 * condition this mechanism is built around, so it says so rather than
 * printing nothing — a blank screen reads as a broken command, and the one
 * reading that must not be mistaken for a malfunction is the one that means
 * the tool has done its job.
 */
export function renderFeedback(rows: readonly FeedbackRow[], filtered: boolean): string {
  if (rows.length === 0) {
    return filtered
      ? 'No feedback matches those filters.'
      : [
          'No feedback has been recorded.',
          '',
          'This tool is v0 scaffolding and silence is its success condition: a long',
          'stretch with nothing logged is the signal to remove it. Removing it is a',
          'deletion — the tool, the command, this reader, the writer and the table.',
        ].join('\n');
  }

  return rows
    .map((row) => {
      const context = [
        row.sessionId === null ? undefined : `session ${row.sessionId}`,
        row.claimId === null ? undefined : `lease ${row.claimId}`,
        row.lastEventId === null ? undefined : `last operation #${String(row.lastEventId)}`,
        row.lastGuard === null ? undefined : `refused by ${row.lastGuard}`,
      ].filter((part): part is string => part !== undefined);

      return [
        `#${String(row.id)}  ${row.at}  ${String(row.rating)}/5  ${row.category}`,
        context.length === 0
          ? '  (no context was captured — no lease and no prior event)'
          : `  ${context.join(' · ')}`,
        `  ${row.note}`,
      ].join('\n');
    })
    .join('\n\n');
}
