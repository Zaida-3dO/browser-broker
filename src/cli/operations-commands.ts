import type { Database } from 'better-sqlite3';

import { runDoctor, formatReport } from '../doctor/report.ts';
import { EXIT } from './adapter.ts';
import type { Environment } from '../config/environment.ts';
import { readLedger, type LedgerQuery } from '../operations/ledger.ts';
import { writeSnapshot } from '../report/snapshot.ts';

/**
 * The three commands this row owns: `snapshot`, `doctor` and `events`.
 *
 * ── Why they live in their own file ─────────────────────────────────────
 *
 * `CLAUDE.md`: "Every adapter is a thin shell over a service call. No adapter
 * may reach the database or a guard directly." These three are the narrow
 * exception the design already carves out, and it is worth being precise
 * about which exception, because "the rule does not apply to me" is how a
 * rule stops applying to anyone:
 *
 * - **`snapshot` and `doctor` have no service operation behind them.**
 *   `SCHEMA.md` §5.5 lists them under "The commands that have no operation
 *   behind them", and records that each "carries a **written waiver** in the
 *   parity suite rather than being quietly absent from it". They are not
 *   agent operations, they are not on any tool surface, and there is nothing
 *   for them to be a shell over.
 * - **`events` is a read of history.** §5.4 puts "read the ledger" on the
 *   operations command surface. It decides nothing, grants nothing and
 *   refuses nothing.
 *
 * **What that does not excuse.** None of these may grow into arbitration. If
 * one of them ever needs to grant, refuse, promote or expire anything, it
 * needs a service operation and it stops being one of these — and §5.2's
 * consequence would then apply to it: "any command that goes through
 * arbitration performs the lazy sweep". None of these three sweeps, and none
 * of them may start.
 *
 * Kept in a separate module from the dispatcher for one practical reason
 * beyond tidiness: the command surface is being filled by more than one piece
 * of work at once, and a file per concern is a file per conflict rather than
 * one file with all of them.
 */

/** Where output goes, matching the dispatcher's own shape. */
export interface CommandStreams {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * Exit codes, chosen so situations wanting opposite responses are
 * distinguishable without parsing anything (§5.6).
 *
 * Re-exported from the adapter that owns them rather than restated, so there
 * is one set of numbers in this build and no second copy to drift. The
 * re-export exists because these three commands are not adapter operations —
 * they have no service call behind them — and importing the adapter's own
 * constant is how they stay in step with the route that does.
 */
export const COMMAND_EXIT = EXIT;

/** `--name value` and `--name=value`, plus bare `--flag`. */
export function parseFlags(rest: readonly string[]): Readonly<Record<string, string | true>> {
  const parsed: Record<string, string | true> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === undefined || !word.startsWith('--')) {
      continue;
    }
    const body = word.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      parsed[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed[body] = true;
      continue;
    }
    parsed[body] = next;
    index += 1;
  }
  return parsed;
}

