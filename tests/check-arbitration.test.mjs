import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ARBITRATION_SOURCE,
  BROWSER_SEAM_SOURCE,
  OPERATION_SOURCES,
  FORBIDDEN_DRIVER_TRANSACTIONS,
  FORBIDDEN_SQL_KEYWORDS,
  REQUIRED_BEGIN,
  TRANSACTION_SOURCE,
  afterCommitRegions,
  browserSessionMethods,
  checkImmediateTransaction,
  checkNoBrowserIo,
  checkNoReadOnlyPath,
  registeredNamesIn,
  stringLiterals,
  stripComments,
  stripCommentsKeepingLines,
} from '../scripts/check-arbitration.mjs';

/**
 * The self-test for the two arbitration build rules.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN OF THIS FILE MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `CLAUDE.md`: "any script used as a gate must ship a test proving it fails on
 * a seeded violation, not merely that it passes on clean input", and that test
 * "must also state plainly what a green result does, and does not, mean".
 *
 * **What it means:** each of the eight scans has been run against a source
 * that violates it, and each refused. Every one of these seeds is a mutation
 * of the real file, so a scan that stopped working fails here.
 *
 * **What it does not mean:** that the rules are unbypassable. The script's own
 * header sets out the limits in full and they are real — `immediate(fn)` is a
 * convention rather than a construction, and a bare statement on a raw handle
 * matches no shape either rule looks for. A green run here says the scans
 * catch **the shapes they were taught**. It cannot say anything about a shape
 * nobody thought of, and widening intent does not widen a regular expression.
 *
 * **The seeds are mutations of the shipped source, never a local copy of it.**
 * A crew on this repository shipped a hollow test that exercised a
 * reimplementation of the logic, so the shipped code was never run at all.
 * Every seed below starts from `readFileSync` of the real file and changes one
 * thing, which is what makes it a mutation rather than an imitation.
 */

const arbitration = readFileSync(ARBITRATION_SOURCE, 'utf8');
const transaction = readFileSync(TRANSACTION_SOURCE, 'utf8');
const seam = readFileSync(BROWSER_SEAM_SOURCE, 'utf8');

/** Every operation module, as `arbitration.no_browser_io` reads them. */
function operationSources() {
  return Object.fromEntries(OPERATION_SOURCES.map((path) => [path, readFileSync(path, 'utf8')]));
}

/** The operation modules with one file replaced by a mutation of itself. */
function seededOperation(path, mutate) {
  const sources = operationSources();
  const after = mutate(sources[path]);
  assert.notEqual(
    after,
    sources[path],
    `the seed for ${path} changed nothing — the mutation missed, so the assertion below would pass vacuously`,
  );
  return { ...sources, [path]: after };
}

/** The handler body that every browser-rule seed below reaches into. */
const NAVIGATE_BODY = "const { lease, tab, expiresAt } = admit(scope, input, 'navigate');";

/** The real tree, as the two rules see it. */
function clean() {
  return { [ARBITRATION_SOURCE]: arbitration, [TRANSACTION_SOURCE]: transaction };
}

/** The real tree with one file replaced by a mutation of itself. */
function seeded(path, mutate) {
  const sources = clean();
  const before = sources[path];
  const after = mutate(before);
  assert.notEqual(
    after,
    before,
    `the seed for ${path} changed nothing — the mutation missed, so the assertion below would pass vacuously`,
  );
  return { ...sources, [path]: after };
}

function rules(sources, names = []) {
  return [...checkImmediateTransaction(sources), ...checkNoReadOnlyPath(sources, names)];
}

function scansThatFired(failures) {
  return failures.map((failure) => `${failure.rule}/${failure.scan}`).sort();
}

// ── The control ─────────────────────────────────────────────────────────
//
// Every assertion below is "this seed fires". Without this one, a scan that
// fired on absolutely everything would pass all of them.

test('the real tree passes both rules', () => {
  assert.deepEqual(rules(clean(), ['some_operation']), []);
});

