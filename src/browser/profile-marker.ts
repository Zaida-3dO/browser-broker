import fs from 'node:fs';
import path from 'node:path';

/**
 * Reading what Chromium itself records about the last build to open a
 * profile, and refusing the swaps that would damage one.
 *
 * ── Why this module exists at all ────────────────────────────────────────
 *
 * `discovery.ts` keys a profile directory on the browser **name**
 * (`profileDirectory`), and the name does not change when the binary behind
 * it does. So once a browser can be pointed at a different executable, the
 * obvious edit — change one environment variable — hands an existing profile
 * to a different Chromium build, and two of the ways that can go are
 * destructive:
 *
 * - **An older build opening a newer profile.** Chromium shows a modal
 *   profile-error dialog and never opens a debugging endpoint. Nothing here
 *   could attach; the launch would cost a full readiness timeout and then
 *   report a stall whose cause it could not name.
 * - **A different vendor's build opening the profile.** `Local State` holds
 *   `os_crypt.encrypted_key`, wrapped by the operating system and bound to
 *   the installing application. Chrome, Edge and Brave do not share that
 *   binding, so the browser starts perfectly, runs perfectly, and **cannot
 *   decrypt the cookie store** — the shared signed-in profile reads as
 *   silently logged out. That is the worst shape a failure takes here,
 *   because it is indistinguishable from an expired session and the
 *   sign-in is the thing `setup.ts` refuses even to clear.
 *
 * ── Why the markers are READ and never written ───────────────────────────
 *
 * Chromium already records both facts, so this service writes no marker of
 * its own. `discovery.ts` states the reason and it applies unchanged: *"a
 * record kept anywhere else is a second place the truth lives, and the two go
 * out of step the first time something exits badly."* A marker of ours would
 * be stored state; these are the browser's own, written by the thing whose
 * behaviour they describe.
 *
 * ── The decision table ───────────────────────────────────────────────────
 *
 * Only the dangerous directions refuse, and they refuse **before the spawn**,
 * so nothing is started and there is no orphaned process to reap:
 *
 * | Marker says                         | Configured binary | Outcome  |
 * |-------------------------------------|-------------------|----------|
 * | a different binary path             | any               | refuse   |
 * | same path, higher version in profile | lower            | refuse   |
 * | same path, lower version in profile  | higher           | proceed  |
 * | absent, unreadable or malformed      | any              | proceed  |
 *
 * **An absent marker proceeds, and that is not a gap.** A profile directory
 * that has never been opened has no marker at all, so a guard that refused on
 * absent evidence would refuse every first launch — it would be a guard
 * against the service working. This follows `parsePortFile`'s
 * `undefined`-on-malformed idiom for exactly that reason: unreadable and
 * absent are one answer, and it is *proceed*.
 *
 * The shape is the one `store/schema/step.ts` already settled for persistent
 * state: a build migrates a lower-versioned store in place, and refuses a
 * higher-versioned one rather than guessing at a format it does not know.
 */

/** Chromium's record of the last build to open a profile. ASCII. */
export const LAST_VERSION_FILE = 'Last Version';

/**
 * Chromium's record of the binary that last opened a profile, as an absolute
 * path. **UTF-16LE, no byte-order mark** — see {@link readLastBrowser}.
 */
export const LAST_BROWSER_FILE = 'Last Browser';

/** What a profile directory says about the build that last opened it. */
export interface ProfileMarker {
  /** The version string, e.g. `151.0.7922.34`. Absent if unrecorded. */
  readonly version: string | undefined;
  /** The absolute path of the binary that last opened it. Absent if unrecorded. */
  readonly browserPath: string | undefined;
}

/**
 * Read `Last Browser`, which is **UTF-16LE with no byte-order mark**.
 *
 * ── This encoding is the whole reason this function is not one line ──────
 *
 * Measured on two live profiles rather than assumed. A `readFileSync(…,
 * 'utf8')` on this file does not fail: it returns the path with a NUL between
 * every character, which compares unequal to every real path that was ever
 * written. The check built on it would therefore **always report a mismatch**
 * — it would refuse every launch of a correctly configured browser, while
 * looking like a working guard, and a test written against an ASCII fixture
 * would pass the whole time.
 *
 * `tests/browser/profile-marker.test.ts` writes a genuine UTF-16LE fixture
 * for this reason, so switching this decode back to `'utf8'` turns that test
 * red rather than leaving it green on a fixture that never had the property.
 *
 * The absence of a byte-order mark is why the encoding is stated rather than
 * sniffed: there is nothing in the bytes to sniff.
 */
export function readLastBrowser(profileDirectory: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path.join(profileDirectory, LAST_BROWSER_FILE));
  } catch {
    return undefined;
  }

  // An odd length is not UTF-16LE at all — a truncated or foreign file. A
  // decode would silently drop the last byte and produce a plausible-looking
  // path, which is the one outcome worse than reporting nothing.
  if (bytes.length === 0 || bytes.length % 2 !== 0) {
    return undefined;
  }

  const decoded = bytes.toString('utf16le').replace(/\0+$/, '').trim();
  return decoded === '' ? undefined : decoded;
}

