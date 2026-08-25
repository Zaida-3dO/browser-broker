import path from 'node:path';

/**
 * Naming the files a comparison writes (`SCHEMA.md` §1.7a, §1.9).
 *
 * ── This module names files. It does not resolve them ───────────────────
 *
 * **Resolving a stored path under the artifact root belongs to
 * `src/artifacts/store.ts`, and this module deliberately does not do it.**
 * `ArtifactStore.write` and `ArtifactStore.resolve` both refuse a path that
 * escapes the root, and both ask the question in a way this module could not
 * have got right on its own: they test the **supplied name as well as the
 * computed result**, in **both path namespaces**, because a name that is
 * absolute in the other namespace is a legal relative filename here and
 * resolves quietly under the root — so the computed answer looks clean while
 * the input was an escape.
 *
 * That is a subtle enough trap that having two implementations of it would be
 * a liability rather than defence in depth: the second one is the one that
 * would be missing a case. So this module produces **relative path fragments
 * and file names**, and every join to a real location goes through the store.
 *
 * ── What §1.7a asks of a crop's name ────────────────────────────────────
 *
 * Crops "take the capture's name plus a region suffix, so they sort
 * immediately beside the picture they came from". That is the whole
 * requirement, and it is why the suffix goes **inside** the stem rather than
 * after the extension: a name ending in something other than the image
 * extension sorts nowhere useful and opens in nothing.
 */

/** The subfolder a comparison's images live in, per §1.7a. */
export const IMAGES_KIND = 'images';

/** Which of a region's two crops this is. */
export type CropSide = 'before' | 'after';

/**
 * Split a file name into its stem and extension, so a suffix lands before the
 * extension.
 *
 * Uses the forward-slash parser explicitly rather than the platform's own.
 * A stored path uses forward slashes whatever wrote it (`ArtifactStore.write`
 * normalises on the way out), so reading one with the host platform's parser
 * would give a different answer on the two platforms for the same stored row.
 */
function stem(fileName: string): { base: string; extension: string } {
  const extension = path.posix.extname(fileName);
  return { base: fileName.slice(0, fileName.length - extension.length), extension };
}

/**
 * The file name for one region crop.
 *
 * The index is the region's position in the ordered list, zero-based and
 * zero-padded to two digits, so a directory listing sorts the regions in the
 * order they were reported rather than putting the tenth between the first and
 * the second.
 *
 * **A name, not a path.** It is handed to `ArtifactStore.write`, which is what
 * decides where it lands and what refuses it if it would land outside.
 */
export function regionCropFileName(captureFileName: string, index: number, side: CropSide): string {
  const { base, extension } = stem(captureFileName);
  const numbered = String(index).padStart(2, '0');
  return `${base}-region-${numbered}-${side}${extension}`;
}

/** The file name for a diff's overlay, beside the capture it was drawn from. */
export function overlayFileName(captureFileName: string): string {
  const { base, extension } = stem(captureFileName);
  return `${base}-overlay${extension}`;
}

/**
 * The file name out of a stored relative path.
 *
 * A stored path uses forward slashes, so it is read with the forward-slash
 * parser — but a row written by an older build, or read on a platform whose
 * separator is the backslash, can carry the other spelling. Both are reduced
 * to the last segment, because taking the wrong one would name a directory as
 * though it were a file and produce a crop name built from part of a path.
 */
export function fileNameFrom(storedPath: string): string {
  return path.posix.basename(storedPath.replaceAll(String.fromCharCode(92), '/'));
}