test('the real registry is readable, and it is not empty', () => {
  const registry = registeredNamesIn(arbitration);
  assert.notEqual(
    registry.names,
    null,
    `the registry could not be parsed: ${registry.reason}. Reporting zero for an unreadable registry is the silent failure scan C exists to prevent.`,
  );
  // Unconditional. While the registry was genuinely empty this was excused by
  // a declared exemption naming the row that would fill it; that row has
  // landed, so the assertion it deferred is simply made. Every other rule in
  // this file is an assertion over this set, and an empty one passes them all
  // forever and silently.
  assert.ok(
    registry.names.length > 0,
    'the arbitration registry is empty, so every rule here asserts over an empty set',
  );
});

// ── arbitration.immediate_transaction ───────────────────────────────────

test('scan A fires on transaction-control SQL in the arbitration module', () => {
  for (const keyword of FORBIDDEN_SQL_KEYWORDS) {
    const sources = seeded(ARBITRATION_SOURCE, (source) =>
      source.replace(
        'const swept = sweep(db);',
        `db.prepare('${keyword}').run();\n    const swept = sweep(db);`,
      ),
    );
    const fired = scansThatFired(rules(sources, ['some_operation']));
    assert.ok(
      fired.includes('arbitration.immediate_transaction/A'),
      `${keyword} in a SQL literal did not fire scan A; scans that fired: ${fired.join(', ') || 'none'}`,
    );
  }
});

test('scan A fires on the savepoint bypass, which contains no BEGIN at all', () => {
  // The seed that matters most. `transaction.ts` records that a savepoint
  // opens a transaction with no BEGIN token to find, and that it was tried
  // and works. A rule that only searched for BEGIN would report this clean.
  const sources = seeded(ARBITRATION_SOURCE, (source) =>
    source.replace(
      'const swept = sweep(db);',
      "db.prepare('SAVEPOINT fast_path').run();\n    const swept = sweep(db);",
    ),
  );
  assert.ok(!/\bBEGIN\b/.test('SAVEPOINT fast_path'), 'the seed must not contain BEGIN');
  assert.ok(
    scansThatFired(rules(sources, ['some_operation'])).includes(
      'arbitration.immediate_transaction/A',
    ),
  );
});

test('scan A does not fire on the word commit in prose', () => {
  // The failure mode this guards against is a check people learn to work
  // around: if a comment saying "after the commit" failed the build, the
  // response would be to reword comments, and the rule would be waived by
  // the tenth pull request.
  const sources = seeded(ARBITRATION_SOURCE, (source) =>
    source.replace(
      'const swept = sweep(db);',
      '// A rollback and a commit and a savepoint, all in prose.\n    const swept = sweep(db);',
    ),
  );
  assert.deepEqual(rules(sources, ['some_operation']), []);
});

test('scan B fires when the arbitration module stops opening a transaction', () => {
  const sources = seeded(ARBITRATION_SOURCE, (source) =>
    // Matched on the call rather than on the whole line: the runner wraps
    // this in a try/finally so that a refusal's ledger row survives the
    // rollback, and a seed pinned to the surrounding statement silently stops
    // matching the moment that wrapping changes — which is a mutation that
    // misses, and an assertion that passes vacuously.
    source.replace('options.store.immediate(async ({ db }) => {', '(async ({ db }) => {'),
  );
  assert.ok(
    scansThatFired(rules(sources, ['some_operation'])).includes(
      'arbitration.immediate_transaction/B',
    ),
  );
});

test('scan C fires on the single-character change that drops IMMEDIATE', () => {
  // `MILESTONES.md` names this one explicitly: "the single-character change
  // that breaks this test is dropping IMMEDIATE". Measured: deferred failed
  // 15 times in 25 under contention, with an error the busy timeout cannot
  // retry — and it passes at low contention, which is the whole trap.
  const sources = seeded(TRANSACTION_SOURCE, (source) =>
    source.replace(`'${REQUIRED_BEGIN}'`, "'BEGIN'"),
  );
  const failures = rules(sources, ['some_operation']);
  assert.ok(scansThatFired(failures).includes('arbitration.immediate_transaction/C'));
  assert.match(failures[0].detail, /15 times in 25/);
});

