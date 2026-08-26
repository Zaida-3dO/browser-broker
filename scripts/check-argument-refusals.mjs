#!/usr/bin/env node
/**
 * The argument-refusal check: **a malformed argument is refused, never
 * crashed on, and never answered with the storage layer's own words.**
 *
 * ── The gap this exists to close, stated as the thing that happened ─────
 *
 * `broker claim` with no `--purpose` ended the process with an unhandled
 * `SqliteError: CHECK constraint failed: length(purpose) BETWEEN 3 AND 200`
 * and exit 1. On the tool surface the same call came back as
 * `unexpected_failure` carrying that sentence verbatim. The bound was real
 * and documented (§1.3); what was missing was a *refusal* — so the only thing
 * enforcing it was the column's own `CHECK`, which fires after the statement
 * has been handed to the driver.
 *
 * It survived thirty merged pull requests on one of the first commands
 * anybody runs, and was found three separate times by three separate people
 * before it was fixed. Every existing test called `claim` with a valid
 * purpose, because every existing test was written by somebody who knew the
 * argument was required.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS CHECK PROVES, AND WHAT IT CANNOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Read this before trusting a green run, and read it before extending it.
 *
 * **It is a runtime check, not a scan, and that is the whole design.** The
 * obvious implementation — grep the sources for `SqliteError`, or for a list
 * of driver error names — is the implementation `check-arbitration.mjs`
 * warns about at length: *"a check that greps for `BEGIN` and calls itself
 * done is worse than no check, because sixty rows would trust it"*. The same
 * objection applies here and is worse, because the error this class produces
 * **is never named in the source at all**. Nothing in this repository writes
 * the string `SqliteError`; the driver throws it. A grep would have found
 * nothing, reported green, and been believed.
 *
 * So this spawns the two shipped executables, hands them arguments a caller
 * gets wrong, and reads what comes back.
 *
 * | Claim | Status |
 * |---|---|
 * | For each listed input, the command line exits with the refusal code rather than the crash code | **Checked**, by spawning it |
 * | For each listed input, the command line's output names a rule and not a driver constraint | **Checked**, by reading its output |
 * | For each listed input, the tool surface answers a structured refusal rather than `unexpected_failure` | **Checked**, by speaking the protocol to it |
 * | No response on either surface contains storage-layer vocabulary | **Checked**, over the whole output |
 * | **Every** malformed argument on every operation is refused | **NOT checked.** This ranges over the inputs listed below and nothing else |
 * | A new operation's arguments are guarded | **NOT checked.** Adding one here is a manual step |
 *
 * **The last two rows are the honest limit and they are not hedging.** This
 * is a table-driven check over a list a person maintains: it cannot discover
 * an argument nobody thought of, which is exactly how the original defect
 * survived. What it does guarantee is that the specific class — *a caller's
 * bad argument reaching a storage constraint* — cannot come back **for the
 * inputs named**, and that the seeded violation below proves the mechanism
 * fires rather than merely being present.
 *
 * A future row that adds an argument to a caller-facing operation should add
 * a case here. That instruction is worth as much as the check.
 *
 * ── The seeded violation ────────────────────────────────────────────────
 *
 * `--self-test` re-runs every case against a deliberately broken build, in
 * which the purpose guard is removed and the original defect is therefore
 * present. A check that cannot be made to fail proves nothing, and this one
 * is run by the test suite so the proof travels with it.
 *
 * Usage:
 *   node scripts/check-argument-refusals.mjs
 *   node scripts/check-argument-refusals.mjs --self-test
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ambientEnvironment,
  callLine,
  parseMessages,
  spawnBinary,
  repositoryRoot,
} from './check-operations.mjs';

/**
 * Vocabulary that belongs to the storage layer and must never reach a caller.
 *
 * **This list is not the check.** It is a second, weaker assertion layered on
 * top of the exit-code and refusal-shape assertions above it, and on its own
 * it would be exactly the brittle name-matching this file's header rejects —
 * an error arriving by another route, or a driver renaming its exception,
 * would slip past it. It earns its place only because the strong assertions
 * run first: by the time a response is scanned for these words it has already
 * been established to be a refusal naming a rule.
 */
const STORAGE_VOCABULARY = [
  'SqliteError',
  'SQLITE_',
  'CHECK constraint',
  'UNIQUE constraint',
  'NOT NULL constraint',
  'FOREIGN KEY constraint',
];

