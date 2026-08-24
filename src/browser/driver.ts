/**
 * The seam between the service and whatever actually drives a browser.
 *
 * Everything in this file is types and constants. There is no automation
 * library behind it yet and no runtime dependency added for it — row #20
 * brings the real implementation, and rows #21 through #24, #53, #54 and #56
 * fill in the operations declared here. What lands now is the shape those
 * rows plug into, and a fake that satisfies it (`fake.ts`).
 *
 * ── Why the interface is worth its own row ──────────────────────────────
 *
 * `DECISIONS.md` §5: *a guard that returns "denied" after the tab already
 * opened is worse than no guard*, because it reports a refusal that did not
 * happen and everything downstream believes it. A rejection test that only
 * asserts the response cannot tell those two apart. So the seam exists to be
 * faked, and the fake exists to make *nothing happened* an assertable claim.
 * That is why this row comes before the real driver rather than after it.
 *
 * ── What this shape enforces, and what it merely encourages ─────────────
 *
 * Worth stating exactly, in the manner `transaction.ts` states its own
 * bypasses, because the difference is where a later row will get hurt:
 *
 * **Structural — the compiler refuses these.**
 *
 * - **A third browser is not expressible.** {@link BrowserId} is a union of
 *   two string literals, not `string`, so `SCHEMA.md` §1.2's "exactly two
 *   rows, always" is a type error rather than a review comment. The store
 *   enforces the same thing with a check constraint; this makes the code
 *   that talks to browsers agree with it by construction.
 * - **No operation takes a list of tabs.** Every member of
 *   {@link TabOperations} is singular, because a lease is one tab (§2.3) and
 *   `SCHEMA.md` §3.1 puts it plainly: there was never more than one to list.
 *   There is no plural close and no "close all my tabs" to write.
 * - **A tab is closed through the handle for that tab.** {@link TabHandle} is
 *   what {@link BrowserSession.openTab} returns, so closing one requires
 *   already holding it.
 *
 * **Conventional — this shape makes the wrong thing awkward and nothing
 * more.** Say so rather than implying otherwise:
 *
 * - **`browser_scoped.never` is not enforced here.** No method on
 *   {@link BrowserSession} closes, kills, restarts or reaps a browser, so
 *   there is no browser-scoped destructive call to reach for and adding one
 *   would be a visible new method on a documented seam rather than an
 *   argument slipped into an existing call. That is deliberately as far as it
 *   goes: an implementation of this interface holds a live connection to a
 *   browser, and nothing in a type signature can stop the module that holds
 *   it from doing something else with it. `SCHEMA.md` §7.3 makes
 *   `browser_scoped.never` a **build rule** for exactly that reason, and the
 *   rule is checked against the agent surface, which this is not. Do not read
 *   the absence of a close-browser method as the guarantee; it is the easy
 *   path pointing the right way.
 * - **Adoption is a protocol, not a constructor.** {@link BrowserDriver}
 *   offers {@link BrowserDriver.attach} and {@link BrowserDriver.coldStart}
 *   as separate calls because they are separate acts with different risks
 *   (§1.2a), and nothing here forces a caller to try the first before the
 *   second. Row #54 arbitrates which one a given caller performs, in the
 *   store, in the same transaction that arbitrates claims. **The ordering
 *   rule lives there, not in this file.**
 * - **Nothing here keeps browser work out of the arbitration transaction.**
 *   Every operation is `async`, and `SCHEMA.md` §2.4b's rule is that none of
 *   them is reachable from inside a transaction. What makes that the path of
 *   least resistance is `transaction.ts`'s `afterCommit`, which already takes
 *   the collect-inside-act-outside shape; what makes it checkable is the
 *   `arbitration.no_browser_io` build rule (§7.3). This file cannot do either
 *   job, and a comment claiming it did would be the kind of false assurance
 *   §7.3 exists to replace.
 */

/**
 * The two browsers, and there is no third.
 *
 * `SCHEMA.md` §1.2: the **regular** browser is persistent and signed in by a
 * person, and the **private** one is ephemeral and signed in to nothing. The
 * ceiling does not move with the number of callers, which is the whole point
 * — concurrency is expressed in tabs (`DECISIONS.md` §6).
 */
export type BrowserId = 'regular' | 'private';

/** Both of them, in a fixed order, for anything that has to visit each. */
export const BROWSER_IDS: readonly BrowserId[] = ['regular', 'private'];

