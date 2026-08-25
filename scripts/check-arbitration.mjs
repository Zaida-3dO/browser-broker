#!/usr/bin/env node
/**
 * The three build rules that keep the arbitration transaction shape true:
 * `arbitration.immediate_transaction`, `arbitration.no_read_only_path` and
 * `arbitration.no_browser_io` (`SCHEMA.md` §7.3).
 *
 * All three assert an **absence** — that no arbitration path opens a
 * transaction without declaring its intent to write, that none answers
 * without writing, and that none reaches a browser while the transaction is
 * open — and an absence has no call site, so there is nothing for a test
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
 * | A session supplied on the input is resolved only inside an after-commit closure | **Checked.** Rule three, scan A |
 * | A browser-seam method is called only inside an after-commit closure | **Checked.** Rule three, scan B |
 * | Every listed operation module is present | **Checked.** Rule three, scan C |
 * | The seam's method list is read from the seam, including inherited methods | **Checked.** Rule three, scan D — refuses rather than scanning for nothing |
 * | *A handler that constructed a driver for itself* | **NOT checked.** Reaching a browser that way takes a launch or an attach, which rule three does not look for. What stands against it is that `ArbitrationScope` carries no driver, so there is nothing to reach for by accident |
 * | *A browser reached through a value rule three cannot recognise* | **NOT checked, and not checkable this way.** A session smuggled through a differently-typed field matches no shape here |
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
 * ── What rule three rests on, said plainly ──────────────────────────────
 *
 * **The load-bearing defence against browser work inside the transaction is
 * the type system, not this script.** `ArbitrationScope` carries no driver,
 * so a handler has nothing to call: the obvious path does not exist. What is
 * left is the one deliberate route — a `SessionSource` supplied on the
 * operation input by the caller that owns the browser connection — and
 * `operations/pages.ts` states the governing rule, that it is read inside an
 * after-commit closure and never in a handler body.
 *
 * Rule three checks **that** rule, and can, because it is a question about
 * where a call sits rather than about what a value is. It does not make the
 * violation impossible; it makes the natural way to commit it — moving an
 * `await session.…` out of the closure to get its result before returning —
 * fail in the diff.
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
 * The operation modules `arbitration.no_browser_io` scans.
 *
 * Named individually for the same reason the two above are: a glob would
 * silently start covering the next file somebody adds, and this rule's whole
 * value is that adding an operation module is a deliberate decision taken in
 * the diff. {@link checkNoBrowserIo}'s scan C is what refuses a registry
 * whose handlers live somewhere unlisted.
 */
export const OPERATION_SOURCES = [
  'src/service/operations/claim.ts',
  'src/service/operations/give-back.ts',
  'src/service/operations/pages.ts',
  'src/service/operations/status.ts',
];

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

/** Strip line and block comments, so prose about a keyword is not a match. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Strip comments **without moving any line**, for a scan that reports
 * positions.
 *
 * {@link stripComments} collapses a block comment to a single space, which is
 * correct when only the presence of a match matters — but it means a line
 * number counted afterwards refers to the stripped text rather than to the
 * file. In this repository's files, whose comments are long, that difference
 * is a hundred lines or more, and **a rule that reports the wrong line sends
 * its reader to innocent code**. Every newline is kept here so the two agree.
 */
