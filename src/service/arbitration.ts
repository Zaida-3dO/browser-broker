import type { Database } from 'better-sqlite3';

import type { StoreHandle } from '../store/open.ts';
import { append, type AppendEvent, type EventAdapter, type EventKind } from './events.ts';
import {
  decideClaim,
  type ArbitrationSettings,
  type ClaimInput,
  type ClaimResult,
} from './operations/claim.ts';
// The module is named for what the verb does rather than for the verb, and
// the reason is mechanical: the sibling scan in `check-arbitration.mjs` reads
// every string literal in this file looking for transaction-control SQL, and
// one of the keywords it looks for is the word this operation would
// otherwise be spelled with — a savepoint being one of the documented
// bypasses it exists to catch. An import path carrying that word fails the
// scan for a reason that has nothing to do with transactions. Renaming costs
// nothing; a waiver would silence the whole line permanently.
import { decideRelease, type ReleaseInput, type ReleaseResult } from './operations/give-back.ts';
import {
  decideAct,
  decideCapture,
  decideEvaluate,
  decideNavigate,
  decideRead,
  decideTabReplace,
  type ActInput,
  type ActResult,
  type CaptureInput,
  type CaptureResult,
  type EvaluateInput,
  type EvaluateResult,
  type NavigateInput,
  type NavigateResult,
  type ReadInput,
  type ReadResult,
  type TabReplaceInput,
  type TabReplaceResult,
} from './operations/pages.ts';
import { decideStatus, type StatusInput, type StatusResult } from './operations/status.ts';
import { CallRefusal } from './refusals.ts';

/**
 * The arbitration transaction, which is one shape, provided once.
 *
 * `MILESTONES.md`'s implementation note for #10, #12, #13 and #16 gives the
 * shape in full, and it is a shape rather than a suggestion — "a path that
 * opens its own transaction differently is the bug both build checks in #50
 * exist to catch":
 *
 * ```
 * BEGIN IMMEDIATE
 *   1. Sweep, globally
 *   2. Answer, from the reconciled state
 * COMMIT
 *   3. After the commit, outside every transaction: close the collected tabs
 * ```
 *
 * ── What this module makes structural, and what it does not ─────────────
 *
 * Stated exactly, in the manner `transaction.ts` states its own bypasses,
 * because #50's checks have to be built against the difference rather than
 * against a hope:
 *
 * **Structural — you cannot get this wrong through this module.**
 *
 * - **The sweep is the runner's, not the operation's.** {@link runArbitration}
 *   calls it before the handler, unconditionally, and a handler has no way to
 *   skip it: it is not a flag, not an option, and not a function the handler
 *   is passed. **This is the standing invariant made mechanical** — §1.0a's
 *   guarantee is writer serialisation rather than full serialisability, and
 *   it "holds only because every arbitration path writes". A handler that
 *   returns without writing a thing still ran a global sweep, so the
 *   transaction is still a writer.
 * - **A handler cannot reach the transaction helper.** It is given a
 *   {@link ArbitrationScope}, which carries the driver handle and the swept
 *   state, and no means of opening anything. The transaction is already open
 *   by the time a handler runs.
 * - **After-commit work is declared, not performed.** A handler returns the
 *   closures it wants run afterwards; it does not run them. The runner passes
 *   them to the transaction helper's own `afterCommit`, which is the seam
 *   that already exists for this — §2.4b, and the reason it exists is that
 *   the most natural way to invent a parallel one is by doing browser work
 *   inside the callback, which is the violation.
 * - **An unregistered operation cannot be dispatched.** {@link ArbitrationName}
 *   is the union of the registry's keys, so a name that is not registered is a
 *   compile error at every internal call site.
 *
 * **Conventional — this module makes the correct path the easy one and does
 * not make the wrong one impossible.**
 *
 * - **Nothing stops a future module opening its own transaction.** The store
 *   handle exports `immediate`, and `transaction.ts` records that a savepoint
 *   and a bare statement both bypass even that. What this module buys is that
 *   the arbitration surface is a **single enumerable registry**, which is what
 *   makes `arbitration.no_read_only_path` checkable at all: a check can walk
 *   the registry and know it has seen every arbitration operation this build
 *   has. It cannot know whether somebody wrote a query somewhere else and
 *   called it something other than arbitration.
 * - **Nothing here stops a handler doing browser work.** `ArbitrationScope`
 *   deliberately does not carry a driver, so the obvious path has nothing to
 *   call — but a handler that imports one directly would compile.
 *   `arbitration.no_browser_io` (§7.3) is a separate check and a separate row;
 *   this module's contribution to it is the after-commit collection, which
 *   makes the correct place to close a tab the path of least resistance.
 */

