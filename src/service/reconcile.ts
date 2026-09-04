import type { Database } from 'better-sqlite3';

/**
 * Reconciliation against a **live** browser (`MILESTONES.md` #21a,
 * `SCHEMA.md` §2.6 step 2).
 *
 * ── The three-part shape, and why it is three parts ─────────────────────
 *
 * `tabs.ts` states the constraint this file is built to, and it is a
 * constraint about shape rather than about behaviour: *"the deciding must be a
 * pure function over what the browser said and what the store holds, the
 * writing must take a database handle and no session, and the asking must sit
 * visibly between them. A single function holding a driver and a database
 * handle at once is the shape that ends up called from inside a transaction,
 * because it is the only thing that looks like it does the whole job."*
 *
 * So this module exports exactly two things, and neither of them can do the
 * whole job:
 *
 * | Part | What it holds | What it cannot do |
 * |---|---|---|
 * | {@link decideReconciliation} | Two plain lists | Reach a browser or a database — it takes neither |
 * | {@link applyReconciliation} | A `Database` | Reach a browser — there is no session in its signature |
 *
 * **The asking is not here.** Nothing in this file imports the browser seam,
 * calls `listTabs`, or holds anything that could. The caller does the asking,
 * and it does it between the two calls above, where a reader can see it. That
 * is `src/cli/reconcile-command.ts`, and the ordering is legible in about ten
 * lines there.
 *
 * ── Why that shape rather than one convenient function ──────────────────
 *
 * §2.4b is the rule whose violation would be worst: *"one unresponsive
 * browser inside the transaction blocks every arbitration call on the
 * machine"*. A single `reconcile(session, db)` would be the natural thing to
 * call, and the natural place to call it from is wherever the database handle
 * already is — which, in this service, is inside a transaction. The split is
 * what makes that mistake require writing the wrong thing on purpose:
 * `applyReconciliation` has nothing to hang a browser call on, and
 * `decideReconciliation` has nothing to write with.
 *
 * ── The driver's name for a tab does not leave this module ──────────────
 *
 * §1.4: `driver_tab_id` is *"never returned to a caller on any surface"*.
 * Reconciliation is unavoidably the place the two namespaces meet — it
 * compares what the browser calls its pages against what the store recorded —
 * so the meeting happens here, next to the other place it happens
 * (`tabs.ts`), and the boundary is drawn at this module's exports:
 *
 * - {@link ReconciliationPlan} carries driver names, because closing a page
 *   requires naming it to the driver. It is internal to the service.
 * - {@link ReconciliationReport} — the only thing the command prints, and the
 *   only thing any caller sees — carries **counts and opaque `tabs.id`
 *   values, and no driver name at all.**
 *
 * The two types are separate rather than one type with a rule about which
 * fields to print, because a rule about which fields to print is a rule
 * somebody eventually does not read.
 */

/**
 * What the browser said: one page it has open.
 *
 * **The keeper tab is not among these**, and that is a property of the seam
 * rather than something this module filters for. `BrowserSession.listTabs`
 * excludes it (§3.15 — it is *"never counted against the budget"* and never
 * addressable), so a reconciliation built on `listTabs` never sees it and
 * therefore cannot decide to close it. See {@link decideReconciliation} for
 * why that is load-bearing rather than incidental.
 */
export interface LivePage {
  /** The driver's name for it. Internal to the service (§1.4). */
  readonly driverTabId: string;
}

/**
 * What the store holds: one tab row in a live state, belonging to a live
 * lease.
 *
 * **Only live rows and only live leases**, because reconciliation asks a
 * question about the present. A `closed` row describes a page that is over,
 * and an expired lease's rows are the sweep's business (§2.4) — reading them
 * here would be the second spelling of reclamation that `tabs.ts` warns
 * against.
 */
export interface RecordedTab {
  /** The opaque identifier (§1.4). This is what a report may carry. */
  readonly tabId: string;
  /**
   * The driver's name for it, or `null` while the row is `opening`.
   *
   * `null` is not missing data. §1.4's `CHECK ((state = 'opening') =
   * (driver_tab_id IS NULL))` makes it exactly equivalent to *"the browser
   * has not been asked yet"*, and {@link decideReconciliation} depends on
   * that equivalence.
   */
  readonly driverTabId: string | null;
  readonly claimId: string;
}

