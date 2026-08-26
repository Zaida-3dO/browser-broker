import type { Database } from 'better-sqlite3';

import {
  readCaptureDiffActivity,
  readCaptureRollup,
  readMostDiffedTargets,
  type CaptureGroup,
  type CaptureWindow,
  type DiffOutcomes,
} from '../operations/telemetry.ts';

/**
 * `broker captures` — the capture telemetry rollups (`MILESTONES.md` #37).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS COMMAND EXISTS, AND WHY IT IS A COMMAND
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §1.7 justifies eleven columns on `captures` — the tier, the written reason,
 * the source dimensions beside the written ones, the warning flag — and every
 * one of those justifications is a sentence about somebody *reading* it later.
 * `warned` is the clearest: it exists because "the only way to find out whether
 * the warning changes behaviour is to know which captures carried one". Until
 * something adds them up, that is a claim with no way to be checked, and the
 * columns are storage with a rationale and no evidence — the same argument #48
 * makes for `broker diffs`, applied to the table beside it.
 *
 * ── Why the command line rather than the snapshot ───────────────────────
 *
 * Both were on the table and the specification settles it, in two places that
 * agree:
 *
 * - **§5.4 lists the operations commands** and names "**list captures · list
 *   diffs**" among them. This surface is where reading recorded history
 *   belongs, which is also where `events` and `diffs` already live.
 * - **§4.2 lists what is in the document** — and it is a closed table of seven
 *   sections, none of which is captures or comparisons. It even records what
 *   was *deliberately* left out and why. Adding a section to a document whose
 *   contents are enumerated in the specification would be a change to that
 *   specification, made by a row that was not asked to make one.
 *
 * The snapshot is also the wrong *shape* for this. §4.2 describes a document
 * about the state of the installation right now — live leases, the queue, the
 * budget — and §4.5 says it "does not refresh". A rollup is a question about a
 * **window** that the caller chooses, which is an argument, and a document
 * generated with no arguments has nowhere to put one.
 *
 * ── REACHABLE FROM THE COMMAND LINE ────────────────────────────────────
 *
 * `broker captures` is registered in `STANDALONE_COMMANDS` in
 * `src/cli/commands.ts` and dispatched to {@link runCaptures} by
 * `src/cli/index.ts`, which passes the stepped store's handle and the streams.
 * That is two hops a doubting reader can follow, and it is stated this way
 * rather than asserted as prose because — as `diffs.ts` puts it — "prose
 * describing an absence stops being true the moment the absence is filled, and
 * nothing type-checks a paragraph".
 *
 * It takes no lease, because it decides nothing: it is a read of what has
 * already been recorded, the same reason `events` and `diffs` are not
 * operations either.
 */

