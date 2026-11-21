import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The acting gate for an attached lease — the whole of §3.5 of the safety
 * plan as one pure function.
 *
 * The rule this file is built around is §7's sentence from the other side:
 * a guard that refuses *after* the browser was asked is worse than no guard,
 * because it reports a refusal that did not happen and everything downstream
 * believes it. So `decide` takes **everything it needs as inputs** — the
 * site, the verb, the target's facts, the page's facts, the grant's state —
 * does no I/O, reads no environment, and returns before anything could
 * reach the extension. The caller that wires this (the act operation) must
 * call it and act on the answer before touching a session; the decision is
 * the fence, and it is drawn entirely from what the caller already holds.
 *
 * ── The order of the checks is the specification ──────────────────────
 *
 * 1. the verb itself (a verb never allowed attached refuses whatever the
 *    site, and the answer is the same one read-only S1 gave);
 * 2. the site allowlist — the real fence, since a disguised button still
 *    lives on a site the operator chose to leave readable-but-not-actable;
 * 3. the field kinds (password, one-time-code, card) — refused even on an
 *    allowed site, by role, `autocomplete` or input type;
 * 4. the repeat guard (a second identical act within 30 s of a navigation
 *    is refused outright, grant or no grant);
 * 5. the grant: a present grant that does not verify is refused outright —
 *    fail closed rather than falling back to the ungated path;
 * 6. the consequential table: `needs_owner`, and `no_grant` when the
 *    caller carries no grant — the retry with one is the operator's path,
 *    never the agent's.
 *
 * Nothing here logs, and nothing returns a grant or the secret: the grant
 * appears only as its verification verdict.
 */

/** The page verbs this gate knows, re-exported as one source to list from. */
export type { PageAction } from '../browser/driver.ts';
import type { PageAction } from '../browser/driver.ts';

/**
 * The verbs an attached browser never acts with, whatever the site list:
 * they change his tab or read local files into his accounts. `evaluate` and
 * `storage_seed` are refused at the operations that carry them, not here —
 * they are not verbs of `browser_act`.
 */
export const NEVER_ACTED: readonly PageAction[] = ['resize', 'emulate', 'upload'];

/**
 * The verbs that change nothing and move nothing he is looking at, allowed
 * on any readable site — the read-only slice's allowance, carried forward.
 * `press` is only here for {@link NAVIGATION_KEYS}: a letter press can
 * reach a focused field, so it is an acting verb.
 */
export const ALWAYS_ALLOWED: readonly PageAction[] = ['scroll', 'hover'];

/**
 * The keys `press` may send on any site, spelled as the automation library
 * names them. **One spelling, one list**: the session's view-moving
 * allow-list is built from this very array, so the gate and the performer can
 * never disagree about which keys are movement (a lower-cased spelling the
 * gate accepted and the performer did not is a key that reaches the page
 * unclassified).
 */
export const NAVIGATION_KEYS: readonly string[] = [
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Escape',
];

/**
 * The consequential-step table. A word matches when it is one whole token
 * of the target's accessible name or role — `"Cancel order"` is a cancel,
 * and `"Cancellation policy"` is not one, because the table matches words
 * it was given, not substrings. Which way the near-misses fall is pinned by
 * name in the test, both directions: `"cancel"` **is** consequential, and
 * `"close"` is not, unless it pairs with `"account"` — closing a dialog is
 * ordinary, closing an account is not.
 *
 * One table, extended over time as the plan puts it. When a word is added,
 * its near-miss gets a row beside it.
 */
export const CONSEQUENCE_WORDS: readonly string[] = [
  'pay',
  'buy',
  'order',
  'checkout',
  'transfer',
  'send',
  'submit',
  'delete',
  'remove',
  'cancel',
  'purchase',
  'confirm',
  'place',
  'book',
  'reserve',
  'donate',
  'subscribe',
  'unsubscribe',
  'approve',
  'authorise',
  'authorize',
  'withdraw',
  'sign',
  'publish',
  'post',
  'trash',
  'discard',
  'empty',
  'deactivate',
  'revoke',
  'leave',
  'accept',
  'sell',
  'trade',
  'upgrade',
  'renew',
  'deposit',
  'invest',
  'erase',
  'terminate',
  'bid',
  'redeem',
  'claim',
  'agree',
  'finalise',
  'finalize',
  'settle',
  'wire',
  'commit',
  'refund',
  'dispute',
  'archive',
  'block',
  'report',
  'unfollow',
];

