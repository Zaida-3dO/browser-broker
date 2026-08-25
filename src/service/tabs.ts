import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type { BrowserId, BrowserSession, TabHandle } from '../browser/driver.ts';

/**
 * Tab lifecycle: the identifier mapping, opening, closing, and reconciling
 * the store against what a browser actually has open (row #21).
 *
 * ── The one rule this file exists to keep ───────────────────────────────
 *
 * **The driver's name for a tab is never returned to a caller on any
 * surface.** `SCHEMA.md` §1.4 puts the consequence plainly: exposing it
 * "hands callers a second, non-opaque way to name a tab, which is the
 * addressing bug arriving through a different door". Callers hold
 * `tabs.id` — a value carrying no information about any other tab, so there
 * is no index arithmetic to get wrong and the whole class of
 * landed-on-the-wrong-tab bugs is deleted rather than guarded.
 *
 * So this module is the **only** place the two namespaces meet, and the
 * direction of every function here is one-way by construction:
 * {@link findOpenOwnedTab} takes an opaque identifier and a lease and returns
 * a {@link TabHandle}, which `driver.ts` keeps deliberately un-exported from
 * anything above the service layer. **Nothing here returns a driver name**,
 * and {@link TabRecord} — the shape a surface is given — has no field for
 * one. That is the structural half.
 *
 * The conventional half, said rather than implied: nothing stops a future
 * module selecting `driver_tab_id` out of the store itself and putting it in
 * a response. The column is right there and SQL is not type-checked. What
 * makes that visible is that it would have to be written — a fresh query,
 * naming the column, in a file that is not this one — rather than falling out
 * of reusing a shape that already carries it.
 *
 * ── Reconciliation is against the browser, not against a restart ────────
 *
 * `MILESTONES.md`'s note for #21 is the specification, and its first sentence
 * is the one that shapes the code: **there is no "after a restart" step,
 * because a process ending is the ordinary case here and every spawn is a
 * first spawn.** The hard question is the other one — the store says a tab is
 * open and the browser it was in is gone. A browser outlives any one caller
 * and does not outlive everything, and when it dies every tab inside it dies
 * while every row describing them survives.
 *
 * Hence {@link reconcileBrowser}, whose two halves are asymmetric on purpose:
 *
 * 1. **A browser that fails either discovery check is gone** — the endpoint
 *    does not answer, or it answers and is a different browser (#53). Every
 *    tab row pointing at it is closed, because a tab inside a process that
 *    has exited is closed by definition.
 * 2. **A browser that is alive is asked what is actually open.** A page no
 *    live lease owns is closed; a tab a live lease believes it owns that is
 *    not there is marked closed.
 *
 * **All of that is browser work, so none of it happens inside the arbitration
 * transaction** (§2.4b, `arbitration.no_browser_io`). This module takes the
 * shape that makes the rule easy rather than one that relies on remembering
 * it: {@link planReconciliation} is a pure function over what the browser
 * said and what the store holds, and {@link applyReconciliation} is the part
 * that writes. **Asking the browser happens between the two, outside both.**
 * A single function doing all three would have had to hold a driver and a
 * database handle at once, which is exactly the shape that ends up called
 * from inside a transaction because it is the only thing that looks like it
 * does the job.
 */

/** How long a database timestamp is spelled everywhere in this store. */
function now(): string {
  return new Date().toISOString();
}

/**
 * What a caller is given about its own tab.
 *
 * **There is no driver name here and there is no address here.** The first is
 * §1.4's namespace rule; the second is §1.4's largest deliberate deletion —
 * nothing stores where a tab is, so a table of addresses kept over months is
 * not a thing this design has to have a retention policy for.
 */
export interface TabRecord {
  /** The opaque identifier, and the only name a caller ever holds. */
  readonly tabId: string;
  readonly claimId: string;
  readonly browserId: BrowserId;
  readonly state: TabState;
}

/** §1.4's five states. */
export type TabState = 'opening' | 'open' | 'closing' | 'closed' | 'failed';