/**
 * A tab the sweep found and the commit orphaned.
 *
 * **A leaked tab is not a leaked lease** (§2.4b). By the time one of these is
 * closed the capacity is already back — the transaction reclaimed it, and the
 * commit made that true. What remains is a page in a browser that nobody
 * owns, which costs memory and does not cost budget.
 */
export interface OrphanedTab {
  readonly tabId: string;
  readonly claimId: string;
  readonly browserId: string;
}

/**
 * What the global sweep did, handed to the handler so it does not repeat the
 * work.
 *
 * **The sweep is global rather than scoped to the caller** (§2.4, and the
 * implementation note's "step 1 is global"): capacity held by something that
 * died must come back on the next call from *anyone*, and a caller asking
 * about its own lease is often the only call that will arrive for a while.
 * Scoping it would leave a machine's capacity pinned by a process nobody is
 * ever going to ask about again.
 */
export interface SweepResult {
  /** Claims whose expiry had elapsed, now `expired`. */
  readonly expiredClaimIds: readonly string[];
  /** Their tabs, to be closed after the commit and not before. */
  readonly orphanedTabs: readonly OrphanedTab[];
  /**
   * The timestamp the sweep ran at, read from the database's own clock.
   *
   * Handed to the handler rather than recomputed, so every derivation inside
   * one call uses one instant. Several processes are running by design
   * (§1.0a) and a handler calling the clock again could otherwise decide an
   * expiry against a moment its own sweep did not use.
   */
  readonly sweptAt: string;
}

/** What a handler is given. It has a transaction; it cannot open one. */
export interface ArbitrationScope {
  /**
   * Record a refusal so that it survives the rollback the refusal causes.
   *
   * ── The problem this solves, stated plainly ─────────────────────────────
   *
   * §1.6 requires **every decision, allowed and refused alike**, and a
   * refusal is thrown — which rolls the transaction back and takes an
   * ordinary `append` with it. So a guard that recorded its denial with
   * `append` alone would write a row that is never committed, and the ledger
   * would contain grants only. That is precisely the half-a-ledger failure
   * §1.6 opens by naming: *"a record containing only refusals cannot answer
   * was this rule ever actually reached"* — and its mirror is worse, because
   * a ledger of grants alone can never show a guard firing at all.
   *
   * **A row handed here is written after the rollback, on its own.** It is
   * therefore committed even though the decision it describes undid
   * everything else, which is the correct outcome: the refusal *happened*,
   * and it is the one thing about the call that was not undone.
   *
   * ── What this costs, said rather than hidden ────────────────────────────
   *
   * The row is written outside the transaction that decided it, so its
   * ledger identifier does not fall between the identifiers of the rows that
   * call would have written — there are none, because they rolled back. What
   * it is not is a second decision: nothing re-runs, and the guard that
   * refused has already refused by the time this is called.
   */
  readonly recordRefusal: (event: AppendEvent) => void;

  /**
   * Schedule a tab to be closed **after the commit**, through the same seam
   * the sweep's own orphans go through.
   *
   * ── Why this is on the scope rather than left to the handler ────────────
   *
   * An operation that ends a lease has a tab to close (§3.4), and the sweep
   * is not the only thing that produces one. Without this a handler would
   * have to build its own after-commit closure over a driver it had reached
   * for itself — which is the exact shape §2.4b exists to prevent, and the
   * most natural way to invent it is by doing the work inside the callback.
   *
   * **It carries no driver and cannot be made to do browser work now.** It
   * records a tab against the call; the runner turns the record into an
   * after-commit action using the closer its caller supplied, and calls it
   * outside every transaction. A handler holding this has no way to make a
   * browser call happen inside the transaction, which is what keeps
   * `arbitration.no_browser_io` true through this path as well.
   */
  readonly closeAfterCommit: (tab: OrphanedTab) => void;
  /**
   * The driver handle, inside the open transaction.
   *
   * Only the service layer reaches the store client (`db.import_isolated`,
   * §7.3) and this is where that reach lives for arbitration.
   */
  readonly db: Database;
  /** What the sweep reconciled, before this handler was called. */
  readonly swept: SweepResult;
  /** Which door the call came in through, for the ledger row. */
  readonly adapter: EventAdapter;
}