/**
 * The exit code the command line uses for a refused call.
 *
 * Named rather than inlined because the assertion that matters is *"refused
 * rather than crashed"*, and an unhandled throw exits 1. Comparing against
 * the refusal code rather than merely `!== 0` is what distinguishes the two:
 * a crash is a non-zero exit too.
 */
const REFUSED_EXIT_CODE = 3;

/**
 * The cases: an argument a caller gets wrong, on an operation they reach for
 * early, together with the rule that should refuse it.
 *
 * ── Why each case names its expected rule ───────────────────────────────
 *
 * Asserting only "something refused" would pass on the wrong refusal, and the
 * wrong refusal is a real failure mode here rather than a hypothetical one:
 * `claim` with no arguments at all is refused by `claim.browser_known`,
 * because the browser is checked first. A case that omitted the purpose *and*
 * the browser would therefore have been green throughout the entire life of
 * this defect. **Every case below supplies every argument except the one
 * under test**, so the named rule is the only one left that can fire.
 */
const CASES = [
  {
    // The same coercion as the purpose case below and a worse outcome. There
    // is no `CHECK` on `claims.session_id`, so `''` satisfied the column and
    // this call **succeeded**: a granted lease, a real key, a real tab, and
    // `session_id = ''` on the claims row and on every ledger event it wrote.
    // Nothing crashed, so nothing was noticed. Every argument except the one
    // under test is supplied, so `claim.session_bounded` is the only rule
    // left that can fire.
    what: 'claim with no session id',
    rule: 'claim.session_bounded',
    argv: ['claim', '--browser', 'regular', '--purpose', 'a purpose of a legal length'],
    tool: {
      name: 'browser_claim',
      arguments: { browser: 'regular', purpose: 'a purpose of a legal length' },
    },
  },
  {
    what: 'claim with an empty session id',
    rule: 'claim.session_bounded',
    argv: [
      'claim',
      '--session-id',
      '',
      '--browser',
      'regular',
      '--purpose',
      'a purpose of a legal length',
    ],
    tool: {
      name: 'browser_claim',
      arguments: { session_id: '', browser: 'regular', purpose: 'a purpose of a legal length' },
    },
  },
  {
    // The type case, which the command line cannot express — every argument
    // it parses is a string — so it is checked on the tool surface only.
    what: 'claim with a session id of the wrong type',
    rule: 'claim.session_bounded',
    argv: undefined,
    tool: {
      name: 'browser_claim',
      arguments: { session_id: 1234, browser: 'regular', purpose: 'a purpose of a legal length' },
    },
  },
  {
    what: 'claim with no purpose',
    rule: 'claim.purpose_bounded',
    argv: ['claim', '--session-id', 'check-argument-refusals', '--browser', 'regular'],
    tool: {
      name: 'browser_claim',
      arguments: { session_id: 'check-argument-refusals', browser: 'regular' },
    },
  },
  {
    what: 'claim with a purpose under the minimum',
    rule: 'claim.purpose_bounded',
    argv: [
      'claim',
      '--session-id',
      'check-argument-refusals',
      '--browser',
      'regular',
      '--purpose',
      'ab',
    ],
    tool: {
      name: 'browser_claim',
      arguments: { session_id: 'check-argument-refusals', browser: 'regular', purpose: 'ab' },
    },
  },
  {
    what: 'claim with a purpose over the maximum',
    rule: 'claim.purpose_bounded',
    argv: [
      'claim',
      '--session-id',
      'check-argument-refusals',
      '--browser',
      'regular',
      '--purpose',
      'x'.repeat(201),
    ],
    tool: {
      name: 'browser_claim',
      arguments: {
        session_id: 'check-argument-refusals',
        browser: 'regular',
        purpose: 'x'.repeat(201),
      },
    },
  },
  {
    // The type case, which the command line cannot express — every argument
    // it parses is a string — so it is checked on the tool surface only.
    what: 'claim with a purpose of the wrong type',
    rule: 'claim.purpose_bounded',
    argv: undefined,
    tool: {
      name: 'browser_claim',
      arguments: { session_id: 'check-argument-refusals', browser: 'regular', purpose: 1234 },
    },
  },
  {
    what: 'claim naming a browser that does not exist',
    rule: 'claim.browser_known',
    argv: [
      'claim',
      '--session-id',
      'check-argument-refusals',
      '--browser',
      'chrome',
      '--purpose',
      'a purpose of a legal length',
    ],
    tool: {
      name: 'browser_claim',
      arguments: {
        session_id: 'check-argument-refusals',
        browser: 'chrome',
        purpose: 'a purpose of a legal length',
      },
    },
  },
  {
    what: 'feedback with a rating outside the scale',
    rule: 'feedback.rating_in_scale',
    argv: [
      'feedback',
      '--rating',
      '9',
      '--category',
      'worked-well',
      '--note',
      'a note comfortably longer than the twenty character floor',
    ],
    tool: {
      name: 'browser_feedback',
      arguments: {
        rating: 9,
        category: 'worked-well',
        note: 'a note comfortably longer than the twenty character floor',
      },
    },
  },
  {
    what: 'feedback with a note under its floor',
    rule: 'feedback.note_bounded',
    argv: ['feedback', '--rating', '3', '--category', 'worked-well', '--note', 'short'],
    tool: {
      name: 'browser_feedback',
      arguments: { rating: 3, category: 'worked-well', note: 'short' },
    },
  },
  {
    what: 'feedback with a category outside the set',
    rule: 'feedback.category_known',
    argv: [
      'feedback',
      '--rating',
      '3',
      '--category',
      'nonsense',
      '--note',
      'a note comfortably longer than the twenty character floor',
    ],
    tool: {
      name: 'browser_feedback',
      arguments: {
        rating: 3,
        category: 'nonsense',
        note: 'a note comfortably longer than the twenty character floor',
      },
    },
  },
];