/** A page the browser has open that no live lease owns (§2.6). */
export interface UnownedPage {
  readonly driverTabId: string;
}

/** A row a live lease believes it owns, whose page is not there (§2.6). */
export interface VanishedTab {
  readonly tabId: string;
  readonly claimId: string;
  readonly driverTabId: string;
}

/**
 * What reconciliation concluded, before anything has been done about it.
 *
 * **A value rather than an effect**, which is what makes the decision
 * testable without a browser and without a store: a test hands in two lists
 * and reads back a third.
 */
export interface ReconciliationPlan {
  /** Pages to close. Closing these is browser work, and happens last. */
  readonly unownedPages: readonly UnownedPage[];
  /** Rows to settle. Settling these is a write, and happens first. */
  readonly vanishedTabs: readonly VanishedTab[];
  /**
   * Rows deliberately left alone because the browser has not been asked about
   * them yet — every `opening` row handed in.
   *
   * **Reported rather than silently skipped.** A number that is never zero on
   * a busy installation is the difference between *"reconciliation considered
   * these and declined"* and *"reconciliation did not look"*, and only the
   * first of those is a design.
   */
  readonly skippedOpening: readonly string[];
}

/**
 * Decide what a live browser and the store disagree about.
 *
 * **Pure: no database, no driver, no clock.** Two lists in, one plan out.
 *
 * ── The two disagreements, and the direction of each ────────────────────
 *
 * §2.6 names them and this function is a transcription of that sentence:
 * *"A page open that no live lease owns is closed; a tab a live lease
 * believes it owns that is not there is marked closed and its lease ended."*
 *
 * - **A page the browser has that no row names** — something opened a tab and
 *   the row that would have owned it is gone, or was never written. Nobody is
 *   using it and nobody can: it is unaddressable, because addressing goes
 *   through `tabs.id` and there is no such row. It costs memory forever.
 * - **A row naming a page the browser does not have** — the page died with a
 *   crash, or a person closed it by hand. The lease still counts against the
 *   budget while the thing it is a lease *over* does not exist.
 *
 * ── `opening` rows: the race, and why the answer is not a timeout ───────
 *
 * This is the part that is easy to get wrong, and getting it wrong closes a
 * tab that was mid-open.
 *
 * `reserveTab` writes the row **before the browser is asked**, and says why:
 * the identifier has to exist before anything can fail, or a tab that opened
 * and then lost its answer is a page with no row naming it. The open itself
 * is browser work, so it happens after the commit (§2.4b). Between those two
 * moments the store holds an `opening` row and the browser is about to grow a
 * page that no row yet names.
 *
 * **Reconciliation running inside that window sees exactly the shape it is
 * built to destroy**: a page nothing owns. Closing it would close a tab whose
 * lease was granted seconds ago and whose caller is about to be handed it.
 *
 * What makes this safe is not a heuristic and not a grace period. It is
 * §1.4's check constraint:
 *
 * > `CHECK ((state = 'opening') = (driver_tab_id IS NULL))`
 *
 * An `opening` row has **no driver name, by database constraint**. So it
 * cannot participate in either comparison — there is nothing to compare it
 * against. It cannot be found vanished, because "vanished" means the browser
 * does not list a name the row holds and it holds none. And the page it is
 * about to acquire cannot be matched to it, because matching is by name.
 *
 * **Therefore the safe rule is: while any row is `opening`, no page can be
 * proven unowned.** A page that looks unowned may be that row's, a
 * millisecond before `recordTabOpened` names it. So this function refuses to
 * close anything at all when an `opening` row is present, rather than trying
 * to work out which page belongs to it — which is not knowable from here, and
 * would be a guess dressed as a decision.
 *
 * That is deliberately blunt, and the bluntness is the argument: **the cost
 * of declining is that a genuinely leaked page survives until the next run,
 * and the cost of guessing is a caller losing a tab it was just granted.**
 * Those are not comparable. Reconciliation is not the only thing that
 * reclaims a page — the sweep closes an expired lease's tabs on every
 * arbitration call (§2.4) — so a page this declines to close is a page that
 * waits, not a page that leaks forever.
 *
 * The vanished half is unaffected and still runs: it is a claim about rows
 * that name a page, and an `opening` row names none, so no `opening` row is
 * ever settled by it. A row is only settled when it holds a driver name the
 * browser did not list.
 *
 * ── What is not decided here ────────────────────────────────────────────
 *
 * **Expiry.** `arbitration.ts` owns time-based reclamation and nothing here
 * reads a clock. The question this asks is *"does this page exist"*, which is
 * a different question from *"has this lease lapsed"*, and answering the
 * second one here would be the second spelling of the sweep that `tabs.ts`
 * says to go and not write.
 *
 * **The keeper tab.** It is not in `pages` because `listTabs` excludes it
 * (§3.15). It is worth stating what would happen if a driver ever included
 * it, because the failure is silent and severe: the keeper is owned by no
 * lease, so it would be decided unowned, and closing it kills the shared
 * signed-in session — a headed browser dies within about half a second of its
 * final tab closing. The conformance obligation that keeps this true belongs
 * to the seam, and `tests/service/reconcile.test.ts` asserts the shape here
 * on the assumption the seam holds up its end.
 */
