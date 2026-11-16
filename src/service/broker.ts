import type { Environment } from '../config/environment.ts';
import { readDiffSettings, type DiffSettings } from '../diff/settings.ts';
import type { StoreHandle } from '../store/open.ts';
import { runArbitration, type CloseOrphanedTab } from './arbitration.ts';
import type { ArtifactStore } from '../artifacts/store.ts';
import { append, type EventAdapter } from './events.ts';
import { createPendingSeeds } from './pending-seeds.ts';
import { commandSecretResolver } from '../secrets/resolver.ts';
import {
  resolveBrowser,
  type ArbitrationSettings,
  type ClaimInput,
  type ClaimResult,
} from './operations/claim.ts';
import { CallRefusal, type RefusalCode } from './refusals.ts';
import { BrokerError, StartupRefusal } from '../errors.ts';
import type { ReleaseInput, ReleaseResult } from './operations/give-back.ts';
import type {
  ActInput,
  ActResult,
  CaptureInput,
  CaptureResult,
  EvaluateInput,
  EvaluateResult,
  NavigateInput,
  NavigateResult,
  ReadInput,
  ReadResult,
  SessionSource,
  TabReplaceInput,
  TabReplaceResult,
} from './operations/pages.ts';
import type {
  BeginSignInInput,
  BeginSignInResult,
  EndSignInInput,
  EndSignInResult,
  FinishSignInInput,
  FinishSignInResult,
  RequestSignInInput,
  RequestSignInResult,
} from './operations/sign-in.ts';
import { readPoolStatus, type PoolStatusResult } from './operations/pool-status.ts';
import type { BrowserLiveness, StatusInput, StatusResult } from './operations/status.ts';
import type { BrowserId } from '../browser/driver.ts';

/**
 * The service surface, which is what every adapter calls and the only thing
 * that decides anything.
 *
 * `CLAUDE.md`: **every adapter is a thin shell over a service call.** No
 * adapter may reach the database or a guard directly — it resolves its input,
 * calls one service operation, and shapes the result for its transport. Every
 * rule that decides whether an operation is allowed lives here, or it holds
 * on one transport and not the others.
 *
 * **Each method is one `runArbitration` call and contains no logic of its
 * own.** That is deliberate to the point of being conspicuous: a method that
 * did anything before or after the runner would be doing it outside the
 * transaction, which is where the read-then-write window §1.0a measures as
 * failing gets reopened.
 *
 * **The one method that does something before the runner is `claim`**, and
 * the sentence keeps its reason by saying so: it probes an attached
 * browser's connection ahead of arbitration, and that refusal's ledger row
 * is appended outside every transaction — see the `claim` implementation and
 * its `ensureAttachedConnection` docstring. The window this contract guards
 * is the *transaction's* read-then-write gap, and the probe does not reopen
 * it: it reads no lease state and writes no lease, and its row belongs to a
 * refusal that is a refusal precisely because it lands **before** the
 * transaction exists (§7.1 `attached.not_connected`: refuse ahead of every
 * row, never queue). The browser touch it asks for is the one thing
 * arbitration itself must never make (§2.4b). `poolStatus` remains the only
 * method that is not a `runArbitration` call at all.
 */
export interface Broker {
  claim: (input: ClaimInput) => Promise<ClaimResult>;
  status: (input: StatusInput) => Promise<StatusResult>;
  /**
   * Where the **pool** stands, for a caller that holds no key (§3.3).
   *
   * **The one method here that is not a `runArbitration` call**, and it has
   * to be: it renews nothing, so there is no lease whose sweep it could be
   * charged to, and sweeping on behalf of a caller that holds nothing would
   * make an unkeyed call do work every other caller waits behind. It reads
   * derived state and returns counts.
   *
   * **It discloses no identity** — see {@link PoolStatusResult}. That is the
   * property that makes an unkeyed answer admissible at all.
   */
  poolStatus: () => Promise<PoolStatusResult>;
  /** **Whatever the lease holds, releasing gives it back** (§2.5, §3.4). */
  release: (input: ReleaseInput) => Promise<ReleaseResult>;