function containsStorageVocabulary(text) {
  return STORAGE_VOCABULARY.filter((word) => text.includes(word));
}

/**
 * Run every case against one checkout root.
 *
 * `root` is a parameter rather than a constant so `--self-test` can point the
 * whole check at a deliberately broken copy of the sources.
 */
export async function runArgumentRefusalCheck({ root = repositoryRoot } = {}) {
  const failures = [];
  const notes = [];

  const check = (description, condition, detail) => {
    if (condition) {
      notes.push(`  ok   ${description}`);
    } else {
      failures.push(`  FAIL ${description}${detail === undefined ? '' : `\n         ${detail}`}`);
    }
  };

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'broker-argument-check-'));
  const commandLine = path.join(root, 'src', 'bin', 'broker.ts');
  const toolShim = path.join(root, 'src', 'bin', 'broker-tool.ts');

  try {
    const env = {
      ...ambientEnvironment(),
      BROKER_DB: path.join(temporaryRoot, 'broker.db'),
      BROKER_ARTIFACTS_ROOT: path.join(temporaryRoot, 'artifacts'),
      BROKER_PROFILE_ROOT: path.join(temporaryRoot, 'profiles'),
    };

    for (const testCase of CASES) {
      if (testCase.argv !== undefined) {
        const result = await spawnBinary(commandLine, testCase.argv, { env });
        const output = `${result.stdout}${result.stderr}`;

        // The strong assertion: refused, not crashed. An unhandled throw
        // exits 1, so this separates the two rather than accepting any
        // non-zero code.
        check(
          `command line: ${testCase.what} exits ${String(REFUSED_EXIT_CODE)} (refused)`,
          result.code === REFUSED_EXIT_CODE,
          `exited ${String(result.code)}; output began: ${output.split('\n')[0] ?? ''}`,
        );

        check(
          `command line: ${testCase.what} names ${testCase.rule}`,
          output.includes(testCase.rule),
          `output did not name the rule: ${output.slice(0, 300)}`,
        );

        const leaked = containsStorageVocabulary(output);
        check(
          `command line: ${testCase.what} leaks no storage vocabulary`,
          leaked.length === 0,
          `found ${leaked.join(', ')} in: ${output.slice(0, 300)}`,
        );
      }

      const toolResult = await spawnBinary(toolShim, [], {
        env,
        input: callLine(1, testCase.tool.name, testCase.tool.arguments),
      });

      let messages;
      try {
        messages = parseMessages(toolResult.stdout);
      } catch (error) {
        messages = [];
        check(
          `tool surface: ${testCase.what} answers parseable protocol`,
          false,
          `${String(error)} — stdout was: ${toolResult.stdout.slice(0, 300)}`,
        );
      }

      const response = messages[0];
      const serialised = JSON.stringify(response ?? {});

      // The shape assertion. A refusal is a *result* on this surface — the
      // operation was reached and said no — whereas `unexpected_failure` is
      // the session's last-resort catch, which is what the defect produced.
      check(
        `tool surface: ${testCase.what} is a structured refusal, not unexpected_failure`,
        response?.error?.code !== 'unexpected_failure' && response?.result?.outcome === 'refused',
        `answered: ${serialised.slice(0, 300)}`,
      );

      check(
        `tool surface: ${testCase.what} names ${testCase.rule}`,
        serialised.includes(testCase.rule),
        `answered: ${serialised.slice(0, 300)}`,
      );

      const leakedFromTool = containsStorageVocabulary(`${serialised}${toolResult.stderr}`);
      check(
        `tool surface: ${testCase.what} leaks no storage vocabulary`,
        leakedFromTool.length === 0,
        `found ${leakedFromTool.join(', ')} in: ${serialised.slice(0, 300)}`,
      );
    }
  } finally {
    await removeWhenReleased(temporaryRoot);
  }

  return { failures, notes };
}