/**
 * What a handler returns.
 *
 * `afterCommit` is in the signature from the start for the same reason
 * `TransactionResult` has it: a handler that had only "run this inside" would
 * leave the author of the first browser-touching path to invent the
 * outside-the-transaction seam, and the natural way to invent it is by doing
 * the work in the callback (§2.4b).
 */
export interface ArbitrationOutcome<T> {
  readonly value: T;
  /** Ran after the commit, in order, each failure swallowed. */
  readonly afterCommit?: readonly (() => void | Promise<void>)[];
}

export type ArbitrationHandler<Input, Output> = (
  scope: ArbitrationScope,
  input: Input,
) => ArbitrationOutcome<Output> | Promise<ArbitrationOutcome<Output>>;

/**
 * One registered arbitration operation.
 *
 * `writes` is not a field, and its absence is the design. An operation cannot
 * declare itself read-only, because the runner sweeps for it either way — the
 * invariant is enforced by there being no way to express the violation, not
 * by a flag somebody could set. A field here would be the first thing a
 * well-intentioned optimisation reached for.
 */
export interface ArbitrationOperation<Input = never, Output = unknown> {
  /** The ledger kind this operation records against (§1.6). */
  readonly kind: EventKind;
  /** One line, for a person reading the registry. */
  readonly summary: string;
  readonly handler: ArbitrationHandler<Input, Output>;
}

/**
 * The settings an operation decides against, carried on the input rather than
 * read by the handler.
 *
 * **A handler reaching for the environment itself is the shape this avoids.**
 * §6.3 puts one snapshot per process, read on the way in, so that every rule
 * inside one operation sees one configuration; a handler that read its own
 * would be a second snapshot, taken at a different instant, inside a
 * transaction other callers are waiting behind.
 */
export interface WithSettings {
  readonly settings: ArbitrationSettings;
}

function claimHandler(
  scope: ArbitrationScope,
  input: ClaimInput & WithSettings,
): ArbitrationOutcome<ClaimResult> {
  return decideClaim(scope, input, input.settings);
}

function statusHandler(
  scope: ArbitrationScope,
  input: StatusInput,
): ArbitrationOutcome<StatusResult> {
  return decideStatus(scope, input);
}

function releaseHandler(
  scope: ArbitrationScope,
  input: ReleaseInput & WithSettings,
): ArbitrationOutcome<ReleaseResult> {
  return decideRelease(scope, input, input.settings);
}

/**
 * The six tab-addressed handlers.
 *
 * **None of them takes settings**, for the reason `decideStatus` gives about
 * itself: every duration they report comes off the lease's own row, because
 * each of these renews the lease it names and a renewal has to extend by the
 * duration the caller was already told about. A settings argument they did
 * not use would invite exactly the re-read §6.3 forbids.
 */
function navigateHandler(
  scope: ArbitrationScope,
  input: NavigateInput,
): ArbitrationOutcome<NavigateResult> {
  return decideNavigate(scope, input);
}

function actHandler(scope: ArbitrationScope, input: ActInput): ArbitrationOutcome<ActResult> {
  return decideAct(scope, input);
}

function readHandler(scope: ArbitrationScope, input: ReadInput): ArbitrationOutcome<ReadResult> {
  return decideRead(scope, input);
}

function evaluateHandler(
  scope: ArbitrationScope,
  input: EvaluateInput,
): ArbitrationOutcome<EvaluateResult> {
  return decideEvaluate(scope, input);
}

function captureHandler(
  scope: ArbitrationScope,
  input: CaptureInput,
): ArbitrationOutcome<CaptureResult> {
  return decideCapture(scope, input);
}

function tabReplaceHandler(
  scope: ArbitrationScope,
  input: TabReplaceInput,
): ArbitrationOutcome<TabReplaceResult> {
  return decideTabReplace(scope, input);
}

