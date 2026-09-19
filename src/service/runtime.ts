import { recordTabCloseFailed, recordTabClosed, settleUnopenedTab } from './arbitration.ts';
import { settleStrandedTabs } from './reconcile.ts';
import { countStrandedTabsFor } from './tabs.ts';
import type { BrokerService } from '../adapter/service-seam.ts';
import type { EventAdapter } from './events.ts';
import { readEnvironment, type Environment } from '../config/environment.ts';
import { prepareStore, type StoreHandle } from '../store/open.ts';
import { ArtifactStore } from '../artifacts/store.ts';
import type { BrowserDriver, BrowserSession } from '../browser/driver.ts';
import { browserSessionProvider, type BrowserSessionProvider } from './browser-session.ts';
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
  /**
   * Resolve a live browser session, for the one administrative command that
   * has to ask a browser a question rather than drive a page (§4.3).
   *
   * **The provider this runtime already built, not a second one.** Every
   * other consumer reaches a browser through the page operations, which get
   * this same function passed to `createBroker` above. Reconciliation
   * (`MILESTONES.md` #21a) is the exception because its question — *what do
   * you actually have open* — is about the browser rather than about any
   * lease, so there is no lease for it to arrive through.
   *
   * Exposing the existing provider is what keeps `browser-session.ts`'s
   * central claim true: adoption decides once per browser per process, so a
   * command that built its own provider would be a second launch path racing
   * the first. It is memoised, so asking for a session a command already has
   * costs nothing.
   *
   * **It does not widen the agent surface.** Nothing reachable from a tool
   * call can see this field; it is on the runtime, next to `broker`, for the
   * same reason `broker` is — §5.4's *"they are not on the agent surface and
   * adding them there fails the build"*.
   */
  readonly session: BrowserSessionProvider;
  /** Release the store. Safe to call more than once. */
  readonly close: () => void;
}

export interface RuntimeOptions {
  /** Which door, for the ledger (§1.6). */
  readonly adapter: EventAdapter;
  /** The process environment to read configuration from. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The browser driver, for a caller that has one to supply.
   *
   * **Defaults to the real driver, which is what both shipped binaries get.**
   * Neither passes this, so nothing about a shipped spawn changes by this
   * parameter existing: `src/bin/broker.ts` and `src/bin/broker-tool.ts` call
   * this function with an adapter and nothing else.
   *
   * ── Why the seam is here rather than only one layer down ───────────────
   *
   * `browserSessionProvider` already takes a driver, *"so a test can hand in
   * a fake and drive the whole adoption path with no browser installed"*.
   * This function is what stands between that seam and anything that wants
   * the **whole service** — store, schema, artifacts, broker, bridge — rather
   * than one piece of it. Without this parameter, the only way to reach a
   * real service was to rebuild all five by hand, and a caller that rebuilt
   * them would be testing its own assembly rather than this one.
   *
   * The conformance suite is the caller that needs it: §8's parity assertion
   * is about the routes over the real service, and continuous integration
   * runs with no browser binary. A real service over a fake driver keeps
   * every rule, every transaction and every route real, and fakes only the
   * thing the assertion is not about.
   */
  readonly driver?: BrowserDriver;
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
 * **Row #55, settled.** The launch-race loser polls with a ceiling *in this
 * process* and refuses when it is reached, rather than proceeding as if it
 * had a browser; see `browser-session.ts` for the argument in full.
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

  // **The spawn path, not a hand-assembled equivalent of it.** This used to
  // open and step inline, which silently omitted the third thing a spawn owes:
  // `budget.agrees_with_store` (§1.10, §7.2). Both shipped binaries build
  // their service here, so that omission meant the one value several processes
  // must agree on was never recorded and never compared in anything that
  // shipped. `prepareStore` closes the handle itself if any of the three
  // refuses, so there is no partially-opened store to clean up here.
  const store = await prepareStore(environment);