function asString(value: string | true | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: string | true | undefined): number | undefined {
  const text = asString(value);
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface SnapshotCommandOptions {
  readonly db: Database;
  readonly streams: CommandStreams;
  readonly json: boolean;
  readonly version?: string;
}

/**
 * `broker snapshot --out <path>`.
 *
 * **No browser connection is supplied by this route**, and that is stated
 * rather than hidden: the command line does not attach to a browser, so every
 * address in the document it writes reads as `unreachable` with a note giving
 * the single reason. The row that brings the real driver is the row that
 * passes a source through. §4.2a's requirement is about what the document
 * says when a browser does not answer, and this route satisfies it in the
 * most literal way available — it asks nothing and says so, rather than
 * leaving a blank.
 */
export async function runSnapshotCommand(
  rest: readonly string[],
  options: SnapshotCommandOptions,
): Promise<number> {
  const flags = parseFlags(rest);
  const outputPath = asString(flags.out) ?? asString(flags.output) ?? asString(flags.path);

  if (outputPath === undefined) {
    options.streams.err(
      'broker snapshot needs somewhere to write: --out <path>. It writes one self-contained HTML file and exits.',
    );
    return COMMAND_EXIT.malformed;
  }

  const result = await writeSnapshot(options.db, {
    outputPath,
    eventLimit: asNumber(flags.events),
    feedbackLimit: asNumber(flags.feedback),
    version: options.version,
  });

  if (options.json) {
    options.streams.out(
      JSON.stringify({
        path: result.path,
        bytes: result.bytes,
        at: result.at,
        tabs_asked: result.tabsAsked,
        tabs_unreachable: result.tabsUnreachable,
      }),
    );
  } else {
    options.streams.out(`snapshot: ${result.path}`);
    options.streams.out(`taken at: ${result.at}`);
    // Said on every run, not only when something is wrong. §4.1's rule is
    // that the document must not be mistaken for a window, and the person
    // most likely to make that mistake is the one who just generated it.
    options.streams.out(
      'This is a photograph, not a window: it does not refresh. Generate another to see the current picture.',
    );
    if (result.tabsUnreachable > 0) {
      options.streams.out(
        `${String(result.tabsUnreachable)} of ${String(result.tabsAsked + result.tabsUnreachable)} tab address(es) could not be read and are shown as unreachable.`,
      );
    }
  }

  return COMMAND_EXIT.accepted;
}

export interface DoctorCommandOptions {
  readonly db: Database | undefined;
  readonly environment: Environment;
  readonly streams: CommandStreams;
  readonly json: boolean;
}

/**
 * `broker doctor`.
 *
 * **Reports and changes nothing** (§5.5), and exits with a distinct code on
 * any failure, so it is usable exactly where a readiness check would have
 * been used. The full list is on the output stream in both modes — the
 * machine-readable one is one document, per §5.6.
 */
export function runDoctorCommand(options: DoctorCommandOptions): number {
  const report = runDoctor(options.environment, options.db);

  if (options.json) {
    options.streams.out(
      JSON.stringify({
        store: report.storeLocation,
        exit_code: report.exitCode,
        checks: report.checks.map((check) => ({
          id: check.id,
          group: check.group,
          status: check.status,
          detail: check.detail,
          remedy: check.remedy,
        })),
      }),
    );
  } else {
    for (const line of formatReport(report)) {
      options.streams.out(line);
    }
  }

  return report.exitCode;
}

export interface EventsCommandOptions {
  readonly db: Database;
  readonly streams: CommandStreams;
  readonly json: boolean;
}

/**
 * `broker events` — a slice of the ledger (`MILESTONES.md` #47).
 *
 * Sliced by kind, outcome and rule, with the cursor the counter primary key
 * already provides (§1.6). Every filter is a bound parameter; nothing a
 * caller types reaches the SQL text.
 */
export function runEventsCommand(rest: readonly string[], options: EventsCommandOptions): number {
  const flags = parseFlags(rest);

  const query: LedgerQuery = {
    kinds: asString(flags.kind)?.split(',') ?? undefined,
    outcome: asString(flags.outcome),
    guard: asString(flags.guard),
    sessionId: asString(flags['session-id']),
    claimId: asString(flags['claim-id']),
    since: asNumber(flags.since),
    before: asNumber(flags.before),
    limit: asNumber(flags.limit),
    order: flags.since === undefined ? 'newest' : 'oldest',
  };

  const slice = readLedger(options.db, query);

  if (options.json) {
    options.streams.out(
      JSON.stringify({
        entries: slice.entries,
        cursor: slice.cursor,
        total: slice.total,
      }),
    );
    return COMMAND_EXIT.accepted;
  }

  if (slice.entries.length === 0) {
    options.streams.out('No ledger entries match.');
    return COMMAND_EXIT.accepted;
  }

  for (const entry of slice.entries) {
    const guard = entry.guard === null ? '' : ` guard=${entry.guard}`;
    const session = entry.sessionId === null ? '' : ` session=${entry.sessionId}`;
    options.streams.out(
      `#${String(entry.id)} ${entry.at} ${entry.kind} ${entry.outcome} via=${entry.adapter}${guard}${session}`,
    );
  }

  options.streams.out(
    `${String(slice.entries.length)} of ${String(slice.total)} matching entries.${
      slice.cursor === null ? '' : ` Read on with --since ${String(slice.cursor)}.`
    }`,
  );

  return COMMAND_EXIT.accepted;
}
