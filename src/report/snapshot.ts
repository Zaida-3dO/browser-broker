import fs from 'node:fs';
import path from 'node:path';

import type { Database } from 'better-sqlite3';

import {
  readAddresses,
  type AddressRequest,
  type AddressSource,
  type TabAddress,
} from '../operations/addresses.ts';
import { readOperationsStatus, type StatusOptions } from '../operations/status.ts';
import { renderDocument } from './document.ts';

/**
 * `broker snapshot` — write the operations document to a path and exit
 * (`SCHEMA.md` §4.5, §5.5).
 *
 * **One command, one file. It writes the document wherever it is told,
 * reports the path, and exits. It leaves nothing behind and holds nothing
 * open.**
 *
 * ── The order of operations here is the design ──────────────────────────
 *
 * 1. Read the status. One statement set, derived (§2.4), and it finishes.
 * 2. **Then** ask the browsers where their tabs are (§4.2a), each under its
 *    own timeout.
 * 3. Render, and write.
 *
 * Step 2 is after step 1 and outside everything, which is what keeps §2.4b's
 * hard rule true here: **browser work never happens inside the arbitration
 * transaction.** The status read is over by the time a browser is asked
 * anything, and nothing in this file opens a transaction around either.
 * `MILESTONES.md` #70 says the same thing from the other direction —
 * "generation happens outside any transaction, so this does not violate the
 * never-do-browser-I/O-inside-the-arbitration-transaction rule — but it MUST
 * carry a timeout".
 *
 * ── Failing to reach the browsers is not failing to produce a document ───
 *
 * §4.2a: a generator that inherits a browser's hang "produces nothing at all,
 * which is a worse outcome than an incomplete document". So there is no path
 * through this function that throws because a browser was unavailable. Every
 * such outcome becomes `unreachable` in the document, which is the explicit
 * word the rule requires.
 */

/** How long one tab's address read may take, in milliseconds. */
export const DEFAULT_ADDRESS_TIMEOUT_MS = 2000;

export interface SnapshotOptions extends StatusOptions {
  /** Where to write the file. */
  readonly outputPath: string;
  /**
   * How to reach the browsers, and the tabs to ask about.
   *
   * **Absent is a supported state, not a degraded one.** A person generating
   * a snapshot on a machine where no browser is running, or from a build with
   * no driver wired in, still gets a document — with every address reported
   * as `unreachable` and a note saying why, which is more informative than
   * either a blank column or a refusal to produce anything.
   */
  readonly addresses?: {
    readonly source: AddressSource;
    /** One entry per live tab, from the caller that holds the browser sessions. */
    readonly requests: readonly AddressRequest[];
    readonly timeoutMs?: number;
  };
  readonly version?: string;
}

export interface SnapshotResult {
  /** Where it was written. */
  readonly path: string;
  readonly bytes: number;
  /** The moment the document describes. */
  readonly at: string;
  /** How many tabs were asked about, and how many did not answer. */
  readonly tabsAsked: number;
  readonly tabsUnreachable: number;
}

/**
 * Generate the document and write it.
 *
 * The directory is created if it is absent, which is the one filesystem
 * liberty this takes and it is the same one every writer of a named output
 * path takes: a person naming a path inside a directory that does not exist
 * meant the path, and refusing would be pedantry rather than safety.
 */
export async function writeSnapshot(
  db: Database,
  options: SnapshotOptions,
): Promise<SnapshotResult> {
  // Step 1: the derived status read. Finishes before any browser is touched.
  const status = readOperationsStatus(db, {
    eventLimit: options.eventLimit,
    feedbackLimit: options.feedbackLimit,
    now: options.now,
  });

  // Step 2: the live address read, outside everything.
  let addresses: ReadonlyMap<string, TabAddress> = new Map();
  let addressNote: string | undefined;
  let tabsAsked = 0;

  const liveTabIds = status.sessions
    .flatMap((session) => session.leases)
    .map((lease) => lease.tabId)
    .filter((tabId): tabId is string => tabId !== null);

  if (options.addresses === undefined) {
    if (liveTabIds.length > 0) {
      addressNote =
        'No browser connection was available when this snapshot was taken, so no address could be read. Every address below reads as unreachable for that one reason rather than because fifteen separate reads failed.';
    }
  } else {
    // Only ask about tabs the document is actually going to show. A request
    // for a tab no live lease holds would be a read of a page nobody owns,
    // which is exactly the browsing-history shape §1.4 deletes the column to
    // avoid.
    const shown = new Set(liveTabIds);
    const requests = options.addresses.requests.filter((request) => shown.has(request.tabId));
    tabsAsked = requests.length;
    addresses = await readAddresses(options.addresses.source, requests, {
      timeoutMs: options.addresses.timeoutMs ?? DEFAULT_ADDRESS_TIMEOUT_MS,
    });
  }

  // Step 3: render and write.
  const html = renderDocument({ status, addresses, addressNote, version: options.version });

  const resolved = path.resolve(options.outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, html, 'utf8');

  const unreachable = [...addresses.values()].filter(
    (address) => address.kind === 'unreachable',
  ).length;

  return {
    path: resolved,
    bytes: Buffer.byteLength(html, 'utf8'),
    at: status.at,
    tabsAsked,
    // Tabs that were never asked about count as unreachable, because that is
    // how the document renders them — a number that disagreed with the
    // document would be worse than no number.
    tabsUnreachable: unreachable + (liveTabIds.length - tabsAsked),
  };
}
