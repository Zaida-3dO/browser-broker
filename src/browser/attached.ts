// The attached browser session: a **read-only** view of a person's own browser,
// driven over the bridge in `src/attach/` rather than over a debugging port the
// service opened itself.
//
// This file is the session layer the attach README names as its only consumer
// below the seam: it calls `connect()`, drives the returned bridge with
// Playwright, and implements {@link BrowserSession}. What it never does is the
// three things that make the other two kinds what they are — it never launches
// his browser, never closes it, and never writes to it. Every verb that would
// write — a seed, an expression, a click, a typed value, a style injection, a
// painted mask — is refused here, at the seam, before the bridge is asked, so
// the refusal and the absence of the side effect are the same fact rather than
// two promises that can drift.
//
// ── Why the handle names the extension's tab, not the CDP target ──────────
//
// {@link RealBrowserSession} mints its `driverTabId` from the debugging
// protocol's target id, because that id is identical across every connection
// to one browser. The bridge cannot supply one: `Target.getTargetInfo` is
// answered for a tab's own session only, and opening an extra protocol
// session through the relay does not resolve to one (`newCDPSession` has no
// child session to answer). The ownership mirror can, though — a
// `chrome.tabs` tab id is the browser's own name for the tab, identical
// across connections and across processes for as long as the browser runs,
// and `bridge.isOurs(tabId)` is the contract's ownership test. So an attached
// handle is `tab-<tabId>`, and the mirror doubles as the address book. The
// consequence is stated in full in `DECISIONS.md` §13n: pages and mirror tabs
// are paired at connect time by address where the address is unambiguous and
// by order otherwise, which cannot mispair tabs this connection owns and
// could not mispair tabs it does not — a foreign tab is absent from the
// mirror entirely.
//
// ── What a session is scoped to ───────────────────────────────────────────
//
// One bridge. The bridge is the connection, its port exists only for the
// lease's life, and the mirror it reports is exactly *this connection's* tabs
// — tabs created through it, tabs the person picked for it, and their popups.
// A handle minted by a different bridge addresses a tab this bridge reports
// as foreign, and closing a foreign tab is the one refusal {@link closeTab}
// answers with `refused` rather than `not_found`: it is a rule doing its job,
// not a lookup that missed.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
} from 'playwright-core';

import { slugFromUrl, stampFromInstant } from '../artifacts/names.ts';
import { connect } from '../attach/session.ts';
import type { AttachedBridge } from '../attach/session.ts';
import { openConnectPage } from '../attach/connect-launcher.ts';
import type { ConnectPageRequest } from '../attach/connect-launcher.ts';
import { AttachedError } from '../attach/errors.ts';
import { looksLikeSentinel } from '../secrets/sentinel.ts';
import { annotateRefless, filterSnapshot, REFERENCE_RESOLUTION_MS } from './real.ts';
import type {
  ActionRequest,
  ArtifactResult,
  BrowserDescription,
  BrowserId,
  BrowserSession,
  CaptureRequest,
  CookieSummary,
  EvaluationResult,
  NavigationResult,
  RawCapture,
  ReadArtifact,
  ReadOptions,
  SecretScope,
  SnapshotFilter,
  StorageSeedEntry,
  TabCloseOutcome,
  TabHandle,
} from './driver.ts';
import { readPngDimensions, renderNetworkLog, type NetworkEntry } from './render.ts';

/**
 * How long the open path waits for the extension when a token is configured.
 *
 * With a token the connect page skips its approval click and the extension
 * arrives on its own, so the wait covers only the connect-page launch and the
 * extension's own start — seconds. The refusal this bound produces is
 * `attached.not_connected` — **refuse, not queue**, because the queue's
 * promise is that capacity frees up, and an extension that is not connected
 * has promised nothing of the kind.
 */
const CONNECT_WAIT_MS = 5_000;

/**
 * How long the open path waits when **no** token is configured.
 *
 * Without a token the connect page waits for a person to click Allow in it,
 * and five seconds is the wrong order of magnitude for a human decision: the
 * first approval cannot complete inside it, which is the state the widened
 * bound exists for. The bound is the relay's own interactive default (thirty
 * seconds) — "a few seconds, well under the relay's default" is right only
 * when the token does the clicking. The widened wait still ends in the same
 * refusal; it is longer, not queued.
 */
const TOKENLESS_CONNECT_WAIT_MS = 30_000;

/** Bound on the Playwright handshake once the extension is through. */
const CDP_CONNECT_TIMEOUT_MS = 15_000;

/**
 * How long the mirror is given to report a tab `openTab` just created.
 *
 * The relay records the tab before `Target.createTarget` answers, so in
 * practice this resolves on the first look; the bound exists because the
 * ordering is the relay's promise rather than this file's fact, and an
 * unaddressable tab must be said so rather than half-handled.
 */
const MIRROR_SETTLE_MS = 5_000;

/**
 * How long the session's own snapshot render may take.
 *
 * `real.ts` leaves the render unbounded because its browser is this service's
 * and a wedged page is a wedge it will reclaim. Over the bridge the page
 * belongs to a person, the transport is the extension, and **an unbounded
 * wait would hold a lease on his browser indefinitely**; the bounded render
 * fails the read instead and leaves the browser untouched.
 */
