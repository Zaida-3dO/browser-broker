import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  ALWAYS_ALLOWED,
  CONSEQUENCE_PAIRS,
  CONSEQUENCE_WORDS,
  GRANT_CLOCK_SKEW_SECONDS,
  GRANT_TTL_SECONDS,
  NAVIGATION_KEYS,
  NEVER_ACTED,
  createGrantRegistry,
  decide,
  grantValueDigest,
  isConsequentialText,
  parseKey,
  verifyOwnerGrant,
  type ActTarget,
  type GrantTuple,
  type GrantVerdict,
  type PageAction,
} from '../../src/attach/gate.ts';
import { PAGE_ACTIONS } from '../../src/browser/driver.ts';

/**
 * The safety gate as one table (the plan's §6 shape, plus the grant rows).
 *
 * `decide` is pure, so the codebase's rejection rule — a refusal must prove
 * the browser was never asked — lands here as its strongest form: the gate
 * has **no** seam through which a browser could be asked, and the tripwire
 * below pins that every row stays that way. A refusal row asserts the name
 * it refused with, and the shared assertion at the end asserts no row ever
 * produced a call object of any kind.
 */

// The codebase rule — a refusal must prove the browser was never asked —
// holds here by construction: `decide` takes no callback, returns only a
// decision and a sentence, and does no I/O. The structural test at the end
// of this file pins exactly that, so the refusal rows below mean "the
// extension was never asked" in the strongest available form: there is no
// seam through which it could have been.

// ── Fixtures: placeholder everything ───────────────────────────────────
// The "secret" is a fixture key, not anybody's configuration; hosts are
// example.com and its friends.
const SECRET = 'test-owner-grant-secret';
const LEASE = 'lease-k1';
const ISSUED = 1_700_000_000;
// One exact host and one wildcarded domain, so the wildcard rows below can
// tell apex, subdomain and lookalike apart without any fixture doubling up.
const SITES = ['example.com', '*.news.example.org'] as const;

const BENIGN: ActTarget = { accessibleName: 'Search', role: 'button', tag: 'button' };
// A plain text box: where a letter may be typed and a key may be pressed.
const TEXT_BOX: ActTarget = {
  accessibleName: 'Notes',
  role: 'textbox',
  tag: 'input',
  inputType: 'text',
  editable: true,
};

/**
 * Mirrors the wire format `gate.ts` documents — `base64url(HMAC-SHA256)`
 * over the escaped `|`-joined tuple. The duplication is deliberate: the
 * valid-signature row is the cross-check that the two agree, the way the
 * session tests treat `src/attach/README.md`.
 */
