import fs from 'node:fs';
import path from 'node:path';

import { StartupRefusal } from '../errors.ts';
import {
  isNetworkVolumeType,
  networkFilesystemName,
  type ReadVolumeStatistics,
  type VolumeStatistics,
} from './network-volume.ts';

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
 * ── Why one check is not enough ─────────────────────────────────────────
 *
 * §1.0's table is explicit: a path written as a share directly is caught by
 * reading its root, but **a mapped network drive is lexically identical to a
 * local one**. There is nothing in the string to read. A check that only
 * inspects the string passes on every machine with nothing mapped, which is
 * every machine anybody writes the test on — so a second check has to ask the
 * operating system what the volume actually is.
 *
 * ── The three checks, and why the third is not the second again ─────────
 *
 * | | What it asks | What it catches |
 * |---|---|---|
 * | One | Does the path's root name a share? | A share written out directly, in either separator spelling |
 * | Two | Does the path *resolve* to one? | A mapped drive, on the platform where mappings resolve to the share behind them |
 * | Three | What does the volume's own type code say? | A mount on a platform that has no share spelling to read and no mapping to resolve |
 *
 * **Checks one and two cover exactly one platform's spelling of the problem.**
 * On a platform whose separator is the forward slash, a mounted network volume
 * lives at an ordinary absolute path with no share prefix and nothing to
 * resolve to one — it is a directory as far as every string operation is
 * concerned. That is the same argument the mapped drive makes, transposed, and
 * it needs its own check for the same reason. Check three is in
 * `network-volume.ts` with its own limits written down.
 *
 * **A guard developed on one platform is untested on the other by
 * construction**, so the tests drive all three through injected inputs and
 * refuse on every platform rather than on the one they were written on.
 *
 * ── How check two asks ──────────────────────────────────────────────────
 *
 * By resolving the path to its real location. Where a mapped drive resolves to
 * the share it points at, that turns an invisible case into the visible one
 * check one already handles — so it reduces to check one, applied to the
 * resolved path.
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
 * Filesystem statistics are **not** a route to that answer on the platform
 * with drive letters, and the reason is worth keeping: there the type field
 * reports the same value for a local volume and a mapped network one, so an
 * implementation built on it looks correct, tests green, and refuses nothing.
 * That is why check three stands beside check two rather than standing in for
 * it — each is blind exactly where the other sees.
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
 * Read the volume statistics for a path, walking up to an ancestor that
 * exists for the same reason resolution does — the store file is not there on
 * a first spawn, and the ancestor is on the volume the file will be on.
 *
 * A path whose statistics cannot be read reports nothing rather than throwing.
 * That is a deliberate allow: refusing on an unreadable answer would refuse
 * paths for reasons that have nothing to do with a network, and the store open
 * that follows fails with a better message than this could invent.
 */
export function readVolumeStatistics(target: string): VolumeStatistics | undefined {
  try {
    return fs.statfsSync(nearestExistingAncestor(target));
  } catch {
    return undefined;
  }
}

/**
 * The checks, taking their inputs as functions.
 *
 * Injectable because the refusal has to be provable without a mapped drive or
 * a mounted network volume. A continuous-integration runner has neither by
 * definition, so a test that could only refuse a real one would be a test that
 * never refuses anything — and `CLAUDE.md` is explicit that a guard proven
 * only to allow protects nothing.
 */
export interface NetworkPathChecks {
  /** Resolve a path to its real location, following any mapping. */
  readonly resolveRealPath: (target: string) => string;
  /** Report whether a path's root is a network share. */
  readonly hasNetworkShareRoot: (target: string) => boolean;
  /** Report what the platform says about the volume a path is on. */
  readonly readVolumeStatistics: ReadVolumeStatistics;
}

export const realChecks: NetworkPathChecks = {
  resolveRealPath,
  hasNetworkShareRoot,
  readVolumeStatistics,
};

/**
 * Refuse a network location.
 *
 * Returns nothing on purpose. What check two resolves is the nearest
 * *existing ancestor* of the store path, not the store path itself, so the
 * resolved string is an answer to "which volume is this on" and would be
 * wrong used as a location. The caller keeps the path it asked about.
 *
 * **Surrounding blank space is stripped before any check runs.** A value with
 * a leading space is a value somebody typed with a leading space, and every
 * check here reads the front of the string: the share-root test sees a space
 * where it expects a separator and reports no root, and resolution treats the
 * whole thing as a relative name. One invisible character would walk a share
 * past all three, which is a guard defeated by a typing accident rather than
 * by anything anybody meant.
 */
export function refuseNetworkLocation(
  target: string,
  checks: NetworkPathChecks = realChecks,
): void {
  const candidate = target.trim();

  // Check one: the path as written names a share. Tested before resolution,
  // for the reason above.
  if (checks.hasNetworkShareRoot(candidate)) {
    throw new StartupRefusal(
      'store.not_on_network_filesystem',
      `The store location is on a network share. The write-ahead log requires every process using the database to be on one host, so a network location is refused rather than risked. Set BROKER_DB to a local path.`,
    );
  }

  // Check two: the path as written looks local, and resolving it says
  // otherwise. This is the mapped-drive case, and it is the reason one check
  // is not enough.
  const real = checks.resolveRealPath(candidate);
  if (checks.hasNetworkShareRoot(real)) {
    throw new StartupRefusal(
      'store.not_on_network_filesystem',
      `The store location resolves to a network share. A mapped network drive is indistinguishable from a local one by its path alone, and the write-ahead log requires every process using the database to be on one host. Set BROKER_DB to a local path.`,
    );
  }

  // Check three: nothing in the string says share on this platform because
  // this platform has no share spelling — so the volume is asked what it is.
  const statistics = checks.readVolumeStatistics(candidate);
  if (statistics !== undefined && isNetworkVolumeType(statistics.type)) {
    const name = networkFilesystemName(statistics.type) ?? 'a network filesystem';
    throw new StartupRefusal(
      'store.not_on_network_filesystem',
      `The store location is on a network filesystem (${name}). A mount point is indistinguishable from an ordinary directory by its path alone, and the write-ahead log requires every process using the database to be on one host. Set BROKER_DB to a path on a local disk.`,
    );
  }
}
