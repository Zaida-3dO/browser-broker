// The attached browser session: a **read-only** view of a person's own browser,
// driven over the bridge in `src/attach/` rather than over a debugging port the
// service opened itself.
//
// This file is the session layer the attach README names as its only consumer
// below the seam: it calls `connect()`, drives the returned bridge with
// Playwright, and implements {@link BrowserSession}. What it never does is
// what makes the other two kinds what they are — it never launches his
// browser and never closes it, and its storage is never seeded. It writes to
// his page only where the gate allows. A verb that would
// write to his page runs only when `src/attach/gate.ts` says so — the site
// fence, the field guards, the repeat window and the owner grant, all decided
// **before the bridge is asked**, so the refusal and the absence of the side
// effect are the same fact rather than two promises that can drift. Seeding,
// expressions and full-page captures are refused outright, list or no list.
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
  type Locator,
  type Page,
  type Request,
} from 'playwright-core';

import { slugFromUrl, stampFromInstant } from '../artifacts/names.ts';
import {
  NAVIGATION_KEYS,
  createGrantRegistry,
  decide,
  grantValueDigest,
  isConsequentialText,
  modifierTokensOf,
  verifyOwnerGrant,
  type ActTarget,
  type GateDecision,
  type GrantState,
  type OwnerGrantRegistry,
} from '../attach/gate.ts';
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
import {
  SECRET_FIELD_SELECTOR,
  holdsFocus,
  hostOf,
  readControlFacts,
  readFocusedControl,
  scanSecretField,
} from './attached-facts.ts';
import { readPngDimensions, renderNetworkLog, type NetworkEntry } from './render.ts';

export { SECRET_FIELD_SELECTOR, hostOf };

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
 * How long a press may wait for the focus read before it refuses.
 *
 * The read is one small command over the bridge and answers in milliseconds
 * where a real browser is on the other end. But **every wait over this
 * bridge is bounded** — an unbounded one holds a lease on his browser
 * indefinitely — and its failure mode must be a refusal rather than a hang:
 * a page that will not answer the focus question gets the same answer a
 * fixture that cannot complete the read gets, and in both cases the key
 * never goes out.
 */
const FOCUS_PROBE_MS = 5_000;

/**
 * How long an acted verb keeps the **repeat** guard up for that same tab,
 * verb and refs.
 *
 * Thirty seconds because it is a human-scale window: long enough that a
 * model re-asking on stale references lands inside it, short enough that a
 * person's own deliberate second click an hour later is not blocked. The
 * guard does not fire on the window alone — the gate only honours the answer
 * for a repeat whose page has **moved** since the first act (the repeat is
 * the tell of acting against a snapshot that navigation invalidated), and a
 * further act without navigation in between is not a repeat. The session
 * keeps the clock and the navigation generation; {@link decide} judges.
 */
const REPEAT_WINDOW_MS = 30_000;

/** The longest page-supplied control name the action log keeps. */
const ACTION_NAME_CAP = 200;

/**
 * The keys `press` may send as view-moving.
 *
 * Scrolling and dismissing are the only things a key may do to a page this
 * kind reads: they change which part of the page is visible and what is drawn
 * over it, never what the page holds. A key that could reach a focused field
 * is a typing verb wearing a key's name, and typing is what the read-only
 * rule exists to forbid — so the movement keys here are gated on the press
 * path's focus read (the session's `focusedFormControl`): the same ArrowDown
 * that scrolls an unfocused page moves the value of a focused select. The
 * names are allow-listed because a person watching a
 * page presses them (§13n); whether *this* press may go out is the page's
 * fact, not the name's. **The list is the gate's own** (`NAVIGATION_KEYS`):
 * one spelling, so the gate's allowance and this door's can never differ.
 */
const ALLOWED_PRESS_KEYS: ReadonlySet<string> = new Set(NAVIGATION_KEYS);

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
 * What the focus read learns about one element of the page's focus chain:
 * the tag, whether it is editable, whether it opens a shadow tree, its
 * literal `role` attribute, and whether it carries `aria-valuenow`.
 * JSON's shape on purpose — the read crosses the bridge as **data**, and
 * the decision stays on this side of it, where a table of rows can test it
 * without a browser.
 */
export interface FocusChainElement {
  tagName: string;
  isContentEditable: boolean;
  hasShadowRoot: boolean;
  /** The `role` attribute as written, lower-cased; null when absent. */
  role: string | null;
  /** Whether the element carries `aria-valuenow` — a value by name. */
  hasAriaValue: boolean;
}

/**
 * ARIA roles whose own default behaviour under the movement keys **moves a
 * value**: an arrow changes a slider or spinbutton, a selection in a listbox
 * or radio group, the caret in a textbox. The set is fixed here rather than
 * derived — it is the list of widgets the keys on the allow-list act on, and
 * an unlisted role is only refused when it names a value through
 * `aria-valuenow`.
 */
const WIDGET_ROLES = new Set([
  'checkbox',
  'combobox',
  'grid',
  'listbox',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'radiogroup',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'textbox',
  'tree',
  'treegrid',
]);

/**
 * Tags that either move or edit their own value under the movement keys,
 * or hide their focus from the top-document read: a `SELECT`, a
 * `TEXTAREA`, any `INPUT` (radio and range groups move under arrows; a
 * text field takes carets), and an `<IFRAME>` — a key event routes to the
 * focused element of the focused frame, so focus reported as an
 * `<IFRAME>` is focus inside a frame the read cannot enter.
 */
const OPAQUE_FOCUS_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'IFRAME']);

/**
 * The decision half of the press gate: could a movement key move a
 * **value** anywhere on this focus chain?
 *
 * The answer is an **allow-list, not a deny-list**: a key passes only when
 * every element of the chain is proved to be plain focus — an element that
 * can hold no value a key could move. Every fact that could hide one must
 * be proved absent: the tag is not one that moves or edits its own value
 * under the arrows, or hides its focus from the top-document read
 * ({@link OPAQUE_FOCUS_TAGS}); the element is not contenteditable; it
 * opens no shadow tree — focus inside an open tree reports at the **host**,
 * so a host is treated as holding whatever control hides beneath it; it is
 * not a **custom element**, whose name carries a hyphen and whose controls
 * live in a shadow root, a **closed** one reporting nothing to anyone
 * outside it; it names no ARIA value widget through `role`
 * ({@link WIDGET_ROLES}) and carries no `aria-valuenow`. Everything else —
 * the page body, a link, a plain `div` — is plain focus, and an empty
 * chain (nothing focused) answers false: there is nothing to reach. The
 * point of inverting it is that a deny-list refuses only the shapes its
 * author thought of, while the allow-list refuses everything the read
 * cannot positively clear — the fail-safe direction the gate is meant to
 * lean.
 */
