import {
  ARTIFACT_COLLECTION,
  PAGE_ACTIONS,
  READ_ARTIFACTS,
  type ActionRequest,
  type CookieSummary,
  type PageAction,
  type ReadArtifact,
} from '../browser/driver.ts';
import { BrokerError } from '../errors.ts';

/**
 * The page verbs: what a caller may ask of a tab it owns, and every way that
 * asking is refused (rows #22, #61, #62, #63, #64, #23, #24).
 *
 * ── What is in this file and what is deliberately not ───────────────────
 *
 * Everything here is **argument validation and shaping**. Nothing in this
 * file opens a transaction, reads the store, or talks to a browser, and that
 * is a boundary rather than a coincidence:
 *
 * - Ownership — §7.1 `tab.owned` and `tab.open` — is answered in `tabs.ts`,
 *   against the store, by a query selecting on both the tab and its lease.
 *   Validating an argument cannot establish who owns anything.
 * - Browser work happens after the arbitration transaction commits (§2.4b).
 *   A validator that could reach a browser is a validator that will
 *   eventually be called from inside one.
 *
 * So the functions here take a caller's arguments and either return the
 * typed request the driver seam declares, or throw. **They are the step that
 * turns `unknown` into `ActionRequest`** — the seam's own note says a cast at
 * the boundary makes its union decorative, and this is the code that makes
 * the cast unnecessary.
 *
 * ── Refusals are the specification ──────────────────────────────────────
 *
 * `SCHEMA.md` §7's opening line — "a rule that never refuses anything
 * protects nothing, so the refusals are the specification" — is why this file
 * is mostly refusals and why each one carries the §7 rule that produced it.
 */

/**
 * A refusal from one of these operations.
 *
 * **Deliberately not the service layer's `CallRefusal`.** That taxonomy is a
 * closed table of codes owned by the arbitration row, and its own comment
 * states the discipline it keeps: "a code nothing can raise is exactly the
 * assertion-over-an-empty-set that passes forever and silently — add the row
 * with the guard, never before it." This module is the guards; the codes for
 * them are added to that table when the two are wired together, and inventing
 * them here would either duplicate the table or edit another row's file.
 *
 * What is carried now is the part that must not be lost in the meantime: the
 * §7 rule name, which is what the ledger is grepped by and what §8's parity
 * assertion counts over.
 */
export class PageRefusal extends BrokerError {
  /** §3.14's "any details" — the numbers a caller branches on after the rule. */
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(rule: string, message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(rule, message);
    this.name = 'PageRefusal';
    this.detail = detail;
  }
}

/* ───────────────────────── navigate (#22) ───────────────────────── */

/**
 * The address schemes a navigation may use.
 *
 * **An allowlist, and the shape of the rule is the rule.** §7.1
 * `navigate.scheme_allowed` requires "ordinary web traffic or a blank page",
 * and a denylist of the schemes to refuse would be wrong in the direction
 * that matters: every scheme nobody thought of would be permitted, and
 * browsers carry a great many. The refusal §3.7 names explicitly is the local
 * file, because it "turns a browser lease into an arbitrary read of the
 * machine's filesystem, which no part of this contract intends to grant" —
 * but it is refused here by not being on this list, not by being matched.
 */
const ALLOWED_SCHEMES: readonly string[] = ['http:', 'https:'];

/** The one address that is not a scheme match: a deliberately blank page. */
const BLANK_PAGE = 'about:blank';

/**
 * Check an address before anything navigates to it.
 *
 * Returns the address to navigate to. Refuses anything that is not ordinary
 * web traffic or a blank page.
 */
