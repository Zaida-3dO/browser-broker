import { updateSweptTabs, type ArbitrationOutcome, type ArbitrationScope } from '../arbitration.ts';
import type {
  ActionRequest,
  BrowserId,
  BrowserSession,
  CaptureRequest,
  ReadArtifact,
  TabHandle,
} from '../../browser/driver.ts';
import { append, type EventKind } from '../events.ts';
import { extendLease, resolveLease, type ResolvedLease } from '../leases.ts';
import { resolveOwnedTabOrRefuse } from '../ownership.ts';
import {
  disposeEvaluationResult,
  MAX_INLINE_RESULT_BYTES,
  validateCaptureMode,
  resolveReadArtifacts,
  validateAction,
  validateExpression,
  validateNavigationTarget,
} from '../pages.ts';
import { recordTabOpened, reserveTab } from '../tabs.ts';
import type { PendingSeeds } from '../pending-seeds.ts';
import { seedRecord } from '../storage-seed.ts';
import { BrokerError } from '../../errors.ts';
import type { ArtifactStore } from '../../artifacts/store.ts';
import { sanitiseLabel, stampFromInstant } from '../../artifacts/names.ts';
import { takeCapture } from '../../capture/pipeline.ts';
import { capturesTakenBy, recordCapture } from '../capture-store.ts';
import { captureSource } from '../capture-seam.ts';
import { insertComparison } from '../comparison-store.ts';
import { runComparison, type ComparisonResult } from '../comparison.ts';
import { DEFAULT_DIFF_SETTINGS, type DiffSettings } from '../../diff/settings.ts';

/**
 * The six tab-addressed operations, joined to the arbitration transaction.
 *
 * ── What this module is, and what it deliberately is not ────────────────
 *
 * `src/service/pages.ts` is the guard layer: pure argument validation, no
 * store, no browser, and its own header calls that a boundary rather than a
 * coincidence. `src/service/ownership.ts` is the ownership guard, against the
 * store. `src/browser/driver.ts` is the seam a browser is driven through.
 * All three were built, tested and reviewed before this file existed, and
 * **none of them had a caller** — the surface named ten operations and three
 * were registered, so a caller could take a lease and then do nothing with
 * the tab it got.
 *
 * This module is that join and nothing else. It introduces no new rule, no
 * new refusal code and no new validation: every guard it applies is one of
 * those already written, called in the order the schema requires.
 *
 * ── The order, which is the whole design ────────────────────────────────
 *
 * `SCHEMA.md` §2.4b is unambiguous and it is what shapes every handler here:
 *
 * > **Never do browser I/O inside the arbitration transaction.** The
 * > transaction reclaims capacity and decides; browser work happens after
 * > the commit.
 *
 * So each handler does exactly this, and in this order:
 *
 * 1. **Resolve the lease from the key, which also renews it.** Every keyed
 *    call extends the lease it names (§2.5, row #14) — a caller driving a
 *    tab is a caller who is plainly still there, and making that renew is
 *    what stops an active session losing its lease mid-task.
 * 2. **Validate the arguments**, with the pure validators. A refusal here
 *    happens before anything is written and before any tab is resolved.
 * 3. **Resolve the tab against the lease**, which refuses identically for
 *    unknown, unowned and not-open (§7.1).
 * 4. **Write what the store must record**, on `scope.db`, inside the
 *    transaction.
 * 5. **Return the browser work in `afterCommit`.** Not called here — the
 *    runner calls it after the commit, outside every transaction.
 *
 * ── Why the session arrives as a function rather than a handle ──────────
 *
 * A handler is handed no driver, and it must not be able to acquire one:
 * `ArbitrationScope` carries none, and that is what makes
 * `arbitration.no_browser_io` true by construction rather than by
 * discipline. The session is therefore supplied **on the input**, by the
 * caller that owns the browser connection, exactly as `closeTab` is supplied
 * on `BrokerOptions` — and it is only ever read inside an `afterCommit`
 * closure, never in the body of a handler.
 *
 * **A handler with no session still decides, still writes, and still
 * refuses.** It simply has no browser work to hand back, which is the same
 * documented consequence as omitting `closeTab`: the decision stands and the
 * page is not driven. That is what makes every guard in this file testable
 * without a browser, and it is why the tests for the refusals need no
 * driver at all.
 */

/**
 * How a handler reaches the browser, after the commit.
 *
 * A function returning a session rather than a session, so that a caller
 * which has not connected yet is not forced to connect in order to be
 * refused. It is invoked inside `afterCommit` and nowhere else.
 *
 * ── Why it is asked which browser, and why the handler is what asks ─────
 *
 * There are exactly two browsers and they are not interchangeable: one is
 * headed and signed in, the other headless and ephemeral (§1.2). A tab lives
 * in one of them, and **which one is a fact about the tab's row**, resolved
 * inside the transaction by `resolveOwnedTabOrRefuse` against the lease that
 * owns it. So the handler is the thing that knows, and it says so on the call
 * rather than the provider guessing or defaulting.
 *
 * A zero-argument source would have to pick a browser some other way, and
 * every way of picking is wrong: a default sends work for a signed-in page to
 * the browser that is signed in to nothing, and *"whichever is already
 * running"* makes the answer depend on what some earlier caller happened to
 * need.
 */
export type SessionSource = (browser: BrowserId) => BrowserSession | Promise<BrowserSession>;

/** What every tab-addressed operation carries. */
export interface TabOperationInput {
  readonly key: string;
  readonly tabId: string;
  /**
   * The browser connection, supplied by the caller that owns one.
   *
   * **Optional, and omitting it means the page is not driven** — the
   * documented consequence rather than a gap, and the same trade
   * `BrokerOptions.closeTab` makes. The lease is still renewed, the
   * arguments are still validated, ownership is still enforced and the
   * ledger still records the call.
   */
  readonly session?: SessionSource;
  /**
   * Seeds waiting to be written into this tab before it is first navigated
   * (§3.2, row #65).
   *
   * **Optional and supplied by the caller that owns the process**, exactly as
   * {@link TabOperationInput.session} is: a build with no browser has no page
   * to seed, and every guard here is testable without one. Omitting it means
   * nothing is seeded and nothing claims to have been — the ledger records
   * what was written, so silence here is silence there.
   *
   * See `pending-seeds.ts` for why the entries are held in memory rather than
   * in the store, and what that costs.
   */
  readonly pendingSeeds?: PendingSeeds;
}

