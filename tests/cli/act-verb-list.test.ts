import assert from 'node:assert/strict';
import test from 'node:test';

import { PAGE_ACTIONS } from '../../src/browser/driver.ts';
import { OPERATION_COMMANDS } from '../../src/cli/commands.ts';

/**
 * The CLI's `act` summary names every action `PAGE_ACTIONS` declares.
 *
 * ── What this suite is guarding against ─────────────────────────────────
 *
 * The MCP half of this defect is covered by `tests/tool/act-verb-list.test.ts`:
 * `browser_act`'s description was a hand-typed list that had fallen behind
 * `PAGE_ACTIONS`, so a verb existed that no agent could discover. Tying that
 * description to `PAGE_ACTIONS` fixed the MCP surface and left the CLI's own
 * summary hand-typed — which is how `drag` came to be missing from
 * `broker --help` while `broker act --help`, whose `--action` flag summary
 * derives from the same list, named it correctly on the same screen.
 *
 * `src/cli/commands.ts` now joins `PAGE_ACTIONS` for both. This suite is the
 * independent check on that, and the reason a one-word patch adding the
 * missing verb to a hand-typed string would not have closed the item: a
 * corrected hand-typed list passes on the day it is written and silently stops
 * covering the fourteenth verb the moment one is added.
 *
 * ── Why this asserts against `PAGE_ACTIONS` rather than a hardcoded list ──
 *
 * Writing `['click', 'type', ...]` again here is the hollow shape from the
 * other direction — it would pass immediately and then never notice a new
 * verb, because nothing would connect the copy to the real list. Reading
 * `PAGE_ACTIONS` means a verb added to the driver is covered here the moment
 * it exists with no edit to this file.
 *
 * What makes this a real test rather than a tautology is that it never touches
 * the production join. It reads the rendered `summary` string the way a person
 * reading `--help` does and checks by substring, so reverting the summary to a
 * hand-typed string, dropping a verb from the join, or breaking the separator
 * all fail here even though `PAGE_ACTIONS` itself is untouched.
 *
 * **The single-character change that breaks this:** delete one entry from the
 * joined output — or re-type the summary as a literal missing any one verb —
 * and the loop below fails, naming the verb.
 */

test('the CLI act summary names every PAGE_ACTIONS verb, including drag', () => {
  const actCommand = OPERATION_COMMANDS.find(
    (command) => command.words.length === 1 && command.words[0] === 'act',
  );
  assert.ok(actCommand, 'the CLI has an `act` command');

  for (const action of PAGE_ACTIONS) {
    assert.ok(
      actCommand.summary.includes(action),
      `the CLI act summary does not mention "${action}"`,
    );
  }

  // Named explicitly rather than left to the loop: `drag` is the verb that was
  // missing, so a reviewer sees it fail by name rather than inferring it from
  // an iteration count.
  assert.ok(actCommand.summary.includes('drag'), 'the CLI act summary does not mention "drag"');
});

/**
 * The `--action` flag summary and the command summary agree with each other.
 *
 * Both derive from `PAGE_ACTIONS`, and the defect this whole row came from was
 * two surfaces disagreeing on one screen. This asserts the property a reader
 * actually experiences — that `broker --help` and `broker act --help` tell the
 * same story — rather than only that each independently contains some words.
 */
test('the CLI act summary and its --action flag summary name the same verbs', () => {
  const actCommand = OPERATION_COMMANDS.find(
    (command) => command.words.length === 1 && command.words[0] === 'act',
  );
  assert.ok(actCommand, 'the CLI has an `act` command');

  const actionFlag = actCommand.options?.find((option) => option.flag.startsWith('--action'));
  assert.ok(actionFlag, 'the `act` command documents its --action flag');

  for (const action of PAGE_ACTIONS) {
    assert.equal(
      actCommand.summary.includes(action),
      actionFlag.summary.includes(action),
      `"${action}" appears on one of the two act help surfaces but not the other`,
    );
  }
});
