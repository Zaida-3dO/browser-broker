import { OPERATION_NAMES, type OperationName } from '../adapter/operations.ts';
import { BROWSER_CHOICE_GUIDANCE } from '../browser/driver.ts';

/**
 * The twelve tools, their descriptions, and their argument schemas.
 *
 * ── Surface area is a standing tax, and this file is where it is paid ────
 *
 * `SCHEMA.md` §3.1 opens with it: every description here sits in a connected
 * session's context **on every turn**, whether or not anything calls the
 * tool. Twelve descriptions is the whole agent-facing documentation of this
 * service and it is also a per-turn cost on every session, so each one is
 * written to be the shortest text that still prevents a wrong call.
 *
 * **The description is the only place a calling agent reliably reads.** Not
 * `SCHEMA.md`, not a wiki, not a refusal it has not hit yet. So where a fact
 * changes what a caller does — that `browser_status` is also the renew verb,
 * that the browser choice has no default, that feedback needs no lease — the
 * fact is in the description rather than only in the argument list.
 *
 * **`browser_sign_in`'s description is the strongest case of that rule, and
 * the reason it reads as an instruction rather than a summary.** The failure
 * it exists to end is a caller hitting a login wall and never learning it
 * could ask — and **no refusal can reach that caller**, because it never
 * makes a call to be refused. It abandons the task or fabricates a session
 * instead, which is what 25 measured sessions did in a month. There is no
 * second surface for that guidance to live on, so the description names the
 * alternative outright, the way a refusal would.
 *
 * ── What is deliberately absent ─────────────────────────────────────────
 *
 * **There is no browser-scoped destructive verb, and there must never be
 * one.** No close-browser, no kill-all, no restart. `SCHEMA.md` §3.13 makes
 * that part of the contract rather than an omission: the administrative
 * operations act on something every caller shares, so they are commands a
 * person runs (§4.3, §5.4) and the ledger records that a person did.
 * **The worst thing an agent can do through this surface is close its own
 * tab**, and that ceiling is the reason this surface can be handed to an
 * arbitrary caller at all.
 *
 * **`browser_sign_in` and `browser_sign_in_done` move a browser's state and
 * do not breach that ceiling**, which is worth stating because they look like
 * the exception. Both are keyed, and both act only on the lease that called
 * them: the first takes the browser only when no *other* lease holds a tab on
 * it, and the second is refused unless the calling lease is the one that
 * asked — so a caller can neither interrupt somebody else's work nor end a
 * person's sign-in command mid-password. The unkeyed pair that could do those
 * things, `begin_sign_in` and `end_sign_in`, is deliberately not on this
 * surface at all.
 *
 * `browser_tab_close` is absent for a second, separate reason (§3.1): it
 * closed a caller's only tab while keeping the lease, producing a lease that
 * owned nothing and still consumed budget. It is gone rather than deprecated,
 * and it should not be reintroduced.
 */

/**
 * What a capture can and cannot be trusted to show (§3.11).
 *
 * ── A picture is the one result a caller cannot check against itself ─────
 *
 * Every other operation here returns something self-describing: a claim
 * returns a key, an evaluation returns a value, a refusal explains itself. A
 * capture returns a path to an image, and **an image of a half-rendered page
 * looks exactly like an image of a broken one.** There is no field in the
 * result to distrust, so a caller has nothing to weigh the picture against —
 * which makes a wrong conclusion from a capture both easy to reach and hard
 * to notice.
 *
 * The consequence is not hypothetical, and it is what puts this text on the
 * description rather than in a document: a field session captured a canvas
 * before it had drawn, read the dark frame as the page's real appearance, and
 * **reported a fault against an application that did not have one.** It was
 * caught only because a second measurement happened to disagree — which is
 * not a mechanism anything can rely on.
 *
 * ── Why settling does not already cover this ─────────────────────────────
 *
 * Every capture settles the page first, and settling is worth exactly what
 * §3.11 claims: it stops animations and transitions, hides the caret, and
 * waits for web fonts, so the same page yields the same pixels run to run.
 * **That is repeatability, not completeness.** It makes a moving page hold
 * still; it cannot make an unfinished page finish. A canvas that has not
 * drawn its first frame is not moving — it is absent — and holding it still
 * is not the same as waiting for it.
 *
 * ── Why this names a check rather than a duration ────────────────────────
 *
 * The tempting sentence is *"allow the page to settle first"*, and it is
 * advice a caller cannot act on: **the right wait is a property of the page,
 * not of this service**, and a caller that has never seen the page rendered
 * has no way to pick a number. Any figure written here would be wrong for
 * some page and would be trusted anyway, which is worse than saying nothing.
 *
 * So the guidance is a **check** instead — capture twice and compare, which
 * this tool can already express through `compare_to`. A caller can act on it
 * without knowing anything about the page in advance, and it answers the
 * question actually being asked, which is not *"has enough time passed"* but
 * *"has this stopped changing"*. Two identical frames are evidence; one frame
 * and a duration are an assumption.
 */
