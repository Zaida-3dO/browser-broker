import { solidPng } from '../capture/image.ts';
import { DEFAULT_BROWSER_IDS, type ActionRequest } from './driver.ts';
import type {
  ArtifactResult,
  CaptureRequest,
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
  RawCapture,
  ReadArtifact,
  StorageSeedArea,
  StorageSeedEntry,
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
  | 'seedStorage'
  | 'act'
  | 'read'
  | 'cookies'
  | 'evaluate'
  | 'settlePage'
  | 'capture'
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

/**
 * What the fake's shutter produces, when a test needs a particular picture.
 *
 * **This is canned geometry, never a rendering.** The fake does not simulate a
 * browser (see this file's header), so a test that sets `width` here is
 * stating what it wants the pipeline to have been handed — which is exactly
 * the input a downscale test needs and exactly the wrong thing to read as
 * evidence that a browser would have produced it.
 */
export interface FakeCaptureOptions {
  readonly width?: number;
  readonly height?: number;
  readonly viewportWidth?: number;
  readonly url?: string;
  /**
   * The encoded bytes handed back.
   *
   * Defaults to a real, decodable one-pixel image rather than arbitrary
   * bytes, because a pipeline that decodes what it was given must be given
   * something decodable — and a fake that handed back nonsense would make
   * every downscale test a test of the decoder's error path.
   */
  readonly image?: Uint8Array;
}

/**
 * What an evaluation hands back, when a test needs a particular value.
 *
 * **Canned, never computed.** The fake does not evaluate the expression — see
 * this file's header — so this states what the page is to be *treated as*
 * having produced. It is the input a spill test needs (a value past the
 * inline cap) and exactly the wrong thing to read as evidence that any real
 * page would produce it.
 */
export interface FakeEvaluationOptions {
  /** Handed back verbatim to whatever asked. Serialised by the service, not here. */
  readonly value: unknown;
}

/** Where the fake's canned answers come from, when a test needs a particular one. */
export interface FakeDriverOptions {
  readonly regular?: FakeBrowserOptions;
  readonly private?: FakeBrowserOptions;
  readonly capture?: FakeCaptureOptions;
  readonly evaluate?: FakeEvaluationOptions;
}

/**
 * The one expression shape {@link FakeBrowserDriver} answers from storage.
 *
 * Anchored at both ends and exact about the punctuation, so it matches the
 * form a test writes and nothing that merely resembles it. Deliberately
 * narrow: widening this is the first step toward the interpreter the fake
 * must not become.
 */
const STORAGE_READ_EXPRESSION =
  /^__seeded\((?<area>local|session),\s*(?<origin>[^,)]+),\s*(?<key>[^)]+)\)$/u;

/**
 * How one storage entry is addressed: the tab, the origin, the area, the key.
 *
 * All four, because all four partition storage in a real browser. A key built
 * from fewer would let a seed written for one origin read back under another
 * — which would make a test pass for a service that seeded the wrong place.
 */
function storageKey(
  driverTabId: string,
  origin: string,
  area: StorageSeedArea,
  key: string,
): string {
  return `${driverTabId}|${origin}|${area}|${key}`;
}

const DEFAULT_MODE: Readonly<Record<string, BrowserMode | undefined>> = {
  // The signed-in browser is headed, and that is the whole reason the keeper
  // tab is a correctness mechanism rather than tidiness (`SCHEMA.md` §3.15).
  regular: 'headed',
  private: 'headless',
};

const DEFAULT_PID: Readonly<Record<string, number | undefined>> = {
  regular: 4001,
  private: 4002,
};

/**
 * A stable per-name offset, so a browser keeps one endpoint and one process
 * identifier across the calls of a single test.
 *
 * The two browsers the default configuration names keep the numbers they
 * always had, which is what stops an assertion written against them moving.
 * Any other name is hashed into the same small range — collisions are
 * possible and harmless: nothing here dials the number, it only has to differ
 * between browsers often enough that a test asserting two browsers are
 * distinct is asserting something.
 */
