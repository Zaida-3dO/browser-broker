import { cliConformanceDriver } from '../../cli/conformance-driver.ts';
import { toolStdioConformanceDriver } from '../../tool/conformance-driver.ts';
import type { ConformanceDrivers } from './driver.ts';

/**
 * One conformance driver per mounted route.
 *
 * ── This object is the compile-time half of "an unregistered adapter fails
 *    the suite" ──────────────────────────────────────────────────────────
 *
 * Its type is `Record<AdapterId, ConformanceDriver>`, and `AdapterId` is
 * `keyof typeof ADAPTER_REGISTRY` — **the registry the application mounts
 * through**, not a list kept beside it. So the moment a route is added to
 * that registry, this object stops compiling with
 * `Property '<id>' is missing`, and the only way to make it compile is to
 * write that route's driver.
 *
 * `MILESTONES.md` asks for exactly this: "in a map typed from the route
 * registry the application actually mounts through, so adding a route without
 * adding its driver does not compile."
 *
 * ── What it does not catch, said plainly ────────────────────────────────
 *
 * A module that implements {@link Adapter} and was **never added to the
 * registry** is invisible here — no type can see a file nobody imported. That
 * half is closed at run time by the discovery walk in `discovery.ts`, which
 * finds adapter modules on disk and asserts each is registered. Neither half
 * substitutes for the other, and a reader who assumed this map alone was the
 * mechanism would be wrong in the direction that matters.
 *
 * **Do not widen this to `Partial`, and do not add an index signature.**
 * Either change converts the compile error into a silently absent row in the
 * matrix, which is the failure this file exists to prevent.
 */
export const CONFORMANCE_DRIVERS: ConformanceDrivers = {
  'tool-stdio': toolStdioConformanceDriver,
  cli: cliConformanceDriver,
};