const CAPTURE_SETTLE_CAVEAT =
  'Captures are settled — animations stopped, fonts waited for — so a page yields the same ' +
  'pixels twice; that steadies a moving page but does not wait for one still drawing. A canvas ' +
  'or a deferred region can be captured before it has rendered, and the picture will look like a ' +
  'broken page rather than an early one. When a frame looks wrong, capture again with compare_to ' +
  'and check it against the first: no difference means you are seeing the page, not a moment of it.';

/**
 * What this tool's unit is wrong for, so a caller with the other job does not
 * reach for it anyway.
 *
 * ── The distinction this exists to draw ──────────────────────────────────
 *
 * `compare_to` answers *"did this page change since a moment ago, on this
 * same tab"* — a before-and-after over time, one lease, one running build.
 * That is a different question from *"how do these two builds differ"*,
 * where the two things being compared are not two moments of one tab but two
 * separate runs, often of separate processes. This surface's unit is one
 * lease holding one tab, which is the right shape for the first question and
 * the wrong one for the second: a two-build comparison wants something that
 * reads the scene or the DOM directly, not pixels from whichever tab happened
 * to be open.
 *
 * ── Why this is worth a sentence rather than leaving it to be inferred ────
 *
 * A caller framing its task as "compare two builds" will reach for whatever
 * on this surface has the word "compare" in it, and `compare_to` is the only
 * candidate. Nothing here refuses that call — a diff still runs and still
 * answers a real question about the two pixels it was given — so the caller
 * gets an answer that looks like the one it asked for while measuring
 * something else. A routing hint at the point of the call is the only thing
 * that can catch this before the wrong tool is already in use; there is no
 * refusal to word better; the call succeeds.
 */
const CAPTURE_BUILD_COMPARISON_CAVEAT =
  'For comparing two builds — not two moments of the one tab you hold — a tool reading the scene ' +
  'or DOM directly beats this one: this surface is one lease, one tab, pixels.';

/** One argument a tool takes. */
export interface ToolArgument {
  readonly name: string;
  readonly type: 'string' | 'integer' | 'boolean' | 'object' | 'array';
  readonly required: boolean;
  /** For a calling agent. Short: this is per-turn context, not a manual. */
  readonly description: string;
}

/** One tool on the surface. */
export interface ToolDefinition {
  /** The name a caller calls, exactly as `SCHEMA.md` §3.1 spells it. */
  readonly name: string;
  /** The one service operation behind it. */
  readonly operation: OperationName;
  readonly description: string;
  readonly arguments: readonly ToolArgument[];
}

/** Every tool takes the key except the first and the last (§3.1). */
const LEASE_KEY: ToolArgument = {
  name: 'lease_key',
  type: 'string',
  required: true,
  description: 'Your lease key, from browser_claim. Every call carrying it extends the lease.',
};

