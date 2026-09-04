import type { Adapter, AdapterId } from '../contract.ts';
import type { BrokerService } from '../service-seam.ts';
import type { ConformanceCase, CaseObservation, ObservedDriverCall } from './case.ts';

/**
 * How the suite drives one route, and the map that makes registering
 * mandatory.
 *
 * ── The typed map is the mechanism ──────────────────────────────────────
 *
 * {@link ConformanceDrivers} is `Record<AdapterId, ConformanceDriver>`, and
 * {@link AdapterId} is derived from the registry the application mounts
 * through. So a route added to that registry without a driver added here is a
 * **compile error on a missing key**, not a case that silently never runs.
 * That is `MILESTONES.md`'s requirement met by construction rather than by
 * review attention.
 *
 * The failure this prevents is specific: an adapter that is mounted and
 * serving callers, and absent from the parity matrix, so the rule it enforces
 * differently from everyone else is enforced differently in production and
 * nowhere in the suite.
 */

/** How the suite reaches one route. */
export interface ConformanceDriver {
  /** The adapter this drives. Read for its operations and its waivers. */
  readonly adapter: Adapter;
  /**
   * Run one case against this route and report what happened.
   *
   * `MILESTONES.md`: "Run in process wherever the process boundary is not the
   * thing under test — call the handler directly, drive the command line
   * through its entry point with an argument vector." So a driver is expected
   * to go through its route's real entry point, not around it. A driver that
   * called the service directly would be measuring the service twice and the
   * route never — the exact hollow shape that has been caught here before.
   */
  readonly run: (
    service: BrokerService,
    testCase: ConformanceCase,
    observe: Observation,
  ) => Promise<CaseObservation>;
}

/**
 * The physical observations a driver reports alongside the outcome.
 *
 * Supplied by the harness rather than found by the driver, because both
 * readings have to come from the same place for every route or the comparison
 * is between two different measurements rather than between two routes.
 */
export interface Observation {
  /** Every browser call so far, from the fake driver's own log, arguments included. */
  readonly driverCalls: () => readonly ObservedDriverCall[];
  /** Live claims, from the same predicate the capacity check uses. */
  readonly liveClaimCount: () => number;
}

/**
 * One driver per mounted route. **Every key is required.**
 *
 * Do not widen this to `Partial`, and do not add an index signature. Either
 * change turns the compile error that is this row's whole point into a
 * silently absent row in the matrix.
 */
export type ConformanceDrivers = Readonly<Record<AdapterId, ConformanceDriver>>;
