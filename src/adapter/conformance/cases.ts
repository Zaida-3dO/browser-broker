import { OPERATION_NAMES } from '../operations.ts';
import type { CaseSeed, ConformanceCase } from './case.ts';

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

/**
 * Mint a live lease and hand its key to the case.
 *
 * ── Why every keyed case needs this, rather than a constant ─────────────
 *
 * A lease key is **returned once by the claim that granted it and is not
 * recoverable** (§2.2), so a case cannot write one down. A constant would be
 * a key the service never issued, and every keyed case would then measure
 * `key.valid` refusing it — the whole matrix would go green on the wrong
 * assertion, with the operations themselves never reached.
 *
 * The seed runs afresh per case-and-route pair, so each pair gets its own
 * lease and no pair inherits another's.
 */
const withALiveLease: CaseSeed = {
  apply: async (service) => {
    const granted = await service.perform({
      operation: 'claim',
      adapter: 'conformance',
      arguments: {
        session_id: 'conformance-seed',
        browser: 'regular',
        purpose: 'conformance: a lease for the keyed cases',
      },
    });
    if (granted.outcome !== 'accepted') {
      throw new Error(`the seed could not obtain a lease: ${granted.rule}`);
    }
    // ── Two different outcomes, and only one of them is a live lease ─────
    //
    // `granted.outcome` is the **transport's** answer: the call was accepted
    // rather than refused. `granted.value['outcome']` is the **service's**:
    // whether the claim was granted a tab or put in the queue. A full budget
    // answers `accepted` at the transport and `queued` underneath, and a
    // queued claim holds a real key with no tab behind it.
    //
    // Checking only the first is the shape this suite exists to catch. The
    // docblock above argues that a key the service never issued would send
    // the whole matrix green on `key.valid`; a queued key is the same defect
    // one layer in, and harder to see, because the key is genuine — the
    // operations would refuse for having no tab while the seed reported
    // success, and the failure would name a rule that looks like a real
    // finding about the operation under test.
    //
    // The sibling seed below already reads `value['outcome']`, because
    // reaching a queue placement is the thing it is trying to do. This one
    // wants the opposite and had not said so.
    if (granted.value['outcome'] !== 'granted') {
      throw new Error(
        `the seed obtained a lease that is not live: the service answered ` +
          `'${String(granted.value['outcome'])}' rather than 'granted', so the key it ` +
          `returned has no tab behind it and every keyed case would measure that ` +
          `instead of the operation it names.`,
      );
    }
    // **The key is substituted into the case's input**, so the operation
    // under test is reached rather than being refused for an unknown key.
    return { lease_key: granted.value['key'] };
  },
};

/**
 * A live lease whose tab has been given back, so the key is real and there is
 * no tab behind it.
 *
 * The reachable way to exercise `tab.owned`: no surface takes a tab argument
 * (§3.4), so a caller cannot name another lease's tab and there is no input
 * that would. Releasing the tab leaves a key that resolves and a tab that
 * does not, which is the state the rule refuses.
 */
/**
 * A lease that is **live and holds no tab**: a queue placement.
 *
 * ── Why the queue rather than a released lease ──────────────────────────
 *
 * `tab.owned` is only reachable while the key still resolves. Releasing the
 * lease ends it, so `claim.live` refuses first and the case measures that
 * rule instead — which is correct behaviour and the wrong thing to assert
 * here. §3.14's refusal ordering is a property callers branch on, so a seed
 * that trips an earlier rule is a seed testing the earlier rule.
 *
 * A queued lease is the state that satisfies both halves: §2.5 gives it a key
 * and no tab, because *"a queued lease has no tab"*. The bridge resolves no
 * tab for it and the ownership guard refuses — with `tab_not_found`, the same
 * code an unknown tab gets, because §7.1 requires the two be
 * indistinguishable so probing cannot enumerate another lease's tabs.
 *
 * **Nothing here takes a tab argument**, and could not: no surface offers one
 * (§3.4). That is why this rule is reached by exhausting the budget rather
 * than by naming somebody else's tab — the naming route does not exist.
 */
const withAQueuedLease: CaseSeed = {
  apply: async (service) => {
    // Claim until one is queued rather than counting to the budget: the
    // budget is configurable (§1.10), so a fixture that assumed a number
    // would break on a build configured differently and would break silently
    // — every claim granted, nothing queued, and the case measuring an
    // active lease.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const outcome = await service.perform({
        operation: 'claim',
        adapter: 'conformance',
        arguments: {
          session_id: `conformance-queue-${String(attempt)}`,
          browser: 'regular',
          purpose: 'conformance: filling the budget to reach a queue placement',
        },
      });
      if (outcome.outcome !== 'accepted') {
        throw new Error(`the seed could not obtain a lease: ${outcome.rule}`);
      }
      if (outcome.value['outcome'] === 'queued') {
        return { lease_key: outcome.value['key'] };
      }
    }
    throw new Error('the seed never reached a queue placement');
  },
};