  const artifacts = new ArtifactStore(environment.artifactsRoot);
  const browsers = browserSessionProvider({
    store,
    environment,
    artifacts,
    ...(options.driver === undefined ? {} : { driver: options.driver }),
  });

  /**
   * Settle the stranded backlog, using the tab list this close already needs.
   *
   * ── Why here, and why it is not a new verb ──────────────────────────────
   *
   * A row stranded at `closing` under a lease that has ended is reachable by
   * exactly one thing today: `broker reconcile <browser>`, a shell command a
   * person has to run. So `doctor` reports a permanent red floor and tells an
   * operator to go and fix by hand something that ordinary operation is
   * already in a position to settle — a store was found carrying eleven such
   * rows unchanged across two days, multiple sessions and clean releases.
   *
   * The proof that settling is safe is a **live tab list**, and this is a
   * place the service already holds a session and has just done its close
   * pass. So the backlog drains as a side effect of the browser being used,
   * on the identical evidence `broker reconcile` uses, with no new surface.
   *
   * **Not at startup**: there is no browser and no tab list there, so it
   * could only settle on age, which is guessing about pages. **Not on
   * claim**: that path is latency-sensitive, and the backlog is deliberately
   * reported as a note rather than acted on there.
   *
   * ── The keeper tab, which is the dangerous edge ─────────────────────────
   *
   * `listTabs` excludes the keeper (§3.15), so a row naming it would look
   * absent from the list and be settled. That is safe *here* and would not be
   * safe in a close path: settlement writes a row to `closed` and never asks
   * a browser to end a page, so the worst case is a database row that stops
   * describing the keeper — not a closed keeper and a dead browser. Nothing
   * on this path is handed a driver name to act on.
   *
   * Gated on a count first, so a healthy store pays one indexed read and no
   * round trip. Failures are swallowed for the reason §2.4b gives: the
   * capacity is already back, and failing a release over a bookkeeping pass
   * would fail a call that did its job.
   */
  const drainStrandedTabs = async (browserId: string, session: BrowserSession): Promise<void> => {
    try {
      if (countStrandedTabsFor(store.db, browserId, environment.leaseSeconds) === 0) {
        return;
      }
      const pages = await session.listTabs();
      settleStrandedTabs(
        store.db,
        browserId,
        pages.map((page) => page.driverTabId),
        new Date().toISOString(),
      );
    } catch {
      // A backlog that did not drain is still reported by `doctor`, and the
      // release this rode in on has already succeeded.
    }
  };