export function stripCommentsKeepingLines(source) {
  const blank = (match) => match.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
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

  // Scan C, and it is unconditional.
  //
  // The registry has operations in it, so an empty one is a regression rather
  // than a state this build has to tolerate, and nothing excuses it. There is
  // deliberately no exemption constant to reach for: a declared exemption
  // earns its keep only while the hole it names is real, and one left lying
  // around is an invitation to widen it.
  if (registeredNames.length === 0) {
    failures.push({
      rule: 'arbitration.no_read_only_path',
      scan: 'C',
      line: 0,
      detail:
        'The arbitration registry is empty, so every rule above is an assertion over an empty set — which passes forever and silently.',
    });
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
 * The methods that reach a browser, so a call to one is browser I/O.
 *
 * Read from `BrowserSession` in `src/browser/driver.ts` at run time rather
 * than written down here, by {@link browserSessionMethods}. A list copied
 * into this file would go stale the moment the seam grew a method, and a
 * scan that silently stopped covering a new method is the shape this whole
 * script is written against.
 */
export const BROWSER_SEAM_SOURCE = 'src/browser/driver.ts';

/**
 * Read the browser seam's method names out of its own interface.
 *
 * Returns `null` rather than a guess when the interface cannot be found, and
 * the caller refuses on that — reporting an empty set would make the scan an
 * assertion over nothing, which passes forever and silently.
 */
/**
 * Everything after an interface's name: its optional `extends` clause, then
 * its body up to the closing brace in the first column.
 *
 * Written as a literal so the escapes are the regular expression's own rather
 * than a string's, which keeps the doubled backslashes of an escaped-string
 * form out of the source entirely.
 */
const INTERFACE_BODY_PATTERN = /(?:\s+extends\s+([^{]+))?\s*\{([\s\S]*?)\n\}/;

export function browserSessionMethods(source) {
  const names = new Set();
  const seen = new Set();

  // **The `extends` chain is followed, and that is not a nicety.** The seam
  // declares its page verbs — `navigate`, `act`, `read`, `evaluate`,
  // `capture` — on a base interface, and those are precisely the methods a
  // handler would call. A scan reading only the leaf interface would collect
  // the five session-lifecycle methods, find none of them in an operation
  // module, and report green over the whole rule.
  const collect = (name) => {
    if (seen.has(name)) return;
    seen.add(name);

    // Built from a literal regular expression rather than from a string of
    // escapes: a source line carrying doubled backslashes reads to the
    // hygiene gate as a machine path, and rewording a check to appease
    // another check is how both end up trusted less.
    const declaration = new RegExp(
      ['export interface ', name, INTERFACE_BODY_PATTERN.source].join(''),
    ).exec(source);
    if (declaration === null) return;

    for (const parent of (declaration[1] ?? '').split(',')) {
      const trimmed = parent.trim();
      if (trimmed !== '') collect(trimmed);
    }

    // `readonly name: (...) => ...` — a method is a property whose type is a
    // function, which is how this seam declares every one of them.
    for (const property of stripComments(declaration[2]).matchAll(
      /readonly\s+([A-Za-z_$][\w$]*)\s*:\s*\(/g,
    )) {
      names.add(property[1]);
    }
  };

  collect('BrowserSession');
  return names.size > 0 ? [...names] : null;
}

/**
 * `arbitration.no_browser_io` — no browser call is reachable from a handler
 * body, only from the after-commit work it hands back (`SCHEMA.md` §2.4b).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCAN CAN SEE, AND WHAT IT CANNOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Read this before trusting it, and before extending it.
 *
 * **The load-bearing defence is the type system, not this scan.**
 * `ArbitrationScope` carries no driver, so a handler has nothing to call: the
 * obvious path to a browser does not exist and cannot be taken by accident.
 * What remains is the one deliberate route — a `SessionSource` supplied on
 * the *input* by the caller that owns the browser connection — and the rule
 * governing it is stated in `operations/pages.ts`: it "is only ever read
 * inside an `afterCommit` closure, never in the body of a handler".
 *
 * That rule is what this scan checks, and it is checkable because it is a
 * question about *where* a call sits rather than about what a value is.
 *
 * | Claim | Status |
 * |---|---|
 * | A session obtained from the operation input is dereferenced only inside an after-commit closure | **Checked.** Scan A |
 * | A browser-seam method is called only inside an after-commit closure | **Checked.** Scan B |
 * | Every listed operation module exists | **Checked.** Scan C |
 * | The browser seam's method list is read from the seam itself | **Checked.** Scan D — refuses rather than assuming an empty set |
 * | *A handler importing a driver module directly* | **NOT checked.** Constructing a driver takes a launch or an attach, neither of which this looks for. A handler that did so would be reaching around `ArbitrationScope` in a way no operation here has reason to |
 * | *A browser reached through a value this cannot recognise as a session* | **NOT checked, and not checkable this way.** A session smuggled through a differently-typed field, or returned by a helper whose own body is elsewhere, matches no shape here |
 * | *An operation module not on the list* | **NOT checked.** Scan C refuses a missing file, but a handler defined in a module nobody listed is outside these scans by construction — the same limit rule two carries |
 *
 * **So this makes the violation loud rather than impossible**, exactly as the
 * two rules above do. Its value is that the natural way to commit it — moving
 * an `await session.…` out of the closure and into the body, which is what
 * somebody does when they want the result before returning — is caught in the
 * diff. Somebody determined to reach a browser inside the transaction still
 * can, and the tests in `tests/service/` are what stand in the way.
 */
export function checkNoBrowserIo(sources, seamSource) {
  const failures = [];

  // Scan D. The seam's own method list, read rather than assumed.
  const methods = browserSessionMethods(seamSource);
  if (methods === null) {
    failures.push({
      rule: 'arbitration.no_browser_io',
      scan: 'D',
      line: 0,
      file: BROWSER_SEAM_SOURCE,
      detail:
        `${BROWSER_SEAM_SOURCE} does not declare a readable BrowserSession interface. ` +
        'Scanning for an empty set of browser methods would pass forever and silently, so this refuses instead of guessing.',
    });
    return failures;
  }

  for (const file of OPERATION_SOURCES) {
    const source = sources[file];

    // Scan C. A rule pointed at a file that has moved reports nothing, which
    // reads exactly like a clean tree.
    if (source === undefined) {
      failures.push({
        rule: 'arbitration.no_browser_io',
        scan: 'C',
        line: 0,
        file,
        detail:
          `${file} is listed as an operation module but is not present. ` +
          'A scan over a file that has moved finds no violations, which is indistinguishable from finding none.',
      });
      continue;
    }

    failures.push(...scanOneOperationModule(file, source, methods));
  }

  return failures;
}

/**
 * The two positional scans, over one module.
 *
 * The whole method is "is this call inside an after-commit closure or not",
 * so the work is finding those regions and then asking of each browser call
 * whether it falls in one.
 */
function scanOneOperationModule(file, rawSource, methods) {
  const failures = [];
  // Line-preserving, because every failure this produces reports a position.
  const code = stripCommentsKeepingLines(rawSource);
  const safe = afterCommitRegions(code);
  const inSafeRegion = (index) => safe.some(([from, to]) => index >= from && index < to);
  const lineAt = (index) => code.slice(0, index).split('\n').length;

  // Scan A. A session taken off the operation input, outside a closure.
  //
  // `input.session` is the documented route and the only one an operation has.
  // Reading it is harmless — `const source = input.session` inside a handler
  // body is how the real code hands it to the closure — so what is caught is
  // **invoking** it, which is what turns the source into a live session.
  for (const call of code.matchAll(/\b(?:await\s+)?(\w+\s*\.\s*)?session\s*\(\s*\)/g)) {
    if (inSafeRegion(call.index)) continue;
    failures.push({
      rule: 'arbitration.no_browser_io',
      scan: 'A',
      line: lineAt(call.index),
      file,
      detail:
        `${file} resolves a browser session (${call[0].trim()}) in a handler body. ` +
        'Section 2.4b: the arbitration transaction is open here, and one unresponsive browser inside it blocks every arbitration call on the machine. Hand the work back in afterCommit instead.',
    });
  }

  // Scan B. A browser-seam method called outside a closure.
  //
  // The receiver is deliberately not constrained to a variable called
  // `session`: what makes a call browser I/O is the method, and a value
  // renamed on its way into a handler body is exactly the case a
  // receiver-name check would miss.
  for (const method of methods) {
    for (const call of code.matchAll(new RegExp(`\\.\\s*${method}\\s*\\(`, 'g'))) {
      if (inSafeRegion(call.index)) continue;
      failures.push({
        rule: 'arbitration.no_browser_io',
        scan: 'B',
        line: lineAt(call.index),
        file,
        detail:
          `${file} calls the browser seam's ${method}() in a handler body. ` +
          'Section 2.4b requires browser work to happen after the commit: expiring a claim must also close its tab, and a browser that will not answer must not be able to hold the transaction open.',
      });
    }
  }

  return failures;
}

/**
 * Every region of the source that runs after the commit rather than inside
 * the transaction.
 *
 * Two shapes, and both are found by **matching braces from the opening one**
 * rather than by a regular expression over the whole region — a nested
 * closure or an object literal inside the callback would otherwise end the
 * region early and turn everything after it into a false positive:
 *
 * - `afterCommit: …` on a returned outcome, which is the declaration itself.
 * - `afterCommitWork(scope, input, tab, (session, page) => …)`, the helper
 *   that wraps one piece of work in the closure the runner calls. Its last
 *   argument is the work, so the region is that argument.
 *
 * A region that cannot be closed — unbalanced braces, which means the file
 * does not parse — is dropped rather than extended to the end of the file. An
 * unclosed region would mark the whole remainder safe, which is the failure
 * mode where a scan silently stops scanning.
 */
export function afterCommitRegions(code) {
  const regions = [];

  for (const start of code.matchAll(/\bafterCommit\s*:|\bafterCommitWork\s*\(/g)) {
    const from = start.index;
    const end = closingIndexFrom(code, from);
    if (end !== null) regions.push([from, end]);
  }

  // ── Helpers that are handed a session ────────────────────────────────
  //
  // A function **taking a `BrowserSession` as a parameter cannot obtain one
  // itself**, and nothing inside the transaction has one to pass: the only
  // values of that type in this layer come from resolving a `SessionSource`,
  // which happens inside an after-commit closure. Such a helper is therefore
  // after-commit work wherever it is written in the file.
  //
  // **This is a type-directed exemption, not a name-based one.** It is not
  // "functions called `pageFor`" and not "parameters called `session`" —
  // either of those would be a hole any handler could climb through by
  // choosing a name. A handler that wanted to smuggle browser work into the
  // transaction this way would have to *acquire* a `BrowserSession` to pass
  // in, and acquiring one is the thing scan A catches.
  for (const declaration of code.matchAll(/\bfunction\s+[A-Za-z_$][\w$]*\s*\(([\s\S]*?)\)\s*:/g)) {
    if (!/:\s*BrowserSession\b/.test(declaration[1])) continue;
    const bodyStart = code.indexOf('{', declaration.index + declaration[0].length);
    if (bodyStart === -1) continue;
    const end = matchingBracket(code, bodyStart);
    if (end !== null) regions.push([bodyStart, end]);
  }

  return regions;
}

/**
 * Where the construct beginning at `from` ends, by counting brackets.
 *
 * Starts counting at the first bracket at or after `from` and returns the
 * index just past its match. Strings are skipped, so a brace inside a literal
 * cannot unbalance the count.
 */
function closingIndexFrom(code, from) {
  const openers = { '(': ')', '[': ']', '{': '}' };
  const closers = { ')': '(', ']': '[', '}': '{' };
  const stack = [];

  // **Scanning to the end of the whole value, not to the first balanced
  // bracket.** `afterCommit:` is frequently followed by a ternary whose first
  // branch is an empty array — `source === undefined ? [] : [ … ]` — and
  // stopping at the first balanced pair would end the region on that `[]`,
  // leaving the closure that follows it looking like handler-body code. That
  // is a false positive on correct source, which is the fastest way to get a
  // check waived.
  //
  // The value ends at the comma or closing bracket that sits at the depth the
  // property started at.
  for (let index = from; index < code.length; index += 1) {
    const character = code[index];

    if (character === "'" || character === '"' || character === '`') {
      index = endOfString(code, index);
      if (index === -1) return null;
      continue;
    }

    if (openers[character] !== undefined) {
      stack.push(character);
      continue;
    }

    if (closers[character] !== undefined) {
      // A closer at depth zero ends the object or call this property sits in,
      // so the value ended here.
      if (stack.length === 0) return index;
      if (stack.pop() !== closers[character]) return null;
      continue;
    }

    // A comma at depth zero separates this property from the next one.
    if (character === ',' && stack.length === 0) return index;
  }
  return null;
}

/**
 * The index just past the bracket matching the one at `start`.
 *
 * Distinct from {@link closingIndexFrom}, which ends a *value* and therefore
 * stops at a comma or at the closer of an enclosing construct. A function body
 * ends where its own brace closes and nowhere else.
 *
 * Returns `null` on unbalanced input rather than running to the end of the
 * file. A region left open would mark everything after it as after-commit
 * work, which is the failure where a scan silently stops scanning.
 */
function matchingBracket(code, start) {
  const openers = { '(': ')', '[': ']', '{': '}' };
  const stack = [];

  for (let index = start; index < code.length; index += 1) {
    const character = code[index];

    if (character === "'" || character === '"' || character === '`') {
      index = endOfString(code, index);
      if (index === -1) return null;
      continue;
    }

    if (openers[character] !== undefined) {
      stack.push(openers[character]);
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      if (stack.pop() !== character) return null;
      if (stack.length === 0) return index + 1;
    }
  }
  return null;
}

/** The index of the closing quote of the string starting at `start`. */
function endOfString(code, start) {
  const quote = code[start];
  for (let index = start + 1; index < code.length; index += 1) {
    if (code[index] === '\\') {
      index += 1;
      continue;
    }
    if (code[index] === quote) return index;
  }
  return -1;
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

  // Top-level keys only, tracked by brace depth.
  //
  // **A flat key scan was wrong here and passed anyway**, which is the exact
  // failure mode this file is written against. Each operation is an object
  // with its own `kind`, `summary` and `handler` keys, so a scan ignoring
  // nesting reported twelve operations for three — and, worse, would have
  // satisfied scan C's non-empty assertion out of the *inner* keys of a
  // registry whose outer level was empty. A count inflatable by the shape of
  // a value is not a count of operations.
  const names = [];
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '{' || character === '[' || character === '(') {
      depth += 1;
      continue;
    }
    if (character === '}' || character === ']' || character === ')') {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;

    const key = /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:/.exec(body.slice(index));
    if (key === null) continue;

    // Only at the start of an entry: the beginning of the body, or just past
    // a comma at this depth. Without that, a colon inside a type annotation
    // would read as a key.
    const before = body.slice(0, index).trimEnd();
    if (before === '' || before.endsWith(',')) {
      names.push(key[2] ?? key[3]);
      index += key[0].length - 1;
    }
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
  return [ARBITRATION_SOURCE, TRANSACTION_SOURCE, BROWSER_SEAM_SOURCE, ...OPERATION_SOURCES].filter(
    (path) => !requireFile(path),
  );
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
  for (const path of OPERATION_SOURCES) {
    sources[path] = read(path);
  }

  const registry = registeredNamesIn(sources[ARBITRATION_SOURCE]);
  if (registry.names === null) {
    console.error(
      `The arbitration registry could not be read: ${registry.reason}.\n` +
        'Reporting zero for a registry this cannot read would turn the non-empty assertion into the silent one it exists to prevent.',
    );
    return 1;
  }

  const seam = read(BROWSER_SEAM_SOURCE);
  const seamMethods = browserSessionMethods(seam) ?? [];

  const failures = [
    ...checkImmediateTransaction(sources),
    ...checkNoReadOnlyPath(sources, registry.names),
    ...checkNoBrowserIo(sources, seam),
  ];

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        // The file is carried on the failure rather than assumed: the browser
        // rule reports against whichever operation module it read, and naming
        // the arbitration module for all of them would send a reader to a file
        // the violation is not in.
        `${failure.rule} [scan ${failure.scan}]${failure.line > 0 ? ` ${failure.file ?? ARBITRATION_SOURCE}:${failure.line}` : ''}\n    ${failure.detail}\n`,
      );
    }
    console.error(
      `${failures.length} arbitration rule violation${failures.length === 1 ? '' : 's'}.\n\n` +
        'These rules assert an absence, so there is no call site to inspect. The header of scripts/check-arbitration.mjs\n' +
        'records exactly what they can and cannot prove — read it before deciding a violation is a false positive.',
    );
    return 1;
  }

  // An empty registry fails scan C above, so this branch only ever describes
  // a registry with something in it.
  const registryNote = ` ${registry.names.length} operation${registry.names.length === 1 ? '' : 's'} registered: ${registry.names.join(', ')}.`;

  console.log(
    `arbitration.immediate_transaction, arbitration.no_read_only_path and arbitration.no_browser_io hold on ${treeDescription()}.${registryNote}\n` +
      `Browser I/O was checked positionally across ${String(OPERATION_SOURCES.length)} operation modules, against the ${String(seamMethods.length)} methods read from ${BROWSER_SEAM_SOURCE}.\n` +
      "This means the arbitration surface is narrow, not that a bypass is impossible — see this script's header. " +
      'In particular the browser rule sees a session resolved or a seam method called in a handler body; it does not see a driver a handler constructed for itself.',
  );
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
