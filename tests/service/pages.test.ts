import assert from 'node:assert/strict';
import test from 'node:test';

import { PAGE_ACTIONS, READ_ARTIFACTS, type CookieSummary } from '../../src/browser/driver.ts';
import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import {
  COOKIE_SUMMARY_FIELDS,
  MAX_EXPRESSION_BYTES,
  MAX_FORM_FIELDS,
  MAX_INLINE_RESULT_BYTES,
  MAX_VIEWPORT_SIDE,
  MEDIA_PREFERENCE_NAMES,
  PageRefusal,
  artifactIsLiveQuery,
  disposeEvaluationResult,
  isPageAction,
  resolveReadArtifacts,
  shapeCookieSummary,
  validateAction,
  validateExpression,
  validateNavigationTarget,
} from '../../src/service/pages.ts';

const RECORD = { endpoint: 'http://127.0.0.1:9000', browserUuid: 'fake-regular-uuid' };

/** Assert a call refused, and refused under a particular §7 rule. */
function refusesWith(rule: string, fn: () => unknown): PageRefusal {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PageRefusal, `expected a refusal, got ${String(caught)}`);
  assert.equal(caught.rule, rule);
  return caught;
}

/* ─────────────────── navigate (#22) ─────────────────── */

test('ordinary web traffic and a blank page are what a navigation may target', () => {
  assert.equal(validateNavigationTarget('https://example.com/a'), 'https://example.com/a');
  assert.equal(validateNavigationTarget('http://example.com'), 'http://example.com');
  assert.equal(validateNavigationTarget('about:blank'), 'about:blank');
});

test('a local-file address is refused, because it would make a lease a read of this machine', () => {
  const refusal = refusesWith('navigate.scheme_allowed', () =>
    validateNavigationTarget('file:///etc/passwd'),
  );
  assert.equal(refusal.detail.scheme, 'file:');
  // §3.7 refuses this one by name in the sentence, so a caller reading the
  // refusal learns why rather than only that.
  assert.match(refusal.message, /local-file/);
});

test('every scheme that is not ordinary web traffic is refused, not merely the named one', () => {
  // The rule is an allowlist. A denylist would permit every scheme nobody
  // thought of, and browsers carry a great many. Deleting a scheme from
  // ALLOWED_SCHEMES makes one of the two allowed cases above fail; widening
  // it to include any of these makes one of these fail.
  for (const target of [
    'ftp://example.com',
    'data:text/html,<p>x</p>',
    'javascript:void(0)',
    'chrome://settings',
    'view-source:https://example.com',
    'ws://example.com',
  ]) {
    refusesWith('navigate.scheme_allowed', () => validateNavigationTarget(target));
  }
});

test('an address that is not an address at all is refused', () => {
  refusesWith('navigate.scheme_allowed', () => validateNavigationTarget('not an address'));
  refusesWith('navigate.scheme_allowed', () => validateNavigationTarget(''));
  refusesWith('navigate.scheme_allowed', () => validateNavigationTarget(undefined));
  refusesWith('navigate.scheme_allowed', () => validateNavigationTarget(42));
});

/* ─────────────────── the refusal that lists every action (#22) ─────────────────── */

test('an unknown action is refused with every action named, one by one', () => {
  const refusal = refusesWith('act.action_known', () =>
    validateAction({ action: 'teleport', ref: 'e1' }),
  );

  // **This is the assertion that must fail when an action is deleted from the
  // list.** Each verb is named individually rather than compared against
  // PAGE_ACTIONS — a test asserting `message includes every member of
  // PAGE_ACTIONS` is true for any list, including one with an entry removed,
  // which is the shape that has already been caught here by mutation.
  for (const named of [
    'click',
    'type',
    'fill',
    'press',
    'select',
    'hover',
    'check',
    'scroll',
    'resize',
    'emulate',
    'dialog',
    'fill_form',
    'drag',
  ]) {
    assert.match(
      refusal.message,
      new RegExp(`\\b${named}\\b`),
      `the refusal must name "${named}" — the discoverability cost of folding these into one tool is paid back here or not at all`,
    );
  }

  // And the count, so an action added to the union without being added to the
  // list it is refused from is caught too.
  assert.equal(PAGE_ACTIONS.length, 13);
  assert.deepEqual(refusal.detail.actions, [...PAGE_ACTIONS]);
});

