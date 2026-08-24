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