export function validateNavigationTarget(url: unknown): string {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new PageRefusal(
      'navigate.scheme_allowed',
      'A navigation needs an address: ordinary web traffic, or a blank page.',
      { allowedSchemes: [...ALLOWED_SCHEMES], blankPage: BLANK_PAGE },
    );
  }

  const candidate = url.trim();
  if (candidate === BLANK_PAGE) return candidate;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new PageRefusal(
      'navigate.scheme_allowed',
      `That is not an address this service can navigate to. Use ordinary web traffic (${ALLOWED_SCHEMES.join(', ')}) or ${BLANK_PAGE}.`,
      { allowedSchemes: [...ALLOWED_SCHEMES], blankPage: BLANK_PAGE },
    );
  }

  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    // The local-file case lands here, and §3.7 refuses it specifically. It is
    // named in the sentence rather than matched in the condition: matching it
    // would suggest the other schemes are fine, and the allowlist above is
    // what actually decides.
    throw new PageRefusal(
      'navigate.scheme_allowed',
      `The address uses "${parsed.protocol}", which this service does not navigate to. Ordinary web traffic (${ALLOWED_SCHEMES.join(', ')}) or ${BLANK_PAGE} only — a local-file address in particular would turn a browser lease into a read of this machine's filesystem.`,
      { scheme: parsed.protocol, allowedSchemes: [...ALLOWED_SCHEMES], blankPage: BLANK_PAGE },
    );
  }

  return candidate;
}

/* ───────────────────────── act (#22, #61–#64) ───────────────────────── */

/**
 * The refusal that **lists every action by name**.
 *
 * `SCHEMA.md` §3.8: "Refused for an action that is not on the list, **listing
 * every action** — the discoverability cost of folding them into one tool is
 * paid back here or not at all."
 *
 * That last clause is the whole argument and it is worth keeping in front of
 * whoever edits this. Rows #61 to #64 each fold a capability into
 * `browser_act` instead of adding a tool, on the grounds that each is
 * tab-scoped, non-destructive, invisible to other callers and leaves nothing
 * to recover from. **What folding costs is discoverability**: a caller
 * reading a list of tools sees one entry where it would have seen five. This
 * refusal is the entire repayment. A refusal that said "unknown action" would
 * take the saving and default on the debt.
 *
 * The list comes from {@link PAGE_ACTIONS} rather than being written out
 * again here, so a row adding a verb cannot add it to the union and forget
 * the refusal — there is one place, which is what the seam's comment says the
 * closed union is for.
 */
export function refuseUnknownAction(action: unknown): never {
  throw new PageRefusal(
    'act.action_known',
    `There is no "${String(action)}" action. Every action this service performs: ${PAGE_ACTIONS.join(', ')}.`,
    { action, actions: [...PAGE_ACTIONS] },
  );
}

/** Whether a string is one of the verbs. */
export function isPageAction(action: unknown): action is PageAction {
  return typeof action === 'string' && (PAGE_ACTIONS as readonly string[]).includes(action);
}

/** An element reference, refused when it is absent or empty. */
function requireRef(value: unknown, field: string, action: PageAction): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PageRefusal(
      'act.ref_required',
      `The "${action}" action addresses an element, so it needs ${field} — a reference taken from the tab's most recent snapshot.`,
      { action, field },
    );
  }
  return value;
}

/** A value, refused when the action needs one and it is absent. */
function requireValue(value: unknown, action: PageAction): string {
  if (typeof value !== 'string') {
    throw new PageRefusal('act.value_required', `The "${action}" action needs a value to apply.`, {
      action,
    });
  }
  return value;
}

/**
 * The largest viewport this service will set, per side.
 *
 * A bound rather than none, and the reason is not politeness: a viewport is
 * allocated, so an unbounded one is a memory request from a caller that costs
 * the machine rather than the caller. The number is generous enough that no
 * real review hits it — well past the largest ordinary display — which is the
 * property that makes it a guard against a mistake rather than a limit
 * anybody has to plan around.
 */
export const MAX_VIEWPORT_SIDE = 16384;

