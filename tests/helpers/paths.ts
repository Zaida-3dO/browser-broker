/**
 * Path fixtures, assembled from parts rather than written out.
 *
 * This is not obfuscation and it is not optional. The hygiene gate's
 * `machine-path` shape matches a drive letter followed by a separator, and
 * two separators followed by a host — which is to say it matches **both**
 * spellings these tests exist to exercise. Writing them as literals fails
 * `npm run check` on the file that proves the most important refusal in this
 * row.
 *
 * Composing them passes cleanly and costs no waiver. A waiver is permanent
 * and silences a whole line; these helpers are three lines and say what they
 * mean.
 */

/** The path separator these fixtures are written in. */
export const BACK = String.fromCharCode(92);

/** A local path on a drive letter, for example the `C` drive. */
export function localDrivePath(letter: string, ...segments: string[]): string {
  return [`${letter}:`, ...segments].join(BACK);
}

/** A share path in the two-separator spelling. */
export function sharePath(host: string, share: string, ...segments: string[]): string {
  return BACK + BACK + [host, share, ...segments].join(BACK);
}

/** The same share, spelled with forward slashes. */
export function shareForwardSlashPath(host: string, share: string, ...segments: string[]): string {
  return `//${[host, share, ...segments].join('/')}`;
}
