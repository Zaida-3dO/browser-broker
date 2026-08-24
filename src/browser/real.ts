// The one place the automation library is reached from, which is what
// `driver.import_isolated` (§7.3) requires: only the browser module reaches
// the automation library. Keeping it to this file is what makes the choice
// reversible and what stops a surface driving a browser behind the service's
// back.
//
// `playwright-core` rather than the full distribution: the browser binary is
// spawned by this service, detached and by path (§1.2a), so the package that
// downloads and manages browsers would be adding a lifecycle this design
// deliberately does not have.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import { StartupRefusal } from '../errors.ts';
import { readDiscoveryRecord, verifyDiscoveryRecord } from './discovery.ts';
import type {
  ArtifactResult,
  BrowserDescription,
  BrowserDriver,
  BrowserId,
  BrowserMode,
  BrowserSession,
  ColdStartRequest,
  DiscoveryRecord,
  EvaluationResult,
  NavigationResult,
  TabHandle,
} from './driver.ts';
import { coldStartDetached, type LaunchOptions } from './launch.ts';

/**
 * The real driver: attach to a browser that is already running, and cold-start
 * one detached when none is.
 *
 * ── Which half is the ordinary one ──────────────────────────────────────
 *
 * **Attaching is the ordinary case and launching is the rare one**, which is
 * the opposite of how the two names read (`SCHEMA.md` §1.2a). Browsers are
 * **adopted, not owned**: no process here lives long enough to be a browser's
 * parent, so whichever caller finds none running starts one and everyone
 * after attaches to it. The browser outlives every process that touched it.
 *
 * ── What this file does not decide ──────────────────────────────────────
 *
 * **It does not decide which of the two to perform.** {@link attach} and
 * {@link coldStart} are separate calls because they are separate acts with
 * different risks, and nothing here makes one fall back to the other — the
 * fallback is precisely the thing that must not be automatic, because two
 * callers arriving at an empty machine at the same instant must produce **one
 * launch, not two**. That is arbitrated in the store, in the same transaction
 * that arbitrates claims (`adoption.ts`, row #54), not by whoever asked first.
 *
 * ── The operations that are declared and not implemented ────────────────
 *
 * The seam declares the whole tab surface; the rows that own the page verbs
 * are #21 through #24. Rather than half-implement them, the ones this row
 * does not own throw a refusal naming the row that brings them. That is
 * deliberate over returning a plausible empty value: a navigate that silently
 * did nothing and reported success is exactly the shape `DECISIONS.md` §5
 * calls worse than no guard.
 */

/** Thrown for a seam operation whose row has not landed. */
class NotYetImplemented extends Error {
  constructor(operation: string, row: string) {
    super(
      `The driver operation ${operation} is declared on the seam but is not implemented yet; row ${row} brings it. It refuses rather than reporting success for work it did not do.`,
    );
    this.name = 'NotYetImplemented';
  }
}

/**
 * The blank address the keeper tab sits on.
 *
 * A page that loads nothing from anywhere, holds nothing, and cannot navigate
 * itself somewhere else.
 */
export const KEEPER_TAB_URL = 'about:blank';

/**
 * How a keeper tab is told apart from a leased one.
 *
 * The keeper is identified by **the page object this session opened or
 * adopted as the keeper**, held in memory, rather than by matching on its
 * address. Matching on the address would make every caller-navigated tab that
 * happened to be blank look like the keeper — and, worse, would make the
 * keeper stop being recognisable the moment anything navigated it.
 */
interface KeeperState {
  page: Page | undefined;
}

/**
 * A session over one attached browser.
 *
 * Holds the connection, the browser's identity, and the keeper tab, and hands
 * out tab handles addressed by the driver's own name for a page.
 */
class RealBrowserSession implements BrowserSession {
  readonly #browser: BrowserId;
  readonly #mode: BrowserMode;
  readonly #pid: number;
  readonly #record: DiscoveryRecord;
  readonly #connection: Browser;
  readonly #context: BrowserContext;
  readonly #keeper: KeeperState = { page: undefined };
  /**
   * The driver's name for a page, and the page it names.
   *
   * The identifier is **never returned to a caller on any surface** — callers
   * hold the opaque lease identifier and the mapping between the two is row
   * #21's. Keeping the driver's name inside this class is what stops it
   * leaking outward by accident.
   */
  readonly #pages = new Map<string, Page>();
  #nextTabOrdinal = 0;