/**
 * Whether a browser draws a window.
 *
 * Carried on the seam rather than left to the implementation because it is
 * load-bearing for the keeper tab (#56), and the reason is measured: closing
 * the final tab leaves a **headless** browser alive and kills a **headed**
 * one within about half a second (`SCHEMA.md` §3.15). The signed-in browser
 * is headed, so the behaviour a keeper tab prevents is real for it and absent
 * for the other — and a test that cannot see which mode it is running in
 * cannot assert the difference.
 */
export type BrowserMode = 'headed' | 'headless';

/**
 * Where a browser can be reached, as the browser itself recorded it.
 *
 * **A claim, never a proof** (`SCHEMA.md` §1.2c). Verified: after the browser
 * was killed outright the record was still present, still readable and still
 * naming a port that answered nothing. So nothing may attach on the strength
 * of this alone — and `browserUuid` is why the check is not merely "does the
 * port answer": ports are reused, so a stale record plus an unrelated process
 * that was handed the same port reads as a successful match against the
 * number alone.
 *
 * Row #53 is the row that reads one of these and checks it. It lands here now
 * so the shape #20 writes and #53 verifies is one shape rather than two.
 */
export interface DiscoveryRecord {
  /** The address the browser wrote down for itself. */
  readonly endpoint: string;
  /**
   * The browser's own identifier for itself, read from it when it was
   * adopted. Absent on a record that has been read off disk but not yet
   * checked against a live browser — which is the ordinary state of one.
   */
  readonly browserUuid?: string;
}

/**
 * What a caller learns about a browser without driving it.
 *
 * `pid` is the isolation fact (`SCHEMA.md` §1.2): the service acts on the
 * processes it has recorded and on nothing else, so a browser somebody else
 * is running is never inspected and never touched.
 */
export interface BrowserDescription {
  readonly browser: BrowserId;
  readonly mode: BrowserMode;
  readonly pid: number;
  readonly discovery: DiscoveryRecord;
}

/**
 * A handle to one tab. The unit of capacity and the unit of ownership.
 *
 * The identifier here is the **driver's** name for the tab —
 * `tabs.driver_tab_id` in `SCHEMA.md` §1.4 — and it is **never returned to a
 * caller on any surface**. Callers hold the opaque `tabs.id`, and the mapping
 * between the two is row #21's. Keeping the driver's name inside this type is
 * what stops it leaking outward by accident: nothing above the service layer
 * ever holds one of these.
 */
export interface TabHandle {
  readonly browser: BrowserId;
  readonly driverTabId: string;
}

/** Where a navigation ended up, which is not always where it was pointed. */
export interface NavigationResult {
  /** The address after redirects. */
  readonly url: string;
  readonly title: string;
  /** Null when the navigation produced no response to have a status from. */
  readonly status: number | null;
}

/**
 * One page verb.
 *
 * `SCHEMA.md` §3.8's fixed list, plus the three argued for there: `resize`
 * (#61), `emulate` (#62) and `dialog` (#63). Named here as a closed union so
 * that the refusal §3.8 owes — the one that **lists every action by name** —
 * has a single source to list from, and so a row adding a verb has one place
 * to add it. `SCHEMA.md` §3.13 keeps `bringToFront` off this list
 * deliberately, and `foreground.never_moved` (§7.3) is the build rule that
 * keeps it off.
 */
export type PageAction =
  | 'click'
  | 'type'
  | 'fill'
  | 'press'
  | 'select'
  | 'hover'
  | 'check'
  | 'scroll'
  | 'resize'
  | 'emulate'
  | 'dialog';

/** Every action, in the order §3.8 lists them, for a refusal that names them all. */
export const PAGE_ACTIONS: readonly PageAction[] = [
  'click',
  'type',
  'fill',
  'press',
  'select',
  'hover',
  'check',
  'scroll',
  'resize',
  'emulate',
  'dialog',
];

/**
 * What an action needs. Row #22 decides which fields each verb requires and
 * refuses the combinations that make no sense; the seam only has to carry
 * them.
 */
export interface ActionRequest {
  readonly action: PageAction;
  /**
   * An element reference taken from a snapshot, for the verbs that address an
   * element. Absent for the ones that do not (`resize`, `emulate`, `dialog`).
   */
  readonly ref?: string;
  readonly value?: string;
}

/** The kinds of artefact a read can ask for (`SCHEMA.md` §3.9). */
export type ReadArtifact = 'snapshot' | 'console' | 'network' | 'cookies';

/**
 * A read's result, per artefact.
 *
 * **The contents are never here** (`SCHEMA.md` §3.9): a read returns a path,
 * a size and whether it was truncated, because a full snapshot or network log
 * entering a conversation is paid for once in money and on every later turn
 * in context. The driver writes the file and reports where; the service
 * decides where the file may go (#45).
 */
