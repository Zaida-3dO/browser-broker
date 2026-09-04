import type { OperationName } from '../operations.ts';
import type { BrokerService, OperationOutcome } from '../service-seam.ts';

/**
 * A conformance case: authored **once per operation, never per route**.
 *
 * `MILESTONES.md`: "Cases are authored once per operation, never per route. A
 * case names an operation, a seed, an input and an expectation. The runner
 * takes the cross product with every driver exposing that operation, so a
 * case costs nothing per route — which is what stops the suite decaying at
 * the point where writing cases becomes tedious."
 *
 * The cost model is the argument. A suite where adding a route means
 * rewriting every case is a suite whose second route is written in a hurry
 * and whose third is not written at all.
 */

/** What the world looks like before the case runs. */
export interface CaseSeed {
  /**
   * Applied to the service under test before the operation is invoked.
   *
   * A function rather than data, because a seed has to be applied afresh for
   * **every** route the case is crossed with — otherwise the second route in
   * the matrix runs against the first one's leftovers and the two are not
   * being asked the same question.
   *
   * ── Why it returns values rather than only causing effects ─────────────
   *
   * Some of what a seed establishes is **only knowable after it has run**, and
   * a lease key is the example that forces this: it is minted by the claim, is
   * returned exactly once, and is not recoverable from anywhere (§2.2). So a
   * case needing a live lease cannot write the key into its input — nothing
   * knows it yet — and a case that wrote a placeholder would be asking the
   * service about a key it never issued.
   *
   * What comes back is merged over {@link ConformanceCase.input} before the
   * route is driven. Returning nothing is the ordinary case, for a seed whose
   * whole effect is on the service.
   *
   * **The merge happens once, in the runner**, so every route receives the
   * same substituted input. A driver doing its own substitution would be a
   * route deciding what it was asked — which is the shape the neutral-input
   * rule exists to prevent.
   */
  readonly apply: (
    service: BrokerService,
  ) => Promise<Readonly<Record<string, unknown>> | void> | Readonly<Record<string, unknown>> | void;
}

/** The case expects the operation to be allowed. */
export interface AcceptExpectation {
  readonly outcome: 'accepted';
}

/**
 * The case expects a rule to refuse.
 *
 * The code and the rule are compared; **the message is not** (`SCHEMA.md`
 * §3.14 — the sentence is worded differently per transport and is never
 * compared between them).
 */
export interface RefuseExpectation {
  readonly outcome: 'refused';
  readonly code: string;
  readonly rule: string;
}

export type CaseExpectation = AcceptExpectation | RefuseExpectation;

/** One case. */
export interface ConformanceCase {
  /** Unique, and read by a person when the case fails. */
  readonly name: string;
  readonly operation: OperationName;
  readonly seed?: CaseSeed;
  /**
   * The caller's input, in **neutral** terms.
   *
   * Each driver translates this into its own transport's vocabulary. It is
   * neutral rather than per-route for the same reason the case is authored
   * once: an input written in one route's spelling makes that route the
   * reference implementation and every other route a translation of it.
   */
  readonly input: Readonly<Record<string, unknown>>;
  readonly expect: CaseExpectation;
}

/**
 * What the runner observed for one case on one route.
 *
 * Both physical observations are here because `SCHEMA.md` §8 assertion 2
 * requires both, and they catch different bugs: "a guard that opens a tab and
 * closes it on the way to refusing leaves the count unchanged and the log
 * full; a guard that decrements a counter without telling the browser leaves
 * the log empty and the count wrong."
 */
/**
 * One browser call, as the harness sees it.
 *
 * **`detail` is carried, not just the name.** A shape holding only the name
 * can answer *"was the browser touched"* and never *"with what"*, and the
 * difference is the difference between a route that forwards an argument and
 * one that drops it — both of which touch the browser exactly once, so a
 * name-only reading finds them identical. A defect of exactly that shape
 * survived here: an adapter stopped forwarding an argument and every case
 * still passed, because nothing in this harness could see a payload.
 *
 * Deliberately structural rather than the fake driver's own call type: this
 * observation crosses a route boundary, and one route rebuilds it from what
 * it read rather than handing over the object it was given.
 */
export interface ObservedDriverCall {
  readonly name: string;
  /** The arguments the operation was called with, per operation. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface CaseObservation {
  readonly outcome: OperationOutcome;
  /** Every browser call the service made while this case ran. */
  readonly driverCalls: readonly ObservedDriverCall[];
  /** Live claims, read from **the same predicate the capacity check uses**. */
  readonly liveClaimCount: number;
}