test('scan C fires on the deferred and exclusive spellings too', () => {
  for (const mode of ['BEGIN DEFERRED', 'BEGIN EXCLUSIVE']) {
    const sources = seeded(TRANSACTION_SOURCE, (source) =>
      source.replace(`'${REQUIRED_BEGIN}'`, `'${mode}'`),
    );
    assert.ok(
      scansThatFired(rules(sources, ['some_operation'])).includes(
        'arbitration.immediate_transaction/C',
      ),
      `${mode} did not fire scan C`,
    );
  }
});

test("scan D fires on each of the driver's own transaction affordances", () => {
  const spellings = {
    '\\.transaction\\s*\\(': '.transaction(',
    '\\.deferred\\s*\\(': '.deferred(',
    '\\.exclusive\\s*\\(': '.exclusive(',
  };
  assert.deepEqual(
    Object.keys(spellings).sort(),
    [...FORBIDDEN_DRIVER_TRANSACTIONS].sort(),
    'a driver affordance was added to the check without a seed proving it fires',
  );

  for (const spelling of Object.values(spellings)) {
    const sources = seeded(ARBITRATION_SOURCE, (source) =>
      source.replace(
        'const swept = sweep(db);',
        `db${spelling}() => undefined)();\n    const swept = sweep(db);`,
      ),
    );
    assert.ok(
      scansThatFired(rules(sources, ['some_operation'])).includes(
        'arbitration.immediate_transaction/D',
      ),
      `${spelling} did not fire scan D`,
    );
  }
});

// ── arbitration.no_read_only_path ───────────────────────────────────────

test('scan A fires on a second dispatcher — the shape a fast path arrives in', () => {
  // This is the seeded violation `MILESTONES.md` #50 is most concerned with:
  // a "check status without sweeping" path. Written as a second function that
  // calls a handler directly, which is how one would actually be added, and
  // which type-checks perfectly.
  const sources = seeded(
    ARBITRATION_SOURCE,
    (source) =>
      source +
      `
export async function checkStatusQuickly(store, name, input) {
  const operation = ARBITRATION_OPERATIONS[name];
  return operation.handler({ db: store.db, swept: null, adapter: 'cli' }, input);
}
`,
  );
  assert.ok(
    scansThatFired(rules(sources, ['some_operation'])).includes('arbitration.no_read_only_path/A'),
  );
});

test('scan B fires when the sweep is made conditional rather than removed', () => {
  // Nobody deletes the sweep. They make it optional, for a caller that "only
  // wants to read" — and the result passes a low-contention test suite.
  for (const guard of [
    'const swept = options.skipSweep ? EMPTY : sweep(db);',
    'const swept = shouldSweep && sweep(db);',
  ]) {
    const sources = seeded(ARBITRATION_SOURCE, (source) =>
      source.replace('const swept = sweep(db);', guard),
    );
    assert.ok(
      scansThatFired(rules(sources, ['some_operation'])).includes(
        'arbitration.no_read_only_path/B',
      ),
      `${guard} did not fire scan B`,
    );
  }
});

test('scan B fires when the sweep is removed outright', () => {
  const sources = seeded(ARBITRATION_SOURCE, (source) =>
    source.replace(
      'const swept = sweep(db);',
      "const swept = { expiredClaimIds: [], orphanedTabs: [], sweptAt: '' };",
    ),
  );
  assert.ok(
    scansThatFired(rules(sources, ['some_operation'])).includes('arbitration.no_read_only_path/B'),
  );
});

test('scan C fires on an empty registry, with nothing left to excuse it', () => {
  // The seeded violation is the empty name list rather than an edit to the
  // source: scan C's subject is what the registry parses to, so an empty set
  // is the whole of the violation it exists to catch.
  assert.ok(
    scansThatFired(rules(clean(), [])).includes('arbitration.no_read_only_path/C'),
    'an empty registry must fire scan C',
  );
  // And the clean tree does not fire it, so the assertion above is about the
  // seed rather than about something already broken.
  assert.equal(
    scansThatFired(rules(clean(), ['some_operation'])).includes('arbitration.no_read_only_path/C'),
    false,
  );
});

