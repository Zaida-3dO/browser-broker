import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { OPERATION_COMMANDS, STANDALONE_COMMANDS } from '../../src/cli/commands.ts';

/**
 * The help text and the parser, compared **programmatically**.
 *
 * `broker claim --wait` and `broker events` both worked for a while without
 * appearing in any `--help` output, and the reason they could is structural:
 * the flags a command *accepts* are written in that command's parser, while
 * the flags it *advertises* are written in the command table. Two lists that
 * have to agree is one list somebody eventually forgets, and the forgetting is
 * silent — a caller cannot use what it cannot discover, so an option that
 * works and goes undocumented does not exist for most of the people who need
 * it.
 *
 * Comparing them by eye is what let the drift happen in the first place. This
 * test reads the flags out of the parser sources and the flags out of the
 * table, and fails on any disagreement — which turns a whole class of drift
 * into a gate rather than a thing somebody notices later.
 *
 * **It is deliberately a source-level comparison.** Driving `--help` alone
 * could only ever confirm that the table renders, never that the table matches
 * what the parser will actually accept; the interesting failure is precisely
 * the flag that exists in one and not the other.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const cliDirectory = path.join(here, '..', '..', 'src', 'cli');

/**
 * Flags every command takes, rendered by the help writer rather than declared
 * per command — so they are expected in the parsers and absent from the table.
 */
const UNIVERSAL_FLAGS = new Set(['--json', '--help']);

/**
 * Flags that are deliberately not options of the command they appear beside.
 *
 * `--version` is a top-level flag rather than a command's option, and `--` is
 * the end-of-options separator. Both are **named here rather than filtered by
 * a pattern**, because a pattern that quietly excluded a real flag would
 * reintroduce exactly the silence this test exists to break.
 */
const NOT_COMMAND_OPTIONS = new Set(['--version', '--']);

/** Every command in the table, with the flags it advertises. */
function advertisedFlags(): Map<string, Set<string>> {
  const byCommand = new Map<string, Set<string>>();
  for (const command of [...OPERATION_COMMANDS, ...STANDALONE_COMMANDS]) {
    const flags = new Set<string>();
    for (const option of command.options ?? []) {
      // The table writes a flag with its value placeholder (`--limit <n>`);
      // the parser matches the bare flag. Compare the bare flag.
      flags.add(option.flag.split(/\s+/)[0] ?? option.flag);
    }
    byCommand.set(command.words.join(' '), flags);
  }
  return byCommand;
}

/** Every long flag a source file compares an argument against. */
function flagsMentionedIn(file: string): Set<string> {
  const source = fs.readFileSync(file, 'utf8');
  const found = new Set<string>();
  // Only string literals, which is how the parsers test an argument
  // (`argument === '--out'`). Prose in a comment is not a parse.
  for (const match of source.matchAll(/'(--[a-z][a-z-]*)'/g)) {
    const flag = match[1];
    if (flag === undefined) continue;
    if (UNIVERSAL_FLAGS.has(flag) || NOT_COMMAND_OPTIONS.has(flag)) continue;
    found.add(flag);
  }
  return found;
}

/**
 * Every flag a source file passes to `parseFlags` as an accepted name.
 *
 * ── Why a second extractor rather than a wider pattern ──────────────────
 *
 * {@link flagsMentionedIn} finds a flag by the string literal a parser
 * compares against, which carries the `--` prefix. The accepted sets handed
 * to `parseFlags` are **bare words** — `parseFlags(rest, ['browser',
 * 'session-id'])` — because `parseFlags` strips the prefix before it looks
 * anything up. One extractor cannot read both shapes without matching every
 * quoted lower-case word in the file, which would sweep up SQL column names,
 * event kinds and outcome strings and drown the real signal in false
 * positives.
 *
 * So this reads the **call site** instead: it finds `parseFlags(` and takes
 * the array literal that follows, which is precisely the list `parseFlags`
 * will accept and nothing else. Each bare word is given the `--` prefix a
 * caller actually types, so the result compares directly against the table.
 *
 * Deliberately **only literal arrays written at the call site**. A set built
 * somewhere else and passed in by name would return nothing here, and nothing
 * is a result the non-vacuity test rejects loudly rather than accepting as
 * "this command has no flags" — which is the whole failure this file exists
 * to prevent.
 */
function acceptedFlagsIn(file: string): Set<string> {
  return acceptedFlagsInSource(fs.readFileSync(file, 'utf8'));
}

/**
 * Which source file parses which command's arguments.
 *
 * Written out rather than inferred: a mapping guessed from filenames would
 * silently cover nothing if a file were renamed, and a test that silently
 * covers nothing is the failure mode this whole file is about.
 *
 * `extract` names which extractor reads this command, because the two parse
 * shapes are genuinely different and a row has to say which one it is:
 * {@link flagsMentionedIn} for a parser that compares a prefixed literal, and
 * a `parseFlags` reader for one that declares an accepted set.
 */
