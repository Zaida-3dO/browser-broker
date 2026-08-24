#!/usr/bin/env node
/**
 * The two build rules that keep the arbitration transaction shape true:
 * `arbitration.immediate_transaction` and `arbitration.no_read_only_path`
 * (`SCHEMA.md` §7.3).
 *
 * Both assert an **absence** — that no arbitration path opens a transaction
 * without declaring its intent to write, and that none answers without
 * writing — and an absence has no call site, so there is nothing for a test
 * to invoke. `MILESTONES.md` #50: the second is the one that matters most,
 * because a "check status without sweeping" fast path **would pass a
 * low-contention test suite**, which is exactly what the deferred measurement
 * in §1.0a says the failure looks like.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THESE CHECKS CAN PROVE, AND WHAT THEY CANNOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Read this before trusting a green run, and read it before extending either
 * rule. `src/store/transaction.ts` establishes the fact this whole file is
 * built around, and it is inconvenient:
 *
 * > `immediate(fn)` is **a convention rather than a construction**. A
 * > savepoint opens a transaction with no `BEGIN` token to find, and a bare
 * > statement outside any transaction takes its lock at statement time —
 * > which is precisely the not-declared-at-open case. Both were tried and
 * > both work.
 *
 * **So a check that greps for `BEGIN` and calls itself done is worse than no
 * check**, because sixty rows would trust it. Every one of the three known
 * bypasses is invisible to a `BEGIN` scan: two of them contain no `BEGIN` at
 * all.
 *
 * What is done instead is to check the property that *is* decidable from the
 * source — **that the arbitration surface is narrow** — and to say plainly
 * that narrowness is not the same claim as correctness:
 *
 * | Claim | Status |
 * |---|---|
 * | The arbitration module issues no transaction-control statement of its own | **Checked.** Rule one, scan A |
 * | The arbitration module opens transactions only through the one helper | **Checked.** Rule one, scan B |
 * | That helper's opening literal declares intent to write | **Checked.** Rule one, scan C |
 * | The arbitration module reaches no other transaction affordance the driver offers | **Checked.** Rule one, scan D |
 * | Every registered arbitration operation is dispatched through the runner | **Checked.** Rule two, scan A |
 * | The runner sweeps unconditionally before the handler | **Checked.** Rule two, scan B |
 * | The registry is non-empty | **Checked.** Rule two, scan C — and see the exemption below |
 * | An operation cannot declare itself read-only | **Checked.** Rule two, scan D |
 * | *Nothing anywhere in the tree can ever write outside a transaction* | **NOT checked, and not checkable this way.** A statement run on a raw handle takes its lock at statement time and matches no shape here |
 * | *A future module could not open its own deferred transaction* | **NOT checked.** These scans cover the arbitration module. A new module calling itself something else is outside them by construction |
 * | *The sweep is correct* | **NOT checked.** That it runs is a source fact; that it expires the right rows is a test, and the concurrency suite in #12–#17 is where the global-sweep assertion lives |
 *
 * **The honest summary: these rules make the violation loud rather than
 * impossible.** Somebody who wants to bypass them can, and the value is that
 * they cannot do it *quietly* — every bypass requires either a new file the
 * scans do not cover, or an edit that fails one of them in the diff.
 *
 * The counterpart that catches what source scanning cannot is the contention
 * harness in #12–#17: real operating-system processes, with the deferred
 * variant kept as a deliberately-failing control. Neither substitutes for the
 * other, and this file is not the stronger of the two.
 *
 * ── Why this is source scanning and not the type system ─────────────────
 *
 * Rule two is nearly expressible in types — the runner takes the handler, the
 * handler cannot open a transaction, so a registered operation cannot avoid
 * the sweep. That much *is* enforced by the compiler and is stated in
 * `arbitration.ts`. What types cannot express is the negative: that no
 * *other* function exists which answers an arbitration question without going
 * through the runner. A second dispatcher would type-check perfectly. Scan A
 * is what notices it.
 */

import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * The files each rule reads.
 *
 * Named individually rather than globbed over a directory. A glob would be
 * more convenient and would silently start covering the next file somebody
 * adds — which sounds like a feature until the added file is one the scans
 * were never designed for and it fails for a reason nobody can act on. A
 * named list means adding a module to the service layer is a deliberate
 * decision about which rules apply to it, taken in the diff.
 */
