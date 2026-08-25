import type { Database } from 'better-sqlite3';

import { deriveClaimState, isLive, secondsBetween, type DerivedClaimState } from './derive.ts';
import { countByGuard, readLedger, type GuardCount, type LedgerEntry } from './ledger.ts';

/**
 * The operations read: everything §4.2 says is in the document, derived.
 *
 * ── This is a narrow seam, declared as one ──────────────────────────────
 *
 * `SCHEMA.md` §4.5 says the document "is assembled from **one status read**
 * plus the live address read in §4.2a", and §2.4 says that read must have had
 * the expiry derivation applied. The status *operation* — the one that goes
 * through arbitration, sweeps, and answers from the reconciled state — is the
 * service layer's, and it is not built yet.
 *
 * **So this read applies the derivation itself, and does not sweep.** Said
 * plainly rather than implied, because the difference matters to whoever
 * joins the two:
 *
 * | | The arbitration status operation | This read |
 * |---|---|---|
 * | Expires lapsed leases in the store | yes | **no** |
 * | Reports lapsed leases as expired | yes | **yes** |
 * | Writes a ledger row | yes | **no** |
 *
 * The second row is the one the document depends on, and it is the one this
 * module guarantees. The first is a *stronger* thing the service does, and
 * its absence here is not a gap in the document: a reader that derives
 * correctly renders the same picture whether or not the rows have been swept,
 * which is the entire point of §2.4's standing rule.
 *
 * It is arguably better that generating a report does not expire anybody's
 * lease as a side effect — but that is a consequence rather than the reason.
 *
 * **Do not expect this module to collapse into the agent surface's status
 * operation.** That operation is `browser_status` (§3.3), and it is the wrong
 * shape in three separate ways at once: it takes a lease key and answers for
 * **one** caller, it is authenticated against that key, and **polling it
 * renews the lease** — it mutates. The snapshot needs an installation-wide
 * read of every lease, the queue, the leaked tabs and the ledger, from a
 * process holding nobody's key, and it must renew nothing. A substitution
 * would hand the document one caller's own lease and extend it for looking.
 *
 * So what this module is a stand-in for is **not** an operation that exists:
 * it is an installation-wide read that nothing has built. Until something
 * does, deriving here is the design rather than a shortcut, and the property
 * the document actually depends on — that a lapsed lease is reported as
 * expired — is guaranteed above regardless of what else lands.
 *
 * ── Nothing here is written, and nothing here does browser work ─────────
 *
 * Every statement is a `SELECT`. The live address read (§4.2a) is a separate
 * module for a separate reason: it touches browsers, so it must happen
 * outside any transaction, and keeping it out of this file is what makes that
 * visible rather than asserted.
 */

/** A browser as the document reports it (§4.2). */
export interface BrowserView {
  readonly id: string;
  readonly state: string;
  readonly restartCount: number;
  readonly pid: number | null;
  readonly launchedAt: string | null;
  /**
   * Whether a discovery record is present at all.
   *
   * **Present is not checked** (§1.2c). A record survives the browser dying —
   * verified: still there, still readable, still naming a port that answered
   * nothing. So this field says only that the columns are populated, and
   * §4.2's "checked properly, against both of §1.2c's conditions" is
   * `broker doctor`'s job, which can actually reach the endpoint. The
   * document reports what the store holds and says which fields are present;
   * it does not claim the record checks out.
   */
  readonly discoveryRecorded: boolean;
  /** Whether the record carries the browser's own identifier as well as an address. */
  readonly identityRecorded: boolean;
  /** Tabs this browser is holding for live leases, keeper tab excluded. */
  readonly liveTabs: number;
}

/** One live lease (§4.2). */
export interface LeaseView {
  readonly claimId: string;
  readonly sessionId: string;
  readonly browserId: string;
  readonly purpose: string;
  /** **Derived**, never the stored column. */
  readonly state: DerivedClaimState;
  readonly expiresAt: string;
  /** Negative once the expiry has passed, which is a fact worth showing. */
  readonly secondsUntilExpiry: number;
  readonly renewCount: number;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  /**
   * The tab this lease holds, if it has one.
   *
   * The opaque identifier, never the driver's name for the tab — that is the
   * tool's namespace and is never returned on any surface (§1.4).
   */
  readonly tabId: string | null;
}