/**
 * What every tab-addressed operation reports back, before its own payload.
 *
 * `tabId` is the opaque identifier and **never the driver's name for the
 * page**. `tabs.ts` warns that the column is right there and SQL is not
 * type-checked; the defence is that surfacing it would have to be written in
 * a file that is not that one, and this is such a file, so it is worth being
 * explicit: nothing here reads `driverTabId` into a result.
 */
export interface TabOperationResult {
  readonly claimId: string;
  readonly tabId: string;
  /** The expiry **after** this call extended it. */
  readonly expiresAt: string;
  /**
   * Whether a browser was actually reached, or the page half was a no-op.
   *
   * ── Why this field exists, stated as the thing that happened ────────────
   *
   * This module's header already said it plainly — "a handler with no session
   * still decides, still writes, and still refuses; it simply has no browser
   * work to hand back" — and that remained true and remained *invisible*. A
   * caller driving the shipped binary against a build with no session source
   * got this, over real pipes:
   *
   * ```
   * browser_read     -> {"outcome":"accepted","value":{…,"artifacts":["snapshot"]}}
   * browser_capture  -> {"outcome":"accepted","value":{…,"fullPage":false}}
   * ```
   *
   * …while `SELECT count(*) FROM captures` was **0**. `read` named an
   * artifact nobody collected, `capture` reported an image that does not
   * exist, and the only place the truth was written down was a source comment
   * in `runtime.ts`. `accepted` reads as success, so a caller scripting
   * against this reasonably concluded the page had moved.
   *
   * That is the inverse of the house rule. `refusals.ts` opens on §7's "a
   * rule that never refuses anything protects nothing, so the refusals are
   * the specification", and the whole taxonomy exists so that a no arrives
   * carrying its reason. Silence dressed as acceptance is the same defect
   * pointed the other way: a ledger asserting a fact that did not happen.
   *
   * ── Why a field on the accepted result, and not a refusal ───────────────
   *
   * A refusal here would be **a second lie in the opposite direction.** The
   * arbitration half of the call genuinely happened and is genuinely durable:
   * capacity was taken, the lease was resolved and renewed (§2.5), ownership
   * was enforced (§7.1), and a row went into the ledger. §5.6 already fixes
   * the meaning of the outcomes — a refusal is a call that "does not happen"
   * — so reporting one would tell a caller to retry a decision that is
   * already committed and already extended its lease. Two of the refusal
   * table's own constraints point the same way: it refuses to carry a code
   * the build cannot raise, and `retryable` would have no honest value here.
   *
   * So the outcome stays `accepted`, because the operation was accepted, and
   * the result says what was and was not done with it. The name is negative
   * (`pageDriven: false`) rather than positive so that the surprising state
   * is the one that has to be spelled out.
   *
   * ── Why it is on the shared base rather than on each verb ───────────────
   *
   * All six tab-addressed results extend this interface, so declaring it here
   * is what makes it impossible to answer honestly on five verbs and silently
   * on the sixth. The value comes from {@link afterCommitWork}, which is the
   * one place in the service that knows whether a session was supplied — the
   * knowledge and the reporting of it are therefore the same expression, and
   * cannot drift apart.
   */
  readonly pageDriven: boolean;

  /**
   * Why the page was not driven, present only when it was not.
   *
   * ── Why the fact alone was not enough ───────────────────────────────────
   *
   * `pageDriven: false` tells a caller that its call did not reach the page.
   * It does not tell it whether that is worth retrying, and the causes want
   * opposite responses: a browser that will not launch is not the caller's to
   * fix, while **a reference naming nothing on the page is fixed by
   * reading the page again** — which a caller can do by itself, immediately,
   * without a person.
   *
   * Absent on success rather than empty, so the field's presence is itself
   * the signal and there is no "" to mistake for a reason nobody gave.
   */
  readonly notDrivenReason?: string | undefined;
}

/**
 * Steps 1 to 3, which are identical for all six and therefore written once.
 *
 * Written as one function rather than copied into each handler because the
 * order is the rule: a handler that validated before renewing, or resolved
 * the tab before validating, would refuse in a different order than every
 * other operation, and the difference would be invisible until a caller
 * depended on it.
 */
function admit(
  scope: ArbitrationScope,
  input: TabOperationInput,
  kind: EventKind,
): {
  readonly lease: ResolvedLease;
  readonly tab: {
    readonly tabId: string;
    readonly browserId: string;
    readonly driverTabId: string | null;
  };
  readonly expiresAt: string;
} {
  const { db, adapter, swept } = scope;

  const lease = resolveLease(db, input.key, {
    adapter,
    kind: 'claim_renewed',
    recordRefusal: scope.recordRefusal,
  });
  const expiresAt = extendLease(db, lease, { adapter, now: swept.sweptAt });
  const tab = resolveOwnedTabOrRefuse(db, lease, input.tabId, {
    adapter,
    kind,
    recordRefusal: scope.recordRefusal,
  });

  return { lease, tab, expiresAt };
}

/** The row a tab operation resolved, as `admit` hands it back. */
interface ResolvedTab {
  readonly tabId: string;
  readonly browserId: string;
  readonly driverTabId: string | null;
}

/**
 * Get the page this tab names, opening it if it has never been opened.
 *
 * ── Why the page is opened here rather than when the lease was granted ──
 *
 * Granting a lease reserves a tab **row** — `opening`, with no driver name,
 * because §1.4 requires a tab to carry a driver name only once a page
 * genuinely exists. Nothing about granting capacity requires a page to exist
 * yet, and it would be the wrong moment to make one: the grant happens inside
 * the arbitration transaction, and opening a page there is precisely the
 * browser I/O §2.4b forbids.
 *
 * So the page is opened the first time somebody actually addresses the tab,
 * after that call's commit, by the caller that has the browser connection.
 * That is also the only moment at which a session is guaranteed to be
 * available: capacity can be granted to a caller that has not connected to
 * anything, and refusing to grant it until one had would make the queue
 * depend on the caller's own connection state.
 *
 * **The driver name is written on its own statement, outside the arbitration
 * transaction that has already committed.** It is a single-row update against
 * a row nobody else can address — the tab belongs to one lease, and this runs
 * only for the caller holding that lease's key.
 */
async function pageFor(
  scope: ArbitrationScope,
  session: BrowserSession,
  tab: ResolvedTab,
  input: TabOperationInput,
  claimId: string,
): Promise<TabHandle> {
  if (tab.driverTabId !== null) {
    return { browser: tab.browserId, driverTabId: tab.driverTabId };
  }

  const opened = await session.openTab();
  recordTabOpened(scope.db, tab.tabId, opened.driverTabId);

  // ── The seed, here and nowhere else (§3.2, row #65) ───────────────────
  //
  // **This is the only moment that satisfies "before the tab's first
  // navigation".** The page has just been created and no caller has
  // addressed it yet — the verb that triggered this open has not run its own
  // work, because `pageFor` is awaited first. A seed written any later would
  // be written after the load it exists to precede, which is the whole
  // feature; a seed written any earlier has no page to write into.
  //
  // It is also correctly outside the arbitration transaction: this runs
  // inside an after-commit closure (§2.4b), which is why `openTab` above is
  // allowed to be here at all.
  await applyPendingSeed(scope, session, opened, tab, input, claimId);
  return opened;
}

