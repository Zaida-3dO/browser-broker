import {
  ARTIFACT_COLLECTION,
  MAX_UPLOAD_FILES,
  PAGE_ACTIONS,
  READ_ARTIFACTS,
  type CookieSummary,
  type PageAction,
  type ReadArtifact,
  type SnapshotFilter,
  type ValidatedAction,
} from '../browser/driver.ts';
import { BrokerError } from '../errors.ts';
import { isAbsoluteInEitherNamespace } from '../artifacts/store.ts';

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
 * turns `unknown` into `ValidatedAction`** — the seam's own note says a cast
 * at the boundary makes its union decorative, and this is the code that makes
 * the cast unnecessary.
 *
 * `upload` is the one verb for which that is not the whole journey. What this
 * file produces for it is the caller's **names**, shape-checked; the files
 * those name are read by `src/uploads/resolve.ts` after the lease is admitted,
 * and only then does the request become an `ActionRequest` a driver can be
 * handed. The boundary above is why: reading a file is work against this
 * machine, and nothing in this file touches a filesystem.
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

/**
 * Check how long a navigation may take, before anything navigates.
 *
 * Returns the wait in milliseconds, or `undefined` when the caller expressed
 * no opinion and the browser library's own default should apply.
 *
 * ── Why the lease is the ceiling, rather than a number somebody picked ──
 *
 * `ttlSeconds` is the lifetime this particular lease was promised, converted
 * to milliseconds. It is the number the bound is *about*: a lease is a tab
 * (§2.3) and capacity is a fixed total across the browsers (§6.2), so a caller
 * permitted to wait longer than its own lease lives would sit inside a single
 * call while the tab it is holding becomes reclaimable — which is the one
 * thing an expiry exists to make impossible, and it would be reached without
 * the caller doing anything wrong.
 *
 * Any other ceiling would be a literal, and a literal is wrong in both
 * directions at once: too low and it refuses a slow page an installation with
 * long leases can perfectly well afford, too high and it reintroduces the
 * overrun. Derived from the lease, it moves with the configuration that sets
 * lease lifetimes and needs no separate setting of its own.
 *
 * **The lease's row rather than the environment**, which is the discipline
 * every duration these operations report already keeps: the call carrying the
 * wait renews the lease by the duration that lease was granted for, so a
 * ceiling read from the environment could name a lifetime the caller is not
 * actually holding.
 *
 * A wait exactly equal to the lease is allowed rather than refused. The call
 * carrying it renews the lease first, so both are measured from that instant
 * and equality is the exact edge rather than an overrun.
 */
