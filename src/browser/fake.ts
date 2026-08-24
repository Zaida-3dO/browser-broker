import { BROWSER_IDS, type ActionRequest } from './driver.ts';
import type {
  ArtifactResult,
  BrowserDescription,
  CookieSummary,
  BrowserDriver,
  BrowserId,
  BrowserMode,
  BrowserSession,
  ColdStartRequest,
  DiscoveryRecord,
  EvaluationResult,
  NavigationResult,
  ReadArtifact,
  TabHandle,
} from './driver.ts';

/**
 * A driver that drives nothing and writes down everything it was asked.
 *
 * ── What it is for, which is not "a stand-in until the real one lands" ──
 *
 * `DECISIONS.md` §5 and `CLAUDE.md` both state the rule this exists to make
 * satisfiable: **a rejection test asserts the physical side-effect, not just
 * the response.** Every operation here has a physical consequence — a tab
 * opens, a page navigates, a capture is written — so an assertion that a call
 * returned `denied` proves almost nothing on its own. *A guard that returns
 * "denied" after the tab has already opened is worse than no guard*, because
 * it reports a refusal that did not happen and everything downstream believes
 * it.
 *
 * So the call log is the point of this file and the fake is the wrapper
 * around it. A test that wants to prove a refusal was real asserts on
 * {@link FakeBrowserDriver.calls} being empty — or, more precisely, on
 * {@link FakeBrowserDriver.callsOf} for the operation that must not have
 * happened. That assertion is unavailable without something recording the
 * calls, which is why this row lands before anything that could be refused.
 *
 * ── The property that makes the log trustworthy ─────────────────────────
 *
 * **A call is recorded when it is made, before anything can make it fail.**
 * Not on success, not after a guard, not conditionally. A log written after
 * the work would be silent about exactly the case it exists to describe: an
 * operation that was attempted and threw is still an operation that was
 * attempted, and a test asserting "nothing happened" must not be satisfied by
 * something that happened and failed. See {@link FakeBrowserDriver.failNext},
 * which is deliberately built so that a seeded failure still appears in the
 * log.
 *
 * ── What it does not do ─────────────────────────────────────────────────
 *
 * It does not simulate a browser. Tabs are counters, navigation always
 * arrives, a snapshot is a path that no file exists at, and nothing here has
 * any timing. That is a limit worth stating plainly rather than discovering:
 * **this fake proves what the service asked for, never that a browser would
 * have obliged.** Anything that depends on a real browser's behaviour — the
 * headed keeper-tab measurement (#56), attach verification against a live
 * endpoint (#53), the launch race's readiness gap (#55) — needs a real
 * browser and is owed by the row that owns it. A test that uses this fake to
 * assert a browser's behaviour is asserting this file's behaviour.
 */

/** The name of every operation on the seam that can be recorded. */
export type DriverCallName =
  | 'attach'
  | 'coldStart'
  | 'openTab'
  | 'listTabs'
  | 'ensureKeeperTab'
  | 'closeTab'
  | 'navigate'
  | 'act'
  | 'read'
  | 'cookies'
  | 'evaluate'
  | 'detach';

/**
 * One recorded call.
 *
 * `browser` is on every entry because the fake covers a driver that reaches
 * both browsers, and *"which browser was touched"* is a thing a test needs to
 * assert on its own — capacity is one total across both (`DECISIONS.md` §6),
 * so an operation landing on the wrong one is a failure the count would not
 * show.
 */
export interface DriverCall {
  readonly name: DriverCallName;
  readonly browser: BrowserId;
  /**
   * The tab it addressed, for the tab-scoped operations. Absent on the
   * browser-scoped reads (`attach`, `listTabs`, `detach`) — which are the only
   * browser-scoped operations there are, none of them destructive.
   */
  readonly tab?: TabHandle;
  /** The rest of the arguments, per operation. Read by tests, not by code. */
  readonly detail?: Readonly<Record<string, unknown>>;
  /**
   * Set when this call was made to throw by {@link FakeBrowserDriver.failNext}.
   * **The entry exists either way** — this field says which happened, so a
   * test can tell "was never asked" from "was asked and refused", which are
   * the two outcomes a rejection test has to keep apart.
   */
  readonly failed?: true;
}

/** How a fake browser reports itself, when a test needs it to say something specific. */
export interface FakeBrowserOptions {
  /**
   * Defaults to `headed` for the regular browser and `headless` for the
   * private one, matching `SCHEMA.md` §1.2 and §3.15 — the signed-in browser
   * is the headed one, and that is the fact the keeper tab exists for.
   */
  readonly mode?: BrowserMode;
  readonly pid?: number;
}

/** Where the fake's canned answers come from, when a test needs a particular one. */
export interface FakeDriverOptions {
  readonly regular?: FakeBrowserOptions;
  readonly private?: FakeBrowserOptions;
}