const SNAPSHOT_RENDER_MS = 15_000;

/**
 * The keys `press` may send.
 *
 * Scrolling and dismissing are the only things a key can do to a page this
 * kind is allowed to do: they change which part of the page is visible and
 * what is drawn over it, never what the page holds. A key that could reach a
 * focused field is a typing verb wearing a key's name, and typing is what the
 * read-only rule exists to forbid.
 */
const ALLOWED_PRESS_KEYS = new Set([
  // The automation library's own key names — what a caller's `value` is
  // spelled in on every other driver in this codebase, since the request
  // carries "the key's name" and this is the name the key is driven by.
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Escape',
]);

/**
 * Whether an `act` request stays inside the view-moving allow-list (§7.1
 * `attached.read_only`): scroll, hover, and a press of an allowed key.
 *
 * **Exported because the rule now has two doors and one set.** The service's
 * decide step refuses an attached breach before anything is written (so the
 * caller gets a refusal and the ledger a `deny`, not `accepted` with
 * `pageDriven: false`), and this session keeps its own door as the second —
 * but both doors ask the same question, and two spellings of an allow-list
 * are two lists that eventually disagree.
 */
export function isViewMovingAction(request: ActionRequest): boolean {
  switch (request.action) {
    case 'scroll':
    case 'hover':
      return true;
    case 'press':
      return ALLOWED_PRESS_KEYS.has(request.value);
    default:
      return false;
  }
}

/**
 * One page's accumulated console and network history. The entry shape is
 * `render.ts`'s, shared with `real.ts` — the two drivers render one log
 * format, and this is what they accumulate to render it from.
 */
interface PageRecording {
  readonly console: string[];
  readonly network: NetworkEntry[];
}

/** The handle identifier for one of the bridge's tabs. */
function handleFor(tabId: number): string {
  return `tab-${String(tabId)}`;
}

/** The tab id a handle carries, or undefined for a handle this session never minted. */
function tabIdOf(handleId: string): number | undefined {
  if (!handleId.startsWith('tab-')) return undefined;
  const id = Number(handleId.slice(4));
  return Number.isSafeInteger(id) ? id : undefined;
}

export interface AttachedSessionOptions {
  /** The configured name this session serves (`BROKER_ATTACHED_BROWSERS`' entry). */
  readonly browser: BrowserId;
  /** The tab group's title — the claim's purpose, never the caller's key. */
  readonly clientName: string;
  /** The extension's store id, from `BROKER_ATTACHED_EXTENSION_ID`. */
  readonly extensionId: string;
  /** From `BROKER_ATTACHED_TOKEN`. Passed through the bridge; never logged. */
  readonly token?: string;
  /** Where {@link act} and {@link read} write their artefacts, as in `real.ts`. */
  readonly outputDirectory?: string;
  /**
   * The binary whose window shows the connect page, from
   * `BROKER_BROWSER_<NAME>_PATH`. **Required for an open**: the relay's
   * endpoint is random per lease, so the connect page is the only thing
   * that can carry it to the extension, and without the binary there is no
   * page and nothing reaches the relay. Absent, the open refuses
   * `attached.no_binary` before it binds a port.
   */
  readonly browserPath?: string;
  /** Over the default {@link CONNECT_WAIT_MS} / {@link TOKENLESS_CONNECT_WAIT_MS}. */
  readonly connectTimeoutMs?: number;
  /** Bridge log sink; nothing written there carries the token. */
  readonly log?: (message: string) => void;
  /**
   * How the connect page is opened — injected on the seam's own convention
   * (`spawnImpl` in `launch.ts`) so a test can watch the open without a
   * person's browser. Defaults to `connect-launcher`'s `openConnectPage`.
   */
  readonly launchConnectPage?: (request: ConnectPageRequest) => void;
}

/**
 * Open a bridge to the person's browser, show his extension the connect page,
 * wait for it, and attach.
 *
 * ── Why the connect page is part of the open and not an option ───────────
 *
 * The relay binds a **random port under a random uuid every lease**; nothing
 * else prints or logs it. The connect page — the extension's own
 * `connect.html` carrying `mcpRelayUrl` — is the only route by which the
 * extension learns that endpoint. An open that skipped it would listen on a
 * port nobody can be told about, and `attached.not_connected` would be a
 * permanent answer rather than a moment. So the open runs the configured
 * binary on the URL first, and only then starts the bounded wait — with no
 * token the page is where a person clicks Allow; with one, the token on the
 * URL is what lets the extension skip the click.
 *
 * The whole open is one bounded refusal: if the extension does not arrive
 * within the connect wait, **nothing was connected, no tab was opened, and
 * the listener is closed again** before the rejection reaches the caller —
 * `attached.not_connected`, retryable in the sense that he can connect,
 * never a queue entry.
 */