  /**
   * The six tab-addressed operations (§3.5–§3.11).
   *
   * **Each is one `runArbitration` call like the three above**, and carries
   * no settings for the reason `decideStatus` gives: each renews the lease it
   * names, and a renewal extends by the duration already promised rather than
   * by whatever the environment says now.
   */
  navigate: (input: NavigateInput) => Promise<NavigateResult>;
  act: (input: ActInput) => Promise<ActResult>;
  read: (input: ReadInput) => Promise<ReadResult>;
  evaluate: (input: EvaluateInput) => Promise<EvaluateResult>;
  capture: (input: CaptureInput) => Promise<CaptureResult>;
  /** Give up this lease's tab and take a fresh one, in one transaction. */
  tab_replace: (input: TabReplaceInput) => Promise<TabReplaceResult>;

  /**
   * The two halves of a person signing in (SCHEMA.md 5.5.1).
   *
   * **Neither is keyed and neither takes tab budget**, which is what
   * distinguishes them from everything above: a person at a keyboard is not a
   * caller. They are on this interface rather than beside it because the
   * refusal that makes a sign-in safe — no live lease may hold a tab on that
   * browser — is a fact about leases, and every fact about leases is derived
   * inside the arbitration transaction.
   */
  begin_sign_in: (input: BeginSignInInput) => Promise<BeginSignInResult>;
  end_sign_in: (input: EndSignInInput) => Promise<EndSignInResult>;

  /**
   * The two halves of a **caller** asking a person to sign in (§5.5.2).
   *
   * **Both are keyed, which is what separates them from the pair above.**
   * That pair is a person's and holds no lease; this pair is a caller's, and
   * the lease is the whole mechanism: it names the one lease §5.5.1's
   * live-lease refusal must exempt — the requester is holding the very tab
   * the person will sign in on — and it names the one lease entitled to end
   * the request it made.
   *
   * **Neither takes tab budget and neither gives one back.** A requested
   * sign-in is a pause on the browser, not on the lease: the caller keeps its
   * tab throughout and keeps renewing, which is §5.5.1's *"a sign-in is a
   * pause and not a cancellation"* extended to the one caller that asked for
   * it. A caller that lost its work by asking for help would be a caller that
   * never asks again.
   */
  sign_in: (input: RequestSignInInput) => Promise<RequestSignInResult>;
  sign_in_done: (input: FinishSignInInput) => Promise<FinishSignInResult>;
}

export interface BrokerOptions {
  readonly store: StoreHandle;
  readonly environment: Environment;
  /** Which door the call came in through, for the ledger (§1.6). */
  readonly adapter: EventAdapter;
  /**
   * How a tab the service has finished with is actually closed.
   *
   * **Optional, and omitting it leaks tabs rather than leases** (§2.4b) — the
   * documented consequence rather than a gap. A caller with no browser
   * session has nothing to close with, and the capacity came back at commit
   * regardless.
   */
  readonly closeTab?: CloseOrphanedTab;
  /**
   * How a page verb reaches a browser, after the commit.
   *
   * **Optional, and omitting it means no page is driven** — the same
   * documented consequence {@link BrokerOptions.closeTab} carries, and the
   * state every test that has no browser runs in. Supplied here rather than
   * on each call so that a route cannot decide, per operation, whether a
   * browser is reached: which browser a tab lives in is a fact about the
   * tab's row, and the handler resolves it (see `SessionSource`).
   */
  readonly session?: SessionSource;
  /**
   * Where a capture is written.
   *
   * Travels with {@link BrokerOptions.session} because the two are only
   * useful together: a browser with nowhere to put a picture takes one and
   * drops it, which is the behaviour `decideCapture` was fixed to stop.
   */
  readonly artifacts?: ArtifactStore;
  /**
   * The five numbers that decide a diff's output (§6.2).
   *
   * **Optional, and omitting it reads them from the environment**, which is
   * the same one-snapshot-per-process rule the arbitration settings beside it
   * follow (§6.3). Present as an option only so a test can pin the numbers
   * without setting environment variables on the process — the tuning
   * behaviour §1.9 records on every row is otherwise unobservable from a test
   * that cannot vary them.
   */
  readonly diffSettings?: DiffSettings;
  /**
   * Whether the browser behind a lease is actually running, asked **after**
   * the arbitration transaction has committed.
   *
   * ── Why this exists as a seam rather than a call inside the operation ───
   *
   * Measured 2026-09-04: both browsers were dead, and `status` reported every
   * lease against them `active` with the expiry advancing. `operations/
   * status.ts` cannot answer this itself — it runs inside the arbitration
   * transaction, and `arbitration.no_browser_io` (§2.4b) keeps browser work
   * out of there because one unresponsive browser inside it blocks every
   * arbitration call on the machine. A browser that has died is exactly the
   * one most likely to be slow to answer, so making the honest check there
   * would trade a silent outage for a total one.
   *
   * **Optional, and omitting it means `browser: 'unknown'` rather than a
   * cheerful `live`** — the same documented-consequence shape
   * {@link BrokerOptions.session} and {@link BrokerOptions.closeTab} take. A
   * build that cannot look must not claim to have looked; that is the defect
   * this row exists to remove, and reintroducing it here as a default would
   * be the neatest possible way to undo the whole change.
   */
  readonly checkBrowser?: (browser: BrowserId) => Promise<BrowserLiveness>;
}

