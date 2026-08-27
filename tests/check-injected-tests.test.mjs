import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SELF_EXEMPT,
  cleanReason,
  findViolations,
  isRealReason,
  isScannable,
  withoutStringLiterals,
} from '../scripts/check-injected-tests.mjs';

/**
 * The self-test for `tests.injection_waived`.
 *
 * `CLAUDE.md`: *"Any script used as a gate … must ship a test proving it
 * **fails on a seeded violation**, not merely that it passes on clean input. A
 * gate only ever proven to pass has never been run against the thing it exists
 * to catch, and a check that cannot fail is a no-op with a green tick beside
 * it."*
 *
 * ══ WHAT A GREEN RUN OF THE GATE MEANS, PINNED HERE ══════════════════════
 *
 * Stated in the test as well as in the script, because the script's header is
 * prose and prose drifts — which is the exact failure this gate was built in
 * response to. A green run means:
 *
 *   **Every file under `tests/` that hands a `service:` to an entry point
 *   carries a waiver saying why, and no waiver is a placeholder.**
 *
 * It does **not** mean the reasons are true. Whether a state really is
 * unreachable through every shipped binary, and whether a spawn-driven gate
 * really owns an assertion, are judgements no script can make. The gate makes
 * the claim explicit and visible in the diff; a reviewer decides whether it
 * holds. That limit is asserted below rather than left to be discovered.
 */

/** The shape the gate exists to catch. */
const UNWAIVED = `
test('drives the adapter', async () => {
  const code = await run(['status'], {
    service: { perform: () => Promise.resolve({ outcome: 'accepted' }) },
  });
  assert.equal(code, 0);
});
`;

test('an injection with no waiver anywhere in the file is a violation', () => {
  const found = findViolations(UNWAIVED);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].kind, 'unwaived-injection');
  assert.match(found[0].text, /service:/);
});

test('the same injection under a real waiver passes', () => {
  const waived = `/**
 * injected-test-ok: the queued-then-active transition is a contended queue
 * state no spawn can arrange without manufacturing a race.
 */${UNWAIVED}`;
  assert.deepEqual(findViolations(waived), []);
});

/**
 * The waiver has to say something. These are the exact shapes
 * `check-external-refs.mjs` documents as defeating a naive rule, carried over
 * because the mechanism is carried over.
 */
test('a waiver that explains nothing is itself a violation', () => {
  for (const empty of [
    '// injected-test-ok:',
    '// injected-test-ok: ok',
    '// injected-test-ok: this is fine',
    '// injected-test-ok: TODO TODO TODO',
    '// injected-test-ok: xxxxxxxxxxxxxxx',
    '// injected-test-ok: needed for the test',
  ]) {
    const found = findViolations(`${empty}\n${UNWAIVED}`);
    const kinds = found.map((violation) => violation.kind);
    assert.ok(
      kinds.includes('empty-waiver'),
      `${JSON.stringify(empty)} should have been rejected, got ${JSON.stringify(kinds)}`,
    );
  }
});

/**
 * One real word repeated is one real word. Distinctness is the only rule that
 * reaches this, so it is pinned with a fixture of exactly that shape.
 */
test('a waiver padded out by repeating one word is rejected', () => {
  assert.equal(isRealReason('queue queue queue'), false);
  assert.equal(isRealReason('contended queue arranges races deterministically'), true);
});

/**
 * A waiver that fails and an injection it would have covered are TWO
 * findings, not one. Reporting only the empty waiver would let an author
 * silence the injection with a placeholder and see a single complaint about
 * wording.
 */
test('a placeholder waiver does not silence the injection it sits above', () => {
  const found = findViolations(`// injected-test-ok: fine\n${UNWAIVED}`);
  const kinds = found.map((violation) => violation.kind).sort();
  assert.deepEqual(kinds, ['empty-waiver', 'unwaived-injection']);
});

/**
 * Declarations are plumbing, not injections. Each of the three shapes the
 * script narrows away is pinned, so narrowing it cannot silently stop it
 * seeing a real injection.
 */
test('declaring the seam is not injecting through it', () => {
  const declarations = [
    'async function drive(argv, options: { service?: BrokerService } = {}) {}',
    'function make(answer): { service: BrokerService } {',
    '  const service: BrokerService = {',
  ];
  for (const line of declarations) {
    assert.deepEqual(findViolations(line), [], `should be plumbing: ${line}`);
  }
});