/**
 * Write a granted lease's seed into its brand-new page, and record what was
 * actually written.
 *
 * ── Why the ledger row is written here rather than at claim time ────────
 *
 * The claim appends a `storage_seeded` row saying a seed was **requested**,
 * which is the whole of what is true at that point: the claim is decided
 * inside the arbitration transaction, and §2.4b keeps browser work outside
 * it, so the tab is a row with no page behind it. This row says what was
 * **applied**, and the distinction is the point: §3.2 wants *"which leases
 * started life already holding a credential"* answerable, and a request is
 * not an answer to that. A ledger that recorded the ask and not the act
 * overstates, and a security question answered by an overstatement is read as
 * an all-clear.
 *
 * **Origins and keys, never values**, through `seedRecord` — the same
 * structural redaction the claim's row uses, so neither call site can leak a
 * value by being written carelessly.
 *
 * ── A seed that fails is a seed that is not recorded ────────────────────
 *
 * The throw propagates. It is not caught here, and that is deliberate: the
 * caller is `pageFor`, inside the after-commit closure `afterCommitWork`
 * built, whose `catch` records the reason and rethrows for the runner to
 * swallow (§2.4b). So a browser that refuses the write leaves the lease real,
 * the decision committed, `pageDriven: false`, a reason the caller can read —
 * **and no `applied` row**, because the row is written after the write
 * returns. A caller told its page was not driven has been told its seed did
 * not land.
 */
async function applyPendingSeed(
  scope: ArbitrationScope,
  session: BrowserSession,
  page: TabHandle,
  tab: ResolvedTab,
  input: TabOperationInput,
  claimId: string,
): Promise<void> {
  const entries = input.pendingSeeds?.take(claimId) ?? [];
  if (entries.length === 0) {
    return;
  }

  // **The driver seam, with the entries as data.** `seedStorage` takes a list
  // of origin/area/key/string — there is no position in that signature in
  // which a caller's bytes could be read as a program, which is the entire
  // safety argument for this feature. Nothing here builds an init script, a
  // template or any other source text out of an entry, and doing so would
  // rebuild the interpreting position §3.2 exists to avoid.
  await session.seedStorage(page, entries);

  append(scope.db, {
    kind: 'storage_seeded',
    outcome: 'allow',
    adapter: scope.adapter,
    claimId,
    tabId: tab.tabId,
    browserId: tab.browserId,
    detail: { entries: seedRecord(entries), seed: 'applied' },
  });
}

/**
 * What a scheduled piece of browser work reports about itself.
 *
 * `pageDriven` is a **getter, not a boolean**, and that is the whole of this
 * type's reason to exist — see {@link afterCommitWork}.
 */
interface ScheduledWork {
  readonly afterCommit: readonly (() => Promise<void>)[];
  /** Whether a browser was genuinely reached. Read **after** the work ran. */
  readonly pageDriven: boolean;
  /**
   * Why it was not, when it was not. A getter for the same reason
   * `pageDriven` is one, and `undefined` whenever the work succeeded — so
   * the field is never a stale explanation attached to a call that worked.
   */
  readonly notDrivenReason: string | undefined;
}

/**
 * Schedule one piece of browser work, if the caller brought a browser.
 *
 * **Returns the fact alongside the work, because this is the only place that
 * knows it.** Handing `pageDriven` back next to `afterCommit` means the report
 * and the reality are computed once, from the same place, and no handler can
 * spell the answer differently from the work it scheduled.
 *
 * ── Why this is a getter and not a plain boolean ────────────────────────
 *
 * It used to answer `input.session === undefined`, which was exactly right
 * while nothing ever supplied a session: with no session there is no browser,
 * and `false` was a fact at the moment it was computed.
 *
 * **The moment a session is supplied, that same expression becomes a
 * prediction rather than a fact** — and predicting `true` before the browser
 * has been touched reintroduces the precise defect this field was added to
 * remove, only harder to see. Every failure in after-commit work is swallowed
 * by design (§2.4b), so a browser that is not installed, refuses to launch,
 * loses the launch race, or dies mid-operation produces **no error anywhere a
 * caller can see it**. A caller would be told `accepted` with `pageDriven:
 * true` for a navigation that never happened. That is the same lie as the
 * capture that wrote no row, told with more confidence.
 *
 * So the answer is not settled until the work has either run or failed. The
 * runner awaits every after-commit action **before** the value is returned
 * (`store/transaction.ts`), so by the time any caller can read this field the
 * work is over — and the field reads a flag the work itself set.
 *
 * **Report and reality are still one expression**, which was the property
 * worth keeping: `driven` is written in exactly one place, the last statement
 * of the closure that does the driving. It cannot be set by a handler, it
 * cannot be set on a path that skipped the work, and it cannot be set by the
 * failure path, because the throw happens first.
 *
 * ── Every failure is still swallowed, and now it is also reported ───────
 *
 * The swallowing is unchanged and required: the transaction has committed, the
 * decision stands, capacity was taken, and a driver that will not answer
 * cannot be allowed to unmake it. What the swallowing does not do is tell the
 * caller the page moved. It gets `accepted` — because the arbitration half
 * genuinely happened and is genuinely durable — carrying `pageDriven: false`,
 * which is the honest description of *your lease is real and your page is
 * not*. What it costs is visible in the store rather than hidden: a tab whose
 * page could not be opened keeps its `opening` row and no driver name.
 */