/** A viewport side: a positive whole number within the bound. */
function requireViewportSide(value: unknown, side: 'width' | 'height'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new PageRefusal(
      'act.viewport_bounded',
      `A viewport ${side} is a whole number of pixels greater than zero.`,
      { side, value },
    );
  }
  if (value > MAX_VIEWPORT_SIDE) {
    throw new PageRefusal(
      'act.viewport_bounded',
      `A viewport ${side} of ${String(value)} is past this service's bound of ${String(MAX_VIEWPORT_SIDE)}.`,
      { side, value, maximum: MAX_VIEWPORT_SIDE },
    );
  }
  return value;
}

/** The values each media preference accepts (§3.8's table). */
const MEDIA_PREFERENCES = {
  colourScheme: ['light', 'dark', 'no-preference'],
  reducedMotion: ['reduce', 'no-preference'],
  forcedColours: ['active', 'none'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** The preferences by name, for a refusal that lists them. */
export const MEDIA_PREFERENCE_NAMES: readonly string[] = Object.keys(MEDIA_PREFERENCES);

/**
 * The most fields one batch fill may carry.
 *
 * Batch fill exists because 78 measured calls across 35 sessions filled
 * several fields in a row (#64); it is not a bulk-data channel, and a bound
 * is what keeps the second reading from becoming available by accident.
 */
export const MAX_FORM_FIELDS = 64;

/**
 * Turn a caller's arguments into the typed request the driver takes, or
 * refuse.
 *
 * **The input is `unknown` because that is what a caller's arguments are.**
 * The seam's own note is explicit that a cast at the boundary makes its union
 * decorative — the compiler would then be checking a claim this function made
 * up rather than a fact it established. So every field is examined.
 */
export function validateAction(raw: unknown): ActionRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new PageRefusal('act.action_known', 'An action names what to do and what to do it to.', {
      actions: [...PAGE_ACTIONS],
    });
  }

  const input = raw as Record<string, unknown>;
  const action = input.action;

  if (!isPageAction(action)) refuseUnknownAction(action);

  switch (action) {
    case 'click':
    case 'hover':
    case 'check':
      return { action, ref: requireRef(input.ref, 'an element reference', action) };

    case 'type':
    case 'fill':
    case 'select':
      return {
        action,
        ref: requireRef(input.ref, 'an element reference', action),
        value: requireValue(input.value, action),
      };

    case 'press':
      // The reference is optional: a press with none goes to whatever the
      // page has focused, which is how a caller sends a key to a page rather
      // than to a particular field.
      return {
        action,
        ...(input.ref === undefined
          ? {}
          : { ref: requireRef(input.ref, 'an element reference', action) }),
        value: requireValue(input.value, action),
      };

    case 'scroll':
      return {
        action,
        ...(input.ref === undefined
          ? {}
          : { ref: requireRef(input.ref, 'an element reference', action) }),
      };

    case 'resize': {
      // #61. Two integers, not a string to be re-parsed — see `Viewport` on
      // the seam for why that shape is the one that carries meaning.
      const viewport = input.viewport;
      if (typeof viewport !== 'object' || viewport === null) {
        throw new PageRefusal(
          'act.viewport_bounded',
          "A resize sets the tab's viewport, so it needs a width and a height in pixels.",
          { action },
        );
      }
      const { width, height } = viewport as Record<string, unknown>;
      return {
        action,
        viewport: {
          width: requireViewportSide(width, 'width'),
          height: requireViewportSide(height, 'height'),
        },
      };
    }

    case 'emulate': {
      // #62. Every preference is optional independently — a caller switching
      // to dark mode says nothing about motion or contrast — but an emulate
      // naming none of them is a call that means nothing, and that is the
      // refusal.
      const preferences = input.preferences;
      if (typeof preferences !== 'object' || preferences === null) {
        throw new PageRefusal(
          'act.emulate_preference_named',
          `An emulate sets media preferences, so it names at least one of: ${MEDIA_PREFERENCE_NAMES.join(', ')}.`,
          { action, preferences: MEDIA_PREFERENCE_NAMES },
        );
      }

      const supplied = preferences as Record<string, unknown>;
      const validated: Record<string, string> = {};

      for (const name of MEDIA_PREFERENCE_NAMES) {
        const value = supplied[name];
        if (value === undefined) continue;
        const allowed: readonly string[] =
          MEDIA_PREFERENCES[name as keyof typeof MEDIA_PREFERENCES];
        if (typeof value !== 'string' || !allowed.includes(value)) {
          throw new PageRefusal(
            'act.emulate_preference_named',
            `"${name}" is one of: ${allowed.join(', ')}.`,
            { action, preference: name, allowed: [...allowed], value },
          );
        }
        validated[name] = value;
      }

      if (Object.keys(validated).length === 0) {
        throw new PageRefusal(
          'act.emulate_preference_named',
          `An emulate names at least one preference to set: ${MEDIA_PREFERENCE_NAMES.join(', ')}.`,
          { action, preferences: MEDIA_PREFERENCE_NAMES },
        );
      }

      return { action, preferences: validated };
    }

    case 'dialog': {
      // #63. Here on consequence rather than frequency: an unhandled dialog
      // blocks its tab, so the caller holds a lease it cannot use and burns
      // it.
      const response = input.response;
      if (typeof response !== 'object' || response === null) {
        throw new PageRefusal(
          'act.dialog_answer_named',
          'Answering a dialog says whether to accept it or dismiss it.',
          { action },
        );
      }
      const { accept, promptText } = response as Record<string, unknown>;
      if (typeof accept !== 'boolean') {
        throw new PageRefusal(
          'act.dialog_answer_named',
          'Answering a dialog says whether to accept it or dismiss it.',
          { action },
        );
      }
      if (promptText !== undefined && typeof promptText !== 'string') {
        throw new PageRefusal('act.dialog_answer_named', "A dialog's prompt text is text.", {
          action,
        });
      }
      if (promptText !== undefined && !accept) {
        // Text plus a dismissal describes two intentions at once, and
        // guessing which one was meant is how a caller ends up believing it
        // answered a prompt it actually threw away.
        throw new PageRefusal(
          'act.dialog_answer_named',
          'Prompt text is what to type before accepting, so it cannot accompany a dismissal. Accept the dialog, or dismiss it without text.',
          { action },
        );
      }
      return {
        action,
        response: { accept, ...(promptText === undefined ? {} : { promptText }) },
      };
    }

    case 'fill_form': {
      // #64, the measured half: 78 calls across 35 sessions.
      const fields = input.fields;
      if (!Array.isArray(fields) || fields.length === 0) {
        throw new PageRefusal(
          'act.form_fields_bounded',
          'A batch fill needs at least one field to fill, each with an element reference and a value.',
          { action, maximum: MAX_FORM_FIELDS },
        );
      }
      if (fields.length > MAX_FORM_FIELDS) {
        throw new PageRefusal(
          'act.form_fields_bounded',
          `A batch fill carries at most ${String(MAX_FORM_FIELDS)} fields, and this one carries ${String(fields.length)}.`,
          { action, count: fields.length, maximum: MAX_FORM_FIELDS },
        );
      }
      return {
        action,
        fields: (fields as unknown[]).map((field, index) => {
          const entry = (typeof field === 'object' && field !== null ? field : {}) as Record<
            string,
            unknown
          >;
          if (typeof entry.ref !== 'string' || entry.ref.trim() === '') {
            throw new PageRefusal(
              'act.ref_required',
              `Field ${String(index)} of the batch fill needs an element reference taken from the tab's most recent snapshot.`,
              { action, index },
            );
          }
          if (typeof entry.value !== 'string') {
            throw new PageRefusal('act.value_required', `Field ${String(index)} needs a value.`, {
              action,
              index,
            });
          }
          return { ref: entry.ref, value: entry.value };
        }),
      };
    }

    case 'drag': {
      // #64, the unexercised half: **zero calls across 2,007 transcripts**
      // over a month. Folded in at low priority with that number recorded, so
      // that if it turns out to matter it arrives with the number to argue
      // against. In-page, element to element — there is no
      // file-from-the-desktop shape, because a lease is a tab.
      const ref = requireRef(input.ref, 'an element reference for what is being dragged', action);
      const targetRef = requireRef(
        input.targetRef,
        'a second element reference for where it is being dragged to',
        action,
      );
      if (ref === targetRef) {
        throw new PageRefusal(
          'act.drag_ends_differ',
          'A drag moves something from one element to another, so its two references cannot be the same element.',
          { action, ref },
        );
      }
      return { action, ref, targetRef };
    }
  }
}

