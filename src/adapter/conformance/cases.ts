import { CAPTURES_BEFORE_WARNING } from '../../capture/tiers.ts';
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
 * A live lease that has already taken enough captures that the **next** one is
 * past the accounting threshold.
 *
 * ── Why `warning` needs a seed of its own ───────────────────────────────
 *
 * §3.11 promises a warning on every capture past the threshold, and the
 * default-tier case above cannot assert it: that case takes a lease's *first*
 * capture, which correctly carries no warning. Naming `capture.warning` there
 * would fail against correct code — the one failure {@link ConformanceCase}
 * forbids a case from manufacturing. So the threshold has to be crossed
 * first, and crossing it is what this seed is for.
 *
 * **It drives exactly {@link CAPTURES_BEFORE_WARNING} captures**, so the
 * capture the case itself takes is number `CAPTURES_BEFORE_WARNING + 1` — the
 * first one past the line. Driven through `service.perform` rather than
 * inserted into the `captures` table, because the count the warning reads is
 * a query over rows the service wrote, and a seed that wrote its own rows
 * would be asserting against a fixture rather than against the accounting
 * path this case exists to cover.
 *
 * **Imported rather than written as a literal.** A hard-coded count is only
 * correct for one value of the constant: raise the threshold and the seed
 * stops short of it, so the case takes a capture that carries no warning and
 * asserts nothing while staying green — which is worse than red, because it
 * reads as coverage.
 */