  const broker = createBroker({
    store,
    environment,
    adapter: options.adapter,
    session: browsers.session,
    // **What makes `status` able to tell the truth about a dead browser.**
    // Supplied here rather than defaulted inside the broker for the reason
    // the option's own comment gives: a build that cannot look must report
    // `unknown` rather than claim the browser is fine. This build can look,
    // so it does. Note this is the provider's `liveness`, which asks the
    // operating system — not its memoised session, which is the very thing
    // that keeps presenting a dead browser as a working connection.
    checkBrowser: browsers.liveness,
    artifacts,
    // The same provider closes the tabs the sweep orphaned. Without one,
    // `SCHEMA.md` §2.4b's "a leaked tab is not a leaked lease" describes a
    // permanent state rather than a failure mode: an expired lease's page
    // stays open for the life of the browser. Reclaiming capacity does not
    // depend on a browser; reclaiming the page does.
    closeTab: async (tab) => {
      const session = await browsers.session(tab.browserId);
      const opened = await resolveDriverTab(store.db, tab.tabId);
      if (opened === undefined) {
        // **A row with no driver name is settled here, not left behind.**
        //
        // This used to return without calling either recorder, which left the
        // row at `closing` — the state meaning "the tool was asked and has not
        // answered" — with `close_attempts` at zero, forever. Nothing later
        // could reach it: the vanished-page path reads only tabs of *active*
        // leases, and this lease has ended. That is a leak with the same
        // fingerprint as the one `recordTabClosed` was written to fix, and it
        // survived that fix because it never reaches the recorders at all.
        //
        // ── Which `undefined` this actually is ────────────────────────────
        //
        // `resolveDriverTab` answers `undefined` for two different stores: a
        // row whose `driver_tab_id` is null, and **no row at all**. Only the
        // second can arrive here, and the schema is what decides that:
        // `step-004-tab-never-opened.ts` CHECKs that a live row must say
        // whether it has a driver name —
        //
        //   state NOT IN ('opening','open','closing')
        //   OR (state = 'opening') = (driver_tab_id IS NULL)
        //
        // — so `closing` with a null name cannot exist, and `closing` is
        // exactly what `updateSweptTabs` selects the rows handed here. The
        // null-name case belongs to `opening`, which that function settles
        // straight to `closed` without ever passing through `closing`.
        //
        // So this branch means the row is gone: deleted, or never written.
        // There is no page to ask about and nothing to wait for either way.
        //
        // Settled to `closed` rather than recorded as a failure because
        // `close_failed = 1` means a browser said the page is still there,
        // and no browser said anything here. The UPDATE is a no-op when the
        // row is genuinely absent, which is the common case and is harmless
        // — it is written so that a row present but unresolvable for any
        // other reason is still settled rather than left waiting forever.
        settleUnopenedTab(store.db, tab.tabId, new Date().toISOString());
        await drainStrandedTabs(tab.browserId, session);
        return;
      }
      // **The answer is written down either way.** `closing` means "the tool
      // was asked and has not answered", so a close that returns and is never
      // recorded leaves a row saying that forever — which is what happened,
      // 22 rows deep, until a person noticed his browser had filled with
      // pages no lease owned.
      //
      // A failure is recorded rather than thrown: §2.4b's "a leaked tab is
      // not a leaked lease" means the capacity is already back, and failing
      // the release over the page would fail a call that did its job.
      //
      // ── Recorded closed only on `closed`, and why that is the whole fix ──
      //
      // The driver used to answer `Promise<void>`, so "I ended the page" and
      // "I could not find it" arrived here identically and this wrote
      // `state='closed', close_failed=0` for both. That is the defect, and its
      // worst property is that it **hid itself**: `doctor` counts rows
      // stranded at `closing` and `status` selects `close_failed = 1`, so a
      // row that went straight to `closed` is invisible to every instrument
      // built to find leaked pages. The store read twelve clean closes while
      // three released pages sat open on a person's screen.
      //
      // So the outcome decides the row. `not_found` and `refused` are both
      // recorded as a close that did not happen — not because either is an
      // error, but because neither is evidence that a page is gone, and
      // `close_failed = 1` is the flag that makes a row *visible* to the
      // operator tooling. **A row that overstates its knowledge is worse than
      // one that admits a page may still be open**: the second gets looked at.
      //
      // `refused` in practice means the keeper, which no lease should ever
      // name; if one does, that is exactly the anomaly worth surfacing rather
      // than recording as a tidy success.
      try {
        const outcome = await session.closeTab({ browser: tab.browserId, driverTabId: opened });
        if (outcome === 'closed') {
          recordTabClosed(store.db, tab.tabId, new Date().toISOString());
        } else {
          recordTabCloseFailed(store.db, tab.tabId, new Date().toISOString());
        }
      } catch {
        recordTabCloseFailed(store.db, tab.tabId, new Date().toISOString());
      }
      await drainStrandedTabs(tab.browserId, session);
    },
  });

  let closed = false;
  return {
    // The environment goes in because `doctor` reports on the installation
    // rather than on a lease — its roots, its store and its configured
    // browsers — and none of that is reachable from a broker.
    service: serviceFor({ broker, db: store.db, environment }),
    broker,
    store,
    environment,
    session: browsers.session,
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