/**
 * The twelve, in §3.1's order.
 *
 * The list is data rather than a switch statement for the same reason the
 * command table is: the conformance driver reads it to translate a neutral
 * case input into a tool call, so the tool a caller invokes and the tool the
 * parity suite drives are the same string.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'browser_claim',
    operation: 'claim',
    description:
      'Ask for a lease on one browser tab. You get a tab, or a place in the queue — queued is an ' +
      'outcome, not a failure; poll browser_status until it turns active. One lease is one tab: ' +
      'call this again for a second.',
    arguments: [
      {
        name: 'session_id',
        type: 'string',
        required: true,
        description: 'Who you are. Attributed on captures and in the ledger; it is not a limit.',
      },
      {
        name: 'browser',
        type: 'string',
        // **Optional** (`DECISIONS.md` §13i): unstated resolves to the first
        // signed-in browser. The two wrong guesses are not symmetric —
        // defaulting to clean-room when a sign-in was wanted returns a login
        // redirect, a wrong page that looks like a right one, while
        // defaulting to signed-in returns a personalised page, which is the
        // page most callers were asking for.
        required: false,
        // **Row #66 lands here.** The description is the only place a calling
        // agent reliably reads, and 25 measured sessions hand-seeded tokens
        // into an isolated browser while the signed-in one sat unused. The
        // cookie-jar caveat is carried in the same string rather than left to
        // a refusal — and the default makes that more load-bearing, not less,
        // because a caller that states nothing never sees a refusal at all.
        description: BROWSER_CHOICE_GUIDANCE,
      },
      {
        name: 'purpose',
        type: 'string',
        required: true,
        description:
          'What this lease is for, in human words, 3-200 characters. Read by an operator ' +
          'deciding whether to revoke it.',
      },
      {
        name: 'storage_seed',
        type: 'array',
        required: false,
        description:
          'Up to 16 storage entries written into the origin before the first load. For a token ' +
          'obtained from an API rather than a login form. Written as data, never evaluated.',
      },
    ],
  },
  {
    name: 'browser_status',
    operation: 'status',
    description:
      'Where your lease stands — and the call that renews it. There is deliberately no separate ' +
      'renew tool: every keyed call extends the lease, and this is the one that does nothing ' +
      'else. Call it to keep a lease alive, and to poll a queued one.',
    arguments: [LEASE_KEY],
  },
  {
    name: 'browser_release',
    operation: 'release',
    description:
      'Give back whatever you hold — your tab, or your place in the queue. Do this when you are ' +
      'done rather than letting the lease lapse: it frees capacity for the next caller ' +
      'immediately. Releasing twice is fine.',
    arguments: [LEASE_KEY],
  },
  {
    name: 'browser_tab_replace',
    operation: 'tab_replace',
    description:
      'Discard this lease’s tab and open a fresh one, keeping the lease and its expiry. ' +
      'For a tab that has stopped responding — a wedged page cannot be fixed by navigating, ' +
      'because navigating is a request to that page. For a working tab use browser_navigate, ' +
      'which is cheaper.',
    arguments: [LEASE_KEY],
  },
  {
    name: 'browser_navigate',
    operation: 'navigate',
    description:
      'Point your tab at an address. Returns the final address after redirects, the title, the ' +
      'status, and a path to the accessibility snapshot taken on arrival — a path, because a ' +
      'snapshot is thousands of tokens and you usually want one part of it.',
    arguments: [
      LEASE_KEY,
      {
        name: 'url',
        type: 'string',
        required: true,
        description:
          'Ordinary web traffic or a blank page. A local-file address is refused: it would turn ' +
          'a browser lease into a read of the machine’s filesystem.',
      },
      {
        name: 'wait_ms',
        type: 'integer',
        required: false,
        description:
          'How long to wait for the page, in milliseconds. Bounds the load; it does not wait for ' +
          'work the page starts afterwards, so a canvas or a lazily-loaded region can still be ' +
          'unfinished when this returns. See browser_capture on how to tell.',
      },
    ],
  },
  {
    name: 'browser_act',
    operation: 'act',
    description:
      'Do one thing to the page: click, type, fill, press, select, hover, check, scroll, resize, ' +
      'emulate, dialog. Element references come from a snapshot. Returns a fresh snapshot after ' +
      'every change, because your next reference has to come from the page as it is now.',
    arguments: [
      LEASE_KEY,
      {
        name: 'action',
        type: 'string',
        required: true,
        description: 'One of the verbs above. An unknown verb is refused with the full list.',
      },
      {
        name: 'target',
        type: 'string',
        required: false,
        description: 'The element reference, from a snapshot, where the action needs one.',
      },
      {
        name: 'value',
        type: 'string',
        required: false,
        description: 'What to type, select, or answer a dialog with.',
      },
    ],
  },
  {
    name: 'browser_read',
    operation: 'read',
    description:
      'Read the page: the accessibility snapshot by default, or the console, network or cookies ' +
      'on request. Written to disk and returned as a path, so you pay for the part you open ' +
      'rather than for all of it.',
    arguments: [
      LEASE_KEY,
      {
        name: 'what',
        type: 'string',
        required: false,
        description: '"snapshot" (default), "console", "network" or "cookies".',
      },
    ],
  },
  {
    name: 'browser_evaluate',
    operation: 'evaluate',
    description:
      'Evaluate an expression in the page and get its value back. For a fact about the page that ' +
      'the snapshot does not carry.',
    arguments: [
      LEASE_KEY,
      {
        name: 'expression',
        type: 'string',
        required: true,
        description: 'The expression. Bounded in length; an over-long one is refused.',
      },
    ],
  },
  {
    name: 'browser_capture',
    operation: 'capture',
    description:
      'Take a picture of the page — and, if you name an earlier capture, what changed since it. ' +
      'Returns paths, never the image itself. A selector and a full page cannot both be asked ' +
      'for. Never refused for cost. ' +
      CAPTURE_SETTLE_CAVEAT +
      ' ' +
      CAPTURE_BUILD_COMPARISON_CAVEAT,
    arguments: [
      LEASE_KEY,
      {
        name: 'selector',
        type: 'string',
        required: false,
        description: 'Capture one element rather than the viewport.',
      },
      {
        name: 'full_page',
        type: 'boolean',
        required: false,
        description: 'Capture the whole scrollable page. Not combinable with a selector.',
      },
      {
        name: 'compare_to',
        type: 'string',
        required: false,
        description:
          'An earlier capture to diff against. The diff rides here rather than being its own tool.',
      },
      {
        name: 'reason',
        type: 'string',
        required: false,
        description:
          'Free text, recorded, never refused — why this capture needed more than the default tier.',
      },
    ],
  },
  {
    name: 'browser_sign_in',
    operation: 'sign_in',
    // **Row #67 lands here, and §3.2's sentence is the reason.** The
    // description is the only place a calling agent reliably reads, and the
    // measured failure this tool exists to end is one no refusal can reach: a
    // caller that hits a login wall and never learns it could ask. §1.2
    // counted 25 sessions hand-seeding tokens into an isolated browser rather
    // than asking, so the alternative is named explicitly — the way the
    // refusals do — rather than left to be inferred from the tool existing.
    description:
      'Hit a login wall? Ask the person to sign in, on the tab you already have. Do NOT abandon ' +
      'the task and do NOT fabricate a session by seeding tokens or cookies — ask. Your lease and ' +
      'your tab survive the wait: keep calling browser_status while the person signs in, then ' +
      'call browser_sign_in_done when they say they are finished. The result carries a sentence ' +
      'to relay to them. If nobody answers, the request lapses and the browser serves others ' +
      'again — you keep your tab either way.',
    arguments: [
      LEASE_KEY,
      {
        name: 'what',
        type: 'string',
        required: true,
        description:
          'What they are signing into, 3-200 characters, relayed to them verbatim. Name the site ' +
          'or account — "the account dashboard" — not the step you are on.',
      },
      {
        name: 'request_seconds',
        type: 'integer',
        required: false,
        description:
          'Ask for a shorter wait than the default. Capped, never extended; the wait you actually ' +
          'got comes back on the response.',
      },
    ],
  },
  {
    name: 'browser_sign_in_done',
    operation: 'sign_in_done',
    description:
      'The person says they have signed in. Gives the browser back to other callers and keeps ' +
      'your lease and your tab exactly as they were, so carry straight on. Only the lease that ' +
      'asked can call this.',
    arguments: [LEASE_KEY],
  },
  {
    name: 'browser_feedback',
    operation: 'feedback',
    description:
      'Tell this service that something helped or got in the way. No lease needed — if your ' +
      'claim was just refused, you are exactly who this is for. Rate 1 (it stalled my work) to ' +
      '5 (it made my work faster); 3 is neutral. The lease, your last operation and the refusal ' +
      'you hit are captured for you: say what you were trying to achieve and what you expected. ' +
      'Written locally, never transmitted.',
    arguments: [
      {
        name: 'rating',
        type: 'integer',
        required: true,
        description:
          '1 it stalled the work · 2 substantial friction · 3 neutral · 4 it helped, with a ' +
          'rough edge · 5 it made the work faster. The axis is help versus hinder, not liking.',
      },
      {
        name: 'category',
        type: 'string',
        required: true,
        description:
          'refusal-unclear · no-path · worked-around · surprised-me · worked-well. One of those five.',
      },
      {
        name: 'note',
        type: 'string',
        required: true,
        description:
          '20-2000 characters: what you were trying to achieve, what you expected, and what you ' +
          'did instead. Do not type the lease id, the operation or the rule — those are captured.',
      },
      {
        name: 'session_id',
        type: 'string',
        required: false,
        description: 'Your identity, when there is no lease to read one from.',
      },
      {
        name: 'lease_key',
        type: 'string',
        required: false,
        description:
          'When you hold one. It only attaches the row to a lease; it authorises nothing.',
      },
    ],
  },
];

/**
 * The tools, by name.
 *
 * Built once rather than searched linearly per call, and exported so the
 * surface and its tests look a tool up the same way.
 */
export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(
  TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
);

/** Every operation this surface offers, read from the tool table. */
export const TOOL_OPERATIONS: readonly OperationName[] = TOOL_DEFINITIONS.map(
  (tool) => tool.operation,
);

/**
 * Operations the surface offers, named so a test can compare by name.
 *
 * `MILESTONES.md` records a hollow test that "iterated a list rather than
 * naming its entries, so deleting an entry stayed green". A test comparing
 * this against {@link OPERATION_NAMES} by name catches a deletion; one
 * comparing lengths does not.
 */
export const OPERATIONS_WITH_TOOLS: readonly OperationName[] = OPERATION_NAMES.filter((operation) =>
  TOOL_DEFINITIONS.some((tool) => tool.operation === operation),
);
