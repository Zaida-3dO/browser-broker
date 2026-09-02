import assert from 'node:assert/strict';
import test from 'node:test';

import { makeServiceSubject } from '../../src/adapter/conformance/service-subject.ts';
import { parseArguments } from '../../src/cli/adapter.ts';
import type { BrokerService } from '../../src/adapter/service-seam.ts';

/**
 * **Arguments a caller can actually type reach the service that needs them.**
 *
 * ── The shape of the bug this file exists for ───────────────────────────
 *
 * Three operations were refused for arguments the caller had supplied
 * correctly, because nothing on the way in could carry them:
 *
 * - `act resize` wants `viewport: { width, height }` — an object of two
 *   integers. `parseArguments` produces flat strings and only flat strings,
 *   so **no argument a command-line caller could type would ever parse**. A
 *   field session tried `--value 390x844`, `390,844`, `"390 844"`, the JSON
 *   object and `--width 390 --height 844`, and got the identical refusal to
 *   all five.
 * - `act emulate` wants `preferences: { … }` and had the same problem, behind
 *   a refusal that is otherwise a model of its kind — it names its three
 *   options the way `claim.browser_known` names the browsers, so a caller
 *   read good advice and could not act on it.
 * - `claim` coerced an omitted `--browser` to `''`, which
 *   `claim.browser_known` then correctly refused as a browser named `""` —
 *   turning a documented default into a refusal on a new caller's first call.
 *
 * With the tool surface returning empty results at the same time, the command
 * line was the only working client, so "unreachable from the command line"
 * meant unreachable. Mobile-breakpoint and dark-theme review were impossible.
 *
 * ── Why these go through the real service and the real parser ───────────
 *
 * A test that called the assembly helpers directly would assert that a
 * private function builds an object, which is not the claim. **The claim is
 * that a caller who types this gets that**, so every case below starts at
 * `parseArguments` — the actual command-line parser, on the actual argument
 * vector a person types — and ends at the real service's own outcome. That is
 * the whole path the field session walked, and nothing in between is stubbed.
 *
 * The browser driver is faked, as everywhere else in this suite: every rule
 * under test is enforced inside the arbitration transaction, before a browser
 * is reached. No browser is launched, so none can leak.
 */

/** A lease on a fresh service, and the argv-driven `act` its key unlocks. */
async function withLease(
  body: (
    act: (argv: readonly string[]) => Promise<Awaited<ReturnType<BrokerService['perform']>>>,
    // What the driver was actually told. A test that can only see the
    // outcome can say a call was not refused; it cannot say what the call
    // did, and for an answer whose two values are opposites that is the
    // whole of the behaviour.
    driverCalls: () => readonly { name: string; detail?: unknown }[],
  ) => Promise<void>,
): Promise<void> {
  const subject = await makeServiceSubject();
  try {
    const claimed = await subject.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: parseArguments([
        '--session-id',
        'argument-assembly',
        '--purpose',
        'Proving the arguments a caller types reach the operation that needs them.',
      ]),
    });
    assert.equal(claimed.outcome, 'accepted', 'the lease this test needs was not granted');
    const key = String((claimed as { value: Record<string, unknown> }).value['key']);

    await body(
      (argv) =>
        subject.service.perform({
          operation: 'act',
          adapter: 'cli',
          arguments: parseArguments([...argv, '--lease-key', key]),
        }),
      () => subject.driverCalls(),
    );
  } finally {
    await subject.dispose?.();
  }
}

test('CLAIM WITH NO --browser USES THE DOCUMENTED DEFAULT, rather than asking for a browser named ""', async () => {
  // The tool description promises: "Omit this and you get the first
  // signed-in browser, which is what most work wants." It is the first thing
  // a new caller does.
  //
  // The single change that breaks this test: coercing the absent argument
  // back to `''` in the claim branch of the bridge.
  const subject = await makeServiceSubject();
  try {
    const claimed = await subject.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: parseArguments([
        '--session-id',
        'no-browser-named',
        '--purpose',
        'Claiming without naming a browser, which the description says is the ordinary case.',
      ]),
    });

    assert.equal(
      claimed.outcome,
      'accepted',
      `omitting --browser was refused: ${JSON.stringify(claimed)}`,
    );

    // And it resolved to a real browser rather than to nothing — an
    // acceptance that granted a lease against `undefined` would satisfy the
    // assertion above while leaving the caller just as stuck.
    const granted = (claimed as { value: Record<string, unknown> }).value;
    assert.equal(typeof granted['browserId'], 'string');
    assert.ok(String(granted['browserId']).length > 0, 'the grant named no browser');
  } finally {
    await subject.dispose?.();
  }
});

