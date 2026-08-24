import path from 'node:path';

/**
 * Where a diff's files live, and the one rule about how they are named
 * (`SCHEMA.md` §1.7a, §1.9).
 *
 * ── Every path stored is relative to the artifact root ──────────────────
 *
 * §1.7a: "Every path stored in the database is relative to that root — never
 * absolute. The root can move, and an absolute path pins every row to one
 * machine's layout the moment it is written." The database enforces the same
 * thing from underneath: `captures.path` and `comparisons.overlay_path` both
 * carry a check constraint refusing a value that starts like a root, in either
 * platform's spelling.
 *
 * So every function here produces a **relative** path, assembled from segments,
 * and the join to the root happens in exactly one place — `resolveArtifact`
 * below, which is the only thing in this build that turns a stored path into a
 * filesystem path.
 *
 * ── One tree, under a lease ─────────────────────────────────────────────
 *
 * §1.7a: "Everything the service writes is under a lease, because a lease is
 * the unit you delete. There is no second area holding images that outlive a
 * lease." Crops from a diff are images belonging to whoever took the capture,
 * so they go in that lease's `images` directory beside the capture — and §1.7a
 * says they take "the capture's name plus a region suffix, so they sort
 * immediately beside the picture they came from".
 */

/** The directory under a lease that images live in. §1.7a. */
export const IMAGES_DIRECTORY = 'images';

/** The directory every lease's tree hangs from. §1.7a. */
export const CLAIMS_DIRECTORY = 'claims';

/**
 * A stored path is built from these segments and nothing else.
 *
 * A separate function from the joining below so the shape is stated once. Uses
 * a forward slash rather than the platform separator, deliberately: a stored
 * path is data that outlives the machine that wrote it, and a database full of
 * backslashes is unreadable on a host that does not use them. The read side
 * normalises, so both spellings resolve.
 */
function storedPath(segments: readonly string[]): string {
  return segments.join('/');
}

/** Where one lease's images live, relative to the artifact root. */
export function imagesDirectory(claimId: string): string {
  return storedPath([CLAIMS_DIRECTORY, claimId, IMAGES_DIRECTORY]);
}

/**
 * Strip a file name's extension, so a suffix lands before it rather than
 * after.
 *
 * A crop named `page-view-1024-when-id.png-before` sorts nowhere useful and
 * opens in nothing. §1.7a wants crops sorting "immediately beside the picture
 * they came from", which needs the suffix inside the stem.
 */
function stem(fileName: string): { base: string; extension: string } {
  const extension = path.posix.extname(fileName);
  return { base: fileName.slice(0, fileName.length - extension.length), extension };
}

/** Which of a region's two crops this is. */
export type CropSide = 'before' | 'after';

/**
 * The stored path for one region crop.
 *
 * The index is the region's position in the ordered list, zero-based and
 * zero-padded to two digits, so a directory listing sorts the regions in the
 * order they were reported rather than putting the tenth between the first and
 * the second.
 */
export function regionCropPath(
  claimId: string,
  captureFileName: string,
  index: number,
  side: CropSide,
): string {
  const { base, extension } = stem(captureFileName);
  const numbered = String(index).padStart(2, '0');
  return storedPath([imagesDirectory(claimId), `${base}-region-${numbered}-${side}${extension}`]);
}

/** The stored path for a diff's overlay. */
export function overlayPath(claimId: string, captureFileName: string): string {
  const { base, extension } = stem(captureFileName);
  return storedPath([imagesDirectory(claimId), `${base}-overlay${extension}`]);
}

/**
 * Raised when a stored path would escape the artifact root.
 *
 * Not a refusal a caller can provoke, because no caller supplies a path
 * (§1.9). It is the assertion that the *service* has not constructed one, and
 * it exists because the alternative to noticing here is writing a file
 * somewhere nobody expected.
 */
export class ArtifactPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactPathError';
  }
}

/**
 * Turn a stored, relative path into a filesystem path under the artifact root.
 *
 * **This is the only place in the build that joins the two**, which is what
 * makes `artifact.no_request_path` (§7.3) checkable at all: a rule asserting
 * that no path-serving surface accepts a caller's path needs the set of
 * joining sites to be one, or it has to argue about every one of them.
 *
 * The containment check is **not** the mechanism, and reading it as one would
 * be the mistake this comment exists to prevent. §1.9 states the mechanism
 * plainly: the endpoint "serves paths recorded in the database ... **It never
 * accepts an arbitrary path from a request**, so there is no traversal to
 * defend against: the only strings it can be asked for are identifiers of
 * rows, and the path is looked up rather than supplied."
 *
 * The check below therefore guards against **this service** writing or reading
 * a path it constructed wrongly — a file name derivation that let a separator
 * through, a stored row from an older build. It is a correctness assertion on
 * our own data, not a sanitiser standing between a caller and the filesystem,
 * and a sanitiser is exactly what §1.9 says must not be the defence.
 */
export function resolveArtifact(artifactsRoot: string, stored: string): string {
  if (stored === '') {
    throw new ArtifactPathError('An artifact path is empty, so there is nothing to resolve.');
  }
  if (path.isAbsolute(stored) || /^[A-Za-z]:/.test(stored) || stored.startsWith('\\')) {
    throw new ArtifactPathError(
      `The artifact path ${JSON.stringify(stored)} is absolute. Section 1.7a: every path stored is relative to the artifact root, never absolute.`,
    );
  }

  const root = path.resolve(artifactsRoot);
  const resolved = path.resolve(root, stored);
  const relative = path.relative(root, resolved);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ArtifactPathError(
      `The artifact path ${JSON.stringify(stored)} resolves outside the artifact root. Nothing this service stores can, so this is a constructed path that is wrong rather than a request that was refused.`,
    );
  }

  return resolved;
}
