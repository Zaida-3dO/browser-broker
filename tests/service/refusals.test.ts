import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BrokerError, StartupRefusal } from '../../src/errors.ts';
import { CallRefusal, REFUSALS, REFUSAL_CODES } from '../../src/service/refusals.ts';

/**
 * The rejection taxonomy.
 *
 * `SCHEMA.md` §7: "a rule that never refuses anything protects nothing, so the
 * refusals are the specification". These tests are about the shape a refusal
 * arrives in (§3.14) rather than about any particular guard, because the
 * guards belong to the rows that have operations to guard.
 */

test('a refusal carries the code, the rule and the details separately', () => {
  const refusal = new CallRefusal('lease_ended', 'That lease ended.', {
    detail: { state: 'revoked', endedAt: '2020-01-01T00:00:00.000Z' },
  });

  assert.equal(refusal.code, 'lease_ended');
  assert.equal(refusal.rule, 'claim.live');
  assert.equal(refusal.message, 'That lease ended.');
  assert.deepEqual(refusal.detail, { state: 'revoked', endedAt: '2020-01-01T00:00:00.000Z' });
});

test('the rule is read from the table rather than supplied, so the pair cannot drift', () => {
  // A surface that could pass its own rule name could attribute a refusal to
  // a rule that did not make it — and §8's assertion four counts rules over
  // what the service actually returned, so a mis-attribution there is a
  // rule reported as covered when nothing exercises it.
  for (const code of REFUSAL_CODES) {
    assert.equal(new CallRefusal(code, 'a sentence').rule, REFUSALS[code].rule);
  }
});

test('two rules deliberately share the tab refusal, so probing discovers nothing', () => {
  // §7.1 states this outright: an unowned tab gets "the same refusal as an
  // unknown tab, so probing cannot discover another lease's tabs". Named
  // rather than derived, because the whole point is that the collapse is
  // intentional and must survive somebody tidying it.
  const refusal = new CallRefusal('tab_not_found', 'That tab was not found.');
  assert.equal(refusal.code, 'tab_not_found');
  assert.equal(refusal.rule, 'tab.owned');
});

test('a refusal is a broker error and not a startup refusal', () => {
  // The distinction the entry point's error handling is built on: a startup
  // refusal means this process does not run, a call refusal means this call
  // did not. An entry point that could not tell them apart would exit the
  // process over a bad argument.
  const refusal = new CallRefusal('unknown_browser', 'No such browser.');
  assert.ok(refusal instanceof BrokerError);
  assert.ok(refusal instanceof Error);
  assert.ok(!(refusal instanceof StartupRefusal));
  assert.equal(refusal.name, 'CallRefusal');
});

test('the retry hint distinguishes availability from a permanent answer', () => {
  // §2.2's two outright refusals, and why they are different: "nothing will
  // ever make it valid" against "a browser being down is an availability
  // problem". A caller told to retry a permanent refusal hammers it.
  assert.equal(new CallRefusal('browser_unavailable', 'Starting.').retryable, true);
  assert.equal(new CallRefusal('unknown_browser', 'No such browser.').retryable, false);
  assert.equal(new CallRefusal('lease_ended', 'Ended.').retryable, false);
});

test('detail defaults to empty rather than undefined', () => {
  // A surface reading `.detail.position` on a refusal that carried none
  // should get undefined, not a crash on a property of undefined.
  assert.deepEqual(new CallRefusal('key_missing', 'No key.').detail, {});
});

test('a cause is preserved for the log without reaching the caller', () => {
  const cause = new Error('the underlying failure');
  const refusal = new CallRefusal('browser_unavailable', 'Unavailable.', { cause });
  assert.equal(refusal.cause, cause);
});

test('every code names a rule, a summary and a retry answer', () => {
  // Named per entry rather than iterated blindly: a crew on this repository
  // shipped a check that iterated a list rather than naming its entries, so
  // deleting an entry stayed green. The count is asserted first, so removing
  // a code fails here even though the loop below would happily skip it.
  assert.equal(REFUSAL_CODES.length, 9, 'a refusal code was added or removed without a test');
  assert.deepEqual([...REFUSAL_CODES].sort(), [
    'browser_unavailable',
    // Added with the sign-in path. It shares `browser.serving` with the code
    // above and differs on `retryable`, which is the field a caller acts on:
    // a browser being signed into will serve again, and the private browser
    // will never be signable.
    'cannot_sign_in',
    'key_missing',
    'lease_ended',
    'reason_required',
    'tab_not_found',
    'unknown_browser',
    'unknown_operation',
    'unrecognised_key',
  ]);

  for (const code of REFUSAL_CODES) {
    const definition = REFUSALS[code];
    assert.match(definition.rule, /^[a-z_]+\.[a-z_]+$/, `${code} has no rule name from section 7`);
    assert.ok(definition.summary.length > 10, `${code} has no summary`);
    assert.equal(typeof definition.retryable, 'boolean');
  }
});

test('every rule this taxonomy names is a rule the design actually lists', () => {
  // The check that keeps the table honest: a rule name invented here would
  // make §8's assertion four count a rule that does not exist, and the
  // coverage number would be wrong in the flattering direction.
  //
  // The one exception is declared rather than waived — `arbitration.registered`
  // is raised by the runner and is not a §7.1 row, because §7.1 is about
  // rules that decide whether an operation is allowed and this one is about
  // whether the operation exists.
  const design = readFileSync('docs/plans/SCHEMA.md', 'utf8');
  const notInSection7 = new Set(['arbitration.registered']);

  for (const code of REFUSAL_CODES) {
    const rule = REFUSALS[code].rule;
    if (notInSection7.has(rule)) continue;
    assert.ok(
      design.includes(`\`${rule}\``),
      `${rule} (from ${code}) appears nowhere in the design's rule list`,
    );
  }
});