test('the refusal names the action it did not recognise, so a typo is visible', () => {
  const refusal = refusesWith('act.action_known', () => validateAction({ action: 'clickk' }));
  assert.match(refusal.message, /clickk/);
});

test('the foreground is not reachable by naming it, because there is no such action', () => {
  // `foreground.never_moved` (§7.3) is a build rule and not this list's job.
  // What is this list's job is that the verb cannot be reached by asking.
  for (const attempt of ['bringToFront', 'front', 'focus', 'activate', 'raise']) {
    refusesWith('act.action_known', () => validateAction({ action: attempt, ref: 'e1' }));
  }
});

test('an action is recognised only if it is on the list', () => {
  assert.equal(isPageAction('click'), true);
  assert.equal(isPageAction('resize'), true);
  assert.equal(isPageAction('bringToFront'), false);
  assert.equal(isPageAction(undefined), false);
});

/* ─────────────────── the ordinary page verbs (#22) ─────────────────── */

test('the verbs that address an element require one', () => {
  for (const action of ['click', 'hover', 'check']) {
    assert.deepEqual(validateAction({ action, ref: 'e7' }), { action, ref: 'e7' });
    refusesWith('act.ref_required', () => validateAction({ action }));
    refusesWith('act.ref_required', () => validateAction({ action, ref: '   ' }));
  }
});

test('the verbs that need a value are refused without one', () => {
  for (const action of ['type', 'fill', 'select']) {
    assert.deepEqual(validateAction({ action, ref: 'e7', value: 'x' }), {
      action,
      ref: 'e7',
      value: 'x',
    });
    refusesWith('act.value_required', () => validateAction({ action, ref: 'e7' }));
    refusesWith('act.ref_required', () => validateAction({ action, value: 'x' }));
  }
});

test('an empty value is a value — an empty field is a thing a caller means to set', () => {
  // Clearing a field is `fill` with an empty string, so a check written as
  // truthiness rather than as a type would refuse the ordinary way to empty
  // an input.
  assert.deepEqual(validateAction({ action: 'fill', ref: 'e1', value: '' }), {
    action: 'fill',
    ref: 'e1',
    value: '',
  });
});

test('a press addresses an element optionally, and needs a key either way', () => {
  assert.deepEqual(validateAction({ action: 'press', value: 'Enter' }), {
    action: 'press',
    value: 'Enter',
  });
  assert.deepEqual(validateAction({ action: 'press', ref: 'e1', value: 'Enter' }), {
    action: 'press',
    ref: 'e1',
    value: 'Enter',
  });
  refusesWith('act.value_required', () => validateAction({ action: 'press' }));
});

test('a scroll addresses an element optionally and needs nothing else', () => {
  assert.deepEqual(validateAction({ action: 'scroll' }), { action: 'scroll' });
  assert.deepEqual(validateAction({ action: 'scroll', ref: 'e1' }), {
    action: 'scroll',
    ref: 'e1',
  });
});

/* ─────────────────── resize (#61) ─────────────────── */

test('a resize carries two integers, which is what a viewport is', () => {
  assert.deepEqual(validateAction({ action: 'resize', viewport: { width: 375, height: 812 } }), {
    action: 'resize',
    viewport: { width: 375, height: 812 },
  });
});

test('a resize does not address an element, because a viewport is not in the page', () => {
  // The measured gap this row closes: a viewport is a property of the
  // browsing context, so no expression can set it and no element reference
  // means anything to it.
  const validated = validateAction({
    action: 'resize',
    viewport: { width: 1280, height: 720 },
    ref: 'e1',
  });
  assert.equal('ref' in validated, false);
});