/* ───────────────────────── read (#23) ───────────────────────── */

/**
 * Which artefacts a read will write, given what the caller asked for.
 *
 * ── The default is the snapshot, and the filter is free ─────────────────
 *
 * §7.1 `read.default_snapshot_only` is a **default, not a refusal**. The
 * snapshot is on because it is the only load-bearing artefact — every element
 * reference `browser_act` takes comes from it (§3.8), so a read that omitted
 * it would be useless in the ordinary case. The other three are off.
 *
 * **And the reason the narrow default is cheap rather than a trap is worth
 * stating where the code is, because it is the part a reader gets wrong:**
 * console output and network activity are **accumulated continuously by the
 * browsing context**, from the moment the context exists, whether or not
 * anybody intends to ask. There is no request that starts or stops the
 * collection. So this is a filter on **what gets written to disk**, not on
 * what gets collected, and **the cost of not asking is zero** — a caller that
 * realises afterwards that it wanted the console asks on its next read and
 * gets the accumulated history, not a recording that started when it asked.
 *
 * A default that withheld something expensive to reproduce would push callers
 * into asking for everything defensively. This one withholds nothing that
 * becomes harder to get.
 *
 * **Cookies are the exception and it is named as one.** A cookie summary is a
 * live query against the browsing context, answered at the moment of asking:
 * there is no accumulated log to read from, so asking is a real operation
 * with a real cost — small, but not zero — and the answer describes that
 * instant rather than a history. Off by default for that reason as well as
 * for the obvious one. {@link ARTIFACT_COLLECTION} on the seam is where this
 * per-artefact fact lives so it is not something to reason out each time.
 */