/** Where output goes, injected so a test reads it instead of the terminal. */
export interface TelemetryStreams {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface CapturesOptions {
  readonly db: Database;
  readonly streams: TelemetryStreams;
}

export const CAPTURES_USAGE = [
  'broker captures — what pictures cost, and what diffs did.',
  '',
  'Usage:',
  '  broker captures [--since <t>] [--until <t>] [--lease <id>] [--json]',
  '  broker captures --capture <id> [--limit <n>] [--json]',
  '  broker captures --targets [--limit <n>] [--json]',
  '',
  'The window is half-open: --since includes its instant, --until excludes it,',
  'so two adjacent windows partition the captures rather than sharing one.',
  '  --since <t>     captures taken at or after this timestamp',
  '  --until <t>     captures taken strictly before this timestamp',
  '  --lease <id>    only captures taken under this lease',
  '  --capture <id>  instead: what diffs ran from and against one capture',
  '  --targets       instead: which captures are most diffed against',
  '  --limit <n>     at most this many rows, where a listing is returned',
  '  --json          one JSON document, for something reading rather than someone',
].join('\n');

/**
 * What the arguments parsed to, or the complaint about why they did not.
 *
 * A result rather than a throw, so the caller decides the exit code and the
 * parse stays testable without catching — the shape `diffs.ts` established.
 */
export type ParsedCapturesArguments =
  | {
      readonly ok: true;
      readonly mode: 'rollup';
      readonly window: CaptureWindow;
      readonly json: boolean;
    }
  | {
      readonly ok: true;
      readonly mode: 'capture';
      readonly captureId: string;
      readonly limit?: number;
      readonly json: boolean;
    }
  | { readonly ok: true; readonly mode: 'targets'; readonly limit?: number; readonly json: boolean }
  | { readonly ok: false; readonly message: string };

const WINDOW_FLAGS: Readonly<Record<string, 'since' | 'until' | 'claimId'>> = {
  '--since': 'since',
  '--until': 'until',
  '--lease': 'claimId',
};

/**
 * Parse the arguments after `captures`.
 *
 * **An unrecognised flag refuses rather than being ignored**, and a
 * value-taking flag with nothing after it refuses too. Ignoring either would
 * run a query nobody asked for and print a result that looks like an answer.
 *
 * **The three modes are mutually exclusive and saying so is the point.**
 * `--capture` asks about one picture's diffs and `--targets` asks which
 * pictures get diffed against; neither takes a window. Silently ignoring a
 * window passed beside one of them would print a number labelled with a
 * restriction that was never applied, which is the specific way a telemetry
 * read gets believed when it should not be.
 */
export function parseCapturesArguments(argv: readonly string[]): ParsedCapturesArguments {
  const window: { since?: string; until?: string; claimId?: string } = {};
  let captureId: string | undefined;
  let targets = false;
  let limit: number | undefined;
  let json = false;

  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at] ?? '';

    if (argument === '--json') {
      json = true;
      continue;
    }

    if (argument === '--targets') {
      targets = true;
      continue;
    }

    if (argument === '--limit') {
      const raw = argv[at + 1];
      if (raw === undefined) {
        return { ok: false, message: '--limit needs a number.' };
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        return { ok: false, message: `--limit needs a number, not ${raw}.` };
      }
      limit = parsed;
      at += 1;
      continue;
    }

    if (argument === '--capture') {
      const raw = argv[at + 1];
      if (raw === undefined) {
        return { ok: false, message: '--capture needs a capture identifier.' };
      }
      captureId = raw;
      at += 1;
      continue;
    }

    const field = WINDOW_FLAGS[argument];
    if (field !== undefined) {
      const raw = argv[at + 1];
      if (raw === undefined) {
        return { ok: false, message: `${argument} needs a value.` };
      }
      window[field] = raw;
      at += 1;
      continue;
    }

    return { ok: false, message: `Unrecognised option: ${argument}` };
  }

  const hasWindow =
    window.since !== undefined || window.until !== undefined || window.claimId !== undefined;

  if (captureId !== undefined && targets) {
    return { ok: false, message: '--capture and --targets ask different questions; pick one.' };
  }
  if (captureId !== undefined && hasWindow) {
    return {
      ok: false,
      message: '--capture asks about one capture, so it takes no window.',
    };
  }
  if (targets && hasWindow) {
    return {
      ok: false,
      message: '--targets asks across every comparison, so it takes no window.',
    };
  }

  if (captureId !== undefined) {
    return { ok: true, mode: 'capture', captureId, limit, json };
  }
  if (targets) {
    return { ok: true, mode: 'targets', limit, json };
  }
  return { ok: true, mode: 'rollup', window, json };
}

/** A count and its share of a total, where a bare count invites the wrong reading. */
function share(part: number, whole: number): string {
  if (whole === 0) {
    return '0';
  }
  return `${String(part)} (${String(Math.round((part / whole) * 100))}%)`;
}

function renderGroups(label: string, groups: readonly CaptureGroup[]): readonly string[] {
  if (groups.length === 0) {
    return [];
  }
  return [
    `${label}:`,
    ...groups.map(
      (group) =>
        `  ${group.group.padEnd(10)} ${String(group.captures).padStart(5)} captures  ` +
        `${String(group.bytes).padStart(10)} bytes  ` +
        `${String(group.estimatedTokens).padStart(9)} est. tokens`,
    ),
  ];
}