export function focusChainHoldsFormControl(chain: readonly FocusChainElement[]): boolean {
  return !chain.every(holdsNoValue);
}

/** Whether this one element is proved plain: nothing it holds moves under a key. */
function holdsNoValue(element: FocusChainElement): boolean {
  return (
    !element.isContentEditable &&
    !element.hasShadowRoot &&
    !element.tagName.includes('-') && // a custom element's controls live in a shadow root
    !OPAQUE_FOCUS_TAGS.has(element.tagName) &&
    !element.hasAriaValue &&
    (element.role === null || !WIDGET_ROLES.has(element.role))
  );
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
  /**
   * What the press gate learns about page focus, injected on the same seam
   * convention as {@link launchConnectPage}. The default asks the page
   * itself ({@link AttachedBrowserSession} reads the focus chain through the
   * bridge); a test supplies the answer both ways, because the fake relay
   * cannot complete a page evaluate — the same fixture limit the
   * accessibility render runs into — and the gate's two branches must be
   * provable anyway.
   */
  readonly focusProbe?: () => Promise<readonly FocusChainElement[]>;
  /**
   * The act-site list (`BROKER_ATTACHED_ACT_SITES`). **Empty by default,
   * which is acting off** — the read-only posture stands and every acting
   * verb refuses as it always did.
   */
  readonly attachedActSites?: readonly string[];
  /**
   * The owner-grant signing secret (`BROKER_OWNER_GRANT_SECRET`). Passed to
   * {@link verifyOwnerGrant} for the one tuple the current call presents;
   * never logged, never echoed, never part of any refusal sentence.
   */
  readonly ownerGrantSecret?: string;
  /**
   * Where the session appends one row per acting-verb decision it makes
   * (`attached_actions`, step 13). Injected because this layer does not own
   * the store — the same sink convention as {@link log} above.
   */
  readonly actionLog?: (entry: AttachedActionLogEntry) => void;
  /**
   * What the field guards learn about a named ref — tag, role, accessible
   * name, input type, autocomplete. Injected on {@link focusProbe}'s seam
   * convention: the fake relay cannot complete a locator evaluate any more
   * than it can the accessibility render, and the guards' rows must be
   * provable anyway. Absent, the session reads the element itself.
   */
  readonly elementFactsProbe?: (ref: string) => Promise<ActTarget | null>;
  /**
   * Whether the page holds a password or card field. Injected on the same
   * convention; absent, the session runs its own fixed scan, and a scan the
   * page will not answer counts as **yes** (a page that cannot rule a field
   * out cannot be submitted through).
   */
  readonly pageSecretProbe?: () => Promise<boolean>;
  /**
   * What a `press` that names no ref reaches: the focused control's facts,
   * or `null` when the read cannot say. Absent, the session reads the page's
   * own `activeElement`; frames and shadow hosts answer `null`.
   */
  readonly focusedControlProbe?: () => Promise<ActTarget | null>;
  /**
   * The focus proof for a named control — did the control **take** the
   * page's focus, so the keys land on it. Injected on the same seam
   * convention as {@link focusProbe}: the fake relay cannot complete the
   * focus-and-read the real path runs, and the refusal both ways must be
   * provable anyway. Absent, the session focuses the control itself and
   * runs {@link holdsFocus} against it.
   */
  readonly focusHoldsProbe?: (locator: Locator) => Promise<boolean>;
}

/**
 * What the **caller** carries into one acting call, beyond the seam's
 * `BrowserSession.act` arguments: the identity the owner grant is bound to.
 * Absent (every other caller, and every other verb), the acting path treats
 * the grant seam as never engaged — `needs_owner`, never `no_grant`.
 */
export interface AttachedActContext {
  /** The lease's claim id, for the action-log row. */
  readonly claimId: string;
  /** The lease key, first component of the grant tuple. */
  readonly leaseKey: string;
  /**
   * The owner grant as the operator's retry carried it, wire form
   * `<issued-at-seconds>.<base64url tag>` — the tag is what
   * {@link verifyOwnerGrant} checks, the timestamp is the expiry input.
   * **Never logged, never echoed**: a refusal names the verdict only.
   */
  readonly ownerGrant?: string;
}

/** One acting decision's audit row, as the step-13 `attached_actions` table holds it. */
export interface AttachedActionLogEntry {
  readonly claimId: string;
  readonly driverTabId: string;
  readonly verb: string;
  readonly ref: string | undefined;
  readonly accessibleName: string | undefined;
  readonly host: string;
  /** `acted`, or the refusing rule. The token is never in any field. */
  readonly outcome: string;
}

/** The armed answer to one native dialog — the `dialog` verb's disposition. */
interface DialogDisposition {
  readonly accept: boolean;
  readonly promptText?: string;
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
  // ── A configured path that will not spawn is `no_binary`, not a long wait ──
  //
  // The before-bind check only knows a path is **absent**. A path that names
  // a deleted, non-executable or wrong-type file passes it, spawns a child
  // that is already doomed, and fails **after** this call returns — as an
  // `error` event the launcher's own listener catches so the process
  // survives. Routed here, that reason joins the wait: whoever is waiting
  // stops the moment the spawn is known to be impossible, and the refusal
  // is `attached.no_binary` — the configuration family, not the retryable
  // `not_connected` whose advice ("try again once the extension is
  // connected") is exactly wrong for a broken path. The message carries the
  // error **code**, never the path: the configured path is a machine fact,
  // and a refusal's reason travels into the claim's ledger row.
  let rejectSpawnFailure: ((error: Error) => void) | undefined;
  const spawnFailure = new Promise<never>((_resolve, reject) => {
    rejectSpawnFailure = reject;
  });
  // If the extension arrives first this promise never settles, and if the
  // spawn fails after the race is decided the rejection would be unobserved
  // — itself a process-level problem. Handled either way, as `launch.ts` does.
  spawnFailure.catch(() => undefined);
  const onSpawnError = (error: Error): void => {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'unknown reason';
    // The bridge log's rule is the same as everywhere else in this layer:
    // the reason yes, the configured path and the token never.
    options.log?.(`the connect-page binary could not be started (${code})`);
    rejectSpawnFailure?.(
      new AttachedError(
        'attached.no_binary',
        `the configured binary for "${options.browser}" could not be started for the connect page (${code}). Nothing launched and waiting changes nothing: check its configured path.`,
        { cause: error },
      ),
    );
  };
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
      onSpawnError,
    });
  } catch (error) {
    bridge.close('connect page could not be opened');
    throw error;
  }
  return await attachOverBridge(bridge, options, spawnFailure);
}