test('a browser that genuinely does not exist is still refused, and named', async () => {
  // The negative control for the test above. Without it, "omitting the
  // browser works" would also pass against a bridge that stopped checking the
  // browser at all.
  const subject = await makeServiceSubject();
  try {
    const claimed = await subject.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: parseArguments([
        '--session-id',
        'unknown-browser',
        '--browser',
        'chartreuse',
        '--purpose',
        'Naming a browser this service does not have, which must still be refused.',
      ]),
    });

    assert.equal(claimed.outcome, 'refused');
    assert.equal((claimed as { rule: string }).rule, 'claim.browser_known');
  } finally {
    await subject.dispose?.();
  }
});

test('ACT RESIZE IS REACHABLE FROM THE COMMAND LINE — every form the field session tried', async () => {
  // Each of these was refused identically before, and each *is* a width and a
  // height in pixels. The list is the reporter's own, verbatim, minus the JSON
  // object — which a shell cannot produce as anything but a string and which
  // the tool surface can already send as a real object.
  //
  // The single change that breaks this test: returning `argument(args,
  // 'viewport')` alone from `viewportFrom`, which is what it did before.
  await withLease(async (act) => {
    for (const argv of [
      ['--action', 'resize', '--width', '390', '--height', '844'],
      ['--action', 'resize', '--value', '390x844'],
      ['--action', 'resize', '--value', '390,844'],
      ['--action', 'resize', '--value', '390 844'],
    ]) {
      const outcome = await act(argv);
      assert.equal(
        outcome.outcome,
        'accepted',
        `${argv.join(' ')} was refused: ${JSON.stringify(outcome)}`,
      );
    }
  });
});

test('a resize that names no usable size is still refused — AND THE MESSAGE NOW SAYS HOW TO WRITE ONE', async () => {
  // The negative control, and the message assertion the original report asked
  // for. A refusal that is right and leaves the caller guessing is this
  // project's most expensive defect class: the session that hit it tried five
  // spellings and stopped, and the mobile breakpoint went unreviewed.
  await withLease(async (act) => {
    const outcome = await act(['--action', 'resize', '--value', 'nonsense']);

    assert.equal(outcome.outcome, 'refused');
    assert.equal((outcome as { rule: string }).rule, 'act.viewport_bounded');

    // The syntax, not only the semantics. Naming the accepted form is what
    // ends the guessing in one call.
    const message = (outcome as { message: string }).message;
    assert.match(message, /--width/u, 'the refusal still does not say how to write a viewport');
    assert.match(message, /390x844/u, 'the refusal gives no concrete example');
  });
});

test('ACT EMULATE IS REACHABLE FROM THE COMMAND LINE, by the name its own refusal advertises', async () => {
  // The refusal names `colourScheme`, so `--colour-scheme` is what a caller
  // reading it types. That it was then refused identically is the part that
  // made a good message useless.
  //
  // The single change that breaks this test: returning `argument(args,
  // 'preferences')` alone from `preferencesFrom`.
  await withLease(async (act) => {
    for (const argv of [
      ['--action', 'emulate', '--colour-scheme', 'dark'],
      ['--action', 'emulate', '--reduced-motion', 'reduce'],
      ['--action', 'emulate', '--forced-colours', 'active'],
      // Both spellings of "colour", because a caller who types the one this
      // service does not use should get a dark theme rather than a refusal
      // that reads as though they named nothing.
      ['--action', 'emulate', '--color-scheme', 'dark'],
      // Several at once, since each preference is set independently.
      ['--action', 'emulate', '--colour-scheme', 'dark', '--reduced-motion', 'reduce'],
    ]) {
      const outcome = await act(argv);
      assert.equal(
        outcome.outcome,
        'accepted',
        `${argv.join(' ')} was refused: ${JSON.stringify(outcome)}`,
      );
    }
  });
});

test('an emulate value outside the table is refused BY NAME — the bridge coerces, it does not validate', async () => {
  // This is the assertion that keeps the fix honest. The bridge assembles the
  // object and decides nothing about it: which values are legal stays the
  // operation's decision, on the ledger. A bridge that validated here would
  // produce a refusal from the wrong place and a rule name the caller cannot
  // look up.
  await withLease(async (act) => {
    const outcome = await act(['--action', 'emulate', '--colour-scheme', 'chartreuse']);

    assert.equal(outcome.outcome, 'refused');
    assert.equal((outcome as { rule: string }).rule, 'act.emulate_preference_named');
    // And it names what would have worked.
    assert.match((outcome as { message: string }).message, /light, dark, no-preference/u);
  });
});