/** Read `Last Version`, which is ordinary ASCII. */
export function readLastVersion(profileDirectory: string): string | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(path.join(profileDirectory, LAST_VERSION_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const trimmed = contents.trim();
  // A version is dotted digits. Anything else is a file this code did not
  // write and does not understand, and guessing at it would be worse than
  // reporting nothing — an unparsed marker proceeds, which is the safe
  // direction.
  return /^\d+(\.\d+)*$/.test(trimmed) ? trimmed : undefined;
}

/** Everything a profile directory records about its last opener. */
export function readProfileMarker(profileDirectory: string): ProfileMarker {
  return {
    version: readLastVersion(profileDirectory),
    browserPath: readLastBrowser(profileDirectory),
  };
}

/**
 * Compare two dotted-numeric versions.
 *
 * Returns a negative number when `left` is older, zero when they are equal,
 * and a positive number when `left` is newer. Compared **component by
 * component as numbers**, because these are not decimals and not sortable as
 * strings: `151.0.7922.34` is newer than `98.0.1`, and both string comparison
 * and a float parse get that backwards.
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    // A missing component is zero, so `151.0` and `151.0.0` are one version.
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Two paths naming the same binary.
 *
 * Compared case-insensitively on Windows, where the filesystem is, and
 * exactly everywhere else, where it is not. Both sides are resolved first so
 * that a configured relative path and a recorded absolute one are not
 * reported as different binaries when they are one file.
 */
function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface ProfileCompatibilityRequest {
  /** The browser's name, for the refusal's sentence. */
  readonly browser: string;
  readonly profileDirectory: string;
  /** The binary that is about to be launched against it. */
  readonly executablePath: string;
  /**
   * The version of that binary, when it is known.
   *
   * **Usually undefined, and the design accounts for that.** Reading a
   * version out of an executable is platform-specific and not portably
   * possible without running the thing, which is precisely what must not
   * happen before this check. When it is absent the version comparison is
   * skipped and the binary-path check carries the guard alone — see
   * {@link profileCompatibility} for why that is the honest degradation
   * rather than a hole.
   */
  readonly executableVersion?: string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly readMarker?: (profileDirectory: string) => ProfileMarker;
}

export interface ProfileCompatibility {
  readonly ok: boolean;
  /** Why it was refused, as a whole sentence. Absent when `ok`. */
  readonly detail?: string;
}

/**
 * Whether this binary may open this profile.
 *
 * ── What this does NOT promise, stated plainly ───────────────────────────
 *
 * **The version half only runs when the caller knows the binary's version**,
 * and ordinarily it does not. So in the common case this is a *binary-path*
 * guard: it catches the cross-vendor case — the destructive one, the silent
 * sign-out — and it does not catch a deliberate downgrade of the same
 * installed browser in place, where the recorded path is unchanged and only
 * the build behind it moved.
 *
 * That gap is left open deliberately rather than closed with a guess. The
 * alternatives were to refuse whenever the version is unknown, which refuses
 * every launch on every platform and is a guard against working, or to infer
 * a version from the path, which is a guess that would be wrong for every
 * build that does not put its version in its filename. The downgrade case
 * also fails **safely** without this: Chromium opens no debugging endpoint,
 * so the launch refuses on the readiness timeout instead of corrupting
 * anything. It costs a slow refusal rather than a profile.
 *
 * **`Last Browser` is confirmed written on Windows only.** On a platform that
 * does not write it the marker reads absent, and an absent marker proceeds —
 * so on macOS and Linux this guard degrades to nothing at all rather than to
 * something wrong. That is a real limit of the promise and `.env.example`
 * says so, because a caller who believes they are guarded when they are not
 * is worse off than one who knows they are not.
 */
export function profileCompatibility(request: ProfileCompatibilityRequest): ProfileCompatibility {
  const platform = request.platform ?? process.platform;
  const readMarker = request.readMarker ?? readProfileMarker;
  const marker = readMarker(request.profileDirectory);

  // A profile nothing has opened yet, or one whose markers this code cannot
  // read. Absent evidence is not evidence of danger, and refusing here would
  // refuse every first launch.
  if (marker.browserPath === undefined && marker.version === undefined) {
    return { ok: true };
  }

  if (
    marker.browserPath !== undefined &&
    !samePath(marker.browserPath, request.executablePath, platform)
  ) {
    return {
      ok: false,
      detail: `The profile directory for ${JSON.stringify(request.browser)} was last opened by ${JSON.stringify(marker.browserPath)}, and the configured binary is ${JSON.stringify(request.executablePath)}. Handing one browser's profile to a different one is refused rather than attempted: the cookie store is encrypted with a key the operating system binds to the installing browser, so the launch would succeed, run normally, and read as silently signed out — losing a sign-in a person put there by hand. Give the new binary a browser name of its own, and it gets a profile of its own.`,
    };
  }

  if (
    marker.version !== undefined &&
    request.executableVersion !== undefined &&
    compareVersions(request.executableVersion, marker.version) < 0
  ) {
    return {
      ok: false,
      detail: `The profile directory for ${JSON.stringify(request.browser)} was last opened by version ${marker.version}, and the configured binary is version ${request.executableVersion}, which is lower. A build opening a profile written by a higher version shows a modal profile-error dialog and never opens a debugging endpoint, so this would stall for the whole readiness timeout and then report a failure whose cause nothing could name. The other direction — a higher version opening a lower-versioned profile — migrates in place and is allowed.`,
    };
  }

  return { ok: true };
}
