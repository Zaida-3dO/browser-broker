import type { OperationName } from './operations.ts';
import type { BrokerService, OperationOutcome } from './service-seam.ts';

/**
 * What every route in is, and the registry the application mounts through.
 *
 * ── The mechanism, stated first because it is the row ───────────────────
 *
 * `MILESTONES.md` M5 is done when "every adapter passes the conformance
 * suite, and **adding a new one without registering it fails**". That is a
 * claim about a thing that has *not* been written yet, which makes it the
 * easiest kind of claim to make hollow: a harness that merely invites you to
 * register is worth nothing, because the failure it guards against is
 * somebody not doing the optional step.
 *
 * So it is enforced in two places, and it is worth knowing which does what:
 *
 * 1. **The compiler, for the driver map.** The conformance suite's driver map
 *    is typed `Record<AdapterId, ConformanceDriver>` where {@link AdapterId}
 *    is derived from {@link ADAPTER_REGISTRY} — *the same registry the
 *    application mounts through*, not a second list beside it. Add a route to
 *    the registry without adding its driver and `tsc` fails on a missing key.
 *    This is the half `MILESTONES.md` asks for by name: "in a map typed from
 *    the route registry the application actually mounts through, so adding a
 *    route without adding its driver does not compile."
 * 2. **The suite, for the registry itself.** A route that exists as a module
 *    but was never added to {@link ADAPTER_REGISTRY} is invisible to the
 *    compiler — there is no type that can see a file nobody imported. The
 *    suite closes that half at run time: it discovers every adapter module on
 *    disk and asserts each one is registered. An unregistered adapter fails
 *    that assertion.
 *
 * **Neither half alone is sufficient, and saying which is which is the
 * point.** (1) cannot catch an unregistered module; (2) cannot catch a
 * registered route whose driver was never written. Together they leave one
 * gap, named here rather than papered over: an adapter implemented somewhere
 * the discovery walk does not look. The walk's root is asserted by its own
 * test, so moving it is a visible change to a test rather than a silent one.
 */

/**
 * Why a route deliberately does not offer an operation.
 *
 * `MILESTONES.md`: "the commands with no operation behind them carry written
 * waivers (`SCHEMA.md` §5.5) rather than being quietly absent from the
 * matrix." A waiver is a sentence somebody had to write, which is what makes
 * it visible in a diff — an operation silently missing from an adapter is
 * indistinguishable from one nobody got round to.
 */
export interface OperationWaiver {
  readonly operation: OperationName;
  /** Why this route does not offer it. Must say something (asserted). */
  readonly reason: string;
}

/**
 * One route in.
 *
 * An adapter resolves its input, calls **one** service operation, and shapes
 * the result for its transport. It reaches no database and no guard directly
 * (`CLAUDE.md`; `db.import_isolated`, `SCHEMA.md` §7.3) — which is why
 * {@link Adapter.invoke} is handed the service rather than finding one.
 */
export interface Adapter {
  /** Stable identifier, used in the ledger and in conformance reporting. */
  readonly id: string;
  /** Prose, for a person reading the registry. */
  readonly description: string;
  /**
   * Whether this route offers only reads.
   *
   * `MILESTONES.md`: "A route is read-only **by declaration**, or fully
   * covered, with nothing in between — otherwise a driver that declines to
   * expose anything passes the first assertion vacuously." Declaring it is
   * what makes the waiver rule enforceable, because the alternative is
   * inferring read-only-ness from the very absence the rule is policing.
   */
  readonly readOnly: boolean;
  /** Every operation this route offers. */
  readonly operations: readonly OperationName[];
  /** Every operation it deliberately does not, each with its reason. */
  readonly waivers: readonly OperationWaiver[];
  /**
   * Perform one operation on this route, through the service.
   *
   * Takes the arguments in this route's own vocabulary — an argument vector
   * for the command line, a tool-call object for the tool surface — and
   * returns the service's outcome, so the conformance suite compares outcomes
   * rather than transports.
   */
  readonly invoke: (
    service: BrokerService,
    operation: OperationName,
    input: unknown,
  ) => Promise<OperationOutcome>;
}

/**
 * Every route this application mounts.
 *
 * **This is the registry, and it is the one the application uses.** Not a
 * manifest kept beside the real wiring — the moment there are two, the
 * conformance suite is asserting over the copy and the application is serving
 * from the other, and nothing reports the difference. Every consumer, the
 * suite included, reads this.
 *
 * `SCHEMA.md` §8: there are **two routes, not three**, because nothing is
 * served (§4). The generated operations document is not a route: it performs
 * no operation and refuses nothing, so it has nothing to be at parity with.
 * Do not add it here.
 */
export const ADAPTER_REGISTRY = {
  cli: 'The command line. In process, because there is nothing else for a command to talk to.',
} as const satisfies Readonly<Record<string, string>>;

/**
 * The identifier of a mounted route.
 *
 * Derived from the registry rather than declared beside it — the derivation
 * is the whole mechanism. `Record<AdapterId, …>` is a type that changes the
 * moment {@link ADAPTER_REGISTRY} does, so a map keyed by it stops compiling
 * when a route is added and its entry is not.
 *
 * The tool surface over stdio (row #27) joins this registry when it lands,
 * and the compiler will require its conformance driver in the same change.
 * That is the intended experience, not an inconvenience.
 */
export type AdapterId = keyof typeof ADAPTER_REGISTRY;

/** Every mounted route's identifier, in a stable order. */
export const ADAPTER_IDS: readonly AdapterId[] = Object.keys(ADAPTER_REGISTRY) as AdapterId[];

/** Whether a string names a mounted route. */
export function isAdapterId(value: string): value is AdapterId {
  return Object.prototype.hasOwnProperty.call(ADAPTER_REGISTRY, value);
}
