import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOLS_BY_NAME } from '../../src/tool/tools.ts';

/**
 * The settle caveat on `browser_capture`, and the honest bound on
 * `browser_navigate`'s wait (§3.7, §3.11).
 *
 * ── What this suite is guarding against ─────────────────────────────────
 *
 * **Measured: a session captured a canvas before it had drawn, read the dark
 * frame as the application's real appearance, and reported a fault against an
 * application that did not have one.** Nothing refused it and nothing could
 * have: a capture returns a path to an image, and an image of a half-rendered
 * page is indistinguishable from one of a broken page. The caller had no
 * field in the result to distrust.
 *
 * So the failure this suite prevents is not a crash but a **confident wrong
 * conclusion**, and the only surface that can reach a caller before it draws
 * one is the description it reads on every turn.
 *
 * ── Why these assertions name phrases rather than the constant ──────────
 *
 * `MILESTONES.md` records the hollow shape to avoid: asserting against the
 * imported constant, so the mutation that empties it empties the assertion
 * too and stays green. The literals below are written out here and are not
 * derived from the text under test, so gutting that text fails them.
 *
 * The assertions pin **substance rather than wording** — that the caveat
 * distinguishes settling from completeness, and that it names a check a
 * caller can actually run. Rewording is free; removing the meaning is not.
 */

const captureTool = TOOLS_BY_NAME.get('browser_capture');
const navigateTool = TOOLS_BY_NAME.get('browser_navigate');

test('browser_capture SAYS A FRAME MAY BE EARLY, because the picture cannot say so itself', () => {
  assert.ok(captureTool, 'browser_capture is on the surface');
  const description = captureTool.description;

  // That settling happens at all, and what it buys — a caller told only
  // "captures are settled" would reasonably read that as "captures are
  // complete", which is the inference that produced the wrong report.
  assert.match(description, /settled/i);

  // The distinction that matters: steadying a moving page is not waiting for
  // an unfinished one. Without this sentence the caveat is a reassurance.
  assert.match(description, /still drawing|not (?:yet )?rendered|before it has rendered/i);

  // **The consequence, named.** The reason this is worth per-turn context is
  // that the failure looks like a finding rather than like an error: an early
  // frame is indistinguishable from a broken page.
  assert.match(description, /broken/i);
});

test('THE CAVEAT NAMES A CHECK A CALLER CAN RUN, not a duration it cannot pick', () => {
  assert.ok(captureTool);
  const description = captureTool.description;

  // The right wait is a property of the page, not of this service, so advice
  // to "wait long enough" is advice a caller that has never seen the page
  // rendered cannot act on. The guidance has to be something it can perform
  // with what it already has.
  assert.match(description, /compare_to/);
  assert.match(description, /again/i);

  // And `compare_to` is a real argument on this tool rather than a suggestion
  // pointing at nothing — the guidance is only actionable if the mechanism it
  // names is on the same surface as the sentence naming it.
  assert.ok(
    captureTool.arguments.some((argument) => argument.name === 'compare_to'),
    'the caveat points at an argument this tool actually takes',
  );
});

test('browser_navigate DOES NOT LET wait_ms READ AS A SETTLE, which is why the wrong frame was trusted', () => {
  assert.ok(navigateTool, 'browser_navigate is on the surface');
  const wait = navigateTool.arguments.find((argument) => argument.name === 'wait_ms');
  assert.ok(wait, 'browser_navigate takes a wait');

  // **This is the argument a caller reaches for to solve exactly this
  // problem**, and the description it had — "how long to wait for the page" —
  // invited it to believe the problem was solved. It bounds the load; work
  // the page starts after the load is not the load.
  assert.match(wait.description, /does not wait|not wait for/i);
  assert.match(wait.description, /canvas|lazily|deferred/i);

  // It points at where the answer is, so a caller reading this argument in
  // isolation is not left with a warning and no remedy.
  assert.match(wait.description, /browser_capture/);
});

test('the caveat stays SHORT — surface area is a standing tax, paid every turn', () => {
  // §3.1: every description sits in a connected session's context on every
  // turn, whether or not anything calls the tool. There is no correct number
  // here, so this is a ceiling against the description becoming an essay
  // rather than a claim that some length is right. Roughly twice the current
  // text, matching the ceiling the browser-choice guidance is held to.
  assert.ok(captureTool);
  assert.ok(
    captureTool.description.length < 900,
    `browser_capture's description is ${String(captureTool.description.length)} characters; it is read on every turn and must not become an essay`,
  );
});
