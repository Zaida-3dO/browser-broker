import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_CHOICE_GUIDANCE } from '../../src/browser/driver.ts';
import { TOOLS_BY_NAME } from '../../src/tool/tools.ts';
import { claimInput, withBroker } from '../helpers/broker.ts';

/**
 * Browser-choice guidance, in the two places §3.2 requires it (row #66).
 *
 * ── What this suite is guarding against ─────────────────────────────────
 *
 * **Measured: 25 sessions seeded authentication into an isolated browser
 * while the signed-in browser sat unused.** Nothing was broken — the choice
 * simply was not written where the caller making it would read. So the
 * failure this suite prevents is not a crash but a silent misuse, and the
 * only observable form of "the guidance is present" is the text itself.
 *
 * ── Why these assertions name phrases rather than matching the whole string ──
 *
 * `MILESTONES.md` records a hollow shape to avoid here: **a whole-file
 * substring satisfied by prose that merely mentions the value**, and its
 * cousin, **asserting against an imported constant so the mutation that
 * empties it empties the assertion**. Comparing the description to
 * {@link BROWSER_CHOICE_GUIDANCE} would be exactly the second one — emptying
 * the constant would empty both sides and stay green.
 *
 * So the assertions below name the **substance** in literal text written out
 * here: the default, what each kind is for, and the cookie-jar caveat. A
 * mutation that empties or guts the constant fails them, because these
 * literals are not derived from it.
 *
 * ── Why the default makes this suite matter more, not less ──────────────
 *
 * `browser` is optional (`DECISIONS.md` §13i), so a caller that states
 * nothing never reaches the refusal — which removes one of the two surfaces
 * this guidance was placed on for that caller. The description text is then
 * the only place it learns any of this, and the default sends more traffic
 * into one shared cookie jar, which is exactly what the caveat is about.
 */

const claimTool = TOOLS_BY_NAME.get('browser_claim');

test('the browser argument description carries the DEFAULT and what each kind is for', () => {
  const browser = claimTool?.arguments.find((argument) => argument.name === 'browser');
  assert.ok(browser, 'browser_claim has a browser argument');
  const description = browser.description;

  // **The default, which is the thing a caller most needs to know**
  // (`DECISIONS.md` §13i): omitting the argument is not an error, and what it
  // gets is the signed-in browser. Written as literals rather than read from
  // the constant under test.
  assert.match(description, /omit/i);
  assert.match(description, /signed[- ]in/i);

  // The other two forms: a kind word, and a configured name.
  assert.match(description, /private/);
  assert.match(description, /fresh[- ]visitor|fresh visitor/i);
  assert.match(description, /name/i);

  // **Optional, and that is the reversal made mechanical.** A required
  // argument here would mean the default is unreachable through this surface,
  // whatever the description says about it.
  assert.equal(browser.required, false);
});

test('THE COOKIE-JAR CAVEAT IS IN THE SAME TEXT, not left to a refusal', () => {
  // §1.2 requires the caveat "stated in the same breath" as the guidance.
  // Guidance that sent callers to the signed-in browser without it would
  // trade one silent failure for another — a test that mysteriously sees the
  // wrong account.
  const browser = claimTool?.arguments.find((argument) => argument.name === 'browser');
  assert.ok(browser);

  assert.match(browser.description, /cookie jar/i);
  // The consequence, not merely the fact: callers there are not isolated from
  // each other.
  assert.match(browser.description, /not from each other|not isolated from each other/i);
  // And what to do about it. **The remedy changed with the decision and the
  // caveat did not**: two identities at once is what a second configured
  // browser is for, rather than something declared unsupported.
  assert.match(browser.description, /two identities/i);
  assert.match(browser.description, /two differently-named browsers|two browsers/i);
});

test('the guidance stays SHORT — surface area is a standing tax, paid every turn', () => {
  // §3.1: every description sits in a connected session's context on every
  // turn. There is no correct number here, so this is a ceiling against the
  // description quietly becoming an essay rather than a claim that some
  // length is right. It is roughly twice the current text.
  const browser = claimTool?.arguments.find((argument) => argument.name === 'browser');
  assert.ok(browser);
  assert.ok(
    browser.description.length < 900,
    `the browser argument description is ${String(browser.description.length)} characters; it is read on every turn and must not become an essay`,
  );
});

test('THE CLAIM REFUSAL CARRIES THE GUIDANCE TOO — a refused caller is re-making this choice', async () => {
  await withBroker(async ({ broker }) => {
    let message = '';
    try {
      await broker.claim(claimInput({ browser: 'chrome' }));
      assert.fail('an unknown browser must be refused');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // It still says what went wrong and what the configured names are.
    assert.match(message, /chrome/);
    assert.match(message, /regular/);
    assert.match(message, /private/);

    // And it says how to choose, including the caveat — the substance, named
    // here rather than read from the constant.
    assert.match(message, /signed[- ]in/i);
    assert.match(message, /cookie jar/i);
  });
});

test('the guidance is ONE text used in both places, so the two cannot drift', async () => {
  // The anti-duplication property itself. Two hand-written copies drift, and
  // the copy that goes stale is the one nobody is looking at.
  //
  // This is the one assertion that legitimately reads the constant, because
  // the property under test *is* "both sites use this string" — and it cannot
  // pass vacuously, since the tests above independently pin the substance the
  // constant must contain.
  const browser = claimTool?.arguments.find((argument) => argument.name === 'browser');
  assert.ok(browser);
  assert.ok(
    browser.description.includes(BROWSER_CHOICE_GUIDANCE),
    'the tool description embeds the shared guidance',
  );

  await withBroker(async ({ broker }) => {
    try {
      await broker.claim(claimInput({ browser: 'chrome' }));
      assert.fail('an unknown browser must be refused');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(
        message.includes(BROWSER_CHOICE_GUIDANCE),
        'the refusal embeds the same shared guidance, so the two cannot drift apart',
      );
    }
  });
});

test('the shared guidance is not empty, so no assertion above can pass vacuously', () => {
  // The negative control `MILESTONES.md` asks for by name: an assertion
  // evaluated over an empty set passes forever and silently.
  assert.ok(BROWSER_CHOICE_GUIDANCE.length > 100);
});
