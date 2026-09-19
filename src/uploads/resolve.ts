import fs from 'node:fs';
import path from 'node:path';

import { isAbsoluteInEitherNamespace } from '../artifacts/store.ts';
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  type UploadFile,
} from '../browser/driver.ts';
import { PageRefusal } from '../service/pages.ts';

/**
 * Read a caller-named file from under the configured upload root, or refuse.
 *
 * This is the security-bearing half of the `upload` verb. The Playwright call
 * it feeds is one line; everything that makes the verb safe to expose is
 * here, so this file is written to be read rather than skimmed.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE SHAPE OF THE PROBLEM
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Every other thing this service does moves data that was already in a page.
 * `upload` is the only operation that moves data **from this machine** into a
 * shared, signed-in browser. `browser_navigate` refuses `file://` precisely
 * so a lease cannot become a read of the filesystem (§3.7); this verb
 * approaches that same line from the other side, and the allow-root plus the
 * containment guard below are what keep it on the right side of it.
 *
 * `BROKER_UPLOAD_ROOT` has **no default** and the verb refuses until an
 * operator sets it. See `src/config/environment.ts` for why a default would
 * have handed inbound filesystem reach to every existing installation on
 * upgrade, without anyone choosing it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE BYTES, NOT THE PATH — why Playwright never sees a caller's string
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `setInputFiles` accepts either a filesystem path or an in-memory
 * `{name, mimeType, buffer}`. **This service passes bytes**, and that choice
 * collapses three separate hazards at once:
 *
 * - Playwright resolves a relative path against `process.cwd()` under its own
 *   rules. Handing it a caller-influenced string would put a **second** path
 *   resolver behind this guard, with its own answers, checked by nobody.
 * - The size cap becomes enforceable **before** bytes are read, by `fstat` on
 *   a descriptor this module opened — rather than after a multi-gigabyte file
 *   has already been allocated in the process that arbitrates every lease.
 * - The time-of-check-to-time-of-use window becomes controllable, because
 *   this module owns the `open`. See below.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * OPEN FIRST, THEN ASK THE DESCRIPTOR — and the residual window, honestly
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The naive order is resolve, check, then read the path. That leaves a window
 * in which anything able to write inside the upload root can replace a
 * checked file with a link to somewhere else between the check and the read:
 * the guard passed on one file and the read follows the new link to another.
 *
 * So {@link readUploadFile} opens **first**, and every question after that is
 * asked of the descriptor — `fstatSync(handle)` for the type and the size,
 * `readFileSync(handle)` for the bytes. Renaming the path afterwards cannot
 * change which file the descriptor names.
 *
 * **The residual window is real and is stated rather than papered over.**
 * Step 5's `realpathSync` resolves *the path*, not the descriptor, so a swap
 * between the open and that call makes realpath answer about a different file
 * than the one held open. Closing it properly means comparing `st.ino` and
 * `st.dev` from the `fstat` against a `stat` of the realpath result — which
 * this file does, **where the platform supports it**. Node reports `ino` as
 * `0` on the platform with drive letters, so that comparison is skipped there
 * rather than being written as a check that silently always passes; on that
 * platform the guard degrades to the realpath check alone.
 *
 * **And the honest severity assessment**, because a guard oversold is a guard
 * misunderstood: exploiting that race needs something that can already write
 * into the upload root — and anything that can do that can simply put the
 * file it wants uploaded there, with no race and no link. The symlink guard's
 * real value is against the **static and the accidental**: a package-manager
 * junction, a cloud-sync link, a shortcut to a home directory that somebody
 * made years ago and forgot. Those are deterministic, and steps 1 and 5 catch
 * every one of them.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TWO PRECEDENTS, BOTH FOLLOWED DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * - `src/artifacts/store.ts` — lexical containment asking **both** questions,
 *   of the computed result *and* of the supplied name. {@link
 *   isAbsoluteInEitherNamespace} is imported from there rather than rewritten.
 * - `src/store/network-path.ts` — resolve, then re-ask the containment
 *   question of the resolved value. Its header states this module's principle
 *   exactly: "there is nothing in the string to read... so a second check has
 *   to ask the operating system." Substitute "symlink" for "mapped drive".
 */

/**
 * Types for the extensions a review is likely to attach, and one default.
 *
 * Short and unapologetically incomplete. The default is the honest answer for
 * anything not listed, and a page that cares about the type reads the bytes.
 */