/** Live leases for one session, grouped so one caller reads as one caller (§4.2). */
export interface SessionView {
  readonly sessionId: string;
  readonly leases: readonly LeaseView[];
}

/** A caller waiting (§1.5). */
export interface QueueEntryView {
  readonly claimId: string;
  readonly sessionId: string;
  readonly browserId: string;
  readonly purpose: string;
  /** One-based, ordered by `created_at` then `id`, exactly as §1.5 orders it. */
  readonly position: number;
  readonly waitedSeconds: number;
  readonly expiresAt: string;
  readonly secondsUntilExpiry: number;
}

/** The budget and its use (§4.2). */
export interface BudgetView {
  /**
   * The bound, or null when no process has recorded one yet.
   *
   * Null is a real state and not an error: the budget row is written by the
   * first process to open the store (§1.10), and a store that has been
   * created but never arbitrated against has no row. Reporting null says
   * that; reporting a default would report a number nobody chose.
   */
  readonly limit: number | null;
  /** Live leases, derived. A lease is a tab, so this is also the tab count (§2.3). */
  readonly used: number;
  readonly active: number;
  readonly queued: number;
  /**
   * Keeper tabs, counted separately so the numbers reconcile against a
   * browser window (§3.15).
   *
   * **This is not read from the store**, because a keeper tab is not a `tabs`
   * row: it is never leased, so it has no lease to belong to, and the whole
   * table hangs off `claim_id`. What the document reports is the expected
   * count — one per browser — and it is labelled as expected rather than
   * observed. Whether they are actually there is `broker doctor`'s question,
   * which can ask the browser.
   */
  readonly keeperTabsExpected: number;
}

/** A tab §2.4b left behind (§4.2). */
export interface LeakedTabView {
  readonly tabId: string;
  readonly browserId: string;
  readonly claimId: string;
  readonly state: string;
  readonly closeAttempts: number;
  readonly updatedAt: string;
}

/** What a caller reported (§3.16). */
export interface FeedbackView {
  readonly id: number;
  readonly at: string;
  readonly sessionId: string | null;
  readonly rating: number;
  readonly category: string;
  readonly note: string;
  readonly lastGuard: string | null;
}

/** The whole picture, at one instant. */
export interface OperationsStatus {
  /**
   * The instant everything here was derived against, read from the
   * database's own clock.
   *
   * **One instant for the whole read**, not one per section: two sections
   * derived against two clocks can disagree about whether a lease is live,
   * and a document that contradicts itself is worse than one that is slightly
   * old (§1.1 — "several processes are running by design and two of them
   * disagreeing by a second would make an expiry non-deterministic").
   */
  readonly at: string;
  readonly browsers: readonly BrowserView[];
  readonly budget: BudgetView;
  readonly sessions: readonly SessionView[];
  readonly queue: readonly QueueEntryView[];
  readonly leakedTabs: readonly LeakedTabView[];
  readonly recentEvents: readonly LedgerEntry[];
  readonly refusalsByGuard: readonly GuardCount[];
  readonly feedback: readonly FeedbackView[];
}

export interface StatusOptions {
  /**
   * How many ledger entries to include. §4.2: "the most recent entries".
   */
  readonly eventLimit?: number;
  /** How many feedback rows to include. */
  readonly feedbackLimit?: number;
  /**
   * The instant to derive against.
   *
   * Injected only by tests. In every real call it is the database's own
   * clock, for §1.1's reason: several processes read it and one of them
   * substituting its own would make an expiry depend on which machine asked.
   */
  readonly now?: string;
}

