import { BrokerError } from '../errors.ts';

/**
 * The rejection taxonomy every guard draws from.
 *
 * `SCHEMA.md` §7 opens with the sentence this file is built around: "a rule
 * that never refuses anything protects nothing, so the refusals are the
 * specification". §3.14 then fixes the shape a refusal arrives in — a stable
 * code the caller matches on, the name of the rule that refused, a human
 * sentence, and any details.
 *
 * ── Why the code and the rule are two fields ────────────────────────────
 *
 * They answer different questions for different audiences, and collapsing
 * them loses one of the two.
 *
 * - **The rule** is the row in §7 that refused, spelled as §7 spells it. It
 *   is what somebody reading the ledger greps for, and it is what §8's parity
 *   assertion four counts over — "every rule in §7 appears in at least one
 *   refusal the service actually produced".
 * - **The code** is what a caller branches on. Several rules share one
 *   deliberately: `key.valid` and `claim.live` are separate rules with
 *   separate ledger rows, and a caller that has to handle *"the lease you
 *   named is not usable"* handles both identically. Deriving the code from
 *   the rule would make that collapse either impossible or invisible.
 *
 * ── What this table is, and what it is not ──────────────────────────────
 *
 * It is the **enumeration** of the ways this service says no, and the union
 * type over its keys is what makes an unlisted code a compile error rather
 * than a string somebody typed. It is **not** the guards themselves: nothing
 * in this file checks anything. A row here is a promise that the code exists,
 * not evidence that anything ever produces it — §8's assertion four is what
 * turns the second into a build failure, and it lands with the parity suite,
 * which needs operations to run.
 *
 * **So this file is deliberately not the whole of §7.1.** It carries the
 * refusals the rows built so far can actually produce, plus the one the
 * arbitration runner raises itself. §7.1's rows about capturing, reading,
 * evaluating and diffing are absent because the code that would raise them
 * does not exist, and a code nothing can raise is exactly the "assertion over
 * an empty set" `MILESTONES.md` names as passing forever and silently. Add
 * the row with the guard, never before it.
 */

/**
 * One entry in the taxonomy.
 *
 * `retryable` is the field worth explaining, because it is the one a caller
 * acts on without reading anything else: it says whether *doing the same
 * thing again later* could plausibly succeed. A browser that is starting will
 * finish starting; a lease that ended will never un-end; a browser name that
 * is not one of the two will never become one. Getting this wrong in the
 * generous direction teaches callers to hammer a refusal that is permanent,
 * which is why it is a declared property of the code rather than something
 * each surface infers from the sentence.
 */
export interface RefusalDefinition {
  /** The §7 rule that refuses with this code. */
  readonly rule: string;
  /** What the rule requires, in one line, for a person reading the table. */
  readonly summary: string;
  /** Could the identical call succeed later without anything else changing? */
  readonly retryable: boolean;
}

/**
 * Every refusal code this build can produce, and the §7 rule behind each.
 *
 * Written as an object rather than a list so the union below is the set of
 * its keys — which means a code that is not in this table does not type-check
 * at the throw site, and a table entry nothing throws shows up as an unused
 * key rather than hiding inside an array.
 */