test('a viewport side must be a whole positive number within the bound', () => {
  for (const viewport of [
    { width: 0, height: 812 },
    { width: 375, height: 0 },
    { width: -375, height: 812 },
    { width: 375.5, height: 812 },
    { width: '375', height: 812 },
    { width: 375 },
    { height: 812 },
  ]) {
    refusesWith('act.viewport_bounded', () => validateAction({ action: 'resize', viewport }));
  }
  refusesWith('act.viewport_bounded', () => validateAction({ action: 'resize' }));
});

test('a viewport past the bound is refused, and the bound itself is allowed', () => {
  assert.ok(
    validateAction({
      action: 'resize',
      viewport: { width: MAX_VIEWPORT_SIDE, height: MAX_VIEWPORT_SIDE },
    }),
  );
  const refusal = refusesWith('act.viewport_bounded', () =>
    validateAction({
      action: 'resize',
      viewport: { width: MAX_VIEWPORT_SIDE + 1, height: 720 },
    }),
  );
  assert.equal(refusal.detail.maximum, MAX_VIEWPORT_SIDE);
});

test('a resize reaches the driver as a viewport, not as a string it must re-parse', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const tab = await session.openTab();
  driver.clearCalls();

  await session.act(
    tab,
    validateAction({ action: 'resize', viewport: { width: 375, height: 812 } }),
  );

  const call = driver.callsOf('act')[0];
  assert.equal(call?.detail?.action, 'resize');
  // The two numbers arrive as two numbers. If the seam carried "375x812" in a
  // generic value field, this assertion would be about a string and every
  // driver would own a parser.
  assert.deepEqual(call?.detail?.viewport, { width: 375, height: 812 });
});

/* ─────────────────── emulate (#62) ─────────────────── */

test('each media preference is settable on its own', () => {
  assert.deepEqual(validateAction({ action: 'emulate', preferences: { colourScheme: 'dark' } }), {
    action: 'emulate',
    preferences: { colourScheme: 'dark' },
  });
  assert.deepEqual(
    validateAction({ action: 'emulate', preferences: { reducedMotion: 'reduce' } }),
    {
      action: 'emulate',
      preferences: { reducedMotion: 'reduce' },
    },
  );
  assert.deepEqual(
    validateAction({ action: 'emulate', preferences: { forcedColours: 'active' } }),
    { action: 'emulate', preferences: { forcedColours: 'active' } },
  );
});

test('the three preferences §3.8 names are all present, by name', () => {
  // Named individually rather than counted: deleting one from the table
  // must fail something.
  assert.deepEqual([...MEDIA_PREFERENCE_NAMES].sort(), [
    'colourScheme',
    'forcedColours',
    'reducedMotion',
  ]);
});

test('several preferences in one call are kept, not collapsed to the last one', () => {
  assert.deepEqual(
    validateAction({
      action: 'emulate',
      preferences: { colourScheme: 'dark', reducedMotion: 'reduce', forcedColours: 'none' },
    }),
    {
      action: 'emulate',
      preferences: { colourScheme: 'dark', reducedMotion: 'reduce', forcedColours: 'none' },
    },
  );
});

test('an emulate naming no preference is refused, because it would mean nothing', () => {
  refusesWith('act.emulate_preference_named', () =>
    validateAction({ action: 'emulate', preferences: {} }),
  );
  refusesWith('act.emulate_preference_named', () => validateAction({ action: 'emulate' }));
  // An unrecognised key is not a preference either — silently ignoring it
  // would report success for a call that changed nothing.
  refusesWith('act.emulate_preference_named', () =>
    validateAction({ action: 'emulate', preferences: { colorScheme: 'dark' } }),
  );
});

test('a preference outside its declared values is refused, and the values are named', () => {
  const refusal = refusesWith('act.emulate_preference_named', () =>
    validateAction({ action: 'emulate', preferences: { colourScheme: 'sepia' } }),
  );
  assert.deepEqual(refusal.detail.allowed, ['light', 'dark', 'no-preference']);

  refusesWith('act.emulate_preference_named', () =>
    validateAction({ action: 'emulate', preferences: { reducedMotion: 'always' } }),
  );
  refusesWith('act.emulate_preference_named', () =>
    validateAction({ action: 'emulate', preferences: { forcedColours: 'high' } }),
  );
});

