import type { OperationName } from '../adapter/operations.ts';

/**
 * The command table: `broker <noun> <verb>`, and the single-word commands.
 *
 * `SCHEMA.md` §5.1 gives the shape and §5.3 gives the list: every §3
 * operation has a command, "so parity is real rather than claimed". The table
 * is data rather than a switch statement for one reason that matters — the
 * conformance driver reads it to translate a neutral case input into an
 * argument vector, so the command a caller types and the command the parity
 * suite drives are the same string. A switch would let those two drift, and
 * the drift would be invisible.
 */

/** A command that mirrors one service operation (§5.3). */
export interface OperationCommand {
  /** The words that name it: `['tab', 'replace']`, `['claim']`. */
  readonly words: readonly string[];
  readonly operation: OperationName;
  readonly summary: string;
  /**
   * Options this command accepts beyond the two every command takes.
   *
   * **Here rather than written out in the help renderer**, for the reason this
   * table's own header gives: two lists that have to agree is one list
   * somebody eventually forgets, and the forgetting is silent. A caller cannot
   * use what it cannot discover, so an option that works and goes undocumented
   * does not exist for most of the people who need it.
   */
  readonly options?: readonly CommandOption[];
}

/** One documented option, as `broker <command> --help` prints it. */
export interface CommandOption {
  /** The flag as it is typed, including any value placeholder. */
  readonly flag: string;
  readonly summary: string;
}

/**
 * Ten commands for ten tools (§5.3).
 *
 * The diff rides on `capture` as an argument exactly as it does on the tool
 * surface (§3.11) rather than being an eleventh command, and the two removed
 * tools are absent rather than deprecated (§3.1).
 */
export const OPERATION_COMMANDS: readonly OperationCommand[] = [
  {
    words: ['claim'],
    operation: 'claim',
    summary: 'Ask for a lease. Get one tab, or a place in the queue.',
    options: [
      {
        flag: '--wait',
        summary:
          'Poll a queued place until it is granted, lost or refused, rather than returning the place.',
      },
    ],
  },
  { words: ['status'], operation: 'status', summary: 'Where your lease stands. Extends it.' },
  {
    words: ['release'],
    operation: 'release',
    summary: 'Give back your tab, or your place in the queue.',
  },
  {
    words: ['tab', 'replace'],
    operation: 'tab_replace',
    summary: 'Discard this lease’s tab and open a fresh one in its place.',
  },
  { words: ['navigate'], operation: 'navigate', summary: 'Point your tab at an address.' },
  {
    words: ['act'],
    operation: 'act',
    summary: 'Click, type, fill, press, select, hover, check, scroll, resize, emulate, dialog.',
  },
  {
    words: ['read'],
    operation: 'read',
    summary: 'The page snapshot; console, network or cookies on request.',
  },
  { words: ['evaluate'], operation: 'evaluate', summary: 'Evaluate an expression in the page.' },
  {
    words: ['capture'],
    operation: 'capture',
    summary: 'Take a picture, and optionally the difference from an earlier one.',
  },
  {
    words: ['feedback'],
    operation: 'feedback',
    summary:
      'Record that something helped or got in the way; with no arguments, read the rows back.',
  },
];

/**
 * A command with no service operation behind it (§5.5).
 *
 * Each of these carries a **written waiver** in the parity suite rather than
 * being quietly absent from the matrix (`MILESTONES.md`). The waiver text
 * lives with the adapter definition, next to the operations it sits beside,
 * because a reason kept somewhere else is a reason nobody reads.
 */
export interface StandaloneCommand {
  readonly words: readonly string[];
  readonly summary: string;
  /** The row that builds it, so an unimplemented command says so honestly. */
  readonly owedBy: string;
  /** See {@link OperationCommand.options}. */
  readonly options?: readonly CommandOption[];
}

/**
 * The commands with no service operation behind them.
 *
 * §5.5 names four; the fifth is `diffs`, which reads the comparison history
 * back. It sits here rather than beside the operations because it decides
 * nothing and takes no lease — it is a read of what has already been recorded,
 * which is the same reason `events` is not an operation either.
 */
