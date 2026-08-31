import assert from 'node:assert/strict';
import test from 'node:test';

import { executablePathForEngine } from '../../src/browser/real.ts';

/**
 * The engine hook (`DECISIONS.md` §13i).
 *
 * ── What this covers, and what it deliberately does not ─────────────────
 *
 * §13i builds **the hook and the enum validation, and nothing else**.
 * Per-engine executable *discovery* is named there as separable and out of
 * scope, so there is no test below asserting that a particular engine
 * resolves to a particular installed binary — there is no code claiming to do
 * that, and a test asserting it would be asserting an intention.
 *
 * What is here is the property the hook actually has: **an engine selects
 * among paths this process was supplied, and an engine nobody supplied a path
 * for resolves to nothing** rather than to another engine's binary. That last
 * one is the failure worth a test, because silently launching Chromium while
 * a caller believed it had selected Brave is the configuration-nobody-chose
 * failure §6.3 exists to prevent, and it is invisible from the outside.
 *
 * The validation half — an unrecognised engine word refusing the spawn and
 * naming the accepted set — is in `tests/config/browsers.test.ts`, where the
 * variable is read.
 */

test('an engine resolves to the path supplied for it', () => {
  const paths = { chrome: '/somewhere/chrome', brave: '/somewhere/brave' };
  assert.equal(executablePathForEngine('chrome', paths), '/somewhere/chrome');
  assert.equal(executablePathForEngine('brave', paths), '/somewhere/brave');
});

test('an engine with no supplied path resolves to nothing, never to another engine', () => {
  // The whole point. Returning some other engine's path here would launch a
  // browser the caller did not choose, with nothing to notice it by.
  const paths = { chrome: '/somewhere/chrome' };
  assert.equal(executablePathForEngine('msedge', paths), undefined);
  assert.equal(executablePathForEngine('brave', paths), undefined);
});

test('with nothing supplied at all, no engine resolves', () => {
  // A process given no paths launches what an unconfigured build launches,
  // and the decision to fall back lives in the driver rather than here — so
  // this asserts the resolver reports "not known" rather than choosing.
  assert.equal(executablePathForEngine('chrome', undefined), undefined);
  assert.equal(executablePathForEngine('msedge', undefined), undefined);
  assert.equal(executablePathForEngine('brave', undefined), undefined);
});
