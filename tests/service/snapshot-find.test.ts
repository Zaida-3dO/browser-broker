import assert from 'node:assert/strict';
import test from 'node:test';

import { filterSnapshot } from '../../src/browser/real.ts';
import { PageRefusal, resolveSnapshotFilter } from '../../src/service/pages.ts';

/**
 * `browser_read {what:"snapshot", find:"…"}` — narrowing the accessibility
 * tree without losing the part that says what a node IS.
 *
 * ── Why this is a unit test and not a browser one ───────────────────────
 *
 * The neighbouring `tests/browser/` suites drive a real browser because the
 * thing under test is whether this repository *observes* something the
 * browser does — a listener that was never attached is a defect no fake can
 * exhibit. That argument does not apply here. `ariaSnapshot` returns a
 * `string`, and everything this feature does happens to that string after it
 * arrives: the filter is a pure function of text in and text out.
 *
 * So the browser would contribute nothing but flakiness and a skip on every
 * machine without one — and a skip is exactly what this must not have,
 * because the ancestry behaviour below is the whole design and CI has no
 * browser. `#writeSnapshot` passing the filter through is asserted separately
 * against the fake driver's call log (`read-find-reaches-driver.test.ts`),
 * which is the seam that actually needed watching.
 *
 * ── The mutations these kill ────────────────────────────────────────────
 *
 * - Dropping the ancestor walk and emitting only matching lines — the
 *   ancestry tests fail, and they are the ones that matter, because that
 *   mutation is the *obvious* implementation of this feature.
 * - Emitting an ancestor once per match instead of once — the shared-parent
 *   test fails on a duplicated line.
 * - Emitting matches before ancestors, or in match order — the ordering test
 *   fails, because the result would no longer read as a tree.
 * - Adding the `i` flag to a compiled pattern — the case-sensitivity test
 *   fails, which is the difference between `/[A-Z]/` meaning what it says and
 *   quietly meaning something else.
 * - Dropping the case fold on the literal path — the literal test fails.
 * - Returning `''` when nothing matched — the empty-result test fails on a
 *   file that would otherwise read as a broken write.
 */

/**
 * A fragment shaped like what `ariaSnapshot({mode:'ai'})` actually emits:
 * one node per line, nesting in leading spaces, `[ref=eN]` minted inline.
 *
 * The two `listitem` lines under DIFFERENT lists are the whole point of the
 * fixture — they are indistinguishable from one another on their own line,
 * and the parent is the only thing that tells them apart.
 */
const TREE = [
  '- generic [ref=e1]:',
  '  - navigation [ref=e2]:',
  '    - list "Primary" [ref=e3]:',
  '      - listitem [ref=e4]:',
  '        - link "Home" [ref=e5]',
  '      - listitem [ref=e6]:',
  '        - link "Pricing" [ref=e7]',
  '  - main [ref=e8]:',
  '    - button "Checkout" [ref=e9]',
  '  - contentinfo [ref=e10]:',
  '    - list "Footer" [ref=e11]:',
  '      - listitem [ref=e12]:',
  '        - link "Privacy" [ref=e13]',
].join('\n');

/** The filter a caller's spelling resolves to, for brevity below. */
function find(spelling: string) {
  const resolved = resolveSnapshotFilter(spelling);
  assert.ok(resolved !== undefined, `"${spelling}" resolved to nothing`);
  return resolved;
}

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

/* ─────────────────── the ancestry property ─────────────────── */

/**
 * THE HEADLINE: a match arrives with the lines that enclose it.
 *
 * A bare grep passes no part of this, and a bare grep is the implementation
 * anybody would write first.
 */
test('a matching line is emitted with its ancestors, which are what identify it', () => {
  const result = filterSnapshot(TREE, find('Privacy'));
  const lines = result.split('\n');

  // The match itself.
  assert.ok(
    lines.some((line) => line.includes('link "Privacy"')),
    `the matching line is missing entirely:\n${result}`,
  );
  // And the chain that says WHERE it is — the footer list rather than the
  // primary navigation, which is the distinction a caller acts on.
  assert.ok(
    lines.some((line) => line.includes('list "Footer"')),
    `the parent list is missing, so the match is unidentifiable:\n${result}`,
  );
  assert.ok(
    lines.some((line) => line.includes('contentinfo')),
    `an ancestor above the immediate parent was dropped:\n${result}`,
  );
  assert.ok(
    lines.some((line) => line.includes('generic [ref=e1]')),
    `the root was dropped:\n${result}`,
  );

  // The control that makes the above mean something: the OTHER list and its
  // items are gone. A filter that kept everything would pass every assertion
  // so far.
  assert.ok(
    !result.includes('list "Primary"'),
    `an unrelated branch survived the filter:\n${result}`,
  );
  assert.ok(!result.includes('Checkout'), `an unrelated branch survived the filter:\n${result}`);
});