test('the no-preference state is a value, not the absence of one', () => {
  // A caller returning a tab to the unset state is doing something, and a
  // check treating 'no-preference' as "nothing was named" would refuse it.
  assert.deepEqual(
    validateAction({ action: 'emulate', preferences: { colourScheme: 'no-preference' } }),
    { action: 'emulate', preferences: { colourScheme: 'no-preference' } },
  );
});

/* ─────────────────── dialog (#63) ─────────────────── */

test('a dialog is answered or dismissed', () => {
  assert.deepEqual(validateAction({ action: 'dialog', response: { accept: true } }), {
    action: 'dialog',
    response: { accept: true },
  });
  assert.deepEqual(validateAction({ action: 'dialog', response: { accept: false } }), {
    action: 'dialog',
    response: { accept: false },
  });
});

test('a prompt is answered by accepting with text', () => {
  assert.deepEqual(
    validateAction({ action: 'dialog', response: { accept: true, promptText: 'a name' } }),
    { action: 'dialog', response: { accept: true, promptText: 'a name' } },
  );
});

test('text with a dismissal is refused, because it describes two intentions at once', () => {
  refusesWith('act.dialog_answer_named', () =>
    validateAction({ action: 'dialog', response: { accept: false, promptText: 'a name' } }),
  );
});

test('a dialog answer that says nothing is refused', () => {
  refusesWith('act.dialog_answer_named', () => validateAction({ action: 'dialog' }));
  refusesWith('act.dialog_answer_named', () => validateAction({ action: 'dialog', response: {} }));
  refusesWith('act.dialog_answer_named', () =>
    validateAction({ action: 'dialog', response: { accept: 'yes' } }),
  );
});

/* ─────────────────── batch fill and drag (#64) ─────────────────── */

test('a batch fill carries an array of field and value pairs in one call', () => {
  assert.deepEqual(
    validateAction({
      action: 'fill_form',
      fields: [
        { ref: 'e1', value: 'a' },
        { ref: 'e2', value: 'b' },
      ],
    }),
    {
      action: 'fill_form',
      fields: [
        { ref: 'e1', value: 'a' },
        { ref: 'e2', value: 'b' },
      ],
    },
  );
});

test('a batch fill with no fields is refused, and one past the bound is too', () => {
  refusesWith('act.form_fields_bounded', () => validateAction({ action: 'fill_form', fields: [] }));
  refusesWith('act.form_fields_bounded', () => validateAction({ action: 'fill_form' }));

  const atBound = Array.from({ length: MAX_FORM_FIELDS }, (_, i) => ({
    ref: `e${String(i)}`,
    value: 'x',
  }));
  assert.ok(validateAction({ action: 'fill_form', fields: atBound }));

  const refusal = refusesWith('act.form_fields_bounded', () =>
    validateAction({ action: 'fill_form', fields: [...atBound, { ref: 'e-extra', value: 'x' }] }),
  );
  assert.equal(refusal.detail.maximum, MAX_FORM_FIELDS);
});

test('a malformed field inside a batch fill is refused, and the refusal says which one', () => {
  const refusal = refusesWith('act.ref_required', () =>
    validateAction({
      action: 'fill_form',
      fields: [{ ref: 'e1', value: 'a' }, { value: 'b' }],
    }),
  );
  assert.equal(refusal.detail.index, 1);

  refusesWith('act.value_required', () =>
    validateAction({ action: 'fill_form', fields: [{ ref: 'e1' }] }),
  );
});

test('a drag is element to element, and needs both ends', () => {
  assert.deepEqual(validateAction({ action: 'drag', ref: 'e1', targetRef: 'e2' }), {
    action: 'drag',
    ref: 'e1',
    targetRef: 'e2',
  });
  refusesWith('act.ref_required', () => validateAction({ action: 'drag', ref: 'e1' }));
  refusesWith('act.ref_required', () => validateAction({ action: 'drag', targetRef: 'e2' }));
});

test('a drag onto itself is refused, because it describes no movement', () => {
  refusesWith('act.drag_ends_differ', () =>
    validateAction({ action: 'drag', ref: 'e1', targetRef: 'e1' }),
  );
});