function endpointOffset(browser: string): number {
  const known = DEFAULT_BROWSER_IDS.indexOf(browser);
  if (known !== -1) {
    return known;
  }
  let hash = 0;
  for (const character of browser) {
    hash = (hash * 31 + character.charCodeAt(0)) % 900;
  }
  return DEFAULT_BROWSER_IDS.length + hash;
}

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
  /**
   * Per-tab storage, keyed `<driverTabId>|<origin>|<area>` — the partitioning
   * a real browser enforces, modelled just far enough to be readable back.
   *
   * ── Why the fake holds state here at all ────────────────────────────────
   *
   * This file's header is firm that the fake does not simulate a browser, and
   * this does not walk that back: nothing here renders, lays out or executes.
   * What it does is make **the one property `storage_seed` exists for**
   * observable — that a value written before a tab's first navigation is
   * there when the page looks. A fake whose `seedStorage` only logged could
   * not tell a wired seed from an unwired one, because a page reading storage
   * would answer nothing in both cases. That is the coinciding fixture this
   * repository has been caught by six times, and it is exactly the shape it
   * takes here: **the seed test would pass against a service that never
   * called `seedStorage` at all.**
   *
   * So the seed writes and {@link FakeBrowserDriver.storedValue} reads, and
   * the evaluation lever below reads through the same map — which is what
   * makes "the page can see what was seeded for it" a real assertion rather
   * than a restatement of the call log.
   *
   * Keyed by origin **and** area because both partition real storage: the
   * same key in `local` and in `session`, or under two origins, are different
   * entries, and a fake that collapsed them would let a seed land in the
   * wrong place and still read back.
   */
  readonly #storage = new Map<string, string>();
  readonly #failures: SeededFailure[] = [];
  #nextTabNumber = 1;

  constructor(options: FakeDriverOptions = {}) {
    this.#options = options;
    for (const browser of DEFAULT_BROWSER_IDS) {
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

  /**
   * What a tab's storage holds for one origin and area, or nothing.
   *
   * **Read by a test the way a page would read it**, so an assertion built on
   * this fails when the seed did not happen. Absent rather than empty-string
   * for a key never written, because "seeded with the empty string" and
   * "never seeded" are different facts and a test distinguishing them is the
   * one that catches a seed that silently did nothing.
   */
  storedValue(
    tab: TabHandle,
    origin: string,
    area: StorageSeedArea,
    key: string,
  ): string | undefined {
    return this.#storage.get(storageKey(tab.driverTabId, origin, area, key));
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
      // A configured browser the fake has no entry for is headless with a
      // derived process identifier. Named rather than defaulted silently:
      // the fake stands up whatever browser a test asks for, and the two
      // entries below are the two the default configuration has.
      mode: mode ?? configured?.mode ?? DEFAULT_MODE[browser] ?? 'headless',
      pid: configured?.pid ?? DEFAULT_PID[browser] ?? 4000 + endpointOffset(browser),
      discovery: {
        endpoint: `http://127.0.0.1:${String(9000 + endpointOffset(browser))}`,
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

      /**
       * Every page open in this browser **except the keeper tab**.
       *
       * ── Why the exclusion is here rather than left to the caller ────────
       *
       * `real.ts` excludes it, and says why: the keeper is *"never counted
       * against the budget"* (§3.15) and never addressable, so it does not
       * appear in the list capacity is derived from. This fake did not, and
       * the divergence was invisible for as long as `listTabs` had no
       * consumer in `src/`.
       *
       * **Reconciliation is that consumer** (`MILESTONES.md` #21a), and it is
       * the one whose correctness the divergence destroys. Reconciliation
       * closes pages no live lease owns; the keeper is owned by no lease, by
       * construction. So a fake that listed it would make the fixture agree
       * with a service that closes the keeper — and closing the keeper kills
       * the shared signed-in session, because a headed browser dies within
       * about half a second of its final tab closing.
       *
       * That is exactly the coinciding-fixture shape this repository keeps
       * being caught by, in its most expensive form: the suite would be
       * **evidence for** the destructive behaviour rather than against it,
       * and nothing headed runs in continuous integration to contradict it.
       */
      listTabs: () => {
        const failure = this.#enter({ name: 'listTabs', browser });
        if (failure) return Promise.reject(failure);
        const keeper = this.#keeperTabs.get(browser);
        return Promise.resolve(
          [...this.#tabsFor(browser)]
            .filter((driverTabId) => driverTabId !== keeper)
            .map((driverTabId) => ({ browser, driverTabId })),
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

        // ── The keeper is not closable, and this is the mechanical half ────
        //
        // `keeper.never_leased` (§3.15, §7.3): the keeper is never
        // addressable, and **a caller cannot close what it cannot name.**
        // `real.ts` gets this structurally — the keeper's page is never put
        // in its `#pages` map, so `closeTab` cannot resolve the handle and
        // returns having done nothing.
        //
        // This fake mints its keeper through its own `openTab`, so without
        // this branch the keeper's identifier **is** an ordinary tab name and
        // closing it works. That is the same divergence the keeper had in
        // `listTabs`, in its most consequential form: a fixture on which the
        // destructive act succeeds is a fixture that would validate a service
        // that performed it, and closing the keeper ends the shared signed-in
        // browser — a headed browser dies within about half a second of its
        // last tab closing.
        //
        // Returning without closing rather than rejecting, because that is
        // what `real.ts` does and closing is best effort by design (§2.4b): a
        // rejection here would be a driver reporting a failure the service is
        // specified to ignore.
        if (this.#keeperTabs.get(tab.browser) === tab.driverTabId) {
          return Promise.resolve();
        }

        this.#tabsFor(tab.browser).delete(tab.driverTabId);
        return Promise.resolve();
      },

      navigate: (tab: TabHandle, url: string, waitMs?: number): Promise<NavigationResult> => {
        // The wait is recorded even though nothing here waits, because what a
        // test needs to assert is that the service *asked* for it. An argument
        // that is accepted and dropped between the caller and the driver looks
        // identical from the outside to one that was honoured, and the only
        // place that difference is observable is this log.
        //
        // Recorded as an absent key when the caller omitted it, rather than as
        // an explicit undefined, so a test can tell "asked for no wait" from
        // "asked for a wait of nothing".
        const failure = this.#enter({
          name: 'navigate',
          browser,
          tab,
          detail: { url, ...(waitMs === undefined ? {} : { waitMs }) },
        });
        if (failure) return Promise.reject(failure);
        return Promise.resolve({ url, title: `fake page at ${url}`, status: 200 });
      },

      seedStorage: (tab: TabHandle, entries: readonly StorageSeedEntry[]): Promise<void> => {
        // **The whole entries list, values included**, and that is deliberate
        // in a way the redaction rule does not contradict. The rule §3.2
        // states is about the *ledger* — what the service persists — and the
        // test that matters most for it is "a seeded value never reaches the
        // events table". A fake that redacted here could not tell that test
        // from a fake that was never given the value in the first place, so
        // the log carries what the driver was actually handed and the
        // assertion about redaction is made against the store.
        //
        // The log is in-memory, per-test, and never written anywhere.
        const failure = this.#enter({
          name: 'seedStorage',
          browser,
          tab,
          detail: { entries: entries.map((entry) => ({ ...entry })) },
        });
        if (failure) return Promise.reject(failure);
        // Written **after** the failure check, so a seeded failure leaves the
        // storage untouched — the same discipline `closeTab` keeps above, and
        // for the same reason: a driver that half-performed a rejected call
        // would let a test assert an effect the real driver never produced.
        for (const entry of entries) {
          this.#storage.set(
            storageKey(tab.driverTabId, entry.origin, entry.area, entry.key),
            entry.value,
          );
        }
        return Promise.resolve();
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
        return Promise.resolve([...(this.#cookies.get(tab.driverTabId) ?? DEFAULT_COOKIES)]);
      },

      evaluate: (tab: TabHandle, expression: string): Promise<EvaluationResult> => {
        const failure = this.#enter({ name: 'evaluate', browser, tab, detail: { expression } });
        if (failure) return Promise.reject(failure);

        // ── The one expression this fake understands ────────────────────────
        //
        // **It is not an interpreter and must never become one.** It matches
        // one fixed, exact form — a storage read, spelled out below — and
        // answers it from the same map `seedStorage` writes. Everything else
        // gets the canned `null` it always got.
        //
        // The reason it understands even this much: the property row #65 owes
        // is *the page can see what was seeded before it loaded*, and "the
        // page" reaches storage by evaluating. Without this, a test could
        // only assert that `seedStorage` was called — which is the call log
        // restated, and stays green against a driver whose seed writes
        // nothing.
        //
        // A general evaluator here would be a worse fake, not a better one:
        // it would make every evaluation test a test of this file's
        // interpreter rather than of the service, and this file's header is
        // explicit that the fake does not simulate a browser.
        const read = STORAGE_READ_EXPRESSION.exec(expression);
        if (read !== null) {
          const [, area, origin, key] = read;
          const value = this.#storage.get(
            storageKey(tab.driverTabId, origin as string, area as StorageSeedArea, key as string),
          );
          // `null` and not `undefined` for a key that is not there, because
          // that is what a real `getItem` answers for a missing key — and a
          // test distinguishing "seeded" from "not seeded" reads the same
          // shape either way.
          return Promise.resolve({ value: value ?? null, bytes: 0 });
        }

        const canned = this.#options.evaluate;
        if (canned !== undefined && Object.hasOwn(canned, 'value')) {
          return Promise.resolve({ value: canned.value, bytes: 0 });
        }
        return Promise.resolve({ value: null, bytes: 0 });
      },

      settlePage: (tab: TabHandle): Promise<void> => {
        const failure = this.#enter({ name: 'settlePage', browser, tab });
        if (failure) return Promise.reject(failure);
        // Nothing to settle — the fake has no timing at all (see this file's
        // header). What the entry in the log proves is that the pipeline
        // asked, and *when* it asked relative to the shutter, which is the
        // whole of what `SCHEMA.md` §3.11's "every capture settles the page
        // first" is checkable as from outside a real browser.
        return Promise.resolve();
      },

      capture: (tab: TabHandle, request: CaptureRequest): Promise<RawCapture> => {
        const canned = this.#options.capture;
        const failure = this.#enter({
          name: 'capture',
          browser,
          tab,
          // The mask is recorded as a count and as the rectangles themselves:
          // "a mask was passed to the driver" and "it was *this* mask" are
          // different assertions, and §3.11's masking-before-the-shutter
          // property needs the second.
          detail: {
            fullPage: request.fullPage,
            selector: request.selector,
            mask: request.mask ? [...request.mask] : undefined,
          },
        });
        if (failure) return Promise.reject(failure);
        const width = canned?.width ?? 1280;
        const height = canned?.height ?? 720;
        return Promise.resolve({
          // A real, decodable picture by default — see `FakeCaptureOptions`.
          image: canned?.image ?? solidPng(width, height),
          width,
          height,
          viewportWidth: canned?.viewportWidth ?? width,
          url: canned?.url ?? 'https://example.com/',
        });
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
