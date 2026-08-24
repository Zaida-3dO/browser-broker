import fs from 'node:fs';
import path from 'node:path';

import type { DiscoveryRecord } from './driver.ts';

/**
 * Reading the browser's own record of where it can be reached, and checking
 * it before anybody attaches on the strength of it.
 *
 * ── Why the browser picks the port and not this service ─────────────────
 *
 * `SCHEMA.md` §1.2c: the browser is asked to listen on an **unspecified**
 * port, so the operating system assigns a free one, and the browser writes
 * the result into a file inside its own profile directory. Two properties
 * follow, and both are the reason for the arrangement:
 *
 * - **No collision with anything else on the machine.** A fixed port is a
 *   guess about what else is running, and the inward-isolation rule says this
 *   service must start correctly on a host where unrelated things are already
 *   listening.
 * - **The record cannot drift from the identity it describes**, because it
 *   lives inside the profile directory that *is* the identity (§1.2). A
 *   record kept anywhere else is a second place the truth lives, and the two
 *   go out of step the first time something exits badly.
 *
 * ── The property this module exists for: a claim, not a proof ───────────
 *
 * The record **survives the browser**. This was verified rather than assumed,
 * and re-verified while building this row: after the process was killed
 * outright the file was still present, still readable, and still naming a
 * port that answered nothing.
 *
 * So {@link readDiscoveryRecord} returning a record means *a file said so*
 * and nothing more. {@link verifyDiscoveryRecord} is what turns it into a
 * fact, and it owes **two** checks rather than one:
 *
 * 1. **Liveness.** The endpoint answers. A file is not a process.
 * 2. **Identity.** The browser's own identifier matches. **Ports are
 *    reused** — a stale record plus an unrelated process that happened to be
 *    given the same port reads as a successful match against the number
 *    alone, and the service would attach to something it has no business
 *    touching.
 *
 * A record that fails either check is stale: the browser is treated as not
 * running, and whichever caller notices takes the launch race (§1.2a).
 */

/**
 * The file the browser writes inside its profile directory.
 *
 * Named by the browser rather than chosen here, which is why it is a constant
 * and not configuration: this service reads a file somebody else's code
 * writes, so the name is a fact to be matched, not a preference to be set.
 */
export const PORT_FILE_NAME = 'DevToolsActivePort';

/**
 * Two lines: the port, then the per-browser path that carries the browser's
 * own identifier. Both halves are used — the port to reach it, the identifier
 * to know it is the same browser the record described.
 */
export interface PortFileContents {
  readonly port: number;
  /** The identifier the browser minted for itself, taken from the second line. */
  readonly browserUuid: string;
}

/** Where a profile directory lives, given the configured root and a browser. */
export function profileDirectory(profileRoot: string, browser: string): string {
  // The directory is the root plus the browser's own id, computed rather than
  // stored: `SCHEMA.md` §1.2 keeps no `profile_dir` column, because storing
  // one stores an absolute path the database already knows how to compute,
  // and §1.7a's rule is that no absolute path is ever stored anywhere.
  return path.join(profileRoot, browser);
}

/** The record file's path for a profile directory. */
export function portFilePath(profileDir: string): string {
  return path.join(profileDir, PORT_FILE_NAME);
}

/**
 * Parse the record file's contents.
 *
 * Returns `undefined` for anything that is not a well-formed record rather
 * than throwing, because an unreadable or half-written record is *the browser
 * is not reachable this way* — the same conclusion as an absent one — and a
 * caller that has to tell a malformed file from a missing one in order to
 * decide whether to launch has been handed a distinction that changes
 * nothing. A truncated file is a real state: the browser writes it in two
 * lines and a reader can arrive between them.
 */
export function parsePortFile(contents: string): PortFileContents | undefined {
  const [portLine, wsPath] = contents.split('\n');
  if (portLine === undefined || wsPath === undefined) {
    return undefined;
  }

  const port = Number(portLine.trim());
  // An empty string converts to zero and a partly-written line converts to a
  // non-number, so both cases have to be excluded explicitly rather than by
  // truthiness — zero is exactly what an unfinished write looks like.
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }

  // The identifier is the last segment of the per-browser debugging path.
  const browserUuid = wsPath.trim().split('/').at(-1);
  if (browserUuid === undefined || browserUuid === '') {
    return undefined;
  }

  return { port, browserUuid };
}

