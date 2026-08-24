import type { Database } from 'better-sqlite3';

/**
 * A view of the ledger (`MILESTONES.md` #47, `SCHEMA.md` §1.6).
 *
 * **One query.** §1.6: "The ledger is one stream with a cursor, so a page
 * over it is a page over one query" — and the table's shape is what keeps it
 * that way. A column per kind would be a wide, mostly-empty table; a table
 * per kind would turn every read into a fifteen-way union. So a slice is a
 * `WHERE` over one table, and this module's whole job is to build that
 * `WHERE` without ever building it out of caller-supplied SQL.
 *
 * ── The cursor is not invented here ─────────────────────────────────────
 *
 * §1.6: `events.id` is "**also** the 'everything since here' cursor for
 * anything reading a slice of the ledger". It counts upward, so a reader that
 * remembers the highest id it has seen can ask for everything after it, and
 * the answer is stable regardless of what has been written in between. There
 * is no separate cursor table, no opaque token to encode, and no offset —
 * an offset re-reads rows when the earlier ones have grown, which is the
 * failure a counter key exists to avoid.
 *
 * ── Read-only, and it does not sweep ────────────────────────────────────
 *
 * §5.2 records that "any command that goes through arbitration performs the
 * lazy sweep", which is correct and surprising the first time a listing
 * command closes somebody's tabs. **Reading the ledger is not an arbitration
 * path**: it decides nothing, grants nothing and refuses nothing, so it
 * neither needs the reconciled state nor is entitled to expire anybody's
 * lease. It is a plain read over history — and history is the one thing in
 * this store that is already settled.
 *
 * That is a narrower claim than it may look, and it is worth stating: the
 * *ledger* needs no derivation because every row in it records a decision
 * that was made at a moment that has passed. The **claims** do need one, and
 * that is `derive.ts`'s job. Do not read this file as a precedent for
 * reading `claims.state` directly.
 */