  constructor(options: {
    browser: BrowserId;
    mode: BrowserMode;
    pid: number;
    record: DiscoveryRecord;
    connection: Browser;
    context: BrowserContext;
  }) {
    this.#browser = options.browser;
    this.#mode = options.mode;
    this.#pid = options.pid;
    this.#record = options.record;
    this.#connection = options.connection;
    this.#context = options.context;
  }

  describe(): BrowserDescription {
    return {
      browser: this.#browser,
      mode: this.#mode,
      pid: this.#pid,
      discovery: this.#record,
    };
  }

  /** Mint a handle for a page and remember the mapping. */
  #track(page: Page): TabHandle {
    this.#nextTabOrdinal += 1;
    const driverTabId = `${this.#browser}-${String(this.#nextTabOrdinal)}`;
    this.#pages.set(driverTabId, page);
    return { browser: this.#browser, driverTabId };
  }

  async openTab(): Promise<TabHandle> {
    // The keeper tab is established before any tab is handed out, so a lease
    // can never be the only tab in the browser. `keeper.present` (§7.2) is a
    // precondition on serving, and this is where serving begins.
    await this.ensureKeeperTab();
    const page = await this.#context.newPage();
    return this.#track(page);
  }

  // Not `async`, deliberately: the connection already holds the page list, so
  // this reads it synchronously and hands back a resolved promise. Marking it
  // `async` for symmetry would claim an await that does not happen.
  listTabs(): Promise<readonly TabHandle[]> {
    // Every page open in this browser at the moment it is asked, **including
    // ones no lease of this service's owns** — row #21's reconciliation needs
    // to see a page nobody here opened in order to close it.
    const handles: TabHandle[] = [];
    for (const page of this.#context.pages()) {
      if (page === this.#keeper.page) {
        // The keeper is never counted against the budget (§3.15) and is never
        // addressable, so it does not appear in the list capacity is derived
        // from. Counting it would make the tab budget one lower than it says.
        continue;
      }
      const existing = [...this.#pages.entries()].find(([, held]) => held === page);
      handles.push(
        existing === undefined
          ? this.#track(page)
          : { browser: this.#browser, driverTabId: existing[0] },
      );
    }
    return Promise.resolve(handles);
  }

  /**
   * Establish the keeper tab if it is absent, and report it.
   *
   * **One blank, never-leased, never-addressable tab per browser, never
   * counted against the budget** (§3.15). It is a correctness mechanism and
   * not tidiness: the signed-in browser is headed, and a headed browser dies
   * within about half a second of its final tab closing — so without it, the
   * last caller to release its lease destroys the shared authenticated
   * session by doing the single most ordinary thing a caller ever does.
   *
   * **Idempotent**, because it runs on every spawn and before every grant. A
   * second call adopts the keeper already there rather than opening another
   * blank tab, which would accumulate one uncounted tab per spawn.
   */
  async ensureKeeperTab(): Promise<TabHandle> {
    const existing = this.#keeper.page;
    if (existing !== undefined && !existing.isClosed()) {
      return { browser: this.#browser, driverTabId: this.#keeperHandleId() };
    }

    // A browser this process has just attached to already has pages, and one
    // of them may be a keeper a previous caller established. Adopting one
    // rather than opening another is what keeps the count stable across the
    // many processes that attach over a browser's life.
    const adoptable = this.#context
      .pages()
      .find((page) => !page.isClosed() && page.url() === KEEPER_TAB_URL);

    this.#keeper.page = adoptable ?? (await this.#context.newPage());
    if (adoptable === undefined) {
      await this.#keeper.page.goto(KEEPER_TAB_URL);
    }

    return { browser: this.#browser, driverTabId: this.#keeperHandleId() };
  }

  /**
   * The keeper's handle identifier.
   *
   * Deliberately not registered in the page map, so {@link closeTab} cannot
   * resolve it and a caller holding it cannot close the keeper. **A caller
   * cannot close what it cannot name** (§3.13), and this is the mechanical
   * half of that: the handle exists so the service can assert the tab is
   * present and exclude it from the count, not so anything can drive it.
   */
  #keeperHandleId(): string {
    return `${this.#browser}-keeper`;
  }

  async closeTab(tab: TabHandle): Promise<void> {
    const page = this.#pages.get(tab.driverTabId);
    if (page === undefined) {
      // Includes the keeper's handle, which is never in the map. Closing is
      // best effort by design (§2.4b) — it runs after the arbitration
      // transaction has committed, so a tab that will not close is a leaked
      // tab and not a leaked lease.
      return;
    }
    this.#pages.delete(tab.driverTabId);
    await page.close();
  }

  navigate(): Promise<NavigationResult> {
    throw new NotYetImplemented('navigate', '#22');
  }

  act(): Promise<ArtifactResult> {
    throw new NotYetImplemented('act', '#22');
  }

  read(): Promise<readonly ArtifactResult[]> {
    throw new NotYetImplemented('read', '#23');
  }

  evaluate(): Promise<EvaluationResult> {
    throw new NotYetImplemented('evaluate', '#24');
  }

  /**
   * Cookie **summaries** — names, domains, paths, expiries and flags, and
   * **structurally no values**.
   *
   * Row #23 owns the read surface. What is implemented here is the part that
   * belongs to this module rather than to that row, because
   * `read.cookies_no_values` (§7.1) is a **shape** and not a refusal: a
   * service handing over cookie values is a credential-export feature
   * whatever else it is called. The values exist in this process only inside
   * this method, and they leave it in a shape with nowhere to put one — so
   * there is no later redaction step for anybody to forget.
   *
   * **The mapping is field by field on purpose.** A spread with the value
   * deleted would carry every field the automation library adds in a future
   * version, which is precisely how a value comes back without anybody
   * writing a line that says so.
   *
   * ── Why the return type is written out rather than imported ─────────────
   *
   * The named type for this shape arrives with the row that adds this member
   * to the seam. Declaring the shape structurally here means this file
   * satisfies that interface the moment it lands, without importing a name
   * this build does not yet have — and the compiler is what checks the two
   * agree, rather than a note asking somebody to remember.
   */
  async cookies(tab: TabHandle): Promise<
    readonly {
      readonly name: string;
      readonly domain: string;
      readonly path: string;
      readonly expires: string | null;
      readonly httpOnly: boolean;
      readonly secure: boolean;
      readonly sameSite: 'Strict' | 'Lax' | 'None' | null;
    }[]
  > {
    // Addressed to the tab, so a lease on one page is not a read of the whole
    // profile's jar — even though the tabs in one browser do share it (§1.2).
    const page = this.#pages.get(tab.driverTabId);
    if (page === undefined) {
      throw new Error(
        `No page is held for tab ${tab.driverTabId}. A handle is only valid in the session that opened it.`,
      );
    }

    const jar = await this.#context.cookies(page.url());

    return jar.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      // A session cookie is reported with a negative expiry; the seam asks
      // for null, so the distinction is made here rather than left as a magic
      // number for a reader to decode.
      expires: cookie.expires < 0 ? null : new Date(cookie.expires * 1000).toISOString(),
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));
  }

  /**
   * End this process's connection. **The browser is unaffected.**
   *
   * Measured: attaching and detaching are non-destructive to tabs, cookies and
   * local storage — a caller connecting and disconnecting leaves the browser
   * exactly as it found it (§1.2a). That measurement is the property the whole
   * shared-session design rests on, which is why this closes the *connection*
   * and never the browser.
   */
  async detach(): Promise<void> {
    await this.#connection.close();
  }
}

export interface RealDriverOptions {
  /** Where the browser binary is. Injected so a test can point at its own. */
  readonly executablePath?: string;
  readonly launch?: LaunchOptions;
  readonly fetchImpl?: typeof fetch;
}

/** The browser modes, fixed by which browser it is (§1.2, §3.15). */
export function modeFor(browser: BrowserId): BrowserMode {
  // The signed-in browser is headed, and that is the fact the keeper tab
  // exists for; the private one is headless and has no sign-in to lose.
  return browser === 'regular' ? 'headed' : 'headless';
}

/**
 * Connect to a browser whose endpoint has already been verified, and wrap it.
 *
 * Split out because both halves of the driver end here: a cold start verifies
 * the browser it just produced and then attaches to it exactly as an
 * attaching caller would, so there is one connection path rather than two.
 */
async function connect(options: {
  browser: BrowserId;
  record: DiscoveryRecord;
  pid: number;
}): Promise<BrowserSession> {
  const connection = await chromium.connectOverCDP(options.record.endpoint);
  const [context] = connection.contexts();
  if (context === undefined) {
    await connection.close();
    throw new StartupRefusal(
      'keeper.present',
      'The browser answered but exposes no browsing context, so there is nothing to open a tab in.',
    );
  }

  const session = new RealBrowserSession({
    browser: options.browser,
    mode: modeFor(options.browser),
    pid: options.pid,
    record: options.record,
    connection,
    context,
  });

  // `keeper.present` (§7.2): each browser has its keeper tab open **before
  // any lease is granted against it**. Establishing it here rather than
  // leaving it to the first grant is what makes the precondition true for
  // every path that reaches a browser, including the ones that never grant.
  await session.ensureKeeperTab();

  return session;
}

/**
 * The real driver.
 *
 * Holds no state between calls: every fact two callers share lives in the
 * store, and this object is constructed per process like everything else here.
 */
export class RealBrowserDriver implements BrowserDriver {
  readonly #options: RealDriverOptions;