function afterCommitWork(
  scope: ArbitrationScope,
  input: TabOperationInput,
  tab: ResolvedTab,
  work: (session: BrowserSession, page: TabHandle) => Promise<unknown>,
  claimId: string,
): ScheduledWork {
  const source = input.session;
  if (source === undefined) {
    return {
      afterCommit: [],
      pageDriven: false,
      notDrivenReason:
        'This build has no browser to drive: the call was decided, recorded and its lease renewed, but no page was touched.',
    };
  }

  // The one mutable cell, written by the one statement below and read by the
  // getter. Not exposed: a handler receives the getter and never this.
  let driven = false;

  // ── Why the failure's reason is kept, and not only the fact of it ───────
  //
  // `pageDriven: false` is honest and it is **not actionable**: it says the
  // page did not move and says nothing about whether the caller can do
  // anything about that. The causes want opposite responses — a browser that
  // will not launch is not the caller's to fix, while a stale element
  // reference is fixed by reading the page again, which is a thing a caller
  // can do unattended and immediately.
  //
  // The failure is still swallowed (§2.4b) and the outcome is still
  // `accepted`, both for the reasons above; what changes is that the reason
  // travels with the report instead of dying in the runner's empty `catch`.
  // A refusal's `rule` is carried when there is one, because that is the
  // half a caller can branch on without matching on English.
  let notDrivenReason: string | undefined;

  return {
    afterCommit: [
      async () => {
        try {
          const session = await source(tab.browserId);
          await work(session, await pageFor(scope, session, tab, input, claimId));
          // **Last, deliberately.** Anything above this that throws leaves the
          // flag false, which is what makes a browser failing mid-operation
          // report as the page not having been driven rather than as success.
          driven = true;
        } catch (error) {
          // Recorded, then **rethrown unchanged**. The runner's swallow is
          // what keeps a committed decision from being unmade by a browser
          // that will not answer, and catching here without rethrowing would
          // quietly take that path over — including for the callers of this
          // helper that are not about references at all.
          notDrivenReason =
            error instanceof BrokerError
              ? `${error.rule}: ${error.message}`
              : error instanceof Error
                ? error.message
                : String(error);
          throw error;
        }
      },
    ],
    get pageDriven() {
      return driven;
    },
    get notDrivenReason() {
      return notDrivenReason;
    },
  };
}

/**
 * Attach the scheduled work's live answer to a result that carries everything
 * else.
 *
 * ── Why a helper and not `pageDriven: work.pageDriven` at each site ─────
 *
 * That spelling **reads the getter immediately** and copies the boolean into
 * the object, which puts the answer back where it was: decided before the
 * browser was touched. The bug would be invisible — the property is there, it
 * is the right name, it holds a value from the right place — and it would
 * report `true` for every failed navigation.
 *
 * Composing the getter through instead means the six results share one
 * definition of the field, so it cannot hold on five verbs and be a stale copy
 * on the sixth. That is the same reason {@link TabOperationResult} declares it
 * on the shared base rather than on each verb.
 */
function withPageDriven<T>(
  value: T,
  work: ScheduledWork,
): T & { readonly pageDriven: boolean; readonly notDrivenReason: string | undefined } {
  const withFlag = Object.defineProperty(value as T & { pageDriven: boolean }, 'pageDriven', {
    get: () => work.pageDriven,
    enumerable: true,
  });

  // Composed through the same way and for the same reason: read eagerly it
  // would always be `undefined`, because nothing has run yet.
  return Object.defineProperty(
    withFlag as T & { pageDriven: boolean; notDrivenReason: string | undefined },
    'notDrivenReason',
    {
      get: () => work.notDrivenReason,
      enumerable: true,
    },
  );
}

export interface NavigateInput extends TabOperationInput {
  readonly url: unknown;
}

export interface NavigateResult extends TabOperationResult {
  /** The address that was accepted, after validation. */
  readonly url: string;
}

/**
 * `navigate` (§3.5) — point an owned tab at an address.
 *
 * The address is checked against the scheme allowlist before anything is
 * written, so a refused scheme leaves no trace but the refusal row.
 */
export function decideNavigate(
  scope: ArbitrationScope,
  input: NavigateInput,
): ArbitrationOutcome<NavigateResult> {
  const url = validateNavigationTarget(input.url);
  const { lease, tab, expiresAt } = admit(scope, input, 'navigate');

  append(scope.db, {
    kind: 'navigate',
    outcome: 'allow',
    adapter: scope.adapter,
    claimId: lease.claimId,
    tabId: tab.tabId,
    sessionId: lease.sessionId,
    browserId: tab.browserId,
    detail: { url },
  });

  const work = afterCommitWork(
    scope,
    input,
    tab,
    (session, page) => session.navigate(page, url),
    lease.claimId,
  );
  return {
    value: withPageDriven({ claimId: lease.claimId, tabId: tab.tabId, expiresAt, url }, work),
    afterCommit: work.afterCommit,
  };
}

export interface ActInput extends TabOperationInput {
  readonly request: unknown;
}

export interface ActResult extends TabOperationResult {
  /** Which action was accepted, for a caller that sent it loosely typed. */
  readonly action: ActionRequest['action'];
}

/**
 * `act` (§3.6) — one interaction against an owned tab.
 *
 * The argument shape is turned from `unknown` into the driver's discriminated
 * union by `validateAction`, which is the boundary the driver seam asks for:
 * no cast, and thirteen actions each with their own required fields.
 */
export function decideAct(scope: ArbitrationScope, input: ActInput): ArbitrationOutcome<ActResult> {
  const request = validateAction(input.request);
  const { lease, tab, expiresAt } = admit(scope, input, 'act');

  append(scope.db, {
    kind: 'act',
    outcome: 'allow',
    adapter: scope.adapter,
    claimId: lease.claimId,
    tabId: tab.tabId,
    sessionId: lease.sessionId,
    browserId: tab.browserId,
    detail: { action: request.action },
  });

  const work = afterCommitWork(
    scope,
    input,
    tab,
    (session, page) => session.act(page, request),
    lease.claimId,
  );
  return {
    value: withPageDriven(
      { claimId: lease.claimId, tabId: tab.tabId, expiresAt, action: request.action },
      work,
    ),
    afterCommit: work.afterCommit,
  };
}

export interface ReadInput extends TabOperationInput {
  readonly artifacts?: unknown;
}

export interface ReadResult extends TabOperationResult {
  /**
   * What will be collected, in the seam's declared order.
   *
   * **`snapshot` is always in it**, whatever was asked for — the resolver
   * adds it, because a read whose result cannot be tied back to a page state
   * is a read nobody can act on.
   */
  readonly artifacts: readonly ReadArtifact[];
  /**
   * Where each one was written, once the work has run.
   *
   * ── Why naming the artefact was not enough ──────────────────────────────
   *
   * Naming the artefact is not enough on its own. The driver's `read` returns
   * an {@link ArtifactResult} per artefact, carrying a path, and a handler that
   * reports only the names tells a caller *what* was collected and never
   * *where* — while `capture` next door returns
   * `"path": "claims/<id>/images/…"`. The natural inference from that, "the
   * same place as my captures", is wrong: reads land in a sibling directory
   * keyed by page and timestamp rather than under the claim.
   *
   * The cost was not merely a detour. `act` refuses a CSS selector and tells
   * the caller to use a reference from a snapshot — correctly, and with a good
   * message — so a caller who cannot find the snapshot cannot click anything.
   * A field session concluded the read had silently failed, and only found the
   * files by looking around the artefact root.
   *
   * **Absent when the page was not driven**, which is the discipline
   * {@link CaptureResult.capture} and {@link EvaluateResult.result} both keep:
   * a caller that reached no page should find no field rather than an empty
   * list it has to tell apart from a read that genuinely collected nothing.
   * `pageDriven` is the field that says which happened.
   */
  readonly collected?: readonly CollectedArtifact[];
}