/** The states in which a tab is not finished with. */
const LIVE_TAB_STATES: readonly TabState[] = ['opening', 'open', 'closing'];

/**
 * Reserve the row for a tab that is about to be opened, and return its opaque
 * identifier.
 *
 * **The row is written before the browser is asked**, in state `opening` with
 * no driver name — which is what §1.4's `CHECK ((state = 'opening') =
 * (driver_tab_id IS NULL))` is describing. The order is not an
 * implementation detail:
 *
 * - The identifier a caller will be given has to exist before anything can
 *   fail, or a tab that opened and then lost its answer is a page in a
 *   browser with no row naming it — a leak nothing can find, because the
 *   administrative operation that clears leaked tabs (§4.3) selects on rows.
 * - It is the half of the work that belongs in the arbitration transaction.
 *   Opening the tab is browser work and belongs after the commit (§2.4b), so
 *   the split has to fall exactly here.
 *
 * The consequence is a row that can sit in `opening` forever if the open
 * never completes, and that is the honest outcome rather than a gap: a lease
 * whose tab never opened is visible as a lease whose tab never opened.
 */
export function reserveTab(db: Database, claimId: string, browserId: BrowserId): string {
  const tabId = randomUUID();
  db.prepare(
    `INSERT INTO tabs (id, claim_id, browser_id, driver_tab_id, state)
     VALUES (?, ?, ?, NULL, 'opening')`,
  ).run(tabId, claimId, browserId);
  return tabId;
}

/**
 * Record that a reserved tab actually opened, under the driver's name for it.
 *
 * **This is the moment the mapping comes into being**, and it is the only
 * write that sets `driver_tab_id`. `opened_at` is stamped with when the tab
 * opened rather than when anybody noticed, for the same reason §2.4a gives
 * about expiry: the two are different facts and only one of them is about the
 * tab.
 */
export function recordTabOpened(db: Database, tabId: string, driverTabId: string): void {
  const changed = db
    .prepare(
      `UPDATE tabs
          SET driver_tab_id = ?, state = 'open', opened_at = ?, updated_at = ?
        WHERE id = ? AND state = 'opening'`,
    )
    .run(driverTabId, now(), now(), tabId).changes;

  if (changed !== 1) {
    // Not a refusal a caller ever sees: reaching here means this module was
    // asked to open a tab twice, or to open one that was already finished
    // with. Throwing is right because the alternative is a second driver name
    // silently overwriting the first, leaving a real page with no row —
    // exactly the leak `reserveTab` is ordered the way it is to prevent.
    throw new Error(
      `Tab ${tabId} was not awaiting an open, so the driver name could not be recorded against it.`,
    );
  }
}

/**
 * Look up a tab by its opaque identifier **and the lease that must own it**,
 * returning the handle the driver needs.
 *
 * ── Why ownership is in the query rather than checked after it ──────────
 *
 * §7.1 makes `tab.owned` and `tab.open` refuse **identically** — "tab not
 * found, the same refusal as an unknown tab, so probing cannot discover
 * another lease's tabs". A lookup that fetched by identifier and then
 * compared the owner would have the other lease's row in hand at the moment
 * it decided to say no, and every later maintainer would be one convenience
 * away from putting something from it in the refusal detail. Selecting on
 * both columns means the unowned case and the unknown case produce the same
 * empty result, so the two are indistinguishable **to this code**, not merely
 * in what it chooses to print.
 *
 * Returns `undefined` for all three of unknown, unowned and not-open. The
 * caller raises the single refusal; this function deliberately does not
 * report which of the three it was, because a return value distinguishing
 * them is the enumeration hazard rebuilt one layer up.
 *
 * ── Why the name says `findOpen` rather than `resolve` ──────────────────
 *
 * `ownership.ts` has a sibling, `resolveOwnedTabOrRefuse`, and both were once
 * called `resolveOwnedTab` despite differing in signature and in behaviour.
 * This one **requires `state = 'open'`** and answers with `undefined`; that one
 * resolves a tab in any state and **throws**. Under lazy opening the difference
 * decides whether anything works at all: a caller that reached for this one to
 * authorise an operation would get `undefined` on every first call, because the
 * tab has not been opened yet.
 */