export const ARBITRATION_SOURCE = 'src/service/arbitration.ts';
export const TRANSACTION_SOURCE = 'src/store/transaction.ts';

/**
 * The literal the transaction helper must open with.
 *
 * `SCHEMA.md` §1.0a, measured: 30 concurrent processes on an immediate
 * transaction all succeeded; the same test on a deferred one with a widened
 * read-then-write window failed 15 times in 25, with a busy-snapshot error
 * the busy-timeout setting cannot retry. The single-character change this
 * exists to catch is dropping the second word.
 */
export const REQUIRED_BEGIN = 'BEGIN IMMEDIATE';

/**
 * Transaction-control keywords that must not appear as SQL in the arbitration
 * module.
 *
 * The point is **not** that these words are dangerous. It is that the
 * arbitration module has exactly one legitimate way to be inside a
 * transaction — being called by the runner, which is inside one already — so
 * any of these in its source means a second way exists. `SAVEPOINT` and
 * `RELEASE` are here because `transaction.ts` names a savepoint as one of the
 * bypasses that works, and it is the bypass a reader who has only seen a
 * `BEGIN` scan would reach for.
 */
export const FORBIDDEN_SQL_KEYWORDS = ['BEGIN', 'SAVEPOINT', 'COMMIT', 'ROLLBACK', 'RELEASE'];

/**
 * Transaction affordances the driver offers that the arbitration module must
 * not reach.
 *
 * `transaction.ts` records that the driver ships `.immediate()`, `.deferred()`
 * and `.exclusive()` variants on its own helper, and that the bare form is
 * **deferred by default**. `db.transaction(` is therefore the dangerous
 * spelling rather than `db.deferred(`: it is the one that looks correct.
 */
export const FORBIDDEN_DRIVER_TRANSACTIONS = [
  '\\.transaction\\s*\\(',
  '\\.deferred\\s*\\(',
  '\\.exclusive\\s*\\(',
];

/**
 * The registry may be empty until this row lands.
 *
 * `MILESTONES.md` #50 asks for "a registry test asserting the set of
 * arbitration operations is not empty — an assertion over an empty set passes
 * forever and silently", and #50 lands with the helper it polices rather than
 * after the paths that use it. So at the moment this check ships there is
 * genuinely nothing registered, and the two ways to handle that are both bad:
 * assert non-empty and fail the build on the row that introduces the check,
 * or drop the assertion and reintroduce exactly the silent-forever hole the
 * milestone names.
 *
 * **The third way is this constant.** The check refuses an empty registry,
 * *and* carries one declared exemption naming the row that removes it. That
 * makes the hole visible in the source, visible in every run's output, and
 * removable by deleting one line — rather than invisible in an assertion
 * nobody reads. Set it to `null` when #12 registers the first operation.
 */
export const EMPTY_REGISTRY_EXEMPTION = '#12, which registers the first arbitration operation';

/** Strip line and block comments, so prose about a keyword is not a match. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Every string literal in the source, with the line it sits on.
 *
 * The scans that look for SQL look **inside string literals only**. Scanning
 * raw text would match the word `commit` in a sentence and the identifier
 * `beginWork`, which trains everyone to reword prose to appease a check —
 * and a check people learn to work around is a check that gets waived.
 */
export function stringLiterals(source) {
  const withoutComments = stripComments(source);
  const found = [];
  const pattern = /'([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g;

  for (const match of withoutComments.matchAll(pattern)) {
    const before = withoutComments.slice(0, match.index);
    found.push({
      text: match[0],
      line: before.split('\n').length,
    });
  }
  return found;
}

/**
 * `arbitration.immediate_transaction` — every arbitration path opens a
 * transaction that declares its intent to write.
 *
 * Four scans, and none of them is a bare search for `BEGIN`:
 *
 * - **A.** The arbitration module issues no transaction-control SQL of its
 *   own — including the savepoint spelling, which contains no `BEGIN`.
 * - **B.** It opens a transaction only through the store handle's one
 *   affordance, and does so at least once. The "at least once" half matters:
 *   without it a module that opened nothing at all would pass, and a runner
 *   that stopped opening a transaction is precisely the regression.
 * - **C.** The helper it calls opens with the immediate literal. Read out of
 *   the helper's source rather than imported, so a rename of the constant
 *   cannot make this vacuous.
 * - **D.** It reaches none of the driver's own transaction variants — whose
 *   bare form is deferred by default, which is the mistake that looks right.
 */
