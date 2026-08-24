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
   */
  readonly apply: (service: BrokerService) => Promise<void> | void;
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
export interface CaseObservation {
  readonly outcome: OperationOutcome;
  /** Every browser call the service made while this case ran. */
  readonly driverCalls: readonly { readonly name: string }[];
  /** Live claims, read from **the same predicate the capacity check uses**. */
  readonly liveClaimCount: number;
}
