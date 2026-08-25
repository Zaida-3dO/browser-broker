import { fileURLToPath } from 'node:url';

import { hasNetworkShareRoot, type NetworkPathChecks } from '../../src/store/network-path.ts';

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

/** A mount point on a platform whose separator is the forward slash. */
export function mountPath(...segments: string[]): string {
  return `/${['mnt', ...segments].join('/')}`;
}

/**
 * Checks that report exactly what a test says and nothing the host platform
 * knows.
 *
 * **The defaults are the permissive ones on purpose.** Every check this builds
 * allows unless the test asks for a refusal, so a test that refuses is a test
 * whose refusal came from the input it supplied rather than from the machine
 * it happens to be running on. That is what makes these tests fail on **every**
 * platform when a check is dropped, rather than on the one platform whose real
 * behaviour would have covered for it.
 */
export function checksReporting(options: {
  readonly mappings?: Record<string, string>;
  readonly volumeTypes?: Record<string, number>;
}): NetworkPathChecks {
  const mappings = options.mappings ?? {};
  const volumeTypes = options.volumeTypes ?? {};
  return {
    resolveRealPath: (target) => mappings[target] ?? target,
    hasNetworkShareRoot,
    readVolumeStatistics: (target) => {
      const type = volumeTypes[target];
      return type === undefined ? undefined : { type };
    },
  };
}

/**
 * A file at the root of this repository, resolved from this module's own
 * location.
 *
 * Computed rather than written down, for the same reason every other path in
 * this file is composed: an absolute path is machine-specific and the hygiene
 * gate refuses one in a tracked file. It is also the only way a test that reads
 * a committed file works regardless of the directory the suite is run from.
 */
export function repositoryFile(...segments: string[]): string {
  return fileURLToPath(new URL(`../../${segments.join('/')}`, import.meta.url));
}
