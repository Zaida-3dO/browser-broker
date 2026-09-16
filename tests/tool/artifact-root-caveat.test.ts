import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOLS_BY_NAME } from '../../src/tool/tools.ts';

/**
 * `browser_capture` and `browser_read` return paths, never bytes (§1.7a),
 * and nothing on the tool surface used to say what those paths were rooted
 * at. Reported independently in two feedback notes: a caller not on the same
 * filesystem — or simply without `BROKER_ARTIFACTS_ROOT` set — had a return
 * value it could not open.
 *
 * ── Why this asserts substance, not the constant ────────────────────────
 *
 * `MILESTONES.md`'s hollow-test lesson applies here exactly as it does to
 * the settle caveat: asserting against the imported string would let the
 * mutation that empties it stay green. These literals are written out here,
 * independent of the source text under test.
 */

test('browser_capture NAMES THE ARTIFACT ROOT, so a returned path is findable', () => {
  const captureTool = TOOLS_BY_NAME.get('browser_capture');
  assert.ok(captureTool, 'browser_capture is on the surface');

  assert.match(captureTool.description, /BROKER_ARTIFACTS_ROOT/u);
  assert.match(captureTool.description, /relative to/iu);
});

test('browser_read NAMES THE ARTIFACT ROOT, so a returned path is findable', () => {
  const readTool = TOOLS_BY_NAME.get('browser_read');
  assert.ok(readTool, 'browser_read is on the surface');

  assert.match(readTool.description, /BROKER_ARTIFACTS_ROOT/u);
  assert.match(readTool.description, /relative to/iu);
});
