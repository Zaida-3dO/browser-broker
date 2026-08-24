import type { OperationName } from './operations.ts';

/**
 * The shape an adapter calls, and the whole of what an adapter may reach.
 *
 * ── This is a seam, and it is a stub. Read this before building on it. ──
 *
 * The service layer is row #10 onward and **is not built yet**. This file
 * declares the shape rows #25 and #29 need in order to exist at all, so the
 * adapter contract and the command line can be written, tested and reviewed
 * against something rather than waiting. It is deliberately the *narrowest*
 * shape that supports the parity claim: one call in, one outcome out.
 *
 * **What that costs, stated plainly rather than implied away:** nothing here
 * checks that the implementation behind this seam is the real service. A
 * conforming implementation of {@link BrokerService} could be anything —
 * including, in principle, an adapter's own logic wearing the interface. The
 * rule that actually forbids that is `db.import_isolated` (`SCHEMA.md` §7.3),
 * a **build** rule, precisely because a type cannot express "and you did not
 * reimplement this". This interface makes the correct path the easy one and
 * gives the conformance suite something to hold; it does not make the rule
 * true by construction, and a comment claiming otherwise would be the kind of
 * false assurance §7.3 exists to replace.
 *
 * When the service layer lands, the join is: the real implementation
 * satisfies {@link BrokerService}, and this file's declarations either move
 * into it or are re-exported from it. Nothing else in the adapter layer
 * should need to change — that is the property this seam is shaped for.
 */

/**
 * What a caller asked for.
 *
 * Arguments stay an opaque record here on purpose. Per-operation argument
 * types belong to the operations that own them (rows #21 through #24 and
 * onward); pinning them now would mean writing ten shapes this row cannot
 * test and the service would then have to match. What this row owes is the
 * **envelope**, which is the part parity is asserted on.
 */
export interface OperationRequest {
  readonly operation: OperationName;
  /**
   * The route this request arrived on, carried so the service can record it.
   * `SCHEMA.md` §1.6 keeps one row per decision; which door a decision came
   * in through is a fact an operator reading the ledger wants.
   */
  readonly adapter: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * An operation that was allowed.
 *
 * `queued` is an outcome and not a failure (§5.6: exit codes are chosen so
 * that queuing counts as accepted), which is why there is one accepted shape
 * rather than a granted one and a queued one.
 */
export interface OperationAccepted {
  readonly outcome: 'accepted';
  /** What the caller gets back. Per-operation, and shaped by the adapter. */
  readonly value: Readonly<Record<string, unknown>>;
}

/**
 * An operation a rule refused.
 *
 * `SCHEMA.md` §3.14: every refusal carries a **stable code** the caller
 * matches on, the **name of the rule** that refused (§7), a human sentence,
 * and any details. "The code and the rule name are identical on every
 * surface; the sentence is deliberately worded differently for a terminal and
 * for a tool result, and is never compared between them."
 *
 * That last clause is why {@link OperationRefused.message} exists but the
 * conformance suite never compares it: asserting text is brittle and a weaker
 * claim than asserting the code.
 */
export interface OperationRefused {
  readonly outcome: 'refused';
  /** The stable identifier a caller branches on. */
  readonly code: string;
  /** The rule that refused, spelled as §7 spells it — `capacity.admission`. */
  readonly rule: string;
  /** For a person. Worded for the transport, and never compared across them. */
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type OperationOutcome = OperationAccepted | OperationRefused;

/**
 * The service, as an adapter sees it.
 *
 * One method, because an adapter's whole job is to resolve its input, call
 * **one** service operation and shape the result for its transport
 * (`CLAUDE.md`, `SCHEMA.md` §8). A wider interface — one method per
 * operation — would let an adapter compose two calls and call the result one
 * operation, which is the seam through which a route grows its own rules.
 */
export interface BrokerService {
  readonly perform: (request: OperationRequest) => Promise<OperationOutcome>;
}

/**
 * Every rule this build's service can refuse with.
 *
 * `SCHEMA.md` §8 assertion 4: *"every rule in §7 appears in at least one
 * refusal the service actually produced — computed from what the service
 * returned, never from what a test declared. A new rule therefore fails the
 * build until it has a case."*
 *
 * The registry lives behind this seam because it is the **service's** list,
 * not the adapter layer's: the rules are enforced there, and a list assembled
 * by the adapter layer would be a second copy free to drift from the one
 * doing the enforcing. Row #10 owns the taxonomy and this becomes its export.
 *
 * It is a mutable-by-construction registry rather than a constant so that the
 * conformance suite can be run against a service under test — but it is
 * **never empty**, and the suite asserts that directly, because
 * `MILESTONES.md` calls out an assertion over an empty set as one that
 * "passes forever and silently".
 */
export interface RuleRegistry {
  /** Every rule name, in a stable order. */
  readonly names: readonly string[];
}