function signGrant(tuple: GrantTuple, secret: string): string {
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  const payload = [
    esc(tuple.leaseKey),
    esc(tuple.ref),
    esc(tuple.accessibleName),
    esc(tuple.urlHost),
    String(tuple.issuedAtSeconds),
    esc(tuple.verb),
    esc(tuple.valueDigest),
  ].join('|');
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

// ── The decide table ───────────────────────────────────────────────────

interface Row {
  readonly name: string;
  readonly verb: PageAction;
  readonly host?: string;
  readonly sites?: readonly string[];
  readonly target?: ActTarget;
  readonly focus?: ActTarget | null;
  /** The key (press), text (type) or option (select) the call carries. */
  readonly value?: string;
  readonly pageSecret?: boolean;
  readonly grant?: { present: false } | { present: true; verdict: GrantVerdict };
  readonly repeat?: boolean;
  /** The decision name the row expects, including `'allow'`. */
  readonly expect: string;
  /** A phrase the refusal sentence must carry. */
  readonly message?: string;
}

const ACTING: readonly PageAction[] = [
  'click',
  'type',
  'fill',
  'press',
  'select',
  'check',
  'dialog',
  'fill_form',
  'drag',
];

const rows: Row[] = [
  // ── every verb × site-on / site-off ──────────────────────────────────
  ...ACTING.map((verb): Row => ({
    name: `${verb} on a listed site`,
    verb,
    target: verb === 'press' || verb === 'type' ? TEXT_BOX : BENIGN,
    value: verb === 'press' ? 'a' : undefined,
    expect: 'allow',
  })),
  ...['resize', 'emulate', 'upload'].map((verb): Row => ({
    name: `${verb} even on a listed site`,
    verb: verb as PageAction,
    target: BENIGN,
    expect: 'attached.read_only',
  })),
  ...['scroll', 'hover'].map((verb): Row => ({
    name: `${verb} on a site nowhere on the list`,
    verb: verb as PageAction,
    host: 'example.org',
    target: BENIGN,
    expect: 'allow',
  })),
  {
    name: 'a press of a navigation key off the list (the read-only slice allowance, carried)',
    verb: 'press',
    host: 'example.org',
    target: BENIGN,
    value: 'PageUp',
    expect: 'allow',
  },
  ...ACTING.map((verb): Row => ({
    name: `${verb} on a site off the list`,
    verb,
    host: 'example.org',
    target: verb === 'press' || verb === 'type' ? TEXT_BOX : BENIGN,
    value: verb === 'press' ? 'a' : undefined,
    expect: 'attached.act_site_off_list',
    message: 'BROKER_ATTACHED_ACT_SITES',
  })),
  ...ACTING.map((verb): Row => ({
    name: `${verb} with the act list empty (read-only as before)`,
    verb,
    sites: [],
    target: verb === 'press' || verb === 'type' ? TEXT_BOX : BENIGN,
    value: verb === 'press' ? 'a' : undefined,
    expect: 'attached.read_only',
    message: 'BROKER_ATTACHED_ACT_SITES',
  })),

  // ── the site list itself ─────────────────────────────────────────────
  {
    name: 'a subdomain covered by a wildcard',
    verb: 'click',
    host: 'www.news.example.org',
    target: BENIGN,
    expect: 'allow',
  },
  {
    name: 'the apex of a wildcarded domain (the wildcard covers subdomains only)',
    verb: 'click',
    host: 'news.example.org',
    target: BENIGN,
    expect: 'attached.act_site_off_list',
  },
  {
    name: 'a lookalike suffix is not a subdomain',
    verb: 'click',
    host: 'notnews.example.org',
    target: BENIGN,
    expect: 'attached.act_site_off_list',
  },
  {
    name: 'host case does not matter',
    verb: 'click',
    host: 'Example.COM',
    target: BENIGN,
    expect: 'allow',
  },

  // ── field kinds: refused even on a listed site ───────────────────────
  {
    name: 'type into an input whose type is password',
    verb: 'type',
    target: { role: 'textbox', tag: 'input', inputType: 'password' },
    expect: 'attached.field_forbidden',
    message: 'password',
  },
  {
    name: 'type into an input with autocomplete current-password',
    verb: 'type',
    target: { role: 'textbox', tag: 'input', inputType: 'text', autocomplete: 'current-password' },
    expect: 'attached.field_forbidden',
    message: 'password',
  },
  {
    name: 'type into an input with autocomplete new-password',
    verb: 'type',
    target: { tag: 'input', inputType: 'text', autocomplete: 'new-password' },
    expect: 'attached.field_forbidden',
    message: 'password',
  },
  {
    name: 'type a one-time code into a tel field (autocomplete is the tell, not the type)',
    verb: 'type',
    target: { role: 'textbox', tag: 'input', inputType: 'tel', autocomplete: 'one-time-code' },
    expect: 'attached.field_forbidden',
    message: 'one-time-code',
  },
  ...['cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc'].map((ac): Row => ({
    name: `fill a card field (autocomplete ${ac})`,
    verb: 'fill',
    target: { role: 'textbox', tag: 'input', inputType: 'text', autocomplete: ac },
    expect: 'attached.field_forbidden',
    message: 'card',
  })),
  {
    name: 'a press that reaches a focused password field',
    verb: 'press',
    value: 'h',
    target: undefined,
    focus: { role: 'textbox', tag: 'input', inputType: 'password' },
    expect: 'attached.field_forbidden',
    message: 'password',
  },
  {
    name: 'a press that cannot say what it reaches could reach a password field',
    verb: 'press',
    value: 'h',
    target: undefined,
    focus: null,
    expect: 'attached.field_forbidden',
  },
  {
    name: 'a navigation press needs no ref and reaches no field',
    verb: 'press',
    value: 'Escape',
    expect: 'allow',
  },
  {
    // The grammar answers first, whatever the list says: a wrong-case
    // spelling is not a key at all, and the honest sentence is the
    // grammar's — the same key would be refused even on a listed site.
    name: 'a lower-cased movement key is refused as not a key, even with the act list empty',
    verb: 'press',
    sites: [],
    value: 'arrowdown',
    target: undefined,
    expect: 'attached.key_unparseable',
  },
  {
    name: 'every movement key the performer allows is one the gate allows, off the list too',
    verb: 'press',
    host: 'example.org',
    value: 'ArrowDown',
    expect: 'allow',
  },
  // B1 — the focused-control read hands the gate real facts. A focused
  // field that arrives without them is refused, not read as plain text.
  {
    name: 'a press whose focused input arrives with no type read is not cleared',
    verb: 'press',
    value: 'h',
    target: undefined,
    focus: { tag: 'input', accessibleName: 'Password' },
    expect: 'attached.field_forbidden',
    message: 'could not be read',
  },
  {
    name: 'a press that reaches a focused one-time-code box (autocomplete is the tell)',
    verb: 'press',
    value: '1',
    target: undefined,
    focus: { tag: 'input', inputType: 'text', autocomplete: 'one-time-code' },
    expect: 'attached.field_forbidden',
    message: 'one-time-code',
  },
  {
    name: 'a press that reaches a focused card box (autocomplete cc-number)',
    verb: 'press',
    value: '4',
    target: undefined,
    focus: { tag: 'input', inputType: 'text', autocomplete: 'billing cc-number' },
    expect: 'attached.field_forbidden',
    message: 'card',
  },

  // B2 — a key is a step. None of these name a button, and each is
  // consequential on its own.
  {
    name: 'Enter in a text input submits its form',
    verb: 'press',
    target: TEXT_BOX,
    value: 'Enter',
    expect: 'attached.needs_owner',
  },
  {
    name: 'NumpadEnter is Enter',
    verb: 'press',
    target: TEXT_BOX,
    value: 'NumpadEnter',
    expect: 'attached.needs_owner',
  },
  {
    name: 'Enter in an amount box with a harmless name still asks the owner',
    verb: 'press',
    target: { ...TEXT_BOX, accessibleName: 'Amount' },
    value: 'Enter',
    expect: 'attached.needs_owner',
  },
  {
    name: 'Control+Enter in a contenteditable compose box sends it',
    verb: 'press',
    target: { accessibleName: 'Message body', tag: 'div', role: 'textbox', editable: true },
    value: 'Control+Enter',
    expect: 'attached.needs_owner',
  },
  {
    name: 'Meta+Enter is the same chord on another platform',
    verb: 'press',
    target: TEXT_BOX,
    value: 'Meta+Enter',
    expect: 'attached.needs_owner',
  },
  {
    name: 'any Control chord is a step, even a harmless-looking one',
    verb: 'press',
    target: TEXT_BOX,
    value: 'Control+a',
    expect: 'attached.needs_owner',
  },
  {
    name: 'a bare "#" with the page body focused is a site shortcut (delete)',
    verb: 'press',
    target: undefined,
    focus: { tag: 'body' },
    value: '#',
    expect: 'attached.needs_owner',
  },
  {
    name: 'Shift+3 on the body is the same shortcut spelled with a modifier',
    verb: 'press',
    target: undefined,
    focus: { tag: 'body' },
    value: 'Shift+3',
    expect: 'attached.needs_owner',
  },
  {
    name: 'a single letter with a button focused is a shortcut, not typing',
    verb: 'press',
    target: BENIGN,
    value: 'e',
    expect: 'attached.needs_owner',
  },
  {
    name: 'a letter typed in a text box is typing',
    verb: 'press',
    target: TEXT_BOX,
    value: 'e',
    expect: 'allow',
  },
  {
    name: 'a letter in a textarea is typing',
    verb: 'press',
    target: { tag: 'textarea', role: 'textbox' },
    value: 'e',
    expect: 'allow',
  },
  {
    name: 'Tab moves focus and changes nothing',
    verb: 'press',
    target: undefined,
    focus: { tag: 'body' },
    value: 'Tab',
    expect: 'allow',
  },
  {
    name: 'Space on a focused button presses it',
    verb: 'press',
    target: BENIGN,
    value: 'Space',
    expect: 'attached.needs_owner',
  },
  {
    name: 'Space in a text box is a space',
    verb: 'press',
    target: TEXT_BOX,
    value: ' ',
    expect: 'allow',
  },
  {
    name: 'Enter in a text box with a valid grant goes through (the grant is the route)',
    verb: 'press',
    target: TEXT_BOX,
    value: 'Enter',
    grant: { present: true, verdict: 'valid' },
    expect: 'allow',
  },
  {
    name: 'Enter in a password box is the field rule first, never a grantable step',
    verb: 'press',
    target: { tag: 'input', inputType: 'password' },
    value: 'Enter',
    grant: { present: true, verdict: 'valid' },
    expect: 'attached.field_forbidden',
  },
  {
    name: 'a type whose text carries a newline presses Enter',
    verb: 'type',
    target: TEXT_BOX,
    value: 'hello\nworld',
    expect: 'attached.needs_owner',
  },
  {
    name: 'a type whose text carries a carriage return presses Enter',
    verb: 'type',
    target: TEXT_BOX,
    value: 'hello\rworld',
    expect: 'attached.needs_owner',
  },
  {
    name: 'a type of plain text is plain typing',
    verb: 'type',
    target: TEXT_BOX,
    value: 'hello world',
    expect: 'allow',
  },
  // A `type` at something that is not editable text is a shortcut in
  // waiting: the keys land wherever focus sits. The gate asks the owner;
  // the performer proves the control takes focus (real-browser rows in the
  // reader suite hold the other half).
  {
    name: 'a type at a paragraph cannot land on it — its keys land on whatever holds focus',
    verb: 'type',
    target: { tag: 'p', accessibleName: 'Welcome back', names: ['Welcome back'] },
    value: 'hunter2',
    expect: 'attached.needs_owner',
  },
  {
    name: 'a type at a focusable list row (tabindex) is a site shortcut waiting, not typing',
    verb: 'type',
    target: { tag: 'div', role: 'listitem', accessibleName: 'Message from A' },
    value: '#e',
    expect: 'attached.needs_owner',
  },
  {
    name: 'a type into a contenteditable region is typing',
    verb: 'type',
    target: { tag: 'div', role: 'textbox', editable: true },
    value: 'plain words',
    expect: 'allow',
  },
  {
    name: 'a fill with a newline sets a value and presses nothing',
    verb: 'fill',
    target: { tag: 'textarea', role: 'textbox' },
    value: 'two\nlines',
    expect: 'allow',
  },

  // The key string itself. The performer presses **every** token of a
  // combination it can name, and its own aliases for Enter are the bare
  // characters `\n` and `\r`; each value below really does submit a form it
  // is typed into (probed against real Chromium). So they are refused as
  // **not keys at all**, before the site fence and before the page — not
  // merely classified as steps that a grant could wave through.
  ...(
    [
      ['Enter+Tab', 'Enter+Tab'],
      ['Enter+a', 'Enter+a'],
      ['\n', 'a bare newline'],
      ['\r', 'a bare carriage return'],
      ['Shift+\r', 'Shift over a carriage return'],
      ['Tab+Enter', 'Tab+Enter'],
      ['ctrl+a', 'the ctrl alias'],
      ['ArrowDown+Enter', 'ArrowDown+Enter'],
      ['Shift+', 'Shift, then a dangling plus'],
    ] as const
  ).map(([key, label]): Row => ({
    name: `a press of "${label}" is refused as not a key`,
    verb: 'press',
    target: TEXT_BOX,
    value: key,
    expect: 'attached.key_unparseable',
    message: 'is not a key',
  })),
  {
    name: 'the grammar refusal reaches a text input inside a form just the same',
    verb: 'press',
    target: { ...TEXT_BOX, names: ['Sign in form'] },
    value: 'Enter+Tab',
    pageSecret: true,
    expect: 'attached.key_unparseable',
  },
  {
    name: 'no owner grant answers for a string that is not a key',
    verb: 'press',
    target: TEXT_BOX,
    value: 'Enter+a',
    grant: { present: true, verdict: 'valid' },
    expect: 'attached.key_unparseable',
  },
  {
    name: 'the grammar refusal stands even on a site nowhere on the list',
    verb: 'press',
    host: 'example.org',
    target: TEXT_BOX,
    value: '\r',
    expect: 'attached.key_unparseable',
  },
  // What the grammar keeps: valid spellings classify as before.
  {
    name: 'Shift+A is a shifted letter, classified as before',
    verb: 'press',
    target: TEXT_BOX,
    value: 'Shift+A',
    expect: 'allow',
  },
  {
    name: 'Shift+Tab is still just a focus move',
    verb: 'press',
    target: TEXT_BOX,
    value: 'Shift+Tab',
    expect: 'allow',
  },
  {
    name: 'Shift+ArrowUp is a movement key with a modifier, not a free pass off the list',
    verb: 'press',
    host: 'example.org',
    target: TEXT_BOX,
    value: 'Shift+ArrowUp',
    expect: 'attached.act_site_off_list',
  },
  {
    name: 'a username field is not a password field',
    verb: 'type',
    target: { role: 'textbox', tag: 'input', inputType: 'text', autocomplete: 'username' },
    expect: 'allow',
  },
  {
    name: 'a search field is not a code field',
    verb: 'type',
    target: { role: 'searchbox', tag: 'input', inputType: 'search', autocomplete: 'search' },
    expect: 'allow',
  },

  // M6 — a site does not always declare its secret fields. The kind is read
  // from the name too, for the verbs that type; a click on the same label
  // is just a click.
  ...[
    ['Card number', 'card'],
    ['CVV', 'card'],
    ['Security code', 'card'],
    ['Expiry date', 'card'],
    ['Password', 'password'],
    ['Confirm password', 'password'],
    ['PIN', 'password'],
    ['OTP', 'one-time-code'],
    // The names sign-in pages use when they do not say "password".
    ['Passphrase', 'password'],
    ['Memorable word', 'password'],
    ['Memorable information', 'password'],
    ['Security answer', 'password'],
    ['Secret', 'password'],
  ].map(([name, kind]): Row => ({
    name: `type into a field named "${name}" with no autocomplete`,
    verb: 'type',
    target: { accessibleName: name as string, tag: 'input', inputType: 'text', editable: true },
    expect: 'attached.field_forbidden',
    message: kind,
  })),
  ...[
    ['type', 'cc-number'],
    ['fill', 'user_password'],
    ['fill_form', 'otp-1'],
    ['press', 'cvc'],
    ['type', 'user_secret'],
    ['type', 'security_answer'],
  ].map(([verb, attr]): Row => ({
    name: `${verb} into a field whose name attribute is "${attr}"`,
    verb: verb as PageAction,
    target: { tag: 'input', inputType: 'text', editable: true, attrNames: [attr as string] },
    value: verb === 'press' ? 'a' : undefined,
    expect: 'attached.field_forbidden',
  })),
  {
    name: 'a click on "Forgot password?" is a link, not a field',
    verb: 'click',
    target: { accessibleName: 'Forgot password?', role: 'link', tag: 'a' },
    expect: 'allow',
  },
  {
    name: 'a search box named "Pinterest" is not a PIN box (whole words only)',
    verb: 'type',
    target: { accessibleName: 'Pinterest', tag: 'input', inputType: 'search', editable: true },
    expect: 'allow',
  },
  {
    name: 'a "Secretary name" box is not a secret box (whole words only)',
    verb: 'type',
    target: { accessibleName: 'Secretary name', tag: 'input', inputType: 'text', editable: true },
    expect: 'allow',
  },
  {
    name: 'a "Security centre" heading is not a security-answer box (the pair needs both words)',
    verb: 'type',
    target: { accessibleName: 'Security centre', tag: 'input', inputType: 'text', editable: true },
    expect: 'allow',
  },
  {
    name: 'an "Answer" box alone does not name the pair either',
    verb: 'type',
    target: { accessibleName: 'Answer', tag: 'input', inputType: 'text', editable: true },
    expect: 'allow',
  },

  // ── the consequential table ───────────────────────────────────────────
  ...CONSEQUENCE_WORDS.map((word): Row => ({
    name: `a click named "${word}"`,
    verb: 'click',
    target: {
      accessibleName: word.charAt(0).toUpperCase() + word.slice(1),
      role: 'button',
      tag: 'button',
    },
    expect: 'attached.needs_owner',
  })),
  {
    name: 'a click named "Cancel order" — cancel of something is still a cancel',
    verb: 'click',
    target: { accessibleName: 'Cancel order', role: 'button' },
    expect: 'attached.needs_owner',
  },
  {
    name: 'a click named "Cancellation policy" is not a cancel (word, not substring)',
    verb: 'click',
    target: { accessibleName: 'Cancellation policy', role: 'link' },
    expect: 'allow',
  },
  {
    name: 'a click named "Close account" is consequential (the pair)',
    verb: 'click',
    target: { accessibleName: 'Close account', role: 'button' },
    expect: 'attached.needs_owner',
  },
  {
    name: 'a click named "Close" alone is closing a dialog, not an account',
    verb: 'click',
    target: { accessibleName: 'Close', role: 'button' },
    expect: 'allow',
  },
  {
    name: '"Reorder" is one word and is not the word "order"',
    verb: 'click',
    target: { accessibleName: 'Reorder', role: 'button' },
    expect: 'allow',
  },
  {
    name: '"Repeat order" contains the word "order" as a token, so it fires',
    verb: 'click',
    target: { accessibleName: 'Repeat order', role: 'button' },
    expect: 'attached.needs_owner',
  },
  // H1 — the words real consequence labels use, and their inflections. One
  // row per label; the near-misses beside them keep the table honest in the
  // other direction.
  ...[
    'Complete purchase',
    'Make a payment',
    'Payment',
    'Paying',
    'Paid',
    'Confirm',
    'Place your bid',
    'Book now',
    'Booking',
    'Reserve',
    'Donate',
    'Subscribe',
    'Unsubscribe',
    'Approve',
    'Authorise',
    'Authorize',
    'Withdraw',
    'Sign',
    'Publish',
    'Post',
    'Deleting',
    'Sending',
    'Sent',
    'Trash',
    'Discard',
    'Empty basket',
    'Deactivate',
    'Revoke',
    'Leave group',
    'Accept offer',
    'Sell',
    'Sold',
    'Trade',
    'Upgrade',
    'Renew',
    'Submitted',
    'Transferred',
    'Cancelled',
    'Cancelling',
    'Removed',
    'Orders',
    // The money and account verbs, and the pairs that only fire together.
    'Bid now',
    'Bidding',
    'Redeem',
    'Claim reward',
    'I agree',
    'Finalise',
    'Finalize order',
    'Settle bill',
    'Wire funds',
    'Wiring',
    'Commit',
    'Request refund',
    'Dispute',
    'Archive',
    'Block user',
    'Unfollow',
    'Check out',
    'Top up',
    'Mark as spam',
  ].map((label): Row => ({
    name: `a click named "${label}" is consequential`,
    verb: 'click',
    target: { accessibleName: label, role: 'button', tag: 'button' },
    expect: 'attached.needs_owner',
  })),
  ...[
    'Postcode',
    'Bookmark',
    'Payroll',
    'Signature',
    'Sender address',
    'Reorder',
    'Ordinary',
    // One near-miss beside each of the new words and pairs: the table
    // matches the words it was given, not shapes that contain them.
    'Bidets',
    'Redeemable',
    'Disclaim',
    'Membership agreement',
    'Finalist',
    'Settlement',
    'Wireless',
    'Committee',
    'Refundable',
    'Disarray',
    'Architecture',
    'Blockbuster',
    'Reporter',
    'Follow',
    'Check in',
    'Top shelf',
    'Mark',
  ].map((label): Row => ({
    name: `a click named "${label}" is a near-miss, not a consequence word`,
    verb: 'click',
    target: { accessibleName: label, role: 'link', tag: 'a' },
    expect: 'allow',
  })),
  {
    name: 'select: the option chosen names the consequence, not the control',
    verb: 'select',
    target: { accessibleName: 'Actions', role: 'combobox', tag: 'select' },
    value: 'Delete account',
    expect: 'attached.needs_owner',
  },
  {
    name: "select: the option's label is read when the call names its value",
    verb: 'select',
    target: {
      accessibleName: 'Actions',
      role: 'combobox',
      tag: 'select',
      options: [
        { value: 'opt-1', label: 'Colour' },
        { value: 'opt-2', label: 'Delete account' },
      ],
    },
    value: 'opt-2',
    expect: 'attached.needs_owner',
  },
  {
    name: 'select: an ordinary option on an ordinary control is allowed',
    verb: 'select',
    target: {
      accessibleName: 'Colour',
      role: 'combobox',
      tag: 'select',
      options: [{ value: 'opt-1', label: 'Blue' }],
    },
    value: 'opt-1',
    expect: 'allow',
  },

  // H2 — the name the snapshot shows is one of several. A clickable div
  // carries its label as text, a wrapper carries it in a descendant, and
  // a page may label a button one thing and draw another.
  {
    name: 'a clickable div named only by its text ("Place order") is consequential',
    verb: 'click',
    target: { tag: 'div', names: ['Place order'] },
    expect: 'attached.needs_owner',
  },
  {
    name: 'a wrapper with no name of its own, around a "Pay now" button, is consequential',
    verb: 'click',
    target: { tag: 'div', role: 'generic', names: ['Pay now'] },
    expect: 'attached.needs_owner',
  },
  {
    name: 'a button labelled "Continue" over visible "Pay" text is consequential',
    verb: 'click',
    target: { accessibleName: 'Continue', role: 'button', tag: 'button', names: ['Pay £500'] },
    expect: 'attached.needs_owner',
  },
  {
    name: 'a control with only harmless names reads harmless',
    verb: 'click',
    target: { accessibleName: 'Next', tag: 'button', names: ['Next page', 'Continue reading'] },
    expect: 'allow',
  },

  // M1 — the fence is the frame's host, not only the top document's.
  {
    name: 'a control inside a frame from an unlisted host is off the list',
    verb: 'click',
    target: { accessibleName: 'Continue', tag: 'button', frameHost: 'pay.example.net' },
    expect: 'attached.act_site_off_list',
    message: 'frame',
  },
  {
    name: 'a control inside a frame from a listed host is decided on its facts',
    verb: 'click',
    target: { accessibleName: 'Continue', tag: 'button', frameHost: 'example.com' },
    expect: 'allow',
  },
  {
    name: 'a frame with no host (about:blank, srcdoc) is not on any list',
    verb: 'click',
    target: { accessibleName: 'Continue', tag: 'button', frameHost: '' },
    expect: 'attached.act_site_off_list',
  },
  {
    name: 'a click that lands on the iframe element itself cannot rule out a field inside it',
    verb: 'click',
    target: { tag: 'iframe' },
    expect: 'attached.field_forbidden',
    message: 'frame',
  },
  {
    name: 'any submit while the page holds a card field, whatever the button says',
    verb: 'click',
    target: { accessibleName: 'Continue', tag: 'button', inputType: 'submit' },
    pageSecret: true,
    expect: 'attached.needs_owner',
  },
  {
    name: 'a submit on a clean page is a plain click',
    verb: 'click',
    target: { accessibleName: 'Continue', tag: 'button', inputType: 'submit' },
    pageSecret: false,
    expect: 'allow',
  },
  {
    name: 'the site fence comes before the table: a "Pay" off the list is off-list first',
    verb: 'click',
    host: 'example.org',
    target: { accessibleName: 'Pay now', role: 'button' },
    expect: 'attached.act_site_off_list',
  },

  // A `drag` is decided **once per endpoint** by the session; these rows
  // pin what one endpoint's answer looks like — the same rules, and a
  // pair that carries no grant answers `needs_owner` on either side.
  {
    name: 'a drag endpoint that is a password input',
    verb: 'drag',
    target: { role: 'textbox', tag: 'input', inputType: 'password' },
    expect: 'attached.field_forbidden',
    message: 'password',
  },
  {
    name: 'a drag endpoint named "Pay now"',
    verb: 'drag',
    target: { accessibleName: 'Pay now', role: 'button' },
    expect: 'attached.needs_owner',
  },
  {
    name: 'a clean drag endpoint stands on its own facts',
    verb: 'drag',
    target: { accessibleName: 'Inbox', role: 'list' },
    expect: 'allow',
  },

  // The classifier half of the table: typography the page chose does not
  // get a vote on whether the table reads the word. These rows pin what
  // fires, and - just as honestly - what does **not**.
  {
    name: 'a zero-width space inside "Pay" does not split the word away from the table',
    verb: 'click',
    target: { accessibleName: 'P\u200Bay now', role: 'button' },
    expect: 'attached.needs_owner',
  },
  {
    name: 'accents fold: an a with diaeresis is still an a to the table',
    verb: 'click',
    target: { accessibleName: 'P\u00E4y now', role: 'button' },
    expect: 'attached.needs_owner',
  },
  {
    name: 'compatibility forms fold: a fullwidth P is just a P to the table',
    verb: 'click',
    target: { accessibleName: '\uFF30ay now', role: 'button' },
    expect: 'attached.needs_owner',
  },
  {
    name: 'a soft hyphen hides nothing: the word still fires',
    verb: 'click',
    target: { accessibleName: '\u00ADPay now', role: 'button' },
    expect: 'attached.needs_owner',
  },
  {
    name: 'a bidi embedding control hides nothing either',
    verb: 'click',
    target: { accessibleName: 'P\u202Aay now', role: 'button' },
    expect: 'attached.needs_owner',
  },
  // M4 — every format character is invisible, and the fillers that are
  // classed as letters draw nothing: none of them splits a word.
  ...[
    ['a bidi isolate (U+2066)', 'P\u2066ay now'],
    ['a pop-directional isolate (U+2069)', 'Pa\u2069y now'],
    ['an invisible operator (U+2061)', 'Pa\u2061y now'],
    ['a Mongolian vowel separator (U+180E)', 'Pa\u180Ey now'],
    ['a tag character (U+E0041)', 'Pa\u{E0041}y now'],
    ['a Hangul filler (U+3164)', 'Pa\u3164y now'],
    ['a halfwidth Hangul filler (U+FFA0)', 'Pa\uFFA0y now'],
    ['a choseong filler (U+115F)', 'Pa\u115Fy now'],
    ['a blank braille cell (U+2800)', 'Pa\u2800y now'],
  ].map(([what, label]): Row => ({
    name: `${what} inside "Pay" does not hide the word`,
    verb: 'click',
    target: { accessibleName: label as string, role: 'button' },
    expect: 'attached.needs_owner',
  })),
  {
    name: 'a Cyrillic look-alike is another letter, not a folded one - documented residual, not a catch (13o)',
    verb: 'click',
    target: { accessibleName: 'P\u0430y now', role: 'button' },
    expect: 'allow',
  },
  {
    name: 'a CJK label stays one token: no Latin word matches it, and the shape waits for a CJK word in the table',
    verb: 'click',
    target: { accessibleName: '支付', role: 'button' },
    expect: 'allow',
  },
  // ── the repeat guard ─────────────────────────────────────────────────
  {
    name: 'the same act again within the window after a navigation',
    verb: 'click',
    target: BENIGN,
    repeat: true,
    expect: 'attached.act_repeat',
    message: 'check the page first',
  },
  {
    name: 'a valid grant does not beat the repeat guard',
    verb: 'click',
    target: { accessibleName: 'Pay', role: 'button' },
    repeat: true,
    grant: { present: true, verdict: 'valid' },
    expect: 'attached.act_repeat',
  },

  // ── the grant, as a verdict handed in ────────────────────────────────
  {
    name: 'a consequential click with a valid grant goes through',
    verb: 'click',
    target: { accessibleName: 'Pay', role: 'button' },
    grant: { present: true, verdict: 'valid' },
    expect: 'allow',
  },
  {
    name: 'a consequential click with no grant: the retry path belongs to the operator',
    verb: 'click',
    target: { accessibleName: 'Pay', role: 'button' },
    grant: { present: false },
    expect: 'attached.no_grant',
  },
  ...(['forged', 'expired', 'replayed'] as const).map((verdict): Row => ({
    name: `a consequential click with a ${verdict} grant`,
    verb: 'click',
    target: { accessibleName: 'Pay', role: 'button' },
    grant: { present: true, verdict },
    expect: 'attached.grant_invalid',
  })),
  {
    name: 'a bad grant fails closed even on a harmless click',
    verb: 'click',
    target: BENIGN,
    grant: { present: true, verdict: 'forged' },
    expect: 'attached.grant_invalid',
  },
  {
    name: 'the inert seam: secret unset with a grant present — no_grant, never allow',
    verb: 'click',
    target: { accessibleName: 'Pay', role: 'button' },
    grant: { present: true, verdict: 'no_secret' },
    expect: 'attached.no_grant',
  },
  {
    name: 'the inert seam on a plain click: the grant grants nothing, the act stands',
    verb: 'click',
    target: BENIGN,
    grant: { present: true, verdict: 'no_secret' },
    expect: 'allow',
  },
];

for (const row of rows) {
  test(`gate: ${row.name}`, () => {
    const decision = decide({
      siteHost: row.host ?? 'example.com',
      verb: row.verb,
      target: row.target,
      focusedControl: row.focus,
      value: row.value,
      pageHasSecretField: row.pageSecret ?? false,
      grant: row.grant,
      repeatAfterNavigation: row.repeat ?? false,
      actSites: row.sites ?? SITES,
    });
    assert.equal(decision.decision, row.expect);
    if (decision.decision !== 'allow') {
      if (row.message) {
        assert.ok(
          decision.message.includes(row.message),
          `refusal sentence must carry "${row.message}", got: ${decision.message}`,
        );
      }
    }
  });
}

test('the consequential table is the exported one the rows walked', () => {
  assert.ok(
    CONSEQUENCE_WORDS.includes('cancel'),
    'cancel is consequential, both ways pinned above',
  );
  assert.ok(
    CONSEQUENCE_PAIRS.some(([a, b]) => a === 'close' && b === 'account'),
    'close+account is the pair, "Close" alone pinned above as ordinary',
  );
});

// ── the grant verifier ─────────────────────────────────────────────────

const TUPLE: GrantTuple = {
  leaseKey: LEASE,
  ref: 'e7',
  accessibleName: 'Pay now',
  urlHost: 'example.com',
  issuedAtSeconds: ISSUED,
  verb: 'click',
  valueDigest: '',
};

interface GrantRow {
  readonly name: string;
  readonly grant: string;
  readonly secret: string | undefined;
  readonly tuple?: GrantTuple;
  readonly now?: number;
  /** Grants to verify in order against one registry; defaults to one. */
  readonly useTwice?: boolean;
  readonly expect: GrantVerdict;
}

const validToken = signGrant(TUPLE, SECRET);

const grantRows: GrantRow[] = [
  { name: 'a valid grant', grant: validToken, secret: SECRET, expect: 'valid' },
  {
    name: 'a grant signed with another key reads as forged',
    grant: signGrant(TUPLE, 'other-key'),
    secret: SECRET,
    expect: 'forged',
  },
  {
    name: 'a retargeted ref reads as forged (the tuple is the signature)',
    grant: validToken,
    secret: SECRET,
    tuple: { ...TUPLE, ref: 'e8' },
    expect: 'forged',
  },
  {
    name: 'a retargeted host reads as forged',
    grant: validToken,
    secret: SECRET,
    tuple: { ...TUPLE, urlHost: 'example.org' },
    expect: 'forged',
  },
  {
    name: 'a retargeted lease reads as forged',
    grant: validToken,
    secret: SECRET,
    tuple: { ...TUPLE, leaseKey: 'lease-k2' },
    expect: 'forged',
  },
  {
    name: 'a retargeted accessible name reads as forged',
    grant: validToken,
    secret: SECRET,
    tuple: { ...TUPLE, accessibleName: 'Pay now please' },
    expect: 'forged',
  },
  {
    name: 'a crafted name cannot collide with another tuple (pipes are escaped)',
    grant: signGrant(
      {
        leaseKey: LEASE,
        ref: 'r',
        accessibleName: 'a|b',
        urlHost: 'h.example',
        issuedAtSeconds: ISSUED,
        verb: 'click',
        valueDigest: '',
      },
      SECRET,
    ),
    secret: SECRET,
    // Different fields, but the naive `|`-join of this tuple is byte-for-byte
    // the naive join of the one above — escaping is what tells them apart.
    tuple: {
      leaseKey: LEASE,
      ref: 'r|a',
      accessibleName: 'b',
      urlHost: 'h.example',
      issuedAtSeconds: ISSUED,
      verb: 'click',
      valueDigest: '',
    },
    expect: 'forged',
  },
  // H5 — the grant is for one verb carrying one value.
  {
    name: 'a grant minted for a click does not verify for a type on the same ref',
    grant: validToken,
    secret: SECRET,
    tuple: { ...TUPLE, verb: 'type' },
    expect: 'forged',
  },
  {
    name: 'a grant minted for a click does not verify for a press, a select or a fill',
    grant: validToken,
    secret: SECRET,
    tuple: { ...TUPLE, verb: 'press', valueDigest: grantValueDigest('Enter') },
    expect: 'forged',
  },
  {
    name: 'a grant for typing 12 does not verify for typing 1200',
    grant: signGrant({ ...TUPLE, verb: 'type', valueDigest: grantValueDigest('12') }, SECRET),
    secret: SECRET,
    tuple: { ...TUPLE, verb: 'type', valueDigest: grantValueDigest('1200') },
    expect: 'forged',
  },
  {
    name: 'a grant for typing 12 verifies for typing 12',
    grant: signGrant({ ...TUPLE, verb: 'type', valueDigest: grantValueDigest('12') }, SECRET),
    secret: SECRET,
    tuple: { ...TUPLE, verb: 'type', valueDigest: grantValueDigest('12') },
    expect: 'valid',
  },
  // L3 — the stamp is one-sided: a few seconds of skew, never a life ahead.
  {
    name: 'a stamp a few seconds ahead of this clock is within skew',
    grant: validToken,
    secret: SECRET,
    now: ISSUED - GRANT_CLOCK_SKEW_SECONDS,
    expect: 'valid',
  },
  {
    name: 'a stamp further ahead than the skew is not yet a grant (no 240 s life)',
    grant: validToken,
    secret: SECRET,
    now: ISSUED - GRANT_CLOCK_SKEW_SECONDS - 1,
    expect: 'expired',
  },
  {
    name: 'a stamp two minutes ahead is refused, not honoured for its whole life',
    grant: validToken,
    secret: SECRET,
    now: ISSUED - GRANT_TTL_SECONDS,
    expect: 'expired',
  },
  {
    name: 'a token that is not a SHA-256 tag reads as forged',
    grant: 'bm90LWEtdGFn',
    secret: SECRET,
    expect: 'forged',
  },
  {
    name: 'an empty token reads as forged',
    grant: '',
    secret: SECRET,
    expect: 'forged',
  },
  {
    name: 'valid at exactly the TTL boundary',
    grant: validToken,
    secret: SECRET,
    now: ISSUED + GRANT_TTL_SECONDS,
    expect: 'valid',
  },
  {
    name: 'one second past the boundary is expired',
    grant: validToken,
    secret: SECRET,
    now: ISSUED + GRANT_TTL_SECONDS + 1,
    expect: 'expired',
  },
  {
    name: 'spent on first use, refused on the second: replayed',
    grant: validToken,
    secret: SECRET,
    useTwice: true,
    expect: 'replayed',
  },
  {
    name: 'an expired grant never enters the registry (no tainting)',
    grant: validToken,
    secret: SECRET,
    now: ISSUED + GRANT_TTL_SECONDS + 1,
    useTwice: true,
    expect: 'expired',
  },
  {
    name: 'a grant with no secret configured: no_secret, and nothing verifies',
    grant: validToken,
    secret: undefined,
    expect: 'no_secret',
  },
  {
    name: 'a grant with the empty default secret: the seam is inert',
    grant: validToken,
    secret: '',
    expect: 'no_secret',
  },
];

for (const row of grantRows) {
  test(`grant: ${row.name}`, () => {
    const registry = createGrantRegistry();
    const first = verifyOwnerGrant(
      row.grant,
      row.secret,
      row.tuple ?? TUPLE,
      row.now ?? ISSUED + 60,
      registry,
    );
    if (!row.useTwice) {
      assert.equal(first, row.expect);
      return;
    }
    assert.notEqual(first, 'replayed', 'the first attempt is not the one the row is about');
    const second = verifyOwnerGrant(
      row.grant,
      row.secret,
      row.tuple ?? TUPLE,
      row.now ?? ISSUED + 60,
      registry,
    );
    assert.equal(second, row.expect);
  });
}

test('every verb the driver can carry is placed: never-acted, read-safe, or acting — exactly once', () => {
  // The placement ledger. `decide` treats **anything not named** as an
  // acting verb, so a verb added to `PAGE_ACTIONS` without being placed
  // here would silently start being allowed on listed sites. This is the
  // same pin class as the refusal-rule table on the pages side: the gate
  // must know every verb by name, and each name lands in exactly one box.
  const acting: readonly PageAction[] = [
    'click',
    'type',
    'fill',
    'press',
    'select',
    'check',
    'dialog',
    'fill_form',
    'drag',
  ];
  const never = new Set<string>(NEVER_ACTED);
  const readSafe = new Set<string>(ALWAYS_ALLOWED);
  const acted = new Set<string>(acting);
  const all = new Set<string>(PAGE_ACTIONS);
  assert.equal(all.size, PAGE_ACTIONS.length, 'the driver list itself has no duplicates');
  for (const verb of PAGE_ACTIONS) {
    const boxes = Number(never.has(verb)) + Number(readSafe.has(verb)) + Number(acted.has(verb));
    assert.equal(
      boxes,
      1,
      `"${verb}" must land in exactly one of NEVER_ACTED / ALWAYS_ALLOWED / the acting set`,
    );
  }
  // The other direction: a box may not name a verb the driver cannot send.
  for (const verb of [...never, ...readSafe, ...acted]) {
    assert.ok(all.has(verb), `"${verb}" is placed but the driver cannot carry it`);
  }
});

test('the registry is per-session: the same token is fresh in a new one', () => {
  const a = createGrantRegistry();
  const b = createGrantRegistry();
  assert.equal(verifyOwnerGrant(validToken, SECRET, TUPLE, ISSUED + 60, a), 'valid');
  assert.equal(verifyOwnerGrant(validToken, SECRET, TUPLE, ISSUED + 60, b), 'valid');
  assert.equal(a.size, 1);
  assert.equal(b.size, 1);
});

test('the gate has no seam to a driver, and its decisions carry no call objects', () => {
  // The strongest available form of "the browser was never asked": the
  // input carries no callables a decision could route through, and a
  // decision is only ever its name and its sentence — never a pending
  // call. If a future change widens either shape, this fails before any
  // refusal row can mean something weaker than it says.
  const input = {
    siteHost: 'example.com',
    verb: 'click' as const,
    target: BENIGN,
    focusedControl: null,
    pageHasSecretField: false,
    grant: { present: false } as const,
    repeatAfterNavigation: false,
    actSites: SITES,
  };
  for (const value of Object.values(input)) {
    assert.notEqual(typeof value, 'function', 'gate input carries a callable');
  }
  const allowed = decide(input);
  assert.deepEqual(Object.keys(allowed).sort(), ['decision']);
  const refused = decide({ ...input, verb: 'resize' });
  assert.deepEqual(Object.keys(refused).sort(), ['decision', 'message']);
});

test('every movement key the session performs is a key the gate allows, off the list too', () => {
  for (const key of NAVIGATION_KEYS) {
    const answer = decide({
      siteHost: 'example.org',
      verb: 'press',
      value: key,
      pageHasSecretField: false,
      actSites: SITES,
    });
    assert.equal(answer.decision, 'allow', key);
  }
  for (const key of ['arrowdown', 'pagedown', 'escape', 'ESCAPE']) {
    const answer = decide({
      siteHost: 'example.org',
      verb: 'press',
      value: key,
      pageHasSecretField: false,
      actSites: SITES,
    });
    assert.equal(answer.decision, 'attached.key_unparseable', `${key} is not a key spelling`);
  }
  // The early allowance reads the parsed key, so a movement name cannot ride
  // it on the strength of being only one token of a combination.
  for (const key of ['ArrowDown+Enter', 'Enter+ArrowDown', 'PageUp+Tab']) {
    const answer = decide({
      siteHost: 'example.org',
      verb: 'press',
      value: key,
      pageHasSecretField: false,
      actSites: SITES,
    });
    assert.equal(answer.decision, 'attached.key_unparseable', `${key} is not a key`);
  }
});

test('the key grammar: what parses, and to what', () => {
  // Valid spellings, canonicalised for the rules that read them.
  assert.deepEqual(parseKey('Control+a'), { modifiers: ['Control'], base: 'a' });
  assert.deepEqual(parseKey('Shift+A'), { modifiers: ['Shift'], base: 'A' });
  assert.deepEqual(parseKey('Shift+Tab'), { modifiers: ['Shift'], base: 'Tab' });
  assert.deepEqual(parseKey('control+Enter'), { modifiers: ['Control'], base: 'Enter' });
  assert.deepEqual(parseKey('ControlOrMeta+s'), { modifiers: ['ControlOrMeta'], base: 's' });
  // The plus key, with and without a modifier.
  assert.deepEqual(parseKey('+'), { modifiers: [], base: '+' });
  assert.deepEqual(parseKey('Control++'), { modifiers: ['Control'], base: '+' });
  assert.deepEqual(parseKey('Shift+F12'), { modifiers: ['Shift'], base: 'F12' });
  // Not keys: every one of these would otherwise reach the performer as a
  // real combination that presses Enter or holds something down.
  for (const bad of [
    'Enter+Tab',
    'Tab+Enter',
    'Enter+a',
    'ArrowDown+Enter',
    '\n',
    '\r',
    'Shift+\r',
    'ctrl+a',
    'cmd+a',
    'option+a',
    'super+a',
    'command+a',
    'Return',
    'a+',
    'a++b',
    '',
    'Control+',
  ]) {
    assert.equal(parseKey(bad), undefined, JSON.stringify(bad));
  }
});

test('free text goes through the same table: a dialog message, an option label', () => {
  for (const text of [
    'Permanently delete your account?',
    'Are you sure you want to cancel your order?',
    'Confirm payment of the balance',
  ]) {
    assert.equal(isConsequentialText(text), true, text);
  }
  for (const text of ['Do you want to continue?', 'Cancellation policy', undefined, '']) {
    assert.equal(isConsequentialText(text), false, String(text));
  }
});