test('two matches under one parent print that parent once, not twice', () => {
  // Both listitems under "Primary" match, and they share every ancestor.
  const result = filterSnapshot(TREE, find('/link "(Home|Pricing)"/'));

  const primaryLines = result.split('\n').filter((line) => line.includes('list "Primary"'));
  assert.equal(
    primaryLines.length,
    1,
    `the shared parent was printed ${String(primaryLines.length)} times, which is not a tree:\n${result}`,
  );
  // Both matches are present, so the deduplication did not eat one of them.
  assert.ok(result.includes('link "Home"'));
  assert.ok(result.includes('link "Pricing"'));
});

test('the result is in the order the tree was, so it still reads as a tree', () => {
  const result = filterSnapshot(TREE, find('/link "(Home|Privacy)"/'));
  const lines = result.split('\n');

  const at = (needle: string): number => {
    const index = lines.findIndex((line) => line.includes(needle));
    assert.ok(index !== -1, `${needle} is missing from:\n${result}`);
    return index;
  };

  // An ancestor precedes its descendant...
  assert.ok(at('generic [ref=e1]') < at('navigation'), `root came after its child:\n${result}`);
  assert.ok(at('list "Primary"') < at('link "Home"'), `parent came after its child:\n${result}`);
  // ...and the two branches stay in document order rather than match order.
  assert.ok(
    at('link "Home"') < at('link "Privacy"'),
    `the branches are out of document order:\n${result}`,
  );
});

test('the filtered snapshot keeps the refs, which are the only reason to read one', () => {
  const result = filterSnapshot(TREE, find('Checkout'));
  // §3.9: every reference `browser_act` takes comes from the snapshot. A
  // filter that stripped or renumbered them would hand back something
  // readable and unusable.
  assert.match(result, /\[ref=e9\]/);
});

/* ─────────────────── matching, and its two spellings ─────────────────── */

test('plain text matches anywhere in a line and ignores case', () => {
  const result = filterSnapshot(TREE, find('checkout'));
  assert.ok(
    result.includes('button "Checkout"'),
    `a lower-case search did not find a capitalised label:\n${result}`,
  );
});

test('a pattern is honoured exactly, and is NOT quietly case-insensitive', () => {
  // The mutation this kills is adding `i` to the compiled expression for
  // consistency with the literal path. `/checkout/` must then find nothing,
  // because a caller who wrote a regular expression asked for what they wrote.
  const result = filterSnapshot(TREE, find('/checkout/'));
  assert.ok(
    !result.includes('button "Checkout"'),
    `a pattern matched case-insensitively, so /[A-Z]/ would not mean what it says:\n${result}`,
  );
  // The same pattern with the right case does find it, so the miss above is
  // about case and not about patterns being broken outright.
  assert.ok(filterSnapshot(TREE, find('/Checkout/')).includes('button "Checkout"'));
});

test('a pattern can express what a substring cannot', () => {
  // Anchoring on indentation — every node at exactly one level of nesting.
  const result = filterSnapshot(TREE, find('/^  - (main|navigation)/'));
  assert.ok(result.includes('main [ref=e8]'), `the anchored pattern found nothing:\n${result}`);
  assert.ok(result.includes('navigation [ref=e2]'));
  // A node deeper than the anchor allows is not swept in as a match. It may
  // still appear as an ancestor of one, so this checks a node that is
  // neither: a leaf under main.
  assert.ok(!result.includes('button "Checkout"'), `the anchor was not honoured:\n${result}`);
});

test('a single slash is text, not an empty pattern matching every line', () => {
  // A caller searching for a URL fragment types "/" inside ordinary text, and
  // reading a lone "/" as a pattern would match the entire tree.
  const resolved = find('/');
  assert.equal(resolved.kind, 'text');
});

/* ─────────────────── nothing matched ─────────────────── */

