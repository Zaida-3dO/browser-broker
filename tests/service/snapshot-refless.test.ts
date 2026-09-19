import assert from 'node:assert/strict';
import test from 'node:test';

import { annotateRefless, filterSnapshot } from '../../src/browser/real.ts';
import { resolveSnapshotFilter } from '../../src/service/pages.ts';

/**
 * A snapshot that carries no reference says so — `annotateRefless`.
 *
 * ── The failure being pinned ────────────────────────────────────────────
 *
 * A caller read a page, got a long tree back, could not find in it a control
 * they could plainly see rendered, and concluded their `find` patterns were
 * wrong. They were not necessarily wrong; the file had nothing to act with
 * either way. Twenty minutes went on rewriting patterns and the rest of a
 * five-hour session went through `browser_evaluate` instead of `browser_act`.
 *
 * ── Why this is a unit test ─────────────────────────────────────────────
 *
 * Same argument as `snapshot-find.test.ts`: `ariaSnapshot` hands over a
 * `string`, and everything this does happens to that string afterwards. It is
 * a pure function of text in and text out, so a browser would add flakiness
 * and a skip on every machine without one — and CI has no browser, which
 * would make a browser-bound test of this vacuous rather than merely slow.
 *
 * ── The mutations these kill ────────────────────────────────────────────
 *
 * - Dropping the `[ref=` early return — the byte-identical test fails, and it
 *   is the one that matters most, because that mutation puts a hint on every
 *   ordinary read.
 * - Gating on role names instead of `[ref=` — the refless-but-role-rich test
 *   fails, which is the whole design argument.
 * - Removing the near-empty floor — the `about:blank` test fails on a hint
 *   that tells a caller nothing about an empty document.
 * - Letting the floor count blank lines — the whitespace-document test fails.
 * - Dropping the no-match passthrough — the stacking test fails on a file
 *   carrying two notices about one miss.
 * - Writing a cause into the message ("the page is broken", "not exposing
 *   a11y") — the tone test fails. That assertion is the deliverable, not a
 *   nicety: the hint exists to replace misleading evidence, and a hint that
 *   guesses a cause is the same defect wearing different words.
 */

/** A tree shaped like real `mode:'ai'` output, with references. */
const TREE = [
  '- generic [ref=e1]:',
  '  - navigation [ref=e2]:',
  '    - link "Home" [ref=e3]',
  '  - main [ref=e4]:',
  '    - button "Select a branch" [ref=e5]',
].join('\n');

/**
 * The same shape with every reference removed, and — deliberately — **rich in
 * interactive role names**. This is the fixture that separates the gate this
 * ships from the tempting one: a role-name gate sees `button` and `link` here
 * and stays quiet, leaving the caller with exactly the unusable file that
 * started all this.
 */
const REFLESS = [
  '- generic:',
  '  - navigation:',
  '    - link "Home"',
  '  - main:',
  '    - button "Select a branch"',
].join('\n');

/** The filter a caller's spelling resolves to, for brevity below. */
function find(spelling: string) {
  const resolved = resolveSnapshotFilter(spelling);
  assert.ok(resolved !== undefined, `"${spelling}" resolved to nothing`);
  return resolved;
}

/* ─────────────────── the ordinary read is untouched ─────────────────── */

/**
 * THE HEADLINE GUARD: a snapshot with references comes back byte for byte.
 *
 * Every read that works today goes through this function, so the cost of
 * getting it wrong is paid on all of them rather than on the rare one this
 * feature is for.
 */
test('a snapshot carrying references is returned byte-identical', () => {
  assert.equal(annotateRefless(TREE), TREE);
});

test('a single reference anywhere in the tree is enough to stay silent', () => {
  // The floor is one: a caller with one handle has something to act on, and
  // the hint speaks only about having none.
  const oneRef = ['- generic:', '  - main:', '    - button "Only" [ref=e9]'].join('\n');
  assert.equal(annotateRefless(oneRef), oneRef);
});

/* ─────────────────── the hint itself ─────────────────── */