export function findOpenOwnedTab(
  db: Database,
  tabId: string,
  claimId: string,
): TabHandle | undefined {
  const row = db
    .prepare(
      `SELECT browser_id AS browserId, driver_tab_id AS driverTabId
         FROM tabs
        WHERE id = ? AND claim_id = ? AND state = 'open'`,
    )
    .get(tabId, claimId) as { browserId: BrowserId; driverTabId: string } | undefined;

  if (!row) return undefined;
  return { browser: row.browserId, driverTabId: row.driverTabId };
}

/**
 * Mark a tab as being closed — asked for, not yet confirmed.
 *
 * `closing` "is not ceremony: it is the honest representation of *the tool was
 * asked and has not answered*, and it is what stops a page that may still
 * exist being counted as free" (§1.4). This is the write that happens
 * **inside** the transaction; the close itself is after-commit work.
 */
export function markTabClosing(db: Database, tabId: string): void {
  db.prepare(
    `UPDATE tabs
        SET state = 'closing', close_attempts = close_attempts + 1, updated_at = ?
      WHERE id = ? AND state IN ('opening', 'open', 'closing')`,
  ).run(now(), tabId);
}

/** Record that a close was confirmed. */
export function recordTabClosed(db: Database, tabId: string): void {
  db.prepare(
    `UPDATE tabs
        SET state = 'closed', closed_at = ?, updated_at = ?
      WHERE id = ? AND state <> 'closed'`,
  ).run(now(), now(), tabId);
}

/**
 * Record that the service gave up closing a tab.
 *
 * **This is a leaked tab, not a leaked lease** (§2.4b). The capacity came
 * back at commit, the lease is over, and the count is right; what remains is
 * a page nobody owns. It costs memory and it is worth fixing, and it does not
 * cost budget and does not block anybody.
 *
 * The state goes to `failed` **and** `close_failed` is set, which reads as
 * redundant and is not: the state says the tab is finished with, and the flag
 * is what the administrative clear-a-leaked-tab operation (§4.3) selects on —
 * that operation has to find its subjects, and a leaked tab is by definition
 * one no live lease points at, so nothing else identifies it.
 */
export function recordCloseFailed(db: Database, tabId: string): void {
  db.prepare(
    `UPDATE tabs
        SET state = 'failed', close_failed = 1, updated_at = ?
      WHERE id = ?`,
  ).run(now(), tabId);
}

/** One tab the store believes is live in a given browser. */
export interface LiveTabRow {
  readonly tabId: string;
  readonly claimId: string;
  readonly browserId: BrowserId;
  /** Null while the tab is still `opening` and has no driver name yet. */
  readonly driverTabId: string | null;
  /** Whether the lease that owns it is still live. */
  readonly claimLive: boolean;
}

/**
 * Every tab row in a browser that is not yet finished with, and whether its
 * lease is.
 *
 * A single query rather than two, because "a page no live lease owns" is the
 * question reconciliation is built on and answering it by fetching tabs and
 * then fetching claims would make the two answers describe different
 * instants. Inside one transaction they cannot.
 */
export function liveTabsIn(db: Database, browserId: BrowserId): readonly LiveTabRow[] {
  const rows = db
    .prepare(
      `SELECT t.id           AS tabId,
              t.claim_id     AS claimId,
              t.browser_id   AS browserId,
              t.driver_tab_id AS driverTabId,
              CASE WHEN c.state IN ('queued', 'active') THEN 1 ELSE 0 END AS claimLive
         FROM tabs t
         JOIN claims c ON c.id = t.claim_id
        WHERE t.browser_id = ?
          AND t.state IN (${LIVE_TAB_STATES.map(() => '?').join(', ')})`,
    )
    .all(browserId, ...LIVE_TAB_STATES) as {
    tabId: string;
    claimId: string;
    browserId: BrowserId;
    driverTabId: string | null;
    claimLive: number;
  }[];

  return rows.map((row) => ({
    tabId: row.tabId,
    claimId: row.claimId,
    browserId: row.browserId,
    driverTabId: row.driverTabId,
    claimLive: row.claimLive === 1,
  }));
}

