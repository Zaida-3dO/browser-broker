/**
 * The self-test for the argument-refusal check.
 *
 * **What a green run here means, and what it does not.** Green means the
 * check can fail: run against a build whose purpose guard has been removed —
 * which is exactly the build that shipped for thirty pull requests — it
 * reports failures rather than passing. Green does **not** mean the real
 * executables refuse anything; that claim is made by running the check
 * itself, which `npm run check` does.
 *
 * The distinction is the reason this file exists, and it is the same one
 * `check-operations.test.mjs` makes at greater length: a gate is the one kind
 * of code whose happy path proves nothing. A check that has only ever run
 * against a correct tree has never run against the thing it exists to catch,
 * and *"it passes"* is equally consistent with *"it cannot fail"*.
 *
 * That is not hypothetical for this particular check. Its first draft could
 * not have failed at all — the obvious implementation is to scan the sources
 * for `SqliteError`, and **this repository never writes that string**: the
 * driver throws it. Such a check would have reported green against the
 * defective build forever. The seeded violation is what rules that out, by
 * removing the guard and requiring the check to notice.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runSelfTest } from '../scripts/check-argument-refusals.mjs';

describe('the argument-refusal check detects the defect it exists to detect', () => {
  it('fails against a build with the purpose guard removed', async () => {
    // Seeded against a **copy** of the sources rather than by damaging the
    // working tree: a test that edited the application to prove a gate fires
    // would have to put it back, and a failure midway through would leave the
    // repository broken.
    const outcome = await runSelfTest();
    assert.equal(outcome.ok, true, `the seeded violation did not fire: ${outcome.detail}`);
    assert.match(
      outcome.detail,
      /assertions failed against the broken build/u,
      'the self-test should report how many assertions caught the seeded defect',
    );
  });
});