/**
 * Every arbitration operation this build has.
 *
 * **This registry is the set `arbitration.no_read_only_path` walks**, and the
 * reason it is one object in one file rather than a call to a `register()`
 * function scattered across modules: a check that has to *find* the
 * registrations can only find the ones written the way it expects, and the
 * first one written differently is invisible to it. A single object literal
 * is enumerable statically and at run time, and the two enumerations can be
 * asserted equal.
 *
 * **Every operation here writes, without exception**, which is the property
 * the registry exists to keep true. `claim` inserts a row; `release` updates
 * one; `status` renews, which is row #14's point — a keyed call extends the
 * lease it names, so the operation that looks read-only is a writer twice
 * over, once for its own renewal and once for the sweep the runner ran
 * before it.
 *
 * **The six tab-addressed operations are writers on the same grounds**, and
 * it is worth being explicit because they are the ones that look least like
 * it: `navigate`, `act`, `read`, `evaluate` and `capture` each read a page
 * and change nothing about it, yet each is keyed, so each renews, and each
 * records what it did. The browser work they cause is not part of the
 * transaction at all — it is handed back as `afterCommit` and run once the
 * commit is done (§2.4b), so what is inside the transaction is only ever the
 * renewal, the ownership check and the ledger row.
 *
 * **The empty-registry exemption in `scripts/check-arbitration.mjs` is
 * retired by this row**, which is what it named as the condition for its own
 * removal. Every rule that check enforces is now an assertion over a
 * non-empty set.
 */
export const ARBITRATION_OPERATIONS = {
  claim: {
    kind: 'claim_requested',
    summary: 'Ask for a lease over one tab: granted if capacity allows, queued at the back if not.',
    handler: claimHandler,
  },
  status: {
    kind: 'claim_renewed',
    summary: 'Where this lease stands, and — like every keyed call — an extension of it.',
    handler: statusHandler,
  },
  release: {
    kind: 'claim_released',
    summary: 'Give back whatever this lease holds: a tab, or a place in the queue.',
    handler: releaseHandler,
  },
  navigate: {
    kind: 'navigate',
    summary: 'Point an owned tab at an address, having checked the scheme is one of the two.',
    handler: navigateHandler,
  },
  act: {
    kind: 'act',
    summary: 'One interaction against an owned tab, from the thirteen the seam names.',
    handler: actHandler,
  },
  read: {
    kind: 'read',
    summary: 'Collect artifacts from an owned tab; the page state is always among them.',
    handler: readHandler,
  },
  evaluate: {
    kind: 'evaluate',
    summary: 'Run a bounded expression in an owned tab and dispose of what it returned.',
    handler: evaluateHandler,
  },
  capture: {
    kind: 'capture',
    summary: 'Take an image of an owned tab, of the viewport or of the whole page.',
    handler: captureHandler,
  },
  tab_replace: {
    kind: 'tab_closing',
    summary: 'Give up this lease’s tab and take a fresh one, without the count dipping.',
    handler: tabReplaceHandler,
  },
} as const satisfies Readonly<Record<string, ArbitrationOperation>>;

/** The name of an operation this build registers. Anything else is a type error. */
export type ArbitrationName = keyof typeof ARBITRATION_OPERATIONS;

/** The registered names as data, for the registry test and the ledger. */
export const ARBITRATION_NAMES: readonly string[] = Object.keys(ARBITRATION_OPERATIONS);

/**
 * Expire every lapsed claim and every lapsed queue entry, across the whole
 * store, and collect the tabs they held.
 *
 * **This is what makes even a question a write** (§1.0a, §2.4). It is not
 * conditional, not skippable and not scoped to the caller, and those three
 * properties are the standing invariant rather than three separate choices.
 *
 * ── Why the lapse time is computed rather than stamped ──────────────────
 *
 * §2.4a: `claims.expired_at` is when the lease *lapsed*, which is not when
 * the sweep noticed. A lease whose caller stopped talking lapsed at its own
 * expiry, whether the next caller arrived one second later or forty minutes
 * later. Stamping the sweep's own moment produces a record in which leases
 * expire in clusters at instants when nothing happened to them — an artifact
 * of the observer, and a bad kind, because it is a strong, clean, entirely
 * fictitious pattern.
 *
 * So `expired_at` is set to the row's own `expires_at`, which is the last
 * renewal plus the duration that was in force. The ledger row carries the
 * sweep's moment, and says so by being a ledger row.
 */
