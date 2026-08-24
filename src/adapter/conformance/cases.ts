import { OPERATION_NAMES } from '../operations.ts';
import type { ConformanceCase } from './case.ts';

/**
 * The case table: authored once per operation, crossed with every route.
 *
 * `SCHEMA.md` §8 assertion 3 requires **every operation to have a case that
 * succeeds and a case that is refused**, so each operation below has both.
 * The runner checks that requirement over the operations routes actually
 * offer, rather than trusting this file to be complete — a table that
 * silently lost a case would otherwise weaken the suite without failing it.
 *
 * ── What these cases assert while the service layer is unbuilt ──────────
 *
 * The rules these cases name are `SCHEMA.md` §7.1's, and the service that
 * enforces them is row #10 onward — **not on `main` yet**. So the cases are
 * run against a service double that implements exactly those rules, and what
 * they prove is the property this row owes: **that the route carries an
 * outcome faithfully.** Every code and rule name that comes out of the
 * service arrives at the caller unchanged, with the physical side-effects
 * unmoved on a refusal.
 *
 * That is a narrower claim than #30's and it is stated narrowly on purpose.
 * When the real service lands, this table is pointed at it and the same cases
 * become the parity assertion over real enforcement, with no case rewritten —
 * which is the property the once-per-operation shape exists to give.
 */

/** A lease key a case can carry. Not a real one; nothing issues these. */
const A_LEASE_KEY = 'lease-key-placeholder';

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  {
    name: 'claim: a well-formed request is granted',
    operation: 'claim',
    input: { session_id: 'session-a', browser: 'regular', purpose: 'conformance: a granted claim' },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'claim: a browser that is not one of the two is refused',
    operation: 'claim',
    // §7.1 `claim.browser_known`. There are exactly two browsers and there is
    // no third (§1.2), so naming one is a refusal on every route or on none.
    input: { session_id: 'session-a', browser: 'third', purpose: 'conformance: unknown browser' },
    expect: { outcome: 'refused', code: 'unknown_browser', rule: 'claim.browser_known' },
  },
  {
    name: 'status: a live lease reports where it stands',
    operation: 'status',
    input: { lease_key: A_LEASE_KEY },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'status: a call with no key is refused',
    operation: 'status',
    // §7.1 `key.present`: every operation except requesting a lease carries a
    // key, written out explicitly and never derived from a session (§3.1).
    input: {},
    expect: { outcome: 'refused', code: 'key_missing', rule: 'key.present' },
  },
  {
    name: 'release: a lease gives back what it holds',
    operation: 'release',
    input: { lease_key: A_LEASE_KEY },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'release: an unrecognised key is refused',
    operation: 'release',
    input: { lease_key: 'not-a-key' },
    expect: { outcome: 'refused', code: 'unrecognised_key', rule: 'key.valid' },
  },
  {
    name: 'tab replace: a live lease gets a fresh tab',
    operation: 'tab_replace',
    input: { lease_key: A_LEASE_KEY },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'tab replace: an unrecognised key is refused',
    operation: 'tab_replace',
    input: { lease_key: 'not-a-key' },
    expect: { outcome: 'refused', code: 'unrecognised_key', rule: 'key.valid' },
  },
  {
    name: 'navigate: an ordinary web address is accepted',
    operation: 'navigate',
    input: { lease_key: A_LEASE_KEY, url: 'https://example.com/' },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'navigate: a local-file address is refused',
    operation: 'navigate',
    // §7.1 `navigate.scheme_allowed`, and the reason it is refused explicitly
    // rather than merely unsupported: it turns a browser lease into an
    // arbitrary read of the machine's filesystem.
    input: { lease_key: A_LEASE_KEY, url: 'file:///etc/passwd' },
    expect: { outcome: 'refused', code: 'invalid_address', rule: 'navigate.scheme_allowed' },
  },
  {
    name: 'act: a named verb is performed',
    operation: 'act',
    input: { lease_key: A_LEASE_KEY, action: 'click', target: 'the-button' },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'act: a verb that is not on the list is refused',
    operation: 'act',
    input: { lease_key: A_LEASE_KEY, action: 'teleport', target: 'the-button' },
    expect: { outcome: 'refused', code: 'unknown_action', rule: 'act.verb_known' },
  },
  {
    name: 'read: the page snapshot is returned by default',
    operation: 'read',
    input: { lease_key: A_LEASE_KEY },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'read: an unrecognised key is refused',
    operation: 'read',
    input: { lease_key: 'not-a-key' },
    expect: { outcome: 'refused', code: 'unrecognised_key', rule: 'key.valid' },
  },
  {
    name: 'evaluate: an expression within the cap is evaluated',
    operation: 'evaluate',
    input: { lease_key: A_LEASE_KEY, expression: '1 + 1' },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'evaluate: an expression over the cap is refused',
    operation: 'evaluate',
    // §7.1 `evaluate.expression_bounded`.
    input: { lease_key: A_LEASE_KEY, expression: 'x'.repeat(100_000) },
    expect: {
      outcome: 'refused',
      code: 'expression_too_long',
      rule: 'evaluate.expression_bounded',
    },
  },
  {
    name: 'capture: a default-tier picture is taken',
    operation: 'capture',
    input: { lease_key: A_LEASE_KEY },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'capture: a selector and a full page together are refused',
    operation: 'capture',
    // §7.1 `capture.exclusive_mode`. Note this is a refusal about a malformed
    // argument, never about cost — `capture.never_refused_for_cost` (§7.3) is
    // what keeps the "never a refusal for cost" promise checkable.
    input: { lease_key: A_LEASE_KEY, selector: '.thing', full_page: true },
    expect: { outcome: 'refused', code: 'cannot_do_both', rule: 'capture.exclusive_mode' },
  },
  {
    name: 'feedback: a rated report is recorded without a lease',
    operation: 'feedback',
    // §3.16: no lease required, and that is the point rather than a
    // convenience — requiring one would silence exactly the population the
    // tool exists to hear from.
    input: { rating: '4', category: 'helped', note: 'conformance: a recorded report' },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'feedback: a rating outside the scale is refused',
    operation: 'feedback',
    input: { rating: '9', category: 'helped', note: 'conformance: a rating off the scale' },
    expect: { outcome: 'refused', code: 'rating_out_of_range', rule: 'feedback.rating_in_scale' },
  },
];

/**
 * Every operation named by at least one case.
 *
 * Exported so a test can assert the table covers the operation list by name
 * rather than by counting — `MILESTONES.md` records a hollow test that
 * "iterated a list rather than naming its entries, so deleting an entry
 * stayed green", and a count would have exactly that shape.
 */
export const OPERATIONS_WITH_CASES: readonly string[] = OPERATION_NAMES.filter((operation) =>
  CONFORMANCE_CASES.some((testCase) => testCase.operation === operation),
);