const pastTheCaptureWarningThreshold: CaseSeed = {
  apply: async (service) => {
    const substitutions = await withALiveLease.apply(service);
    const leaseKey = (substitutions as Readonly<Record<string, unknown>>)['lease_key'];

    for (let taken = 0; taken < CAPTURES_BEFORE_WARNING; taken += 1) {
      const capture = await service.perform({
        operation: 'capture',
        adapter: 'conformance',
        arguments: { lease_key: leaseKey },
      });
      // Loud rather than silent: a seed whose captures were refused would
      // leave the lease below the threshold, and the case would then report
      // "the accepted value has no capture.warning" — a finding naming the
      // response when the fault was the setup. Failing here says which.
      if (capture.outcome !== 'accepted') {
        throw new Error(
          `the seed could not take capture ${String(taken + 1)} of ` +
            `${String(CAPTURES_BEFORE_WARNING)}: ${capture.rule}. The lease is below the ` +
            `warning threshold, so the case would measure the setup rather than the response.`,
        );
      }
    }

    return { lease_key: leaseKey };
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

/**
 * A live lease that has **already asked for a sign-in**, so the browser is in
 * `signing-in` and this lease is the one that put it there.
 *
 * ── Why the seed asks rather than the case doing it ─────────────────────
 *
 * `sign_in_done` is only reachable against a sign-in that is open, and only
 * by the lease that opened it (§7.1 `signin.finish_owned`). A case cannot
 * express two calls — it names one operation and one input — so the first of
 * the two happens here, which is what a seed is for.
 *
 * **It goes through the service, exactly like every other seed here.** The
 * browser is moved to `signing-in` by a real `sign_in` call rather than by
 * writing the row, so the state this case finishes is a state the product
 * produced. Seeding it by hand would prove the finish path can move a row
 * somebody inserted, which is not the claim.
 */
const withARequestedSignIn: CaseSeed = {
  apply: async (service) => {
    const granted = await service.perform({
      operation: 'claim',
      adapter: 'conformance',
      arguments: {
        session_id: 'conformance-signin-seed',
        browser: 'regular',
        purpose: 'conformance: a lease that will ask for a sign-in',
      },
    });
    if (granted.outcome !== 'accepted') {
      throw new Error(`the seed could not obtain a lease: ${granted.rule}`);
    }
    if (granted.value['outcome'] !== 'granted') {
      throw new Error(
        `the seed obtained a lease that is not live: the service answered ` +
          `'${String(granted.value['outcome'])}' rather than 'granted', so it holds no tab ` +
          `and cannot ask for a sign-in on one.`,
      );
    }

    const key = granted.value['key'];
    const asked = await service.perform({
      operation: 'sign_in',
      adapter: 'conformance',
      arguments: { lease_key: key, what: 'conformance: the account dashboard' },
    });
    if (asked.outcome !== 'accepted') {
      throw new Error(`the seed could not open a sign-in: ${asked.rule}`);
    }

    return { lease_key: key };
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
    // §3.11's promised response, asserted as a response rather than as a row
    // in a database. All three of `sourceWidth`, `sourceHeight` and `tier`
    // were promised by §3.11 — *"the dimensions written, the dimensions
    // before shrinking, the file size, the tier"* — computed by the pipeline,
    // written to the `captures` table, and then **dropped by the service layer
    // that builds the caller's reply**, for the whole life of the feature.
    //
    // Nothing caught it because nothing anywhere compared a response against
    // the specification that promised it: `check:operations` proves the
    // binaries reach the service, `check:argument-refusals` polices refusals,
    // and neither walks from a documented response field to the code meant to
    // populate it. Naming the fields here is the narrow, non-brittle version
    // of that check — it binds the spec to the code at the one point both
    // agree on, without a parser trying to read §3.x's English.
    expect: {
      outcome: 'accepted',
      //
      // ── What bounds this list, now that the gap it named is closed ───────
      //
      // This comment used to record a known gap: `estimatedTokens`,
      // `capturesThisLease` and `escalation` were promised by §3.11, computed
      // by the *pipeline's* `CaptureResult`, and dropped when `pages.ts`
      // reshaped that into the `written` object. Naming them here would have
      // failed against the code as it then stood, which is the one failure a
      // conformance case must never manufacture — so they were left out and
      // written down instead.
      //
      // **They are forwarded now, so they are asserted now.** That is the
      // whole point of having written the gap down: the note was the thing
      // that survived long enough for somebody to close it.
      //
      // `escalation` belongs in *this* case specifically, and not merely in
      // any capture case, because §3.11 promises it **exactly on a
      // default-tier capture** — which is what this case takes. Asserting it
      // on the escalated case below would fail against correct code.
      //
      // **`warning` is the fourth promised field and is deliberately NOT
      // here.** It appears only past `CAPTURES_BEFORE_WARNING` captures, so a
      // first capture correctly carries none. It has its own case below,
      // which is the only way to assert it without manufacturing that
      // forbidden failure.
      //
      // Spelled `capture.*` because the reply is an envelope: `capture` renews
      // the lease it was called on, so the value carries `claimId`, `tabId`,
      // `expiresAt` and `pageDriven` with the picture nested under `capture`.
      // Naming the path asserts that nesting too.
      valueFields: [
        'capture.captureId',
        'capture.path',
        'capture.width',
        'capture.height',
        'capture.bytes',
        // The three §3.11 promised and the shipped response omitted for the
        // whole life of the feature. They are the reason this list exists.
        'capture.sourceWidth',
        'capture.sourceHeight',
        'capture.tier',
        // Three of the four that the comment above used to record as an open
        // gap. Unconditional, except `escalation`, which is present exactly
        // because this capture is default-tier.
        'capture.estimatedTokens',
        'capture.capturesThisLease',
        'capture.escalation',
      ],
    },
  },
  {
    name: 'capture: a capture past the threshold carries the accounting warning',
    operation: 'capture',
    // ── The fourth field §3.11 promises, and the one that was worst ───────
    //
    // §3.11: *"Past a threshold, every capture is still served **and** carries
    // a warning"*, and the warning *"appears on **every** capture past the
    // threshold rather than only the first, because a warning that appears
    // once has scrolled away by the time it matters."*
    //
    // It appeared on **none**. `captureWarning` computed it correctly and on
    // every capture past the line, the `captures` row recorded `warned`
    // faithfully — and `pages.ts` did not copy the string into the reply. So
    // the database knew something the caller was never told, which is a
    // sharper defect than a missing number: the service had the finding and
    // withheld it.
    //
    // **This case is the assertion that it is told.** It is separate from the
    // default-tier case for a reason that is a property of the field rather
    // than a preference: `warning` is *correctly absent* below the threshold,
    // so it can only be asserted on a lease that has crossed it. The seed
    // crosses it.
    seed: pastTheCaptureWarningThreshold,
    input: {},
    expect: {
      outcome: 'accepted',
      // `capturesThisLease` alongside the warning deliberately: it is the
      // count the warning is *about*, and asserting both together is what
      // makes the pair legible to a caller reading the reply. A warning
      // without the number it refers to is the bare "you have taken a lot of
      // captures" that `accounting.ts` argues against.
      valueFields: ['capture.warning', 'capture.capturesThisLease'],
    },
  },
  {
    name: 'capture: an escalated tier changes the picture that comes back',
    operation: 'capture',
    // ── The assertion `check:argument-reachability` cannot make ───────────
    //
    // `tier` was read at the bridge, validated, packed into a request object,
    // and then dropped at the single `takeCapture` call site, which spread
    // only `fullPage` and `selector`. Every capture was taken at the default
    // rung whatever was asked for, and `tier: "max"` charged the caller a
    // written 8-200 character justification for it. The static check passed
    // throughout, exactly as its own table says it must: *"a branch that reads
    // an argument and drops it on the floor passes this."*
    //
    // So this case asserts the thing that actually failed: that passing the
    // argument **changes what comes back**. The runner drives the operation a
    // second time with `tier` and `reason` removed and requires the two
    // readings to differ, so a `tier` hard-wired to `"max"` fails here rather
    // than passing as a constant.
    //
    // `max` rather than `detail` because it is the rung that costs a reason,
    // which puts both arguments on the same case: `reason` is recorded only on
    // this tier (`pipeline.ts` — *"a reason attached to a capture nobody had to
    // justify would put noise into the one column the resolution study
    // reads"*), so the two travel together or not at all.
    //
    // ── What this case asserts about `reason`, stated honestly ───────────
    //
    // **It asserts that passing `reason` does not prevent the escalation, and
    // nothing more.** `reason` is genuinely **not observable** from any route:
    // it is written to the `captures` row and read back by no operation the
    // conformance suite can reach (`capture-store.ts` exposes `recordCapture`
    // and `capturesTakenBy`, and neither returns it). So there is no response
    // field and no driver call in which a dropped `reason` would show.
    //
    // It is named in `arguments` regardless, because the baseline must remove
    // it: `max` without a reason is **refused**, so a baseline that dropped
    // only `tier` would be measuring a refusal rather than the default rung.
    // Removing both is what makes the comparison a comparison.
    //
    // The one assertion that would close `reason` is a read path to the
    // capture's own record, which does not exist and is not invented here.
    seed: withALiveLease,
    input: {
      tier: 'max',
      reason: 'conformance: proving an escalated tier reaches the pipeline that acts on it',
    },
    expect: {
      outcome: 'accepted',
      effects: [
        {
          arguments: ['tier', 'reason'],
          expect: [
            {
              field: 'capture.tier',
              value: 'max',
              // The rung a caller lands on with no tier (`DEFAULT_TIER`).
              withoutArgument: 'default',
            },
            {
              // The **physical** consequence, not merely the label. `tier`
              // could be echoed back by a service that did nothing with it;
              // the width cannot. The fake produces 1280x720, so the default
              // rung's 1024 long edge shrinks it to 1024x576 while `max`'s
              // 2576 leaves it alone — never upscaled (`image.ts`: *"a picture
              // smaller than the rung is written as it is"*).
              //
              // This is the field that would have failed on the shipped
              // defect: every capture came back 1024 wide however it was
              // asked for.
              field: 'capture.width',
              value: 1280,
              withoutArgument: 1024,
            },
            {
              // The height, for the same reason as the width and as a
              // separate reading: the shrink is taken on the **long edge**,
              // so a change to `TIER_LONGEST_EDGE` that moved only one
              // dimension would leave the other's assertion standing.
              field: 'capture.height',
              value: 720,
              withoutArgument: 576,
            },
          ],
        },
      ],
    },
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
    name: 'sign in: a live lease holding a tab can ask a person to sign in',
    operation: 'sign_in',
    seed: withALiveLease,
    input: { what: 'conformance: the account dashboard' },
    expect: { outcome: 'accepted' },
  },
  {
    name: 'sign in: a request that does not say what it is signing into is refused',
    operation: 'sign_in',
    // The one free-text field relayed to a person verbatim by a third party,
    // so an empty one produces a request nobody can act on. Reached with a
    // real lease rather than a bad key, because a bad key would refuse on
    // `key.valid` first and the case would measure that instead (§3.14's
    // ordering is a property callers branch on).
    seed: withALiveLease,
    input: { what: '' },
    expect: {
      outcome: 'refused',
      code: 'sign_in_what_out_of_bounds',
      rule: 'signin.what_bounded',
    },
  },
  {
    name: 'sign in done: the lease that asked gives the browser back',
    operation: 'sign_in_done',
    seed: withARequestedSignIn,
    input: {},
    expect: { outcome: 'accepted' },
  },
  {
    name: 'sign in done: an unrecognised key is refused',
    operation: 'sign_in_done',
    input: { lease_key: NOT_A_KEY },
    expect: { outcome: 'refused', code: 'unrecognised_key', rule: 'key.valid' },
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
