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
 * Row #7 and #8 add the test that seeds a location-shaped row and asserts it
 * is ignored, which needs a schema to seed into.
 */
export function resolveStoreLocation(environment: Environment, checks?: NetworkPathChecks): string {
  const location = environment.databasePath;
  // Checked as configured as well as resolved: a share-shaped value loses its
  // root when a platform that does not recognise the spelling resolves it.
  refuseNetworkLocation(environment.configuredDatabasePath, checks);
  refuseNetworkLocation(location, checks);
  return location;
}