/**
 * One artefact a read wrote, and where.
 *
 * A narrowing of the seam's own {@link ArtifactResult}: `truncated` is not
 * carried, because nothing in this service truncates yet and reporting a
 * constant `false` to every caller would be inventing a policy the row that
 * owns it has not argued for.
 */
export interface CollectedArtifact {
  readonly artifact: ReadArtifact;
  /** Where the file is, as a caller can open it. */
  readonly path: string;
  readonly bytes: number;
}

/**
 * `read` (§3.7) — collect artifacts from an owned tab.
 */
export function decideRead(
  scope: ArbitrationScope,
  input: ReadInput,
): ArbitrationOutcome<ReadResult> {
  const artifacts = resolveReadArtifacts(input.artifacts);
  const { lease, tab, expiresAt } = admit(scope, input, 'read');

  append(scope.db, {
    kind: 'read',
    outcome: 'allow',
    adapter: scope.adapter,
    claimId: lease.claimId,
    tabId: tab.tabId,
    sessionId: lease.sessionId,
    browserId: tab.browserId,
    detail: { artifacts: [...artifacts] },
  });

  // Set inside the after-commit closure and read by the getter below — the
  // same arrangement `decideCapture` uses for `written`, and for the same
  // reason: the paths do not exist until the work has run, so a value read
  // eagerly here would always be empty.
  let collected: readonly CollectedArtifact[] | undefined;

  const work = afterCommitWork(
    scope,
    input,
    tab,
    async (session, page) => {
      const results = await session.read(page, artifacts);
      // **The return value is what carries the paths.** The driver knows them;
      // a handler that ignores this leaves the caller unable to open anything
      // it just collected.
      collected = results.map((result) => ({
        artifact: result.artifact,
        path: result.path,
        bytes: result.bytes,
      }));
    },
    lease.claimId,
  );

  const value = withPageDriven(
    { claimId: lease.claimId, tabId: tab.tabId, expiresAt, artifacts },
    work,
  );

  return {
    // Enumerable, deliberately: both surfaces serialise their result, and a
    // getter that is not enumerable is invisible to `JSON.stringify` — present
    // in process, absent on the wire.
    value: Object.defineProperty(value, 'collected', {
      get: () => collected,
      enumerable: true,
    }),
    afterCommit: work.afterCommit,
  };
}

export interface EvaluateInput extends TabOperationInput {
  readonly expression: unknown;
  /**
   * Where a result too large to return inline is written (§3.10).
   *
   * **Optional for the same reason {@link CaptureInput.artifacts} is**: a
   * caller with no browser has no result to spill, and every guard in this
   * handler is testable without either. A caller that supplies a session and
   * no store can still evaluate — a small result comes back inline, which is
   * the overwhelmingly common case — and only a result past the cap has
   * nowhere to go. That case says so rather than being silently dropped; see
   * {@link decideEvaluate}.
   */
  readonly artifacts?: ArtifactStore;
}

export interface EvaluateResult extends TabOperationResult {
  /** How many bytes the expression itself was, having passed the bound. */
  readonly expressionBytes: number;
  /**
   * What the expression evaluated to, and where it ended up (§3.10 — "returns
   * the value inline when it is small, and a path when it is not").
   *
   * **Absent when the page was not driven**, which is the same discipline
   * {@link CaptureResult.capture} keeps: a caller that reached no page should
   * find no field rather than a `null` it has to tell apart from an
   * expression that genuinely evaluated to one. `pageDriven` is the field
   * that says which happened.
   */
  readonly result?: EvaluationOutcome;
}

/**
 * An evaluation's value, in whichever of the two places §3.10 puts it.
 *
 * **The two are a union rather than two optional fields on one object**, so
 * there is no shape in which both are present and no shape in which neither
 * is. A caller branches on `spilled`, which is the same question the cap
 * asks, rather than on which field happens to be defined.
 */
export type EvaluationOutcome = InlineEvaluation | SpilledEvaluation;

/** Small enough to come back inline. */
export interface InlineEvaluation {
  readonly spilled: false;
  /** The serialised value, as JSON text. */
  readonly value: string;
  readonly bytes: number;
}

/** Past the inline cap, so it went to a file (§3.10). */
export interface SpilledEvaluation {
  readonly spilled: true;
  /** **Relative to the artifact root** (§1.7a), which is the only form stored. */
  readonly path: string;
  readonly bytes: number;
}

/**
 * `evaluate` (§3.9) — run an expression in an owned tab.
 *
 * The expression is bounded and otherwise uninspected: there is no allowlist
 * and no filtering, which `pages.ts` states as a deliberate position rather
 * than an omission. **This handler adds no target, context, world or scope
 * argument to that path**, which that file's comment names as the specific
 * way the capability it declined would arrive back by accident.
 */