/** The event kinds, exactly as the schema's check constraint spells them (§1.6). */
export const EVENT_KINDS = [
  'claim_requested',
  'claim_granted',
  'claim_queued',
  'claim_promoted',
  'claim_renewed',
  'claim_released',
  'claim_expired',
  'claim_revoked',
  'tab_opening',
  'tab_open_failed',
  'tab_closing',
  'navigate',
  'act',
  'read',
  'evaluate',
  'capture',
  'compare',
  'browser_launched',
  'browser_adopted',
  'browser_exited',
  'launch_race_lost',
  'sweep',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** `allow` or `deny`, separate from the kind (§1.6). */
export const EVENT_OUTCOMES = ['allow', 'deny'] as const;
export type EventOutcome = (typeof EVENT_OUTCOMES)[number];

/** Which door a call came in through (§1.6). */
export type EventAdapter = 'tool-stdio' | 'tool-http' | 'cli' | 'internal';

/** One row of the ledger, as it is read back. */
export interface LedgerEntry {
  readonly id: number;
  readonly at: string;
  readonly kind: string;
  readonly outcome: string;
  /** Which rule refused. Null on an allow — the schema constrains the pair. */
  readonly guard: string | null;
  readonly claimId: string | null;
  readonly tabId: string | null;
  readonly sessionId: string | null;
  readonly adapter: string;
  readonly browserId: string | null;
  /** The per-kind remainder, as it was stored. Null when the kind carries none. */
  readonly detail: string | null;
}

/**
 * How to slice it.
 *
 * Every field is optional and an absent field filters nothing, so the empty
 * query is "the most recent entries" — which is what both callers want by
 * default: the document (§4.2) shows a recent slice, and a person running the
 * command usually wants the end of the stream.
 */
export interface LedgerQuery {
  /** Only these kinds. Empty or absent means every kind. */
  readonly kinds?: readonly string[];
  readonly outcome?: string;
  /**
   * Only refusals by this rule.
   *
   * Naming a guard implies `outcome = 'deny'` and does not need it said: the
   * schema's own check constrains `guard IS NOT NULL` to exactly the denials,
   * so the two conditions select the same rows. Stated here because a reader
   * comparing this to §1.6 will notice the redundancy and should know it was
   * seen rather than missed.
   */
  readonly guard?: string;
  readonly sessionId?: string;
  readonly claimId?: string;
  /** Everything with an id strictly greater than this. The cursor. */
  readonly since?: number;
  /** Everything with an id strictly less than this, for paging backwards. */
  readonly before?: number;
  /** How many rows at most. Defaulted and clamped by {@link readLedger}. */
  readonly limit?: number;
  /**
   * `newest` (the default) reads the end of the stream; `oldest` reads
   * forward from a cursor.
   *
   * Both are needed and neither is a preference. Following a cursor means
   * "everything since here, in the order it happened"; looking at what just
   * happened means "the last twenty, most recent first". Offering only one
   * would make the other a client-side reverse of a wrongly-truncated page.
   */
  readonly order?: 'newest' | 'oldest';
}

/** What came back, plus the cursor for asking again. */
export interface LedgerSlice {
  readonly entries: readonly LedgerEntry[];
  /**
   * The highest id in this slice, or null when it is empty.
   *
   * **The cursor to pass as `since` next time**, and it is the highest rather
   * than the last returned because `newest` order returns the highest first.
   * A caller that took the last entry's id would page backwards forever.
   */
  readonly cursor: number | null;
  /** How many rows matched the filter in total, ignoring the limit. */
  readonly total: number;
}

/** The default page. Small enough to read, large enough to be a page. */
export const DEFAULT_LEDGER_LIMIT = 20;

/**
 * The most rows one call will return.
 *
 * A bound rather than an unbounded read because the ledger is kept forever by
 * default (§6.2) and one of its two callers is assembling a self-contained
 * HTML file — a document that inlined a million rows would be unopenable, and
 * the failure would arrive long after the decision that caused it.
 */
export const MAXIMUM_LEDGER_LIMIT = 500;

interface Condition {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * Build the `WHERE` clause.
 *
 * **Every caller value is a bound parameter and none is interpolated.** The
 * only strings that reach the SQL text are column names written in this file.
 * That is not a general-purpose defence so much as a structural one: there is
 * no code path here that concatenates a caller's string into a statement, so
 * there is nothing to review for whether a particular value was escaped.
 */
function buildConditions(query: LedgerQuery): Condition {
  const clauses: string[] = [];
  const parameters: unknown[] = [];

  const kinds = query.kinds?.filter((kind) => kind !== '') ?? [];
  if (kinds.length > 0) {
    clauses.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
    parameters.push(...kinds);
  }
  if (query.outcome !== undefined) {
    clauses.push('outcome = ?');
    parameters.push(query.outcome);
  }
  if (query.guard !== undefined) {
    clauses.push('guard = ?');
    parameters.push(query.guard);
  }
  if (query.sessionId !== undefined) {
    clauses.push('session_id = ?');
    parameters.push(query.sessionId);
  }
  if (query.claimId !== undefined) {
    clauses.push('claim_id = ?');
    parameters.push(query.claimId);
  }
  if (query.since !== undefined) {
    clauses.push('id > ?');
    parameters.push(query.since);
  }
  if (query.before !== undefined) {
    clauses.push('id < ?');
    parameters.push(query.before);
  }

  return {
    sql: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`,
    parameters,
  };
}

interface LedgerRow {
  readonly id: number;
  readonly at: string;
  readonly kind: string;
  readonly outcome: string;
  readonly guard: string | null;
  readonly claim_id: string | null;
  readonly tab_id: string | null;
  readonly session_id: string | null;
  readonly adapter: string;
  readonly browser_id: string | null;
  readonly detail: string | null;
}

function toEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    outcome: row.outcome,
    guard: row.guard,
    claimId: row.claim_id,
    tabId: row.tab_id,
    sessionId: row.session_id,
    adapter: row.adapter,
    browserId: row.browser_id,
    detail: row.detail,
  };
}

/**
 * Clamp the page size.
 *
 * A limit below one is a caller asking for nothing, which is almost always a
 * mistake in arithmetic rather than an intention, so it becomes the default
 * rather than an empty page that looks like an empty ledger. Above the
 * maximum it is capped rather than refused: a slice is a convenience read and
 * failing a report over a page size would be a poor trade.
 */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LEDGER_LIMIT;
  }
  return Math.min(Math.floor(limit), MAXIMUM_LEDGER_LIMIT);
}

/**
 * Read a slice of the ledger.
 *
 * Two statements rather than one, and the second is the count. That is a
 * deliberate departure from "one query" in the narrow sense and not in the
 * sense §1.6 means it: the *slice* is one query over one table with no joins
 * and no union, which is the property the table's shape was designed to buy.
 * The count answers "how many matched" — which a page of twenty cannot say
 * about a filter over a ledger kept forever — and it runs over the same
 * predicate and the same indexes.
 */
export function readLedger(db: Database, query: LedgerQuery = {}): LedgerSlice {
  const conditions = buildConditions(query);
  const limit = clampLimit(query.limit);
  const direction = query.order === 'oldest' ? 'ASC' : 'DESC';

  const rows = db
    .prepare(
      `SELECT id, at, kind, outcome, guard, claim_id, tab_id, session_id, adapter, browser_id, detail
       FROM events${conditions.sql}
       ORDER BY id ${direction}
       LIMIT ?`,
    )
    .all(...conditions.parameters, limit) as LedgerRow[];

  const counted = db
    .prepare(`SELECT COUNT(*) AS total FROM events${conditions.sql}`)
    .get(...conditions.parameters) as { total: number } | undefined;

  const entries = rows.map(toEntry);
  const cursor = entries.reduce<number | null>(
    (highest, entry) => (highest === null || entry.id > highest ? entry.id : highest),
    null,
  );

  return { entries, cursor, total: counted?.total ?? 0 };
}

/** One row of the by-rule rollup. */
export interface GuardCount {
  readonly guard: string;
  readonly count: number;
}

/**
 * How often each rule has refused something.
 *
 * §1.6: "the question that *is* asked — 'has this rule ever fired' — is
 * answered by the refusals", and the partial index on `guard` exists for
 * exactly this read. Denials are rare, so the index is small and this is
 * cheap; that is why the ledger records allows and denials alike rather than
 * only the interesting half.
 */
export function countByGuard(db: Database, query: LedgerQuery = {}): readonly GuardCount[] {
  const conditions = buildConditions({ ...query, guard: undefined });
  const where =
    conditions.sql === '' ? ' WHERE guard IS NOT NULL' : `${conditions.sql} AND guard IS NOT NULL`;

  return db
    .prepare(
      `SELECT guard, COUNT(*) AS count FROM events${where} GROUP BY guard ORDER BY count DESC, guard ASC`,
    )
    .all(...conditions.parameters) as GuardCount[];
}
