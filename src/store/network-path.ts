import fs from 'node:fs';
import path from 'node:path';

import { StartupRefusal } from '../errors.ts';

/**
 * `store.not_on_network_filesystem` (`SCHEMA.md` §7.2, §1.0).
 *
 * The write-ahead log coordinates through a shared-memory index that requires
 * every process using the database to be on the same host. On a network
 * filesystem that requirement is not met, and the failure is not a clean
 * error — it is two hosts each believing they hold the writer's position,
 * which is corruption rather than contention. So this is a refusal to run,
 * not a warning.
 *
 * ── Why there are two checks and not one ────────────────────────────────
 *
 * §1.0's table is explicit: a path written as a share directly is caught by
 * reading its root, but **a mapped network drive is lexically identical to a
 * local one**. There is nothing in the string to read. A check that only
 * inspects the string passes on every machine with nothing mapped, which is
 * every machine anybody writes the test on — so the second check has to ask
 * the operating system what the volume actually is.
 *
 * ── How the second check asks ───────────────────────────────────────────
 *
 * By resolving the path to its real location. On Windows a mapped drive
 * resolves to the share it points at, which turns an invisible case into the
 * visible one the first check already handles — so the second check reduces
 * to the first, applied to the resolved path.
 *
 * The alternative is asking the platform's management interface for the
 * volume's drive-type code in a subprocess. It answers correctly and it was
 * measured, and it is not used here: it costs between roughly 0.7 and 1.1
 * seconds per call, against a process startup this design puts at tens of
 * milliseconds and a service that is spawned once per session. Paying a
 * second on every spawn to learn something a filesystem call answers in a
 * fraction of a millisecond would invalidate the startup measurement the
 * storage decision rests on. It stays documented here as the fallback if a
 * mapping is ever found that does not resolve.
 *
 * Filesystem statistics are **not** a route to this answer, and the reason is
 * worth keeping: the type field reports the same value for a local volume and
 * a mapped network one, so an implementation built on it looks correct, tests
 * green, and refuses nothing.
 */

/** A path that does not exist yet cannot be resolved; walk up to one that does. */
function nearestExistingAncestor(target: string): string {
  let candidate = path.resolve(target);
  // The loop terminates: `path.dirname` of a root is the root itself.
  for (;;) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return candidate;
    }
    candidate = parent;
  }
}

/**
 * Resolve a path to its real location, following any mapping.
 *
 * The store file does not exist on a first spawn, and resolving a path that
 * is not there throws — so what gets resolved is the nearest ancestor that
 * does exist. That ancestor is on the same volume as the file will be, which
 * is the only property this check needs from it.
 */
export function resolveRealPath(target: string): string {
  try {
    return fs.realpathSync.native(nearestExistingAncestor(target));
  } catch {
    // A path that cannot be resolved at all is left as it was written. The
    // root check below still runs on it, and the store open that follows
    // will fail for its own reasons with a better message than this one
    // could invent.
    return path.resolve(target);
  }
}

/**
 * Is this path's root a network share?
 *
 * Both separator spellings are tested. The platform path parser reports the
 * share prefix as the root for the backslash spelling, and reports the
 * forward-slash spelling **unchanged** rather than normalising it — so
 * matching one spelling really does catch only half the cases.
 */
export function hasNetworkShareRoot(target: string): boolean {
  const root = path.win32.parse(target).root;
  if (root === '') {
    return false;
  }
  const normalised = root.replace(/\//g, '\\');
  // A share root is two separators, then a host, then a share. Two
  // separators alone is a root-relative path on the current drive, which is
  // local.
  return /^\\\\[^\\]+\\/.test(normalised);
}

/**
 * The two checks, taking their inputs as functions.
 *
 * Injectable because the refusal has to be provable without a mapped drive.
 * A continuous-integration runner has nothing mapped by definition, so a test
 * that could only refuse a real network volume would be a test that never
 * refuses anything — and `CLAUDE.md` is explicit that a guard proven only to
 * allow protects nothing.
 */
export interface NetworkPathChecks {
  /** Resolve a path to its real location, following any mapping. */
  readonly resolveRealPath: (target: string) => string;
  /** Report whether a path's root is a network share. */
  readonly hasNetworkShareRoot: (target: string) => boolean;
}

export const realChecks: NetworkPathChecks = {
  resolveRealPath,
  hasNetworkShareRoot,
};

/**
 * Refuse a network location.
 *
 * Returns nothing on purpose. What check two resolves is the nearest
 * *existing ancestor* of the store path, not the store path itself, so the
 * resolved string is an answer to "which volume is this on" and would be
 * wrong used as a location. The caller keeps the path it asked about.
 */
export function refuseNetworkLocation(
  target: string,
  checks: NetworkPathChecks = realChecks,
): void {
  // Check one: the path as written names a share.
  if (checks.hasNetworkShareRoot(target)) {
    throw new StartupRefusal(
      'store.not_on_network_filesystem',
      `The store location is on a network share. The write-ahead log requires every process using the database to be on one host, so a network location is refused rather than risked. Set BROKER_DB to a local path.`,
    );
  }

  // Check two: the path as written looks local, and resolving it says
  // otherwise. This is the mapped-drive case, and it is the reason one check
  // is not enough.
  const real = checks.resolveRealPath(target);
  if (checks.hasNetworkShareRoot(real)) {
    throw new StartupRefusal(
      'store.not_on_network_filesystem',
      `The store location resolves to a network share. A mapped network drive is indistinguishable from a local one by its path alone, and the write-ahead log requires every process using the database to be on one host. Set BROKER_DB to a local path.`,
    );
  }
}