/**
 * What reconciliation decided, before anything acts on it.
 *
 * A plan rather than an effect, so the deciding is testable without a browser
 * and without a store, and so the browser work and the database work are
 * forced apart (§2.4b).
 */
export interface ReconciliationPlan {
  /**
   * Tab rows to mark closed. Either their browser is gone, or the browser is
   * alive and does not have them.
   */
  readonly tabsToClose: readonly string[];
  /** Leases to end, because the tab each of them was is gone. */
  readonly claimsToEnd: readonly string[];
  /**
   * Pages open in the browser that no live lease owns, to be closed in the
   * browser. **Driver handles**, which is why this field never leaves the
   * service layer.
   */
  readonly pagesToClose: readonly TabHandle[];
}

/**
 * Decide what reconciliation should do, from what the browser said and what
 * the store holds.
 *
 * ── The two halves, and why they are not symmetrical ────────────────────
 *
 * **When the browser is gone**, nothing is asked and nothing is inspected:
 * every live tab row pointing at it closes and every lease behind one ends.
 * There is no per-page decision to make, because there are no pages — a tab
 * inside a process that has exited is closed by definition. **A browser dying
 * ends every lease in it at once**, and that is reported as what it is rather
 * than hidden as a degraded mode: with two browsers and no third there is no
 * capacity to fail over to.
 *
 * **When the browser is alive**, both directions are checked and they mean
 * different things:
 *
 * - A page the browser has that **no live lease owns** is closed *in the
 *   browser*. Its row, if it has one, is already finished with.
 * - A row a **live lease believes it owns** that the browser does not have is
 *   marked closed and its lease ended. The page is gone; the row is stale.
 *
 * ── The keeper tab, and why it is excluded by being named ───────────────
 *
 * {@link ReconciliationInput.keeperTabId} is the driver name of the browser's
 * keeper tab (#56), and it is excluded from `pagesToClose` explicitly.
 * Without that, reconciliation is **the thing that kills the signed-in
 * browser**: the keeper tab is by design owned by no lease, which is exactly
 * the test for a page to close, and closing the last tab in a headed browser
 * kills it within about half a second (§3.15) — taking the shared
 * authenticated session with it. The mechanism that exists to prevent that
 * failure would have been its cause.
 *
 * **It is passed in rather than recognised**, because there is nothing about
 * a keeper tab to recognise: it is a blank page, and so is any other blank
 * page. The browser session is what knows which one it established.
 */
export interface ReconciliationInput {
  readonly browserId: BrowserId;
  /**
   * Whether the browser passed both discovery checks (#53). **False means
   * gone**, and it covers both failures — the endpoint did not answer, or it
   * answered and was a different browser. They are one outcome here because
   * the response to them is identical; #53 owns telling them apart.
   */
  readonly browserAlive: boolean;
  /**
   * What the browser says is open, or an empty list when it is gone and was
   * never asked. **Not `undefined` for the gone case**, deliberately: a
   * caller that has to supply something for a browser it did not ask is a
   * caller that might supply a stale list it happened to have, and an empty
   * list read as "the browser has nothing" produces the same answer as "the
   * browser is gone" only because the gone branch never looks at it.
   */
  readonly openInBrowser: readonly TabHandle[];
  readonly storedTabs: readonly LiveTabRow[];
  /** The keeper tab's driver name, when this browser has one established. */
  readonly keeperTabId?: string;
}

