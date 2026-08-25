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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Dialog,
  type Page,
  type Request,
} from 'playwright-core';

import { slugFromUrl, stampFromInstant } from '../artifacts/names.ts';
import { BrokerError, StartupRefusal } from '../errors.ts';
import { readDiscoveryRecord, verifyDiscoveryRecord } from './discovery.ts';
import type {
  ActionRequest,
  ArtifactResult,
  BrowserDescription,
  BrowserDriver,
  BrowserId,
  BrowserMode,
  BrowserSession,
  CaptureRequest,
  ColdStartRequest,
  CookieSummary,
  DiscoveryRecord,
  EvaluationResult,
  NavigationResult,
  RawCapture,
  ReadArtifact,
  StorageSeedEntry,
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
 * **There are none left.** The seam declares the whole tab surface and every
 * member of it is implemented here against the automation library. Rows #21
 * through #24 owned the page verbs; the last two to land were {@link
 * RealBrowserSession.act} (#22, with #61–#64) and {@link
 * RealBrowserSession.read} (#23), which until then threw a refusal naming the
 * row that would bring them rather than returning a plausible empty value — a
 * verb that silently did nothing and reported success being exactly the shape
 * `DECISIONS.md` §5 calls worse than no guard.
 *
 * **What is still not decided here is where the files go.** `act` and `read`
 * hand back paths, so this file writes files; the directory it writes them
 * into is supplied from outside and never chosen here. See
 * {@link RealDriverOptions.outputDirectory}.
 */

/**
 * The pixel dimensions a PNG declares about itself.
 *
 * ── Why this reads eight bytes instead of importing a decoder ────────────
 *
 * `captures.source_*` is *what the browser produced*, and the only place that
 * is stated without inference is the image header. A full-page capture is
 * taller than the viewport by definition, so measuring the page instead would
 * be wrong in exactly the case those fields exist to describe.
 *
 * The repository already has a real decoder, and this deliberately does not
 * call it: **the capture pipeline owns decoding, and the browser module owns
 * driving a browser.** Reaching across for two integers would put a second
 * consumer on that module and make an isolation rule a matter of habit rather
 * than of imports. Reading a fixed-offset header is smaller than the import
 * it avoids, and it decodes nothing — the pixels are never touched here.
 *
 * Returns `undefined` rather than throwing on anything that is not a PNG: the
 * caller has a page-measured fallback, and a capture that succeeded should not
 * be turned into a failure by a header this function did not recognise.
 */
function readPngDimensions(image: Uint8Array): { width: number; height: number } | undefined {
  // Signature, then a 4-byte length, then the type `IHDR`, then width and
  // height as big-endian 32-bit integers: 24 bytes before either is complete.
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (image.length < 24) {
    return undefined;
  }
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (image[index] !== SIGNATURE[index]) {
      return undefined;
    }
  }

  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The blank address the keeper tab sits on.
 *
 * A page that loads nothing from anywhere, holds nothing, and cannot navigate
 * itself somewhere else.
 */
export const KEEPER_TAB_URL = 'about:blank';

/**
 * How long a single attempt to resolve an element reference may take, in
 * milliseconds.
 *
 * ── Why this exists at all ──────────────────────────────────────────────
 *
 * Without it the wait is the automation library's **default action timeout**,
 * which is thirty seconds and is the right length for the question it was
 * chosen to answer — *is this element going to appear* — and the wrong length
 * for the one asked here, which is *does this connection know this reference*.
 * A connection that has taken no snapshot never will, and waiting thirty
 * seconds to say so was measured: 30.5 seconds for a command-line action whose
 * reference was minted in the previous process.
 *
 * ── Why this number ─────────────────────────────────────────────────────
 *
 * Long enough that an element still being attached by the page's own scripts
 * is found rather than declared missing; short enough that the whole failure
 * path — a bounded attempt, a snapshot, a second bounded attempt — is a thing
 * a caller waits through rather than a thing it times out on. It is a bound on
 * *resolution only*: once a reference resolves, the verb runs under the
 * library's ordinary timeouts, so nothing here shortens how long a click may
 * take to complete.
 */
export const REFERENCE_RESOLUTION_MS = 250;

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
 * What the browsing context has been recording about one page since the moment
 * that page existed.
 *
 * ── Why this is accumulated rather than fetched ─────────────────────────
 *
 * `SCHEMA.md` §3.9 asks for this to be **understood rather than merely
 * obeyed**, and {@link ARTIFACT_COLLECTION} puts it on the seam as data:
 * console output and network activity are recorded continuously by the
 * browsing context, whether or not anybody intends to ask. There is no request
 * that starts or stops the collection.
 *
 * **So `read`'s filter is a write-time filter and not a fetch-time one.** The
 * question a caller's artefact list answers is *do we serialise this into a
 * file and hand back a path*, not *do we start collecting*. That is the whole
 * reason **the cost of not asking is zero**: a caller that realises afterwards
 * that it wanted the console asks on its next read and gets the accumulated
 * history from the start of the context, not a recording that began at the
 * moment of asking.
 *
 * Which is also why there is **no console-listener action on `browser_act`**
 * and no hole where one would go: *arm, act, collect* is served by *act, then
 * read*. The listeners here are attached when the page is first tracked —
 * before any lease could have asked for anything — which is what makes that
 * claim true rather than aspirational.
 *
 * **Cookies are deliberately not in here.** They are the one live query
 * ({@link ARTIFACT_COLLECTION}), answered against the context at the moment of
 * asking, and they are served by {@link RealBrowserSession.cookies} — which
 * returns a shape with no value field. Accumulating them here would mean this
 * process held cookie values, which is the thing §7.1 `read.cookies_no_values`
 * exists to prevent.
 */
interface PageRecording {
  readonly console: string[];
  readonly network: string[];
}

/**
 * How the next native dialog on a page will be answered.
 *
 * ── Why this is a standing disposition and not "answer the dialog up now" ──
 *
 * **Measured while building this row, and it decides the shape of the whole
 * verb.** A native dialog blocks its tab (§3.8) — and the blocking is more
 * total than that description suggests: it blocks *the very action that raised
 * it*. With a dialog held unanswered, the `click` that triggered it never
 * returns and fails on its own timeout:
 *
 * ```
 * CLICK FAILED: page.click: Timeout 2000ms exceeded.
 * ```
 *
 * So a `dialog` action meaning *"answer the dialog already on screen"* is
 * unimplementable in principle rather than merely awkward: by the time a
 * caller could send it, the {@link RealBrowserSession.act} call that raised
 * the dialog has already hung and taken the lease with it. That is exactly the
 * capacity failure §3.8 puts this verb here for, and an implementation that
 * answered late would be one that never runs.
 *
 * Hence: `dialog` records **how the next one will be answered**, and the
 * caller arms it before the action that trips it. Measured working on both
 * paths — an armed accept makes the page's `confirm()` return `true`, an armed
 * dismissal makes it return `false`, and an armed accept with prompt text puts
 * that text into the page's `prompt()` result.
 *
 * **A page with no disposition set is left to the automation library's own
 * default, which dismisses.** That default is why an unhandled dialog does not
 * strand a tab in practice, and it is stated here so the absence of a handler
 * reads as a decision rather than an oversight.
 */
interface DialogDisposition {
  readonly accept: boolean;
  readonly promptText?: string;
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

  /**
   * How many artefacts this session has written, used to keep their names
   * apart.
   *
   * ── Why a counter is needed on top of the timestamp ─────────────────────
   *
   * **Measured, driving the real browser through every verb: without this,
   * roughly twenty writes produced four files.** The stamp `names.ts` supplies
   * is second-granular, and every other part of an artefact's name — the
   * address slug, which artefact it is, the tab it came from — is identical
   * for two actions against one tab. So a run of actions inside one second all
   * assembled the *same* name and silently overwrote each other.
   *
   * That is not a tidiness problem. {@link RealBrowserSession.act} promises a
   * **fresh snapshot after every change**, and the promise is worthless if the
   * path it hands back has been overwritten by the next action before the
   * caller reads it: two results would name one file, and the earlier state
   * would be gone with nothing reporting that it had been.
   *
   * A monotonic counter rather than a random identifier, which is where this
   * departs from `captureFileName`'s fifth part: captures are written by many
   * processes into one lease's directory and need uniqueness *without
   * coordination*, whereas these are written by one session that can simply
   * count. Counting also leaves a directory listing in the order the actions
   * happened, which is what makes a sequence of snapshots readable as a
   * sequence.
   */
  #artifactsWritten = 0;

  /**
   * What the context has recorded for each page it handed out, keyed by the
   * driver's own name for that page.
   *
   * Keyed by the handle rather than held on the page so that a page closing
   * does not take its own history with it: a caller may read the console of a
   * tab whose last action closed something, and the accumulated log is the
   * only place that history exists.
   */
  readonly #recordings = new Map<string, PageRecording>();

  /** How the next dialog on each page will be answered. See {@link DialogDisposition}. */
  readonly #dialogs = new Map<string, DialogDisposition>();

  /**
   * The pages this connection has registered element references against.
   *
   * ── Why this is remembered rather than recomputed ───────────────────────
   *
   * A reference resolves only in a connection that has snapshotted the page,
   * and this service is daemonless — so the first action in a spawned process
   * always reaches a page with no registration. {@link #locate} establishes it
   * on first contact, and this is what tells it that the first contact has
   * happened. **Asking the page instead is not available**: an unregistered
   * reference and a reference whose element is gone both simply fail to
   * resolve, so a lookup cannot distinguish the two and the whole point of
   * remembering is to distinguish them. See {@link #locate}.
   *
   * Keyed by the page object rather than by the tab's name, and **weakly**: a
   * page that closes is collectable with nothing here keeping it alive, which
   * matters because a session may outlive many tabs. Membership means only
   * *this connection has snapshotted this page at least once* — the reference
   * engine's own registrations are what actually resolve anything.
   */
  readonly #referenced = new WeakSet<Page>();

  /** Where this session writes the files `act` and `read` hand back paths to. */
  readonly #outputDirectory: string;

  constructor(options: {
    browser: BrowserId;
    mode: BrowserMode;
    pid: number;
    record: DiscoveryRecord;
    connection: Browser;
    context: BrowserContext;
    outputDirectory?: string;
  }) {
    this.#browser = options.browser;
    this.#mode = options.mode;
    this.#pid = options.pid;
    this.#record = options.record;
    this.#connection = options.connection;
    this.#context = options.context;
    // Defaulted to a directory of this session's own rather than to the
    // artifact tree, because **this module does not know where the artifact
    // tree is and must not**: §1.7a puts "the service decides where the file
    // may go" in `artifacts/store.ts`, and a driver that reached for that
    // store would be a second thing choosing locations under the root. The
    // caller supplies a directory; this file only ever fills in a leaf.
    this.#outputDirectory =
      options.outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'broker-artifacts-'));
  }

  describe(): BrowserDescription {
    return {
      browser: this.#browser,
      mode: this.#mode,
      pid: this.#pid,
      discovery: this.#record,
    };
  }

  /**
   * Mint a handle for a page and remember the mapping.
   *
   * ── The identifier is the browser's, and that is the whole point ────────
   *
   * `driver_tab_id` is specified as a **physical** identity: the store carries
   * `CREATE UNIQUE INDEX one_row_per_physical_tab ON tabs (browser_id,
   * driver_tab_id)`, whose own comment says the rule exists because "across
   * separate processes this is not one option among several — there is no
   * shared process to hold a lock in". So the name has to mean the same thing
   * in every process that connects to one browser.
   *
   * **A counter cannot do that.** A per-session ordinal names the first page
   * this connection happened to see, which is a fact about the connection
   * rather than about the page: a second process attaching to the same browser
   * either gives the same page a different name, or gives a *different* page
   * the same name because it enumerated in a different order. Both are worse
   * than they sound in a service that is spawned per caller and exits with it
   * — a fresh process is the ordinary case, not an edge one, so the ordinary
   * case is a caller unable to address the tab its own lease owns.
   *
   * The debugging protocol already assigns every page a stable identifier that
   * every connection sees identically, so that is what is used. Verified
   * against a live browser: the same page reports the same identifier from a
   * second, independent connection, and the keeper reports a different one.
   *
   * It stays inside this class exactly as the ordinal did — never returned to
   * a caller on any surface — so nothing about what is disclosed changes.
   */
  async #track(page: Page): Promise<TabHandle> {
    const driverTabId = await this.#identify(page);
    this.#pages.set(driverTabId, page);
    this.#recordFrom(driverTabId, page);
    return { browser: this.#browser, driverTabId };
  }

  /**
   * Ask the browser what it calls this page.
   *
   * A short protocol session, opened and detached around the one question. It
   * is not held open: the identifier does not change, so there is nothing to
   * keep listening for, and a session per page held for the life of a
   * connection is a resource this class would have to reason about.
   */
  async #identify(page: Page): Promise<string> {
    const cdp = await this.#context.newCDPSession(page);
    try {
      const info = (await cdp.send('Target.getTargetInfo')) as {
        targetInfo: { targetId: string };
      };
      return info.targetInfo.targetId;
    } finally {
      // Best effort: a page that closed under us cannot be detached from, and
      // the session dies with it either way.
      await cdp.detach().catch(() => undefined);
    }
  }

  /**
   * Find a live page by the browser's own name for it, adopting it if this
   * session has not seen it before.
   *
   * **This is what makes a tab addressable by the process that did not open
   * it.** Without it, a handle really would be "only valid in the session that
   * opened it", and a command line that spawns a process per command could
   * drive a page exactly once — on the call that created it.
   *
   * Nothing is trusted from the caller here: the identifier is matched against
   * pages **the browser reports as open**, so a name that matches nothing
   * resolves to nothing. The keeper is excluded, so it stays unaddressable
   * (§3.13) by the same rule that keeps it out of {@link listTabs}.
   */
  async #adopt(driverTabId: string): Promise<Page | undefined> {
    for (const page of this.#context.pages()) {
      if (page.isClosed() || page === this.#keeper.page) {
        continue;
      }
      if ((await this.#identify(page)) !== driverTabId) {
        continue;
      }
      this.#pages.set(driverTabId, page);
      this.#recordFrom(driverTabId, page);
      return page;
    }
    return undefined;
  }

  /**
   * Begin accumulating this page's console and network activity.
   *
   * **Attached here — at the moment the page is first named — rather than when
   * a read asks for it**, and that ordering is the whole of §3.9's "the cost of
   * not asking is zero". A listener attached on demand would collect from the
   * moment of asking, which is precisely the *arm, act, collect* shape §3.9
   * says is not needed and deliberately does not offer. See
   * {@link PageRecording}.
   *
   * The entries are text rather than structures because what leaves this
   * module is a **file**, and a file is text. Shaping them here keeps the
   * serialisation in one place rather than splitting the format between the
   * collector and the writer.
   */
  #recordFrom(driverTabId: string, page: Page): void {
    if (this.#recordings.has(driverTabId)) return;
    const recording: PageRecording = { console: [], network: [] };
    this.#recordings.set(driverTabId, recording);

    page.on('console', (message: ConsoleMessage) => {
      recording.console.push(`${message.type()}: ${message.text()}`);
    });
    page.on('request', (request: Request) => {
      recording.network.push(`${request.method()} ${request.url()}`);
    });

    // A dialog blocks its tab until something answers it, so a page with no
    // handler at all would hand that decision to the automation library's
    // default. The handler is installed once, here, and consults the standing
    // disposition — which is what makes the `dialog` verb able to be armed
    // *before* the action that trips one. See {@link DialogDisposition}.
    page.on('dialog', (dialog: Dialog) => {
      const disposition = this.#dialogs.get(driverTabId);
      // Consumed rather than left in place: a disposition is an answer to the
      // next dialog, not a standing policy for the tab. Leaving it set would
      // make one armed accept silently answer every later dialog, including
      // ones a caller never anticipated.
      this.#dialogs.delete(driverTabId);

      // Answering is best effort: a dialog whose page has already gone rejects
      // here, and there is nobody left for that to be an error to.
      if (disposition === undefined || !disposition.accept) {
        void dialog.dismiss().catch(() => undefined);
        return;
      }
      void dialog.accept(disposition.promptText).catch(() => undefined);
    });
  }

  /**
   * The page a handle names.
   *
   * The keeper's handle is deliberately absent from this map, so every
   * operation that resolves through here is structurally unable to address it
   * — **a caller cannot drive what it cannot name** (§3.13).
   */
  async #page(tab: TabHandle): Promise<Page> {
    const held = this.#pages.get(tab.driverTabId);
    if (held !== undefined && !held.isClosed()) {
      return held;
    }

    // Not in this session's map, which is the ordinary state of a process that
    // did not open the tab. The name is the browser's own (see {@link #track}),
    // so it can be looked for among the pages the browser reports as open.
    const adopted = await this.#adopt(tab.driverTabId);
    if (adopted !== undefined) {
      return adopted;
    }

    throw new Error(
      `No page is open in the ${this.#browser} browser for tab ${tab.driverTabId}. The page it named has closed, or it belongs to a different browser.`,
    );
  }

  async openTab(): Promise<TabHandle> {
    // The keeper tab is established before any tab is handed out, so a lease
    // can never be the only tab in the browser. `keeper.present` (§7.2) is a
    // precondition on serving, and this is where serving begins.
    await this.ensureKeeperTab();
    const page = await this.#context.newPage();
    return await this.#track(page);
  }

  /**
   * Every page open in this browser at the moment it is asked, **including
   * ones no lease of this service's owns** — row #21's reconciliation needs to
   * see a page nobody here opened in order to close it.
   *
   * `async` because naming a page means asking the browser what it calls it,
   * which is a round trip. It reported a resolved promise while the name was a
   * local counter; the name is now the browser's, and the await is real.
   */
  async listTabs(): Promise<readonly TabHandle[]> {
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
          ? await this.#track(page)
          : { browser: this.#browser, driverTabId: existing[0] },
      );
    }
    return handles;
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

  /**
   * Point a tab at an address and report where it actually ended up.
   *
   * The address after redirects rather than the one asked for, because those
   * differ constantly and the caller needs the one it got.
   */
  async navigate(tab: TabHandle, url: string): Promise<NavigationResult> {
    const page = await this.#page(tab);
    const response = await page.goto(url);
    return {
      url: page.url(),
      title: await page.title(),
      // Null when the navigation produced no response to have a status from —
      // which is the ordinary case for an address the browser satisfies
      // without a request.
      status: response?.status() ?? null,
    };
  }

  /**
   * Write storage entries into their origins, **before the tab's first
   * navigation** (§3.2, row #65).
   *
   * ── How the values reach storage, and why it is not an evaluation ───────
   *
   * The obvious implementation is an init script — a program the browser runs
   * before each load — built by interpolating the caller's key and value into
   * source text. **That is exactly what is not done here**, because building
   * a program out of a caller's bytes is the interpreting position this whole
   * argument exists to avoid, and it would be one string-escaping bug away
   * from the arbitrary-code verb §9.4 measured being abused.
   *
   * Instead the page is brought to the entry's origin — which is the only way
   * a browser will let anything write that origin's storage, since storage is
   * partitioned by origin and there is no cross-origin write — and the value
   * is written by a **fixed function with its arguments passed as data**,
   * never concatenated into program text.
   *
   * **The parameterisation is the whole property and it is worth being
   * precise about it.** The expression below is a fixed string literal that
   * this file contains in full; it never varies with the entry. The area, the
   * key and the value travel as an argument object, which the library
   * serialises and the browser deserialises as data. A caller's value is
   * therefore a `string` on both sides of that boundary and is never part of
   * the program text — so **there is no position in this call in which a
   * caller's bytes could be read as a program**, which is the claim §3.2
   * makes structurally rather than as a promise.
   *
   * ── The honest limits ───────────────────────────────────────────────────
   *
   * - **The navigation to the origin is real.** Seeding an origin means
   *   visiting it, so the page does load once before the caller's own first
   *   navigation. That is not hidden: it is a request the site sees, and a
   *   caller seeding an origin it does not intend to visit should know it
   *   will be visited.
   * - **Storage is per-origin, so entries are grouped and applied per
   *   origin.** Two origins mean two navigations.
   * - **This does not sandbox the value.** It prevents the argument being a
   *   code channel; it does not make a credential in a shared browser private.
   *   See the seam's own note.
   */
  async seedStorage(tab: TabHandle, entries: readonly StorageSeedEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const page = await this.#page(tab);

    // Grouped by origin because storage is partitioned by origin: a write has
    // to happen while the page is *at* that origin, so one navigation per
    // origin is the minimum and doing it per entry would be the same
    // navigation repeated.
    const byOrigin = new Map<string, StorageSeedEntry[]>();
    for (const entry of entries) {
      const group = byOrigin.get(entry.origin);
      if (group === undefined) {
        byOrigin.set(entry.origin, [entry]);
      } else {
        group.push(entry);
      }
    }

    for (const [origin, group] of byOrigin) {
      await page.goto(origin);
      await page.evaluate(
        // A fixed program. It closes over nothing and interpolates nothing —
        // every value it acts on arrives in the argument below, as data.
        // Changing this to a template literal that embeds an entry would
        // reintroduce exactly the evaluation this argument exists to avoid.
        (items: readonly { area: 'local' | 'session'; key: string; value: string }[]) => {
          // The stores are reached through a typed local rather than through
          // globals, because this project compiles without the browser type
          // library — the same convention `settlePage` uses and for the same
          // reason: this function runs in the page, so the compiler here has
          // no reason to know those names.
          const scope = globalThis as unknown as {
            localStorage: { setItem: (key: string, value: string) => void };
            sessionStorage: { setItem: (key: string, value: string) => void };
          };
          for (const item of items) {
            const store = item.area === 'local' ? scope.localStorage : scope.sessionStorage;
            // `setItem` takes a key and a string. This is the interface §3.2
            // names, and it is the reason a seeded value cannot be a program:
            // there is no argument here that anything parses.
            store.setItem(item.key, item.value);
          }
        },
        group.map((entry) => ({ area: entry.area, key: entry.key, value: entry.value })),
      );
    }
  }

  /**
   * Perform one page verb, and hand back **a fresh snapshot of the page as it
   * now is** (`SCHEMA.md` §3.8, rows #22, #61, #62, #63, #64).
   *
   * ── Why the snapshot comes back from an action at all ───────────────────
   *
   * Every element reference a caller can use comes from a snapshot, so a
   * caller acting twice against one snapshot is acting against a page that no
   * longer matches it — and §3.8 names a stale reference as **the most common
   * cause of an action landing on the wrong element**. Returning the page as
   * it is now is what makes the next action addressable, which is why it is
   * not an option and not an artefact list: an action returns one snapshot.
   *
   * ── Why this switches on the verb rather than reading optional fields ────
   *
   * {@link ActionRequest} is a **discriminated union over the verb**, and the
   * union exists because the verbs need genuinely different arguments: a
   * resize takes two integers and addresses no element, an emulate takes three
   * independent enums, a dialog a boolean and a string, a `fill_form` a list,
   * a `drag` a **second** reference. A flat read of `ref?` and `value?` would
   * be the shape the seam's own note rejects — it would make *"which fields
   * does this verb require"* a run-time question in every implementation, and
   * it would silently drop every argument belonging to a verb added later.
   *
   * So the switch below is exhaustive over the discriminant, and the compiler
   * is what keeps it exhaustive: a verb added to the union without a case here
   * fails the type check rather than falling through to a default that did
   * something plausible.
   *
   * ── What this method does NOT refuse, stated because the absence matters ─
   *
   * **The conventional refusals are not here, and their absence is not an
   * oversight.** A zero width, a negative height, an empty reference, an
   * emulate naming no preference, prompt text accompanying a dismissal, an
   * over-long field list — every one of those is refused by `validateAction`
   * in the service layer, before a request is ever shaped into this union. The
   * seam's own note draws that line: the compiler owns the structural set, the
   * guard owns the conventional set. Re-checking them here would put the same
   * rule in two places and let them disagree.
   *
   * What *is* owed here is the refusal for **a reference that does not
   * resolve** (§3.8), because whether an element is on the page is not a fact
   * any validator upstream can know.
   */
  async act(tab: TabHandle, request: ActionRequest): Promise<ArtifactResult> {
    const page = await this.#page(tab);

    switch (request.action) {
      case 'click':
        await (await this.#locate(page, request.ref)).click();
        break;

      case 'hover':
        await (await this.#locate(page, request.ref)).hover();
        break;

      case 'check':
        // `check` rather than `click`: it asserts the box ends up checked and
        // is a no-op on one already checked, where a click would toggle it
        // off. A caller asking for `check` twice means the box is checked.
        await (await this.#locate(page, request.ref)).check();
        break;

      case 'type':
        // Keystroke by keystroke, which is what distinguishes it from `fill`:
        // a field that reacts to each key — a combo box filtering as it goes,
        // a validator running per character — sees the keys it would see from
        // a person.
        await (await this.#locate(page, request.ref)).pressSequentially(request.value);
        break;

      case 'fill':
        // Sets the value in one step. The ordinary way to put text in a field.
        await (await this.#locate(page, request.ref)).fill(request.value);
        break;

      case 'select':
        await (await this.#locate(page, request.ref)).selectOption(request.value);
        break;

      case 'press':
        // The reference is optional, and the two branches are different acts
        // rather than one with a default: with a reference the key goes to
        // that element, without one it goes to whatever the page has focused,
        // which is how a caller sends a key to a page rather than to a field.
        if (request.ref === undefined) {
          await page.keyboard.press(request.value);
        } else {
          await (await this.#locate(page, request.ref)).press(request.value);
        }
        break;

      case 'scroll':
        if (request.ref === undefined) {
          // The page. A fixed expression with nothing interpolated into it —
          // the same convention `seedStorage` and `settlePage` use, and for
          // the same reason: it runs in the page, so the compiler here has no
          // reason to know those names.
          await page.evaluate(() => {
            const scope = globalThis as unknown as {
              scrollBy: (x: number, y: number) => void;
              innerHeight: number;
            };
            scope.scrollBy(0, scope.innerHeight);
          });
        } else {
          await (await this.#locate(page, request.ref)).scrollIntoViewIfNeeded();
        }
        break;

      case 'resize':
        // #61, and **the measured reason this verb is on the list**: 578 calls
        // across 140 sessions, 58% of every session that drove a browser at
        // all. A viewport is a property of the browsing context rather than of
        // anything in the page, so `browser_evaluate` cannot reach it — an
        // expression can read the dimensions and cannot change the window they
        // describe. Without this call the measured dominant loop (resize →
        // navigate → evaluate → capture, once per breakpoint) is not merely
        // awkward: responsive review is **inexpressible**.
        //
        // The bounds are the service's (`MAX_VIEWPORT_SIDE`), already applied.
        await page.setViewportSize({
          width: request.viewport.width,
          height: request.viewport.height,
        });
        break;

      case 'emulate':
        // #62. Each preference is set only when the caller named it, because
        // they are independent: a caller switching to dark mode is not saying
        // anything about motion or contrast, and passing `undefined` for the
        // two it did not mention is what leaves them as they were rather than
        // resetting them.
        await page.emulateMedia({
          ...(request.preferences.colourScheme === undefined
            ? {}
            : { colorScheme: request.preferences.colourScheme }),
          ...(request.preferences.reducedMotion === undefined
            ? {}
            : { reducedMotion: request.preferences.reducedMotion }),
          ...(request.preferences.forcedColours === undefined
            ? {}
            : { forcedColors: request.preferences.forcedColours }),
        });
        break;

      case 'dialog':
        // #63. **Arms the answer for the next dialog; it does not answer one
        // already up** — which is not a shortcut but the only implementable
        // reading, because an unanswered dialog blocks the very action that
        // raised it. See {@link DialogDisposition} for the measurement.
        this.#dialogs.set(tab.driverTabId, {
          accept: request.response.accept,
          ...(request.response.promptText === undefined
            ? {}
            : { promptText: request.response.promptText }),
        });
        break;

      case 'fill_form': {
        // #64, measured at 78 calls across 35 sessions — the ordinary half of
        // this row. Sequential rather than concurrent, deliberately: fields
        // routinely depend on each other (a second field that only appears
        // once the first is filled, a form that revalidates on every change),
        // and filling them in parallel would race against the page's own
        // reaction to the previous field.
        for (const field of request.fields) {
          await (await this.#locate(page, field.ref)).fill(field.value);
        }
        break;
      }

      case 'drag':
        // #64, and **measured at zero calls across 2,007 transcripts in a
        // month** — not "few", none. Implemented so the number that justified
        // its low priority can be argued with rather than defended, and
        // deliberately given no more machinery than the one call it needs.
        //
        // **In-page, element to element.** Both references come from the same
        // snapshot; there is no file-from-the-desktop shape here, because a
        // lease is a tab and the desktop is not in it.
        //
        // **Both references are resolved before either is used**, so a drag
        // naming one good reference and one stale one refuses rather than
        // picking the element up and dropping it nowhere.
        await (
          await this.#locate(page, request.ref)
        ).dragTo(await this.#locate(page, request.targetRef));
        break;
    }

    // A fresh snapshot **after** the change, for the reason at the top of this
    // method. It is taken for every verb including the ones that address no
    // element: a resize reflows the page and an emulate can change what it
    // renders outright, so the references a caller holds are exactly as stale
    // after those two as after a click. §3.8 says so of `emulate` explicitly.
    return this.#writeSnapshot(tab, page);
  }

  /**
   * The element a reference names, or a refusal that says where it should have
   * come from.
   *
   * ── Why the reference is resolved rather than interpreted ───────────────
   *
   * A reference is a name the **snapshot** minted (`[ref=e12]`), and it is
   * looked up through the automation library's own reference engine. That is
   * the point: this file never turns a caller's bytes into a selector it then
   * evaluates. A caller's reference is matched against references the browser
   * itself handed out, so a reference that names nothing resolves to nothing
   * rather than to whatever a hand-built selector would have matched.
   *
   * ── Why resolution is attempted here rather than left to the verb ───────
   *
   * **The reference engine is populated per connection, and this service is
   * daemonless.** A snapshot registers its references against the connection
   * that took it; a caller running one command per process reads references in
   * one process and acts on them in the next, which reaches a connection that
   * has taken no snapshot and therefore knows no references at all. That is
   * the ordinary arrangement on the command line, not an edge case.
   *
   * Left to the verb, that lookup does not fail — it **waits**, for the whole
   * of the automation library's default action timeout, and only then reports
   * a failure whose text is about the element not appearing. Measured at 30.5
   * seconds for a reference that could never have resolved. So the wait is
   * bounded here instead, and the refusal names the reference rather than the
   * timeout.
   *
   * ── The snapshot is taken ONCE PER PAGE, and only when this connection has
   *    never taken one ───────────────────────────────────────────────────
   *
   * Two measured facts about the reference engine decide the shape here, and
   * they pull in opposite directions.
   *
   * **Within one connection, a reference is bound to an element and stays
   * bound to it.** Snapshotting a second time does not renumber: on a page of
   * heading `e3`, button `e4`, textbox `e5`, removing the button and
   * snapshotting again leaves the textbox `e5` and leaves `e4` resolving to
   * nothing. So inside a connection, a reference going stale is *reported* as
   * a reference going stale, which is what a caller needs.
   *
   * **Across connections, the names are assigned afresh from the tree's
   * current shape.** The same removal seen by a connection that had never
   * snapshotted the page yields heading `e3`, **textbox `e4`** — the textbox
   * inherits the removed button's name.
   *
   * Taking the snapshot is what makes the cross-process case work at all: a
   * connection that has snapshotted nothing knows no references, and every
   * `act` from a freshly spawned process was in that state.
   *
   * ── Why it is taken up front rather than on the failure path ────────────
   *
   * The obvious alternative is to try the lookup first and snapshot only when
   * it fails, which saves a round trip on every action after the first.
   * **Measured, that alternative behaves identically** — the renumbering above
   * happens only on a connection's *first* snapshot, and once a page has been
   * registered here a further snapshot never revives or re-points a reference
   * whose element has gone. So it is not the hazard it looks like.
   *
   * It is not used because its safety rests on that last fact, which is a
   * detail of the automation library established by measurement rather than by
   * documentation, and which nothing would fail if a future version changed.
   * Registering before the first lookup makes the guarantee structural
   * instead: by the time any lookup runs, this connection's references
   * describe the page, so a reference that does not resolve has genuinely gone
   * — and that stays true however the engine renumbers. The cost is the same
   * one snapshot per page per connection either way.
   *
   * So the first action against a page pays one round trip, every action after
   * it pays none, and the staleness a caller must be told about is preserved
   * rather than papered over. The protection against acting on a page that
   * moved underneath you is unchanged and lives where it always did: every
   * action hands back a fresh snapshot ({@link act}).
   */
  async #locate(page: Page, ref: string): Promise<ReturnType<Page['locator']>> {
    // `aria-ref` is the engine that resolves the identifiers an AI-mode aria
    // snapshot mints, which is the same snapshot {@link #writeSnapshot}
    // writes and hands a path to. The two halves are deliberately the same
    // mechanism: a reference a caller read out of our snapshot file is a
    // reference this resolves, and there is no translation step in between to
    // get wrong.
    //
    // Once per page, before the first lookup against it — so that what follows
    // is a question about the page rather than about this connection's
    // history. See the note above for why it is not repeated.
    if (!this.#referenced.has(page)) {
      this.#referenced.add(page);
      await page.locator('html').ariaSnapshot({ mode: 'ai' });
    }

    const locator = page.locator(`aria-ref=${ref}`);
    if (await this.#resolves(locator)) {
      return locator;
    }

    // **Nothing, so this refuses rather than proceeding.** An action on an
    // unresolvable reference must not report success: a verb that accepted and
    // did nothing is the defect this whole path exists to remove. The throw
    // leaves `pageDriven` false — the flag is set by the last statement of the
    // after-commit closure, which this never reaches — so the caller is told
    // the page was not driven, and told why.
    throw new BrokerError(
      'act.ref_resolves',
      `No element on this page matches the reference "${ref}". References are minted by a snapshot and describe the page as it was when that snapshot was taken, so a reference goes stale when the page changes underneath it. Read the page again and use a reference from the snapshot that read returns.`,
    );
  }

  /**
   * Whether a reference names something on the page **now**, answered within a
   * bound.
   *
   * ── Why a bounded wait rather than a count ──────────────────────────────
   *
   * Counting the matches would answer immediately and would answer the wrong
   * question on a page that is still settling: an element arriving a moment
   * later is present, and a check that ran before it arrived would refuse a
   * reference that was about to be perfectly good. So this waits — but for a
   * *short* bound of its own rather than the action timeout, because the case
   * it is distinguishing is a reference that was never registered in this
   * connection, and no amount of waiting fixes that one.
   *
   * The bound is deliberately far below the automation library's default
   * action timeout of thirty seconds, which is the length a lookup takes to
   * fail when nothing bounds it. What follows a `false` here is a refusal, so
   * an unresolvable reference costs one of these and is answered well inside a
   * second.
   *
   * Attached is not required, only present: `attached` is the weakest state
   * that means *the reference resolves to an element*, and the stronger states
   * are the verb's business. A disabled button, an element scrolled out of
   * view or one covered by an overlay is a reference that resolved and an
   * action that should fail on its own terms, with the automation library's
   * own message about why — not one this misreports as an unknown reference.
   */
  async #resolves(locator: ReturnType<Page['locator']>): Promise<boolean> {
    try {
      await locator.waitFor({ state: 'attached', timeout: REFERENCE_RESOLUTION_MS });
      return true;
    } catch {
      // The only thing a failure here means is *not attached within the
      // bound*, which is the question being asked. It is not reported: the
      // caller gets the refusal below it, which names the reference.
      return false;
    }
  }

  /**
   * Write the page's accessibility tree and report where it went.
   *
   * **The AI mode is what mints the element references** (`[ref=e12]`), and
   * that is why it is used rather than the plain rendering: §3.9 calls the
   * snapshot the only load-bearing artefact precisely because every reference
   * `browser_act` takes comes from it. A snapshot without references would be
   * readable and useless.
   */
  async #writeSnapshot(tab: TabHandle, page: Page): Promise<ArtifactResult> {
    const snapshot = await page.locator('html').ariaSnapshot({ mode: 'ai' });
    return this.#write(tab, 'snapshot', page.url(), snapshot);
  }

  /**
   * Write the requested artefacts to disk and report where each went
   * (`SCHEMA.md` §3.9, row #23).
   *
   * ── The snapshot is the default because it is the only load-bearing one ──
   *
   * Console output, network activity and the cookie summary answer questions a
   * caller has sometimes and most callers never have at all. The snapshot is
   * what a caller needs in order to act at all. Which artefacts arrive here is
   * the service's decision (`resolveReadArtifacts` always includes the
   * snapshot); what this does is honour the list it is given, in the order it
   * is given, so that a caller's result lines up with its request.
   *
   * ── Why asking for the console is free, which is the part worth knowing ──
   *
   * **Console and network are accumulated continuously by the browsing
   * context** ({@link PageRecording}), from before the lease existed. So the
   * list below is a filter on **what gets written to disk**, not on what gets
   * collected — nothing is avoided by not asking, because nothing was being
   * done on demand. A caller that only afterwards realises it wanted the
   * console asks on its next read and gets the whole history, not a recording
   * that started when it asked.
   *
   * **Cookies are the exception and are a live query.** They are answered
   * against the context at the moment of asking, so that one *does* cost
   * something.
   *
   * ── Cookie values are structurally absent, not redacted ─────────────────
   *
   * The cookie file is written from {@link RealBrowserSession.cookies}, which
   * returns {@link CookieSummary} — **a type with no value field**. This
   * method never sees a cookie value, so there is no redaction step here for
   * anybody to forget and no branch on which one could survive. That is the
   * shape §7.1 `read.cookies_no_values` asks for: serialising the jar directly
   * here would have put the only checkable point inside the module that holds
   * the values.
   */
  async read(
    tab: TabHandle,
    artifacts: readonly ReadArtifact[],
  ): Promise<readonly ArtifactResult[]> {
    const page = await this.#page(tab);
    const results: ArtifactResult[] = [];

    for (const artifact of artifacts) {
      switch (artifact) {
        case 'snapshot':
          results.push(await this.#writeSnapshot(tab, page));
          break;

        case 'console':
          results.push(
            this.#write(tab, 'console', page.url(), this.#recording(tab).console.join('\n')),
          );
          break;

        case 'network':
          results.push(
            this.#write(tab, 'network', page.url(), this.#recording(tab).network.join('\n')),
          );
          break;

        case 'cookies': {
          // Through the seam's own cookie member, never by serialising the
          // jar here — see this method's note on why that is the whole
          // mechanism rather than a preference.
          const summaries = await this.cookies(tab);
          results.push(this.#write(tab, 'cookies', page.url(), JSON.stringify(summaries, null, 2)));
          break;
        }
      }
    }

    return results;
  }

  /** What has accumulated for a tab, or an empty history for one that has none. */
  #recording(tab: TabHandle): PageRecording {
    return this.#recordings.get(tab.driverTabId) ?? { console: [], network: [] };
  }

  /**
   * Write one artefact into this session's output directory.
   *
   * ── What this does and does not decide ──────────────────────────────────
   *
   * **It fills in a leaf; it does not choose a location.** The directory
   * arrives from outside (see the constructor), and every name assembled here
   * is built from parts run through `names.ts` — the same rules §1.7a applies
   * to a capture's file name, and for the same reason: a file name travels
   * further than a database column does, so the address a name is derived from
   * has its query string stripped before anything else.
   *
   * `truncated` is reported as `false` and that is honest rather than
   * placeholder: nothing here truncates. **The cap that would make it
   * sometimes true is the service's**, in the same way §3.10's inline cap is,
   * and inventing a byte count in this file would be a policy nobody agreed
   * applied before the row that owns it could argue with it.
   */
  #write(tab: TabHandle, artifact: ReadArtifact, url: string, contents: string): ArtifactResult {
    fs.mkdirSync(this.#outputDirectory, { recursive: true });

    // The address's slug first so a listing groups a page's artefacts
    // together, then what kind it is, then the instant — the same ordering
    // §1.7a chooses for a capture, and readable for the same reason.
    const fileName = [
      slugFromUrl(url),
      artifact,
      stampFromInstant(new Date()),
      // The driver's own name for the tab, which is unique within this session
      // and is what keeps two tabs of one page from writing the same file.
      // It never leaves this process on any surface — a caller holds the
      // opaque lease identifier — so using it here names a file without
      // widening what is disclosed.
      tab.driverTabId,
      // Last, and load-bearing: the stamp above is only second-granular, so
      // without this every artefact written inside one second collides. See
      // {@link #artifactsWritten} for the measurement that caught it.
      String(this.#artifactsWritten),
    ].join('-');
    this.#artifactsWritten += 1;

    const destination = path.join(this.#outputDirectory, `${fileName}.txt`);
    const bytes = Buffer.byteLength(contents, 'utf8');
    fs.writeFileSync(destination, contents, 'utf8');

    return { artifact, path: destination, bytes, truncated: false };
  }

  /**
   * Evaluate an expression in the page.
   *
   * **The inline cap and the spill-to-path decision are row #24 owns**, and
   * they are deliberately not invented here: this returns the value and the
   * size it measured, which is what that row needs in order to decide. A byte
   * count chosen in this file would be a policy nobody agreed, applied before
   * the row that owns it could argue with it.
   */
  async evaluate(tab: TabHandle, expression: string): Promise<EvaluationResult> {
    const page = await this.#page(tab);
    const value: unknown = await page.evaluate(expression);

    // Measured on the serialised form, because that is what a caller would be
    // charged for if it were returned, and it is the only size that means
    // anything for a value that is not a string.
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value) ?? 'undefined', 'utf8');
    } catch {
      // A value that will not serialise has no size to report; the row that
      // decides what to do with large values is the one that should decide
      // what to do with unserialisable ones too.
      bytes = 0;
    }

    return { value, bytes };
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
   */
  async cookies(tab: TabHandle): Promise<readonly CookieSummary[]> {
    // Addressed to the tab, so a lease on one page is not a read of the whole
    // profile's jar — even though the tabs in one browser do share it (§1.2).
    const page = await this.#page(tab);

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
   * Stop the page moving, so the same page produces the same pixels.
   *
   * `SCHEMA.md` §3.11 calls settling the highest-value line in the comparison
   * feature, and the reason is that **no threshold fixes movement**: a colour
   * tolerance is a per-pixel comparison and has nothing to say about a banner
   * mid-fade, a transition in flight, a blinking caret or an image that
   * arrived one frame later.
   *
   * **Kept as its own call rather than folded into {@link capture}** — which
   * is the seam's decision and the right one. A driver that settled inside its
   * own capture would make *"every capture settles first"* a property of
   * whichever driver happens to be installed, provable only by reading it. As
   * two calls the ordering belongs to the pipeline, and a driver that forgot
   * to settle cannot hide the omission.
   *
   * The style sheet is added rather than toggled on elements one by one so
   * that it applies to everything the page renders, including nodes that do
   * not exist yet when this runs.
   */
  async settlePage(tab: TabHandle): Promise<void> {
    const page = await this.#page(tab);

    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          scroll-behavior: auto !important;
        }
        /* The caret blinks on its own schedule, so it is a pixel that differs
           between two runs of an identical page. */
        * { caret-color: transparent !important; }
      `,
    });

    // Web fonts land after first paint, and text rendered in a fallback face
    // is different pixels from the same text in the intended one.
    //
    // The document is reached through a typed local rather than a global,
    // because this project compiles without the browser type library: the
    // expression runs in the page, so the compiler here has no reason to know
    // those names and is right not to.
    await page.evaluate(() => {
      const scope = globalThis as unknown as {
        document?: { fonts?: { ready?: Promise<unknown> } };
      };
      return scope.document?.fonts?.ready ?? Promise.resolve();
    });
  }

  /**
   * Take a picture and hand back the pixels.
   *
   * **The correct-surface property is owed here**, and the seam says so:
   * `capture.surface_required` (§7.3) is not a parameter, because a parameter
   * would be a way to disable it. It is a property of this implementation.
   *
   * ── How it is actually satisfied, which is not what the name suggests ───
   *
   * Measured while building this row, in both modes, with a *different* tab in
   * front: the capture returned **the requested tab's own pixels** every time.
   * The automation library captures per target over the debugging protocol
   * rather than photographing the window surface, so it cannot return whatever
   * happens to be in front — and **nothing here brings a tab to the front**,
   * which `foreground.never_moved` (§7.3) requires and which this method's
   * complete absence of an activation call is the whole of.
   *
   * What the rule genuinely guards against is a background tab that has
   * **stopped rendering**, and that is prevented at launch: see
   * `CAPTURE_SURFACE_ARGUMENTS` in `launch.ts`, applied in both modes.
   *
   * **Masks are painted before the shutter, never after** — a mask applied
   * afterwards is a mask that was, for one moment, not applied.
   */
  async capture(tab: TabHandle, request: CaptureRequest): Promise<RawCapture> {
    const page = await this.#page(tab);

    // Painted **before** the shutter, never after: a mask applied afterwards
    // is a mask that was, for one moment, not applied. The request names
    // rectangles, so they are drawn into the page as elements rather than
    // handed to an element-masking interface that has no rectangle to point
    // at.
    const masks = request.mask ?? [];
    const maskMarker = 'data-broker-capture-mask';

    if (masks.length > 0) {
      await page.evaluate(
        ({ areas, marker }) => {
          const scope = globalThis as unknown as {
            document: {
              createElement: (tag: string) => {
                setAttribute: (name: string, value: string) => void;
                style: { cssText: string };
              };
              body: { appendChild: (node: unknown) => void };
            };
          };
          for (const area of areas) {
            const node = scope.document.createElement('div');
            node.setAttribute(marker, '');
            node.style.cssText = [
              'position:fixed',
              `left:${String(area.x)}px`,
              `top:${String(area.y)}px`,
              `width:${String(area.width)}px`,
              `height:${String(area.height)}px`,
              'background:#000',
              'z-index:2147483647',
              'pointer-events:none',
            ].join(';');
            scope.document.body.appendChild(node);
          }
        },
        { areas: masks, marker: maskMarker },
      );
    }

    try {
      // `fullPage` describes a page and means nothing for one element, so it
      // is passed only where it applies rather than defaulted into a call that
      // would quietly ignore it.
      const image =
        request.selector === undefined
          ? await page.screenshot({ type: 'png', fullPage: request.fullPage })
          : await page.locator(request.selector).screenshot({ type: 'png' });

      // Read from the page rather than from whatever a caller last asked to
      // resize to: those disagree whenever a resize did not take, and the
      // breakpoint a picture was taken at is the one the page actually had.
      const measured = await page.evaluate(() => {
        const scope = globalThis as unknown as {
          innerWidth: number;
          document: { documentElement: { scrollWidth: number; scrollHeight: number } };
        };
        return {
          viewportWidth: scope.innerWidth,
          scrollWidth: scope.document.documentElement.scrollWidth,
          scrollHeight: scope.document.documentElement.scrollHeight,
        };
      });

      // The dimensions are what the browser actually produced
      // (`captures.source_*`), read out of the image rather than inferred from
      // the viewport: a full-page capture is taller than the viewport by
      // definition, so reporting the viewport would be wrong in exactly the
      // case these fields exist to describe.
      const produced = readPngDimensions(image);

      return {
        image,
        width: produced?.width ?? measured.scrollWidth,
        height: produced?.height ?? measured.scrollHeight,
        viewportWidth: measured.viewportWidth,
        url: page.url(),
      };
    } finally {
      // Removed whether or not the shutter succeeded, so a failed capture does
      // not leave black rectangles over a page whose lease is still live.
      if (masks.length > 0) {
        await page.evaluate((marker) => {
          const scope = globalThis as unknown as {
            document: {
              querySelectorAll: (selector: string) => ArrayLike<{ remove: () => void }>;
            };
          };
          const nodes = scope.document.querySelectorAll(`[${marker}]`);
          for (let index = 0; index < nodes.length; index += 1) {
            nodes[index]?.remove();
          }
        }, maskMarker);
      }
    }
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
  /**
   * Where {@link TabOperations.act} and {@link TabOperations.read} write the
   * artefacts they hand back paths to.
   *
   * ── Why this is a parameter rather than something this module works out ──
   *
   * `SCHEMA.md` §1.7a puts *"the service decides where the file may go"* in
   * `artifacts/store.ts`, and the seam's own note on {@link RawCapture}
   * explains why `capture` therefore returns **bytes** rather than a path: a
   * driver that picked a path would be *"a second thing choosing locations
   * under the artifact root"*, and the rule that nothing lands outside the
   * tree would then hold in one place and be a convention in another.
   *
   * `act` and `read` are declared as returning a path, so this file cannot
   * take the same way out. What it does instead is refuse to choose a
   * **location** while still choosing a **name**: the directory arrives here,
   * opaque, and every file written into it is named from parts run through
   * `names.ts`. The store keeps deciding the tree; this fills in a leaf.
   *
   * **The seam this leaves, described honestly:** nothing structurally stops a
   * caller passing a directory outside the artifact root, because this module
   * has no way to know where that root is — which is the same fact that makes
   * the arrangement correct. What closes it is the wiring row handing over
   * `store.directoryFor(claimId, …)` and nothing else. Until then the default
   * is a temporary directory of this session's own, so an unwired driver
   * writes somewhere harmless rather than somewhere surprising.
   */
  readonly outputDirectory?: string;
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
  outputDirectory?: string;
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
    ...(options.outputDirectory === undefined ? {} : { outputDirectory: options.outputDirectory }),
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
      ...(this.#options.outputDirectory === undefined
        ? {}
        : { outputDirectory: this.#options.outputDirectory }),
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
      ...(this.#options.outputDirectory === undefined
        ? {}
        : { outputDirectory: this.#options.outputDirectory }),
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