export const REFUSALS = {
  /**
   * §7.1 `key.present`. Separate from `unrecognised_key` on purpose: a caller
   * that forgot the key entirely and a caller whose key is wrong need
   * different sentences, and merging them sends the first one hunting for a
   * lease that was never the problem.
   */
  key_missing: {
    rule: 'key.present',
    summary: 'Every operation except requesting a lease carries a key, written out by the caller.',
    retryable: false,
  },

  /**
   * §7.1 `key.valid`. What a caller gets for a key this store has never seen.
   */
  unrecognised_key: {
    rule: 'key.valid',
    summary: 'The key matches a lease.',
    retryable: false,
  },

  /**
   * §7.1 `claim.live`. Names the state it ended in and when, per §2.2 — a
   * caller told only "no" cannot tell a revoke it should escalate from an
   * expiry it should simply retry with a fresh lease.
   */
  lease_ended: {
    rule: 'claim.live',
    summary: 'That lease is queued or active.',
    retryable: false,
  },

  /**
   * §7.1 `claim.browser_known`, and §2.2's first outright refusal: "nothing
   * will ever make it valid", which is why waiting is not offered.
   */
  unknown_browser: {
    rule: 'claim.browser_known',
    summary: 'The browser named is one of the two.',
    retryable: false,
  },

  /**
   * §7.1 `claim.browser_kind_agrees`. `DECISIONS.md` §13i names two
   * processes on one machine holding **different configurations** as a real
   * scenario, and rules that "every disagreement is a nameable refusal
   * rather than a silently broken invariant" — this is that rule for the one
   * disagreement `INSERT OR IGNORE` cannot detect on its own: the insert is a
   * no-op when a row already exists, whatever kind it was created with, so a
   * name configured `regular` on this process and `private` on the one that
   * created the row would otherwise be handed a browser of the wrong kind in
   * silence. Checked immediately after the insert, inside the same
   * transaction, against the row as it now stands.
   *
   * Not retryable: the row's kind does not change by waiting, only by one of
   * the two processes reconfiguring.
   */
  browser_kind_mismatch: {
    rule: 'claim.browser_kind_agrees',
    summary: "A browser's stored kind agrees with the kind this process configured it as.",
    retryable: false,
  },

  /**
   * §7.1 `claim.purpose_bounded`. The bound §1.3 states — three to two
   * hundred characters, mandatory — checked before a row is written.
   *
   * ── Why this row exists at all ──────────────────────────────────────────
   *
   * Because until it did, the bound was enforced **only** by the column's
   * `CHECK (length(purpose) BETWEEN 3 AND 200)`, which is not a refusal: it
   * is a driver error raised after the statement is handed to the store. On
   * the command line it left the process with an unhandled `SqliteError` and
   * exit 1, and on the tool surface it came back as `unexpected_failure`
   * carrying the constraint text verbatim. Both told a caller the name of a
   * database constraint instead of the name of the argument they got wrong,
   * and the first of the two is indistinguishable from the service being
   * broken — on the first command anybody runs.
   *
   * **This is the rule §7.1 was missing rather than a new policy.** §1.3
   * already made the field mandatory and already fixed the bound; every other
   * bounded free-text field in the service had its refusal
   * (`feedback.note_bounded`, `evaluate.expression_bounded`,
   * `capture.max_tier_reason`) and this one did not. The naming follows those
   * — `<operation>.<field>_bounded` — rather than starting a second
   * convention beside them.
   *
   * Not retryable: the identical call, with the identical argument, fails
   * identically forever. What changes it is the caller writing a purpose, not
   * the caller waiting.
   */
  purpose_out_of_bounds: {
    rule: 'claim.purpose_bounded',
    summary: 'A claim carries a purpose, three to two hundred characters.',
    retryable: false,
  },

  /**
   * §1.3's attribution key, absent.
   *
   * ── Why this needs a code of its own rather than reusing the purpose's ──
   *
   * They are the same *shape* of defect — a surface coerced a missing
   * argument to the empty string and the service took it — but not the same
   * refusal, and the rule is looked up here precisely so a code and a rule
   * cannot drift apart. A caller branching on `purpose_out_of_bounds` would
   * go and rewrite a purpose that was never wrong.
   *
   * ── Why it is not retryable ─────────────────────────────────────────────
   *
   * Nothing about waiting supplies an identity the caller did not send
   * (§2.2). The same reasoning that makes `unknown_browser` permanent applies
   * unchanged: the request has to be re-made differently, not re-made later.
   */
  session_id_missing: {
    rule: 'claim.session_bounded',
    summary: 'A claim carries the identity of the session asking for it.',
    retryable: false,
  },

  /**
   * §5.5.1's last line: the private browser cannot be signed into.
   *
   * ── Why this is not `unknown_browser`, which it was at first ────────────
   *
   * The private browser **is** one of the two. Refusing it with the code for
   * a name that does not exist made the command report the rule
   * `claim.browser_known` — telling a person their browser name was wrong
   * when it was correct, and pointing them at the one rule that was not the
   * reason. The message said the right thing and the machine-readable fields
   * contradicted it, which is worse than either alone: a caller branching on
   * the rule would conclude it had a typo and retry the same word.
   *
   * The rule is looked up here rather than passed by the caller precisely so
   * that the pair cannot drift — so a refusal that needs a different rule
   * needs a different code, which is this one.
   *
   * Not retryable: the private browser's profile is ephemeral by design, so
   * no amount of waiting makes signing into it produce anything.
   */
  cannot_sign_in: {
    // §7.1 `browser.serving`, whose entry covers the signing-in cases. The
    // private browser is not available *to be signed into* — permanently,
    // which is why this code and `browser_unavailable` share a rule and
    // differ on the one field a caller acts on.
    rule: 'browser.serving',
    summary: 'The browser named keeps a profile that a sign-in can persist in.',
    retryable: false,
  },

  /**
   * §7.1 `browser.serving`, and §2.2's second: a browser being down is an
   * availability problem rather than a capacity one, so it is refused rather
   * than queued — the queue's promise is that capacity frees up, and nothing
   * about a failed browser promises that.
   */
  browser_unavailable: {
    rule: 'browser.serving',
    summary: 'The browser is available.',
    retryable: true,
  },

  /**
   * §7.1 `tab.owned` **and** `tab.open` produce this one code, and the
   * sharing is the point rather than an economy: §7.1 says outright that an
   * unowned tab gets "the same refusal as an unknown tab, so probing cannot
   * discover another lease's tabs". Two rules, two ledger rows, one code — a
   * caller able to tell them apart is a caller able to enumerate tabs it does
   * not own.
   */
  tab_not_found: {
    rule: 'tab.owned',
    summary: 'The tab belongs to this lease and is open.',
    retryable: false,
  },

  /** §7.1 `revoke.reason_required`. An operator taking capacity owes a sentence. */
  reason_required: {
    rule: 'revoke.reason_required',
    summary: 'A revoke carries a reason.',
    retryable: false,
  },

  /**
   * §7.1 `signin.what_bounded`. What a caller gets for a sign-in request that
   * does not say what is being signed into.
   *
   * ── Why this is not `purpose_out_of_bounds` ─────────────────────────────
   *
   * Same shape of defect, different field, and the table's own rule is that a
   * code and a rule are looked up together precisely so they cannot drift. A
   * caller branching on `purpose_out_of_bounds` would go and rewrite the
   * purpose it gave its *claim*, which was never wrong and is not what the
   * refusal is about.
   *
   * ── Why it matters more than an ordinary bound ──────────────────────────
   *
   * This is the one free-text field in the service that is **relayed to a
   * person verbatim by a third party**. Everything else a caller writes is
   * read by an operator with the ledger in front of them; this is read by
   * somebody who has been interrupted and told to go and type a password. An
   * empty one produces a request that reaches a person saying nothing about
   * what they are signing into, which is a request they cannot act on.
   *
   * Not retryable: the identical call with the identical argument fails
   * identically forever. What changes it is the caller writing a sentence.
   */
  sign_in_what_out_of_bounds: {
    rule: 'signin.what_bounded',
    summary: 'A sign-in request says what is being signed into, three to two hundred characters.',
    retryable: false,
  },

  /**
   * Not a §7.1 row, and it is here because the arbitration runner raises it
   * (`arbitration.ts`). An operation named on a surface that this build does
   * not register is a caller mistake rather than a crash, and it is the shape
   * a version mismatch between a caller and this service arrives in.
   */
  unknown_operation: {
    rule: 'arbitration.registered',
    summary: 'The operation named is one this build registers.',
    retryable: false,
  },
} as const satisfies Readonly<Record<string, RefusalDefinition>>;