/* ─────────────────── read (#23) ─────────────────── */

test('a read returns the snapshot by default, and nothing else', () => {
  assert.deepEqual(resolveReadArtifacts(undefined), ['snapshot']);
  assert.deepEqual(resolveReadArtifacts(null), ['snapshot']);
  assert.deepEqual(resolveReadArtifacts([]), ['snapshot']);
});

test('console, network and cookies each come only when asked for, by name', () => {
  // Named one at a time. A loop over READ_ARTIFACTS asserting each appears
  // when requested would stay green with an artefact deleted from the list.
  assert.deepEqual(resolveReadArtifacts(['console']), ['snapshot', 'console']);
  assert.deepEqual(resolveReadArtifacts(['network']), ['snapshot', 'network']);
  assert.deepEqual(resolveReadArtifacts(['cookies']), ['snapshot', 'cookies']);
  assert.deepEqual(resolveReadArtifacts(['console', 'network', 'cookies']), [
    'snapshot',
    'console',
    'network',
    'cookies',
  ]);
});

test('the snapshot is added even when a caller asks only for something else', () => {
  // Every element reference `browser_act` takes comes from the snapshot, so a
  // read handing back a console log and no snapshot leaves the tab unusable.
  assert.ok(resolveReadArtifacts(['console']).includes('snapshot'));
});

test('the order is the declared one, so two callers asking the same get the same', () => {
  assert.deepEqual(resolveReadArtifacts(['cookies', 'console']), [
    'snapshot',
    'console',
    'cookies',
  ]);
});

test('an artefact that is not one of the four is refused, with all four named', () => {
  const refusal = refusesWith('read.artifact_known', () => resolveReadArtifacts(['storage']));
  for (const named of ['snapshot', 'console', 'network', 'cookies']) {
    assert.match(refusal.message, new RegExp(`\\b${named}\\b`));
  }
  assert.equal(READ_ARTIFACTS.length, 4);
  refusesWith('read.artifact_known', () => resolveReadArtifacts('console'));
});

test('only cookies cost anything to ask for, and that is why the default is cheap', () => {
  // Console and network are accumulated by the browsing context from the
  // moment it exists, so the default filters what is written to disk rather
  // than what is collected — the cost of not asking is zero. Cookies are a
  // live query. Asserted per artefact by name.
  assert.equal(artifactIsLiveQuery('console'), false);
  assert.equal(artifactIsLiveQuery('network'), false);
  assert.equal(artifactIsLiveQuery('snapshot'), false);
  assert.equal(artifactIsLiveQuery('cookies'), true);
});

/* ─────────────────── cookie values are never returned (#23) ─────────────────── */

test('a cookie summary carries names, domains, paths, expiries and flags — and no value', () => {
  const cookie: CookieSummary = {
    name: 'session',
    domain: 'example.com',
    path: '/',
    expires: null,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  };

  const shaped = shapeCookieSummary(cookie);

  // Every surviving field, named. Deleting one from `shapeCookieSummary`
  // fails here.
  assert.equal(shaped.name, 'session');
  assert.equal(shaped.domain, 'example.com');
  assert.equal(shaped.path, '/');
  assert.equal(shaped.expires, null);
  assert.equal(shaped.httpOnly, true);
  assert.equal(shaped.secure, true);
  assert.equal(shaped.sameSite, 'Lax');

  // And the whole of them: an eighth key appearing here is the moment a value
  // would arrive, whatever it were called.
  assert.deepEqual(Object.keys(shaped).sort(), [...COOKIE_SUMMARY_FIELDS].sort());
});