/**
 * Turn a failed attached open into the §7.1 refusal it is, with the ledger
 * row to match.
 *
 * **Why the row is written here rather than by `recordRefusal`.** The open
 * happens before arbitration opens, so there is no transaction, no scope and
 * no handler to record through — and a refusal with no ledger row is the
 * other half of the defect this gate removes: the caller told "not
 * connected", the operator's `broker events` showing nothing. `append` on
 * the store's own connection is the same call the runner's finally block
 * makes after a rollback, so the row lands exactly as it would have from a
 * handler's `recordRefusal`.
 *
 * **A `StartupRefusal` is rethrown untouched.** A missing extension id is
 * §7.2's kind of problem — this installation should not be offering the
 * attached capability at all — and downgrading it to a per-call refusal
 * would tell the caller to retry a call no retry can fix.
 */
function refuseAttachedClaim(
  options: BrokerOptions,
  sessionId: string,
  browser: string,
  error: unknown,
): never {
  if (error instanceof StartupRefusal) throw error;

  const rule =
    error instanceof BrokerError && error.rule === 'attached.no_binary'
      ? 'attached.no_binary'
      : 'attached.not_connected';
  const code: RefusalCode =
    rule === 'attached.no_binary' ? 'attached_no_binary' : 'attached_not_connected';

  // The same shape the claim handler's own pre-lease refusals take: the
  // `browser_id` column has a foreign key into `browsers`, and this row is
  // deliberately written **before that row exists** — which is the whole
  // point of the gate. The browser the refusal is about travels in
  // `detail`, exactly as `claim.browser_kind_agrees` carries it.
  append(options.store.db, {
    kind: 'claim_requested',
    outcome: 'deny',
    guard: rule,
    adapter: options.adapter,
    sessionId,
    detail: { browser, reason: error instanceof Error ? error.message : String(error) },
  });

  throw new CallRefusal(
    code,
    rule === 'attached.no_binary'
      ? `The attached browser "${browser}" cannot be reached: nothing is configured to open its connect page with, so its extension would never learn the relay's address. Set BROKER_BROWSER_<NAME>_PATH for it, or empty BROKER_ATTACHED_BROWSERS to leave the capability off — retrying changes nothing either way.`
      : `The attached browser "${browser}" is not connected: its extension did not reach the relay, so it cannot be shown the connect page or asked to attach. No lease was taken and no place was queued — waiting would hold capacity against a browser that has promised none. Try again once the extension is connected.`,
    { detail: { browser }, cause: error },
  );
}

/**
 * Bind a service to one store, one environment snapshot and one adapter.
 *
 * The settings are read from the environment **here, once**, and handed to
 * every operation on its input. §6.3: one snapshot per process, so every rule
 * inside one operation sees one configuration — a handler that read the
 * environment itself would be a second snapshot taken at a different instant,
 * inside a transaction other callers are waiting behind.
 */