export function validateNavigationWait(waitMs: unknown, ttlSeconds: number): number | undefined {
  if (waitMs === undefined || waitMs === null) return undefined;

  const maximumMs = ttlSeconds * 1000;

  // The syntax as well as the semantics, which is the lesson the viewport and
  // emulate refusals below were both rewritten for: a caller that cannot see
  // the accepted range from the message has no way to converge except by
  // guessing, and a refusal that leaves it guessing costs more than the
  // argument saves.
  if (typeof waitMs !== 'number' || !Number.isInteger(waitMs) || waitMs <= 0) {
    throw new PageRefusal(
      'navigate.wait_bounded',
      `How long to wait for a page is a whole number of milliseconds from 1 to ${String(maximumMs)}, for example \`--wait-ms 5000\`.`,
      { waitMs, minimumMs: 1, maximumMs },
    );
  }

  if (waitMs > maximumMs) {
    // Named separately from the shape refusal above because the caller's
    // mistake is a different one: the value is well formed and simply asks for
    // more than a lease lasts, so the sentence says what the ceiling is and
    // where it comes from rather than how to write a number.
    throw new PageRefusal(
      'navigate.wait_bounded',
      `A wait of ${String(waitMs)}ms is longer than a lease lives (${String(maximumMs)}ms), so the tab would be reclaimable before the navigation returned. Ask for at most ${String(maximumMs)}ms.`,
      { waitMs, minimumMs: 1, maximumMs },
    );
  }

  return waitMs;
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

/**
 * The shape of a reference a snapshot mints.
 *
 * **The optional `f<n>` prefix is the whole reason this is not `/^e\d+$/`.**
 * The automation library mints an identifier as `refPrefix + "e" + n`, where
 * `refPrefix` is `"f" + frameSeq` for anything inside an iframe and empty
 * otherwise, and its own resolver matches `/^f(\d+)e\d+$/` for the framed
 * case. So `e14` and `f1e23` are both references this service will resolve,
 * and a check that recognised only the unframed form would refuse every
 * reference to an element in an iframe — turning a message that misdiagnoses
 * into a refusal that is simply wrong, which is worse.
 */
const REF_SHAPE = /^(?:f\d+)?e\d+$/u;

/** How much of a caller's value a refusal quotes back before cutting it off. */
const REF_ECHO_LIMIT = 24;

/** A caller's value, shortened so the refusal names it without reprinting it. */
function echoRef(value: string): string {
  return value.length > REF_ECHO_LIMIT ? `${value.slice(0, REF_ECHO_LIMIT)}...` : value;
}

/**
 * An element reference, refused when it is absent, empty, or not a reference
 * at all.
 *
 * ── Why the shape is checked here rather than at resolution ──────────────
 *
 * A caller passed a CSS selector as a reference and was told, at length, that
 * references go stale — so they re-read the page repeatedly, with the message
 * endorsing a hypothesis that was never true. The two failures look identical
 * at the point of resolution, where all that is known is that nothing
 * matched; they are plainly different *here*, where the value itself is still
 * in hand and a selector does not have the shape of a reference.
 *
 * So this is a conventional refusal, which is what {@link validateAction} is
 * for: it is answered from the argument alone, and answering it here means no
 * tab is touched and the driver is never asked. What remains at the
 * resolution site is genuine staleness — a well-formed reference to an
 * element that has since gone — and its message is free to explain staleness
 * because by then staleness is the only thing left to explain.
 */
function requireRef(value: unknown, field: string, action: PageAction): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PageRefusal(
      'act.ref_required',
      `The "${action}" action addresses an element, so it needs ${field} — a reference taken from the tab's most recent snapshot.`,
      { action, field },
    );
  }
  if (!REF_SHAPE.test(value.trim())) {
    throw new PageRefusal(
      'act.ref_shaped',
      `"${echoRef(value.trim())}" is not an element reference. A reference is a handle a snapshot minted — the value in [ref=...] on a line of the accessibility tree, like e14 or f1e23 — and never a selector composed by the caller. Read the page (browser_read with what: "snapshot") and use a [ref=...] value from it.`,
      { action, field, [field]: value },
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
export function validateAction(raw: unknown): ValidatedAction {
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
        // **The syntax, not only the semantics.** The previous wording said
        // what a resize needs and never how to write it, so a caller who had
        // supplied a width and a height in pixels — in one of five reasonable
        // spellings — read a message telling them to supply a width and a
        // height in pixels. There was no way to converge by guessing, and the
        // session that hit it stopped after five attempts. An example ends
        // that in one call.
        throw new PageRefusal(
          'act.viewport_bounded',
          "A resize sets the tab's viewport, so it needs a width and a height in pixels: " +
            '`--width 390 --height 844`, or `--value 390x844`.',
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
        // The names were always here, and they were the good half of this
        // message. What was missing is how to write one — see the resize
        // refusal above for the same fix and the same reason.
        throw new PageRefusal(
          'act.emulate_preference_named',
          `An emulate sets media preferences, so it names at least one of: ${MEDIA_PREFERENCE_NAMES.join(', ')}. ` +
            'On the MCP surface the preferences travel inside the `request` argument: ' +
            '`{"request": {"action": "emulate", "preferences": {"colourScheme": "dark"}}}`. ' +
            'On the command line: `--colour-scheme dark`.',
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
          `An emulate names at least one preference to set: ${MEDIA_PREFERENCE_NAMES.join(', ')}. ` +
            'On the MCP surface the preferences travel inside the `request` argument: ' +
            '`{"request": {"action": "emulate", "preferences": {"colourScheme": "dark"}}}`. ' +
            'On the command line: `--colour-scheme dark`.',
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
          // The same shape gate as {@link requireRef}, because a selector
          // passed here is the same caller mistake and deserves the same
          // answer rather than a staleness story from the resolution site.
          if (!REF_SHAPE.test(entry.ref.trim())) {
            throw new PageRefusal(
              'act.ref_shaped',
              `Field ${String(index)} of the batch fill carries "${echoRef(entry.ref.trim())}", which is not an element reference. A reference is a handle a snapshot minted — the value in [ref=...] on a line of the accessibility tree, like e14 or f1e23 — and never a selector composed by the caller. Read the page (browser_read with what: "snapshot") and use a [ref=...] value from it.`,
              { action, index, ref: entry.ref },
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

    case 'upload': {
      // **The one verb that moves data from this machine into a page**, and
      // the only interaction a caller cannot reach by dispatching an event
      // from inside the page — which is the admission argument §3.8 asks for.
      //
      // What is checked here is the **shape** of the request and nothing
      // else: the reference, the count, and each name being a name at all.
      // Nothing here touches a filesystem. Containment, the read and the size
      // caps belong to `src/uploads/resolve.ts` and happen after `admit`,
      // because they are questions about this machine rather than about the
      // request — and this function's contract is that everything it refuses,
      // it refuses before a tab is reached.
      //
      // The reference goes through `requireRef` unchanged, so `upload`
      // inherits every refusal that guards a reference for the other verbs
      // rather than minting its own opinion about what one looks like.
      const ref = requireRef(input.ref, 'an element reference', action);
      const paths = input.paths;
      if (!Array.isArray(paths) || paths.length === 0) {
        throw new PageRefusal(
          'act.upload_paths_required',
          'The "upload" action puts files into a file input, so it needs paths — a list of one or more files, each named relative to the service\'s configured upload root. On the command line: --path invoice.pdf.',
          { action, maximum: MAX_UPLOAD_FILES },
        );
      }
      if (paths.length > MAX_UPLOAD_FILES) {
        throw new PageRefusal(
          'act.upload_paths_bounded',
          `An upload carries at most ${String(MAX_UPLOAD_FILES)} files, and this one names ${String(paths.length)}.`,
          { action, count: paths.length, maximum: MAX_UPLOAD_FILES },
        );
      }
      return {
        action,
        ref,
        // The names, not the files. The bytes arrive later, from the
        // resolver; this carries what the caller wrote so the layer that
        // reads can refuse in terms of what was asked for.
        paths: (paths as unknown[]).map((entry, index) => {
          if (typeof entry !== 'string' || entry.trim() === '' || entry.includes('\0')) {
            throw new PageRefusal(
              'act.upload_path_shape',
              `Path ${String(index)} of the upload is not a name this service will read. Each one is a file's name relative to the configured upload root.`,
              { action, index },
            );
          }
          // Absolute in **either** namespace, asked of the name the caller
          // supplied. This is the same question `src/artifacts/store.ts` asks
          // of a filename, for the same reason, and it is asked twice on
          // purpose: here, so a caller learns the shape is wrong before a
          // lease is admitted, and again in the resolver, which is the guard
          // that must hold whoever calls it and however this path changes.
          if (isAbsoluteInEitherNamespace(entry)) {
            throw new PageRefusal(
              'act.upload_path_shape',
              `Path ${String(index)} of the upload names a location of its own. An upload path is relative to the configured upload root: no leading slash, no drive letter and no share prefix.`,
              { action, index },
            );
          }
          return entry;
        }),
      };
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
 * The longest `find` this will compile, in characters.
 *
 * A bound rather than a guess at what is reasonable: the pattern is compiled
 * into a regular expression on this process, and an unbounded one is an
 * unbounded compile. This is far above any selector text a caller writes —
 * the pattern is matched against one line of an accessibility tree, and a
 * line is rarely past a couple of hundred characters — so the bound refuses
 * abuse without being reachable by ordinary use.
 */
const FIND_MAX_LENGTH = 200;

/**
 * Read a caller's `find` into something the driver can match lines against.
 *
 * ── Why two spellings and not one ───────────────────────────────────────
 *
 * The overwhelmingly common case is a literal: *the word "Checkout" appears
 * on this page somewhere*. Making that caller write a regular expression —
 * and escape the `.` in a price, or the `(` in a label — is a tax on the
 * ordinary case for the benefit of the rare one.
 *
 * The rare one is real though: `/^\s*- button/` finds every button at a
 * depth, which no substring can express. So `/…/` is read as a pattern and
 * everything else is read as literal text, which is the spelling agents
 * already know from `grep` and from this repository's own doc-link checks.
 *
 * **Case is ignored on the literal path** and honoured on the pattern path.
 * A caller typing `checkout` is looking for the button whatever the page
 * capitalised it as; a caller who wrote a regular expression has asked for
 * exactly what they wrote, and quietly adding a flag to it would make
 * `/[A-Z]/` match a lower-case letter — a pattern that does not do what it
 * says is worse than one that finds nothing.
 *
 * Returns `undefined` when nothing was asked for, which is the ordinary read
 * — `find` is optional and its absence is not a refusal.
 *
 * ── Why a malformed pattern is refused here rather than thrown ──────────
 *
 * `new RegExp` on bad syntax throws a `SyntaxError` whose message is written
 * for a JavaScript author (*"Invalid regular expression: /[/: Unterminated
 * character class"*). Let out, it reaches an agent as an internal error with
 * no rule name and no suggestion, and the reasonable inference — *the browser
 * broker is broken* — is wrong. It is a refusal: the caller asked for
 * something this cannot do, and the thing to do instead is to fix the
 * pattern or to drop the slashes and search for text.
 */
export function resolveSnapshotFilter(find: unknown): SnapshotFilter | undefined {
  if (find === undefined || find === null) return undefined;

  if (typeof find !== 'string' || find.trim() === '') {
    throw new PageRefusal(
      'read.find_shape',
      'find is the text to look for in the snapshot, as a string: ' +
        'find: "Checkout" matches any line containing it, ignoring case. ' +
        'Wrap it in slashes for a regular expression instead: find: "/^\\\\s*- button/".',
      { find },
    );
  }

  if (find.length > FIND_MAX_LENGTH) {
    throw new PageRefusal(
      'read.find_shape',
      `find is ${String(find.length)} characters, and the limit is ${String(FIND_MAX_LENGTH)}. ` +
        'It is matched against one line of the accessibility tree at a time, so a pattern ' +
        'longer than a line cannot match anything. Search for a distinctive part of it.',
      { find, length: find.length, limit: FIND_MAX_LENGTH },
    );
  }

  // A pattern is `/…/`, needing both delimiters and something between them —
  // so a lone "/" is text (an address fragment, which is a perfectly ordinary
  // thing to search a snapshot for) rather than an empty pattern that matches
  // every line.
  const isPattern = find.length >= 2 && find.startsWith('/') && find.endsWith('/');
  if (!isPattern) {
    return { kind: 'text', text: find };
  }

  const source = find.slice(1, -1);
  if (source === '') {
    throw new PageRefusal(
      'read.find_shape',
      'find was "//", which is an empty regular expression and matches every line. ' +
        'Put the pattern between the slashes — find: "/^\\\\s*- button/" — or drop them ' +
        'to search for the text "//" itself.',
      { find },
    );
  }

  try {
    return { kind: 'pattern', pattern: new RegExp(source) };
  } catch (error) {
    // The engine's own message is carried through rather than replaced: it
    // names the position and the construct, which is the part that tells a
    // caller which character to fix. What this adds is the way out.
    throw new PageRefusal(
      'read.find_shape',
      `find was read as a regular expression because it is wrapped in slashes, and ` +
        `it does not compile: ${error instanceof Error ? error.message : String(error)}. ` +
        'Fix the pattern, or drop the surrounding slashes to search for it as literal text.',
      { find, pattern: source },
    );
  }
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
      'An evaluation needs an expression to evaluate in the page, in the `expression` argument ' +
        '(a string — a measurement, a computed style, some geometry to read back).',
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

/**
 * Check a capture's two mode arguments before the shutter is pressed.
 *
 * ── Why this exists as its own guard, and what it was found by ──────────
 *
 * `capture.exclusive_mode` is a §7.1 rule — *"a selector and a full page are
 * not both asked for"*, refused with *"cannot do both"* — and it had **no
 * implementation anywhere**. A capture naming both was accepted, and what it
 * then did was decided by whichever argument the pipeline happened to read
 * first. That is the shape §7's own header calls out: a rule that never
 * refuses anything protects nothing.
 *
 * It went unnoticed because the only thing asserting it was a service double
 * that implemented the rule itself, so the assertion was about the double.
 * Running the same cases against the real service is what surfaced it.
 *
 * ── Why it is a refusal rather than a precedence rule ───────────────────
 *
 * Picking a winner would be the worse answer and §1.9's reasoning is the
 * same one: the two arguments express **different intentions**, not different
 * amounts of one. A caller asking for an element and for the whole page has
 * contradicted itself, and any resolution silently gives it a picture of
 * something it did not ask for — which it cannot detect, because a capture
 * comes back as a path and some dimensions rather than as pixels it could
 * check.
 *
 * **This is a refusal about a malformed argument and never about cost**,
 * which `capture.never_refused_for_cost` (§7.3) requires be kept true: a
 * capture is never refused for being expensive, and nothing here reads a tier,
 * a size or a count.
 */
export function validateCaptureMode(options: {
  readonly fullPage: boolean;
  readonly selector: string | undefined;
}): void {
  if (options.fullPage && options.selector !== undefined) {
    throw new PageRefusal(
      'capture.exclusive_mode',
      'A capture takes a selector or the whole page, and this call asked for both. They are different pictures rather than different amounts of one, so nothing here can pick for you: ask for the element, or ask for the page.',
      { fullPage: true, selector: options.selector },
    );
  }
}

/**
 * The resolution rung a capture was asked for, checked before the pipeline
 * indexes anything by it.
 *
 * ── Why this guard is here and not left to the pipeline ─────────────────
 *
 * The pipeline types the field {@link RequestableTier}, so within the service
 * an unknown rung is a compile error and no check is needed. It stops being a
 * compile-time question at the surface: a tool call and a command line both
 * arrive as free text, and an unrecognised word typed by a caller would reach
 * `TIER_LONGEST_EDGE[tier]`, resolve to `undefined`, and be handed to the
 * downscaler as a target edge. That is a bad answer arriving quietly, which is
 * the same family as the inert argument this pair was wired for.
 *
 * **`default` is refused as a value even though it is a real tier**, because
 * it is the rung you get by passing nothing. `RequestableTier` excludes it on
 * the seam deliberately — "there is deliberately no way to ask for the default
 * explicitly" is a compile error rather than a line in a document — and this
 * refusal keeps that true for callers who reach the service through text.
 */
export function validateCaptureTier(tier: unknown): 'detail' | 'max' | undefined {
  if (tier === undefined || tier === null) return undefined;

  if (tier !== 'detail' && tier !== 'max') {
    throw new PageRefusal(
      'capture.tier_known',
      'A capture tier is "detail" or "max". Omit it for the default resolution — there is no way to ask for the default by name, because passing nothing is how you get it. "max" additionally requires reason, a written explanation in your own words.',
      { tier, accepted: ['detail', 'max'] },
    );
  }

  return tier;
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