/** Every code this build can refuse with. An unlisted one is a type error. */
export type RefusalCode = keyof typeof REFUSALS;

/** The codes as data, for a test that walks them. */
export const REFUSAL_CODES: readonly RefusalCode[] = Object.keys(REFUSALS) as RefusalCode[];

/**
 * A refusal from §7.1 — checked on a call, and the call does not happen.
 *
 * Distinct from `StartupRefusal` because the two are acted on differently and
 * by different code: a startup refusal means this process does not run at
 * all, and a call refusal means this one call did not, on a process that is
 * otherwise serving fine. An entry point that could not tell them apart would
 * either exit the process over a bad argument or carry on over a bad
 * configuration.
 *
 * **The rule is looked up rather than passed.** A caller supplies the code
 * and the table supplies the rule, so the pair cannot drift and a surface
 * cannot quietly attribute a refusal to a rule that did not make it.
 */
export class CallRefusal extends BrokerError {
  /** The stable code the caller matches on (§3.14). */
  readonly code: RefusalCode;

  /** Whether the identical call could succeed later. Read from the table. */
  readonly retryable: boolean;

  /**
   * The rest, shaped per refusal — §3.14's "any details". The state a lease
   * ended in, the position in the queue, the two numbers that disagreed.
   *
   * **Not the sentence and not a substitute for it.** The sentence is for a
   * person and is deliberately worded differently per surface (§3.14); this
   * is for a caller that has already branched on the code and now needs the
   * number.
   */
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: RefusalCode,
    message: string,
    options: { readonly detail?: Readonly<Record<string, unknown>>; readonly cause?: unknown } = {},
  ) {
    super(REFUSALS[code].rule, message, { cause: options.cause });
    this.name = 'CallRefusal';
    this.code = code;
    this.retryable = REFUSALS[code].retryable;
    this.detail = options.detail ?? {};
  }
}