export function decideEvaluate(
  scope: ArbitrationScope,
  input: EvaluateInput,
): ArbitrationOutcome<EvaluateResult> {
  const expression = validateExpression(input.expression);
  const { lease, tab, expiresAt } = admit(scope, input, 'evaluate');

  const expressionBytes = Buffer.byteLength(expression, 'utf8');
  append(scope.db, {
    kind: 'evaluate',
    outcome: 'allow',
    adapter: scope.adapter,
    claimId: lease.claimId,
    tabId: tab.tabId,
    sessionId: lease.sessionId,
    browserId: tab.browserId,
    // The expression itself is not recorded. It is caller code, it can be
    // four kilobytes of it, and the ledger is read by people.
    detail: { expressionBytes },
  });

  // Set inside the after-commit closure and read by the getter below — the
  // arrangement `decideCapture` uses for `written`, and for the same reason:
  // the value does not exist until the work has run, so a copy taken here
  // would always be absent. **This is row #24's missing half.** The
  // evaluation already happened in after-commit, correctly (§2.4b); what was
  // absent was any path by which its value reached the caller.
  let evaluated: EvaluationOutcome | undefined;
  const artifacts = input.artifacts;

  const work = afterCommitWork(
    scope,
    input,
    tab,
    async (session, page) => {
      const result = await session.evaluate(page, expression);
      // The spill decision is made against the result the page actually
      // produced, which is only knowable here. `disposeEvaluationResult` is
      // what decides it, and it is the same function the seam's own tests
      // measure.
      const disposition = disposeEvaluationResult(result.value);

      if (!disposition.spill) {
        evaluated = { spilled: false, value: disposition.serialised, bytes: disposition.bytes };
        return;
      }

      // ── Past the cap, and nowhere to put it ──────────────────────────────
      //
      // **Thrown rather than returned**, for the reason `decideCapture` gives
      // where it is handed a browser and no store: running to completion here
      // would report `pageDriven: true` for a call whose value the caller
      // cannot reach, in either place §3.10 says it may be. Throwing takes the
      // ordinary after-commit failure path — swallowed by the runner, ledger
      // row and decision still committed — so the caller is told plainly, and
      // `notDrivenReason` carries which of the two it was.
      if (artifacts === undefined) {
        throw new BrokerError(
          'evaluate.result_serialisable',
          `That expression produced ${String(disposition.bytes)} bytes, past the ${String(MAX_INLINE_RESULT_BYTES)}-byte inline limit, and this call supplied no artifact store to spill it into. Nothing was returned.`,
        );
      }

      // The same store, the same refusal and the same relative-path form every
      // other artefact uses (§1.7a). Written through `ArtifactStore.write` and
      // not `writeFileSync`, because that method is the single implementation
      // that refuses a name resolving outside the root.
      const stored = artifacts.write(
        lease.claimId,
        'snapshots',
        evaluationFileName(new Date(), lease.claimId),
        Buffer.from(disposition.serialised, 'utf8'),
      );
      evaluated = { spilled: true, path: stored.relativePath, bytes: disposition.bytes };
    },
    lease.claimId,
  );

  return {
    value: withPageDriven(
      {
        claimId: lease.claimId,
        tabId: tab.tabId,
        expiresAt,
        expressionBytes,
        // A getter for the same reason `pageDriven` is one — see
        // {@link withPageDriven}. Read eagerly it would always be absent.
        get result() {
          return evaluated;
        },
      },
      work,
    ),
    afterCommit: work.afterCommit,
  };
}

/**
 * What a spilled evaluation is called on disk.
 *
 * Every part is derived rather than supplied: an instant and the claim, both
 * of which this service generates. **Nothing a caller sent reaches the name**
 * — not the expression, not the value — which is `names.ts`'s rule one
 * (a file name travels further than a column does) applied to the one
 * artefact whose contents are entirely the caller's.
 *
 * `.json` because the contents are exactly what `JSON.stringify` produced,
 * and a reader opening the file should be able to tell.
 */
function evaluationFileName(when: Date, claimId: string): string {
  return `evaluation-${stampFromInstant(when)}-${sanitiseLabel(claimId)}.json`;
}

export interface CaptureInput extends TabOperationInput {
  readonly fullPage?: boolean;
  readonly selector?: string;
  /**
   * Where the image is written, supplied by the caller that owns one.
   *
   * **Optional for the same reason {@link TabOperationInput.session} is**: a
   * caller with no browser has no picture to store, and every guard in this
   * handler is testable without either. Supplying a session without this one
   * takes the picture and cannot keep it, so the handler treats the pair as a
   * pair — see {@link decideCapture}.
   */
  readonly artifacts?: ArtifactStore;
  /**
   * An earlier capture to diff against — `compare_to` on the tool surface and
   * `--compare-to` on the command line (§3.11).
   *
   * **Optional, and its absence is the ordinary case.** §3.11 makes the diff
   * *an argument on a capture* rather than an operation of its own, which is
   * the property that decides every branch downstream: a capture that cannot
   * find what it was told to compare against still took the picture, so it
   * returns the picture with a sentence rather than a refusal.
   *
   * Nothing in the capture pipeline sees this field. It is read here, in the
   * service operation, after `takeCapture` has already returned — which is
   * what keeps `capture.no_diff_dependency` (§7.3) true: the closure the
   * check walks starts at `src/capture/pipeline.ts`, and the pipeline neither
   * receives this argument nor knows a comparison exists.
   */
  readonly compareTo?: string;
  /**
   * The five numbers that decide a diff's output (§6.2).
   *
   * Supplied by the caller that read the environment once, rather than read
   * here, for the reason §6.3 gives: one snapshot per process, so every rule
   * inside one operation sees one configuration. Defaulted rather than
   * required so that every existing caller and every test that never diffs is
   * unaffected by the field existing.
   */
  readonly diffSettings?: DiffSettings;
}

export interface CaptureResult extends TabOperationResult {
  readonly fullPage: boolean;
  /**
   * What was written, **relative to the artifact root** (§1.7a), and absent
   * when nothing was.
   *
   * Absent rather than empty on the no-browser path: a caller that got no
   * picture should find no field, not a path to a file that is not there.
   */
  readonly capture?: {
    readonly captureId: string;
    readonly path: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
  };
  /**
   * What the diff produced, present only when `compareTo` was supplied.
   *
   * **Absent when no diff was asked for, and present-but-`diffed: false` when
   * one was asked for and could not run.** Those are different facts and
   * collapsing them would make "you did not ask" and "you asked and it could
   * not find the target" the same answer — the confusion §1.9 spends a
   * section preventing, and the reason the field is optional rather than
   * always carrying a null-ish result.
   *
   * It carries `comparedAgainst` echoed back and `truncated` when the region
   * cap bit, both of which §1.9 requires the caller be told rather than left
   * to assume.
   */
  readonly comparison?: ComparisonResult;
}

/**
 * `capture` (§3.10) — take an image of an owned tab.
 *
 * **`fullPage` defaults to false rather than being required**, which is the
 * one reading this handler had to choose: `CaptureRequest` makes the field
 * mandatory on the seam, and no validator for it exists anywhere in
 * `pages.ts`. A viewport capture is the cheaper and more common of the two
 * and is what a caller who did not think about it almost certainly wants, so
 * that is the default. The choice is recorded in the ledger either way, so a
 * caller surprised by it can see what was actually taken.
 */
