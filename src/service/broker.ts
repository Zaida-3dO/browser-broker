import type { Environment } from '../config/environment.ts';
import { readDiffSettings, type DiffSettings } from '../diff/settings.ts';
import type { StoreHandle } from '../store/open.ts';
import { runArbitration, type CloseOrphanedTab } from './arbitration.ts';
import type { ArtifactStore } from '../artifacts/store.ts';
import type { EventAdapter } from './events.ts';
import { createPendingSeeds } from './pending-seeds.ts';
import type { ArbitrationSettings, ClaimInput, ClaimResult } from './operations/claim.ts';
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
} from './operations/sign-in.ts';
import type { StatusInput, StatusResult } from './operations/status.ts';

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
 */
export interface Broker {
  claim: (input: ClaimInput) => Promise<ClaimResult>;
  status: (input: StatusInput) => Promise<StatusResult>;
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

  const withBrowser = <T>(input: T): T => ({
    ...input,
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

  return {
    claim: async (input) => {
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
    status: (input) => run<StatusInput, StatusResult>('status', input),
    release: (input) =>
      run<ReleaseInput & { settings: ArbitrationSettings }, ReleaseResult>('release', {
        ...input,
        settings,
      }),
    navigate: (input) => run<NavigateInput, NavigateResult>('navigate', withBrowser(input)),
    act: (input) => run<ActInput, ActResult>('act', withBrowser(input)),
    read: (input) => run<ReadInput, ReadResult>('read', withBrowser(input)),
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
  };
}
