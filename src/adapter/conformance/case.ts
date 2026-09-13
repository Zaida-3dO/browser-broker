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

/**
 * One claim about the value an accepted operation returned.
 *
 * ── Why an argument's *effect* is a first-class expectation ─────────────
 *
 * `check-argument-reachability.mjs` proves a declared argument is **read at
 * the bridge**. That is necessary and it is not sufficient, and the gap is not
 * theoretical: `tier` was read at the bridge, validated, packed into a request
 * object, and then dropped at the single `takeCapture` call site, which spread
 * only `fullPage` and `selector`. Every capture was taken at the default rung
 * regardless of what was asked for — while `tier: "max"` charged the caller a
 * written 8–200 character justification for the privilege. The static check
 * passed for the whole life of the feature, and its own table says why: *"the
 * value read is forwarded correctly to the driver — NOT checked."*
 *
 * So the assertion that closes it is not *"was the argument read"* but
 * **"did the argument change what came back"**. An argument that is read and
 * then dropped produces a result identical to the one produced by not passing
 * it, and that identity is exactly what {@link ArgumentEffect} refuses to let
 * pass.
 *
 * ── What this can and cannot reach, which is not the same for every name ─
 *
 * It reaches an argument whose effect is **visible in the response**. `tier`
 * qualifies: it selects the rung the image is shrunk to, so it shows in
 * `capture.tier` and, physically, in `capture.width`.
 *
 * **It does not reach `reason`, and the reason is worth stating rather than
 * leaving as an omission somebody later reads as an oversight.** `reason` is
 * written to the `captures` row and returned by nothing — no operation a case
 * can drive reads it back. Nor does it reach the driver: the capture seam
 * takes `{fullPage, selector, mask}` and `driver.ts` says so in as many words
 * — *"No tier and no resolution. The driver takes the picture the page can
 * give."* `tier` is applied **after** the shutter, by the downscale. So for
 * these two names there is no driver call in which a dropped value would
 * show, and the phrase *"forwarded to the driver"* names something that does
 * not happen for either of them.
 *
 * What would close `reason` is a read path to a capture's own record. That is
 * a change to the service rather than to this harness, and it is not invented
 * here.
 *
 * ── Why it lives on the case rather than in a unit test ────────────────
 *
 * Because a case is crossed with **every route**, so one declaration asserts
 * the effect survives the CLI's argv-and-JSON round trip and the tool
 * surface's, not merely the service's own call. `tests/capture/pipeline.test.ts`
 * already exercises tiers, but its rig calls `takeCapture(...)` directly —
 * below the seam where this defect lived — so it could not have caught it, and
 * did not.
 */
export interface ArgumentEffect {
  /**
   * The field of the accepted value this effect is about.
   *
   * Spelled as the **service** spells it. Adapters shape presentation, but the
   * conformance drivers all read the value back as a record, so the field name
   * is the one place the routes already agree.
   *
   * **A dotted path**, resolved a step at a time, because an accepted value is
   * an envelope rather than a flat record: `capture` renews the lease it was
   * called on, so the picture is nested under `capture` beside `claimId` and
   * `expiresAt`. Naming `capture.tier` therefore asserts the shape of the
   * reply as well as the value in it.
   */
  readonly field: string;
  /**
   * What that field must be when the case's input is sent.
   *
   * Compared with `deepStrictEqual`, so a structured field is compared whole
   * rather than by identity.
   */
  readonly value: unknown;
  /**
   * What the field is when the argument is **not** sent — the baseline the
   * effect is measured against.
   *
   * **Required, and it is the entire point.** An expectation naming only the
   * wanted value is satisfiable by a constant: if `tier` were hard-wired to
   * `"max"` and the argument ignored, `{field: 'tier', value: 'max'}` alone
   * would pass while the argument remained as inert as it ever was. Naming
   * what the field is *without* the argument forces the two to differ, so the
   * assertion is about the argument's effect rather than about the field's
   * contents.
   *
   * The runner therefore drives the operation **twice** — once with the case's
   * input, once with the effect's arguments removed — and requires both
   * readings.
   */
  readonly withoutArgument: unknown;
}

/** The case expects the operation to be allowed. */
export interface AcceptExpectation {
  readonly outcome: 'accepted';
  /**
   * Fields the accepted value must carry, named and checked.
   *
   * Separate from {@link AcceptExpectation.effects} because presence is a
   * weaker and different claim: it says the response **conforms to what
   * `SCHEMA.md` §3.x promises**, without saying any argument caused it.
   * `sourceWidth`, `sourceHeight` and `tier` were promised by §3.11 and absent
   * from the shipped response for the entire life of capture, because nothing
   * anywhere compared a response against its own specification.
   *
   * A field listed here must be present and not `undefined`. The value is not
   * constrained — that is {@link AcceptExpectation.effects}' job.
   *
   * **Dotted paths**, for the reason {@link ArgumentEffect.field} gives: the
   * accepted value is an envelope, and §3.x's promises are about the object
   * nested inside it.
   */
  readonly valueFields?: readonly string[];
  /**
   * Arguments whose effect on the returned value is asserted.
   *
   * Each names the input keys it owns, so the runner can re-drive the
   * operation without them to establish the baseline.
   */
  readonly effects?: readonly {
    /** Input keys removed to produce the without-argument reading. */
    readonly arguments: readonly string[];
    readonly expect: readonly ArgumentEffect[];
  }[];
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