test('an emulate naming no preference at all is refused, and the message now carries an example', async () => {
  await withLease(async (act) => {
    const outcome = await act(['--action', 'emulate']);

    assert.equal(outcome.outcome, 'refused');
    assert.equal((outcome as { rule: string }).rule, 'act.emulate_preference_named');
    assert.match((outcome as { message: string }).message, /colourScheme/u);
    assert.match(
      (outcome as { message: string }).message,
      /--colour-scheme/u,
      'the refusal names its options but still not how to write one',
    );
  });
});

test('the verbs that always worked still work — the assembly did not capture arguments it should not', async () => {
  // `scroll` takes an optional reference and no value; `press` takes a value
  // that is a key name. Neither is object-shaped, so neither was ever broken —
  // and a change that started routing `--value` into a viewport would break
  // them. This is the regression that would otherwise be silent.
  await withLease(async (act) => {
    const scrolled = await act(['--action', 'scroll']);
    assert.equal(scrolled.outcome, 'accepted', JSON.stringify(scrolled));

    const pressed = await act(['--action', 'press', '--value', 'Enter']);
    assert.equal(pressed.outcome, 'accepted', JSON.stringify(pressed));
  });
});

test('ACT DIALOG IS REACHABLE, AND SAYS THE ANSWER THE CALLER MEANT', async () => {
  // Left unreachable by the pull request that fixed resize and emulate, and
  // recorded there as "known and deliberately not fixed here". The operation
  // wants `response: { accept: boolean }`; a command line produces strings,
  // so --response accept, --value accept and --accept true were all refused
  // identically with a message describing what the caller had just said.
  //
  // **Asserted on the driver's call log, not on the outcome.** An earlier
  // version of this test checked only that the call was not refused, and a
  // mutation inverting the dismiss branch — so `--value dismiss` ACCEPTS —
  // passed all sixteen cases in this file and the whole suite besides. The
  // two answers are opposites, and a test that cannot tell them apart is
  // defending nothing: an agent answering "Delete these rows?" would have
  // clicked OK and been told it succeeded.
  await withLease(async (act, driverCalls) => {
    const answers: readonly (readonly [readonly string[], boolean])[] = [
      [['--action', 'dialog', '--accept'], true],
      [['--action', 'dialog', '--value', 'accept'], true],
      [['--action', 'dialog', '--response', 'accept'], true],
      [['--action', 'dialog', '--dismiss'], false],
      [['--action', 'dialog', '--value', 'dismiss'], false],
      [['--action', 'dialog', '--response', 'dismiss'], false],
    ];

    for (const [argv, expected] of answers) {
      const before = driverCalls().length;
      const outcome = await act(argv);
      assert.equal(outcome.outcome, 'accepted', `${argv.join(' ')}: ${JSON.stringify(outcome)}`);

      const call = driverCalls()
        .slice(before)
        .find((entry) => entry.name === 'act');
      assert.ok(call !== undefined, `${argv.join(' ')} never reached the driver`);
      const detail = call.detail as { response?: { accept?: unknown } };
      assert.equal(
        detail.response?.accept,
        expected,
        `${argv.join(' ')} answered the dialog the wrong way round`,
      );
    }
  });
});

test('a dialog accepted WITH PROMPT TEXT carries the text to the driver', async () => {
  await withLease(async (act, driverCalls) => {
    const before = driverCalls().length;
    const outcome = await act([
      '--action',
      'dialog',
      '--accept',
      '--prompt-text',
      'typed before accepting',
    ]);

    assert.equal(outcome.outcome, 'accepted', JSON.stringify(outcome));
    const call = driverCalls()
      .slice(before)
      .find((entry) => entry.name === 'act');
    assert.deepEqual((call?.detail as { response?: unknown }).response, {
      accept: true,
      promptText: 'typed before accepting',
    });
  });
});

test('a dialog answer that names neither acceptance nor dismissal is still refused', async () => {
  // The negative control. Without it, "dialog is reachable" would also pass
  // against a bridge that fabricated an answer whenever one was missing —
  // which is the worst possible fix, since it would decide on the caller's
  // behalf whether to accept something they never saw.
  await withLease(async (act) => {
    const outcome = await act(['--action', 'dialog', '--value', 'perhaps']);

    assert.equal(outcome.outcome, 'refused');
    assert.equal((outcome as { rule: string }).rule, 'act.dialog_answer_named');
  });
});