  constructor(options: RealDriverOptions = {}) {
    this.#options = options;
  }

  #executablePath(): string {
    // Resolved lazily rather than in the constructor: a process that only
    // attaches never needs a binary path, and a driver that refused to
    // construct without one would make an attach-only caller depend on a
    // browser installation it is not going to use.
    return this.#options.executablePath ?? chromium.executablePath();
  }

  /**
   * Attach to a browser that is already running, **having checked the record
   * first**.
   *
   * The record is a claim and not a proof (§1.2c), so both checks are owed
   * before connecting: the endpoint answers, and the browser identifies itself
   * as the expected one. **Refuses rather than connecting to something it
   * cannot identify** — attaching to a stranger is worse than failing to
   * attach, because it succeeds.
   */
  async attach(browser: BrowserId, record: DiscoveryRecord): Promise<BrowserSession> {
    const expectedUuid = record.browserUuid;
    if (expectedUuid === undefined) {
      throw new StartupRefusal(
        'launch.explicit_profile_dir',
        'Attaching needs the identifier the browser reported for itself, and this record carries only an address. A record read off disk has not been checked against a live browser, and a port that answers is not the same fact as the browser that recorded it.',
      );
    }

    const outcome = await verifyDiscoveryRecord(record, expectedUuid, {
      fetchImpl: this.#options.fetchImpl,
    });

    if (!outcome.ok) {
      throw new StartupRefusal(
        'launch.explicit_profile_dir',
        `The browser recorded at ${record.endpoint} was not attached to: ${outcome.detail}`,
      );
    }

    return connect({
      browser,
      record: outcome.record,
      // The process is not this one's child — the browser was adopted, not
      // owned — so the identifier comes from the store's record of it rather
      // than from a handle this process holds.
      pid: 0,
    });
  }