/**
 * `service:` occurs in English inside assertion messages. There is one in the
 * tree reading "must reach the service: a surface that declares an argument
 * and drops it" — demanding a waiver for prose would be the gate crying wolf.
 */
test('the word inside a string literal is prose, not an injection', () => {
  const prose = 'assert.ok(hit, `must reach the service: a surface that drops it lies`);';
  assert.deepEqual(findViolations(prose), []);
});

test('a string literal is blanked without moving the columns around it', () => {
  const line = 'const a = "service: x"; const b = 1;';
  const stripped = withoutStringLiterals(line);
  assert.equal(stripped.length, line.length, stripped);
  assert.ok(!/service\s*:/.test(stripped), stripped);
  assert.match(stripped, /const b = 1;/);
});

test('an escaped quote does not end the literal early', () => {
  const line = 'const a = "he said \\"service: x\\" loudly"; const b = 2;';
  const stripped = withoutStringLiterals(line);
  assert.ok(!/service\s*:/.test(stripped), stripped);
});

/**
 * A fenced block is documentation. A file teaching the syntax would otherwise
 * excuse anything pasted into that block later — the same carve-out
 * `check-external-refs.mjs` makes.
 */
test('a waiver inside a fenced code block does not waive', () => {
  const documented = [
    '```',
    '// injected-test-ok: this explains the syntax properly',
    '```',
    UNWAIVED,
  ].join('\n');
  const kinds = findViolations(documented).map((violation) => violation.kind);
  assert.deepEqual(kinds, ['unwaived-injection']);
});

test('comment furniture is stripped off a reason before it is judged', () => {
  assert.equal(cleanReason(' the queue cannot be raced */'), 'the queue cannot be raced');
  assert.equal(cleanReason(' the queue cannot be raced -->'), 'the queue cannot be raced');
});

/**
 * The self-exemption is pinned, because one name added to that list silences
 * a file completely. It must stay exactly these two: the gate and its own
 * self-test, whose fixtures are deliberately the shapes the gate catches.
 */
test('exactly two files are exempt from the gate, and they are the gate itself', () => {
  assert.deepEqual(SELF_EXEMPT, [
    'scripts/check-injected-tests.mjs',
    'tests/check-injected-tests.test.mjs',
  ]);
  assert.equal(isScannable('tests/check-injected-tests.test.mjs'), false);
});

/** Product code is out of scope; the rule is about tests. */
test('only test sources are scanned', () => {
  assert.equal(isScannable('tests/cli/run.test.ts'), true);
  assert.equal(isScannable('tests/helpers/browser.ts'), true);
  assert.equal(isScannable('src/cli/index.ts'), false);
  assert.equal(isScannable('docs/ROLLOUT.md'), false);
});

/**
 * ══ KNOWN LIMITS, ASSERTED SO THEY CANNOT BE FORGOTTEN ═══════════════════
 *
 * These seed cases the gate does **not** catch and assert it stays quiet —
 * which looks perverse and is the point. A limit that is only written down
 * gets forgotten; a limit with a test beside it has to be deliberately
 * changed. Each mirrors the treatment in `check-capture-isolation`'s
 * self-test.
 */
test('a limit: the gate does not judge whether a reason is TRUE', () => {
  const false_but_well_formed = `/**
 * injected-test-ok: this reason is entirely fabricated nonsense about
 * unreachable browser states that anybody could disprove in a minute.
 */${UNWAIVED}`;
  assert.deepEqual(
    findViolations(false_but_well_formed),
    [],
    'the gate costs an explanation; it cannot audit one',
  );
});

test('a limit: a waived file may gain a second, unjustified injection', () => {
  const two = `/**
 * injected-test-ok: the contended queue transition cannot be arranged by any
 * spawn without manufacturing a race.
 */${UNWAIVED}${UNWAIVED}`;
  assert.deepEqual(
    findViolations(two),
    [],
    'waivers are file-scoped by design — see the rationale in the script',
  );
});

test('a limit: an injection assembled elsewhere and spread in is invisible', () => {
  const spread = `
const options = buildOptions();
const code = await run(['status'], { ...options });
`;
  assert.deepEqual(findViolations(spread), [], 'this is a text scan, not a type-aware one');
});