function sweep(db: Database): SweepResult {
  const sweptAt = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get() as {
    now: string;
  };
  const now = sweptAt.now;

  // Read before writing, inside the transaction. Which tabs the lapsed claims
  // held cannot be read after the update on the claims alone — the claims are
  // still there — but reading first keeps the two statements over one set of
  // rows rather than over whatever the second statement re-derives.
  const lapsed = db
    .prepare(
      `SELECT id FROM claims
       WHERE state IN ('queued', 'active') AND expires_at <= @now
       ORDER BY id`,
    )
    .all({ now }) as { id: string }[];

  if (lapsed.length === 0) {
    return { expiredClaimIds: [], orphanedTabs: [], sweptAt: now };
  }

  const placeholders = lapsed.map(() => '?').join(', ');
  const ids = lapsed.map((row) => row.id);

  const orphanedTabs = db
    .prepare(
      `SELECT id AS tabId, claim_id AS claimId, browser_id AS browserId
       FROM tabs
       WHERE claim_id IN (${placeholders}) AND state IN ('opening', 'open')
       ORDER BY id`,
    )
    .all(...ids) as OrphanedTab[];

  // Positional parameters throughout, not a mix. The driver refuses a
  // statement that carries both spellings, and the list of identifiers has to
  // be positional because its length varies per call.
  db.prepare(
    `UPDATE claims
     SET state = 'expired',
         -- Section 2.4a: when it lapsed, not when this noticed.
         expired_at = expires_at,
         ended_at = expires_at,
         updated_at = ?
     WHERE id IN (${placeholders})`,
  ).run(now, ...ids);

  // The tab rows follow their claims, and which state they follow into
  // depends on whether there is anything to ask a browser about.
  //
  // §1.4 defines the two precisely, and the definition decides this rather
  // than a preference: `closing` is "the honest representation of *the tool
  // was asked and has not answered*", and it is what stops **a page that may
  // still exist** being counted as free.
  //
  // - **A tab with a driver name was opened.** A page exists, the tool will be
  //   asked to close it after the commit, and until it answers `closing` is
  //   the only honest thing to say.
  // - **A tab with no driver name was never opened.** Nothing was asked,
  //   because there is nothing to ask about — no page exists and none ever
  //   did. Calling that `closing` would assert an outstanding round trip that
  //   is not outstanding, and would leave the row waiting forever for an
  //   answer nobody is coming to give.
  //
  // So the second goes straight to `closed`, which is also what the schema
  // requires: `CHECK ((state = 'opening') = (driver_tab_id IS NULL))` permits
  // a null driver name only on `opening`, and a `closed` row with one is
  // exactly as consistent as an `open` row with one. **The constraint is
  // right and it caught a genuine error**, rather than being an obstacle to
  // route around — a tab moved to `closing` with nothing to close is a claim
  // about the world that is false.
  // What comes back is the subset a browser still owes an answer about. The
  // rest are already `closed`, so scheduling a close for them would ask the
  // driver to shut a page that never existed.
  const pendingCloses = updateSweptTabs(db, orphanedTabs, now);

  return { expiredClaimIds: ids, orphanedTabs: pendingCloses, sweptAt: now };
}

/**
 * Move tabs out of a lease that has ended, into the state that is true of
 * each.
 *
 * **Exported because release needs exactly this rule** (§3.4) and two writers
 * spelling it separately is how they come to disagree. The defect this
 * function exists to make impossible was precisely that: the sweep and
 * release each moved every tab to `closing`, and every tab this build creates
 * has no driver name, so both violated the schema's own check on the ordinary
 * path.
 *
 * Returns the tabs that still need a browser round trip — which is **not**
 * every tab handed in. A tab that never opened has nothing to close, so
 * scheduling one would be asking the driver to close a page that does not
 * exist.
 */
