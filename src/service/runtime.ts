import type { BrokerService } from '../adapter/service-seam.ts';
import type { EventAdapter } from './events.ts';
import { readEnvironment, type Environment } from '../config/environment.ts';
import { openStore, type StoreHandle } from '../store/open.ts';
import { stepSchema } from '../store/schema/step.ts';
import { ArtifactStore } from '../artifacts/store.ts';
import type { BrowserId } from '../browser/driver.ts';
import { browserSessionProvider } from './browser-session.ts';
import { serviceFor } from './bridge.ts';
import { createBroker, type Broker } from './broker.ts';

/**
 * What a shipped executable does to get a service: open the store, step it,
 * build the broker, present it through the bridge.
 *
 * ── Why this is a file and not four lines in each binary ────────────────
 *
 * There are two executables — the command line and the tool shim — and they
 * must reach *the same* service, built the same way. Written out twice, the
 * two would be one edit away from a rule that holds on one surface and not
 * the other, which is the failure `SCHEMA.md` §8 exists to make checkable.
 * Written once, "the same rules through every door" is true by construction
 * for the part a binary controls: which service it built.
 *
 * The only thing the two pass differently is {@link EventAdapter}, and that
 * is the one thing that *should* differ — §1.6 keeps one row per decision
 * and records which door it came in through.
 *
 * ── The lifetime this hands back, and why closing is the caller's job ───
 *
 * A store handle is an open file, and this returns one that is open. The
 * caller closes it, because the caller is the one that knows when its work is
 * finished — the command line closes after one command, and the tool shim
 * closes when its input stream ends, which may be many operations later.
 */
export interface Runtime {
  readonly service: BrokerService;
  /**
   * The typed service, for the operations that are not on the agent surface.
   *
   * `service` above is the ten-operation seam every adapter drives, and it is
   * deliberately flat: a caller names an operation and passes arguments.
   * **Signing in is not one of the ten** — it is performed by a person, takes
   * no lease and no tab budget — so it is reached here rather than by
   * widening the surface agents can call. §5.4's rule about the
   * administrative operations is the same one: *"They are not on the agent
   * surface and adding them there fails the build."*
   */
  readonly broker: Broker;
  readonly store: StoreHandle;
  readonly environment: Environment;
  /** Release the store. Safe to call more than once. */
  readonly close: () => void;
}

export interface RuntimeOptions {
  /** Which door, for the ledger (§1.6). */
  readonly adapter: EventAdapter;
  /** The process environment to read configuration from. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build the service a shipped binary serves, **with a real browser behind it**.
 *
 * ── What changed here, and why it is now correct to do it ───────────────
 *
 * This function used to supply no session source, and said so at length: a
 * page verb decided, renewed, checked ownership and wrote its ledger row, and
 * then moved no page, because there was no page. That was honest and it is now
 * obsolete. The two reasons it gave have both been answered:
 *
 *  1. `act` and `read` are implemented on the real driver, and the directory
 *     they write into is supplied here from the artifact store rather than
 *     left to the driver's temporary default.
 *  2. Attach-against-launch is not decided here at all. It is decided in the
 *     store, by `decideAdoption`, in the same transaction that arbitrates
 *     claims — which is where §1.2a puts it. `service/browser-session.ts`
 *     composes that decision with the driver that performs it.
 *
 * **Row #55 is still open and this does not close it.** The launch-race loser
 * polls with a ceiling *in this process* and refuses when it is reached,
 * rather than proceeding as if it had a browser. What the design should
 * specify — whether a bound belongs there at all, and what it should be —
 * remains #55's; see `browser-session.ts` for the argument in full.
 *
 * ── Nothing is acquired here, and that is the load-bearing part ─────────
 *
 * `browserSessionProvider` returns a **function**, and this hands that
 * function to the broker. No browser is launched, attached to, or looked for
 * until a page verb actually needs one, inside an after-commit closure.
 *
 * That is what keeps every other path working on a machine with no browser at
 * all: `claim`, `status`, `release`, `feedback`, `doctor`, every refusal, and
 * the continuous-integration job that spawns these executables on a runner
 * where no browser is installed. A build that connected eagerly would make all
 * of them depend on something most of them never use.
 *
 * ── And a browser that cannot be reached is reported, not hidden ────────
 *
 * After-commit failures are swallowed by design (§2.4b), so a browser that
 * fails to launch or dies mid-operation produces no error a caller can see.
 * What stops that becoming a lie is that `pageDriven` is settled **after** the
 * work has run rather than predicted before it: the arbitration half is
 * reported as the `accepted` fact it genuinely is, and the page half is
 * reported as `false`. See `operations/pages.ts` for why that is a field on an
 * accepted result rather than a refusal.
 */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const environment = readEnvironment({ env: options.env });
  const store = openStore(environment);

  try {
    // `SCHEMA.md` §1.2d: every spawn steps the schema. A binary that skipped
    // it would run against whatever version it found.
    await stepSchema(store.db);
  } catch (error) {
    store.close();
    throw error;
  }

  const artifacts = new ArtifactStore(environment.artifactsRoot);
  const browsers = browserSessionProvider({ store, environment, artifacts });

  const broker = createBroker({
    store,
    environment,
    adapter: options.adapter,
    session: browsers.session,
    artifacts,
    // The same provider closes the tabs the sweep orphaned. Without one,
    // `SCHEMA.md` §2.4b's "a leaked tab is not a leaked lease" describes a
    // permanent state rather than a failure mode: an expired lease's page
    // stays open for the life of the browser. Reclaiming capacity does not
    // depend on a browser; reclaiming the page does.
    closeTab: async (tab) => {
      const session = await browsers.session(tab.browserId as BrowserId);
      const opened = await resolveDriverTab(store.db, tab.tabId);
      if (opened !== undefined) {
        await session.closeTab({ browser: tab.browserId as BrowserId, driverTabId: opened });
      }
    },
  });

  let closed = false;
  return {
    service: serviceFor({ broker, db: store.db }),
    broker,
    store,
    environment,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      // **Detaching is deliberately not awaited, and the store is closed
      // regardless.** `close` is synchronous because its callers are: the
      // command line closes in a `finally` after one command, and the tool
      // shim closes when its input stream ends.
      //
      // Letting go of a connection is not closing a browser — `real.ts`
      // measures that attaching and detaching are non-destructive, and a
      // browser is adopted rather than owned, so a process that exits without
      // having finished detaching leaves the browser exactly where it was.
      // The connection dies with the process either way. What must not happen
      // is the store staying open, and it does not.
      void browsers.close().catch(() => {
        // Nothing can act on a failure to let go of a connection.
      });
      store.close();
    },
  };
}

/**
 * The driver's name for a tab, or nothing if it never had one.
 *
 * Read here rather than carried on {@link OrphanedTab} because that type is
 * the arbitration transaction's, and the driver name is only wanted **after**
 * the commit, by the one caller that has a browser to ask. A tab that was
 * never opened has no page, so there is nothing to close and this returns
 * nothing rather than asking the browser about a page that does not exist.
 */
function resolveDriverTab(db: StoreHandle['db'], tabId: string): Promise<string | undefined> {
  const row = db
    .prepare<[string], { driverTabId: string | null }>(
      'SELECT driver_tab_id AS driverTabId FROM tabs WHERE id = ?',
    )
    .get(tabId);
  return Promise.resolve(row?.driverTabId ?? undefined);
}