test('scan D fires on a field that would let an operation opt out of writing', () => {
  for (const field of ['writes', 'readOnly', 'skipSweep', 'noSweep']) {
    const sources = seeded(ARBITRATION_SOURCE, (source) =>
      source.replace(
        '  readonly handler: ArbitrationHandler<Input, Output>;',
        `  readonly ${field}: boolean;\n  readonly handler: ArbitrationHandler<Input, Output>;`,
      ),
    );
    assert.ok(
      scansThatFired(rules(sources, ['some_operation'])).includes(
        'arbitration.no_read_only_path/D',
      ),
      `${field} did not fire scan D`,
    );
  }
});

// ── The registry parser, which scan C depends on ────────────────────────

test('the registry parser reads keys, and refuses what it cannot read', () => {
  const wrap = (body) => `export const ARBITRATION_OPERATIONS = ${body} as const satisfies X;`;

  assert.deepEqual(registeredNamesIn(wrap('{}')).names, []);
  assert.deepEqual(
    registeredNamesIn(wrap('{\n  claim: OPERATION,\n  release: OPERATION,\n}')).names,
    ['claim', 'release'],
  );
  assert.deepEqual(registeredNamesIn(wrap("{\n  'claim': OPERATION,\n}")).names, ['claim']);

  // The important half: unreadable is null, never zero. Reporting zero for a
  // registry it could not read would make scan C pass forever and silently,
  // which is the exact failure the milestone names.
  assert.equal(registeredNamesIn(wrap('{\n  ...others,\n}')).names, null);
  assert.equal(registeredNamesIn('no registry here at all').names, null);
});

test('comments are stripped before scanning, and literals are found within lines', () => {
  assert.equal(stripComments('a /* BEGIN */ b').includes('BEGIN'), false);
  assert.equal(stripComments('a // BEGIN\nb').includes('BEGIN'), false);
  assert.deepEqual(
    stringLiterals('const a = \'one\';\nconst b = "two";').map((l) => [l.text, l.line]),
    [
      ["'one'", 1],
      ['"two"', 2],
    ],
  );
});

test('a pair of slashes inside a string literal is not a comment', () => {
  // ── `MILESTONES.md` #73 ─────────────────────────────────────────────
  //
  // The strippers were two regexes with no string awareness, so the slashes
  // in a URL were blanked as though they opened a line comment. The literal
  // was left unterminated and the rest of the line vanished.
  //
  // Both strippers are asserted because they had the same defect and their
  // consequences differ: the line-preserving one feeds the positional scans,
  // and the collapsing one feeds `stringLiterals`.
  const line = "const a = 'file:///opt/seed/target';";
  assert.equal(stripCommentsKeepingLines(line), line, 'the literal was truncated at its slashes');
  assert.equal(stripComments(line), line, 'the literal was truncated at its slashes');

  // Length is preserved exactly, which is what keeps reported lines true.
  const across = "const a = 'file:///opt/seed/target';\nconst b = 2;";
  assert.equal(stripCommentsKeepingLines(across).length, across.length);

  // A real comment on the same line as such a literal is still stripped —
  // the fix must not have been "stop stripping after a quote".
  assert.equal(
    stripCommentsKeepingLines("const a = 'x://y'; // BEGIN").includes('BEGIN'),
    false,
    'a genuine line comment after a scheme-bearing literal survived stripping',
  );
  assert.equal(
    stripCommentsKeepingLines("const a = 'x://y'; /* BEGIN */ b").includes('BEGIN'),
    false,
    'a genuine block comment after a scheme-bearing literal survived stripping',
  );
});