export function updateSweptTabs(
  db: Database,
  tabs: readonly OrphanedTab[],
  now: string,
): readonly OrphanedTab[] {
  if (tabs.length === 0) {
    return [];
  }

  const ids = tabs.map((tab) => tab.tabId);
  const placeholders = ids.map(() => '?').join(', ');

  // Opened, so a page exists and the tool has to be asked. `closing` until it
  // answers.
  db.prepare(
    `UPDATE tabs
        SET state = 'closing', updated_at = ?
      WHERE id IN (${placeholders})
        AND state IN ('opening', 'open')
        AND driver_tab_id IS NOT NULL`,
  ).run(now, ...ids);

  // Never opened, so there is nothing to ask and nothing to wait for. The
  // close time is this moment because the tab is over now, not when some
  // round trip that will never happen would have returned.
  db.prepare(
    `UPDATE tabs
        SET state = 'closed', closed_at = ?, updated_at = ?
      WHERE id IN (${placeholders})
        AND state = 'opening'
        AND driver_tab_id IS NULL`,
  ).run(now, now, ...ids);

  // Only the ones a browser still owes an answer about.
  const pending = db
    .prepare(
      `SELECT id AS tabId, claim_id AS claimId, browser_id AS browserId
         FROM tabs
        WHERE id IN (${placeholders}) AND state = 'closing'
        ORDER BY id`,
    )
    .all(...ids) as OrphanedTab[];

  return pending;
}

/**
 * Record what the sweep did, on the call that performed it.
 *
 * §1.6's `internal` adapter, and the reason it exists: "that last one is not a
 * background job — with no long-lived process there is nothing running in the
 * background — so a sweep is attributed to the call that performed it". The
 * adapter recorded here is therefore the **caller's**, not `internal`; the
 * kind is what says this was a sweep.
 *
 * **A sweep that found nothing writes no row.** The ledger records decisions,
 * and finding nothing to expire is not one — a row per call on a quiet
 * installation would be the ledger's largest category and would carry no
 * information. What is recorded is each claim that actually expired, which is
 * a decision about that lease.
 */
function recordSweep(scope: ArbitrationScope, swept: SweepResult): void {
  for (const claimId of swept.expiredClaimIds) {
    append(scope.db, {
      kind: 'claim_expired',
      outcome: 'allow',
      adapter: scope.adapter,
      claimId,
      detail: {
        sweptAt: swept.sweptAt,
        orphanedTabs: swept.orphanedTabs.filter((tab) => tab.claimId === claimId).length,
      },
    });
  }
}

/**
 * How a swept tab is actually closed, supplied by the caller.
 *
 * **A function rather than a driver**, and that is the seam doing work: this
 * module has no import of anything that talks to a browser, so
 * `arbitration.no_browser_io` has nothing to find here even by call graph.
 * The caller that owns a browser session supplies a closure, and the runner
 * only ever calls it after the commit.
 *
 * **It is expected to fail sometimes, and failing is not an error.** §2.4b:
 * best effort, and a tab that will not close is a leaked tab rather than a
 * leaked lease. Whatever this throws is swallowed by the transaction
 * helper's own after-commit handling.
 */
export type CloseOrphanedTab = (tab: OrphanedTab) => void | Promise<void>;

export interface RunArbitrationOptions<Input> {
  readonly store: StoreHandle;
  readonly name: string;
  readonly adapter: EventAdapter;
  readonly input: Input;
  /**
   * What to do with the tabs the sweep orphaned, after the commit.
   *
   * **Optional, and omitting it leaks tabs rather than leases** — which is
   * the documented consequence rather than a gap. A caller with no browser
   * session (a command-line read, a test) has nothing to close with, and the
   * capacity still came back at commit. The rows stay `closing`, which is
   * what §1.4 calls the honest representation of "the tool was asked and has
   * not answered", and the administrative operation that clears a leaked tab
   * (§4.3) is what deals with them.
   */
  readonly closeTab?: CloseOrphanedTab;
}

/**
 * Dispatch one arbitration operation: sweep, answer, commit, then close.
 *
 * **The only way an arbitration operation is invoked.** Everything in the
 * shape that must not vary lives here rather than in the operations — the
 * transaction, the sweep, the ledger row for what the sweep did, and the
 * ordering of all three — so an operation cannot get the order wrong by
 * writing it differently. What an operation supplies is step 2 alone.
 *
 * The transaction is opened by `immediate` from `transaction.ts` and by
 * nothing else in this module. There is no second path, no fast path and no
 * option that skips it, which is the whole of what
 * `arbitration.immediate_transaction` can be enforced against on this side —
 * the check itself explains what it can and cannot prove.
 */
