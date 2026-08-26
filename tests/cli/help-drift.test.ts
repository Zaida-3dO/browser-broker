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
 * Which source file parses which command's arguments.
 *
 * Written out rather than inferred: a mapping guessed from filenames would
 * silently cover nothing if a file were renamed, and a test that silently
 * covers nothing is the failure mode this whole file is about.
 */
const PARSERS: readonly { command: string; file: string }[] = [
  { command: 'diffs', file: 'diffs.ts' },
  { command: 'image', file: 'image.ts' },
];

test('every flag a command parses is advertised in its --help', () => {
  const advertised = advertisedFlags();

  const undocumented: string[] = [];
  for (const { command, file } of PARSERS) {
    const parsed = flagsMentionedIn(path.join(cliDirectory, file));
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
  for (const { command, file } of PARSERS) {
    const parsed = flagsMentionedIn(path.join(cliDirectory, file));
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

test('THE PARSER LIST IS NOT EMPTY, so a green result means something', () => {
  // A comparison over an empty set passes trivially. This project has been
  // caught twice by a signal that could not be told from a non-signal, so the
  // gate asserts it actually looked at something.
  assert.ok(PARSERS.length > 0);
  for (const { file } of PARSERS) {
    const flags = flagsMentionedIn(path.join(cliDirectory, file));
    assert.ok(
      flags.size > 0,
      `${file} yielded no flags at all — the extraction is broken, not the sources`,
    );
  }
});