test('a forbidden literal after a scheme-bearing one is still seen by scan A', () => {
  // ── Why #73 was not the harmless over-firing it was filed as ────────
  //
  // The row recorded the failure direction as safe, reasoning that a dropped
  // region makes the positional scans fire *more*. That is true of the
  // line-preserving stripper and false of the other one. `stringLiterals`
  // strips comments first, so a truncated literal swallows whatever follows
  // it — including the next literal — and rule one's scan A looks **inside
  // string literals only**.
  //
  // The result was a forbidden-SQL literal that no scan could see. This is
  // the unsafe direction, and it is the reason both strippers were fixed
  // together rather than one being left to its own row.
  const hidden = "const url = 'x://y'; const sql = 'COMMIT';";
  assert.ok(
    stringLiterals(hidden).some((literal) => /\bCOMMIT\b/.test(literal.text)),
    'a forbidden literal following a scheme-bearing one on the same line was invisible to scan A',
  );

  // The control that proves the assertion above is about the scheme and not
  // about the shape of the line: the same two literals, no scheme.
  assert.ok(
    stringLiterals("const url = 'plain'; const sql = 'COMMIT';").some((literal) =>
      /\bCOMMIT\b/.test(literal.text),
    ),
  );

  // And end to end, through the rule itself rather than through its helper.
  const sources = {
    [ARBITRATION_SOURCE]: `const url = 'x://y'; const sql = 'COMMIT';\n${readFileSync(ARBITRATION_SOURCE, 'utf8')}`,
    [TRANSACTION_SOURCE]: readFileSync(TRANSACTION_SOURCE, 'utf8'),
  };
  assert.ok(
    checkImmediateTransaction(sources).some((failure) => failure.scan === 'A'),
    'the seeded COMMIT did not fire scan A, so a scheme-bearing literal still hides the literal after it',
  );
});

test('an after-commit region survives a nested template literal inside it', () => {
  // ── The false positive the shared scanner also closes ───────────────
  //
  // `endOfString` stopped at the next backtick, which for a `${…}` holding
  // its own template literal is the *inner* one's opening quote. The text
  // after it was then read as source, so braces inside the inner literal
  // unbalanced `matchingBracket` and the region ended early — putting genuine
  // after-commit work outside its own exemption.
  //
  // The seed below is that shape. The `session.navigate(…)` sits after the
  // nested template, so a region that ends early leaves it exposed to scan B.
  const code = [
    'const outcome = {',
    '  afterCommit: async (session, page) => {',
    '    const label = `a ${x === 1 ? `one}}}` : `many`} b`;',
    '    await session.navigate(page, label);',
    '  },',
    '};',
  ].join('\n');

  const regions = afterCommitRegions(stripCommentsKeepingLines(code));
  assert.equal(regions.bothScans.length, 1, 'the after-commit region was not found at all');

  const [from, to] = regions.bothScans[0];
  assert.ok(
    code.slice(from, to).includes('session.navigate(page, label)'),
    'the region ended before the after-commit work it exists to cover, so scan B would fire on correct code',
  );
});

test('the registry parser counts operations, not the keys inside them', () => {
  // A real defect this caught rather than a hypothetical one: an operation is
  // an object with its own `kind`, `summary` and `handler` keys, and a flat
  // key scan read three operations as twelve. The count is what scan C's
  // non-empty assertion rests on, so a count inflatable by the shape of a
  // value is not a count of operations.
  const wrap = (body) => `export const ARBITRATION_OPERATIONS = ${body} as const satisfies X;`;
  const nested = wrap(
    [
      '{',
      "  claim: { kind: 'claim_requested', summary: 'ask', handler: claimHandler },",
      "  giveBack: { kind: 'claim_released', summary: 'give back', handler: backHandler },",
      '}',
    ].join('\n'),
  );
  assert.deepEqual(registeredNamesIn(nested).names, ['claim', 'giveBack']);
});

test('an outer-empty registry reads as empty however its values would be shaped', () => {
  // The sharp edge of the defect above: were nesting ignored, a registry with
  // no operation in it could satisfy the non-empty assertion out of keys
  // belonging to something else entirely.
  const wrap = (body) => `export const ARBITRATION_OPERATIONS = ${body} as const satisfies X;`;
  assert.deepEqual(registeredNamesIn(wrap('{\n}')).names, []);
});

/* ─────────────── arbitration.no_browser_io ─────────────── */