test('a value attached to a cookie does not survive being shaped, whatever it is called', () => {
  // The driver seam has no value field, so a driver has to drop it. This is
  // the second lock: an object that acquired one anyway — from a library type
  // with a value on it, which every one of them has — fails closed.
  const smuggled = {
    name: 'session',
    domain: 'example.com',
    path: '/',
    expires: null,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    // Three spellings, because the field a library uses is not this
    // repository's choice.
    value: 'a-secret-nobody-should-see',
    cookieValue: 'a-secret-nobody-should-see',
    v: 'a-secret-nobody-should-see',
  } as CookieSummary;

  const shaped = shapeCookieSummary(smuggled);
  const serialised = JSON.stringify(shaped);

  // **The assertion that must fail if the redaction is dropped.** Rewriting
  // `shapeCookieSummary` to spread its input — the single most natural
  // "simplification" of that function — makes this fail.
  assert.equal(
    serialised.includes('a-secret-nobody-should-see'),
    false,
    'a cookie value must appear nowhere in what is written',
  );
  assert.equal('value' in shaped, false);
  assert.equal(Object.keys(shaped).length, COOKIE_SUMMARY_FIELDS.length);

  // The summary is still a summary: the redaction has not eaten the fields
  // that are supposed to survive, which is the half an over-reaching
  // redaction breaks.
  assert.equal(shaped.name, 'session');
  assert.equal(shaped.httpOnly, true);
});

test('the cookies a driver hands over have no value field to begin with', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const tab = await session.openTab();

  const cookies = await session.cookies(tab);

  assert.ok(cookies.length >= 2, 'an empty list would satisfy a redaction test trivially');
  for (const cookie of cookies) {
    assert.equal('value' in cookie, false);
    assert.deepEqual(Object.keys(cookie).sort(), [...COOKIE_SUMMARY_FIELDS].sort());
  }
});

/* ─────────────────── evaluate (#24) ─────────────────── */

test('an ordinary measurement expression is allowed, contents unexamined', () => {
  // No allowlist and no fixed vocabulary: a restricted one would have to be
  // guessed in advance, and every measurement nobody guessed becomes a
  // screenshot instead.
  const expression = 'getComputedStyle(document.body).fontSize';
  assert.equal(validateExpression(expression), expression);
});

test('the obvious storage accessors are not refused, because that would be theatre', () => {
  // §3.10 settles this: a lease on the signed-in browser already grants the
  // ability to act as the signed-in user, so an expression reading a page's
  // own storage does something strictly smaller than driving the page. A rule
  // that only stops the honest is worse than no rule, because it is believed.
  for (const expression of [
    'localStorage.getItem("token")',
    'document.cookie',
    'sessionStorage.length',
  ]) {
    assert.equal(validateExpression(expression), expression);
  }
});

test('an expression past its size cap is refused, because a program is not an expression', () => {
  const atCap = 'a'.repeat(MAX_EXPRESSION_BYTES);
  assert.equal(validateExpression(atCap), atCap);

  const refusal = refusesWith('evaluate.expression_bounded', () =>
    validateExpression('a'.repeat(MAX_EXPRESSION_BYTES + 1)),
  );
  assert.equal(refusal.detail.maximumBytes, MAX_EXPRESSION_BYTES);
});

test('the cap is measured in bytes, not characters', () => {
  // A multi-byte character counted as one would let an expression through at
  // several times the intended size.
  const multibyte = '€'.repeat(MAX_EXPRESSION_BYTES);
  assert.ok(multibyte.length <= MAX_EXPRESSION_BYTES);
  refusesWith('evaluate.expression_bounded', () => validateExpression(multibyte));
});

test('an absent or empty expression is refused', () => {
  refusesWith('evaluate.expression_bounded', () => validateExpression(undefined));
  refusesWith('evaluate.expression_bounded', () => validateExpression(''));
  refusesWith('evaluate.expression_bounded', () => validateExpression('   '));
  refusesWith('evaluate.expression_bounded', () => validateExpression({ toString: () => 'x' }));
});

test('a small result comes back inline', () => {
  const disposition = disposeEvaluationResult({ fontSize: '16px', lineHeight: '24px' });
  assert.equal(disposition.spill, false);
  assert.equal(disposition.serialised, '{"fontSize":"16px","lineHeight":"24px"}');
  assert.equal(disposition.bytes, disposition.serialised.length);
});

test('a large result spills to a path instead of entering the conversation', () => {
  const large = { data: 'x'.repeat(MAX_INLINE_RESULT_BYTES) };
  const disposition = disposeEvaluationResult(large);
  assert.equal(disposition.spill, true);
  assert.ok(disposition.bytes > MAX_INLINE_RESULT_BYTES);
});