export interface ArtifactResult {
  readonly artifact: ReadArtifact;
  readonly path: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/**
 * A rectangle to paint over before a picture is taken (`SCHEMA.md` §3.11's
 * `mask`).
 *
 * **Masking before the pixels exist beats filtering afterwards**, because a
 * region that was never captured cannot be reported as changed. That is why
 * this is on the seam rather than something the pipeline does to the image it
 * got back: a mask applied after the shutter is a mask that was, for one
 * moment, not applied.
 */
export interface CaptureMask {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What a driver is asked for when a picture is wanted.
 *
 * **No tier and no resolution.** The driver takes the picture the page can
 * give; deciding which rung it is shrunk to, and doing the shrinking, is the
 * pipeline's (#31) — see {@link RawCapture} for why that split is where it is.
 */
export interface CaptureRequest {
  /** `viewport` unless the caller asked otherwise; `element` names a selector. */
  readonly fullPage: boolean;
  readonly selector?: string;
  /** Areas painted over **before** the shutter, never after. */
  readonly mask?: readonly CaptureMask[];
}

/**
 * A picture, as the browser produced it, **in memory**.
 *
 * ── Why the driver returns bytes and not a path ─────────────────────────
 *
 * Every other artefact on this seam comes back as a path
 * ({@link ArtifactResult}) because a snapshot or a network log entering a
 * conversation is paid for on every later turn. A capture is different in one
 * specific way and identical in every other: the image still never reaches a
 * caller — §3.11 is explicit that what comes back is *"a path, the dimensions
 * … **never the image**"* — but between the shutter and the file there is a
 * **downscale**, and the thing that downscales is the pipeline rather than the
 * browser.
 *
 * So the choice is between a driver that writes a file the pipeline
 * immediately rewrites, and a driver that hands over bytes the pipeline writes
 * once. The second is chosen, and the deciding argument is not the extra
 * write: it is **`SCHEMA.md` §1.7a's "the service decides where the file may
 * go"**. A driver that picked a path would be a second thing choosing
 * locations under the artifact root, and rule two of `artifacts/store.ts` —
 * nothing lands outside the tree — would then hold in one place and be a
 * convention in another.
 *
 * The cost is stated rather than hidden: **a full-page capture of a long page
 * is held in memory in full.** That is bounded by what a browser was willing
 * to produce in one image, and it is the same bound a downscaler would face on
 * reading the file back.
 */
export interface RawCapture {
  /** The encoded image. PNG, which is what every driver here produces. */
  readonly image: Uint8Array;
  /** What the browser produced, before any shrinking (`captures.source_*`). */
  readonly width: number;
  readonly height: number;
  /**
   * The viewport width the picture was taken at — **the breakpoint**
   * (`captures.viewport_width`, §1.7). Read from the page rather than from
   * whatever the caller last asked to resize to, because those disagree
   * whenever a resize did not take.
   */
  readonly viewportWidth: number;
  /** Where the tab actually is, for `captures.url` (§1.7). */
  readonly url: string;
}

/** What evaluating an expression produced (`SCHEMA.md` §3.10). */
export interface EvaluationResult {
  /**
   * The value, when it was small enough to return inline. The inline cap and
   * the spill-to-path decision are row #24's; both outcomes are expressible
   * here so that row does not have to widen the seam to ship.
   */
  readonly value?: unknown;
  /** Where it was written instead, when it was not. */
  readonly path?: string;
  readonly bytes: number;
}

/**
 * The tab-scoped operations. **Every one of them is singular in its tab.**
 *
 * Split out from {@link BrowserSession} rather than inlined so that the
 * property is legible as a property: this is the whole set of things that can
 * be done to a page, and the absence of anything plural or browser-wide is
 * visible in one place rather than inferred from a longer list.
 *
 * Every member is declared and none is implemented here. Row #21 brings
 * {@link TabOperations.closeTab}, #22 brings {@link TabOperations.navigate}
 * and {@link TabOperations.act}, #23 brings {@link TabOperations.read} and
 * #24 brings {@link TabOperations.evaluate}. A fake that answers all of them
 * is what lets the rows before those write rejection tests that assert
 * nothing happened.
 */
export interface TabOperations {
  /**
   * Close this tab. **The only destructive operation on this seam, and it is
   * scoped to one tab** — which is the shape `DECISIONS.md` §5 asks for: a
   * destructive operation keeps its own name and is never folded under an
   * action parameter, because a rule matching on the operation's name goes
   * invisible the moment it becomes a string argument.
   *
   * Closing is **best effort by design** (`SCHEMA.md` §2.4b): it runs after
   * the arbitration transaction has committed, so a tab that will not close is
   * a leaked tab and not a leaked lease. The capacity is already back. A
   * rejection here is therefore information for the row rather than a failure
   * to propagate to the caller.
   */
  readonly closeTab: (tab: TabHandle) => Promise<void>;