test('a tree with no reference anywhere says so, naming the line count', () => {
  const result = annotateRefless(REFLESS);

  assert.notEqual(result, REFLESS);
  // The tree it describes is still there, unchanged, at the front of the file.
  assert.ok(result.startsWith(REFLESS), `the hint displaced the tree:\n${result}`);
  // It names the count, which is what tells a caller the read produced
  // something rather than nothing.
  assert.ok(result.includes('5 lines'), `the hint does not name the line count:\n${result}`);
  // And it names the absence of the thing `browser_act` consumes.
  assert.match(result, /\[ref=/);
});

/**
 * The design argument, as an executable assertion.
 *
 * `REFLESS` contains the words `button`, `link`, `navigation` and `main`. A
 * gate written against role names stays silent on it. The file is
 * nevertheless unusable for acting, which is the caller's actual problem.
 */
test('a tree rich in interactive roles but minting no reference still gets the hint', () => {
  assert.ok(REFLESS.includes('button "Select a branch"'));
  assert.ok(REFLESS.includes('link "Home"'));
  assert.notEqual(annotateRefless(REFLESS), REFLESS);
});

/* ─────────────────── the tone, which is the deliverable ─────────────────── */

/**
 * THE ASSERTION THIS FEATURE EXISTS FOR.
 *
 * The hint replaces misleading evidence. A hint that named a cause it cannot
 * observe would be misleading evidence with better manners — and the causes
 * genuinely are indistinguishable from a string of text: a shell-mangled
 * `find`, a narrowed read, a page mid-build and a reference-free rendering
 * all arrive here looking identical.
 */
test('the hint asserts no cause', () => {
  const result = annotateRefless(REFLESS);

  for (const forbidden of [
    'broken',
    'degenerate',
    'not exposing',
    'failed',
    'invalid',
    'malformed',
    'unsupported',
    'inaccessible',
    'at fault',
    'should have',
  ]) {
    assert.ok(
      !result.toLowerCase().includes(forbidden),
      `the hint blames a cause it cannot observe — it says "${forbidden}":\n${result}`,
    );
  }
});

test('the hint says it is describing the snapshot rather than diagnosing it', () => {
  const result = annotateRefless(REFLESS);
  // The explicit disclaimer, in the same spirit as the no-match message's
  // "which is not the same as the read having failed".
  assert.match(result, /not why/i);
});

/* ─────────────────── it is useful next ─────────────────── */

test('the hint points at the route that needs no reference', () => {
  const result = annotateRefless(REFLESS);

  // The two halves of the focus path: the verb that needs no reference, and
  // the marker that says where focus currently is.
  assert.match(result, /press/i);
  assert.ok(result.includes('[active]'), `the hint omits the focus marker:\n${result}`);
});

test('the hint names find as a thing to drop, since a narrowed read looks like this', () => {
  assert.match(annotateRefless(REFLESS), /without it|without find/i);
});

/* ─────────────────── the empty page ─────────────────── */

/**
 * `about:blank` has no references for a reason nobody needs telling.
 *
 * The hint's value is that its presence means something. Firing it on an
 * empty document spends that, and tells a caller who can already read the
 * whole two-line file at a glance something they can see.
 */
test('a near-empty document gets no hint', () => {
  for (const empty of ['', '- generic', '- generic:\n  - paragraph']) {
    assert.equal(
      annotateRefless(empty),
      empty,
      `a ${String(empty.split('\n').length)}-line document was given a hint it cannot act on`,
    );
  }
});

test('a document of blank lines counts as empty rather than clearing the floor', () => {
  // Whitespace is not content. Counting raw lines here would let three
  // newlines buy a hint about a document with nothing in it.
  const whitespace = '\n\n\n\n\n';
  assert.equal(annotateRefless(whitespace), whitespace);
});

test('the floor is a floor, not a blanket exemption for short trees', () => {
  // Three populated lines is the smallest thing that does get a hint, which
  // is what makes the test above an assertion about emptiness rather than
  // about length in general.
  const three = ['- generic:', '  - main:', '    - button "Go"'].join('\n');
  assert.notEqual(annotateRefless(three), three);
});

/* ─────────────────── it composes with find ─────────────────── */

/**
 * A `find` that matched nothing already explains itself.
 *
 * Its message is prose, carries no `[ref=`, and tells the caller to read
 * again without `find`. Appending the hint would produce a file saying that
 * twice, under two headings, about one miss.
 */
test('the no-match message does not also collect a no-reference hint', () => {
  const missed = filterSnapshot(TREE, find('nothing on this page says this'));

  // Precondition: it is the no-match message, and it has no references in it.
  assert.match(missed, /matched/i);
  assert.ok(!missed.includes('[ref='));

  assert.equal(annotateRefless(missed), missed);
});

/**
 * But a `find` that DID match, onto lines carrying no reference, is a real
 * instance of the problem — the caller has a file of matches and nothing to
 * act on. Computing the hint against the unfiltered tree would miss exactly
 * this case, because the full tree has references.
 */
test('a find that matched only reference-free lines still gets the hint', () => {
  const mixed = [
    '- generic [ref=e1]:',
    '  - main [ref=e2]:',
    '    - paragraph: Choose a branch to continue',
  ].join('\n');

  // The full tree has references, so a hint computed before filtering is silent.
  assert.equal(annotateRefless(mixed), mixed);

  // The narrowed file does not. `find` keeps the match plus its ancestors,
  // and those ancestors carry refs — so narrow to something whose ancestry is
  // also reference-free to get the case that matters.
  const narrowed = filterSnapshot(REFLESS, find('Select a branch'));
  assert.ok(!narrowed.includes('[ref='));
  assert.notEqual(annotateRefless(narrowed), narrowed);
});
