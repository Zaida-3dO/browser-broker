import { updateSweptTabs, type ArbitrationOutcome, type ArbitrationScope } from '../arbitration.ts';
import type {
  ActionRequest,
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
  resolveReadArtifacts,
  validateAction,
  validateExpression,
  validateNavigationTarget,
} from '../pages.ts';
import { recordTabOpened, reserveTab } from '../tabs.ts';

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
 */
export type SessionSource = () => BrowserSession | Promise<BrowserSession>;

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
): Promise<TabHandle> {
  if (tab.driverTabId !== null) {
    return { browser: tab.browserId as TabHandle['browser'], driverTabId: tab.driverTabId };
  }

  const opened = await session.openTab();
  recordTabOpened(scope.db, tab.tabId, opened.driverTabId);
  return opened;
}

/**
 * Schedule one piece of browser work, if the caller brought a browser.
 *
 * **Returns the fact alongside the work, because this is the only place that
 * knows it.** `input.session === undefined` is the single expression in the
 * service that distinguishes *a page was driven* from *there was no page*,
 * and it used to answer that question and then throw the answer away, which
 * is exactly how a caller came to be told `accepted` for a capture that wrote
 * no row. Handing back `pageDriven` next to `afterCommit` means the report
 * and the reality are computed once, from the same branch: a build that
 * starts supplying a session reports `true` by construction, and no handler
 * can spell the answer differently from the work it scheduled.
 *
 * **Every failure is swallowed**, matching what the runner already does with
 * the sweep's closes and what §2.4b requires of after-commit work generally:
 * the transaction has committed, the decision stands, and a driver that will
 * not answer cannot be allowed to unmake it. What that costs is visible in
 * the store rather than hidden — a tab whose page could not be opened keeps
 * its `opening` row and no driver name, which is the same thing it said
 * before the attempt.
 */
function afterCommitWork(
  scope: ArbitrationScope,
  input: TabOperationInput,
  tab: ResolvedTab,
  work: (session: BrowserSession, page: TabHandle) => Promise<unknown>,
): {
  readonly afterCommit: readonly (() => Promise<void>)[];
  readonly pageDriven: boolean;
} {
  const source = input.session;
  if (source === undefined) return { afterCommit: [], pageDriven: false };

  return {
    afterCommit: [
      async () => {
        const session = await source();
        await work(session, await pageFor(scope, session, tab));
      },
    ],
    pageDriven: true,
  };
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

  const work = afterCommitWork(scope, input, tab, (session, page) => session.navigate(page, url));
  return {
    value: {
      claimId: lease.claimId,
      tabId: tab.tabId,
      expiresAt,
      url,
      pageDriven: work.pageDriven,
    },
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

  const work = afterCommitWork(scope, input, tab, (session, page) => session.act(page, request));
  return {
    value: {
      claimId: lease.claimId,
      tabId: tab.tabId,
      expiresAt,
      action: request.action,
      pageDriven: work.pageDriven,
    },
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

  const work = afterCommitWork(scope, input, tab, (session, page) => session.read(page, artifacts));
  return {
    value: {
      claimId: lease.claimId,
      tabId: tab.tabId,
      expiresAt,
      artifacts,
      pageDriven: work.pageDriven,
    },
    afterCommit: work.afterCommit,
  };
}

export interface EvaluateInput extends TabOperationInput {
  readonly expression: unknown;
}

export interface EvaluateResult extends TabOperationResult {
  /** How many bytes the expression itself was, having passed the bound. */
  readonly expressionBytes: number;
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

  const work = afterCommitWork(scope, input, tab, async (session, page) => {
    const result = await session.evaluate(page, expression);
    // The spill decision is made against the result the page actually
    // produced, which is only knowable here. `disposeEvaluationResult` is
    // what decides it, and it is the same function the seam's own tests
    // measure — joining the two is row #24's missing half.
    return disposeEvaluationResult(result.value);
  });
  return {
    value: {
      claimId: lease.claimId,
      tabId: tab.tabId,
      expiresAt,
      expressionBytes,
      pageDriven: work.pageDriven,
    },
    afterCommit: work.afterCommit,
  };
}

export interface CaptureInput extends TabOperationInput {
  readonly fullPage?: boolean;
  readonly selector?: string;
}

export interface CaptureResult extends TabOperationResult {
  readonly fullPage: boolean;
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

  const work = afterCommitWork(scope, input, tab, (session, page) =>
    session.capture(page, request),
  );
  return {
    value: {
      claimId: lease.claimId,
      tabId: tab.tabId,
      expiresAt,
      fullPage,
      pageDriven: work.pageDriven,
    },
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
  const browser = tab.browserId as TabHandle['browser'];

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

  return {
    value: {
      claimId: lease.claimId,
      previousTabId: tab.tabId,
      tabId: replacementId,
      expiresAt,
      pageDriven: source !== undefined,
    },
    afterCommit:
      source === undefined
        ? []
        : [
            async () => {
              const session = await source();
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
            },
          ],
  };
}