  /** Point a tab at an address, and report where it actually ended up. */
  readonly navigate: (tab: TabHandle, url: string) => Promise<NavigationResult>;

  /**
   * Perform one page verb. Row #22 returns a **fresh snapshot after every
   * change**, because the caller's next element reference has to come from
   * the page as it is now (`SCHEMA.md` §3.8).
   */
  readonly act: (tab: TabHandle, request: ActionRequest) => Promise<ArtifactResult>;

  /** Write the requested artefacts to disk and report where each went. */
  readonly read: (
    tab: TabHandle,
    artifacts: readonly ReadArtifact[],
  ) => Promise<readonly ArtifactResult[]>;

  /** Evaluate an expression in the page (`SCHEMA.md` §3.10). */
  readonly evaluate: (tab: TabHandle, expression: string) => Promise<EvaluationResult>;

  /**
   * Stop the page moving: animations and transitions stopped, the text caret
   * hidden, web fonts waited for (`SCHEMA.md` §3.11).
   *
   * **Separate from {@link TabOperations.capture} rather than folded into
   * it**, and the separation is the whole reason it is testable. §3.11 calls
   * settling *"the highest-value line in the whole comparison feature"*,
   * because without it **the same page produces different pixels run to run** —
   * a fading banner, a transition mid-flight, a blinking caret, a spinner, an
   * image that arrived one frame later. No threshold fixes any of that: a
   * colour tolerance is a per-pixel comparison and has nothing to say about
   * something that moved.
   *
   * A driver that settled inside its own capture would make *"every capture
   * settles first"* an implementation detail of whichever driver is installed,
   * provable only by inspecting it. As two calls, the ordering is the
   * pipeline's, it is one assertion on the fake's call log, and a driver that
   * forgot to settle cannot hide the omission.
   */
  readonly settlePage: (tab: TabHandle) => Promise<void>;

  /**
   * Take a picture and hand back the pixels.
   *
   * **The correct-surface setting is not a parameter here, and that is
   * deliberate.** `capture.surface_required` (§7.3) says no capture is ever
   * taken with it disabled — in a windowed browser it returns another tab's
   * pixels, with no error, *a wrong answer that looks exactly like a right
   * one*. A parameter would be a way to disable it, so there is none: it is a
   * property of an implementation of this seam, owed by row #20, and a build
   * rule rather than a run-time check because the correct behaviour is that the
   * call never happens.
   */
  readonly capture: (tab: TabHandle, request: CaptureRequest) => Promise<RawCapture>;
}

/**
 * An attached browser: what a caller holds once it has reached one.
 *
 * **There is nothing on this interface that ends a browser.** No close, no
 * kill, no restart, no reap, no close-every-tab — see this file's header for
 * what that does and does not amount to. Reap and restart are administrative
 * operations on the administrative surface (`SCHEMA.md` §4.3), and what fails
 * the build is either of them appearing on the agent surface (§7.3).
 *
 * `detach` is the exception that proves the rule, and it is worth being
 * explicit about why it is not destructive: **attaching and detaching were
 * measured to be non-destructive** to tabs, cookies and local storage — a
 * caller connecting and disconnecting leaves the browser exactly as it found
 * it (§1.2a). That measurement is the property the whole shared-session
 * design rests on. Detaching ends *this process's connection* and nothing
 * else; the browser outlives it, which is the entire model.
 */
export interface BrowserSession extends TabOperations {
  readonly describe: () => BrowserDescription;

  /**
   * Open a tab and return its handle. One call, one tab — there is no count
   * argument, because a lease is one tab (`SCHEMA.md` §2.3) and a caller that
   * wants three claims three times.
   */
  readonly openTab: () => Promise<TabHandle>;

  /**
   * Every page open in this browser at the moment it is asked, including ones
   * no lease of this service's owns.
   *
   * Row #21's reconciliation is against the browser rather than against a
   * restart: a live browser is **asked what is actually open**, a page no live
   * lease owns is closed, and a tab a live lease believes it owns that is not
   * there is marked closed. Neither half of that is expressible without being
   * able to ask, so the ability to ask is on the seam from the start.
   */
  readonly listTabs: () => Promise<readonly TabHandle[]>;