/** A key that was never issued — for the cases whose subject is `key.valid`. */
const NOT_A_KEY = 'not-a-key';

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
    seed: withALiveLease,
    input: {},
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
    seed: withALiveLease,
    input: {},
    expect: { outcome: 'accepted' },
  },
  {
    name: 'release: an unrecognised key is refused',
    operation: 'release',
    input: { lease_key: NOT_A_KEY },
    expect: { outcome: 'refused', code: 'unrecognised_key', rule: 'key.valid' },
  },
  {
    name: 'tab replace: a live lease gets a fresh tab',
    operation: 'tab_replace',
    seed: withALiveLease,
    input: {},
    expect: { outcome: 'accepted' },
  },
  {
    name: 'tab replace: an unrecognised key is refused',
    operation: 'tab_replace',
    input: { lease_key: NOT_A_KEY },
    expect: { outcome: 'refused', code: 'unrecognised_key', rule: 'key.valid' },
  },
  {
    name: 'navigate: an ordinary web address is accepted',
    operation: 'navigate',
    seed: withALiveLease,
    input: { url: 'https://example.com/' },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'navigate: a local-file address is refused',
    operation: 'navigate',
    // §7.1 `navigate.scheme_allowed`, and the reason it is refused explicitly
    // rather than merely unsupported: it turns a browser lease into an
    // arbitrary read of the machine's filesystem.
    seed: withALiveLease,
    input: { url: 'file:///etc/passwd' },
    expect: {
      outcome: 'refused',
      code: 'navigate.scheme_allowed',
      rule: 'navigate.scheme_allowed',
    },
  },
  {
    name: 'act: a named verb is performed',
    operation: 'act',
    seed: withALiveLease,
    input: { action: 'click', target: 'the-button' },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'act: a verb that is not on the list is refused',
    operation: 'act',
    seed: withALiveLease,
    input: { action: 'teleport', target: 'the-button' },
    // The rule is spelled `act.action_known`, which is what the service
    // actually produces. §8.4 computes coverage from what came back rather
    // than from what a case declared, so a case naming a rule nothing raises
    // fails the run instead of quietly passing.
    expect: { outcome: 'refused', code: 'act.action_known', rule: 'act.action_known' },
  },
  {
    name: 'read: the page snapshot is returned by default',
    operation: 'read',
    seed: withALiveLease,
    input: {},
    expect: { outcome: 'accepted' },
  },
  {
    name: 'read: an unrecognised key is refused',
    operation: 'read',
    input: { lease_key: NOT_A_KEY },
    expect: { outcome: 'refused', code: 'unrecognised_key', rule: 'key.valid' },
  },
  {
    name: 'evaluate: an expression within the cap is evaluated',
    operation: 'evaluate',
    seed: withALiveLease,
    input: { expression: '1 + 1' },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'evaluate: an expression over the cap is refused',
    operation: 'evaluate',
    // §7.1 `evaluate.expression_bounded`.
    seed: withALiveLease,
    input: { expression: 'x'.repeat(100_000) },
    expect: {
      outcome: 'refused',
      code: 'evaluate.expression_bounded',
      rule: 'evaluate.expression_bounded',
    },
  },
  {
    name: 'capture: a default-tier picture is taken',
    operation: 'capture',
    seed: withALiveLease,
    input: {},
    expect: { outcome: 'accepted' },
  },
  {
    name: 'capture: a selector and a full page together are refused',
    operation: 'capture',
    // §7.1 `capture.exclusive_mode`. Note this is a refusal about a malformed
    // argument, never about cost — `capture.never_refused_for_cost` (§7.3) is
    // what keeps the "never a refusal for cost" promise checkable.
    seed: withALiveLease,
    input: { selector: '.thing', full_page: true },
    expect: {
      outcome: 'refused',
      code: 'capture.exclusive_mode',
      rule: 'capture.exclusive_mode',
    },
  },
  {
    name: 'claim: a purpose outside its bounds is refused',
    operation: 'claim',
    // §7.1 `claim.purpose_bounded`. The purpose is what an operator reads
    // when deciding whether to revoke a lease (§1.3), so it is bounded at
    // both ends and the refusal is the same on every route.
    input: { session_id: 'session-a', browser: 'regular', purpose: 'x' },
    expect: {
      outcome: 'refused',
      code: 'purpose_out_of_bounds',
      rule: 'claim.purpose_bounded',
    },
  },
  {
    name: 'navigate: a lease holding no tab is refused',
    operation: 'navigate',
    // §7.1 `tab.owned`. **The tab is not an argument on any surface** (§3.4),
    // so a route cannot name somebody else's — the bridge resolves the tab
    // from the key. A queued lease is live and holds no tab, which reaches
    // this rule from the direction a caller can actually get to.
    seed: withAQueuedLease,
    input: { url: 'https://example.com/' },
    // `tab_not_found` and not a code of its own: §7.1 requires an unowned
    // tab and an unknown one to be indistinguishable to the caller.
    expect: { outcome: 'refused', code: 'tab_not_found', rule: 'tab.owned' },
  },
  {
    name: 'feedback: a rated report is recorded without a lease',
    operation: 'feedback',
    // §3.16: no lease required, and that is the point rather than a
    // convenience — requiring one would silence exactly the population the
    // tool exists to hear from.
    input: { rating: '4', category: 'worked-well', note: 'conformance: a recorded report' },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'feedback: a rating outside the scale is refused',
    operation: 'feedback',
    input: { rating: '9', category: 'worked-well', note: 'conformance: a rating off the scale' },
    expect: {
      outcome: 'refused',
      code: 'feedback.rating_in_scale',
      rule: 'feedback.rating_in_scale',
    },
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
