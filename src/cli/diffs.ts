import type { Database } from 'better-sqlite3';

import { type ComparisonQuery, listComparisons } from '../service/comparison-store.ts';

/**
 * `broker diffs` — the read surface for comparisons (`MILESTONES.md` #48).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS ROW EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════════
 *
 * #48 states it as plainly as any row in the plan:
 *
 * > **The table's entire justification is that tuning reads it, so a version
 * > with nothing reading it has a justification and no evidence.**
 *
 * §1.9 argues the `comparisons` table past the standing rule against storing
 * what can be computed, and the argument that carries it is that a rerun
 * answers a different question once any of the three settings has moved. That
 * argument is only true if somebody can *read* what an earlier call did. A
 * table nothing reads is a table whose justification has never been exercised.
 *
 * So this command is not a convenience on top of the feature. It is the half of
 * the feature that makes the other half worth storing.
 *
 * ── REACHABLE FROM THE COMMAND LINE ────────────────────────────────────
 *
 * `broker diffs` is registered in {@link STANDALONE_COMMANDS} and dispatched
 * to {@link runDiffs} by `src/cli/index.ts`, which passes the stepped store's
 * handle and the streams. It takes no lease, because it decides nothing — it
 * is a read of what has already been recorded, the same reason `events` is
 * not an operation either.
 *
 * **A comment asserting that this command is unreachable would be false**, and
 * worth guarding against specifically: prose describing an absence stops being
 * true the moment the absence is filled, and nothing type-checks a paragraph.
 * The dispatch is one branch in `src/cli/index.ts` and one entry in
 * {@link STANDALONE_COMMANDS}; a reader doubting either can follow both in a
 * single hop, which is the only durable answer to a stale sentence.
 *
 * ── What it shows, and why those columns ────────────────────────────────
 *
 * The three settings, on every row, because they are the whole point: the
 * question tuning asks is "under what numbers did this produce this", and a
 * listing that showed the outcome without the settings would answer half of it.
 * Then the outcome — whether anything changed, how many pixels, how many
 * regions, whether the list was truncated — because a run of rows where
 * `changed` is always false at a tolerance somebody raised is exactly the
 * pattern #43 warns is indistinguishable from the feature working.
 */

/** Where output goes, injected so a test reads it instead of the terminal. */
export interface DiffsStreams {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface DiffsOptions {
  readonly db: Database;
  readonly streams: DiffsStreams;
}

export const DIFFS_USAGE = [
  'broker diffs — list the comparisons this store has recorded.',
  '',
  'Usage:',
  '  broker diffs [--capture <id>] [--target <id>] [--lease <id>] [--limit <n>] [--json]',
  '',
  'Filters combine, so the diffs one lease ran against one capture is two of them:',
  '  --capture <id>  diffs run FROM this capture',
  '  --target <id>   diffs run AGAINST this capture',
  '  --lease <id>    diffs run by this lease',
  '  --limit <n>     at most this many, most recent first',
  '  --json          one JSON document, for something reading rather than someone',
].join('\n');

/**
 * What the arguments parsed to, or the complaint about why they did not.
 *
 * A result rather than a throw, so the caller decides the exit code and the
 * parse stays testable without catching.
 */
export type ParsedDiffsArguments =
  | { readonly ok: true; readonly query: ComparisonQuery; readonly json: boolean }
  | { readonly ok: false; readonly message: string };

const FILTERS: Readonly<Record<string, 'sourceCaptureId' | 'targetCaptureId' | 'claimId'>> = {
  '--capture': 'sourceCaptureId',
  '--target': 'targetCaptureId',
  '--lease': 'claimId',
};

/**
 * Parse the arguments after `diffs`.
 *
 * **An unrecognised flag refuses rather than being ignored**, and a value-taking
 * flag with nothing after it refuses too. Ignoring either would run a query
 * nobody asked for and print a result that looks like an answer — the same
 * reasoning §6.3 applies to a variable that is set and unreadable.
 */
export function parseDiffsArguments(argv: readonly string[]): ParsedDiffsArguments {
  const query: {
    sourceCaptureId?: string;
    targetCaptureId?: string;
    claimId?: string;
    limit?: number;
  } = {};
  let json = false;

  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at] ?? '';

    if (argument === '--json') {
      json = true;
      continue;
    }

    if (argument === '--limit') {
      const raw = argv[at + 1];
      if (raw === undefined) {
        return { ok: false, message: '--limit needs a number after it.' };
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        return {
          ok: false,
          message: `--limit takes a whole number of at least one; got ${JSON.stringify(raw)}.`,
        };
      }
      query.limit = value;
      at += 1;
      continue;
    }

    const field = FILTERS[argument];
    if (field !== undefined) {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, message: `${argument} needs an identifier after it.` };
      }
      query[field] = value;
      at += 1;
      continue;
    }

    return { ok: false, message: `Unrecognised option: ${argument}` };
  }

  return { ok: true, query, json };
}

/** A ratio as a percentage with two decimals, which is the readable form. */
function asPercentage(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

/**
 * Run the command.
 *
 * Returns an exit code rather than exiting, so the whole of it is reachable
 * from a test — the arrangement `src/cli/index.ts` establishes and the reason
 * its dispatcher is importable.
 */
export function runDiffs(argv: readonly string[], options: DiffsOptions): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    options.streams.out(DIFFS_USAGE);
    return 0;
  }

  const parsed = parseDiffsArguments(argv);
  if (!parsed.ok) {
    options.streams.err(parsed.message);
    options.streams.err(DIFFS_USAGE);
    return 2;
  }

  const comparisons = listComparisons(options.db, parsed.query);

  if (parsed.json) {
    options.streams.out(JSON.stringify(comparisons, null, 2));
    return 0;
  }

  if (comparisons.length === 0) {
    // **Says what was asked, not merely that there was nothing.** An empty
    // listing after a mistyped identifier looks identical to one after a
    // correct identifier with no diffs behind it, and the first is far more
    // likely — the same reasoning §1.9 applies to a missing diff target.
    const asked = Object.entries(parsed.query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`);
    options.streams.out(
      asked.length === 0
        ? 'No comparisons recorded. A diff is an optional argument on a capture, so none is recorded until a capture names an earlier one to compare against.'
        : `No comparisons match ${asked.join(', ')}.`,
    );
    return 0;
  }

  for (const comparison of comparisons) {
    options.streams.out(
      [
        comparison.at,
        comparison.id,
        comparison.changed ? 'CHANGED' : 'unchanged',
        `${String(comparison.regions.length)} region(s)${comparison.truncated ? ' (truncated)' : ''}`,
        `${String(comparison.changedPixels)} px (${asPercentage(comparison.changedRatio)})`,
      ].join('  '),
    );
    options.streams.out(
      `    from ${comparison.sourceCaptureId} against ${comparison.targetCaptureId}, lease ${comparison.claimId}`,
    );
    // The three settings, on every row. This is the line tuning reads.
    options.streams.out(
      `    settings: tolerance ${String(comparison.colourTolerance)}, minimum area ${String(comparison.minimumRegionArea)} px squared, at most ${String(comparison.maximumRegions)} regions`,
    );
    options.streams.out(`    overlay: ${comparison.overlayPath}`);
  }

  options.streams.out(
    `${String(comparisons.length)} comparison${comparisons.length === 1 ? '' : 's'}.`,
  );
  return 0;
}
