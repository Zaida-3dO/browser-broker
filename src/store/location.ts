import type { Environment } from '../config/environment.ts';
import { refuseNetworkLocation, type NetworkPathChecks } from './network-path.ts';

/**
 * Where the store file is.
 *
 * `store.location_from_environment_only` (`SCHEMA.md` §7.2): the location
 * comes from the environment and is never read from the database. The reason
 * is not a preference — **a value that is only readable after you have opened
 * the file cannot tell you which file to open**, and a wrong value stored
 * inside would be unfixable through the surface it broke (§6.1).
 *
 * That rule is held here structurally: this module imports the environment
 * snapshot and the network-path refusal, and **nothing from `open.ts`**. It
 * has no store client to read through, so there is no read path to police.
 */

/**
 * Resolve the store location, refusing a network one.
 *
 * **The checks run against both the value as it was configured and the value
 * after resolution, and the first of those is not redundant.**
 *
 * Resolving a path applies the host platform's own rules, and those rules
 * disagree about what a share even is: on a platform whose separator is the
 * forward slash, the two-backslash spelling is not a root at all — it is an
 * ordinary relative filename that happens to contain backslashes, so resolving
 * it prefixes the working directory and the share root is gone. A check that
 * only ever saw the resolved value would therefore refuse a share on one
 * platform and silently create a bizarrely-named local file on another, from
 * identical configuration.
 *
 * **A location that was not configured is not checked in its configured
 * form**, because there is no configured form to check — the resolved value is
 * a path this build computed from the platform's own application-data
 * location, and it is checked on its own account below.
 */
export function resolveStoreLocation(environment: Environment, checks?: NetworkPathChecks): string {
  const location = environment.databasePath;
  if (environment.configuredDatabasePath !== undefined) {
    refuseNetworkLocation(environment.configuredDatabasePath, checks);
  }
  refuseNetworkLocation(location, checks);
  return location;
}