/**
 * The browser rule's self-tests.
 *
 * **What a green run of these means:** each scan has been run against a
 * mutation of the shipped operation modules that violates it, and each
 * refused. The mutation in the first test is the one a reviewer wrote by hand
 * to demonstrate that the build check could not see it.
 *
 * **What it does not mean:** that browser work inside the transaction is
 * impossible. The script's header carries the limits in full; the short
 * version is that the load-bearing defence is `ArbitrationScope` carrying no
 * driver, and that this rule sees the one deliberate route — a session
 * supplied on the input — rather than every conceivable one.
 */

test('the real operation modules pass the browser rule', () => {
  assert.deepEqual(checkNoBrowserIo(operationSources(), seam), []);
});

test('scan A fires when a handler resolves the session in its body', () => {
  // ── The mutation this rule was written for ──────────────────────────
  //
  // Browser I/O inside the arbitration transaction, reaching around
  // `ArbitrationScope` — which carries no driver — by way of the session the
  // caller supplied on the input. Tests killed this; the build check did not.
  const sources = seededOperation('src/service/operations/pages.ts', (source) =>
    source.replace(
      NAVIGATE_BODY,
      `${NAVIGATE_BODY}\n  const live = await input.session();\n  void live;`,
    ),
  );
  const failures = checkNoBrowserIo(sources, seam);
  assert.ok(
    failures.some((failure) => failure.scan === 'A'),
    `resolving the session in a handler body did not fire scan A; scans that fired: ${failures.map((f) => f.scan).join(', ') || 'none'}`,
  );
});

test('scan B fires on a seam method called in a handler body, whatever the receiver is called', () => {
  // The receiver is deliberately named nothing like `session`: what makes a
  // call browser I/O is the method it names, and a check keyed to a variable
  // name is one a rename walks straight through.
  const sources = seededOperation('src/service/operations/pages.ts', (source) =>
    source.replace(NAVIGATE_BODY, `${NAVIGATE_BODY}\n  await thing.navigate(page, url);`),
  );
  const failures = checkNoBrowserIo(sources, seam);
  assert.ok(
    failures.some((failure) => failure.scan === 'B'),
    `a seam method in a handler body did not fire scan B; scans that fired: ${failures.map((f) => f.scan).join(', ') || 'none'}`,
  );
});

test('scan B fires for every method the seam declares, including its inherited ones', () => {
  // **The seam splits its methods across two interfaces**, and the page verbs
  // — the ones a handler would actually call — are on the base. A scan that
  // read only the leaf would collect the lifecycle methods, find none of them
  // in an operation module, and report green over the whole rule.
  const methods = browserSessionMethods(seam);
  assert.notEqual(methods, null, 'the seam declared no readable methods');

  for (const method of methods) {
    const sources = seededOperation('src/service/operations/pages.ts', (source) =>
      source.replace(NAVIGATE_BODY, `${NAVIGATE_BODY}\n  await thing.${method}();`),
    );
    const failures = checkNoBrowserIo(sources, seam);
    assert.ok(
      failures.some((failure) => failure.scan === 'B'),
      `${method}() in a handler body did not fire scan B`,
    );
  }
});

test('the same call inside an after-commit closure does not fire, so the rule is positional', () => {
  // ── The control for this rule ───────────────────────────────────────
  //
  // Without it, a scan that fired on the mere presence of `session.navigate(`
  // anywhere in the file would pass every test above while forbidding the
  // correct code as loudly as the incorrect code. What is being checked is
  // *where* the call sits, so a seed in the permitted position must stay
  // silent.
  //
  // **The anchor is the closure's head, deliberately, and stops before the
  // argument list.** An argument list is the part of a call that churns: a
  // seed spelling out `session.navigate(page, url)` in full matches nothing
  // the moment `navigate` takes another argument, and a seed that matches
  // nothing leaves this guarantee untested while the suite stays green.
  // `seededOperation` is what stops that being silent, and anchoring on the
  // part that does not churn — a closure taking `(session, page)` and calling
  // a method on the session it was handed — is what stops it happening.
  //
  // **What is seeded is still a real second browser call in the permitted
  // position** — `session.describe()`, a method scan B looks for by name,
  // written inside the after-commit closure. `?? ` rather than a comma
  // expression so that every bracket in the injected text closes: the region
  // finder counts brackets, and an unbalanced seed would drop the enclosing
  // region and make this control pass for the wrong reason.
  const sources = seededOperation('src/service/operations/pages.ts', (source) =>
    source.replace(
      '(session, page) => session.',
      '(session, page) => (session.describe() as unknown) ?? session.',
    ),
  );
  assert.deepEqual(
    checkNoBrowserIo(sources, seam).filter((failure) => failure.scan === 'B'),
    [],
    'a browser call inside an after-commit closure fired the rule, which would forbid the correct shape',
  );
});