export function decideCapture(
  scope: ArbitrationScope,
  input: CaptureInput,
): ArbitrationOutcome<CaptureResult> {
  const fullPage = input.fullPage === true;
  // **Before `admit`, like every other argument validation in this file.** A
  // capture that contradicts itself is refused before the lease is resolved,
  // before ownership is checked and before a single row is written, so the
  // refusal leaves nothing behind but its own ledger entry.
  validateCaptureMode({ fullPage, selector: input.selector });
  const request: CaptureRequest = {
    fullPage,
    ...(input.selector === undefined ? {} : { selector: input.selector }),
  };
  const { lease, tab, expiresAt } = admit(scope, input, 'capture');

  append(scope.db, {
    kind: 'capture',
    outcome: 'allow',
    adapter: scope.adapter,
    claimId: lease.claimId,
    tabId: tab.tabId,
    sessionId: lease.sessionId,
    browserId: tab.browserId,
    detail: { fullPage },
  });

  // Read inside the transaction, where every other read this handler makes
  // happens. It decides the accounting warning only — never a refusal — so
  // reading it here rather than in the closure costs nothing but keeps the
  // store access on the transaction's side of §2.4b.
  const takenBefore = input.artifacts === undefined ? 0 : capturesTakenBy(scope.db, lease.claimId);

  let written: CaptureResult['capture'];
  // Set inside the after-commit closure, read by the getter below — the same
  // arrangement `written` uses and for the same reason: neither value exists
  // until the work has run.
  let compared: ComparisonResult | undefined;
  const artifacts = input.artifacts;
  const compareTo = input.compareTo;

  const work = afterCommitWork(
    scope,
    input,
    tab,
    async (session, page) => {
      if (artifacts === undefined) {
        // A browser but nowhere to put the picture. Taking one and dropping it
        // is precisely the behaviour this handler exists to stop, so the shutter
        // is not pressed at all.
        //
        // **Thrown rather than returned**, and the difference is the honesty of
        // the answer. Returning would leave the closure to run to completion and
        // report `pageDriven: true` — for a call that reached no page, wrote no
        // file and left `captures` empty, which is the precise combination this
        // field exists to make impossible. Throwing takes the same path a
        // browser failure takes: swallowed by the runner (§2.4b), the decision
        // and its ledger row still committed, and the caller told plainly that
        // nothing was driven.
        throw new BrokerError(
          'capture.arguments_consistent',
          'A capture needs somewhere to write the image, and this call supplied a browser without one. No picture was taken.',
        );
      }

      // **The pipeline, not `session.capture` directly.** Reaching the seam here
      // was the defect: it skipped the settle, the downscale to the requested
      // rung, and the write through the artifact store — the only thing that
      // decides where a file may go — and then discarded the bytes. Everything
      // the `captures` row needs comes back as telemetry.
      const taken = await takeCapture(
        { tabs: session, artifacts },
        lease.claimId,
        page,
        {
          fullPage,
          ...(request.selector === undefined ? {} : { selector: request.selector }),
        },
        takenBefore,
      );

      // The row last, describing a file that is already on disk. See
      // `capture-store.ts` for why that order is the rule and not a preference.
      recordCapture(scope.db, lease.claimId, tab.tabId, taken.telemetry);

      written = {
        captureId: taken.captureId,
        path: taken.path,
        width: taken.width,
        height: taken.height,
        bytes: taken.bytes,
      };

      // ── The diff, when one was asked for (§3.11, §1.9) ──────────────────
      //
      // **Here, and not one line earlier.** Three separate rules put it at this
      // exact point and they agree:
      //
      // 1. §2.4b — never browser I/O inside the arbitration transaction. This
      //    whole closure is after-commit, so the shutter above already obeyed
      //    that. The comparison itself is arithmetic over two decoded images
      //    and some file writes: no browser, no seam method, nothing that could
      //    reintroduce the thing that rule forbids.
      // 2. §1.7 order — the `captures` row is written above, *before* this
      //    runs, because the comparison names that capture as its source and a
      //    row referencing one that does not exist yet is a foreign key waiting
      //    to fail.
      // 3. `capture.no_diff_dependency` (§7.3) — the direction still runs one
      //    way. This module reads the diff feature; the diff feature does not
      //    read this. `takeCapture` was handed no comparison argument and
      //    returned before any of this was considered, so the pipeline remains
      //    a module that could be built with the diff feature deleted.
      //
      // **Nothing here can fail the capture.** `runComparison` throws only on a
      // programming mistake and returns an explanation for every caller-caused
      // failure, so a diff that cannot run leaves `written` exactly as it is
      // above and the caller still gets its picture — which is §3.11's rule that
      // an optional argument may not withhold the thing it is optional on.
      if (compareTo !== undefined) {
        const source = captureSource(scope.db, artifacts);
        const justTaken = {
          id: taken.captureId,
          claimId: lease.claimId,
          path: taken.path,
          kind: taken.telemetry.kind,
          width: taken.width,
          height: taken.height,
        };
        compared = await runComparison({
          capture: justTaken,
          // **Read back through the seam rather than kept from the pipeline.**
          // `takeCapture` returns `bytes` as a *file size*, not the image, and
          // deliberately so — §3.11 is emphatic that a capture result carries
          // "a path, the dimensions … **Never the image**", and `CaptureResult`
          // has no field that could hold pixels. So the bytes are read from the
          // file just written, through `ArtifactStore.resolve` — the single
          // implementation that refuses a path escaping the root in either
          // namespace. Reading the file directly would have meant a second
          // resolver, and the second one is the one missing a case.
          captureBytes: await source.readBytes(justTaken),
          targetCaptureId: compareTo,
          source,
          settings: input.diffSettings ?? DEFAULT_DIFF_SETTINGS,
          artifacts,
          // The row is written through the same handle every other write in
          // this closure uses, so a comparison and the capture it describes
          // cannot end up in different states of the store.
          writeRow: (row) => insertComparison(scope.db, row),
        });
      }
    },
    lease.claimId,
  );

  return {
    value: withPageDriven(
      {
        claimId: lease.claimId,
        tabId: tab.tabId,
        expiresAt,
        fullPage,
        // A getter for the same reason `pageDriven` is one: the value is not
        // known until the after-commit work has run, and a copy taken here
        // would always be absent.
        get capture() {
          return written;
        },
        // A getter for the same reason `capture` is one. Stays `undefined`
        // when no diff was asked for, which is what distinguishes "you did
        // not ask" from a comparison that ran and found nothing.
        get comparison() {
          return compared;
        },
      },
      work,
    ),
    afterCommit: work.afterCommit,
  };
}

export interface TabReplaceInput {
  readonly key: string;
  readonly tabId: string;
  readonly session?: SessionSource;
}