export function decideReconciliation(
  pages: readonly LivePage[],
  recorded: readonly RecordedTab[],
): ReconciliationPlan {
  const skippedOpening = recorded.filter((tab) => tab.driverTabId === null).map((tab) => tab.tabId);

  // Every driver name a live lease claims. Built from the rows that have one,
  // which by §1.4's check is exactly the rows that are not `opening`.
  const owned = new Set(
    recorded
      .map((tab) => tab.driverTabId)
      .filter((driverTabId): driverTabId is string => driverTabId !== null),
  );

  const listed = new Set(pages.map((page) => page.driverTabId));

  // A row holding a name the browser did not list. Safe regardless of the
  // `opening` window: a row in that window holds no name and so is never
  // here.
  const vanishedTabs: VanishedTab[] = recorded
    .filter((tab) => tab.driverTabId !== null && !listed.has(tab.driverTabId))
    .map((tab) => ({
      tabId: tab.tabId,
      claimId: tab.claimId,
      // Non-null by the filter above; narrowed for the type rather than
      // asserted, because an assertion here would be the one place a null
      // could reach a driver call.
      driverTabId: tab.driverTabId ?? '',
    }));

  // See the docblock: while a row is mid-open, "unowned" is not provable, so
  // nothing is closed. The vanished half above is untouched by this.
  const unownedPages: readonly UnownedPage[] =
    skippedOpening.length > 0
      ? []
      : pages
          .filter((page) => !owned.has(page.driverTabId))
          .map((page) => ({ driverTabId: page.driverTabId }));

  return { unownedPages, vanishedTabs, skippedOpening };
}

/**
 * What reconciliation did, in the only vocabulary a caller is allowed.
 *
 * **No driver name appears on this type**, and that is the §1.4 boundary made
 * structural rather than promised: a command printing one of these cannot
 * print a driver name, because it does not have one to print. `settled`
 * carries `tabs.id` values, which are the identifiers callers already hold.
 */
export interface ReconciliationReport {
  /** How many pages the browser said it had open, keeper excluded (§3.15). */
  readonly pagesSeen: number;
  /** Opaque identifiers of the rows settled, in a stable order. */
  readonly settled: readonly string[];
  /** How many pages were closed because no live lease owned them. */
  readonly closed: number;
  /** How many of those closes the driver refused. A leaked page (§2.4b). */
  readonly closeFailures: number;
  /** How many rows were left alone because their open is still in flight. */
  readonly skippedOpening: number;
  /**
   * How many rows stranded at `closing` by an ended lease were settled,
   * their page not being among what the browser listed.
   */
  readonly strandedSettled: number;
}

/**
 * The live tab rows to reconcile against, for one browser.
 *
 * **A `Database` and no session** — this is the read half of the writing
 * part, and it is here rather than in the command so that the command holds
 * no SQL. `claims.state = 'active'` is what makes it *live* leases: a lapsed
 * lease's rows belong to the sweep.
 */