/**
 * Irregular and derived forms the generated inflections do not reach. The
 * table matches **whole tokens**, so a word is only caught in the forms
 * listed: "Paying", "Payment", "Paid" and "Sold" are each a form of a word
 * above, and each is named here or generated by {@link inflections}.
 * Deliberately **not** here: forms that name a different thing —
 * "cancellation" (a policy page), "reorder", "postcode".
 */
const IRREGULAR_FORMS: readonly string[] = [
  'paid',
  'payment',
  'payments',
  'payout',
  'bought',
  'sent',
  'sold',
  'withdrawal',
  'withdrawn',
  'withdrew',
  'deletion',
  'removal',
  'donation',
  'donations',
  'emptied',
];

/**
 * The regular forms of one table word: the word, its plural, and the
 * -ed / -ing forms with and without a doubled final consonant. Over-generating
 * a nonsense form costs nothing (no page names a control with it); missing a
 * real one lets "Deleting" or "Submitted" through the table.
 */
function inflections(word: string): string[] {
  const forms = new Set<string>([word, `${word}s`, `${word}es`]);
  const last = word.slice(-1);
  if (word.endsWith('e')) {
    forms.add(`${word}d`);
    forms.add(`${word.slice(0, -1)}ing`);
  } else {
    forms.add(`${word}ed`);
    forms.add(`${word}ing`);
    forms.add(`${word}${last}ed`);
    forms.add(`${word}${last}ing`);
  }
  return [...forms];
}

const CONSEQUENCE_FORMS: ReadonlySet<string> = new Set([
  ...CONSEQUENCE_WORDS.flatMap(inflections),
  ...IRREGULAR_FORMS,
]);

/**
 * Word pairs that only fire together: the first names the act, the second
 * names the thing it falls on. Both must appear as tokens of the name or
 * role, in any order.
 */
export const CONSEQUENCE_PAIRS: readonly (readonly [string, string])[] = [
  ['close', 'account'],
  ['check', 'out'],
  ['top', 'up'],
  ['mark', 'spam'],
];

/** How long an owner grant stays valid, in seconds. */
export const GRANT_TTL_SECONDS = 120;

/** How far ahead of this clock a grant's stamp may sit before it is not yet a grant. */
export const GRANT_CLOCK_SKEW_SECONDS = 5;