const PARSERS: readonly {
  command: string;
  file: string;
  extract: (file: string) => Set<string>;
}[] = [
  { command: 'diffs', file: 'diffs.ts', extract: flagsMentionedIn },
  { command: 'image', file: 'image.ts', extract: flagsMentionedIn },
  // The three `parseFlags` consumers, derived from their call sites rather
  // than written out. A fourth one added tomorrow is covered by adding its
  // row here — and if somebody forgets the row, the count assertion below is
  // what says so.
  { command: 'snapshot', file: 'operations-commands.ts', extract: snapshotAcceptedFlags },
  { command: 'events', file: 'operations-commands.ts', extract: eventsAcceptedFlags },
  { command: 'reconcile', file: 'reconcile-command.ts', extract: acceptedFlagsIn },
];

/**
 * `operations-commands.ts` holds two commands' call sites in one file, so the
 * file-level extractor cannot answer for either alone. Each is narrowed to its
 * own function body first.
 *
 * Split on the function declaration rather than by line number: a line number
 * goes stale the moment anything above it moves, and goes stale *silently*.
 */
function bodyOf(file: string, functionName: string): string {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf(`export function ${functionName}`);
  const startAsync = source.indexOf(`export async function ${functionName}`);
  const from = start === -1 ? startAsync : start;
  assert.ok(from !== -1, `${functionName} is not declared in ${path.basename(file)}`);
  // To the next top-level declaration, or the end of the file.
  const rest = source.slice(from + 1);
  const next = rest.search(/\nexport (?:async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

function acceptedFlagsInSource(source: string): Set<string> {
  const found = new Set<string>();
  for (const call of source.matchAll(/parseFlags\(\s*\w+\s*,\s*\[([^\]]*)\]/g)) {
    const list = call[1];
    if (list === undefined) continue;
    for (const word of list.matchAll(/'([a-z][a-z-]*)'/g)) {
      const name = word[1];
      if (name === undefined) continue;
      const flag = `--${name}`;
      if (UNIVERSAL_FLAGS.has(flag) || NOT_COMMAND_OPTIONS.has(flag)) continue;
      found.add(flag);
    }
  }
  return found;
}

function snapshotAcceptedFlags(file: string): Set<string> {
  const flags = acceptedFlagsInSource(bodyOf(file, 'runSnapshotCommand'));
  // `--output` and `--path` are long-standing spellings of `--out` that the
  // command still reads and the table deliberately does not teach, because one
  // name is what a table should teach. Named here one at a time rather than
  // filtered by a pattern: a pattern broad enough to cover an alias would be
  // broad enough to hide the next real flag, which is this file's whole
  // subject. Removing either from the source will fail the not-empty check on
  // this row rather than passing quietly.
  flags.delete('--output');
  flags.delete('--path');
  return flags;
}

function eventsAcceptedFlags(file: string): Set<string> {
  return acceptedFlagsInSource(bodyOf(file, 'runEventsCommand'));
}

/**
 * Commands whose flags this file's extractor cannot see, with the flags they
 * are known to take.
 *
 * ── Why a second list rather than more rows in the first ────────────────
 *
 * {@link flagsMentionedIn} finds a flag by matching the string literal a
 * parser compares against (`argument === '--out'`). Two of the commands that
 * had drifted do not parse that way and so are invisible to it:
 *
 * - **`claim`** and its eleven siblings go through `parseArguments`, which
 *   normalises every `--name` into a record and hands the whole record to the
 *   service. The service schema is the list; the CLI never names these flags,
 *   so there is nothing in the CLI source to derive them from. Deriving these
 *   means reading the operation schema instead, which is a larger piece and
 *   overlaps the open follow-up about refusing unknown arguments at the
 *   `parseArguments` seam. Left written out until those are done together.
 *
 * **A command belongs here only when the CLI holds no list to read.** Anything
 * that calls `parseFlags` declares its accepted set at the call site, so it
 * belongs in {@link PARSERS} instead, where {@link acceptedFlagsIn} derives
 * the flags from source and they cannot go stale. This list is the last
 * resort, not the default — one entry, for the one parse shape that keeps its
 * list somewhere the CLI cannot see.
 *
 * The direction it protects is the one that matters: a flag named here and
 * absent from the table fails.
 */
const DECLARED_FLAG_COMMANDS: readonly { command: string; flags: readonly string[] }[] = [
  // The two `claim` refuses for omitting: `claim.session_bounded` and
  // `claim.purpose_bounded`. A required argument missing from `--help` is the
  // worst case of this defect — the command cannot be run successfully by
  // anybody reading its own help.
  { command: 'claim', flags: ['--session-id', '--purpose'] },
];

test('every flag a command parses is advertised in its --help', () => {
  const advertised = advertisedFlags();

  const undocumented: string[] = [];
  for (const { command, file, extract } of PARSERS) {
    const parsed = extract(path.join(cliDirectory, file));
    const shown = advertised.get(command);
    assert.ok(shown !== undefined, `${command} is parsed but absent from the command table`);
    for (const flag of parsed) {
      if (!shown.has(flag)) {
        undocumented.push(`${command} accepts ${flag} but does not document it`);
      }
    }
  }

  assert.deepEqual(
    undocumented,
    [],
    `these options work but cannot be discovered:\n  ${undocumented.join('\n  ')}`,
  );
});

test('every flag a command advertises is one it actually parses', () => {
  const advertised = advertisedFlags();

  const phantom: string[] = [];
  for (const { command, file, extract } of PARSERS) {
    const parsed = extract(path.join(cliDirectory, file));
    for (const flag of advertised.get(command) ?? []) {
      if (!parsed.has(flag)) {
        phantom.push(`${command} documents ${flag} but does not parse it`);
      }
    }
  }

  // The mirror of the test above, and worth having separately: a help text
  // promising a flag that does nothing wastes a caller's time just as surely
  // as one omitting a flag that works.
  assert.deepEqual(
    phantom,
    [],
    `these options are documented but not accepted:\n  ${phantom.join('\n  ')}`,
  );
});

test('a flag a command is known to take appears in its --help', () => {
  const advertised = advertisedFlags();

  const undocumented: string[] = [];
  for (const { command, flags } of DECLARED_FLAG_COMMANDS) {
    const shown = advertised.get(command);
    assert.ok(shown !== undefined, `${command} is absent from the command table`);
    for (const flag of flags) {
      if (!shown.has(flag)) {
        undocumented.push(`${command} takes ${flag} but does not document it`);
      }
    }
  }

  assert.deepEqual(
    undocumented,
    [],
    `these options are required and cannot be discovered:\n  ${undocumented.join('\n  ')}`,
  );
});

test('THE PARSER LIST IS NOT EMPTY, so a green result means something', () => {
  // A comparison over an empty set passes trivially. This project has been
  // caught twice by a signal that could not be told from a non-signal, so the
  // gate asserts it actually looked at something.
  assert.ok(PARSERS.length > 0);
  for (const { command, file, extract } of PARSERS) {
    const flags = extract(path.join(cliDirectory, file));
    assert.ok(
      flags.size > 0,
      `${command} yielded no flags at all from ${file} — the extraction is broken, not the sources`,
    );
  }

  // The same question of the second list. It compares against the command
  // table rather than a source file, so its way of covering nothing is a
  // command name that matches no row — which would pass every assertion above
  // by never entering the loop.
  assert.ok(DECLARED_FLAG_COMMANDS.length > 0);
  const advertised = advertisedFlags();
  for (const { command, flags } of DECLARED_FLAG_COMMANDS) {
    assert.ok(flags.length > 0, `${command} names no flags — the row asserts nothing`);
    assert.ok(advertised.has(command), `${command} matches no row in the command table`);
  }
});

test('every parseFlags call site in the CLI is covered by a row above', () => {
  // The gap this closes. The rows above derive their flags from source, so a
  // flag added to a covered command cannot escape — but a *fourth command*
  // calling `parseFlags` would simply not be looked at, which is how the two
  // flags in the original defect got out. Rather than trusting the list to be
  // complete, count the call sites in the sources and require the rows to
  // account for all of them.
  const files = fs
    .readdirSync(cliDirectory)
    .filter((name) => name.endsWith('.ts'))
    .sort();

  const callSites: string[] = [];
  for (const name of files) {
    const source = fs.readFileSync(path.join(cliDirectory, name), 'utf8');
    // Requiring the array literal is what keeps the *declaration* of
    // `parseFlags` out of the count: it is followed by a parameter list, not
    // by `rest, [`.
    const calls = [...source.matchAll(/parseFlags\(\s*\w+\s*,\s*\[/g)];
    callSites.push(...calls.map(() => name));
  }

  assert.ok(
    callSites.length > 0,
    'no parseFlags call sites found at all — the search is broken, not the sources',
  );

  // Every call site must be spoken for by a row whose extractor reads that
  // file. A file with two call sites needs two rows, which is why this counts
  // rather than comparing sets of filenames.
  const covered = PARSERS.filter((row) => row.extract !== flagsMentionedIn).map((row) => row.file);

  assert.deepEqual(
    [...covered].sort(),
    [...callSites].sort(),
    'a parseFlags call site is not covered by any row in PARSERS — a command that accepts ' +
      'flags is not being checked against its --help, which is exactly the drift this file ' +
      'exists to catch. Add a row for it.',
  );
});