const DEFAULT_MODE: Readonly<Record<BrowserId, BrowserMode>> = {
  // The signed-in browser is headed, and that is the whole reason the keeper
  // tab is a correctness mechanism rather than tidiness (`SCHEMA.md` §3.15).
  regular: 'headed',
  private: 'headless',
};

const DEFAULT_PID: Readonly<Record<BrowserId, number>> = {
  regular: 4001,
  private: 4002,
};

/**
 * What a tab's cookies look like when a test has not said otherwise.
 *
 * Two entries rather than none, and it matters: a redaction test that asserts
 * a secret appears nowhere in the output is trivially satisfied by output
 * with nothing in it, and would stay green with the redaction deleted. Two
 * cookies with flags that differ also mean a test asserting the flags survive
 * cannot pass by returning one shape for everything.
 *
 * **No value field appears here because {@link CookieSummary} has none.** The
 * seeding lever is what carries a secret value — see
 * {@link FakeBrowserDriver.seedCookies}.
 */
const DEFAULT_COOKIES: readonly CookieSummary[] = [
  {
    name: 'session',
    domain: 'example.com',
    path: '/',
    expires: null,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  },
  {
    name: 'preference',
    domain: 'example.com',
    path: '/settings',
    expires: '2027-01-01T00:00:00.000Z',
    httpOnly: false,
    secure: false,
    sameSite: 'Strict',
  },
];

/** A seeded failure: the next call to this operation throws instead of answering. */
interface SeededFailure {
  readonly name: DriverCallName;
  readonly error: Error;
}

/**
 * The fake, its log, and the levers a test needs.
 *
 * One instance is one installation's worth of browsers: it can hand out a
 * session for each of the two and no more, because {@link BrowserId} has two
 * members and there is nothing here that invents a third.
 */
export class FakeBrowserDriver implements BrowserDriver {
  readonly #calls: DriverCall[] = [];
  readonly #options: FakeDriverOptions;
  readonly #openTabs = new Map<BrowserId, Set<string>>();
  readonly #keeperTabs = new Map<BrowserId, string>();
  readonly #cookies = new Map<string, readonly CookieSummary[]>();
  readonly #failures: SeededFailure[] = [];
  #nextTabNumber = 1;

  constructor(options: FakeDriverOptions = {}) {
    this.#options = options;
    for (const browser of BROWSER_IDS) {
      this.#openTabs.set(browser, new Set());
    }
  }