/**
 * Attach over a bridge that is already open.
 *
 * Split out because the bridge and the session have different lifetimes and
 * different owners: whoever opens a bridge owns its listener, and every path
 * out of this function — including its refusals — closes it again.
 *
 * `spawnFailure`, when the caller has one, joins the bounded wait: a connect
 * page whose binary could not start is knowable before the extension was
 * ever going to arrive, and the wait must end for that reason rather than
 * sitting out its bound and calling it the extension's absence.
 */
export async function attachOverBridge(
  bridge: AttachedBridge,
  options: AttachedSessionOptions,
  spawnFailure?: Promise<never>,
): Promise<AttachedBrowserSession> {
  try {
    // A token means the extension skips its approval click and answers in
    // seconds; without one the wait is for a person, and the bound widens to
    // the relay's interactive default — still a refusal at the bound, never
    // a queue.
    await Promise.race([
      bridge.waitForExtension(
        options.connectTimeoutMs ??
          (options.token === undefined ? TOKENLESS_CONNECT_WAIT_MS : CONNECT_WAIT_MS),
      ),
      ...(spawnFailure === undefined ? [] : [spawnFailure]),
    ]);
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
      ...(options.focusProbe === undefined ? {} : { focusProbe: options.focusProbe }),
      ...(options.attachedActSites === undefined
        ? {}
        : { attachedActSites: options.attachedActSites }),
      ...(options.ownerGrantSecret === undefined
        ? {}
        : { ownerGrantSecret: options.ownerGrantSecret }),
      ...(options.actionLog === undefined ? {} : { actionLog: options.actionLog }),
      ...(options.elementFactsProbe === undefined
        ? {}
        : { elementFactsProbe: options.elementFactsProbe }),
      ...(options.pageSecretProbe === undefined
        ? {}
        : { pageSecretProbe: options.pageSecretProbe }),
      ...(options.focusedControlProbe === undefined
        ? {}
        : { focusedControlProbe: options.focusedControlProbe }),
      ...(options.focusHoldsProbe === undefined
        ? {}
        : { focusHoldsProbe: options.focusHoldsProbe }),
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
 * Release every modifier a **failed** press may have left held down.
 *
 * The library's `press` walks the key string's tokens in order, holding
 * each modifier down before it tries the next, and on a throw it releases
 * nothing — the keyboard state belongs to the page and survives the call.
 * The gate's grammar keeps this rare (an unpressable base or a wrong-case
 * modifier refuses before the page), but if a press ever fails part-way —
 * a bridge error between two tokens, a name the gate and the library
 * disagree about — a Shift left on the page modifies **every later key**
 * for the rest of the session, approved or not. So the catch that
 * rethrows the failure first lifts each modifier the library would have
 * pressed down (`modifierTokensOf` reads the same grammar); an up on a
 * modifier that was never down is a no-op, so running it after a throw
 * that preceded any key costs nothing.
 */
export async function releaseHeldModifiers(page: Page, value: string): Promise<void> {
  for (const modifier of modifierTokensOf(value)) {
    await page.keyboard.up(modifier).catch(() => undefined);
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

  /** The press gate's focus answer, when a test injected one — see {@link AttachedSessionOptions.focusProbe}. */
  readonly #focusProbe: (() => Promise<readonly FocusChainElement[]>) | undefined;

  // ── Acting state (S2) ───────────────────────────────────────────────────

  /** `BROKER_ATTACHED_ACT_SITES`, read once at construction. Empty is acting off. */
  readonly #actSites: readonly string[];
  /** `BROKER_OWNER_GRANT_SECRET`, held only to verify against. Never logged, never echoed. */
  readonly #grantSecret: string | undefined;
  /** The `attached_actions` sink, when the wiring injected one. */
  readonly #actionLog: ((entry: AttachedActionLogEntry) => void) | undefined;
  /**
   * Spent owner grants for **this session's life**: one token answers one
   * act, and the memory ends where the lease does. Holding the tag in a set
   * is safe — it is an HMAC digest, not the secret.
   */
  readonly #grants: OwnerGrantRegistry = createGrantRegistry();
  /**
   * The last acting call per tab+verb+refs (+ the pressed key, for
   * `press`): when it landed and the navigation generation that was
   * current then. Feeds the gate's `repeatAfterNavigation` — see
   * {@link REPEAT_WINDOW_MS}.
   */
  readonly #acts = new Map<string, { atMs: number; navGen: number }>();
  /**
   * Bumped by every {@link navigate} on this session, before the goto, and by
   * every **main-frame navigation the page reports** — a clicked link, a
   * submitted form, a script's redirect, a same-document history change. The
   * repeat guard asks "did the page move since that act", and the page moves
   * for reasons other than this session's own goto.
   */
  #navGen = 0;
  /**
   * Armed `dialog`-verb answers, per handle, consumed once by the page's
   * own dialog event. An undisposed dialog stays the person's to answer —
   * see {@link #recordFrom}.
   */
  readonly #dialogs = new Map<string, DialogDisposition>();

  /** The field guards' element read, and the other injected acting answers. */
  readonly #elementFactsProbe: ((ref: string) => Promise<ActTarget | null>) | undefined;
  readonly #pageSecretProbe: (() => Promise<boolean>) | undefined;
  readonly #focusedControlProbe: (() => Promise<ActTarget | null>) | undefined;
  readonly #focusHoldsProbe: ((locator: Locator) => Promise<boolean>) | undefined;

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
    focusProbe?: () => Promise<readonly FocusChainElement[]>;
    attachedActSites?: readonly string[];
    ownerGrantSecret?: string;
    actionLog?: (entry: AttachedActionLogEntry) => void;
    elementFactsProbe?: (ref: string) => Promise<ActTarget | null>;
    pageSecretProbe?: () => Promise<boolean>;
    focusedControlProbe?: () => Promise<ActTarget | null>;
    focusHoldsProbe?: (locator: Locator) => Promise<boolean>;
  }) {
    this.#browser = options.browser;
    this.#bridge = options.bridge;
    this.#connection = options.connection;
    this.#context = options.context;
    this.#focusProbe = options.focusProbe;
    this.#actSites = options.attachedActSites ?? [];
    this.#grantSecret = options.ownerGrantSecret;
    this.#actionLog = options.actionLog;
    this.#elementFactsProbe = options.elementFactsProbe;
    this.#pageSecretProbe = options.pageSecretProbe;
    this.#focusedControlProbe = options.focusedControlProbe;
    this.#focusHoldsProbe = options.focusHoldsProbe;
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
    // Bumped **before** the goto: the repeat guard's "did the page move
    // since that act" question is answered against this counter, and a
    // navigation that was asked and then failed has still moved — erring
    // toward treating the page as moved is the safe direction for a guard
    // whose whole job is stale references.
    this.#navGen += 1;
    // **The arm does not ride the navigation.** An armed `dialog` answer
    // belongs to the page that armed it: navigation is free, so a listed
    // page can arm an accept and hand its redirect target a standing
    // disposition — a dialog on an off-list site would then be answered
    // on the owner's behalf where acting verbs never run. The next page
    // must re-arm through the fence itself.
    this.#dialogs.delete(tab.driverTabId);
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
   * `browser_act` on an attached browser: the view-moving verbs always, and
   * the acting verbs only where `src/attach/gate.ts` allows — the site
   * fence, the field guards, the repeat window, and the owner grant.
   *
   * **The refusal is decided before the page is resolved**, so a refused verb
   * is a verb the bridge was never asked to perform — the side-effect half of
   * every rejection test hangs off that ordering. `scroll` with no reference
   * runs a fixed one-line expression this file contains; the session's own
   * fixed expressions are not the caller's expression, and the expression
   * {@link evaluate} refuses is refused there, at its own door.
   *
   * `context` is {@link AttachedActContext}: the caller-side half of the
   * owner-grant seam. Every other caller, and every view-moving verb, leaves
   * it absent and the seam stays unengaged.
   */
  async act(
    tab: TabHandle,
    request: ActionRequest,
    secrets?: SecretScope,
    context?: AttachedActContext,
  ): Promise<ArtifactResult> {
    this.#refuseSecrets(secrets);
    if ('value' in request && looksLikeSentinel(request.value)) {
      throw new AttachedError(
        'attached.no_secrets',
        'A secret sentinel reached an attached browser. Secrets are typed into fields, and an attached browser is never typed into — the secret was never resolved.',
      );
    }

    // ── The host-free half of the gate, before the page or the mirror ────
    //
    // What `decide` can answer without knowing which site this is: the
    // never-acted verbs, an empty act list (the capability itself is off,
    // so the read-only sentence stands for any site), and the view-moving
    // allow-list. `attached.act_site_off_list` is the one answer that
    // genuinely needs the page's address, and it waits for the second,
    // fully-informed `decide` below — a refusal that needs a host the
    // session has not looked at yet would be a guess about someone else's
    // tab. This ordering is also why a hostile verb on a **foreign** handle
    // still refuses on the rule before the ownership rule: the gate's
    // sentence is true of the verb, whatever tab it named.
    const preflight = decide({
      siteHost: '',
      verb: request.action,
      ...(request.action === 'press' ? { value: request.value } : {}),
      stage: 'fence',
      pageHasSecretField: false,
      actSites: this.#actSites,
    });
    if (preflight.decision !== 'allow' && preflight.decision !== 'attached.act_site_off_list') {
      this.#logAction(tab, request, context, '', undefined, preflight.decision);
      throw new AttachedError(preflight.decision, preflight.message);
    }

    this.#requireOurs(tab);

    const page = this.#page(tab);
    if (!isViewMovingAction(request)) {
      return await this.#actOnListedSite(tab, page, request, context);
    }
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
        // Allowed keys only reach the page, never a field's text: the
        // preflight's `decide` already let the key through as a movement or
        // dismiss key.
        //
        // **Whether a key could reach a focused field is a fact about the page,
        // not about the key name** — §7.1's `attached.read_only` refuses "press
        // of anything that could reach a focused field", and the same arrows
        // that move the view over the page body move the value of a focused
        // select, radio group or range input and fire its change. So the press
        // is gated on one fixed read this file owns, asking Chrome itself what
        // holds focus (see {@link #focusedFormControl} — and its fail-safe
        // halves: a frame or shadow tree the read cannot enter is refused, not
        // guessed through), and it refuses while a form control holds it. That
        // includes `Escape`: over a focused search field it is not only a
        // dismissal — the field's own behaviour clears the text and fires the
        // events live-search pages act on — so dismissal is gated too, and
        // still dismisses wherever the page holds no form control. And when
        // the read cannot answer, the press does not happen either: a key
        // whose focus cannot be seen is a key that could reach his field, and
        // guessing is what the rule exists to stop.
        let formControlHoldsFocus: boolean;
        try {
          formControlHoldsFocus = await this.#focusedFormControl(page);
        } catch {
          throw new AttachedError(
            'attached.read_only',
            `press of "${request.value}" is refused because the page could not be asked what holds its focus, and a key that could reach a field is not pressed on trust.`,
          );
        }
        if (formControlHoldsFocus) {
          throw new AttachedError(
            'attached.read_only',
            `press of "${request.value}" is refused while a form control holds the page's focus: over a focused select, radio group, range input or field the movement keys change that control's value, not the view, and Escape clears a focused search field. What his page holds focused is not reported.`,
          );
        }
        try {
          await page.keyboard.press(request.value);
        } catch (error) {
          await releaseHeldModifiers(page, request.value);
          throw error;
        }
        break;
      }
    }
    return await this.#writeSnapshot(tab, page);
  }

  /**
   * Whether the page holds a form control focused at the moment of the press
   * — one fixed read, written here, of the browser's own focus fact.
   *
   * This is a **fixed expression of this file**, in the same standing as the
   * scroll instruction above: {@link evaluate} refuses the caller's program,
   * and nothing the caller wrote is part of this one. (The alternative — one
   * accessibility-tree command with no expression at all — was tried and
   * dropped: the bridge has no browser-level CDP target, because
   * `chrome.debugger` is per-tab, so a fresh protocol session cannot be
   * opened over it. The expression route is the one that reaches focus.)
   * The read answers with the focused element's *facts* — tag, editability,
   * shadow root, `role`, `aria-valuenow` — and {@link focusChainHoldsFormControl}
   * makes the decision on this side of the bridge, where a table can prove
   * it either way.
   *
   * **What the read cannot see, it refuses.** A key event routes to the
   * focused element of the *focused frame*, and the top document's
   * `activeElement` answers only for itself: focus inside a frame reports
   * the `<IFRAME>` element, and focus inside an open shadow tree reports
   * the **host**. Both are counted as focused-control state — the press
   * refuses rather than dispatching into a frame or tree the read cannot
   * enter. The read also answers with the `role` attribute and whether
   * `aria-valuenow` is present, so the predicate can refuse an ARIA value
   * widget and a custom element by those facts rather than by the tag: the
   * value of a widget built on other tags moves under the same arrows, and
   * a **closed** shadow root reports nothing to anyone outside it, so its
   * host element is refused rather than cleared. What stays outside the
   * gate is the page's own code: a script on the page can bind any allowed
   * key to an action of its choosing, and the gate covers the **default**
   * actions of the keys, not the page's handlers. That is why this is a
   * fail-safe gate, not a complete model of focus. If the read itself
   * fails, this **throws**: an unread focus is refused upstream, never
   * assumed safe.
   */
  async #focusedFormControl(page: Page): Promise<boolean> {
    const read = (this.#focusProbe ?? (() => this.#readFocusChain(page)))();
    void read.catch(() => undefined); // the race may win first; keep it handled
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unreadable = new Promise<'unreadable'>((resolve) => {
      timer = setTimeout(() => resolve('unreadable'), FOCUS_PROBE_MS);
    });
    const answer = await Promise.race([read, unreadable]);
    clearTimeout(timer);
    if (answer === 'unreadable') {
      throw new Error(`the focus read did not answer within ${String(FOCUS_PROBE_MS)}ms`);
    }
    return focusChainHoldsFormControl(answer);
  }

  /**
   * The default focus answer: the top document's focused element, as data.
   * The frame and shadow-tree cases are not looked *through* — they arrive
   * here as an `<IFRAME>` tag and a shadow root on the host, and the
   * predicate turns both into a refusal.
   */
  #readFocusChain(page: Page): Promise<readonly FocusChainElement[]> {
    return page.evaluate(() => {
      const scope = globalThis as unknown as {
        document: {
          activeElement: {
            tagName: string;
            isContentEditable?: boolean;
            shadowRoot?: unknown;
            getAttribute: (name: string) => string | null;
            hasAttribute: (name: string) => boolean;
          } | null;
        };
      };
      const element = scope.document.activeElement;
      if (element === null) return [];
      const role = element.getAttribute('role');
      return [
        {
          tagName: element.tagName,
          isContentEditable: element.isContentEditable === true,
          hasShadowRoot: element.shadowRoot !== null && element.shadowRoot !== undefined,
          role: role === null ? null : role.trim().toLowerCase(),
          hasAriaValue: element.hasAttribute('aria-valuenow'),
        },
      ];
    });
  }

  // ── Acting on a listed site ─────────────────────────────────────────────

  /**
   * The acting verbs, reached only after the preflight let the verb through
   * as one that *can* act and the tab resolved to one of ours.
   *
   * The gate's remaining answers need facts the page holds — its host, what
   * the named control is, whether the page carries a secret field, whether
   * this is a replay across a navigation, and what the owner grant says —
   * so they are read here, in the open, before the browser performs
   * anything. **Every fact the page will not answer is a refusal**, in the
   * same fail-safe direction as the focus read: a control this session
   * cannot describe is a control it cannot rule out as a password field,
   * and the call ends before `Input.*` is ever mentioned.
   */
  async #actOnListedSite(
    tab: TabHandle,
    page: Page,
    request: ActionRequest,
    context: AttachedActContext | undefined,
  ): Promise<ArtifactResult> {
    const host = hostOf(page.url());

    // The site fence, with the address now known. An attached page on
    // `about:blank` or an unread address answers `''`: not on any list, and
    // the honest reason is "this site is not listed", not a guess.
    const fence = decide({
      siteHost: host,
      verb: request.action,
      ...(request.action === 'press' ? { value: request.value } : {}),
      stage: 'fence',
      pageHasSecretField: false,
      actSites: this.#actSites,
    });
    if (fence.decision !== 'allow') {
      this.#logAction(tab, request, context, host, undefined, fence.decision);
      throw new AttachedError(fence.decision, fence.message);
    }

    // ── What this call reaches ────────────────────────────────────────────
    const refs = this.#refsOf(request);
    const named = new Map<string, ActTarget>();
    // **One whole-page snapshot serves every ref of the call.** The library
    // resolves a ref against the last snapshot taken in its frame, and a
    // snapshot of one element makes that the frame's whole ref map, holding only the element's own subtree —
    // so reading each ref's facts from its own snapshot left the second ref
    // of a drag or a form unresolvable.
    let pageSnapshot: string | undefined;
    if (refs.length > 0 && this.#elementFactsProbe === undefined) {
      try {
        pageSnapshot = await this.#pageSnapshotText(page);
      } catch {
        const message = `This "${request.action}" could not read the page to learn which controls its references are, so it cannot rule out a password or code field; nothing was attempted.`;
        this.#logAction(tab, request, context, host, undefined, 'attached.field_forbidden');
        throw new AttachedError('attached.field_forbidden', message);
      }
    }
    for (const ref of refs) {
      try {
        named.set(ref, await this.#elementFacts(page, ref, pageSnapshot));
      } catch (error) {
        // A ref that resolves to nothing is the stale-reference case with its
        // own guidance; anything else that went wrong reading the control is
        // the unread-control case, and both refuse before any act.
        if (error instanceof AttachedError) {
          this.#logAction(tab, request, context, host, undefined, error.rule);
          throw error;
        }
        const message = `This "${request.action}" could not be asked which control "${ref}" is, so it cannot rule out a password or code field; nothing was attempted.`;
        this.#logAction(tab, request, context, host, undefined, 'attached.field_forbidden');
        throw new AttachedError('attached.field_forbidden', message);
      }
    }

    const pageHasSecretField = await this.#pageSecretField(page);
    const navigationsBefore = this.#navGen;
    const focusedControl =
      request.action === 'press' && request.ref === undefined
        ? await this.#focusedControlFacts(page)
        : undefined;
    const repeatAfterNavigation = this.#isRepeat(tab, request, refs);

    // The grant: verified against **this exact call** — this lease, this
    // ref, the accessible name this page reports for it right now, this
    // host — so a token minted for "Pay" cannot answer for "Delete", and a
    // retargeted one is `forged`, not a smaller verdict. A call naming more
    // than one control (drag's pair, fill_form's list) carries no grant at
    // all: the tuple binds a single ref, and a token that cannot say which
    // control it approved approves none of them.
    // The control the grant binds: the named ref if the call named one,
    // else the focused control a no-ref press reaches — the same control the
    // gate reads. A token signed over any other name, ref or host is
    // `forged` against this call.
    const boundTarget = refs[0] !== undefined ? named.get(refs[0]) : (focusedControl ?? undefined);
    const grant = this.#grantState(context, refs, boundTarget, host, request);

    const decideOne = (target: ActTarget | undefined): GateDecision =>
      decide({
        siteHost: host,
        verb: request.action,
        ...('value' in request ? { value: request.value } : {}),
        ...(target === undefined ? {} : { target }),
        ...(focusedControl === undefined ? {} : { focusedControl }),
        pageHasSecretField,
        ...(grant === undefined ? {} : { grant }),
        repeatAfterNavigation,
        actSites: this.#actSites,
      });

    if (request.action === 'fill_form') {
      // Every field passes on its own facts; one forbidden field refuses the
      // whole form, because a form filled except for one box is the shape a
      // page submits by accident.
      for (const field of request.fields) {
        const decision = decideOne(named.get(field.ref));
        if (decision.decision !== 'allow') {
          this.#logAction(tab, request, context, host, named.get(field.ref), decision.decision);
          throw new AttachedError(decision.decision, decision.message);
        }
      }
    } else if (request.action === 'drag') {
      // **Both endpoints are decided.** A drag moves a value *into*
      // `targetRef` and drops *onto* it: Chrome accepts text dropped into
      // an input, and a control named by a consequence word is a
      // consequential target whatever the source was called. Reading both
      // refs' facts and deciding only the first is a gate that has read a
      // control and not asked about it — and a control it has not asked
      // about is a control it has not cleared. The pair carries no grant
      // (`#grantState` refuses multi-ref calls), so a consequence on either
      // side answers `needs_owner`, never an allow.
      for (const ref of refs) {
        const facts = named.get(ref);
        const decision = decideOne(facts);
        if (decision.decision !== 'allow') {
          this.#logAction(tab, request, context, host, facts, decision.decision);
          throw new AttachedError(decision.decision, decision.message);
        }
      }
    } else {
      // A `press` naming no ref passes **no** target, so the gate falls back
      // to the focused control — and if that read could not say, the gate's
      // own "cannot say which control it reaches" row refuses. The key needs
      // no mention here: every key the gate would exempt as view-moving left
      // for the view-moving branch above.
      const facts = refs[0] === undefined ? undefined : named.get(refs[0]);
      const decision = decideOne(facts);
      if (decision.decision !== 'allow') {
        this.#logAction(tab, request, context, host, facts, decision.decision);
        throw new AttachedError(decision.decision, decision.message);
      }
    }

    // ── Allowed: the browser work, mirroring `real.ts` verb for verb ──────
    await this.#performActing(tab, page, request);
    // The generation recorded is the one **before** the act, so a page the
    // act itself moved (a click on "Next", a submit) counts as moved since:
    // the replay of the same ref onto the new page is the stale-reference
    // mistake the guard exists for.
    this.#acts.set(this.#repeatKey(tab, request, refs), {
      atMs: Date.now(),
      navGen: navigationsBefore,
    });
    const primary = refs[0];
    this.#logAction(
      tab,
      request,
      context,
      host,
      primary === undefined ? undefined : named.get(primary),
      'acted',
    );
    return await this.#writeSnapshot(tab, page);
  }

  /** The refs one acting request names, in call order. */
  #refsOf(request: ActionRequest): readonly string[] {
    switch (request.action) {
      case 'click':
      case 'check':
      case 'hover':
      case 'type':
      case 'fill':
      case 'select':
        return [request.ref];
      case 'press':
        return request.ref === undefined ? [] : [request.ref];
      case 'drag':
        return [request.ref, request.targetRef];
      case 'fill_form':
        return request.fields.map((field) => field.ref);
      default:
        return [];
    }
  }

  #repeatKey(tab: TabHandle, request: ActionRequest, refs: readonly string[]): string {
    // "Identical act" means the key it presses too: `press` is the one
    // acting verb whose *parameter* is the act (the others say everything
    // they do through verb and refs), so a second press of a **different**
    // key onto the same refs after a navigation is a new act, not a
    // replay — and the guard that refuses anyway over-refuses safe keys
    // off a page it merely wants re-read.
    const pressed = request.action === 'press' ? `|${request.value}` : '';
    return `${tab.driverTabId}|${request.action}${pressed}|${refs.join(',')}`;
  }

  /**
   * The repeat answer the gate honours: the same tab, verb, refs (and
   * pressed key) landed inside the window **and** a navigation has
   * happened since — replaying an
   * act onto a page that has moved underneath it is the mistake this stops.
   * The same act again with no navigation between is not a repeat.
   */
  #isRepeat(tab: TabHandle, request: ActionRequest, refs: readonly string[]): boolean {
    const prior = this.#acts.get(this.#repeatKey(tab, request, refs));
    if (prior === undefined) return false;
    return Date.now() - prior.atMs <= REPEAT_WINDOW_MS && this.#navGen > prior.navGen;
  }

  /**
   * The grant as this call presents it: absent when the caller engaged no
   * seam (the agent's path), present-and-verified when an operator's retry
   * carried a token. Multi-ref calls never engage it — see the note at the
   * call site. The wire form is `<issued-at-seconds>.<base64url tag>`; a
   * token with no parseable stamp verifies against issued-at `0`, which
   * `verifyOwnerGrant` reads as expired at best and forged at worst —
   * malformed input is never a partial pass.
   */
  #grantState(
    context: AttachedActContext | undefined,
    refs: readonly string[],
    control: ActTarget | undefined,
    host: string,
    request: ActionRequest,
  ): GrantState | undefined {
    if (context?.ownerGrant === undefined) return undefined;
    if (refs.length > 1) return undefined;
    const ref = refs[0] ?? '';
    const at = context.ownerGrant.lastIndexOf('.');
    let tag = context.ownerGrant;
    let issuedAtSeconds = 0;
    if (at > 0) {
      const stamped = Number(context.ownerGrant.slice(0, at));
      if (Number.isSafeInteger(stamped) && stamped >= 0) {
        tag = context.ownerGrant.slice(at + 1);
        issuedAtSeconds = stamped;
      }
    }
    const verdict = verifyOwnerGrant(
      tag,
      this.#grantSecret,
      {
        leaseKey: context.leaseKey,
        ref,
        accessibleName: control?.accessibleName ?? '',
        urlHost: host,
        issuedAtSeconds,
        // The grant answers one verb carrying one value: approving "click
        // Pay" is not approving a `type` of a different amount into the
        // same ref.
        verb: request.action,
        valueDigest: grantValueDigest('value' in request ? request.value : undefined),
      },
      Math.floor(Date.now() / 1_000),
      this.#grants,
    );
    return { present: true, verdict };
  }

  /**
   * The page's accessibility snapshot as text — the one a call's refs are
   * read from, and the one the library then resolves them against. Marks the
   * page as referenced, so {@link #locate} does not take a second one that
   * would replace this.
   */
  async #pageSnapshotText(page: Page): Promise<string> {
    const text = await page.locator('html').ariaSnapshot({
      mode: 'ai',
      timeout: SNAPSHOT_RENDER_MS,
    });
    this.#referenced.add(page);
    return text;
  }

  /**
   * One ref's facts as the gate reads them. With the injected probe
   * ({@link AttachedSessionOptions.elementFactsProbe}) the answer is given;
   * without it the session reads the element — `readControlFacts`, which
   * joins the page's own read (type, `autocomplete`, every name the control
   * answers to, the frame it lives in) with the snapshot's line for the ref.
   * A read that will not answer throws — the caller turns that into a
   * refusal, never a guess.
   */
  async #elementFacts(page: Page, ref: string, snapshot?: string): Promise<ActTarget> {
    if (this.#elementFactsProbe !== undefined) {
      const answer = await this.#elementFactsProbe(ref);
      // `null` from the probe is "this control cannot be described", which
      // is the unread-control case, not a blank target: a guard cannot clear
      // a field it cannot see, and the caller turns the throw into a
      // refusal.
      if (answer === null) throw new Error(`the element read could not describe "${ref}"`);
      return answer;
    }
    return await readControlFacts(await this.#locate(page, ref), snapshot, ref);
  }

  /**
   * Whether the page holds a secret field. The fixed scan is this file's,
   * not the caller's; **a page that will not answer counts as holding one**
   * — the fact's only use is refusing a submit over it, and the safe
   * failure is the refusal.
   */
  async #pageSecretField(page: Page): Promise<boolean> {
    if (this.#pageSecretProbe !== undefined) {
      try {
        return await this.#pageSecretProbe();
      } catch {
        return true;
      }
    }
    return await scanSecretField(page);
  }

  /**
   * What a `press` that names no ref reaches: the focused control's facts,
   * or `null` when the read cannot say. The same read a named ref gets (see
   * `readFocusedControl`): the focused field's type and `autocomplete` are
   * known, so a password box holding the cursor is refused as one.
   */
  async #focusedControlFacts(page: Page): Promise<ActTarget | null> {
    if (this.#focusedControlProbe !== undefined) {
      try {
        return await this.#focusedControlProbe();
      } catch {
        return null;
      }
    }
    try {
      return await readFocusedControl(page);
    } catch {
      return null;
    }
  }

  /**
   * The gate judged the **named** control; this proves the keys will land on
   * it. `pressSequentially` and `locator.press` only *try* to focus — a
   * disabled or otherwise unfocusable element raises no error and takes no
   * keys: they go wherever focus actually sits, which is a password box
   * holding the cursor, or the page body and its site shortcuts. So the
   * control is focused, and one fixed in-page read (`holdsFocus`, in
   * `attached-facts.ts` — it walks the active element through open shadow
   * roots and same-frame, and it was written before the first key was ever
   * sent, because after the keys the state it would report is gone) asks
   * whether the element **is** the deep active element now. If it is not —
   * or the read or the focus itself fails — the answer is
   * `attached.field_forbidden`, and no key has crossed.
   *
   * This makes the agent's **own targeting honest**, not the page's: a page
   * that moves focus of its own accord between characters of a sequential
   * type stays a documented residual (§13o of the design notes).
   */
  async #holdFocused(locator: Locator, action: string): Promise<void> {
    if (this.#focusHoldsProbe !== undefined) {
      // The injected answer stands in for both steps: on the fake relay
      // neither a locator focus nor the in-page read completes, and the
      // refusal both ways has to be provable. It is held to the same bar:
      // an answer it cannot give is an answer it does not vouch for.
      let probed: boolean;
      try {
        probed = await this.#focusHoldsProbe(locator);
      } catch {
        throw new AttachedError(
          'attached.field_forbidden',
          `This "${action}" is refused because the page could not be asked whether the control holds its focus; no key was sent.`,
        );
      }
      if (!probed) {
        throw new AttachedError(
          'attached.field_forbidden',
          `This "${action}" is refused because the control would not take focus — the keys would have landed somewhere else on the page, and a control the broker cannot put the keys into is a control it cannot clear.`,
        );
      }
      return;
    }
    try {
      await locator.focus();
    } catch {
      throw new AttachedError(
        'attached.field_forbidden',
        `This "${action}" is refused because the control would not take focus — the keys would have landed somewhere else on the page, and a control the broker cannot put the keys into is a control it cannot clear.`,
      );
    }
    let focused: boolean;
    try {
      focused = await holdsFocus(locator);
    } catch {
      // A focus this read cannot see is a focus it does not vouch for.
      throw new AttachedError(
        'attached.field_forbidden',
        `This "${action}" is refused because the page could not be asked whether the control holds its focus; no key was sent.`,
      );
    }
    if (!focused) {
      throw new AttachedError(
        'attached.field_forbidden',
        `This "${action}" is refused because the control would not take focus — the keys would have landed somewhere else on the page, and a control the broker cannot put the keys into is a control it cannot clear.`,
      );
    }
  }

  /**
   * The physical half of an allowed acting verb — `real.ts`'s operations,
   * over this bridge. Only reached after every gate has said yes.
   * (`hover` and `scroll` never arrive here; the view-moving branch above
   * runs them.)
   */
  async #performActing(tab: TabHandle, page: Page, request: ActionRequest): Promise<void> {
    switch (request.action) {
      case 'click': {
        await (await this.#locate(page, request.ref)).click();
        break;
      }
      case 'check': {
        await (await this.#locate(page, request.ref)).check();
        break;
      }
      case 'type': {
        // `type` types as if by keyboard (`real.ts`'s `pressSequentially`);
        // `fill` sets the value — the same split, the same reasons.
        //
        // As if by keyboard means the keys go to whatever holds focus, so
        // the control named has to be shown to hold it first — see
        // {@link #holdFocused}.
        const typed =
          this.#focusHoldsProbe === undefined
            ? await this.#locate(page, request.ref)
            : page.locator(`aria-ref=${request.ref}`);
        await this.#holdFocused(typed, request.action);
        if (this.#focusHoldsProbe === undefined) {
          await typed.pressSequentially(request.value);
        } else {
          // With the focus proof injected there is no locator step to
          // complete: the relay cannot finish the snapshot that mints refs
          // or the resolution that reads them (it answers commands, not
          // evaluates), which is why the probe exists. It answered that the
          // control holds focus, and a focused control receives exactly the
          // keys the page keyboard sends — one press per character, which
          // is what `pressSequentially` carries to a resolved locator.
          for (const character of request.value) {
            await page.keyboard.press(character);
          }
        }
        break;
      }
      case 'fill': {
        await (await this.#locate(page, request.ref)).fill(request.value);
        break;
      }
      case 'select': {
        await (await this.#locate(page, request.ref)).selectOption(request.value);
        break;
      }
      case 'press': {
        // A throw part-way through the key string can leave modifiers held
        // on the page (the library releases nothing on error), so both
        // branches clear them before the failure is rethrown — see
        // {@link releaseHeldModifiers}.
        if (request.ref === undefined) {
          try {
            await page.keyboard.press(request.value);
          } catch (error) {
            await releaseHeldModifiers(page, request.value);
            throw error;
          }
        } else {
          const pressed =
            this.#focusHoldsProbe === undefined
              ? await this.#locate(page, request.ref)
              : page.locator(`aria-ref=${request.ref}`);
          await this.#holdFocused(pressed, request.action);
          try {
            if (this.#focusHoldsProbe === undefined) {
              await pressed.press(request.value);
            } else {
              // Same arrangement as `type` above: the probe stands in for
              // the focus-and-read the relay cannot complete, and a
              // focused control receives what the page keyboard sends.
              await page.keyboard.press(request.value);
            }
          } catch (error) {
            await releaseHeldModifiers(page, request.value);
            throw error;
          }
        }
        break;
      }
      case 'fill_form': {
        for (const field of request.fields) {
          await (await this.#locate(page, field.ref)).fill(field.value);
        }
        break;
      }
      case 'drag': {
        await (
          await this.#locate(page, request.ref)
        ).dragTo(await this.#locate(page, request.targetRef));
        break;
      }
      case 'dialog': {
        // Arm the disposition for the dialog this verb exists to answer;
        // {@link #recordFrom}'s handler spends it once. A dialog that never
        // comes costs nothing; a dialog with no armed disposition stays the
        // person's to answer.
        this.#dialogs.set(tab.driverTabId, {
          accept: request.response.accept,
          ...(request.response.promptText === undefined
            ? {}
            : { promptText: request.response.promptText }),
        });
        break;
      }
    }
  }

  /** One audit row for one acting decision, when the caller identified itself. */
  #logAction(
    tab: TabHandle,
    request: ActionRequest,
    context: AttachedActContext | undefined,
    host: string,
    target: ActTarget | undefined,
    outcome: string,
  ): void {
    if (context === undefined || this.#actionLog === undefined) return;
    const refs = this.#refsOf(request);
    // The name is page-controlled text: capped, so a hostile page cannot
    // bloat the store a row at a time.
    const name = target?.accessibleName;
    try {
      this.#actionLog({
        claimId: context.claimId,
        driverTabId: tab.driverTabId,
        verb: request.action,
        ref: refs[0],
        accessibleName: name === undefined ? undefined : name.slice(0, ACTION_NAME_CAP),
        host,
        outcome,
      });
    } catch {
      // The audit row is written after the browser acted on the `acted`
      // path; a store that is busy must not turn a performed act into an
      // error the caller would retry; the row is the thing that is lost.
    }
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

    // **The page moving drops the arm.** A disposition belongs to the page
    // that armed it: a click on a link, a submitted form or a script's
    // redirect carries the tab to another page without this session's own
    // goto, and a standing "accept" would then answer that page's dialog for
    // the owner — on a site the act list may not even name. The same event
    // bumps the repeat guard's generation.
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.#navGen += 1;
      this.#dialogs.delete(handle);
    });

    // **A dialog is answered only when the `dialog` verb armed an answer
    // first.** The verb arms a disposition (`#actOnListedSite`, behind the
    // gate); this handler spends it, once. A dialog with nothing armed is
    // his to answer — an attached session dismissing a stranger on his own
    // initiative would be acting on his page without being asked to.
    //
    // **And the answer is gated at the moment it is given.** The arm was
    // decided against the page that armed it; the dialog arrives from
    // whatever the page is now, so the site fence is asked again against
    // the live address, and the dialog's own message goes through the
    // consequence table — `confirm("Permanently delete your account?")`
    // raised by a control that was named something harmless is a consequential
    // step, and the owner's. Either refusal spends the arm and leaves the
    // dialog where it was: his to answer.
    page.on('dialog', (dialog) => {
      const disposition = this.#dialogs.get(handle);
      if (disposition === undefined) return;
      this.#dialogs.delete(handle);
      const fence = decide({
        siteHost: hostOf(page.url()),
        verb: 'dialog',
        stage: 'fence',
        pageHasSecretField: false,
        actSites: this.#actSites,
      });
      if (fence.decision !== 'allow' || isConsequentialText(dialog.message())) return;
      const answered = disposition.accept
        ? dialog.accept(disposition.promptText)
        : dialog.dismiss();
      void answered.catch(() => undefined); // the tab may be gone by the time it lands
    });
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

/**
 * The one call the act operation's after-commit closure makes.
 *
 * The seam's `act` takes no caller context, and the owner-grant seam must
 * not widen it for the sessions that have no use for one — so the context
 * arrives through this wrapper: an attached session gets the grant and the
 * claim identity, every other session gets exactly the call it has always
 * gotten. Split rather than a fourth parameter on the interface because a
 * context on, say, a launched session would be a field nothing reads — and
 * a field nothing reads is a field somebody eventually sets by mistake.
 */
export function actAttached(
  session: BrowserSession,
  tab: TabHandle,
  request: ActionRequest,
  secrets: SecretScope | undefined,
  context: AttachedActContext | undefined,
): Promise<ArtifactResult> {
  return session instanceof AttachedBrowserSession
    ? session.act(tab, request, secrets, context)
    : session.act(tab, request, secrets);
}