  /**
   * Ensure the keeper tab exists, and report its handle.
   *
   * **One blank, never-leased, never-addressable tab per browser, never
   * counted against the budget** (`SCHEMA.md` §3.15). It is a correctness
   * mechanism rather than tidiness: the signed-in browser is headed, and a
   * headed browser **dies within about half a second of its final tab
   * closing** — so without it, the last caller to release its lease destroys
   * the shared authenticated session by doing the single most ordinary thing
   * a caller ever does.
   *
   * It is a separate call from {@link BrowserSession.openTab} for two
   * reasons: the keeper tab is not capacity and must never be handed to a
   * lease, and it is a **spawn-time precondition in its own right** (§7.2),
   * so something has to be able to establish and report it independently of
   * anyone claiming anything. Row #56 implements it and owns the headed test
   * that proves it.
   *
   * The handle it returns is deliberately not addressable by any caller: it
   * exists so the service can assert the tab is present and exclude it from
   * the count, not so anything can drive it. **A caller cannot close what it
   * cannot name** (§3.13).
   */
  readonly ensureKeeperTab: () => Promise<TabHandle>;

  /**
   * End this process's connection. Non-destructive, and the browser is
   * unaffected — see this interface's own note above.
   */
  readonly detach: () => Promise<void>;
}

/** What a cold start needs to be told, since none of it may be defaulted. */
export interface ColdStartRequest {
  readonly browser: BrowserId;
  /**
   * **Mandatory, and never a default profile location** (`SCHEMA.md` §7.2,
   * `launch.explicit_profile_dir`). Two independent justifications, and each
   * would be sufficient on its own: a default location is shared with
   * anything else that also takes the default, so an unrelated run that
   * started first would stop this service starting at all; and with browsers
   * adopted rather than owned, **profile identity is a path** — without a
   * stable one there is nothing to attach to later.
   *
   * Required rather than optional so that omitting it is a type error and not
   * a silent fallback. The refusal for an empty or unusable one is row #20's,
   * because a value can be present and still be wrong.
   */
  readonly profileDirectory: string;
  readonly mode: BrowserMode;
}

/**
 * Reaching a browser. Two paths, because there are two acts.
 *
 * **Browsers are adopted, not owned** (`SCHEMA.md` §1.2a). No process here
 * lives long enough to be a browser's parent — the service is spawned by a
 * caller and exits with it — so a browser that belonged to a process would die
 * with the first caller that finished, taking every other caller's tabs with
 * it. Hence: whichever caller finds none running starts one, everyone after
 * attaches, and the browser outlives every process that touched it.
 *
 * **Attaching is the ordinary case and launching is the rare one**, which is
 * the opposite of how the two names read. They are separate members rather
 * than one `connect` with a fallback because the fallback is precisely the
 * thing that must not be automatic: two callers arriving at an empty machine
 * at the same instant must produce **one launch, not two**, and that is
 * arbitrated in the store by row #54 rather than by whoever asked first.
 */
export interface BrowserDriver {
  /**
   * Attach to a browser that is already running, having checked the record
   * first.
   *
   * The record is a claim and not a proof (§1.2c), so an implementation owes
   * **both** checks before it connects — the endpoint answers, and the browser
   * identifies itself as the expected one. Row #53 is where those checks are
   * built. Refuses rather than connecting to something it cannot identify:
   * attaching to a stranger is worse than failing to attach, because it
   * succeeds.
   */
  readonly attach: (browser: BrowserId, record: DiscoveryRecord) => Promise<BrowserSession>;

  /**
   * Start a browser that is not running, **detached**, and attach to it.
   *
   * Detached is a measured requirement rather than a preference (§1.2a):
   * launching through an automation library's own launcher **kills the
   * browser when that client closes** — correct for a test and fatal for a
   * shared browser — whereas spawning the binary detached survived its
   * spawning process being killed uncleanly, staying healthy and
   * re-attachable for around 90 minutes with its pages intact.
   *
   * **Success is an endpoint that answers, asserted positively, never
   * inferred from the launch not failing.** A second browser started against a
   * profile directory already in use does not report a lock error: it hands
   * its address to the browser already holding the profile and **exits zero**,
   * with nothing on the error stream and no debugging endpoint opened. Row #20
   * owes that assertion and row #55 owes the bound on how long to wait for it,
   * which `SCHEMA.md` §1.2b records as genuinely open rather than settled.
   */
  readonly coldStart: (request: ColdStartRequest) => Promise<BrowserSession>;
}