export function readRecordedTabs(db: Database, browserId: string): readonly RecordedTab[] {
  return db
    .prepare<[string], RecordedTab>(
      `SELECT tabs.id AS tabId,
              tabs.driver_tab_id AS driverTabId,
              tabs.claim_id AS claimId
         FROM tabs
         JOIN claims ON claims.id = tabs.claim_id
        WHERE tabs.browser_id = ?
          AND tabs.state IN ('opening', 'open')
          AND claims.state = 'active'
        ORDER BY tabs.id`,
    )
    .all(browserId);
}

/**
 * Settle rows stranded at `closing` whose page the browser does not have.
 *
 * ── Why the vanished-tab path cannot reach these ────────────────────────
 *
 * {@link readRecordedTabs} requires `claims.state = 'active'`, and rightly:
 * a lapsed lease's rows are the sweep's business, not reconciliation's. But
 * that is exactly the population that strands. A lease ends, its tab is moved
 * to `closing`, and if the answer is never written back the row is left in a
 * state meaning "waiting for the tool" — attached to a lease that is no
 * longer active, and therefore invisible to every later reconciliation.
 *
 * A store was found holding 22 such rows, the oldest two days old, every one
 * with `close_attempts = 0`. The pages had been closed by hand; the rows
 * could not be reached by anything.
 *
 * ── Why this is safe to settle without asking again ─────────────────────
 *
 * The caller has just asked the browser what it has open, and passes the
 * driver names it answered with. A row whose name is not in that list
 * describes a page this browser does not have, so there is no round trip
 * outstanding and nothing to wait for — the same reasoning
 * {@link applyReconciliation} uses for a vanished page, and the sweep uses
 * for a tab that never opened.
 *
 * **A row whose name IS in the list is left alone.** Its page exists, the
 * close may genuinely still be in flight, and settling it would claim an
 * answer nobody has given.
 */
export function settleStrandedTabs(
  db: Database,
  browserId: string,
  openDriverTabIds: readonly string[],
  at: string,
): number {
  const stranded = db
    .prepare<[string], { tabId: string; driverTabId: string | null }>(
      `SELECT tabs.id AS tabId, tabs.driver_tab_id AS driverTabId
         FROM tabs
         JOIN claims ON claims.id = tabs.claim_id
        WHERE tabs.browser_id = ?
          AND tabs.state = 'closing'
          AND claims.state <> 'active'
        ORDER BY tabs.id`,
    )
    .all(browserId);

  const open = new Set(openDriverTabIds);
  const gone = stranded.filter((tab) => tab.driverTabId === null || !open.has(tab.driverTabId));
  if (gone.length === 0) {
    return 0;
  }

  const placeholders = gone.map(() => '?').join(', ');
  db.prepare(
    `UPDATE tabs
        SET state = 'closed', closed_at = ?, updated_at = ?
      WHERE id IN (${placeholders})
        AND state = 'closing'`,
  ).run(at, at, ...gone.map((tab) => tab.tabId));

  return gone.length;
}