test('a snapshot nothing matched says so, rather than being an empty file', () => {
  const result = filterSnapshot(TREE, find('nothing on this page says this'));

  // The failure this prevents: a zero-byte artefact is indistinguishable from
  // a write that failed, and the caller's reasonable conclusion — "the read
  // broke" — is wrong.
  assert.notEqual(result.trim(), '');
  assert.match(result, /matched/i);
  // It quotes back what was searched for, so a mangled or shell-eaten `find`
  // is visible rather than silent.
  assert.ok(
    result.includes('nothing on this page says this'),
    `the miss does not say what was searched for:\n${result}`,
  );
  // And it says the way out.
  assert.match(result, /without find/i);
});

test('a miss on a pattern quotes the pattern back in its own spelling', () => {
  const result = filterSnapshot(TREE, find('/zzz-no-such-node/'));
  assert.ok(
    result.includes('/zzz-no-such-node/'),
    `the miss does not name the pattern that was run:\n${result}`,
  );
});

/* ─────────────────── the refusals ─────────────────── */

test('no find at all is not a refusal — it is the ordinary read', () => {
  assert.equal(resolveSnapshotFilter(undefined), undefined);
  assert.equal(resolveSnapshotFilter(null), undefined);
});

test('a find that is not a string is refused, naming the argument and the shape', () => {
  for (const bad of [42, true, ['Checkout'], { text: 'Checkout' }]) {
    const refusal = refusesWith('read.find_shape', () => resolveSnapshotFilter(bad));
    // The house rule: a refusal names the argument and shows the shape.
    assert.match(refusal.message, /\bfind\b/);
    assert.match(refusal.message, /find: "Checkout"/);
  }
});

test('an empty or blank find is refused rather than silently matching everything', () => {
  refusesWith('read.find_shape', () => resolveSnapshotFilter(''));
  refusesWith('read.find_shape', () => resolveSnapshotFilter('   '));
});

test('an over-long find is refused, and the message says the limit and why', () => {
  const refusal = refusesWith('read.find_shape', () => resolveSnapshotFilter('x'.repeat(201)));
  assert.match(refusal.message, /201/);
  assert.match(refusal.message, /200/);
  // The reason, not just the number: it is matched against one line.
  assert.match(refusal.message, /line/i);
  // And the bound is not reachable by ordinary use.
  assert.ok(resolveSnapshotFilter('x'.repeat(200)) !== undefined);
});

test('a malformed pattern is REFUSED, not thrown as an internal error', () => {
  // The defect this closes: `new RegExp('[')` throws a SyntaxError written
  // for a JavaScript author. Let out, an agent reads "the broker is broken"
  // from what is actually its own typo.
  const refusal = refusesWith('read.find_shape', () => resolveSnapshotFilter('/[/'));
  assert.ok(!(refusal instanceof SyntaxError));
  // The engine's own words survive, because they name the character to fix...
  assert.match(refusal.message, /regular expression/i);
  // ...and the way out is stated, which the engine's message never does.
  assert.match(refusal.message, /slashes/i);
});

test('"//" is refused rather than compiling to a pattern matching every line', () => {
  const refusal = refusesWith('read.find_shape', () => resolveSnapshotFilter('//'));
  assert.match(refusal.message, /every line/i);
});

test('a well-formed pattern resolves to a pattern, and text to text', () => {
  const pattern = resolveSnapshotFilter('/^\\s*- button/');
  assert.equal(pattern?.kind, 'pattern');
  assert.ok(pattern?.kind === 'pattern' && pattern.pattern.source === '^\\s*- button');

  const text = resolveSnapshotFilter('Checkout');
  assert.equal(text?.kind, 'text');
  assert.ok(text?.kind === 'text' && text.text === 'Checkout');
});

/* ─────────────────── edges in the tree itself ─────────────────── */

test('a blank line does not orphan everything after it', () => {
  // A blank line has zero indentation. Measured as depth rather than skipped,
  // it would pop the whole ancestor stack and every later match would lose
  // its parents — a mutation that is invisible on a tree with no blank lines.
  const withBlank = [
    '- generic [ref=e1]:',
    '  - list "Footer" [ref=e2]:',
    '',
    '    - link "Privacy" [ref=e3]',
  ].join('\n');
  const result = filterSnapshot(withBlank, find('Privacy'));
  assert.ok(
    result.includes('list "Footer"'),
    `a blank line above the match cost it its ancestry:\n${result}`,
  );
});

test('a match at the root has no ancestors and is returned alone', () => {
  const result = filterSnapshot(TREE, find('generic [ref=e1]'));
  assert.equal(result, '- generic [ref=e1]:');
});