interface ClaimRow {
  readonly id: string;
  readonly session_id: string;
  readonly browser_id: string;
  readonly state: 'queued' | 'active' | 'released' | 'expired' | 'revoked';
  readonly purpose: string;
  readonly expires_at: string;
  readonly renew_count: number;
  readonly created_at: string;
  readonly activated_at: string | null;
  readonly tab_id: string | null;
}

interface BrowserRow {
  readonly id: string;
  readonly state: string;
  readonly restart_count: number;
  readonly pid: number | null;
  readonly launched_at: string | null;
  readonly endpoint: string | null;
  readonly browser_uuid: string | null;
}

interface LeakedRow {
  readonly id: string;
  readonly browser_id: string;
  readonly claim_id: string;
  readonly state: string;
  readonly close_attempts: number;
  readonly updated_at: string;
}

interface FeedbackRow {
  readonly id: number;
  readonly at: string;
  readonly session_id: string | null;
  readonly rating: number;
  readonly category: string;
  readonly note: string;
  readonly last_guard: string | null;
}

/**
 * Read the database's own clock in the same textual form every timestamp
 * column defaults to.
 *
 * The format string is repeated from the schema step rather than imported
 * from it, and that is a considered choice: the step is **history the moment
 * it has run anywhere** and must never be edited, so importing a constant out
 * of it would make a file that may not change a dependency of one that will.
 * A test asserts the two agree, which is the check that keeps a repetition
 * honest.
 */
export const STORE_CLOCK_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export function readStoreClock(db: Database): string {
  const row = db.prepare(`SELECT ${STORE_CLOCK_SQL} AS now`).get() as { now: string } | undefined;
  if (row === undefined) {
    throw new Error('The store returned no answer when asked for its own clock.');
  }
  return row.now;
}

/**
 * Read the recorded tab budget, or null when nothing has recorded one.
 *
 * The row §1.10 describes is written by the first process to open the store,
 * and the table it lives in belongs to the row that builds that check. Until
 * then this returns null — which the document renders as "not recorded",
 * a true statement about a store nothing has arbitrated against yet.
 *
 * **Tolerating the table's absence is deliberate and is the narrow seam.**
 * The alternative was to invent the table here, which would mean the row that
 * actually owns it inheriting a shape it did not choose, in a schema step
 * that can never be edited afterwards.
 */