/**
 * Settle the rows whose pages are gone, and end the leases that held them.
 *
 * **A database handle and no session** (the constraint `tabs.ts` sets), so
 * this cannot be the function that also asks the browser. It is called
 * *before* any page is closed, which is the safe order: a write that lands
 * and a close that fails leaves a settled row and a leaked page, which §2.4b
 * already describes and `broker doctor` already reports. The reverse order —
 * closing first — would leave a closed page and a row still claiming a live
 * lease over it, which is capacity pinned by nothing.
 *
 * ── Why this is not `updateSweptTabs` ───────────────────────────────────
 *
 * `arbitration.ts` exports that function so release and sweep cannot spell
 * one rule twice, and it is the right function for the question *"this lease
 * has ended, what becomes of its tabs"*. This is a different question, and
 * the difference is visible in the states each produces:
 *
 * | | Question | The tab goes to |
 * |---|---|---|
 * | `updateSweptTabs` | The lease ended; is there a page to close? | `closing` — the tool is about to be asked |
 * | this | The page is already gone | `closed` — there is nothing to ask |
 *
 * **`closing` appears in the predicate, and no row reaches it in that
 * state.** The rows here come from {@link readRecordedTabs} by way of
 * {@link decideReconciliation}, and that read requires `tabs.state IN
 * ('opening', 'open')` — so the third value in the predicate below matches
 * nothing this caller can supply. It is kept as a bound on what the write is
 * permitted to touch rather than as a population it serves: the statement
 * says which states this function may move a row out of, and a future caller
 * that widens its own read cannot silently reopen a `closed` row through it.
 *
 * **The stranded-`closing` population is {@link settleStrandedTabs}'s**, not
 * this function's, and the distinction is load-bearing. Those rows belong to
 * leases that have already ended, which is precisely why `readRecordedTabs`
 * (`claims.state = 'active'`) cannot see them and why they need their own
 * pass. A store was found holding 22 of them, each still occupying its slot
 * in the partial unique index on `(browser_id, driver_tab_id)`. Reading that
 * story as this function's would leave the impression the gap is covered
 * here, and it is not.
 *
 * A vanished page has no round trip outstanding, so `closing` would assert
 * one that is not, and the row would wait forever for an answer nobody is
 * coming to give — the exact reasoning the sweep uses for a tab that never
 * opened. `closed_at` is this moment because that is when the absence was
 * established; the page died earlier and nothing here knows when, which is
 * the honest version of §2.4a's distinction rather than a violation of it:
 * a fact nobody observed is not recoverable by stamping a guess.
 *
 * **And the lease is ended, not expired.** §2.6 says the row is marked closed
 * *"and its lease ended"*. `expired` would claim the lease lapsed on time,
 * which is a claim about a clock and is false — this lease was cut short by
 * its tab disappearing. `revoked` is the state for a lease ended by a
 * decision that was not the caller's and not the clock's, and an
 * administrator running reconciliation is exactly that.
 *
 * ── The sentence is not decoration, and the schema says so ──────────────
 *
 * `CHECK ((state = 'revoked') = (revoke_reason IS NOT NULL))` refuses a
 * revoked lease with no reason, and the column's own comment gives the
 * purpose: *"an operator taking capacity off a caller owes a sentence, and
 * the caller's next call is refused with it"*. That is the whole reason this
 * state is the right one — the caller does not get a bare failure on its next
 * call, it gets told its page was gone when somebody looked.
 *
 * **Found by the constraint rather than by review.** The first version of
 * this function wrote `state = 'revoked'` with no reason and would have
 * thrown on the first vanished tab it ever met. The check is doing exactly
 * the job §1.11 describes.
 */
export function applyReconciliation(
  db: Database,
  vanished: readonly VanishedTab[],
  at: string,
): void {
  if (vanished.length === 0) {
    return;
  }

  const tabIds = vanished.map((tab) => tab.tabId);
  const tabPlaceholders = tabIds.map(() => '?').join(', ');

  db.prepare(
    `UPDATE tabs
        SET state = 'closed', closed_at = ?, updated_at = ?
      WHERE id IN (${tabPlaceholders})
        AND state IN ('opening', 'open', 'closing')`,
  ).run(at, at, ...tabIds);

  // The lease goes with the tab, because a lease *is* a tab (§2.3): a lease
  // whose tab is gone owns nothing while still counting against the budget,
  // which §3.13 names as a state that should not exist.
  const claimIds = [...new Set(vanished.map((tab) => tab.claimId))];
  const claimPlaceholders = claimIds.map(() => '?').join(', ');

  db.prepare(
    `UPDATE claims
        SET state = 'revoked',
            revoke_reason = ?,
            ended_at = ?,
            updated_at = ?
      WHERE id IN (${claimPlaceholders})
        AND state = 'active'`,
  ).run(VANISHED_TAB_REASON, at, at, ...claimIds);
}

/**
 * The sentence a caller is refused with after its page went away.
 *
 * **Written for the caller rather than for a log.** §3.14: every refusal
 * *"names the way forward, because the alternative teaches a caller to
 * satisfy the check rather than to do the right thing"*. The way forward
 * after losing a page is a fresh lease, so that is what it says — and it says
 * what happened in terms the caller can act on, without naming the driver's
 * identifier for the page (§1.4) or implying the caller did anything wrong.
 */
export const VANISHED_TAB_REASON =
  'This lease’s tab was absent from the browser when reconciliation checked, so the lease was ended. Claim again to get a fresh tab.';
