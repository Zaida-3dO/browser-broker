import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOLS_BY_NAME } from '../../src/tool/tools.ts';

/**
 * The description an agent reads before deciding an upload is impossible.
 *
 * ── What this suite is guarding against ─────────────────────────────────
 *
 * `MAX_EXPRESSION_BYTES` bounds the expression's own source text, not any
 * data the page goes on to fetch. Nothing in an earlier description said so,
 * and a caller holding a multi-megabyte screenshot read the byte limit as a
 * statement about the file — a measured, repeated misreading (a fetch, a
 * `File`, and a dispatched `change` event moves a file of any size in a few
 * hundred bytes of expression). The failure is a confident wrong conclusion
 * reached before any call is made, so the only surface that can reach a
 * caller in time is the description it reads on every turn — same shape as
 * the settle caveat this suite borrows its structure from
 * (`capture-settle.test.ts`).
 *
 * ── Why these assertions name phrases rather than the constant ──────────
 *
 * Asserting against the imported byte constant would go green even if the
 * clarifying sentence were deleted outright. The literals below are written
 * independently of the text under test, so gutting that text fails them.
 */

const evaluateTool = TOOLS_BY_NAME.get('browser_evaluate');

test('browser_evaluate SAYS THE BOUND IS ON THE SOURCE, not on data it fetches', () => {
  assert.ok(evaluateTool, 'browser_evaluate is on the surface');
  const description = evaluateTool.description;

  assert.match(description, /length limit/i);
  assert.match(description, /expression source/i);
  assert.match(description, /not on data it fetches/i);
});

test('the `expression` argument description carries the same fact, in brief', () => {
  assert.ok(evaluateTool);
  const expression = evaluateTool.arguments.find((argument) => argument.name === 'expression');
  assert.ok(expression, 'browser_evaluate takes an expression');
  assert.match(expression.description, /bound is on this source text/i);
  assert.match(expression.description, /not on data/i);
});

test('the description stays SHORT — surface area is a standing tax, paid every turn', () => {
  // §3.1: every description sits in a connected session's context on every
  // turn, whether or not anything calls the tool. There is no correct number
  // here, so this is a ceiling against the description becoming an essay
  // rather than a claim that some length is right — the same 900 ceiling
  // `browser_capture` and the browser-choice guidance are held to.
  assert.ok(evaluateTool);
  assert.ok(
    evaluateTool.description.length < 900,
    `browser_evaluate's description is ${String(evaluateTool.description.length)} characters; it is read on every turn and must not become an essay`,
  );
});