export interface TabReplaceResult {
  readonly claimId: string;
  /** The tab that was given up. */
  readonly previousTabId: string;
  /** The tab that replaced it, reserved by this call. */
  readonly tabId: string;
  readonly expiresAt: string;
  /**
   * Whether a browser was reached, with the same meaning as
   * {@link TabOperationResult.pageDriven} and declared separately only
   * because this result does not extend that base.
   *
   * **It matters more here than anywhere else**, which is why it is repeated
   * rather than left off as an exception. The other five verbs leave nothing
   * behind when no session is supplied; this one exchanges the tab in the
   * store regardless. With no browser the surrendered page is never closed
   * and the replacement is never opened, so the lease comes back holding a
   * fresh tab identifier whose row is still `opening` with no page under it. A caller
   * told only that the swap succeeded would believe it now had a clean page.
   */
  readonly pageDriven: boolean;
}

/**
 * `tab_replace` (§3.11) — give up this lease's tab and take a fresh one.
 *
 * ── Why this is one operation and not a release followed by a claim ─────
 *
 * A lease is one tab (§2.3), so a caller wanting a clean page has to give up
 * the one it has. Doing that as two calls means dropping to zero tabs in
 * between — at which point the capacity it just freed is fair game for
 * whoever is at the front of the queue, and a caller tidying up its own page
 * can lose its lease for doing so. Inside one transaction the count never
 * dips, and nothing can be promoted into the gap because there is no gap.
 *
 * Closing the tab being given up is after-commit work, like every other
 * close: the row goes to `closing` inside the transaction, which is §1.4's
 * honest representation of *the tool was asked and has not answered*, and a
 * tab that does not close is a leaked tab rather than a leaked lease.
 */
export function decideTabReplace(
  scope: ArbitrationScope,
  input: TabReplaceInput,
): ArbitrationOutcome<TabReplaceResult> {
  const { db, adapter } = scope;
  const { lease, tab, expiresAt } = admit(scope, input, 'tab_closing');
  const browser = tab.browserId;

  // Out first, in second, both inside the one transaction. The order matters
  // only for the ledger reading sensibly; the count never changes, because
  // the reservation is written before the commit that would have let anyone
  // else see the tab go.
  //
  // **Which state the tab goes out through is not this operation's rule to
  // invent**, and writing it here was a real defect the schema caught: a tab
  // still `opening` has no page, and moving one to `closing` asserts an
  // outstanding round trip that nobody is coming to answer — which the
  // `(state = 'opening') = (driver_tab_id IS NULL)` constraint refuses
  // outright. `updateSweptTabs` is the one place that rule is written, it is
  // exported precisely so the sweep and release cannot spell it differently,
  // and this is the third caller that needs exactly it. What comes back is
  // the subset a browser still owes an answer about.
  const pendingCloses = updateSweptTabs(
    db,
    [{ tabId: tab.tabId, claimId: lease.claimId, browserId: browser }],
    scope.swept.sweptAt,
  );
  append(db, {
    kind: 'tab_closing',
    outcome: 'allow',
    adapter,
    claimId: lease.claimId,
    tabId: tab.tabId,
    sessionId: lease.sessionId,
    browserId: tab.browserId,
    detail: { givenUpFor: 'a fresh tab', pageToClose: pendingCloses.length === 1 },
  });

  const replacementId = reserveTab(db, lease.claimId, browser);
  append(db, {
    kind: 'tab_opening',
    outcome: 'allow',
    adapter,
    claimId: lease.claimId,
    tabId: replacementId,
    sessionId: lease.sessionId,
    browserId: tab.browserId,
    detail: { takenOverFrom: tab.tabId },
  });

  const source = input.session;

  // **The same live answer the other five verbs give, not a second spelling of
  // it.** This handler cannot use `afterCommitWork` — its work closes one page
  // and opens another rather than driving one, so it does not take that
  // helper's shape — and the previous arrangement answered `source !==
  // undefined` here instead. That was a *second* computation of a field whose
  // whole value is that it is computed once: correct while nothing supplied a
  // session, and a prediction the moment something did.
  //
  // It matters more here than anywhere else, for the reason
  // {@link TabReplaceResult.pageDriven} gives: this verb exchanges the tab in
  // the store regardless, so a caller told the swap succeeded believes it holds
  // a clean page. If the browser could not be reached, it holds a fresh
  // identifier over a row that is still `opening` with nothing under it.
  //
  // So the flag is declared here and written by the closure below, and the
  // field is composed by {@link withPageDriven} — the same function the other
  // five go through, which is what stops the two answers drifting.
  let driven = false;
  // Carried for the same reason and by the same rule as in
  // {@link afterCommitWork}: the fact that the swap did not reach a browser is
  // not actionable on its own. This verb addresses no element, so the stale
  // reference case cannot arise here — what it reports is a browser that could
  // not be reached or a page that would not open.
  let notDrivenReason: string | undefined =
    source === undefined
      ? 'This build has no browser to drive: the tab was exchanged in the store, but no page was opened for it.'
      : undefined;
  const work: ScheduledWork = {
    get pageDriven() {
      return driven;
    },
    get notDrivenReason() {
      return notDrivenReason;
    },
    afterCommit:
      source === undefined
        ? []
        : [
            async () => {
              try {
                const session = await source(browser);
                // The tab being given up is closed first, and only if a page
                // was ever opened for it. If it will not close it is a leaked
                // tab; the fresh one is owed either way, and making it wait on
                // a page that is refusing to die is how one stuck close turns
                // into a lease with no tab at all.
                // At most one, and empty when no page was ever opened for this
                // tab — in which case there is nothing to ask a browser about
                // and the row is already `closed`.
                if (pendingCloses.length > 0 && tab.driverTabId !== null) {
                  try {
                    await session.closeTab({ browser, driverTabId: tab.driverTabId });
                  } catch {
                    // Best effort (§2.4b). The row stays `closing`, which is
                    // what the administrative clear-a-leaked-tab operation
                    // selects on.
                  }
                }
                const opened = await session.openTab();
                // Recorded on its own connection-free path: this runs after the
                // commit, so it opens its own short write rather than
                // reaching back into a transaction that is gone.
                recordTabOpened(scope.db, replacementId, opened.driverTabId);
                // Last, for the same reason it is last in `afterCommitWork`: a
                // throw above leaves this false, so a browser that failed
                // partway through reports the page as not driven.
                driven = true;
              } catch (error) {
                // Recorded and rethrown unchanged, so the runner's swallow
                // (§2.4b) still governs what a failure costs.
                notDrivenReason =
                  error instanceof BrokerError
                    ? `${error.rule}: ${error.message}`
                    : error instanceof Error
                      ? error.message
                      : String(error);
                throw error;
              }
            },
          ],
  };

  return {
    value: withPageDriven(
      {
        claimId: lease.claimId,
        previousTabId: tab.tabId,
        tabId: replacementId,
        expiresAt,
      },
      work,
    ),
    afterCommit: work.afterCommit,
  };
}