export function createBroker(options: BrokerOptions): Broker {
  const settings: ArbitrationSettings = {
    tabBudget: options.environment.tabBudget,
    leaseSeconds: options.environment.leaseSeconds,
    queueSeconds: options.environment.queueSeconds,
    regularBrowsers: options.environment.regularBrowsers,
    privateBrowsers: options.environment.privateBrowsers,
    // The attached pair reads straight through: `readEnvironment` has
    // already refused the configurations that cannot work and defaulted the
    // rest, so "off" arrives here as an empty list, which is exactly what
    // the claim rules below read (§13n).
    attachedBrowsers: options.environment.attachedBrowsers,
    attachedTabs: options.environment.attachedTabs,
  };

  // The same one-per-process snapshot the arbitration settings are, taken
  // here for the same reason (§6.3). A bad value refuses the spawn rather
  // than one capture, which is `readDiffSettings`'s own documented split.
  const diffSettings: DiffSettings = options.diffSettings ?? readDiffSettings();

  const run = <Input, Output>(name: string, input: Input): Promise<Output> =>
    runArbitration<Input, Output>({
      store: options.store,
      name,
      adapter: options.adapter,
      input,
      ...(options.closeTab === undefined ? {} : { closeTab: options.closeTab }),
    });

  /**
   * The browser connection, added to the six inputs that can use one.
   *
   * **Added here rather than by each adapter**, which is the same rule the
   * bridge holds itself to: a route shapes arguments and names an operation,
   * and whether a browser is reached is not an argument a caller passes. A
   * surface that could omit it would be a surface on which a page verb
   * silently did nothing, and the two surfaces would differ in what they
   * actually did while agreeing on what they returned — the exact failure
   * §8's parity assertion exists to catch.
   */
  /**
   * Seeds a granted claim asked for, waiting for its tab's first open.
   *
   * **One store per broker, which is one per process** (§1.0 — the service is
   * spawned by its caller and exits with it). The values are credentials and
   * are deliberately never written to the store; `pending-seeds.ts` sets out
   * why, and what a lease granted in one process and driven from another
   * therefore does not get.
   */
  const pendingSeeds = createPendingSeeds();

  /**
   * How a secret's name becomes its value (§3.8a), built once from the
   * environment snapshot — or absent, and secrets are off.
   *
   * Handed to every tab verb, not only `act`: a read, a capture or a
   * navigation of a tab that has received a secret needs the values back to
   * scrub them out of what it returns.
   */
  const secretResolver =
    options.environment.secretResolver === undefined
      ? undefined
      : commandSecretResolver(options.environment.secretResolver);

  const withBrowser = <T>(input: T): T => ({
    ...input,
    ...(secretResolver === undefined ? {} : { secretResolver }),
    ...(options.session === undefined ? {} : { session: options.session }),
    // Handed to every tab verb rather than only to the one that opens the
    // page, because **which verb opens the page is not knowable here**: a
    // lease's first call may be a navigate, a read, a capture or any other,
    // and `pageFor` is what discovers it is the first. Supplying it only to
    // one would make seeding depend on which verb a caller happened to reach
    // for — the same class of defect as a rule holding on one route.
    pendingSeeds,
  });

  /**
   * The browser connection **and** somewhere to write, for the two verbs that
   * produce a file: a capture always, and an evaluation whose result is past
   * the inline cap (§3.10).
   *
   * Added here for the same reason {@link withBrowser} is: which store an
   * artefact lands in is not an argument a caller passes, and a surface that
   * could omit it would be a surface on which a large evaluation silently
   * had nowhere to go.
   */
  const withBrowserAndArtifacts = <T>(input: T): T => ({
    ...withBrowser(input),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    // Read once, above, and handed to every capture — never read inside the
    // handler, for the reason this function's own header gives about the
    // arbitration settings: a second snapshot taken at a different instant
    // would let two rules inside one operation see two configurations.
    diffSettings,
  });

  /**
   * **An attached claim connects before it writes a row** (§7.1
   * `attached.not_connected`, MILESTONES #74's "refuse before any row is
   * written, never queue").
   *
   * A lease granted against an unreachable extension holds shared budget
   * and an attached cap slot, and every page verb on it answers `accepted`
   * with `pageDriven: false` — capacity pinned by a lease that can never
   * do its work, until release or TTL frees it. So the open — connect
   * page, bounded wait — runs **before** arbitration opens: the browser is
   * resolved with the claim's own resolution rule (`resolveBrowser`, the
   * function the handler itself uses, so the two can never disagree about
   * which browser a claim means), and an attached browser first reaches
   * the provider.
   *
   * The provider is the memoised one the page verbs use, so this opens at
   * most one bridge per process, and the later verbs inherit it. The check
   * sits outside every transaction and writes no lease, so a not-connected
   * refusal takes no claim, no queue place, and no cap slot — the counts
   * it refused against stay exactly where they were.
   *
   * **No session source means no check**, the same documented consequence
   * {@link BrokerOptions.closeTab} and {@link BrokerOptions.session}
   * carry: a build that cannot reach a browser also cannot drive the lease,
   * and it must not claim to have checked.
   *
   * **It runs ahead of the claim's own argument and cap refusals, and that
   * ordering is accepted rather than accidental.** A claim arbitration
   * would refuse for a seed on the attached browser, or for the per-browser
   * cap, still reaches the provider first — and with no bridge up yet, that
   * means a connect page pops in the person's window for a claim that was
   * always going to be refused. Reordering the probe behind those refusals
   * would mean re-deciding the seed rule and the cap's live-plus-queued
   * arithmetic **outside** the transaction, in a second place, where they
   * could drift from the arbitration that decides for real. One outward
   * launch on a refused claim is the cheaper of the two mistakes: the
   * refusal keeps its own side-effect discipline (no row, no queue place,
   * no cap slot — the probe consumed none of them), and the provider is
   * memoised, so once the extension is connected the probe launches nothing
   * at all. `tests/operations/claim-attached.test.ts` pins the accepted
   * shape: provider reached, then the ordinary refusal with its rows still
   * absent.
   */
  const ensureAttachedConnection = async (input: ClaimInput): Promise<void> => {
    const source = options.session;
    if (source === undefined) return;
    const browser = resolveBrowser(input.browser, settings);
    if (browser === undefined || !(settings.attachedBrowsers ?? []).includes(browser)) return;
    try {
      await source(browser);
    } catch (error) {
      refuseAttachedClaim(options, input.sessionId, browser, error);
    }
  };

  return {
    claim: async (input) => {
      await ensureAttachedConnection(input);
      const result = await run<ClaimInput & { settings: ArbitrationSettings }, ClaimResult>(
        'claim',
        { ...input, settings },
      );
      // **After the call returns, so only a committed grant holds a seed.**
      // A refused claim throws before reaching here and a queued one carries
      // no entries (`claim.ts`: a queue placement has no tab to seed and the
      // entries are deliberately dropped rather than held across an
      // unbounded wait). So nothing is retained for a lease that does not
      // exist, and a caller cannot leave values in this process by being
      // refused repeatedly.
      if (result.outcome === 'granted') {
        pendingSeeds.put(result.claimId, result.storageSeed);
      }
      return result;
    },
    /**
     * **After the call returns, so the probe is outside the transaction.**
     * The same shape `claim` above uses for its seed, and for a stricter
     * reason: this one talks to a browser, and
     * `arbitration.no_browser_io` (§2.4b) is what keeps that out of the
     * arbitration transaction.
     *
     * A queued lease is not probed. It holds no tab and is waiting for
     * capacity rather than using it, so a browser that is down is the
     * ordinary reason the queue exists — reporting a waiting caller as
     * expired would end a lease that has nothing wrong with it.
     */
    /**
     * **No `run`, and that is the whole of what distinguishes it.**
     *
     * Every other method here is one `runArbitration` call, which sweeps and
     * then renews the lease the key names. This one has no key and no lease,
     * so there is nothing to renew — and a sweep charged to a caller holding
     * nothing would put the cheapest question on the surface inside the
     * transaction every other caller waits behind.
     *
     * It is `async` only because {@link Broker} is uniformly asynchronous;
     * the read itself is synchronous, like every other `better-sqlite3` read
     * in this service.
     */
    poolStatus: () => Promise.resolve(readPoolStatus(options.store.db)),
    status: async (input) => {
      const result = await run<StatusInput, StatusResult>('status', input);
      if (result.state !== 'active' || options.checkBrowser === undefined) {
        return result;
      }

      const liveness = await options.checkBrowser(result.browserId);
      if (liveness !== 'gone') {
        return { ...result, browser: liveness };
      }

      // **The lease is reported `expired`, and this writes nothing.**
      //
      // Two things are true at once and the split matters: the browser is
      // gone, so this lease cannot do anything a lease is for; but the
      // reclamation that ends leases is the sweep's, inside the arbitration
      // transaction, and this code is deliberately outside it. Writing here
      // would be a second writer of lease state racing the one that owns it.
      //
      // So this reports the truth without asserting authorship of it, which
      // is exactly what §2.4's standing rule licenses: **stored state is
      // provisional, derived state is the truth.** A row saying `active`
      // against a dead browser is provisional in the same way a lapsed row
      // is, and a reader that derives correctly renders the same picture
      // whether or not the row has been swept.
      //
      // `tabId` is dropped rather than carried: it names a page in a browser
      // that does not exist, and handing it back invites a caller to address
      // it. Nothing owns it to close — the browser took it.
      const { tabId, ...withoutTab } = result;
      // Read so that dropping it is a decision the compiler can see rather
      // than an unused binding a later cleanup would "tidy" back into the
      // result. The tab is real in the store; what is gone is the browser
      // holding it, which is why it is omitted here and not closed here.
      void tabId;
      return {
        ...withoutTab,
        state: 'expired',
        browser: 'gone',
        checkBack: `The ${result.browserId} browser this lease was held against is not running: its endpoint did not answer, or answered as a different browser. The lease cannot be used, so it is reported expired rather than active however much time is left on it. Release this lease and claim again — a claim is what starts a browser, and the next one will start a fresh one.`,
      };
    },
    release: (input) =>
      run<ReleaseInput & { settings: ArbitrationSettings }, ReleaseResult>('release', {
        ...input,
        settings,
      }),
    navigate: (input) => run<NavigateInput, NavigateResult>('navigate', withBrowser(input)),
    // The upload root, for the one verb that reads a file from this machine.
    // Read from the environment snapshot here and handed in, rather than read
    // inside the handler — the same discipline as the arbitration settings
    // above, and what makes the unconfigured-root refusal provable without a
    // process environment. Spread away when unset, so that "no operator has
    // configured one" arrives as an absent field rather than as an empty
    // string a handler could mistake for a directory.
    act: (input) =>
      run<ActInput, ActResult>('act', {
        ...withBrowser(input),
        ...(options.environment.uploadRoot === undefined
          ? {}
          : { uploadRoot: options.environment.uploadRoot }),
      }),
    // The artifact store, alongside the browser: an `inline` read returns the
    // text of the artefact **file** the read writes, so it needs somewhere to
    // read it back from — the same pairing `evaluate` and `capture` keep. It
    // arrives under `artifactStore` rather than `artifacts` because
    // `ReadInput.artifacts` already spells the list of artefacts asked for,
    // and the store would arrive in the slot the artefact list vacates.
    read: (input) =>
      run<ReadInput, ReadResult>('read', {
        ...withBrowser(input),
        ...(options.artifacts === undefined ? {} : { artifactStore: options.artifacts }),
      }),
    evaluate: (input) =>
      run<EvaluateInput, EvaluateResult>('evaluate', {
        ...withBrowser(input),
        // The artifact store, and deliberately **not** `diffSettings`: an
        // evaluation never diffs, and handing it a setting it cannot use
        // would be the surface declaring an argument that does nothing.
        ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
      }),
    capture: (input) => run<CaptureInput, CaptureResult>('capture', withBrowserAndArtifacts(input)),
    tab_replace: (input) =>
      run<TabReplaceInput, TabReplaceResult>('tab_replace', withBrowser(input)),
    begin_sign_in: (input) => run<BeginSignInInput, BeginSignInResult>('begin_sign_in', input),
    end_sign_in: (input) => run<EndSignInInput, EndSignInResult>('end_sign_in', input),
    sign_in: (input) => run<RequestSignInInput, RequestSignInResult>('sign_in', input),
    sign_in_done: (input) => run<FinishSignInInput, FinishSignInResult>('sign_in_done', input),
  };
}
