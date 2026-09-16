import assert from 'node:assert/strict';
import test from 'node:test';

import { PAGE_ACTIONS } from '../../src/browser/driver.ts';
import { TOOLS_BY_NAME } from '../../src/tool/tools.ts';

/**
 * `browser_act`'s description names every action `PAGE_ACTIONS` declares.
 *
 * ── What this suite is guarding against ─────────────────────────────────
 *
 * **Measured at HEAD `ca53f43`:** `fill_form` and `drag` were both real,
 * implemented `PAGE_ACTIONS` entries, but `browser_act`'s description named
 * only the other ten. The refusal an unknown verb gets lists every action
 * (`PAGE_ACTIONS` itself), so the description and the refusal disagreed —
 * silently, because nothing compared them. An agent reading only the
 * description, which is the one surface it reliably reads every turn, had no
 * way to learn either verb existed.
 *
 * `src/tool/tools.ts` now builds the verb list by joining `PAGE_ACTIONS`
 * itself, so the two cannot drift apart in code. This suite is the
 * independent check on that: it does not import the join, it re-derives the
 * expectation from the same source list and asks the rendered description
 * whether each name is actually present as text. A future edit that reverts
 * the description to a hand-typed string — reintroducing exactly this bug —
 * fails this test even though nothing changed about `PAGE_ACTIONS`.
 *
 * ── Why this asserts against `PAGE_ACTIONS` rather than a hardcoded list ──
 *
 * The alternative — writing out `['click', 'type', ...]` again here — is the
 * hollow shape from the other direction: it would pass at first and then
 * silently stop covering a thirteenth verb the moment one is added, because
 * nothing connects the hardcoded list to the real one. Reading `PAGE_ACTIONS` means
 * a new verb is covered by this test the moment it exists, with no edit here
 * required. What makes this a real test rather than a tautology is that it
 * does not touch the *production* join at all — it reads the rendered
 * `description` string as a caller would and checks by substring, so a
 * regression in the join itself (wrong separator, truncated list, a typo'd
 * import) is exactly what this would catch.
 */

test('browser_act names every PAGE_ACTIONS verb, including fill_form and drag', () => {
  const actTool = TOOLS_BY_NAME.get('browser_act');
  assert.ok(actTool, 'browser_act is on the surface');

  for (const action of PAGE_ACTIONS) {
    assert.ok(
      actTool.description.includes(action),
      `browser_act's description does not mention "${action}"`,
    );
  }

  // Named explicitly, not just covered by the loop above: these are the two
  // verbs that were missing, and a reviewer should see them fail by name
  // rather than infer it from a loop iteration number.
  assert.ok(actTool.description.includes('fill_form'));
  assert.ok(actTool.description.includes('drag'));
});