const MIME_TYPES = new Map<string, string>([
  ['.csv', 'text/csv'],
  ['.gif', 'image/gif'],
  ['.htm', 'text/html'],
  ['.html', 'text/html'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain'],
  ['.webp', 'image/webp'],
  ['.xml', 'application/xml'],
  ['.zip', 'application/zip'],
]);

const DEFAULT_MIME_TYPE = 'application/octet-stream';

/** What a page is told this file is, from its extension. */
function mimeTypeFor(name: string): string {
  return MIME_TYPES.get(path.extname(name).toLowerCase()) ?? DEFAULT_MIME_TYPE;
}

/**
 * Echo a caller's name back in a refusal, bounded.
 *
 * Quoted so that trailing whitespace and an empty string are visible as
 * themselves, and truncated so a refusal cannot be made enormous by sending
 * an enormous name.
 */
function echoName(name: string): string {
  const limit = 120;
  const shown = name.length > limit ? `${name.slice(0, limit)}…` : name;
  return JSON.stringify(shown);
}

/**
 * The lexical half of containment: `..` out of the root, and a name that is
 * absolute in either namespace.
 *
 * **The supplied name is tested as well as the computed result**, and that is
 * not belt and braces — it is the only check that catches a name absolute in
 * the *other* namespace. A drive-qualified name contains no forward slash, so
 * on a host whose separator is the forward slash `path.posix.isAbsolute` says
 * false and `path.resolve(root, it)` produces one oddly-named file under the
 * root. `path.relative` then answers something clean with no `..`, and
 * **nothing downstream can notice**. On the platform with drive letters the
 * same string is a genuine absolute path, so this is not a portability nicety
 * there — it is the primary guard.
 *
 * Exported for the tests, which assert the escape table against it directly
 * as well as through the whole read.
 */
export function refuseUncontainedName(root: string, name: string): string {
  const absolute = path.resolve(root, name);
  const relative = path.relative(root, absolute);
  if (
    relative.startsWith('..') ||
    isAbsoluteInEitherNamespace(relative) ||
    isAbsoluteInEitherNamespace(name)
  ) {
    throw new PageRefusal(
      'act.upload_path_contained',
      `${echoName(name)} does not resolve inside the upload root. An upload reads only files under that directory: a name that climbs out of it, or one that names a root of its own, is refused.`,
      { action: 'upload', name },
    );
  }
  return absolute;
}

/**
 * The resolved upload root, or a refusal naming the variable.
 *
 * Resolved **once per upload** rather than once per file: if the root itself
 * is reached through a link, comparing a resolved leaf against an unresolved
 * root makes every legitimate file look like an escape.
 */
function realRootOf(root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch {
    throw new PageRefusal(
      'act.upload_root_configured',
      `BROKER_UPLOAD_ROOT is set to a directory this service cannot read. An upload reads files from under that directory, so it must exist and be readable by whoever runs the broker.`,
      { action: 'upload' },
    );
  }
}

/**
 * What a failed `open` means, said in terms of files rather than errnos.
 *
 * The errno is deliberately **not** in the message. Playwright's own error on
 * a missing path is a raw `ENOENT` naming an absolute path, which is the
 * defect `scripts/check-argument-refusals.mjs` exists to prevent: it reports a
 * mechanism the caller cannot act on, and it reports **where this service
 * looked**, which is the root's layout and is not the caller's to learn.
 */
function refuseUnreadable(name: string): never {
  throw new PageRefusal(
    'act.upload_file_readable',
    `There is no readable file at ${echoName(name)} under the upload root. A directory, a device, a socket and a link pointing at nothing are each refused: an upload sends the bytes of one ordinary file.`,
    { action: 'upload', name },
  );
}

/**
 * Whether the descriptor and the resolved path name the same file.
 *
 * `ino` is `0` on the platform with drive letters, so a comparison there would
 * be `0 === 0` — a check that always passes, written as though it checked
 * something. Returning `true` unexamined in that case is the honest shape: the
 * realpath check stands alone there, and this file's header says so.
 */
function sameFile(fromHandle: fs.Stats, fromPath: fs.Stats): boolean {
  if (fromHandle.ino === 0 || fromPath.ino === 0) {
    return true;
  }
  return fromHandle.ino === fromPath.ino && fromHandle.dev === fromPath.dev;
}

/** How many bytes an upload has accumulated so far, for the total cap. */
export interface UploadBudget {
  bytesSoFar: number;
}

/**
 * Resolve one caller-named file under the root and read its bytes.
 *
 * The steps are numbered to match this file's header. Every refusal closes
 * the descriptor, which is what the `finally` is for — a guard that leaks a
 * handle on the refusal path leaks one on exactly the paths taken most.
 */
export function readUploadFile(root: string, name: string, budget: UploadBudget): UploadFile {
  // 1. Lexical containment, both questions. Before anything is opened.
  const absolute = refuseUncontainedName(root, name);
  const realRoot = realRootOf(root);

  // 2. Open first. From here every question is asked of the descriptor.
  let handle: number;
  try {
    handle = fs.openSync(absolute, fs.constants.O_RDONLY);
  } catch {
    refuseUnreadable(name);
  }

  try {
    // 3. An ordinary file, asked of the descriptor. This is what excludes a
    //    directory, a device, a socket and a FIFO. A link pointing at nothing
    //    already failed to open at step 2.
    const stats = fs.fstatSync(handle);
    if (!stats.isFile()) {
      refuseUnreadable(name);
    }

    // 4. Size, from the descriptor, BEFORE a byte is read.
    if (stats.size > MAX_UPLOAD_FILE_BYTES) {
      throw new PageRefusal(
        'act.upload_bytes_bounded',
        `${echoName(name)} is ${String(stats.size)} bytes, and the largest file this service uploads is ${String(MAX_UPLOAD_FILE_BYTES)}.`,
        { action: 'upload', name, bytes: stats.size, maximum: MAX_UPLOAD_FILE_BYTES },
      );
    }
    if (budget.bytesSoFar + stats.size > MAX_UPLOAD_TOTAL_BYTES) {
      throw new PageRefusal(
        'act.upload_bytes_bounded',
        `That upload totals more than ${String(MAX_UPLOAD_TOTAL_BYTES)} bytes, which is the most this service carries in one call.`,
        {
          action: 'upload',
          name,
          bytes: budget.bytesSoFar + stats.size,
          maximum: MAX_UPLOAD_TOTAL_BYTES,
        },
      );
    }

    // 5. Symlink containment. `realpathSync` resolves **every component**, so
    //    a link three directories up is caught — which is precisely what an
    //    `lstat` of the final component is blind to.
    let real: string;
    try {
      real = fs.realpathSync.native(absolute);
    } catch {
      refuseUnreadable(name);
    }
    const relativeToReal = path.relative(realRoot, real);
    if (relativeToReal.startsWith('..') || isAbsoluteInEitherNamespace(relativeToReal)) {
      throw new PageRefusal(
        'act.upload_path_contained',
        `${echoName(name)} resolves to a location outside the upload root. A link inside that directory pointing out of it is refused: an upload reads only files that are really under the root, not names that lead elsewhere.`,
        { action: 'upload', name },
      );
    }

    // The descriptor and the resolved path must be the same file. This is
    // what closes the window between step 2 and step 5 — where the platform
    // answers it at all. See {@link sameFile}.
    let resolvedStats: fs.Stats;
    try {
      resolvedStats = fs.statSync(real);
    } catch {
      refuseUnreadable(name);
    }
    if (!sameFile(stats, resolvedStats)) {
      throw new PageRefusal(
        'act.upload_path_contained',
        `${echoName(name)} changed while it was being read. An upload reads one file, and a name that names a different file part-way through the read is refused rather than guessed at.`,
        { action: 'upload', name },
      );
    }

    // 6. Read from the descriptor, never from the path.
    const bytes = fs.readFileSync(handle);
    // Re-checked, because a file can grow between the `fstat` and the read.
    if (bytes.byteLength > MAX_UPLOAD_FILE_BYTES) {
      throw new PageRefusal(
        'act.upload_bytes_bounded',
        `${echoName(name)} is ${String(bytes.byteLength)} bytes, and the largest file this service uploads is ${String(MAX_UPLOAD_FILE_BYTES)}.`,
        { action: 'upload', name, bytes: bytes.byteLength, maximum: MAX_UPLOAD_FILE_BYTES },
      );
    }
    if (budget.bytesSoFar + bytes.byteLength > MAX_UPLOAD_TOTAL_BYTES) {
      throw new PageRefusal(
        'act.upload_bytes_bounded',
        `That upload totals more than ${String(MAX_UPLOAD_TOTAL_BYTES)} bytes, which is the most this service carries in one call.`,
        {
          action: 'upload',
          name,
          bytes: budget.bytesSoFar + bytes.byteLength,
          maximum: MAX_UPLOAD_TOTAL_BYTES,
        },
      );
    }
    budget.bytesSoFar += bytes.byteLength;

    // 8. The name the page is told. The basename, never the caller's
    //    directories and never the resolved absolute path — that would hand
    //    the root's layout to the page, for no benefit to anybody.
    return { name: path.basename(name), mimeType: mimeTypeFor(name), bytes };
  } finally {
    // 7. Closed on every path out of here, including every refusal above.
    fs.closeSync(handle);
  }
}

/** Read every file one upload names, enforcing the total across them. */
export function readUploadFiles(root: string, names: readonly string[]): readonly UploadFile[] {
  const budget: UploadBudget = { bytesSoFar: 0 };
  return names.map((name) => readUploadFile(root, name, budget));
}
