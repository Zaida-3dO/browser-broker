/**
 * The network-volume check for platforms whose separator is the forward slash.
 *
 * ── Why this file exists at all ─────────────────────────────────────────
 *
 * The share-root check reads a path's root and refuses a two-separator
 * spelling. That is the whole of the detection on a platform that spells a
 * share that way. **On a platform that does not, there is nothing in the
 * string to read**: a mount lives at an ordinary absolute path, and a mount
 * point is lexically identical to a directory. The mapped-drive argument of
 * `SCHEMA.md` §1.0 transposes exactly — a check that only inspects the string
 * passes on every machine with nothing mounted, which is every machine
 * anybody writes the test on.
 *
 * The failure it is guarding is the same one and it is not a clean error: the
 * write-ahead log coordinates through a shared-memory index that requires
 * every process using the database to be on one host. Two hosts each believing
 * they hold the writer's position is corruption rather than contention.
 *
 * ── How this asks ───────────────────────────────────────────────────────
 *
 * Filesystem statistics report a type code for the volume a path is on, and on
 * a platform whose separator is the forward slash that code distinguishes a
 * network filesystem from a local one. So the volume is asked what it is,
 * rather than the string being asked what it looks like.
 *
 * > **The same call is not a route to this answer on the platform with drive
 * > letters, and the reason is worth keeping**: there the type field reports
 * > the same value for a local volume and a mapped network one, so an
 * > implementation built on it looks correct, tests green, and refuses
 * > nothing. That platform is served by resolving the path instead, which
 * > turns its invisible case into the visible one — and this file is not
 * > consulted there.
 *
 * ── Why a list of codes rather than a property ──────────────────────────
 *
 * There is no "is this remote" flag to read. The type code is the only thing
 * reported that distinguishes the filesystems at all, so the check is a
 * membership test against the codes the network filesystems in ordinary use
 * report. That has a known and stated limit: **a network filesystem whose code
 * is not below is not detected.** The list is the mitigation for the common
 * cases rather than a proof over all of them, and saying so is better than
 * implying a completeness this cannot have.
 */

/**
 * The type codes network filesystems report.
 *
 * Each is the constant that filesystem's own implementation reports for a
 * mounted volume of its kind. They are magic numbers in the literal sense —
 * fixed values with no derivation — so they are written down with the name of
 * what reports them and nothing else to check them against.
 */
export const NETWORK_FILESYSTEM_TYPES: ReadonlyMap<number, string> = new Map([
  // Server message block, versions one through three — the protocol the
  // drive-letter platform's shares also speak, mounted natively here.
  [0x517b, 'SMB'],
  [0xfe534d42, 'SMB2'],
  [0xff534d42, 'CIFS'],
  // Network file system, versions two through four.
  [0x6969, 'NFS'],
  // Andrew file system, and its open reimplementation.
  [0x5346414f, 'AFS'],
  [0x6b414653, 'AFS (OpenAFS)'],
  // Netware core protocol.
  [0x564c, 'NCP'],
  // A filesystem in user space, which is how most user-mounted network
  // filesystems arrive. Not every one of these is remote — the code says
  // "a program is serving this", not "a program on another host is serving
  // this" — and that is stated plainly below rather than hidden.
  [0x65735546, 'FUSE'],
  [0x65735543, 'FUSE (control)'],
  // Cluster filesystems, which are shared between hosts by definition and so
  // break the one-host requirement for the same reason a mount does.
  [0x47504653, 'GPFS'],
  [0x7461636f, 'OCFS2'],
]);

/** What the platform reports about the volume a path is on. */
export interface VolumeStatistics {
  readonly type: number;
}

/**
 * Read the volume statistics for a path, or report that they could not be
 * read.
 *
 * Injected rather than called directly, so the refusal is provable without a
 * mounted network volume — a continuous-integration runner has nothing mounted
 * by definition, so a test that could only refuse a real one would be a test
 * that never refuses anything.
 */
export type ReadVolumeStatistics = (target: string) => VolumeStatistics | undefined;

/**
 * Is this path on a filesystem whose type code says it is served over a
 * network?
 *
 * A path whose statistics cannot be read is **not** refused. The store open
 * that follows fails for its own reasons with a better message than this could
 * invent, and refusing on an unreadable answer would refuse every path that
 * does not exist yet — which is every path on a first spawn.
 */
export function isNetworkVolumeType(type: number): boolean {
  return NETWORK_FILESYSTEM_TYPES.has(type);
}

/** The name of the filesystem a type code belongs to, for the refusal message. */
export function networkFilesystemName(type: number): string | undefined {
  return NETWORK_FILESYSTEM_TYPES.get(type);
}