export function readTabBudget(db: Database): number | null {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'`)
    .get() as { name: string } | undefined;
  if (table === undefined) {
    return null;
  }
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'tab_budget'`).get() as
    { value: unknown } | undefined;
  const value = Number(row?.value);
  return Number.isFinite(value) ? value : null;
}

/**
 * Take the picture.
 *
 * Every claim-derived number in it goes through `derive.ts`. There is no
 * branch in this file that reads `claims.state` and reports it, and that is
 * the property the mutation tests are aimed at.
 */
export function readOperationsStatus(db: Database, options: StatusOptions = {}): OperationsStatus {
  const at = options.now ?? readStoreClock(db);

  const browserRows = db
    .prepare(
      `SELECT id, state, restart_count, pid, launched_at, endpoint, browser_uuid
       FROM browsers ORDER BY id`,
    )
    .all() as BrowserRow[];

  // Every claim whose *stored* state is live. A claim whose stored state is
  // final cannot become live again, so this is the complete candidate set —
  // the derivation can only move a row out of the live set, never into it.
  const claimRows = db
    .prepare(
      `SELECT c.id, c.session_id, c.browser_id, c.state, c.purpose, c.expires_at,
              c.renew_count, c.created_at, c.activated_at,
              (SELECT t.id FROM tabs t
                WHERE t.claim_id = c.id AND t.state IN ('opening', 'open', 'closing')
                ORDER BY t.created_at LIMIT 1) AS tab_id
         FROM claims c
        WHERE c.state IN ('queued', 'active')
        ORDER BY c.created_at, c.id`,
    )
    .all() as ClaimRow[];

  const live = claimRows.filter((claim) => isLive(claim, at));

  const leases: LeaseView[] = live
    .filter((claim) => deriveClaimState(claim, at) === 'active')
    .map((claim) => ({
      claimId: claim.id,
      sessionId: claim.session_id,
      browserId: claim.browser_id,
      purpose: claim.purpose,
      state: deriveClaimState(claim, at),
      expiresAt: claim.expires_at,
      secondsUntilExpiry: secondsBetween(at, claim.expires_at),
      renewCount: claim.renew_count,
      createdAt: claim.created_at,
      activatedAt: claim.activated_at,
      tabId: claim.tab_id,
    }));

  const sessions = groupBySession(leases);

  // Ordered by created_at then id, which is §1.5's ordering exactly. The
  // SELECT above already applies it, so position is the index in that order
  // among the entries still queued once derived.
  const queue: QueueEntryView[] = live
    .filter((claim) => deriveClaimState(claim, at) === 'queued')
    .map((claim, index) => ({
      claimId: claim.id,
      sessionId: claim.session_id,
      browserId: claim.browser_id,
      purpose: claim.purpose,
      position: index + 1,
      waitedSeconds: secondsBetween(claim.created_at, at),
      expiresAt: claim.expires_at,
      secondsUntilExpiry: secondsBetween(at, claim.expires_at),
    }));

  const liveTabsByBrowser = new Map<string, number>();
  for (const lease of leases) {
    if (lease.tabId !== null) {
      liveTabsByBrowser.set(lease.browserId, (liveTabsByBrowser.get(lease.browserId) ?? 0) + 1);
    }
  }

  const browsers: BrowserView[] = browserRows.map((row) => ({
    id: row.id,
    state: row.state,
    restartCount: row.restart_count,
    pid: row.pid,
    launchedAt: row.launched_at,
    discoveryRecorded: row.endpoint !== null,
    identityRecorded: row.browser_uuid !== null,
    liveTabs: liveTabsByBrowser.get(row.id) ?? 0,
  }));

  const leakedRows = db
    .prepare(
      `SELECT id, browser_id, claim_id, state, close_attempts, updated_at
         FROM tabs WHERE close_failed = 1 ORDER BY updated_at DESC`,
    )
    .all() as LeakedRow[];

  const feedbackRows = db
    .prepare(
      `SELECT id, at, session_id, rating, category, note, last_guard
         FROM feedback ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(options.feedbackLimit ?? 10) as FeedbackRow[];

  return {
    at,
    browsers,
    budget: {
      limit: readTabBudget(db),
      used: live.length,
      active: leases.length,
      queued: queue.length,
      keeperTabsExpected: browserRows.length,
    },
    sessions,
    queue,
    leakedTabs: leakedRows.map((row) => ({
      tabId: row.id,
      browserId: row.browser_id,
      claimId: row.claim_id,
      state: row.state,
      closeAttempts: row.close_attempts,
      updatedAt: row.updated_at,
    })),
    recentEvents: readLedger(db, { limit: options.eventLimit ?? 20 }).entries,
    refusalsByGuard: countByGuard(db),
    feedback: feedbackRows.map((row) => ({
      id: row.id,
      at: row.at,
      sessionId: row.session_id,
      rating: row.rating,
      category: row.category,
      note: row.note,
      lastGuard: row.last_guard,
    })),
  };
}

/**
 * Group live leases by session, "so one caller holding several reads as one
 * caller" (§4.2).
 *
 * Insertion order is preserved, which means sessions appear in the order
 * their earliest lease was created — the same ordering the query applied.
 * Sorting by session identity instead would order the document by a value
 * another system minted, which carries no meaning to a reader.
 */
function groupBySession(leases: readonly LeaseView[]): readonly SessionView[] {
  const grouped = new Map<string, LeaseView[]>();
  for (const lease of leases) {
    const existing = grouped.get(lease.sessionId);
    if (existing === undefined) {
      grouped.set(lease.sessionId, [lease]);
    } else {
      existing.push(lease);
    }
  }
  return [...grouped].map(([sessionId, sessionLeases]) => ({ sessionId, leases: sessionLeases }));
}
