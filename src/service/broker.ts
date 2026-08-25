import type { Environment } from '../config/environment.ts';
import type { StoreHandle } from '../store/open.ts';
import { runArbitration, type CloseOrphanedTab } from './arbitration.ts';
import type { EventAdapter } from './events.ts';
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
  TabReplaceInput,
  TabReplaceResult,
} from './operations/pages.ts';
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
  };

  const run = <Input, Output>(name: string, input: Input): Promise<Output> =>
    runArbitration<Input, Output>({
      store: options.store,
      name,
      adapter: options.adapter,
      input,
      ...(options.closeTab === undefined ? {} : { closeTab: options.closeTab }),
    });

  return {
    claim: (input) =>
      run<ClaimInput & { settings: ArbitrationSettings }, ClaimResult>('claim', {
        ...input,
        settings,
      }),
    status: (input) => run<StatusInput, StatusResult>('status', input),
    release: (input) =>
      run<ReleaseInput & { settings: ArbitrationSettings }, ReleaseResult>('release', {
        ...input,
        settings,
      }),
    navigate: (input) => run<NavigateInput, NavigateResult>('navigate', input),
    act: (input) => run<ActInput, ActResult>('act', input),
    read: (input) => run<ReadInput, ReadResult>('read', input),
    evaluate: (input) => run<EvaluateInput, EvaluateResult>('evaluate', input),
    capture: (input) => run<CaptureInput, CaptureResult>('capture', input),
    tab_replace: (input) => run<TabReplaceInput, TabReplaceResult>('tab_replace', input),
  };
}