export async function openAttachedSession(
  options: AttachedSessionOptions,
): Promise<AttachedBrowserSession> {
  // Refused **before the port is bound**: a listener nobody can be pointed
  // at is the open door this layer's whole close-the-port discipline is
  // built to avoid, and the binary's absence is knowable here.
  if (options.browserPath === undefined || options.browserPath.trim() === '') {
    throw new AttachedError(
      'attached.no_binary',
      `The attached browser "${options.browser}" has no configured binary to open its connect page with, so nothing could learn this relay's address. Set BROKER_BROWSER_<NAME>_PATH for it, or empty BROKER_ATTACHED_BROWSERS to leave the capability off.`,
    );
  }
  const bridge = await connect({
    clientName: options.clientName,
    extensionId: options.extensionId,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  try {
    // The URL is the bridge's own — token and background flags included as
    // configured — so this call cannot disagree with what the extension is
    // expected to present. The token travels to the launcher only for the
    // `--open-in-background` pairing (`buildConnectArgs` carries it with a
    // token and never alone), never as a second copy in the URL.
    (options.launchConnectPage ?? openConnectPage)({
      browserPath: options.browserPath,
      connectUrl: bridge.connectUrl(),
      ...(options.token === undefined ? {} : { token: options.token, background: true }),
    });
  } catch (error) {
    bridge.close('connect page could not be opened');
    throw error;
  }
  return await attachOverBridge(bridge, options);
}

/**
 * Attach over a bridge that is already open.
 *
 * Split out because the bridge and the session have different lifetimes and
 * different owners: whoever opens a bridge owns its listener, and every path
 * out of this function — including its refusals — closes it again.
 */
export async function attachOverBridge(
  bridge: AttachedBridge,
  options: AttachedSessionOptions,
): Promise<AttachedBrowserSession> {
  try {
    // A token means the extension skips its approval click and answers in
    // seconds; without one the wait is for a person, and the bound widens to
    // the relay's interactive default — still a refusal at the bound, never
    // a queue.
    await bridge.waitForExtension(
      options.connectTimeoutMs ??
        (options.token === undefined ? TOKENLESS_CONNECT_WAIT_MS : CONNECT_WAIT_MS),
    );
    const connection = await chromium.connectOverCDP(bridge.cdpEndpoint, {
      timeout: CDP_CONNECT_TIMEOUT_MS,
    });
    const [context] = connection.contexts();
    if (context === undefined) {
      await connection.close();
      throw new AttachedError(
        'attached.no_context',
        'The bridge answered but exposes no browsing context, so there is nothing to open a tab in.',
      );
    }
    return new AttachedBrowserSession({
      browser: options.browser,
      bridge,
      connection,
      context,
      ...(options.outputDirectory === undefined
        ? {}
        : { outputDirectory: options.outputDirectory }),
    });
  } catch (error) {
    // Whatever failed, the port must not outlive the refusal: the bridge is
    // the whole of the connection, and a listener left open behind a failed
    // claim is an open door with nobody in the room.
    bridge.close('connect refused');
    throw error;
  }
}

/**
 * The attached session.
 *
 * Reads and scrolls, and refuses everything else — see the header for the
 * rule and this class for where each half of it is enforced.
 */
export class AttachedBrowserSession implements BrowserSession {
  readonly #browser: BrowserId;
  readonly #bridge: AttachedBridge;
  readonly #connection: Browser;
  readonly #context: BrowserContext;

  /**
   * The handle a page answers to, and the page it names.
   *
   * Mirrored by {@link #identified} because pairing runs in both directions:
   * verbs resolve name → page, and `listTabs` needs page → name for the pages
   * it did not open.
   */
  readonly #pages = new Map<string, Page>();
  readonly #identified = new WeakMap<Page, string>();

  /** Accumulated console/network history per handle — see `real.ts`'s equivalent. */
  readonly #recordings = new Map<string, PageRecording>();

  /**
   * Tabs whose debugger Chrome took off — his Cancel, and its reason.
   *
   * Kept so the resolve-failure message can name his Cancel as the reason a
   * page stopped being drivable, rather than blaming a close that never
   * happened.
   */
  readonly #detached = new Map<number, string>();

  /** Pages whose element references this connection has registered. See `real.ts`'s note. */
  readonly #referenced = new WeakSet<Page>();

  /**
   * Tab ids this connection has seen in the mirror, including ones since gone.
   *
   * The mirror forgets a tab the moment the extension reports it closed, and
   * ownership outlives that: a handle for a tab **we** owned must still
   * answer `not_found` — the page it named is gone — rather than `refused`,
   * which would relabel our own closed tab as somebody else's. The set is
   * per-session, so the memory ends where the connection does, and a tab the
   * mirror never showed stays foreign forever.
   */
  readonly #seenTabs = new Set<number>();

  /**
   * The tail of the `openTab` queue, one open at a time per session.
   *
   * {@link AttachedBrowserSession.openTab} decides "which mirror entry is
   * mine" by diffing against a snapshot taken **before** the page is
   * created, and that diff is only sound while nothing else moves the
   * mirror mid-flight. Two first-touch verbs on two leases — parallel
   * tool calls through one memoised provider — would otherwise both
   * snapshot the same mirror, both create a page, and both bind the
   * first fresh id: the second `#bind` overwrites the first page's entry,
   * the store's one-row-per-physical-tab index then refuses the second
   * open, and a page is left in the person's own window that neither
   * lease can address or close. The real browser driver sidesteps this
   * by naming tabs through CDP target ids; at this seam the mirror is
   * the address book, so the opens have to take turns.
   */
  #openTail: Promise<unknown> = Promise.resolve();

  readonly #outputDirectory: string;
  #artifactsWritten = 0;

  constructor(options: {
    browser: BrowserId;
    bridge: AttachedBridge;
    connection: Browser;
    context: BrowserContext;
    outputDirectory?: string;
  }) {
    this.#browser = options.browser;
    this.#bridge = options.bridge;
    this.#connection = options.connection;
    this.#context = options.context;
    // The same eager-name, lazy-create arrangement as `real.ts`, for the same
    // measured reason: an unwired session that never writes must not leave an
    // empty directory behind, and this module still does not know where the
    // artifact tree is — §1.7a keeps that in `artifacts/store.ts`.
    this.#outputDirectory =
      options.outputDirectory ??
      path.join(os.tmpdir(), `broker-artifacts-${randomUUID().slice(0, 8)}`);

    // His Cancel arrives as a debugger detach: the tab stops being drivable,
    // which ends the lease's usefulness without ending the bridge. Drop the
    // page here so no verb can reach it between the detach and Playwright's
    // own close of the target.
    this.#bridge.on('debuggerDetached', ({ tabId, reason }) => {
      this.#detached.set(tabId, reason);
      const handle = handleFor(tabId);
      const page = this.#pages.get(handle);
      if (page !== undefined) {
        this.#pages.delete(handle);
        this.#identified.delete(page);
      }
    });
  }

  describe(): BrowserDescription {
    return {
      browser: this.#browser,
      // His browser draws a window — that is what "his own browser" means.
      mode: 'headed',
      // The browser is not this process's child and its process is not
      // reachable through the bridge; `0` is the convention every adopted
      // browser in this codebase already uses for "pid is not ours to know".
      pid: 0,
      discovery: { endpoint: this.#bridge.cdpEndpoint },
    };
  }

  openTab(): Promise<TabHandle> {
    // One open at a time per session — see {@link #openTail} for why the
    // snapshot-diff below cannot be run twice at once. The tail swallows
    // failures on purpose: a refused open must not poison the queue for
    // every later one.
    const turn = this.#openTail.then(() => this.#openTabNow());
    this.#openTail = turn.catch(() => undefined);
    return turn;
  }

  async #openTabNow(): Promise<TabHandle> {
    // No keeper tab here, and none is owed: the keeper exists so a headed
    // browser this service started survives its last tab closing. His browser
    // is alive because he is using it, and a blank tab added to his window is
    // a write to his browsing that the claim never asked for.
    const before = new Set(this.#mirrorTabIds());
    const page = await this.#context.newPage();
    const fresh = await this.#waitForNewMirrorTab(before);
    if (fresh === undefined) {
      // The tab exists but the bridge will not name it, which means nothing
      // downstream can address or close it. Say so rather than hand back an
      // unresolvable handle.
      throw new AttachedError(
        'attached.tab_untracked',
        'The attached browser opened a tab the bridge never reported, so it cannot be addressed. The lease is unusable against it.',
      );
    }
    return this.#bind(fresh, page);
  }

  listTabs(): Promise<readonly TabHandle[]> {
    this.#pairAll();
    return Promise.resolve(
      this.#bridge
        .tabs()
        .flatMap((tab) =>
          tab.id === undefined ? [] : [{ browser: this.#browser, driverTabId: handleFor(tab.id) }],
        ),
    );
  }

  /**
   * Close one of this connection's tabs; refuse every other name.
   *
   * The ownership test is **before** any resolution, and that ordering is the
   * half the tests pin: a foreign handle must produce no removal request at
   * all, because a close that reached his browser and then explained itself
   * would be a close that happened. A tab he closed by hand or Chrome detached
   * answers `not_found` — the name is ours, the page is simply gone; a name
   * the mirror disowns answers `refused` — closing it is a rule's business,
   * not a lookup's.
   */
  async closeTab(tab: TabHandle): Promise<TabCloseOutcome> {
    if (!this.#ownsTab(tab)) {
      return 'refused';
    }

    const held = this.#pages.get(tab.driverTabId);
    if (held !== undefined && !held.isClosed()) {
      this.#pages.delete(tab.driverTabId);
      this.#identified.delete(held);
      await held.close();
      return 'closed';
    }

    this.#pairAll();
    const paired = this.#pages.get(tab.driverTabId);
    if (paired === undefined || paired.isClosed()) {
      this.#pages.delete(tab.driverTabId);
      return 'not_found';
    }
    this.#pages.delete(tab.driverTabId);
    this.#identified.delete(paired);
    await paired.close();
    return 'closed';
  }

  /**
   * Navigate one of our tabs.
   *
   * **The wait is the commit, not the load.** Over the bridge every page event
   * rides the extension's forwarding, and a session that waited on a load
   * event it cannot observe would hold a lease on his browser for whatever
   * the transport decided not to deliver. Commit is the one navigation wait
   * that closes on the navigation response itself, and the page verbs' own
   * bounded waits do the settling.
   */
  async navigate(
    tab: TabHandle,
    url: string,
    waitMs?: number,
    secrets?: SecretScope,
  ): Promise<NavigationResult> {
    this.#refuseSecrets(secrets);
    this.#requireOurs(tab);
    const page = this.#page(tab);
    const response = await page.goto(
      url,
      ...(waitMs === undefined
        ? [{ waitUntil: 'commit' as const }]
        : [{ waitUntil: 'commit' as const, timeout: waitMs }]),
    );
    return {
      url: page.url(),
      title: await page.title(),
      status: response?.status() ?? null,
    };
  }

  /**
   * Storage seeding is what the claim already refused; this is the same door
   * seen from the inside. A seed writes a credential into an origin **before
   * the first navigation** — into his browser — and this kind never writes to
   * it. Refusing here rather than trusting the caller means no path reaches
   * his storage without an edit to both files.
   */
  seedStorage(tab: TabHandle, entries: readonly StorageSeedEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    // **Rejects rather than throws, and that is the interface's contract and
    // not a style point:** every seam member is asynchronous, and an operation
    // that fails synchronously in front of a caller written against rejections
    // escapes its `catch` — a guard nobody can call uniformly is a guard that
    // behaves differently depending on which door it was reached through.
    if (!this.#ownsTab(tab)) {
      return Promise.reject(this.#foreignRefusal());
    }
    return Promise.reject(
      new AttachedError(
        'attached.no_seed',
        'An attached browser is never seeded. A storage seed writes into the browser before its first navigation, and this browser belongs to a person.',
      ),
    );
  }

  /**
   * The read-only half of `browser_act`: scrolling, hovering, and pressing a
   * key that can only move the view or dismiss an overlay.
   *
   * **The refusal is decided before the page is resolved**, so a refused verb
   * is a verb the bridge was never asked to perform — the side-effect half of
   * every rejection test hangs off that ordering. `scroll` with no reference
   * runs a fixed one-line expression this file contains; the session's own
   * fixed expressions are not the caller's expression, and the expression
   * {@link evaluate} refuses is refused there, at its own door.
   */
  async act(
    tab: TabHandle,
    request: ActionRequest,
    secrets?: SecretScope,
  ): Promise<ArtifactResult> {
    this.#refuseSecrets(secrets);
    if ('value' in request && looksLikeSentinel(request.value)) {
      throw new AttachedError(
        'attached.no_secrets',
        'A secret sentinel reached an attached browser. Secrets are typed into fields, and an attached browser is never typed into — the secret was never resolved.',
      );
    }
    this.#refuseOutsideAllowList(request);
    this.#requireOurs(tab);

    const page = this.#page(tab);
    switch (request.action) {
      case 'scroll': {
        if (request.ref === undefined) {
          // The same fixed expression `real.ts` runs for the same reason: the
          // scroll is this service's instruction, byte-for-byte, and nothing
          // the caller wrote is part of it.
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
      }
      case 'hover': {
        await (await this.#locate(page, request.ref)).hover();
        break;
      }
      case 'press': {
        // Allowed keys only reach the page, never a field's text: `#refuseOutsideAllowList`
        // already checked the key against the movement-and-dismiss set.
        await page.keyboard.press(request.value);
        break;
      }
    }
    return await this.#writeSnapshot(tab, page);
  }

  /**
   * The artefacts, written the way `real.ts` writes them.
   *
   * Console and network come from the same at-name-time listeners and cookies
   * from the same no-value shape; the secret branches `real.ts` carries are
   * absent because **a secret never reached this session** — every verb that
   * could bring one refuses its scope at the door, so there is no received
   * history to scrub and no branch a reader has to trust.
   */
  async read(
    tab: TabHandle,
    artifacts: readonly ReadArtifact[],
    options?: ReadOptions,
  ): Promise<readonly ArtifactResult[]> {
    this.#refuseSecrets(options?.secrets);
    this.#requireOurs(tab);
    const page = this.#page(tab);
    const results: ArtifactResult[] = [];
    for (const artifact of artifacts) {
      switch (artifact) {
        case 'snapshot':
          results.push(await this.#writeSnapshot(tab, page, options?.snapshotFind));
          break;
        case 'console':
          results.push(
            this.#write(
              tab,
              'console',
              page.url(),
              this.#recording(tab.driverTabId).console.join('\n'),
            ),
          );
          break;
        case 'network':
          results.push(
            this.#write(
              tab,
              'network',
              page.url(),
              renderNetworkLog(this.#recording(tab.driverTabId).network),
            ),
          );
          break;
        case 'cookies': {
          const summaries = await this.cookies(tab);
          results.push(this.#write(tab, 'cookies', page.url(), JSON.stringify(summaries, null, 2)));
          break;
        }
      }
    }
    return results;
  }

  /**
   * Cookie summaries over his jar — names, domains, paths, expiries, flags,
   * and structurally no values, exactly as {@link CookieSummary} enforces for
   * every driver. A cookie *read* is a read; the value field does not exist
   * here for a reader to wonder about.
   */
  async cookies(tab: TabHandle): Promise<readonly CookieSummary[]> {
    this.#requireOurs(tab);
    const page = this.#page(tab);
    const jar = await this.#context.cookies(page.url());
    return jar.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires < 0 ? null : new Date(cookie.expires * 1000).toISOString(),
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));
  }

  /**
   * **No expression runs in his browser.** Not a bounded read, not a read of
   * `document.title`: an expression is a program, the position §9.4 measured
   * being abused, and on a browser that holds his session it is the worst
   * place in this design to put one. The refusal is a constant, not a
   * parameter — there is no expression that turns it off.
   */
  evaluate(tab: TabHandle, expression: string): Promise<EvaluationResult> {
    if (!this.#ownsTab(tab)) {
      return Promise.reject(this.#foreignRefusal());
    }
    return Promise.reject(
      new AttachedError(
        'attached.no_evaluate',
        `Nothing is evaluated in an attached browser${
          expression.length > 0
            ? ` — the ${String(expression.length)}-character expression was refused at the door and never sent`
            : ''
        }. An expression is a program, and this browser belongs to a person whose session it could reach.`,
      ),
    );
  }

  /**
   * Settling means **stopping the page from moving**, and the only way to do
   * that is to inject a style sheet into it — a write to a page this kind
   * never writes to. A no-op with a name, rather than a silent omission: the
   * pipeline may still order settle before capture, and an attached capture
   * is simply taken as his browser is showing it.
   */
  settlePage(tab: TabHandle): Promise<void> {
    // Still an ownership check, so a foreign handle is refused as a foreign
    // handle rather than passing a no-op on its way through.
    if (!this.#ownsTab(tab)) {
      return Promise.reject(this.#foreignRefusal());
    }
    return Promise.resolve();
  }

  /**
   * A picture of the tab as he has it — viewport, unmasked, unfullpaged.
   *
   * - **No full page.** The lease is pointed at a tab; a full-page capture
   *   reports a document taller than the surface either party looked at.
   * - **No masks.** A mask is painted by appending elements to the page — a
   *   write — and masks exist for secret values, which never reach here.
   * - **No secrets.** A capture on a tab with a received secret means the tab
   * *received* one, which the typed-verb refusals make unreachable; the
   *   scope at the door is the reachable half, and it is refused.
   */
  async capture(tab: TabHandle, request: CaptureRequest): Promise<RawCapture> {
    this.#refuseSecrets(request.secrets);
    if (request.fullPage) {
      throw new AttachedError(
        'attached.no_full_page',
        'A capture of an attached browser is the viewport the lease is pointed at. A full-page picture reports regions neither the caller nor the owner pointed at.',
      );
    }
    if (request.mask !== undefined && request.mask.length > 0) {
      throw new AttachedError(
        'attached.read_only',
        'A capture mask is painted by writing elements into the page, and an attached browser is never written to. Nothing was captured.',
      );
    }
    this.#requireOurs(tab);

    const page = this.#page(tab);
    const image =
      request.selector === undefined
        ? await page.screenshot({ type: 'png' })
        : await page.locator(request.selector).screenshot({ type: 'png' });

    const produced = readPngDimensions(image);
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

    return {
      image,
      width: produced?.width ?? measured.scrollWidth,
      height: produced?.height ?? measured.scrollHeight,
      viewportWidth: measured.viewportWidth,
      url: page.url(),
    };
  }

  /**
   * There is no keeper tab on an attached browser, and nothing here may make
   * one. The keeper exists to keep a headed browser *this service started*
   * alive across an empty pool; his browser is alive because he is in it, and
   * a blank tab inserted into his window is an unasked-for write.
   */
  ensureKeeperTab(): Promise<TabHandle> {
    return Promise.reject(
      new AttachedError(
        'attached.no_keeper',
        'An attached browser has no keeper tab. It is kept alive by the person using it, and this service never adds tabs to his browser to keep it alive.',
      ),
    );
  }

  /**
   * Usable means both halves are up: Playwright's socket to the relay, and the
   * extension's socket to the relay. Either flag read is local — no I/O — as
   * the seam requires, and either dropping means no page verb can complete,
   * which is the whole question this member answers.
   */
  isConnected(): boolean {
    return this.#connection.isConnected() && this.#bridge.extensionConnected();
  }

  /**
   * End the lease: close the bridge, then the connection.
   *
   * The bridge first, deliberately: closing it stops the listener and tells
   * his extension the connection ended, and the Playwright close then rides
   * that fact rather than racing it. **His browser is untouched** — the
   * bridge was a connection to it, not a handle on it.
   */
  async detach(): Promise<void> {
    this.#bridge.close('lease ended');
    await this.#connection.close();
  }

  // ── The read-only rule ──────────────────────────────────────────────────

  /**
   * The handle must name a tab **this connection owns** — a flag read of the
   * ownership mirror, no I/O, before anything reaches a page. The mirror is
   * also why the rule is enforceable at all: a tab the extension has not
   * reported is not in it, so "not ours" and "not here" are the same answer,
   * and a page verb on a foreign handle refuses as foreign rather than
   * resolving a page the caller has no business addressing.
   */
  #requireOurs(tab: TabHandle): void {
    if (this.#ownsTab(tab)) return;
    throw this.#foreignRefusal();
  }

  #foreignRefusal(): AttachedError {
    return new AttachedError(
      'attached.foreign_tab',
      'That handle is not a tab of this attached connection. The bridge reports only tabs its extension reported — a tab outside them is not hidden here, it is absent, and nothing runs against it.',
    );
  }

  #refuseSecrets(secrets: SecretScope | undefined): void {
    if (secrets === undefined) return;
    throw new AttachedError(
      'attached.no_secrets',
      'A secret scope reached an attached browser. Secrets are typed into fields and scrubbed from what a tab returns, and both halves belong to a browser this service writes to — which this one never is. The scope was never resolved.',
    );
  }

  #refuseOutsideAllowList(request: ActionRequest): void {
    if (isViewMovingAction(request)) return;
    if (request.action === 'press') {
      throw new AttachedError(
        'attached.read_only',
        `press of "${request.value}" is not available on an attached browser. Only view-moving and overlay-dismissing keys are: ${[...ALLOWED_PRESS_KEYS].join(', ')}. A key that could reach a focused field is typing, and typing writes to his page.`,
      );
    }
    throw new AttachedError(
      'attached.read_only',
      `The ${request.action} action is not available on an attached browser. An attached browser belongs to a person and this service only reads it: scroll, hover and press (${[...ALLOWED_PRESS_KEYS].join(', ')}) are the whole allow-list, and nothing that clicks, types, selects, resizes, emulates, answers dialogs, fills, drags or uploads ever runs.`,
    );
  }

  // ── Resolution ──────────────────────────────────────────────────────────

  #page(tab: TabHandle): Page {
    const held = this.#pages.get(tab.driverTabId);
    if (held !== undefined && !held.isClosed()) {
      return held;
    }
    this.#pairAll();
    const paired = this.#pages.get(tab.driverTabId);
    if (paired !== undefined && !paired.isClosed()) {
      return paired;
    }
    const tabId = tabIdOf(tab.driverTabId);
    const detached = tabId === undefined ? undefined : this.#detached.get(tabId);
    throw new Error(
      detached === undefined
        ? `No tab of the attached browser ${this.#browser} answers to ${tab.driverTabId}. The page it named has closed, or it belongs to a different connection.`
        : `The debugging session for tab ${tab.driverTabId} of the attached browser ${this.#browser} ended: ${detached}. The tab is his to give back.`,
    );
  }

  /**
   * Bind every page the bridge reports to a page Playwright reports.
   *
   * ── Why pairing exists at all, and exactly what it promises ─────────────
   *
   * A fresh bridge auto-attaches to every tab already in this connection —
   * the tabs the person picked, or the tabs a previous process opened under
   * the same lease — and neither list arrives carrying the other's name. The
   * mirror and Playwright's page list are **the same set**, because the model
   * drives both, and pairing assigns each page the handle of a tab. Address
   * where it is decisive, position where it is not:
   *
   * - A tab the person picked reports the address he was on, and an attached
   *   page reports the address it is on, so an address shared by exactly one
   *   tab and one page is a fact.
   * - Everything else — the tabs this lease created, which the mirror
   *   recorded at `about:blank` — pairs by order. Both lists derive from the
   *   model's insertion order, and where that order can differ, a swap is
   *   between two tabs **of this connection**, both ours, both addressable.
   *   The mirror cannot pair a page with a foreign tab, because a foreign tab
   *   is not in the mirror at all.
   *
   * Tabs this session opened itself never take this path: `openTab` saw both
   * sides happen and bound them directly.
   */
  #pairAll(): void {
    // Whatever the pairing decides, every id in the mirror is now one this
    // session can vouch for as ours — including ones that leave the mirror
    // later, which must keep answering as our closed tab rather than foreign.
    for (const tab of this.#bridge.tabs()) {
      if (tab.id !== undefined) this.#seenTabs.add(tab.id);
    }
    const pages = this.#context.pages().filter((page) => !page.isClosed());
    const unbound = pages.filter((page) => this.#identified.get(page) === undefined);
    if (unbound.length === 0) return;

    const boundHandles = new Set(
      pages
        .map((page) => this.#identified.get(page))
        .filter((handle): handle is string => handle !== undefined),
    );
    // A tab whose debugger Chrome took off is listed — it is still his tab,
    // still open — but it is never drivable again over this connection, so
    // pairing skips it and its verbs fail with the detach's reason rather
    // than quietly driving a page the bridge cannot command.
    const tabs = this.#bridge
      .tabs()
      .filter(
        (tab) =>
          tab.id !== undefined &&
          !this.#detached.has(tab.id) &&
          !boundHandles.has(handleFor(tab.id)),
      );

    // Address first, and only where the address is unique on both sides —
    // two tabs on the same page stay unpaired-by-address and fall to order.
    const pagesByUrl = this.#uniqueBy(pages, (page) => page.url());
    const tabsByUrl = this.#uniqueBy(tabs, (tab) => tab.url ?? '');
    const restOfTabs = [...tabs];
    const restOfPages: Page[] = [];
    for (const page of unbound) {
      const tab = pagesByUrl.has(page.url()) ? tabsByUrl.get(page.url()) : undefined;
      if (tab !== undefined && tab.id !== undefined && !boundHandles.has(handleFor(tab.id))) {
        this.#bind(tab.id, page);
        const at = restOfTabs.findIndex((candidate) => candidate.id === tab.id);
        if (at !== -1) restOfTabs.splice(at, 1);
      } else {
        restOfPages.push(page);
      }
    }

    // Position for what is left, up to whichever list is shorter; the surplus
    // is left honestly unaddressed rather than guessed at against a tab it
    // has no fact tying it to.
    for (let at = 0; at < Math.min(restOfPages.length, restOfTabs.length); at += 1) {
      const tab = restOfTabs[at];
      const page = restOfPages[at];
      if (tab?.id !== undefined && page !== undefined) this.#bind(tab.id, page);
    }
  }

  /** Entries whose key occurs exactly once, keyed by that key. */
  #uniqueBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
    const out = new Map<string, T>();
    for (const item of items) {
      if (counts.get(key(item)) === 1) out.set(key(item), item);
    }
    return out;
  }

  /** The tab id is (or was, this session) in the ownership mirror. */
  #ownsTab(tab: TabHandle): boolean {
    const tabId = tabIdOf(tab.driverTabId);
    if (tabId === undefined) return false;
    return this.#bridge.isOurs(tabId) || this.#seenTabs.has(tabId);
  }

  #bind(tabId: number, page: Page): TabHandle {
    this.#seenTabs.add(tabId);
    const handle = handleFor(tabId);
    this.#pages.set(handle, page);
    this.#identified.set(page, handle);
    this.#recordFrom(handle, page);
    return { browser: this.#browser, driverTabId: handle };
  }

  #mirrorTabIds(): number[] {
    return this.#bridge.tabs().flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
  }

  /** The mirror entry that is not in `before`, within the settle bound. */
  async #waitForNewMirrorTab(before: ReadonlySet<number>): Promise<number | undefined> {
    const deadline = Date.now() + MIRROR_SETTLE_MS;
    for (;;) {
      const fresh = this.#mirrorTabIds().filter((id) => !before.has(id));
      if (fresh.length > 0) return fresh[0];
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // ── Accumulation, artefacts, references ─────────────────────────────────

  /** Console and network from the moment the page is first named — as `real.ts` attaches them. */
  #recordFrom(handle: string, page: Page): void {
    if (this.#recordings.has(handle)) return;
    const recording: PageRecording = { console: [], network: [] };
    this.#recordings.set(handle, recording);

    const entries = new WeakMap<Request, NetworkEntry>();

    page.on('console', (message: ConsoleMessage) => {
      recording.console.push(`${message.type()}: ${message.text()}`);
    });
    page.on('request', (request: Request) => {
      const entry: NetworkEntry = {
        method: request.method(),
        url: request.url(),
        startedAt: Date.now(),
      };
      entries.set(request, entry);
      recording.network.push(entry);
    });
    page.on('response', (response) => {
      const entry = entries.get(response.request());
      if (entry === undefined || entry.outcome !== undefined) return;
      entry.outcome = {
        kind: 'response',
        status: response.status(),
        elapsedMs: Date.now() - entry.startedAt,
      };
    });
    page.on('requestfailed', (request: Request) => {
      const entry = entries.get(request);
      if (entry === undefined || entry.outcome !== undefined) return;
      entry.outcome = {
        kind: 'failed',
        reason: request.failure()?.errorText ?? 'no reason reported',
        elapsedMs: Date.now() - entry.startedAt,
      };
    });

    // **No dialog handler, and that is the read-only rule, not an omission.**
    // Answering a native dialog is the `dialog` verb, and no verb of the
    // write half runs here; a dialog on his tab is his to answer, and an
    // attached session that dismissed it for him would be acting on his page.
  }

  #recording(handle: string): PageRecording {
    return this.#recordings.get(handle) ?? { console: [], network: [] };
  }

  /** The snapshot render, narrowed and annotated as `real.ts` does, bounded as above. */
  async #writeSnapshot(tab: TabHandle, page: Page, find?: SnapshotFilter): Promise<ArtifactResult> {
    const snapshot = await page.locator('html').ariaSnapshot({
      mode: 'ai',
      timeout: SNAPSHOT_RENDER_MS,
    });
    const narrowed = find === undefined ? snapshot : filterSnapshot(snapshot, find);
    return this.#write(tab, 'snapshot', page.url(), annotateRefless(narrowed));
  }

  /** One artefact into this session's output directory — `real.ts`'s naming, for the same reasons. */
  #write(tab: TabHandle, artifact: ReadArtifact, url: string, contents: string): ArtifactResult {
    fs.mkdirSync(this.#outputDirectory, { recursive: true });
    const fileName = [
      slugFromUrl(url),
      artifact,
      stampFromInstant(new Date()),
      tab.driverTabId,
      String(this.#artifactsWritten),
    ].join('-');
    this.#artifactsWritten += 1;

    const destination = path.join(this.#outputDirectory, `${fileName}.txt`);
    const bytes = Buffer.byteLength(contents, 'utf8');
    fs.writeFileSync(destination, contents, 'utf8');
    return { artifact, path: destination, bytes, truncated: false };
  }

  /** Reference resolution against the AI-mode registration — as `real.ts`'s. */
  async #locate(page: Page, ref: string): Promise<ReturnType<Page['locator']>> {
    if (!this.#referenced.has(page)) {
      this.#referenced.add(page);
      await page.locator('html').ariaSnapshot({ mode: 'ai', timeout: SNAPSHOT_RENDER_MS });
    }
    const locator = page.locator(`aria-ref=${ref}`);
    try {
      await locator.waitFor({ state: 'attached', timeout: REFERENCE_RESOLUTION_MS });
    } catch {
      throw new AttachedError(
        'act.ref_resolves',
        `No element on this page matches the reference "${ref}". References are minted by a snapshot and describe the page as it was when that snapshot was taken, so a reference goes stale when the page changes underneath it. Read the page again and use a reference from the snapshot that read returns.`,
      );
    }
    return locator;
  }
}
