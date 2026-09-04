import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOLS_BY_NAME } from '../../src/tool/tools.ts';

/**
 * The build-comparison routing hint on `browser_capture` (§3.11).
 *
 * ── What this suite is guarding against ─────────────────────────────────
 *
 * Measured: 18 hours of transcripts had `compare_to` used once against 80
 * `Read` calls opening a screenshot back into context — but that measurement
 * is answered by `capture-teaches-compare-to.test.ts`, not this file. This
 * suite guards the other half of the same feedback: `compare_to` diffs one
 * tab against an earlier moment of itself, and a caller trying to compare
 * two separate *builds* — two runs, often two processes — will find the word
 * "compare" on this tool and reach for it anyway. Nothing refuses that call;
 * a diff still runs and still answers a real question, just not the one the
 * caller meant to ask. A routing hint at the point of the call is the only
 * thing that can catch this before the wrong tool is already in use.
 *
 * ── Why these assertions name phrases rather than the constant ──────────
 *
 * Following `capture-settle.test.ts`'s rule: asserting against the imported
 * constant means the mutation that empties it empties the assertion too and
 * stays green. The literals below are written out separately and are not
 * derived from the text under test, so gutting the description fails them.
 */

const captureTool = TOOLS_BY_NAME.get('browser_capture');

test('browser_capture DISTINGUISHES a same-tab diff from a two-build comparison', () => {
  assert.ok(captureTool, 'browser_capture is on the surface');
  const description = captureTool.description;

  // The routing hint names the wrong-shape case explicitly rather than
  // leaving it to be inferred from `compare_to` merely existing.
  assert.match(description, /two builds|separate builds|two runs/i);

  // And it names why: this tool's unit (one lease, one tab, pixels) is a
  // property of the whole surface, not just this one call, so the reasoning
  // has to survive without the caller reading anything else.
  assert.match(description, /one lease|one tab/i);
  assert.match(description, /scene|dom/i);
});

test('the routing hint and the settle caveat are both present, at the same time', () => {
  // Both caveats have to survive together: the settle caveat is what teaches
  // `compare_to` as a same-tab check, and this one is what keeps a caller
  // from pointing that same mechanism at the wrong question. Losing either
  // independently is a real regression, so both are asserted in one test.
  assert.ok(captureTool);
  const description = captureTool.description;
  assert.match(description, /settled/i, 'the settle caveat must still be present');
  assert.match(
    description,
    /two builds|separate builds|two runs/i,
    'the build-comparison routing hint must still be present',
  );
});

test('the description stays under the standing ceiling with both caveats attached', () => {
  // §3.1: every description sits in a connected session's context on every
  // turn. `capture-settle.test.ts` already pins the same ceiling; repeated
  // here because this file is what proves the ceiling still holds once the
  // second caveat is added, not merely that the first one alone fits.
  assert.ok(captureTool);
  assert.ok(
    captureTool.description.length < 900,
    `browser_capture's description is ${String(captureTool.description.length)} characters; it is read on every turn and must not become an essay`,
  );
});