function renderOutcomes(label: string, outcomes: DiffOutcomes): readonly string[] {
  if (outcomes.comparisons === 0) {
    return [`${label}: none.`];
  }
  return [
    `${label}: ${String(outcomes.comparisons)} comparisons, ` +
      `${share(outcomes.changed, outcomes.comparisons)} found a change, ` +
      `${String(outcomes.truncated)} truncated.`,
    ...outcomes.settings.map(
      (use) =>
        `  tolerance ${String(use.colourTolerance)}, ` +
        `min area ${String(use.minimumRegionArea)}, ` +
        `max regions ${String(use.maximumRegions)}: ` +
        `${String(use.comparisons)} comparisons, ${String(use.changed)} changed`,
    ),
  ];
}

/**
 * Run `broker captures`.
 *
 * Returns an exit code rather than exiting, so the dispatcher owns the process
 * and a test can drive this in the same way the parity suite drives the rest of
 * the command surface.
 */
export function runCaptures(rest: readonly string[], options: CapturesOptions): number {
  if (rest.includes('--help')) {
    options.streams.out(CAPTURES_USAGE);
    return 0;
  }

  const parsed = parseCapturesArguments(rest);
  if (!parsed.ok) {
    options.streams.err(parsed.message);
    options.streams.err(CAPTURES_USAGE);
    return 2;
  }

  if (parsed.mode === 'capture') {
    const activity = readCaptureDiffActivity(options.db, parsed.captureId, parsed.limit);
    if (parsed.json) {
      options.streams.out(JSON.stringify(activity));
      return 0;
    }
    options.streams.out(`Capture ${activity.captureId}`);
    for (const line of renderOutcomes('  Diffs run FROM it', activity.asSource)) {
      options.streams.out(line);
    }
    for (const line of renderOutcomes('  Diffs run AGAINST it', activity.asTarget)) {
      options.streams.out(line);
    }
    return 0;
  }

  if (parsed.mode === 'targets') {
    const rows = readMostDiffedTargets(options.db, parsed.limit);
    if (parsed.json) {
      options.streams.out(JSON.stringify({ targets: rows }));
      return 0;
    }
    if (rows.length === 0) {
      options.streams.out('No comparisons recorded.');
      return 0;
    }
    options.streams.out('Most diffed against — a baseline in behaviour, not in the schema:');
    for (const row of rows) {
      options.streams.out(
        `  ${row.captureId}  ${String(row.comparisons)} comparisons, ` +
          `${String(row.changed)} changed  ${row.url ?? '(capture row gone)'}`,
      );
    }
    return 0;
  }

  const rollup = readCaptureRollup(options.db, parsed.window);

  if (parsed.json) {
    options.streams.out(JSON.stringify(rollup));
    return 0;
  }

  if (rollup.total.captures === 0) {
    options.streams.out('No captures in this window.');
    return 0;
  }

  const total = rollup.total;
  options.streams.out(
    `${String(total.captures)} captures, ${String(total.bytes)} bytes, ` +
      `${String(total.estimatedTokens)} estimated tokens.`,
  );
  options.streams.out(
    `${share(total.downscaled, total.captures)} were downscaled; ` +
      `${share(total.warned, total.captures)} carried the accounting warning.`,
  );

  for (const line of renderGroups('By tier', rollup.byTier)) {
    options.streams.out(line);
  }
  for (const line of renderGroups('By kind', rollup.byKind)) {
    options.streams.out(line);
  }

  if (rollup.escalationReasons.length > 0) {
    options.streams.out('Why callers escalated, as written:');
    for (const reason of rollup.escalationReasons) {
      options.streams.out(`  ${reason.takenAt}  ${reason.reason}`);
    }
  }

  return 0;
}