/** The state a control is in, as the session's last snapshot reported it. */
export interface ActTarget {
  /** The accessible name, as the snapshot's text says it. */
  readonly accessibleName?: string;
  /** The ARIA role, or the implicit role the tag implies. */
  readonly role?: string;
  /** The HTML tag, lower case. */
  readonly tag?: string;
  /** The `autocomplete` attribute, verbatim. */
  readonly autocomplete?: string;
  /** The input `type` (or a button's `type`), lower case. */
  readonly inputType?: string;
  /** For `press`: the key the call carries, as the page names it. */
  readonly key?: string;
  /** Whether the control takes typed text (a text input, a textarea, a contenteditable region). */
  readonly editable?: boolean;
  /**
   * Every other name the control answers to: its visible text, `title`,
   * `aria-label`, a button-type input's `value`, the names of its
   * descendants, and the names of the element that sits under its click
   * point. A page decides what it calls a control in several places at
   * once, and the one the snapshot shows is only one of them: the table is
   * asked about **all** of them.
   */
  readonly names?: readonly string[];
  /** The attributes a site names a field by: `name`, `id`, `placeholder`. */
  readonly attrNames?: readonly string[];
  /** The host of the frame the control lives in, when it is not the top document's. */
  readonly frameHost?: string;
  /** For a `<select>`: the options it offers, so the chosen one can be named. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

/**
 * The caller's whole question, in one shape. `focusedControl` is what
 * `press` and `type` act on when the call names no ref — an absent one
 * means the session could not say, and a press is then treated as able to
 * reach anything (a guess that cannot name the control cannot clear it).
 */
export interface GateInput {
  /** The page's host, as the navigation reported it. */
  readonly siteHost: string;
  readonly verb: PageAction;
  readonly target?: ActTarget;
  readonly focusedControl?: ActTarget | null;
  /**
   * What the call carries: the key for `press`, the text for `type`, the
   * option for `select`. The gate reads it for what it **does** (an Enter,
   * a chord, a newline, a consequence word in the option chosen), never for
   * what it spells out into a field.
   */
  readonly value?: string;
  /**
   * `fence` asks only the questions that need no page facts — the verb and
   * the site — and answers `allow` for the rest: the two early doors (the
   * service's decide step and the session's preflight) hold a host and a
   * verb and nothing else, and must not refuse for facts they were never
   * given. The default, `full`, is the question with everything known.
   */
  readonly stage?: 'fence' | 'full';
  /** Whether the page holds a password or card field as the caller last read it. */
  readonly pageHasSecretField: boolean;
  /**
   * The owner grant. The distinction between **absent** (the field is not
   * there at all — the caller never engaged the seam, the agent's path) and
   * **present: false** (the caller engaged it and carried no token — the
   * operator-side retry path came up empty) is what separates the two
   * consequential refusals: `needs_owner` tells an agent to ask the owner;
   * `no_grant` says a retry was attempted without one, and is never an
   * allow.
   */
  readonly grant?: GrantState;
  /**
   * Whether this is the same ref and verb as an act that landed within the
   * last 30 s **and** a navigation has happened since that act. The window
   * itself is the session's to keep; this gate only honours the answer.
   */
  readonly repeatAfterNavigation?: boolean;
  /**
   * The operator's act list (`BROKER_ATTACHED_ACT_SITES`): exact hosts or
   * `*.` wildcards. Empty means acting is off altogether.
   */
  readonly actSites: readonly string[];
}

/**
 * An owner grant as this gate sees it: {@link verifyOwnerGrant}'s verdict,
 * passed in so `decide` stays pure. `absent` is the common case — no token
 * with the call at all.
 */
export type GrantState =
  { readonly present: false } | { readonly present: true; readonly verdict: GrantVerdict };

/** What {@link verifyOwnerGrant} concluded about a token. */
export type GrantVerdict = 'valid' | 'forged' | 'expired' | 'replayed' | 'no_secret';

/** The names a decision can come back with: `allow`, or one of these. */
export type GateRefusal =
  | 'attached.read_only'
  | 'attached.act_site_off_list'
  | 'attached.field_forbidden'
  | 'attached.needs_owner'
  | 'attached.act_repeat'
  | 'attached.grant_invalid'
  | 'attached.no_grant'
  | 'attached.key_unparseable';

export type GateDecision =
  { readonly decision: 'allow' } | { readonly decision: GateRefusal; readonly message: string };

/**
 * The one question the act operation asks before anything touches the
 * browser. A refusal carries the sentence the caller gets; the grant and
 * the secret are never in it.
 */
export function decide(input: GateInput): GateDecision {
  const { verb, siteHost, actSites } = input;

  if (NEVER_ACTED.includes(verb)) {
    return refusal(
      'attached.read_only',
      `The attached browser never acts with "${verb}": it changes the owner's tab or reads from his machine.`,
    );
  }

  // A `press` whose key string this grammar does not know is refused here,
  // before the site fence and before the page — in the full question and in
  // the host-free preflight alike, because both are this function. The
  // performer presses **every** token of a combination it can name, so a
  // string that is not a key is not a step anyone classified, and the honest
  // answer is that it is never pressed at all.
  const key = verb === 'press' ? (input.value ?? input.target?.key) : undefined;
  const parsedKey = key === undefined ? undefined : parseKey(key);
  if (verb === 'press' && key !== undefined && parsedKey === undefined) {
    return refusal(
      'attached.key_unparseable',
      `"${key}" is not a key the broker knows how to press: name zero or more of Shift, Control, Alt, Meta, ControlOrMeta, then one key. Refused before the page.`,
    );
  }

  // The read-safe verbs cross the site fence: they change nothing. The
  // movement-key allowance is decided on the **parsed** key, so a
  // combination cannot ride it on the strength of its first token.
  if (ALWAYS_ALLOWED.includes(verb)) {
    return { decision: 'allow' };
  }
  const navigationPress =
    parsedKey !== undefined &&
    parsedKey.modifiers.length === 0 &&
    NAVIGATION_KEYS.includes(parsedKey.base);
  if (navigationPress) {
    return { decision: 'allow' };
  }

  // Acting proper begins here: empty list means the whole capability is
  // off, which is the sentence read-only already gave; a non-empty list
  // that does not name this site owes the variable to set.
  if (actSites.length === 0) {
    return refusal(
      'attached.read_only',
      `This attached lease is read-only: set BROKER_ATTACHED_ACT_SITES to allow acting anywhere. "${verb}" refused.`,
    );
  }
  if (!siteListed(siteHost, actSites)) {
    return refusal(
      'attached.act_site_off_list',
      `This site is not in BROKER_ATTACHED_ACT_SITES, so "${verb}" is refused here; the site stays readable.`,
    );
  }
  if (input.stage === 'fence') return { decision: 'allow' };

  // The effective control: the named target, else the focused control,
  // else (for press/type) nothing — and "nothing" cannot clear a field.
  const control = input.target ?? input.focusedControl ?? undefined;

  // The fence applies to the frame the control lives in, not only to the
  // top document: a payment widget or a sign-in frame is a different site
  // sitting inside a listed one.
  if (control?.frameHost !== undefined && !siteListed(control.frameHost, actSites)) {
    return refusal(
      'attached.act_site_off_list',
      `This control lives in a frame from a site that is not in BROKER_ATTACHED_ACT_SITES, so "${verb}" is refused; the page stays readable.`,
    );
  }
  if (control?.tag === 'iframe') {
    return refusal(
      'attached.field_forbidden',
      `This "${verb}" lands inside a frame, so it cannot rule out a password or code field there. Ask the owner (browser_sign_in).`,
    );
  }

  const field = fieldKind(control);
  if (field) {
    return refusal(
      'attached.field_forbidden',
      `This control is a ${field} field, and an agent never types into one. Ask the owner to enter it (browser_sign_in).`,
    );
  }
  if (control?.tag === 'input' && control.inputType === undefined) {
    // A real input always has a type; an input reported without one means
    // the read never asked, and a field that was never asked about is a
    // field that has not been cleared.
    return refusal(
      'attached.field_forbidden',
      `This control is an input whose kind could not be read, so it cannot be ruled out as a password or code field. Ask the owner (browser_sign_in).`,
    );
  }
  if (TYPING_VERBS.includes(verb)) {
    const named = fieldKindByName(control);
    if (named) {
      return refusal(
        'attached.field_forbidden',
        `This control is named like a ${named} field, and an agent never types into one. Ask the owner to enter it (browser_sign_in).`,
      );
    }
  }
  if ((verb === 'press' || verb === 'type') && !control) {
    // A press or type that cannot say what it reaches could reach a
    // password field, and a guess cannot clear what it cannot name.
    return refusal(
      'attached.field_forbidden',
      `This "${verb}" cannot say which control it reaches, so it cannot rule out a password or code field. Name a ref.`,
    );
  }

  if (input.repeatAfterNavigation) {
    return refusal(
      'attached.act_repeat',
      'The same action landed on this ref moments ago and the page moved since — check the page first.',
    );
  }

  const grant = input.grant;
  // The inert seam: with no secret configured, a token verifies against
  // nothing, and the call is answered exactly as one without it — never
  // allowed "because there was no way to check". A token that **was**
  // checkable and failed is the other case, and it is refused outright:
  // a caller carrying a bad grant is not a caller carrying none.
  if (grant?.present && grant.verdict !== 'valid' && grant.verdict !== 'no_secret') {
    return refusal(
      'attached.grant_invalid',
      `The owner grant did not verify (${grant.verdict}); the step is refused.`,
    );
  }
  const grantHolds = grant?.present === true && grant.verdict === 'valid';

  const consequential =
    isConsequential(control) ||
    (verb === 'select' && isConsequentialSelection(control, input.value)) ||
    // A key is a step in its own right: Enter submits the form it is
    // typed in, a chord sends or deletes, and a bare letter on a page that
    // is not a text field is a site shortcut. A newline typed into a field
    // is an Enter pressed. None of these name a control, so none of them
    // pass through the control's name.
    (verb === 'press' && parsedKey !== undefined && isConsequentialKey(parsedKey, control)) ||
    // A `type` whose control is not editable text is a shortcut in waiting:
    // the keystrokes will land on whatever holds focus — the page body and
    // its site keys, or a focused field the call never named. A focusable
    // non-text element (a list row with `tabindex`) takes site shortcuts
    // too, so "focusable" is not the test; "editable text" is.
    (verb === 'type' && !isEditableText(control)) ||
    (verb === 'type' && /[\r\n]/.test(input.value ?? '')) ||
    // Any submit while the page holds a password or card field: the field
    // is the tell that this form is signing something or paying something,
    // whatever the button calls itself.
    (input.pageHasSecretField && control?.inputType === 'submit');
  if (consequential) {
    if (grant === undefined) {
      // The agent's path: the seam was never engaged. The ask is the
      // answer — the owner does the step via `browser_sign_in`.
      return refusal(
        'attached.needs_owner',
        'This step is consequential, so the owner does it: call browser_sign_in with what to press.',
      );
    }
    if (!grantHolds) {
      // The retry path engaged the seam and carried nothing usable. That
      // is the operator side, never the agent's: a grant arrives through
      // the caller that holds the secret, not through a re-ask.
      return refusal(
        'attached.no_grant',
        'This consequential step was retried with no owner grant, and none can be verified; it stays with the owner.',
      );
    }
    // The grant is already spent: `verifyOwnerGrant` consumes on `valid`,
    // so a verdict of `valid` here means the registry has the token and no
    // second act — same ref or another — will verify it again. The spend
    // happens at the call's verification, **before** the remaining rules
    // and before the act: a call later refused by the repeat guard, or an
    // act that then fails physically, burns the operator's one-shot token
    // and costs them a re-mint. Spend-then-decide is the chosen direction,
    // not an accident of ordering: a lost grant costs a re-ask, an
    // unspent one costs a second consequential act on one approval (§13o).
  }

  return { decision: 'allow' };
}

/** The verbs that put characters into a control. */
const TYPING_VERBS: readonly PageAction[] = ['type', 'fill', 'fill_form', 'press'];

/**
 * The tuple a grant signs over — the exact question it answers, and the
 * only shape that verifies against it.
 */
export interface GrantTuple {
  readonly leaseKey: string;
  readonly ref: string;
  readonly accessibleName: string;
  readonly urlHost: string;
  readonly issuedAtSeconds: number;
  /**
   * The verb the owner approved. A grant minted for "click Pay" is a grant
   * for a click, not for `type`, `select` or `press` on the same ref.
   */
  readonly verb: string;
  /**
   * {@link grantValueDigest} of the value the call carries (the key, the
   * text, the option) — empty for a verb that carries none. A grant for
   * "type 12" does not verify for "type 1200".
   */
  readonly valueDigest: string;
}

/**
 * The digest of a call's value as the grant binds it: hex SHA-256, or the
 * empty string for no value. The minting side computes the same digest of
 * the value it showed the owner; the value itself never travels in a grant.
 */
export function grantValueDigest(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The opaque wire form: `base64url(HMAC-SHA256(payload, secret))`. */
export type OwnerGrantToken = string;

/**
 * The consume-once registry, keyed by the token itself. It is a small set
 * the **session holds** for the life of one attached lease: a token spent
 * on one act cannot answer for any other, and it is forgotten when the
 * lease ends. The token is an HMAC tag, not the secret and not derivable
 * into anything else, so holding it in a set is safe to keep.
 */
export interface OwnerGrantRegistry {
  /** Takes the token on first sight and says `true`; every later `false`. */
  consume(grant: OwnerGrantToken): boolean;
  readonly size: number;
}

export function createGrantRegistry(): OwnerGrantRegistry {
  const spent = new Set<string>();
  return {
    consume(grant) {
      if (spent.has(grant)) return false;
      spent.add(grant);
      return true;
    },
    get size() {
      return spent.size;
    },
  };
}

/**
 * Checks an owner grant: signature, tuple, expiry, single use — and the
 * inert-seam rule above all of them: **with no secret configured, nothing
 * ever verifies.** An unset or empty secret is not a wildcard that accepts
 * every grant; a grant-bearing call in that state is refused exactly as one
 * without it (`no_grant`), never allowed because the broker "has no way to
 * check". The secret arrives as an input: this function reads no
 * environment, so it cannot be run against a configuration it was not
 * handed.
 *
 * `forged` covers every signature failure at once — a bad signature over
 * the presented tuple, a decoded length that is not a SHA-256 tag, **and**
 * any component mismatch (wrong ref, wrong host, wrong lease, wrong name):
 * the token is an opaque signature over one exact tuple, so retargeting any
 * component of the tuple invalidates it. There is no per-component verdict
 * to leak, and the comparison is constant-time.
 */
export function verifyOwnerGrant(
  grant: OwnerGrantToken,
  secret: string | undefined,
  tuple: GrantTuple,
  nowSeconds: number,
  registry: OwnerGrantRegistry,
): GrantVerdict {
  if (!secret) return 'no_secret';

  const presented = Buffer.from(grant, 'base64url');
  if (presented.length !== 32) return 'forged';

  const expected = createHmac('sha256', secret).update(grantPayload(tuple)).digest();
  if (!timingSafeEqual(presented, expected)) return 'forged';

  // One-sided on purpose: a grant is valid from a few seconds of clock skew
  // before its stamp to its life after it — never up to a life *ahead* of it,
  // which would stretch a 120 s grant into a 240 s one.
  const age = nowSeconds - tuple.issuedAtSeconds;
  if (age > GRANT_TTL_SECONDS || age < -GRANT_CLOCK_SKEW_SECONDS) return 'expired';

  if (!registry.consume(grant)) return 'replayed';
  return 'valid';
}

/**
 * The payload the HMAC covers: the tuple fields joined by `|`, each with
 * backslash and pipe escaped so a crafted accessible name — an HTML page
 * can put any text in one, pipes included — cannot make two different
 * tuples hash to the same payload.
 */
function grantPayload(tuple: GrantTuple): string {
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  return [
    esc(tuple.leaseKey),
    esc(tuple.ref),
    esc(tuple.accessibleName),
    esc(tuple.urlHost),
    String(tuple.issuedAtSeconds),
    esc(tuple.verb),
    esc(tuple.valueDigest),
  ].join('|');
}

function refusal(decision: GateRefusal, message: string): GateDecision {
  return { decision, message };
}

/**
 * Site list, env-list style: blank entries ignored, exact host or `*.`
 * prefix, compared lower-case. A wildcard covers subdomains and **not** the
 * apex — `*.example.com` says nothing about `example.com`, which has to be
 * listed itself. No suffix, no path, no port games: hosts as navigations
 * report them.
 */
function siteListed(siteHost: string, actSites: readonly string[]): boolean {
  const host = siteHost.toLowerCase();
  for (const entry of actSites) {
    const e = entry.trim().toLowerCase();
    if (e === '') continue;
    if (e.startsWith('*.')) {
      if (host.endsWith(`.${e.slice(2)}`) && host !== e.slice(2)) return true;
    } else if (host === e) {
      return true;
    }
  }
  return false;
}

/** The forbidden field kinds, as the refusal names them. */
type FieldKind = 'password' | 'one-time-code' | 'card';

/**
 * A control's dangerous kind, found by input type, `autocomplete` and
 * role — the three attributes §3.5 names. `autocomplete` is the strongest
 * tell (it is the site declaring the field's purpose) and the input type
 * catches the sites that get the role wrong; role catches the sites that
 * fake the type.
 */
function fieldKind(control: ActTarget | undefined): FieldKind | undefined {
  if (!control) return undefined;
  if (control.inputType === 'password') return 'password';
  // `autocomplete` values are space-separated, and their hyphens are part
  // of the keyword: `one-time-code` is one token, and splitting it apart
  // would miss the very field the rule exists for.
  for (const token of (control.autocomplete ?? '').toLowerCase().split(/\s+/)) {
    if (token === 'password' || token === 'current-password' || token === 'new-password') {
      return 'password';
    }
    if (token === 'one-time-code') return 'one-time-code';
    if (
      token === 'cc-number' ||
      token === 'cc-exp' ||
      token === 'cc-exp-month' ||
      token === 'cc-exp-year' ||
      token === 'cc-csc'
    ) {
      return 'card';
    }
  }
  // The role adds no kind of its own: ARIA has no password or card role, so
  // the kind comes from the input type, the site's own `autocomplete`, or —
  // for the verbs that put characters in — the name ({@link fieldKindByName}).
  return undefined;
}

/**
 * The fields a site does not declare. A show-password toggle turns the box
 * into `type=text`, split one-time-code boxes carry `inputmode` and no
 * `autocomplete`, and card fields named "Card number" or "CVV" are
 * commonly `autocomplete=off` — so the kind is also read from what the
 * field is called. **Over-firing here costs a refusal; under-firing is the
 * leak**, which is the direction the whole field rule leans. Applied to the
 * verbs that type, never to a click (a "Forgot password?" link is a link).
 */
function fieldKindByName(control: ActTarget | undefined): FieldKind | undefined {
  if (!control) return undefined;
  const strings = [control.accessibleName, ...(control.attrNames ?? [])];
  const squashed = strings.map((s) => tokens(s).join(''));
  const words = new Set(strings.flatMap(tokens));
  if (squashed.some((s) => SECRET_NAME_PASSWORD.some((part) => s.includes(part)))) {
    return 'password';
  }
  if (squashed.some((s) => SECRET_NAME_CARD.some((part) => s.includes(part)))) return 'card';
  for (const word of SECRET_NAME_WORDS) {
    if (words.has(word)) return PASSWORD_WORDS.includes(word) ? 'password' : 'one-time-code';
  }
  // Pairs of whole words that name a secret jointly but not singly: a
  // single "Security" heading is ordinary, a single "Answer" is ordinary,
  // the two together name the thing a bank signs in with.
  for (const [a, b] of SECRET_NAME_WORD_PAIRS) {
    if (words.has(a) && words.has(b)) return 'password';
  }
  return undefined;
}

// Matched inside the squashed name ("Card number" → `cardnumber`), so the
// separator a site uses makes no difference.
const SECRET_NAME_PASSWORD: readonly string[] = [
  'password',
  'passwd',
  'passcode',
  'passphrase',
  'memorable',
];
const SECRET_NAME_CARD: readonly string[] = [
  'cardnumber',
  'ccnumber',
  'ccnum',
  'creditcard',
  'cvv',
  'cvc',
  'securitycode',
  'cardexpir',
  'expirydate',
  'expirationdate',
];
// Matched as whole words, because they are short enough to sit inside
// ordinary ones.
const SECRET_NAME_WORDS: readonly string[] = ['pin', 'pwd', 'otp', 'csc', 'mfa', '2fa', 'secret'];

/** Of the whole words, the ones that name a secret to type, not a code sent to someone. */
const PASSWORD_WORDS: readonly string[] = ['pin', 'pwd', 'secret'];

/** Whole-word pairs that name a secret only together (words has each). */
const SECRET_NAME_WORD_PAIRS: readonly (readonly [string, string])[] = [['security', 'answer']];

/** Whether free text names a consequence — the table over a bare string (a dialog's message, an option's label). */
export function isConsequentialText(text: string | undefined): boolean {
  return namesConsequence(tokens(text));
}

function namesConsequence(words: readonly string[]): boolean {
  const seen = new Set(words);
  for (const word of words) {
    if (CONSEQUENCE_FORMS.has(word)) return true;
  }
  for (const [a, b] of CONSEQUENCE_PAIRS) {
    if (seen.has(a) && seen.has(b)) return true;
  }
  return false;
}

function isConsequential(control: ActTarget | undefined): boolean {
  if (!control) return false;
  return namesConsequence([
    ...tokens(control.accessibleName),
    ...tokens(control.role),
    ...(control.names ?? []).flatMap(tokens),
  ]);
}

/** `select` names its consequence in the **option chosen**, not only in the control. */
function isConsequentialSelection(
  control: ActTarget | undefined,
  value: string | undefined,
): boolean {
  if (value === undefined) return false;
  if (isConsequentialText(value)) return true;
  const chosen = control?.options?.filter((o) => o.value === value || o.label === value) ?? [];
  return chosen.some((o) => isConsequentialText(o.label) || isConsequentialText(o.value));
}

/**
 * The grammar of a key the performer can press: zero or more modifier
 * names, then exactly one base key, joined by `+`. The base key is one
 * printable character or a name from one fixed list — the names the
 * automation library itself uses for keys.
 *
 * The grammar is deliberately **stricter than the library**. The library
 * holds down *every* token of a combination it can name, not only the
 * modifiers, so `"Enter+Tab"` and `"Tab+Enter"` both press Enter, and the
 * library's own aliases for Enter are the characters `\n` and `\r` — a bare
 * carriage return really does submit the form it sits in. A string this
 * grammar rejects is refused at the gate and never reaches the page; a
 * string it accepts is then classified by the rules below. The aliases a
 * caller most often reaches for (`ctrl`, `cmd`, `command`, `option`,
 * `super`) are **not** key names the library knows — it errors on them —
 * so the grammar does not accept them either: a key the performer cannot
 * press is not a key worth clearing.
 */
export interface ParsedKey {
  /** The modifier names, in this file's spelling, in the order given. */
  readonly modifiers: readonly string[];
  /** The base key, as the classification rules below read it. */
  readonly base: string;
}

/** The modifier names the grammar admits, in the library's own spellings. */
const KEY_MODIFIERS: readonly string[] = ['Shift', 'Control', 'Alt', 'Meta', 'ControlOrMeta'];

/** Of those, the ones that make the combination a chord the owner takes. */
const CHORD_MODIFIERS: readonly string[] = ['Control', 'Alt', 'Meta', 'ControlOrMeta'];

/** The base keys this grammar can name by word, in the library's spellings. */
const BASE_KEY_NAMES: readonly string[] = [
  'Enter',
  'NumpadEnter',
  'Tab',
  'Space',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
];

/** The canonical spelling of a base key, or `undefined` if it is not one. */
function canonicalBase(token: string): string | undefined {
  if (token.length === 1) {
    // The line terminators are the library's aliases for Enter — a
    // `Shift+\r` really does press Enter — but they are not spellings a
    // caller may use: the grammar refuses them, before the page.
    if (token === '\n' || token === '\r' || token === '\t') return undefined;
    return token;
  }
  if (token === '+') return '+';
  return BASE_KEY_NAMES.includes(token) ? token : undefined;
}

/**
 * Parse the key string a `press` carries, or `undefined` when it is not a
 * key. The split follows the library's own: a `+` separates only **after a
 * non-empty token**, so the plus key spells `"+"`, `"Control++"` is the
 * plus with Control held, and a trailing `+` is a dangling empty segment —
 * not a key. Modifier names are matched case-insensitively (a wrong case
 * is a library error at the performer, never a key that slips through
 * unclassified); base names are matched exactly, so there stays **one
 * spelling, one list** between this gate and the performer's allow-list.
 */
export function parseKey(value: string): ParsedKey | undefined {
  const tokens: string[] = [];
  let building = '';
  for (const char of value) {
    if (char === '+' && building !== '') {
      tokens.push(building);
      building = '';
    } else {
      building += char;
    }
  }
  tokens.push(building);
  const base = canonicalBase(tokens[tokens.length - 1] as string);
  if (base === undefined) return undefined;
  const modifiers: string[] = [];
  for (const token of tokens.slice(0, -1)) {
    const modifier = KEY_MODIFIERS.find((m) => m.toLowerCase() === token.toLowerCase());
    if (modifier === undefined) return undefined;
    modifiers.push(modifier);
  }
  return { modifiers, base };
}

/**
 * Whether pressing this parsed key is a step the owner takes. Three
 * families, none of which name a control: Enter (submits the form it is
 * typed in, sends a compose box), a Control/Alt/Meta chord (send, delete,
 * archive in most web apps), and any key at a control that is not a text
 * field — a bare letter on a page's body is a site shortcut (`#` deletes,
 * `e` archives). Space presses a focused button. Movement keys never reach
 * here (they cross the fence earlier); Tab moves focus and changes nothing.
 */
function isConsequentialKey(parsed: ParsedKey, control: ActTarget | undefined): boolean {
  if (parsed.modifiers.some((m) => CHORD_MODIFIERS.includes(m))) return true;
  if (parsed.base === 'Enter' || parsed.base === 'NumpadEnter') return true;
  if (parsed.base === 'Tab') return false;
  if ((parsed.base === 'Space' || parsed.base === ' ') && isPressable(control)) return true;
  return !isEditableText(control);
}

const TEXT_INPUT_TYPES: readonly string[] = ['', 'text', 'search', 'email', 'url', 'tel', 'number'];

function isEditableText(control: ActTarget | undefined): boolean {
  if (!control) return false;
  if (control.editable === true) return true;
  if (control.tag === 'textarea') return true;
  if (control.tag === 'input') return TEXT_INPUT_TYPES.includes(control.inputType ?? '');
  return control.role === 'textbox' || control.role === 'searchbox';
}

const PRESSABLE_INPUT_TYPES: readonly string[] = ['submit', 'button', 'reset', 'image'];
const PRESSABLE_ROLES: readonly string[] = ['button', 'link', 'menuitem', 'tab', 'option'];

function isPressable(control: ActTarget | undefined): boolean {
  if (!control) return false;
  if (control.tag === 'button' || control.tag === 'a' || control.tag === 'summary') return true;
  if (control.tag === 'input' && PRESSABLE_INPUT_TYPES.includes(control.inputType ?? '')) {
    return true;
  }
  return control.role !== undefined && PRESSABLE_ROLES.includes(control.role);
}

// Invisible to a page's reader and to a word table: **every** format
// character (Unicode's `Cf` — zero-width joins and separators, the soft
// hyphen, the bidi embeddings *and* isolates, the invisible operators, the
// tag characters), plus the fillers that are classed as letters or symbols
// but draw nothing: the Hangul fillers and the blank braille cell. Stripped
// **before** tokenizing, so an invisible character inside a word is one word
// to the table and not two.
const INVISIBLE_CHARS = /[\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]/gu;

/**
 * Lower-case word tokens. The page does not get a vote on its own
 * typography: zero-width and bidi-control characters are stripped, letters
 * and numbers of **any** script form a run (a CJK label stays one token,
 * so the shape a CJK word in the table needs is already there), and each
 * run is then Unicode-normalized — compatibility forms folded, combining
 * marks dropped — and lower-cased. Fullwidth `Pay` and `Päy` are "pay" to
 * the table; they were only hiding in their own typography before.
 *
 * What is **not** folded is said plainly, because the site fence is the
 * first line and this table the second: the fold is Unicode's, not ours.
 * A Cyrillic `а` that *looks* like `a` is a different letter to every
 * normalizer, and the table speaks Latin — a consequence word written in a
 * non-Latin script's look-alikes is a documented residual (§13o), not a
 * case this half of the fence catches.
 */
function tokens(s: string | undefined): string[] {
  if (!s) return [];
  const runs = s.replace(INVISIBLE_CHARS, '').match(/[\p{L}\p{N}\p{M}]+/gu);
  if (runs === null) return [];
  return runs
    .map((run) =>
      run
        .normalize('NFKD')
        .replace(/\p{Mn}/gu, '')
        .toLowerCase(),
    )
    .filter((run) => run !== '');
}