test('prompt text with a dismissal is still refused — the operation decides, not the bridge', async () => {
  // Assembly is coercion only. This rule lives in the operation, on the
  // ledger, and the bridge must not start enforcing a second copy of it:
  // two places deciding the same thing is how they come to disagree.
  await withLease(async (act) => {
    const outcome = await act([
      '--action',
      'dialog',
      '--dismiss',
      '--prompt-text',
      'text that cannot accompany a dismissal',
    ]);

    assert.equal(outcome.outcome, 'refused');
    assert.equal((outcome as { rule: string }).rule, 'act.dialog_answer_named');
  });
});

test('ACT FILL_FORM IS REACHABLE FROM THE COMMAND LINE — one --field per field', async () => {
  // The other half of the same gap: the operation wants an array of objects
  // and a command line has only strings, so the batch verb measured at 78
  // calls across 35 sessions could not be called at all from the only client
  // that was working at the time.
  await withLease(async (act) => {
    const outcome = await act([
      '--action',
      'fill_form',
      '--field',
      'e1=alice',
      '--field',
      'e2=bob@example.com',
    ]);

    assert.notEqual(
      (outcome as { rule?: string }).rule,
      'act.form_fields_bounded',
      `a batch of two fields did not arrive as fields: ${JSON.stringify(outcome)}`,
    );
  });
});

test('a field value may contain an equals sign — only the first one separates', async () => {
  // A password, a base64 fragment or a query string all carry one. Splitting
  // on every = would silently truncate the value, which is the kind of defect
  // that surfaces as "the form was filled but the login failed".
  await withLease(async (act) => {
    const outcome = await act(['--action', 'fill_form', '--field', 'e1=a=b=c']);

    assert.equal(outcome.outcome, 'accepted', JSON.stringify(outcome));
  });
});

test('splitting on the LAST separator would name a different field — it splits on the first', async () => {
  // The equals-sign case above proves a value carrying one is accepted; it
  // cannot prove *where* the split happened, because an accepted batch fill
  // echoes no fields back. This can: a field whose text contains a separator
  // is paired with one that has none, and the operation refuses a field with
  // no value **by index**. Splitting anywhere but the first separator moves
  // which index is bad, so the index in the refusal is the evidence.
  await withLease(async (act) => {
    const outcome = await act(['--action', 'fill_form', '--field', 'e1=a=b', '--field', 'e2']);

    assert.equal(outcome.outcome, 'refused');
    assert.equal((outcome as { rule: string }).rule, 'act.value_required');
    // Field 1, never field 0: the first field split correctly and is fine.
    assert.match(
      (outcome as { message: string }).message,
      /Field 1/u,
      'the wrong field was blamed, so the pair did not split where it should',
    );
  });
});

test('a batch fill with no fields is still refused', async () => {
  // The negative control for the two above.
  await withLease(async (act) => {
    const outcome = await act(['--action', 'fill_form']);

    assert.equal(outcome.outcome, 'refused');
    assert.equal((outcome as { rule: string }).rule, 'act.form_fields_bounded');
  });
});

test('A REPEATED --field ACCUMULATES; every other repeated option still keeps the last word', () => {
  // The parser assigned unconditionally, so a repeated option kept only its
  // last occurrence. For `--value` that is right. For `--field` it was
  // silent data loss of exactly the kind a batch verb cannot tolerate:
  // `--field a=1 --field b=2` filled ONE field and reported success, which
  // is worse than the refusal it replaced, because a refusal is visible.
  //
  // Asserted on the parser directly rather than through an outcome, because
  // an accepted batch fill echoes no fields back — there is nothing
  // downstream that can show how many arrived.
  assert.deepEqual(parseArguments(['--field', 'e1=a', '--field', 'e2=b'])['field'], [
    'e1=a',
    'e2=b',
  ]);

  // One occurrence is still a list, so the shape does not depend on how many
  // the caller happened to pass.
  assert.deepEqual(parseArguments(['--field', 'e1=a'])['field'], ['e1=a']);

  // The narrowness is the point: making every option accumulate would turn a
  // twice-typed --value into a shape no operation expects.
  assert.equal(parseArguments(['--value', 'first', '--value', 'second'])['value'], 'second');
});
