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
 *
 * **`fill_form` and `drag` are row #64's, and their measurements are
 * opposite.** Batch fill was measured at **78 calls across 35 sessions** and
 * is ordinary; **drag and drop measured zero calls across 2,007 transcripts**
 * over a month — not "few", none. #64 folds the second in at low priority
 * with that number recorded rather than splitting it out to hide the
 * asymmetry, so that if it turns out to matter it arrives with the number to
 * argue against. `drag` is **in-page, element to element**: it takes two
 * references from the same snapshot, and there is no file-from-the-desktop
 * shape here, because a lease is a tab and the desktop is not in it.
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
  | 'dialog'
  | 'fill_form'
  | 'drag';

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
  'fill_form',
  'drag',
];

/**
 * A viewport, in device-independent pixels (`resize`, #61).
 *
 * **Two numbers rather than a string, and that is the whole reason this type
 * exists.** The obvious alternative is to carry the size in the generic
 * `value` field as something like `"1280x720"` — and it would work, and it
 * would move the parse into every implementation of this seam, each free to
 * disagree about the separator, about whitespace, and about what a negative
 * number means. A viewport is two integers; carrying it as two integers means
 * a driver receives what the caller meant rather than a string it has to
 * re-derive. **The bounds are still row #61's** — a type says these are
 * numbers, not that they are sane ones.
 */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * The media preferences a page renders against (`emulate`, #62).
 *
 * `SCHEMA.md` §3.8's table, one field each, **and every one is optional
 * independently** — a caller switching to dark mode is not thereby saying
 * anything about motion or contrast, and a shape that made it say something
 * would silently reset a preference the caller had set on a previous call.
 * Row #62 refuses the empty case, because an emulate that names no preference
 * is a call that means nothing.
 *
 * These are properties of the **browsing context**, not of anything reachable
 * from inside the page (§3.8, §3.10) — which is the same gap `resize` has and
 * the reason 19 measured calls are enough. An expression can read which
 * preferences are in force and cannot set one; a page's own theme switch
 * exercises **the page's state rather than what the browser reports**, and
 * what the browser reports is precisely the code path a dark-mode review
 * exists to check.
 */
export interface MediaPreferences {
  /** `light`, `dark`, or the no-preference state. */
  readonly colourScheme?: 'light' | 'dark' | 'no-preference';
  /** Whether the page is told a person prefers less animation. */
  readonly reducedMotion?: 'reduce' | 'no-preference';
  /** Whether a high-contrast colour override is in force. */
  readonly forcedColours?: 'active' | 'none';
}

/**
 * How to answer a native dialog (`dialog`, #63).
 *
 * **Here on consequence rather than frequency.** Measured at 8 calls, which
 * on frequency alone earns nothing — but a native dialog **blocks the tab it
 * belongs to**, and nothing else in that tab answers while it is up: not a
 * navigation, not an action, not a capture, not an evaluation. So a caller
 * that trips one holds a lease it cannot use and pays for it until the
 * lifetime expires, and its only exit is to burn the lease. That is a
 * capacity failure wearing a convenience failure's clothes (§3.8).
 */
export interface DialogResponse {
  /** Accept it, or dismiss it. */
  readonly accept: boolean;
  /**
   * What to type into a prompt before accepting. Meaningless on a dialog that
   * takes no text, and row #63 refuses it alongside a dismissal — supplying
   * text and then dismissing describes two different intentions at once.
   */
  readonly promptText?: string;
}

/** One field and what to put in it (`fill_form`, #64). */
export interface FormField {
  /** An element reference taken from a snapshot. */
  readonly ref: string;
  readonly value: string;
}

/**
 * What an action needs, **as a discriminated union over the verb**.
 *
 * ── Why this is a union rather than one interface of optional fields ────
 *
 * A single flat interface carrying `ref?` and `value?` for every verb would
 * leave *"which fields does this verb require"* entirely to a run-time guard.
 * The verbs are what make that the wrong trade: `resize` needs two numbers,
 * `emulate` needs three independent enums, `dialog` needs a boolean and a
 * string, `fill_form` needs a list and `drag` needs a **second** reference.
 * One flat interface holding all of that gives every verb eight optional
 * fields and makes *"which of these matter for this verb"* a thing to look up
 * rather than a thing to read.
 *
 * **So the compiler refuses the nonsense combinations, and row #22's guard
 * refuses the ones it cannot see.** Those are different sets and the
 * difference is worth stating rather than implying:
 *
 * - **Structural.** A `resize` carrying an element reference does not
 *   type-check; nor does a `click` carrying a viewport, a `dialog` carrying a
 *   list of fields, or a `drag` with only one end. The member for each verb
 *   names exactly its own arguments and no others.
 * - **Conventional, and left to the guard.** Nothing here stops a width of
 *   zero, a negative height, an empty reference string, an `emulate` naming
 *   no preference, an empty field list or a `drag` whose two references are
 *   the same element. **Every one of those type-checks**, and every one is a
 *   refusal row #22 or the row that owns the verb owes. A type says what
 *   shape a value has; it does not say the value is sensible, and reading the
 *   absence of these checks here as their absence everywhere is the mistake
 *   this paragraph exists to prevent.
 *
 * **Anything arriving from outside the process is `unknown` until a guard has
 * looked at it.** A caller's arguments reach this type by being validated
 * into it, never by being asserted into it — a cast at the boundary makes the
 * whole union decorative, because the compiler is then checking a claim the
 * boundary made up rather than a fact anybody established.
 */
export type ActionRequest =
  | {
      /**
       * The verbs that address one element and take no value: `SCHEMA.md`
       * §3.8's ordinary page verbs, minus the ones that need something typed.
       */
      readonly action: 'click' | 'hover' | 'check';
      /** An element reference taken from a snapshot. */
      readonly ref: string;
    }
  | {
      /** The verbs that address one element **and** need a value. */
      readonly action: 'type' | 'fill' | 'select';
      readonly ref: string;
      readonly value: string;
    }
  | {
      /**
       * A key press. Addresses an element optionally — a press with no
       * reference goes to whatever the page has focused, which is the
       * ordinary way a caller sends a key to a page rather than to a field.
       */
      readonly action: 'press';
      readonly ref?: string;
      /** The key's name. */
      readonly value: string;
    }
  | {
      /**
       * Scroll. The reference is optional for the same reason `press`'s is:
       * with one, the named element is scrolled into view; without one, the
       * page is.
       */
      readonly action: 'scroll';
      readonly ref?: string;
    }
  | {
      /** #61. Set the tab's viewport. Addresses no element — it is not in the page. */
      readonly action: 'resize';
      readonly viewport: Viewport;
    }
  | {
      /** #62. Set media preferences. Addresses no element, for the same reason. */
      readonly action: 'emulate';
      readonly preferences: MediaPreferences;
    }
  | {
      /** #63. Answer or dismiss a native dialog. Addresses no element — it is not in the page either. */
      readonly action: 'dialog';
      readonly response: DialogResponse;
    }
  | {
      /** #64. Several fields in one call, measured at 78 calls across 35 sessions. */
      readonly action: 'fill_form';
      readonly fields: readonly FormField[];
    }
  | {
      /**
       * #64. Element to element, in the page. **Measured at zero calls**, and
       * folded in at low priority with that number recorded.
       */
      readonly action: 'drag';
      /** What is being dragged. */
      readonly ref: string;
      /** Where it is being dragged to. Both come from the same snapshot. */
      readonly targetRef: string;
    };

/** The kinds of artefact a read can ask for (`SCHEMA.md` §3.9). */
export type ReadArtifact = 'snapshot' | 'console' | 'network' | 'cookies';

/**
 * Every artefact a read can ask for, for a caller that has to enumerate them.
 *
 * Snapshot first because it is the default and the only load-bearing one
 * (`SCHEMA.md` §3.9): every element reference `browser_act` takes comes from
 * it, so a read that omitted it would be useless in the ordinary case.
 */
export const READ_ARTIFACTS: readonly ReadArtifact[] = [
  'snapshot',
  'console',
  'network',
  'cookies',
];

/**
 * How an artefact comes to be, which decides what asking for it costs.
 *
 * **This is the fact `SCHEMA.md` §3.9 asks to be understood rather than
 * merely obeyed**, so it is on the seam as data instead of in a comment
 * somebody has to find:
 *
 * - **`accumulated`** — the browsing context has been recording it since the
 *   moment it existed, whether or not anybody intends to ask. Console output
 *   and network activity, and **only** those two. There is no request that
 *   starts or stops the collection, so the default's filter is on *what gets
 *   written to disk*, not on what gets collected, and **the cost of not
 *   asking is zero**: a caller that realises afterwards that it wanted the
 *   console asks on its next read and gets the accumulated history, not a
 *   recording that started when it asked. That is what makes a narrow default
 *   cheap rather than a trap, and it is why there is **no console-listener
 *   action** on `browser_act` and no hole where one would go — *arm, act,
 *   collect* is served by *act, then read*.
 * - **`live`** — answered at the moment of asking, against the context, with
 *   no accumulated log behind it. **Cookies, and cookies alone.** Asking is a
 *   real operation with a real cost — small, but not zero — and the answer is
 *   a snapshot of that instant rather than a history. So this one is off by
 *   default for a second reason on top of the obvious one.
 * - **`generated`** — produced on request from the page as it is now. The
 *   snapshot.
 */
export type ArtifactCollection = 'accumulated' | 'live' | 'generated';

/**
 * Which artefacts are which. Written down so *"is this already being
 * collected"* has a stable answer per artefact rather than being something to
 * reason out each time somebody reads the default.
 */
export const ARTIFACT_COLLECTION: Readonly<Record<ReadArtifact, ArtifactCollection>> = {
  snapshot: 'generated',
  console: 'accumulated',
  network: 'accumulated',
  cookies: 'live',
};

/**
 * One cookie, as a summary — **and there is no field here for its value.**
 *
 * `SCHEMA.md` §3.9 and §7.1 `read.cookies_no_values`: a cookie read returns
 * names, domains, paths, expiries and flags. **Not truncated, not masked: the
 * field is absent.** A service handing over cookie values is a
 * credential-export feature whatever else it is called, and §3.13 refuses the
 * write side for the same reason.
 *
 * **The absence is expressed as a type rather than as a redaction step**, and
 * that is the point of putting it on the seam. A shape with a `value` field
 * that something later blanks has a moment in which the value is in this
 * process's memory and one forgotten path away from a file; a shape with no
 * such field has nowhere to put one. Row #23 owes the test that seeds a
 * cookie with a known string and asserts the string appears nowhere in the
 * response **or in the file** — because a type stops this process holding a
 * value, and cannot stop a driver writing one into a file it names.
 */
export interface CookieSummary {
  readonly name: string;
  readonly domain: string;
  readonly path: string;
  /** When it expires, or null for a session cookie. */
  readonly expires: string | null;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: 'Strict' | 'Lax' | 'None' | null;
}

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

  /**
   * The cookie summary as data — **names, domains, paths, expiries and flags,
   * and structurally no values** ({@link CookieSummary}).
   *
   * Separate from {@link TabOperations.read} rather than folded into it, and
   * the reason is the rule rather than convenience. §7.1
   * `read.cookies_no_values` is a **shape**, not a refusal: the way to make a
   * shape true is for the value to have nowhere to live. A driver that
   * serialised cookies to a file itself would put the only place the
   * redaction could be checked inside the module that has the values, where
   * this repository's own test could observe the file and never the step. By
   * handing back {@link CookieSummary} — a type with no value field — the
   * redaction happens at the seam, and what row #23 writes to disk is
   * something that never had a value in it.
   *
   * **A live query** ({@link ARTIFACT_COLLECTION}), so calling this costs
   * something and the answer describes that instant rather than a history.
   */
  readonly cookies: (tab: TabHandle) => Promise<readonly CookieSummary[]>;

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