export function resolveReadArtifacts(requested: unknown): readonly ReadArtifact[] {
  if (requested === undefined || requested === null) return ['snapshot'];

  if (!Array.isArray(requested)) {
    throw new PageRefusal(
      'read.artifact_known',
      `A read names which artefacts it wants: ${READ_ARTIFACTS.join(', ')}.`,
      { artifacts: [...READ_ARTIFACTS] },
    );
  }

  for (const artifact of requested as unknown[]) {
    if (typeof artifact !== 'string' || !(READ_ARTIFACTS as readonly string[]).includes(artifact)) {
      throw new PageRefusal(
        'read.artifact_known',
        `There is no "${String(artifact)}" artefact. Every artefact a read can ask for: ${READ_ARTIFACTS.join(', ')}.`,
        { artifact, artifacts: [...READ_ARTIFACTS] },
      );
    }
  }

  const asked = new Set(requested as ReadArtifact[]);
  // The snapshot is added rather than required, because a caller asking only
  // for the console still needs somewhere to take its next element reference
  // from, and a read that handed back a console log and no snapshot would
  // leave the tab unusable until the caller worked out it had to ask again.
  asked.add('snapshot');

  // Returned in the seam's declared order rather than the caller's, so that
  // two callers asking for the same set get the same answer and a test can
  // name the order it expects.
  return READ_ARTIFACTS.filter((artifact) => asked.has(artifact));
}

/**
 * Whether asking for an artefact costs anything, which is the honest answer
 * to *"should I ask for this defensively"*.
 */