test('scan A fires on a session resolved inside a helper the exemption covers', () => {
  // ── The hole the two-tier split closes ──────────────────────────────
  //
  // `afterCommitRegions` exempts the whole body of a function declaring a
  // `BrowserSession` parameter, and that exemption is sound only because
  // *acquiring* a session is what scan A catches. While both scans read one
  // flat region list, the acquisition could be written **inside the exempted
  // body**, where scan A had just been switched off — so the helper resolved
  // its own session and drove it, and the rule said nothing.
  //
  // The seed below is exactly that shape: a helper that receives a session it
  // never uses while resolving another one. Scan A must see the resolution,
  // because the region it sits in is only ever exempt from scan B.
  const sources = seededOperation('src/service/operations/pages.ts', (source) =>
    source.replace(
      NAVIGATE_BODY,
      `${NAVIGATE_BODY}\nfunction smuggle(handed: BrowserSession, source: SessionSource): void {\n  void handed;\n  const live = source.session();\n  void live;\n}`,
    ),
  );
  const failures = checkNoBrowserIo(sources, seam);
  assert.ok(
    failures.some((failure) => failure.scan === 'A'),
    `a session resolved inside a BrowserSession-taking helper did not fire scan A, so the helper exemption still silences the scan that keeps it sound; scans that fired: ${failures.map((f) => f.scan).join(', ') || 'none'}`,
  );
});

test('a seam call inside that same helper still does not fire, so the exemption survives the split', () => {
  // ── The control for the split ───────────────────────────────────────
  //
  // The tier above must narrow the exemption without abolishing it. A helper
  // *handed* a session calling a seam method on it is the case the exemption
  // was written for, and it has to stay silent — otherwise the fix trades a
  // latent hole for a live false positive on correct code, which is how a
  // check gets waived.
  //
  // **The seeded target carries a scheme, and that is load-bearing.** The
  // pair of slashes inside the literal is exactly the shape that the comment
  // strippers must not mistake for a line comment: blanking it unterminates
  // the string, unbalances `matchingBracket` and drops the enclosing region,
  // so this control would fail for that reason rather than the one it tests.
  // `MILESTONES.md` #73. The scheme therefore does double duty — a realistic
  // navigation target, and a regression test for the stripper.
  const sources = seededOperation('src/service/operations/pages.ts', (source) =>
    source.replace(
      NAVIGATE_BODY,
      `${NAVIGATE_BODY}\nfunction drive(handed: BrowserSession, page: TabHandle): Promise<void> {\n  return handed.navigate(page, 'file:///opt/seed/target');\n}`,
    ),
  );
  assert.deepEqual(
    checkNoBrowserIo(sources, seam).filter((failure) => failure.scan === 'B'),
    [],
    'a seam call inside a helper handed a session fired scan B, so the split abolished the exemption rather than narrowing it',
  );
});

test('scan C refuses an operation module that is not there', () => {
  const sources = operationSources();
  delete sources['src/service/operations/pages.ts'];
  const failures = checkNoBrowserIo(sources, seam);
  assert.ok(
    failures.some((failure) => failure.scan === 'C'),
    'a missing operation module was scanned as though it were clean, which reads exactly like a clean tree',
  );
});

test('scan D refuses rather than scanning for an empty set of browser methods', () => {
  // The vacuous case, and the one that would pass forever and silently: with
  // no methods to look for, scan B asks nothing of any file.
  const failures = checkNoBrowserIo(operationSources(), 'export interface NotTheSeam {}');
  assert.ok(
    failures.some((failure) => failure.scan === 'D'),
    'an unreadable browser seam did not refuse, so the rule would have scanned for nothing',
  );
});