export function checkImmediateTransaction(sources) {
  const failures = [];
  const arbitration = sources[ARBITRATION_SOURCE];
  const transaction = sources[TRANSACTION_SOURCE];

  // Scan A.
  for (const literal of stringLiterals(arbitration)) {
    for (const keyword of FORBIDDEN_SQL_KEYWORDS) {
      if (new RegExp(`\\b${keyword}\\b`, 'i').test(literal.text)) {
        failures.push({
          rule: 'arbitration.immediate_transaction',
          scan: 'A',
          line: literal.line,
          detail:
            `${ARBITRATION_SOURCE} issues transaction-control SQL: ${keyword} in ${literal.text.slice(0, 60)}. ` +
            'Arbitration runs inside the transaction the runner opened; a second way to be in one is the bug this rule exists to catch.',
        });
      }
    }
  }

  // Scan B.
  const opensThroughHelper =
    /\bstore\s*\.\s*immediate\s*\(|\boptions\s*\.\s*store\s*\.\s*immediate\s*\(/.test(
      stripComments(arbitration),
    );
  if (!opensThroughHelper) {
    failures.push({
      rule: 'arbitration.immediate_transaction',
      scan: 'B',
      line: 0,
      detail:
        `${ARBITRATION_SOURCE} never opens a transaction through the store handle. ` +
        'Either it opens none, in which case arbitration is not serialised, or it found another way, which is the same finding.',
    });
  }

  // Scan C.
  const beginLiteral = stringLiterals(transaction).find((literal) =>
    /\bBEGIN\b/i.test(literal.text),
  );
  if (beginLiteral === undefined) {
    failures.push({
      rule: 'arbitration.immediate_transaction',
      scan: 'C',
      line: 0,
      detail: `${TRANSACTION_SOURCE} contains no transaction-opening literal to check.`,
    });
  } else if (!new RegExp(`^['"\`]${REQUIRED_BEGIN}['"\`]$`, 'i').test(beginLiteral.text)) {
    failures.push({
      rule: 'arbitration.immediate_transaction',
      scan: 'C',
      line: beginLiteral.line,
      detail:
        `${TRANSACTION_SOURCE} opens with ${beginLiteral.text} rather than '${REQUIRED_BEGIN}'. ` +
        'Measured: 30 concurrent processes on an immediate transaction all succeeded; deferred with a widened read-then-write window failed 15 times in 25, with an error the busy timeout cannot retry.',
    });
  }

  // Scan D.
  const arbitrationCode = stripComments(arbitration);
  for (const spelling of FORBIDDEN_DRIVER_TRANSACTIONS) {
    const match = new RegExp(spelling).exec(arbitrationCode);
    if (match !== null) {
      failures.push({
        rule: 'arbitration.immediate_transaction',
        scan: 'D',
        line: arbitrationCode.slice(0, match.index).split('\n').length,
        detail:
          `${ARBITRATION_SOURCE} reaches the driver's own transaction helper (${match[0]}). ` +
          'Its bare form is deferred by default, which is the mode the measurement says fails under contention.',
      });
    }
  }

  return failures;
}

/**
 * `arbitration.no_read_only_path` — no arbitration path answers without
 * writing.
 *
 * The invariant this protects is stated in §1.0a as the standing one: the
 * guarantee is writer serialisation rather than full serialisability, and it
 * holds **only because every arbitration path writes**. The sweep is what
 * makes even a question a write.
 *
 * Four scans:
 *
 * - **A.** Every key in the registry is reachable only through the runner —
 *   which is checked as "there is exactly one dispatcher", because a second
 *   function that calls a handler is the shape a fast path arrives in.
 * - **B.** The runner calls the sweep, and calls it **unconditionally**: not
 *   inside an `if`, not behind a `?.`, not guarded by an option. A sweep that
 *   can be skipped is a read-only path with an extra step.
 * - **C.** The registry is non-empty, so the check is not an assertion over
 *   an empty set — subject to the one declared exemption above.
 * - **D.** No operation can declare itself read-only. The registry's own
 *   interface must not grow a field that would let it, because that field is
 *   the first thing a well-intentioned optimisation reaches for.
 */
export function checkNoReadOnlyPath(sources, registeredNames) {
  const failures = [];
  const code = stripComments(sources[ARBITRATION_SOURCE]);

  // Scan A. The runner is the only thing that invokes a registered handler.
  const handlerCalls = [...code.matchAll(/\.handler\s*\(/g)];
  if (handlerCalls.length === 0) {
    failures.push({
      rule: 'arbitration.no_read_only_path',
      scan: 'A',
      line: 0,
      detail:
        `${ARBITRATION_SOURCE} invokes no registered handler at all. ` +
        'Either dispatch moved out of this module, where these scans do not reach, or nothing dispatches.',
    });
  } else if (handlerCalls.length > 1) {
    failures.push({
      rule: 'arbitration.no_read_only_path',
      scan: 'A',
      line: code.slice(0, handlerCalls[1].index).split('\n').length,
      detail:
        `${ARBITRATION_SOURCE} invokes a registered handler from ${handlerCalls.length} places. ` +
        'One dispatcher sweeps before it answers; a second one is where a check-status-without-sweeping path arrives, and it would pass a low-contention test suite.',
    });
  }

  // Scan B. The sweep runs, and nothing can skip it.
  const sweepCall = /(?<prefix>[^\n]*?)\bsweep\s*\(\s*db\s*\)/.exec(code);
  if (sweepCall === null) {
    failures.push({
      rule: 'arbitration.no_read_only_path',
      scan: 'B',
      line: 0,
      detail:
        `${ARBITRATION_SOURCE} does not call the sweep. ` +
        'The standing invariant in section 1.0a holds only because every arbitration path writes, and the sweep is what makes even a question a write.',
    });
  } else {
    const prefix = sweepCall.groups.prefix;
    // A conditional sweep is the violation in its most plausible costume:
    // nobody removes the sweep, they make it optional. The shapes are a
    // ternary, a short-circuit, and an `if` on the same line — which is to
    // say, anything on the left of the call that could decide not to make it.
    //
    // Matched on the prefix rather than on the whole line because what is on
    // the *right* is harmless: `sweep(db) ?? fallback` still sweeps.
    const guarded = /(\?|&&|\|\||\bif\s*\()[^\n]*$/.test(prefix);
    if (guarded) {
      failures.push({
        rule: 'arbitration.no_read_only_path',
        scan: 'B',
        line: code.slice(0, sweepCall.index).split('\n').length,
        detail:
          `${ARBITRATION_SOURCE} calls the sweep conditionally: ${prefix.trim().slice(-60)}. ` +
          'A sweep that can be skipped is a read-only path with an extra step.',
      });
    }
  }

  // Scan C.
  if (registeredNames.length === 0) {
    if (EMPTY_REGISTRY_EXEMPTION === null) {
      failures.push({
        rule: 'arbitration.no_read_only_path',
        scan: 'C',
        line: 0,
        detail:
          'The arbitration registry is empty, so every rule above is an assertion over an empty set — which passes forever and silently.',
      });
    }
  }

  // Scan D. No field lets an operation opt out of writing.
  const optOut = /\breadonly\s+(writes|readOnly|skipSweep|noSweep)\b/.exec(code);
  if (optOut !== null) {
    failures.push({
      rule: 'arbitration.no_read_only_path',
      scan: 'D',
      line: code.slice(0, optOut.index).split('\n').length,
      detail:
        `${ARBITRATION_SOURCE} declares ${optOut[0]}, which lets an operation opt out of writing. ` +
        'The invariant is enforced by there being no way to express the violation, not by a flag somebody could set.',
    });
  }

  return failures;
}

/**
 * The registered names, read from the source rather than imported.
 *
 * Importing the module would be the obvious thing and it is the wrong one
 * here: this script runs as part of the build, over a tree that may not
 * type-check, and it must be able to report *why* rather than fail to load.
 * Reading the object literal keeps the check independent of whether the
 * module it polices compiles at the moment the check runs.
 *
 * **This parse is deliberately shallow, and it fails loudly rather than
 * guessing.** It handles the empty literal and a flat list of keys. A
 * registry built any other way — spread from another object, assembled in a
 * loop, keys computed — is reported as unparseable, because a scan that
 * silently reported zero for a registry it could not read would turn scan C
 * into the silent-forever assertion it exists to prevent.
 */
export function registeredNamesIn(source) {
  const match = /export const ARBITRATION_OPERATIONS = (\{[\s\S]*?\n?\}) as const/.exec(source);
  if (match === null) {
    return { names: null, reason: 'no ARBITRATION_OPERATIONS object literal found' };
  }

  const body = stripComments(match[1]).slice(1, -1).trim();
  if (body === '') {
    return { names: [], reason: null };
  }

  if (/\.\.\./.test(body)) {
    return {
      names: null,
      reason: 'the registry is assembled by spreading, which this cannot read',
    };
  }

  const names = [];
  for (const key of body.matchAll(/(?:^|[{,])\s*(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:/g)) {
    names.push(key[2] ?? key[3]);
  }

  if (names.length === 0) {
    return { names: null, reason: 'the registry is non-empty but no keys could be read from it' };
  }
  return { names, reason: null };
}

function read(path) {
  return readFileSync(path, 'utf8');
}

/** Confirm a file exists before scanning it, so a rename fails loudly. */
function requireFile(path) {
  try {
    if (statSync(path).isFile()) return true;
  } catch {
    /* falls through */
  }
  return false;
}

/**
 * Confirm the scanned files are the ones this repository carries.
 *
 * A rule pointed at a file that has moved reports no violations, which is
 * indistinguishable from a clean tree. The gate next door had the same
 * problem from the other direction and solved it by reporting coverage; this
 * one refuses outright, because there are two files rather than hundreds and
 * a missing one is never ordinary.
 */
function missingSources() {
  return [ARBITRATION_SOURCE, TRANSACTION_SOURCE].filter((path) => !requireFile(path));
}

/**
 * Is the working tree the one this check thinks it is scanning?
 *
 * Only used for the summary line. The check reads the files on disk, which is
 * what the pipeline builds from and what a local run should agree with.
 */
function treeDescription() {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'this tree';
}

export function main() {
  const absent = missingSources();
  if (absent.length > 0) {
    console.error(
      `The arbitration rules cannot run: ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not present.\n` +
        'A rule pointed at a file that has moved reports nothing, which reads exactly like a clean tree.',
    );
    return 1;
  }

  const sources = {
    [ARBITRATION_SOURCE]: read(ARBITRATION_SOURCE),
    [TRANSACTION_SOURCE]: read(TRANSACTION_SOURCE),
  };

  const registry = registeredNamesIn(sources[ARBITRATION_SOURCE]);
  if (registry.names === null) {
    console.error(
      `The arbitration registry could not be read: ${registry.reason}.\n` +
        'Reporting zero for a registry this cannot read would turn the non-empty assertion into the silent one it exists to prevent.',
    );
    return 1;
  }

  const failures = [
    ...checkImmediateTransaction(sources),
    ...checkNoReadOnlyPath(sources, registry.names),
  ];

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `${failure.rule} [scan ${failure.scan}]${failure.line > 0 ? ` ${ARBITRATION_SOURCE}:${failure.line}` : ''}\n    ${failure.detail}\n`,
      );
    }
    console.error(
      `${failures.length} arbitration rule violation${failures.length === 1 ? '' : 's'}.\n\n` +
        'These rules assert an absence, so there is no call site to inspect. The header of scripts/check-arbitration.mjs\n' +
        'records exactly what they can and cannot prove — read it before deciding a violation is a false positive.',
    );
    return 1;
  }

  const registryNote =
    registry.names.length === 0
      ? ` The registry is EMPTY, exempted until ${EMPTY_REGISTRY_EXEMPTION}; until then every rule here is an assertion over an empty set.`
      : ` ${registry.names.length} operation${registry.names.length === 1 ? '' : 's'} registered: ${registry.names.join(', ')}.`;

  console.log(
    `arbitration.immediate_transaction and arbitration.no_read_only_path hold on ${treeDescription()}.${registryNote}\n` +
      "This means the arbitration surface is narrow, not that a bypass is impossible — see this script's header.",
  );
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