export function artifactIsLiveQuery(artifact: ReadArtifact): boolean {
  return ARTIFACT_COLLECTION[artifact] === 'live';
}

/**
 * The fields a cookie summary carries, and the whole of them.
 *
 * Written down as data rather than left to whatever a serialiser happens to
 * emit, because §7.1 `read.cookies_no_values` is a **shape** and a shape
 * needs something to be checked against. A test that walks a serialised
 * cookie's keys and compares them to this list fails the moment a field is
 * added, which is the moment a value would arrive if one ever did.
 */
export const COOKIE_SUMMARY_FIELDS: readonly string[] = [
  'name',
  'domain',
  'path',
  'expires',
  'httpOnly',
  'secure',
  'sameSite',
];

/**
 * Shape a cookie summary for writing, **naming every field that survives**.
 *
 * ── Why this rebuilds the object instead of passing it through ──────────
 *
 * Passing a driver's cookie object straight to a serialiser emits **whatever
 * that object happens to have**, which is a different set from what this
 * service has decided to return — and the field it would most plausibly
 * acquire is the value, since every browser automation library's own cookie
 * type carries one. `CookieSummary`
 * has no value field, so a driver implementing this seam has to drop it; this
 * function is the second lock, and it fails closed: a field not named here
 * does not come out, whatever arrived.
 *
 * **A service handing over cookie values is a credential-export feature
 * whatever else it is called** (§3.9), and §3.13 refuses the write side for
 * the same reason. The value is *absent*, not truncated and not masked —
 * masking implies the value was in this process and got hidden, and the
 * design's claim is stronger than that.
 */
export function shapeCookieSummary(cookie: CookieSummary): Record<string, unknown> {
  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  };
}

/* ───────────────────────── evaluate (#24) ───────────────────────── */

/**
 * The largest expression this service will evaluate.
 *
 * §7.1 `evaluate.expression_bounded`, and §3.10 gives the reasoning in one
 * line: **"a long expression is a program, and a program wants a capability
 * that is not on offer"** (§3.13). The bound is not about cost. It is the
 * line between *"compute this measurement in the page"* — computed styles,
 * contrast ratios, box geometry, spacing, line height, reading width, a few
 * hundred tokens of structured data — and shipping a body of code into a
 * browser to run.
 */
export const MAX_EXPRESSION_BYTES = 4096;

/**
 * The largest result returned inline, before it is written to a file instead.
 *
 * §3.10: "Returns the value inline when it is small, and a path when it is
 * not." The cap exists for the reason the whole read surface returns paths —
 * a large result entering a conversation is paid for once in money and on
 * every later turn in context — and the spill is what stops that being a
 * refusal: the caller asked a legitimate question and gets its answer, in the
 * place large answers go.
 */
export const MAX_INLINE_RESULT_BYTES = 8192;