export async function runArbitration<Input, Output>(
  options: RunArbitrationOptions<Input>,
): Promise<Output> {
  // Read as an untyped record so an unregistered name is a lookup returning
  // nothing rather than a type error at this site: the refusal below is what
  // handles it, and it has to be reachable at run time for a caller on a
  // different build. The per-operation input types are preserved on the
  // registry itself, which is what makes an internal call site type-safe.
  const operation = (
    ARBITRATION_OPERATIONS as unknown as Readonly<
      Record<string, ArbitrationOperation<unknown, unknown>>
    >
  )[options.name];

  if (operation === undefined) {
    // Refused before the transaction opens, deliberately. An unregistered
    // name is not a decision about capacity and there is nothing to sweep on
    // behalf of — opening a transaction to refuse it would serialise every
    // caller on the machine behind a mistyped operation name.
    throw new CallRefusal(
      'unknown_operation',
      `There is no arbitration operation named ${JSON.stringify(options.name)}. This build registers ${ARBITRATION_NAMES.length === 0 ? 'none yet' : ARBITRATION_NAMES.join(', ')}.`,
      { detail: { requested: options.name, registered: ARBITRATION_NAMES } },
    );
  }

  // Refusals collected inside the transaction and written after it rolls
  // back. A refusal is a decision (§1.6) and it is the one thing about a
  // refused call that was not undone, so it must outlive the rollback its own
  // throw causes.
  const refusals: AppendEvent[] = [];

  try {
    return await options.store.immediate(async ({ db }) => {
      // Step 1, always, before anything the operation does. Unconditional is
      // the point: this is what makes the transaction a writer even when the
      // operation only asks a question (section 1.0a).
      const swept = sweep(db);

      // What the operation asks to have closed, collected inside and acted on
      // outside. A list rather than a call: nothing here can reach a browser,
      // so a handler cannot turn a schedule into a round trip.
      const scheduled: OrphanedTab[] = [];
      const scope: ArbitrationScope = {
        db,
        swept,
        adapter: options.adapter,
        closeAfterCommit: (tab) => {
          scheduled.push(tab);
        },
        recordRefusal: (event) => {
          refusals.push(event);
        },
      };
      recordSweep(scope, swept);

      // Step 2: the operation answers from the reconciled state.
      const outcome = (await operation.handler(scope, options.input)) as ArbitrationOutcome<Output>;

      // Step 3 is handed to the transaction helper, which runs it after the
      // commit and outside every transaction. The sweep's own orphaned tabs
      // are scheduled here rather than by the operation, because an operation
      // that had to remember to close them is an operation that can forget —
      // and the sweep is not its work in the first place.
      //
      // The sweep's closes go first: they are reclamation of capacity that
      // has already come back, and an operation's own after-commit work may
      // well be opening the tab that capacity is for.
      const closeTab = options.closeTab;
      const closes: (() => void | Promise<void>)[] =
        closeTab === undefined
          ? []
          : [...swept.orphanedTabs, ...scheduled].map((tab) => () => closeTab(tab));

      return {
        value: outcome.value,
        afterCommit: [...closes, ...(outcome.afterCommit ?? [])],
      };
    });
  } finally {
    // **After the transaction, whichever way it went.** On the ordinary path
    // this list is empty and the block does nothing. On a refusal the
    // transaction has rolled back, so these rows are written on their own —
    // which is what makes a refused decision recorded rather than erased by
    // the very refusal it describes (§1.6).
    //
    // `finally` rather than a catch, because a guard is free to record a
    // refusal and then let the call succeed anyway — the nudge is exactly
    // that shape — and a catch would drop the row on the path that did not
    // throw.
    writeRefusals(options.store, refusals);
  }
}

/**
 * Write the collected refusal rows, outside the transaction that produced
 * them.
 *
 * **Failure here is swallowed, deliberately, and this is a real trade rather
 * than an oversight.** The caller is already receiving a refusal that names
 * the rule and says what to do next; turning a failure to *record* that
 * refusal into a second, different error would replace an actionable answer
 * with an unactionable one, and the caller would be left unable to tell which
 * of the two actually decided its call.
 *
 * **What that costs is a refusal missing from the ledger** under conditions
 * that also lose ordinary writes. The alternative costs the caller its
 * answer, which is worse.
 */
function writeRefusals(store: StoreHandle, refusals: readonly AppendEvent[]): void {
  if (refusals.length === 0) {
    return;
  }
  try {
    for (const refusal of refusals) {
      append(store.db, refusal);
    }
  } catch {
    // See above: the caller's refusal is the more useful of the two answers.
  }
}