/**
 * Build a copy of the sources with the purpose guard removed, and run the
 * whole check against it.
 *
 * **This is the proof that the check can fail.** It reproduces the original
 * defect by deleting the guard — not by editing an expected string — so what
 * it demonstrates is that the *mechanism* is detected, rather than that a
 * literal appears somewhere.
 *
 * The copy is a whole checkout rather than a patched file in place, because
 * mutating the working tree and restoring it leaves the repository broken if
 * the process dies in between.
 */
export async function runSelfTest() {
  const broken = mkdtempSync(path.join(tmpdir(), 'broker-argument-selftest-'));
  try {
    // A checkout copy, minus the directories that make it enormous and that
    // nothing here reads.
    const { cpSync } = await import('node:fs');
    for (const entry of ['src', 'scripts', 'package.json', 'tsconfig.json']) {
      cpSync(path.join(repositoryRoot, entry), path.join(broken, entry), {
        recursive: true,
      });
    }
    // `node_modules` is linked rather than copied: the driver is a compiled
    // binary and copying it is slow enough to change the character of the run.
    const { symlinkSync } = await import('node:fs');
    try {
      symlinkSync(
        path.join(repositoryRoot, 'node_modules'),
        path.join(broken, 'node_modules'),
        'junction',
      );
    } catch {
      cpSync(path.join(repositoryRoot, 'node_modules'), path.join(broken, 'node_modules'), {
        recursive: true,
      });
    }

    const claimPath = path.join(broken, 'src', 'service', 'operations', 'claim.ts');
    const source = readFileSync(claimPath, 'utf8');
    const guardStart = source.indexOf("  if (\n    typeof input.purpose !== 'string' ||");
    const guardEnd = source.indexOf('  // Validated **before the first insert**');
    if (guardStart < 0 || guardEnd < 0 || guardEnd < guardStart) {
      return {
        ok: false,
        detail:
          'the self-test could not find the purpose guard to remove — it has been rewritten, and this seeded violation must be updated with it',
      };
    }
    writeFileSync(claimPath, source.slice(0, guardStart) + source.slice(guardEnd));

    const result = await runArgumentRefusalCheck({ root: broken });
    return {
      ok: result.failures.length > 0,
      detail:
        result.failures.length > 0
          ? `${String(result.failures.length)} assertions failed against the broken build, as they must`
          : 'the check passed against a build with the purpose guard removed — it does not detect the defect it exists to detect',
    };
  } finally {
    await removeWhenReleased(broken);
  }
}

async function removeWhenReleased(directory) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  if (process.argv.includes('--self-test')) {
    const outcome = await runSelfTest();
    console.log(outcome.detail);
    if (!outcome.ok) {
      process.exitCode = 1;
    }
  } else {
    const result = await runArgumentRefusalCheck();
    for (const note of result.notes) {
      console.log(note);
    }
    if (result.failures.length > 0) {
      console.error('\nThe argument-refusal check failed:\n');
      for (const failure of result.failures) {
        console.error(failure);
      }
      console.error(
        '\nA malformed argument must be refused at the service boundary, naming the argument.\nA storage constraint reaching a caller names the wrong thing and, on the command line,\nis indistinguishable from the service being broken.',
      );
      process.exitCode = 1;
    } else {
      console.log(
        `\nArgument-refusal check passed: ${String(CASES.length)} malformed arguments refused across both\nshipped executables, each naming its rule, none leaking the storage layer.`,
      );
    }
  }
}