/**
 * Read the record a browser left in its profile directory.
 *
 * **The returned record deliberately carries no `browserUuid`.** The shape on
 * the seam makes that field optional and says why: it is absent on a record
 * that has been read off disk but not yet checked against a live browser,
 * which is the ordinary state of one. The identifier read from the *file* is
 * the browser's claim about itself; the identifier that matters is the one a
 * live endpoint reports. Keeping the file's copy out of the record is what
 * stops a later reader treating a value that came off disk as though it had
 * been confirmed.
 *
 * The file's identifier is not discarded — {@link verifyDiscoveryRecord}
 * takes it as the expectation to match against. It simply does not travel
 * inside a type whose presence means *verified*.
 */
export function readDiscoveryRecord(
  profileDir: string,
): { record: DiscoveryRecord; expectedUuid: string } | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(portFilePath(profileDir), 'utf8');
  } catch {
    // Absent, unreadable, or a directory. Every one of them means the same
    // thing to a caller: there is no record to attach on.
    return undefined;
  }

  const parsed = parsePortFile(contents);
  if (parsed === undefined) {
    return undefined;
  }

  return {
    record: { endpoint: `http://127.0.0.1:${String(parsed.port)}` },
    expectedUuid: parsed.browserUuid,
  };
}

/** Why a record was not trusted, in the words the refusal uses. */
export type DiscoveryFailure = 'endpoint_unreachable' | 'identity_mismatch';

export interface DiscoveryVerified {
  readonly ok: true;
  /** The record, now carrying the identifier a live browser reported. */
  readonly record: DiscoveryRecord;
}

export interface DiscoveryRejected {
  readonly ok: false;
  readonly failure: DiscoveryFailure;
  readonly detail: string;
}

export type DiscoveryOutcome = DiscoveryVerified | DiscoveryRejected;

/** What the endpoint reports about itself. Only the identifier is read. */
interface VersionResponse {
  readonly webSocketDebuggerUrl?: unknown;
}

/**
 * How long to wait for the endpoint to answer before calling it unreachable.
 *
 * This bounds **one request to a loopback address**, which either answers
 * immediately or is not there — it is not the launch-readiness bound, which
 * is row #55's open question (§1.2b) and is a different quantity entirely. A
 * bound is needed at all because a port can be held by something that accepts
 * a connection and never replies, and a verification step that inherits that
 * hang stalls every caller instead of concluding the browser is not usable.
 */
export const ENDPOINT_TIMEOUT_MS = 2000;

/**
 * Check that the endpoint answers **and** that the browser behind it is the
 * one the record described.
 *
 * Both checks, never one. Liveness alone attaches to whatever inherited the
 * port; identity alone cannot be read without something answering.
 */
export async function verifyDiscoveryRecord(
  record: DiscoveryRecord,
  expectedUuid: string,
  options: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number } = {},
): Promise<DiscoveryOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? ENDPOINT_TIMEOUT_MS;

  let payload: VersionResponse;
  try {
    const response = await fetchImpl(`${record.endpoint}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        failure: 'endpoint_unreachable',
        detail: `The endpoint answered with status ${String(response.status)} rather than a version document.`,
      };
    }
    payload = (await response.json()) as VersionResponse;
  } catch (error) {
    return {
      ok: false,
      failure: 'endpoint_unreachable',
      detail: `The endpoint did not answer: ${error instanceof Error ? error.message : String(error)}. The record is a claim, not a proof — it survives the browser it describes.`,
    };
  }

  const url = payload.webSocketDebuggerUrl;
  const actualUuid = typeof url === 'string' ? url.split('/').at(-1) : undefined;

  if (actualUuid === undefined || actualUuid === '') {
    return {
      ok: false,
      failure: 'identity_mismatch',
      detail:
        'The endpoint answered but reported no browser identifier, so there is nothing to match the record against.',
    };
  }

  if (actualUuid !== expectedUuid) {
    // The case this exists for: the recorded browser exited and an unrelated
    // process was handed the same port. Matching the number alone would read
    // as success and attach to a stranger.
    return {
      ok: false,
      failure: 'identity_mismatch',
      detail:
        'The endpoint answered, but it is a different browser from the one the record describes. Ports are reused, so a matching port is not a matching browser.',
    };
  }

  return { ok: true, record: { endpoint: record.endpoint, browserUuid: actualUuid } };
}