/**
 * Check an expression before it is evaluated.
 *
 * ── The thing this must never become ────────────────────────────────────
 *
 * **Evaluation happens inside the page, sandboxed by the browser, and it must
 * never be widened to run in the automation server's own process.** That is a
 * different capability wearing a similar name: the server's process reaches
 * its own filesystem, its own network, and every browser and every tab it can
 * see — past the caller's own lease entirely.
 *
 * §3.10 records what the sampling found when a verb like that existed. Of 328
 * measured calls across 53 sessions, **101 calls across 33 sessions did
 * something a page-scoped expression could not**: 16 calls in one session
 * enumerated other callers' tabs and drove one it did not own; 2 read a local
 * environment file and extracted administrative credentials in cleartext; 49
 * made authenticated outbound network requests from the server process, which
 * is not a browser operation at all.
 *
 * **So the refusal is evidence rather than caution, and it is refused by
 * absence.** There is no argument here selecting a target, no option naming a
 * context, and nothing to widen — the expression goes to the page the tab is,
 * and that is the only place it can go. **Do not reintroduce it by
 * accident**: a `target`, a `context`, a `world` or a `scope` parameter on
 * this path is that capability arriving, whatever it is called.
 *
 * ── What is deliberately *not* checked ──────────────────────────────────
 *
 * The expression's **contents**. No allowlist, no fixed vocabulary of
 * permitted measurements, no filtering of what comes back, and this is
 * settled rather than pending (§3.10): a lease on the signed-in browser
 * already grants the ability to act as the signed-in user — that is what the
 * lease is *for* — so an expression reading a page's own storage does
 * something strictly smaller than what the same lease can do by driving the
 * page. A restricted vocabulary would have to be guessed in advance, and
 * every measurement nobody guessed becomes a screenshot instead, pushing
 * callers toward the expensive path. **Refusing the obvious storage
 * accessors was considered and rejected as theatre**: it stops nobody who is
 * trying and teaches a reader that a hole is closed when it is not.
 *
 * The exposure is real and it is handled at the artifact-write layer
 * (`artifact.write_scanned`, §7.1) — one shape-matcher over everything
 * written to disk, on every path that writes, because **a page snapshot can
 * capture a rendered credential with nobody having chosen to evaluate
 * anything** and a control on this path would not have been near it.
 */
export function validateExpression(expression: unknown): string {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new PageRefusal(
      'evaluate.expression_bounded',
      'An evaluation needs an expression to evaluate in the page.',
      { maximumBytes: MAX_EXPRESSION_BYTES },
    );
  }

  const bytes = Buffer.byteLength(expression, 'utf8');
  if (bytes > MAX_EXPRESSION_BYTES) {
    throw new PageRefusal(
      'evaluate.expression_bounded',
      `That expression is ${String(bytes)} bytes and the limit is ${String(MAX_EXPRESSION_BYTES)}. This evaluates an expression in the page — a measurement, a computed style, some geometry — rather than running a program.`,
      { bytes, maximumBytes: MAX_EXPRESSION_BYTES },
    );
  }

  return expression;
}

/** What an evaluation should do with its result: hand it back, or spill it. */
export interface EvaluationDisposition {
  /** The serialised result. */
  readonly serialised: string;
  readonly bytes: number;
  /** True when it is past the inline cap and belongs in a file instead. */
  readonly spill: boolean;
}

/**
 * Decide whether a result comes back inline or goes to a file.
 *
 * **Serialising is what measures it**, rather than any estimate from the
 * value's shape: the cap is about what enters a conversation, and what enters
 * a conversation is the serialised bytes. A check against, say, an array's
 * length would let one enormous string through and spill a long list of small
 * numbers.
 *
 * A value that cannot be serialised at all is refused rather than silently
 * becoming `undefined` — a caller told its expression returned nothing, when
 * it actually returned something with a cycle in it, debugs the wrong thing.
 */
export function disposeEvaluationResult(value: unknown): EvaluationDisposition {
  let serialised: string;
  try {
    // `undefined` has no serialisation, and an expression that genuinely
    // evaluated to it is an ordinary outcome rather than an error, so it is
    // spelled out instead of falling into the catch.
    serialised = value === undefined ? 'null' : JSON.stringify(value);
  } catch (error) {
    throw new PageRefusal(
      'evaluate.result_serialisable',
      'That expression produced a value this service cannot return — a cycle, or something with no plain representation. Evaluate to plain data: a number, a string, or an object of them.',
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }

  if (serialised === undefined) {
    // `JSON.stringify` answers `undefined` rather than throwing for a
    // function or a symbol, so the two unserialisable outcomes arrive by
    // different routes and both are refused.
    throw new PageRefusal(
      'evaluate.result_serialisable',
      'That expression produced a value this service cannot return. Evaluate to plain data: a number, a string, or an object of them.',
      {},
    );
  }

  const bytes = Buffer.byteLength(serialised, 'utf8');
  return { serialised, bytes, spill: bytes > MAX_INLINE_RESULT_BYTES };
}