test('the inline cap is a boundary, and a result exactly at it stays inline', () => {
  // `JSON.stringify` of a string adds two quotes, so this lands the
  // serialisation exactly on the cap.
  const exact = 'x'.repeat(MAX_INLINE_RESULT_BYTES - 2);
  const disposition = disposeEvaluationResult(exact);
  assert.equal(disposition.bytes, MAX_INLINE_RESULT_BYTES);
  assert.equal(disposition.spill, false);

  const oneMore = disposeEvaluationResult('x'.repeat(MAX_INLINE_RESULT_BYTES - 1));
  assert.equal(oneMore.bytes, MAX_INLINE_RESULT_BYTES + 1);
  assert.equal(oneMore.spill, true);
});

test("the spill decision is measured on the serialised bytes, not on the value's shape", () => {
  // One enormous string is a handful of "items"; a long list of small numbers
  // is thousands. Only one of them is large, and a check against a length
  // would get both backwards.
  const oneBigString = disposeEvaluationResult('y'.repeat(MAX_INLINE_RESULT_BYTES + 100));
  const manySmallNumbers = disposeEvaluationResult(Array.from({ length: 500 }, (_, i) => i));

  assert.equal(oneBigString.spill, true);
  assert.equal(manySmallNumbers.spill, false);
});

test('an expression that evaluated to nothing is an ordinary answer, not a failure', () => {
  assert.deepEqual(disposeEvaluationResult(undefined), {
    serialised: 'null',
    bytes: 4,
    spill: false,
  });
  assert.equal(disposeEvaluationResult(null).serialised, 'null');
});

test('a value with no plain representation is refused rather than silently becoming nothing', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  refusesWith('evaluate.result_serialisable', () => disposeEvaluationResult(cyclic));

  // A function serialises to `undefined` without throwing, so it arrives by a
  // different route and must be refused too — a caller told "it returned
  // nothing" debugs the wrong thing.
  refusesWith('evaluate.result_serialisable', () =>
    disposeEvaluationResult(() => 'not plain data'),
  );
});

/* ─────────────────── the capability that is deliberately absent (#24) ─────────────────── */

test('there is no argument on this path that selects where an expression runs', async () => {
  // Evaluation happens inside the page, sandboxed by the browser. The
  // capability that runs code in the automation server's own process is not
  // implemented, and sampling found real usage of it enumerating other
  // callers' tabs, reading local credential files and making authenticated
  // outbound requests. It is refused by absence: there is nothing to widen.
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const tab = await session.openTab();
  driver.clearCalls();

  await session.evaluate(tab, validateExpression('document.title'));

  const call = driver.callsOf('evaluate')[0];
  assert.deepEqual(Object.keys(call?.detail ?? {}), ['expression']);
  // The call is addressed to one tab, and there is no second place it could
  // have gone.
  assert.deepEqual(call?.tab, tab);
});

test("an evaluation names one tab, so it cannot reach another caller's", async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  const mine = await session.openTab();
  const theirs = await session.openTab();
  driver.clearCalls();

  await session.evaluate(mine, validateExpression('1 + 1'));

  const calls = driver.callsOf('evaluate');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.tab, mine);
  assert.notDeepEqual(calls[0]?.tab, theirs);
});

/* ─────────────────── nothing here reaches a browser ─────────────────── */

test('a refused action never reaches the driver', async () => {
  const driver = new FakeBrowserDriver();
  const session = await driver.attach('regular', RECORD);
  await session.openTab();
  driver.clearCalls();

  // The rule this repository is built around: a rejection test asserts the
  // physical side-effect, not just the response. Validation is refused before
  // anything is asked of a browser, so the log is empty.
  assert.throws(() => validateAction({ action: 'teleport' }));
  assert.throws(() => validateNavigationTarget('file:///etc/passwd'));
  assert.throws(() => validateExpression('a'.repeat(MAX_EXPRESSION_BYTES + 1)));

  assert.deepEqual(driver.calls, []);
});