export function planReconciliation(input: ReconciliationInput): ReconciliationPlan {
  if (!input.browserAlive) {
    // A browser that fails either discovery check is gone, and every tab row
    // pointing at it is closed. Nothing is asked of it and `openInBrowser` is
    // deliberately not consulted — a browser that is gone cannot have told us
    // anything, so anything in that list would be from before.
    return {
      tabsToClose: input.storedTabs.map((tab) => tab.tabId),
      claimsToEnd: [...new Set(input.storedTabs.filter((t) => t.claimLive).map((t) => t.claimId))],
      pagesToClose: [],
    };
  }

  const present = new Set(input.openInBrowser.map((tab) => tab.driverTabId));
  const ownedByLiveLease = new Set(
    input.storedTabs
      .filter((tab) => tab.claimLive && tab.driverTabId !== null)
      .map((tab) => tab.driverTabId as string),
  );

  // A row a live lease believes it owns that the browser does not have. A tab
  // still `opening` has no driver name yet and is not stale — the open is in
  // flight, and treating "not there yet" as "gone" would close a tab that was
  // about to exist.
  const missing = input.storedTabs.filter(
    (tab) => tab.driverTabId !== null && !present.has(tab.driverTabId),
  );

  // A page the browser has that no live lease owns. The keeper tab is
  // excluded by name — see this type's own note on why that is load-bearing
  // rather than tidy.
  const pagesToClose = input.openInBrowser.filter(
    (page) => !ownedByLiveLease.has(page.driverTabId) && page.driverTabId !== input.keeperTabId,
  );

  return {
    tabsToClose: missing.map((tab) => tab.tabId),
    claimsToEnd: [...new Set(missing.filter((tab) => tab.claimLive).map((tab) => tab.claimId))],
    pagesToClose,
  };
}

/**
 * Write a plan's store half.
 *
 * **Only the store half.** `pagesToClose` is not touched here and cannot be —
 * closing a page is a round trip to a browser, and a browser can hang. Inside
 * the transaction one unresponsive browser blocks every arbitration call on
 * the machine, "not the caller that hit it — every caller, including ones
 * that only wanted to know where they stand" (§2.4b). So this function takes
 * a database handle and no session, which means the violation is not
 * available to write here rather than merely discouraged.
 */
export function applyReconciliation(db: Database, plan: ReconciliationPlan): void {
  const at = now();

  for (const tabId of plan.tabsToClose) {
    db.prepare(
      `UPDATE tabs
          SET state = 'closed', closed_at = ?, updated_at = ?
        WHERE id = ? AND state <> 'closed'`,
    ).run(at, at, tabId);
  }

  for (const claimId of plan.claimsToEnd) {
    db.prepare(
      `UPDATE claims
          SET state = 'expired', expired_at = COALESCE(expired_at, ?), ended_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('queued', 'active')`,
    ).run(at, at, at, claimId);
  }
}

/**
 * Ask a browser what it has open, outside every transaction.
 *
 * A named function rather than a line inlined at the call site, so that
 * "collect from the browser, then open the transaction" is a shape somebody
 * reading a call site can see, and so the reconciliation flow has a place to
 * put the ask that is visibly not between a `BEGIN` and a `COMMIT`.
 */
export async function askBrowserWhatIsOpen(session: BrowserSession): Promise<readonly TabHandle[]> {
  return await session.listTabs();
}

/**
 * Close the pages a plan orphaned, best effort, after the commit.
 *
 * **Every failure is swallowed and that is by design** (§2.4b): closing runs
 * after the arbitration transaction has committed, so a tab that will not
 * close is a leaked tab and not a leaked lease — the capacity is already
 * back. A rejection here is information rather than a failure to propagate.
 *
 * Returns the handles it could not close so a caller can record them, because
 * swallowing an error is not the same as having nothing to say about it.
 */
export async function closeOrphanedPages(
  session: BrowserSession,
  pages: readonly TabHandle[],
): Promise<readonly TabHandle[]> {
  const failed: TabHandle[] = [];
  for (const page of pages) {
    try {
      await session.closeTab(page);
    } catch {
      failed.push(page);
    }
  }
  return failed;
}