  /**
   * Start a browser that is not running, **detached**, and attach to it.
   *
   * Success is an endpoint that answers, **asserted positively, never
   * inferred from the launch not failing** — see `launch.ts` for the measured
   * silent-collision case that makes the distinction load-bearing.
   */
  async coldStart(request: ColdStartRequest): Promise<BrowserSession> {
    const outcome = await coldStartDetached(
      {
        profileDirectory: request.profileDirectory,
        mode: request.mode,
        executablePath: this.#executablePath(),
      },
      { ...this.#options.launch, fetchImpl: this.#options.fetchImpl },
    );

    return connect({
      browser: request.browser,
      record: outcome.record,
      pid: outcome.pid,
    });
  }
}

/**
 * Read a profile's record and say whether a browser is actually running
 * against it.
 *
 * The question the launch race asks before it decides anything (#54), and it
 * is deliberately **not** a method on the driver: it answers *is one running*,
 * which is a question about the world, whereas the driver's two members are
 * acts performed on it.
 */
export async function browserIsRunning(
  profileDir: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<DiscoveryRecord | undefined> {
  const found = readDiscoveryRecord(profileDir);
  if (found === undefined) {
    return undefined;
  }
  const outcome = await verifyDiscoveryRecord(found.record, found.expectedUuid, {
    fetchImpl: options.fetchImpl,
  });
  // A record that fails either check is stale: the browser is treated as not
  // running, and whichever caller notices takes the launch race (§1.2c).
  return outcome.ok ? outcome.record : undefined;
}