export const STANDALONE_COMMANDS: readonly StandaloneCommand[] = [
  {
    words: ['snapshot'],
    summary: 'Write the operations document to a path and exit.',
    owedBy: 'the row that builds the operations document',
  },
  {
    words: ['doctor'],
    summary: 'Report every precondition separately, and exit non-zero on any failure.',
    owedBy: 'the row that builds the preconditions report',
  },
  {
    words: ['login'],
    summary: 'Claim a browser for a person to sign in to.',
    owedBy: 'the row that builds the sign-in handshake',
  },
  {
    words: ['init'],
    summary: 'Run the setup handshake explicitly and show its report.',
    owedBy: 'the row that builds the setup report',
  },
  {
    words: ['diffs'],
    summary: 'List the recorded comparisons, filtered by lease, tab or outcome.',
    owedBy: 'the row that builds changed-region review',
    options: [
      { flag: '--capture <id>', summary: 'Only comparisons made from this capture.' },
      { flag: '--target <id>', summary: 'Only comparisons made against this earlier capture.' },
      { flag: '--lease <id>', summary: 'Only comparisons recorded under this lease.' },
      { flag: '--limit <n>', summary: 'At most this many comparisons.' },
    ],
  },
  {
    // The bytes of one recorded image, named by the identifier of a row.
    // Standalone for the same reason `diffs` is: it takes no tab budget,
    // drives no browser and decides nothing — it reads what is already
    // recorded. §3.1 fixes the agent surface at ten tools and none of them
    // serves bytes, deliberately: the tools return paths so a caller pays for
    // the part it opens.
    words: ['image'],
    summary: 'Write the bytes of one recorded image — a capture, an overlay or a region crop.',
    owedBy: 'the row that builds image delivery',
    options: [
      { flag: '--capture <id>', summary: 'The capture whose bytes to write.' },
      { flag: '--overlay <id>', summary: 'The comparison whose overlay to write.' },
      { flag: '--region <id>', summary: 'The comparison whose changed region to crop.' },
      { flag: '--index <n>', summary: 'Which region, largest first; defaults to the largest.' },
      { flag: '--side <before|after>', summary: 'Which capture a region crop is cut from.' },
      { flag: '--out <file>', summary: 'The file to write the bytes to. Required.' },
      { flag: '--lease-key <key>', summary: 'Your lease key; an artifact belongs to its lease.' },
    ],
  },
  {
    // The capture telemetry rollups (#37). Standalone for the same reason
    // `diffs` is: it takes no lease and no tab budget, drives no browser and
    // decides nothing — it adds up what has already been recorded. §5.4 puts
    // "list captures" on the operations command surface, which is this one.
    words: ['captures'],
    summary: 'What pictures cost, and what diffs did, over a window.',
    owedBy: 'the row that builds the capture telemetry rollups',
    options: [
      { flag: '--since <t>', summary: 'Captures taken at or after this timestamp.' },
      { flag: '--until <t>', summary: 'Captures taken strictly before this timestamp.' },
      { flag: '--lease <id>', summary: 'Only captures taken under this lease.' },
      { flag: '--capture <id>', summary: 'Instead: what diffs ran from and against one capture.' },
      { flag: '--targets', summary: 'Instead: which captures are most diffed against.' },
      { flag: '--limit <n>', summary: 'At most this many rows, where a listing is returned.' },
    ],
  },
  {
    // Reading the ledger back. Standalone for the same reason `diffs` is: it
    // takes no lease and no tab budget, drives no browser and decides nothing —
    // it is a read of history. Listed here because this table is what
    // `broker --help` prints, and a command absent from it is a command a
    // caller has no way to discover.
    words: ['events'],
    summary: 'Read the decision ledger, filtered by kind, outcome, guard, session or claim.',
    owedBy: 'the row that builds the ledger read',
    options: [
      { flag: '--kind <a,b>', summary: 'Only these event kinds, comma-separated.' },
      { flag: '--outcome <name>', summary: 'Only entries with this outcome.' },
      { flag: '--guard <rule>', summary: 'Only entries naming this rule.' },
      { flag: '--session-id <id>', summary: 'Only entries for this session.' },
      { flag: '--claim-id <id>', summary: 'Only entries for this claim.' },
      { flag: '--since <n>', summary: 'Entries after this cursor, oldest first.' },
      { flag: '--before <n>', summary: 'Entries before this cursor.' },
      { flag: '--limit <n>', summary: 'At most this many entries.' },
    ],
  },
];

/** What a parsed argument vector turned out to be. */
export type ParsedCommand =
  | {
      readonly kind: 'operation';
      readonly command: OperationCommand;
      readonly rest: readonly string[];
    }
  | {
      readonly kind: 'standalone';
      readonly command: StandaloneCommand;
      readonly rest: readonly string[];
    }
  | { readonly kind: 'unknown'; readonly attempted: string };

/**
 * Match an argument vector against the table, longest name first.
 *
 * Longest first is not a preference: `tab replace` is two words and `tab`
 * alone is not a command, so a shortest-first match would resolve `tab
 * replace` to an unknown noun and never reach the verb.
 */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const candidates = [
    ...OPERATION_COMMANDS.map((command) => ({ kind: 'operation' as const, command })),
    ...STANDALONE_COMMANDS.map((command) => ({ kind: 'standalone' as const, command })),
  ].sort((a, b) => b.command.words.length - a.command.words.length);

  for (const candidate of candidates) {
    const { words } = candidate.command;
    if (words.every((word, index) => argv[index] === word)) {
      const rest = argv.slice(words.length);
      return candidate.kind === 'operation'
        ? { kind: 'operation', command: candidate.command, rest }
        : { kind: 'standalone', command: candidate.command, rest };
    }
  }

  return { kind: 'unknown', attempted: argv.filter((word) => !word.startsWith('-')).join(' ') };
}