  /**
   * Every call, in the order it was made.
   *
   * **The assertion a rejection test is built on is that this is empty**, or
   * that {@link FakeBrowserDriver.callsOf} for the forbidden operation is.
   * Returned as a copy so a test holding it cannot be surprised by a later
   * call mutating what it already read, and cannot quietly clear the log by
   * mutating the array it was handed.
   */
  get calls(): readonly DriverCall[] {
    return [...this.#calls];
  }

  /** Every recorded call to one operation. The narrow form of the assertion above. */
  callsOf(name: DriverCallName): readonly DriverCall[] {
    return this.#calls.filter((call) => call.name === name);
  }

  /**
   * How many tabs are open in a browser, keeper tab included.
   *
   * **The second half of a capacity refusal's assertion.** Refusing an
   * over-budget claim means the tab count did not move, and a test that only
   * checked the response would pass against a service that opened the tab and
   * then said no. Use {@link FakeBrowserDriver.leasableTabCount} for the
   * number the budget is actually about.
   */
  openTabCount(browser: BrowserId): number {
    return this.#openTabs.get(browser)?.size ?? 0;
  }

  /**
   * Open tabs excluding the keeper tab — the number a budget is counted in.
   *
   * `SCHEMA.md` §3.15: the keeper tab **is not counted against the budget**,
   * because it is not capacity anybody can use. Counting it would mean the
   * budget was one lower than it says. Both counts are exposed rather than
   * only this one, because *"one more tab than the budget accounts for"* is
   * itself the thing §3.15 asks to be reconcilable.
   */
  leasableTabCount(browser: BrowserId): number {
    const keeper = this.#keeperTabs.get(browser);
    const tabs = this.#openTabs.get(browser);
    if (!tabs) return 0;
    return keeper !== undefined && tabs.has(keeper) ? tabs.size - 1 : tabs.size;
  }

  /** Empty the log. For a test with a setup phase whose calls are not the subject. */
  clearCalls(): void {
    this.#calls.length = 0;
  }

  /**
   * Make the next call to `name` throw.
   *
   * For the paths whose whole behaviour is what happens when a browser does
   * not co-operate: a close that fails is a **leaked tab and not a leaked
   * lease** (`SCHEMA.md` §2.4b), and that distinction is untestable without a
   * close that can fail on demand.
   *
   * **The failed call is still recorded**, with `failed: true`. That is the
   * property that keeps the log honest — see this file's header.
   */
  failNext(
    name: DriverCallName,
    error: Error = new Error(`the fake was told to fail ${name}`),
  ): void {
    this.#failures.push({ name, error });
  }

  /**
   * Give a tab a particular set of cookies.
   *
   * **The lever a redaction test needs, and the shape of it is the point.**
   * A test proving `read.cookies_no_values` (§7.1) seeds a cookie whose
   * *value* is a known secret and then asserts that string appears nowhere in
   * the response or in the file. This method takes {@link CookieSummary}
   * entries, which have no value field — so the secret is supplied to the
   * test's own driver-level fixture rather than through here, and this method
   * exists to control the **names and flags** that do come back.
   *
   * That asymmetry is deliberate and it is the honest position: this fake
   * cannot demonstrate that a value was dropped, because at this seam there
   * was never a value to drop. What it can demonstrate is that everything
   * else survives, which is the half of §3.9 a redaction is most likely to
   * break by over-reaching.
   */
  seedCookies(tab: TabHandle, cookies: readonly CookieSummary[]): void {
    this.#cookies.set(tab.driverTabId, [...cookies]);
  }

  attach(browser: BrowserId, record: DiscoveryRecord): Promise<BrowserSession> {
    const failure = this.#enter({ name: 'attach', browser, detail: { endpoint: record.endpoint } });
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.#session(browser));
  }

  coldStart(request: ColdStartRequest): Promise<BrowserSession> {
    const failure = this.#enter({
      name: 'coldStart',
      browser: request.browser,
      detail: { profileDirectory: request.profileDirectory, mode: request.mode },
    });
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.#session(request.browser, request.mode));
  }

  /**
   * Append the entry, marking it failed when a failure is seeded for it.
   *
   * Every operation goes through this and {@link FakeBrowserDriver.#enter}
   * rather than repeating the sequence at each call site, so that
   * *record-before-failing* is stated once and cannot drift between
   * operations. An operation that recorded after its failure check would be
   * the single mutation that makes the whole log untrustworthy, and it would
   * be invisible in a diff that only touched that one method.
   */
  #record(call: DriverCall): void {
    const seeded = this.#failures.find((failure) => failure.name === call.name);
    this.#calls.push(seeded ? { ...call, failed: true } : call);
  }

  /**
   * Record the call, then take the seeded failure if there is one.
   *
   * Returns the error rather than throwing it, so that every operation can
   * surface it as a **rejected promise**. That distinction is not cosmetic: a
   * real driver is asynchronous and reports a failure by rejecting, so a fake
   * that threw synchronously would let the service's error handling be written
   * against a shape production never produces — and the divergence would show
   * up only once the real driver landed, which is the worst moment to find it.
   */
  #enter(call: DriverCall): Error | undefined {
    this.#record(call);
    const index = this.#failures.findIndex((failure) => failure.name === call.name);
    if (index === -1) return undefined;
    const [seeded] = this.#failures.splice(index, 1);
    return seeded?.error ?? new Error(`the fake was told to fail ${call.name}`);
  }

  #describe(browser: BrowserId, mode?: BrowserMode): BrowserDescription {
    const configured = browser === 'regular' ? this.#options.regular : this.#options.private;
    return {
      browser,
      mode: mode ?? configured?.mode ?? DEFAULT_MODE[browser],
      pid: configured?.pid ?? DEFAULT_PID[browser],
      discovery: {
        endpoint: `http://127.0.0.1:${String(9000 + BROWSER_IDS.indexOf(browser))}`,
        browserUuid: `fake-${browser}-uuid`,
      },
    };
  }

  #tabsFor(browser: BrowserId): Set<string> {
    let tabs = this.#openTabs.get(browser);
    if (!tabs) {
      tabs = new Set();
      this.#openTabs.set(browser, tabs);
    }
    return tabs;
  }

  #session(browser: BrowserId, mode?: BrowserMode): BrowserSession {
    const description = this.#describe(browser, mode);

    const openTab = (name: DriverCallName): Promise<TabHandle> => {
      const driverTabId = `fake-tab-${String(this.#nextTabNumber++)}`;
      const failure = this.#enter({ name, browser, tab: { browser, driverTabId } });
      // The tab is added only after the failure check. A capacity refusal's
      // assertion is that the tab count did not move, so a fake that opened
      // the tab and then rejected would report a count for work that failed.
      if (failure) return Promise.reject(failure);
      this.#tabsFor(browser).add(driverTabId);
      return Promise.resolve({ browser, driverTabId });
    };

    return {
      describe: () => description,

      openTab: () => openTab('openTab'),

      listTabs: () => {
        const failure = this.#enter({ name: 'listTabs', browser });
        if (failure) return Promise.reject(failure);
        return Promise.resolve(
          [...this.#tabsFor(browser)].map((driverTabId) => ({ browser, driverTabId })),
        );
      },

      ensureKeeperTab: async () => {
        const existing = this.#keeperTabs.get(browser);
        if (existing !== undefined && this.#tabsFor(browser).has(existing)) {
          // Idempotent: it is a precondition checked on every spawn
          // (`SCHEMA.md` §7.2), so establishing it twice must not produce two
          // tabs. The call is still recorded — a test proving the check ran
          // needs to see it.
          const failure = this.#enter({
            name: 'ensureKeeperTab',
            browser,
            tab: { browser, driverTabId: existing },
          });
          if (failure) throw failure;
          return { browser, driverTabId: existing };
        }
        const tab = await openTab('ensureKeeperTab');
        this.#keeperTabs.set(browser, tab.driverTabId);
        return tab;
      },

      closeTab: (tab: TabHandle) => {
        const failure = this.#enter({ name: 'closeTab', browser, tab });
        // The tab stays open when the close fails. `SCHEMA.md` §2.4b: that is
        // a leaked tab and not a leaked lease, and the distinction is only
        // observable if the fake keeps the page it could not close.
        if (failure) return Promise.reject(failure);
        this.#tabsFor(tab.browser).delete(tab.driverTabId);
        return Promise.resolve();
      },

      navigate: (tab: TabHandle, url: string): Promise<NavigationResult> => {
        const failure = this.#enter({ name: 'navigate', browser, tab, detail: { url } });
        if (failure) return Promise.reject(failure);
        return Promise.resolve({ url, title: `fake page at ${url}`, status: 200 });
      },

      act: (tab: TabHandle, request: ActionRequest): Promise<ArtifactResult> => {
        const failure = this.#enter({
          name: 'act',
          browser,
          tab,
          // The whole request, not a hand-picked few of its fields.
          // `ActionRequest` is a union over the verb, so each member carries
          // different arguments — a `resize` has a viewport and no reference,
          // a `drag` has two references. Copying named fields would silently
          // drop every argument belonging to a verb added after the copy was
          // written, and a test asserting "it was asked to resize to 375
          // wide" would then pass against a driver asked to resize to
          // anything at all.
          detail: { ...request },
        });
        if (failure) return Promise.reject(failure);
        // A fresh snapshot after every change (`SCHEMA.md` §3.8). No file is
        // written — see this file's header on what the fake does not do.
        return Promise.resolve({
          artifact: 'snapshot',
          path: `${tab.driverTabId}-after-${request.action}.snapshot`,
          bytes: 0,
          truncated: false,
        });
      },

      read: (
        tab: TabHandle,
        artifacts: readonly ReadArtifact[],
      ): Promise<readonly ArtifactResult[]> => {
        const failure = this.#enter({
          name: 'read',
          browser,
          tab,
          detail: { artifacts: [...artifacts] },
        });
        if (failure) return Promise.reject(failure);
        return Promise.resolve(
          artifacts.map((artifact) => ({
            artifact,
            path: `${tab.driverTabId}-${artifact}`,
            bytes: 0,
            truncated: false,
          })),
        );
      },

      cookies: (tab: TabHandle): Promise<readonly CookieSummary[]> => {
        const failure = this.#enter({ name: 'cookies', browser, tab });
        if (failure) return Promise.reject(failure);
        // A canned pair rather than an empty list, because a redaction test
        // asserting "no value appeared" against nothing at all is the
        // assertion-over-an-empty-set this repository has already been caught
        // by: it stays green when the redaction is deleted. `CookieSummary`
        // has no value field, so there is nothing here to redact — which is
        // the property #23's test exists to pin, not something this fake
        // performs.
        return Promise.resolve([...this.#cookies.get(tab.driverTabId) ?? DEFAULT_COOKIES]);
      },

      evaluate: (tab: TabHandle, expression: string): Promise<EvaluationResult> => {
        const failure = this.#enter({ name: 'evaluate', browser, tab, detail: { expression } });
        if (failure) return Promise.reject(failure);
        return Promise.resolve({ value: null, bytes: 0 });
      },

      detach: () => {
        const failure = this.#enter({ name: 'detach', browser });
        if (failure) return Promise.reject(failure);
        // Non-destructive, and the tabs are deliberately untouched: attaching
        // and detaching were measured to leave a browser exactly as they found
        // it (`SCHEMA.md` §1.2a), and that is the property the shared-session
        // design rests on. A fake that dropped its tabs here would let a test
        // pass against a driver that killed the browser on detach.
        return Promise.resolve();
      },
    };
  }
}
