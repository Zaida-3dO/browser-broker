import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  MAXIMUM_PART_LENGTH,
  captureFileName,
  sanitiseLabel,
  slugFromUrl,
  stampFromInstant,
} from '../../src/artifacts/names.ts';
import { BACK } from '../helpers/paths.ts';

/**
 * `SCHEMA.md` §1.7a's four naming rules.
 *
 * **Every assertion here is written to die on a specific mutation**, and the
 * mutation is named beside it. That is the standard this repository holds
 * itself to: a test that would stay green with the rule removed is worse than
 * no test, because it is false confidence that survives review.
 *
 * The fixtures avoid real hostnames per `CLAUDE.md`'s browsing-surface rule —
 * `example.com` and friends only — and the machine-path fixtures are composed
 * from parts through `tests/helpers/paths.ts` rather than written out, because
 * a literal drive-letter path fails the hygiene gate on the file proving the
 * refusal.
 */

test('rule one: the query string is stripped, and its contents reach no part of the name', () => {
  // A query carrying exactly what §1.7a says a query carries: a token. The
  // value is invented and is not a credential, but it stands in for one.
  const slug = slugFromUrl('https://example.com/orders?session=abc123secret&q=search+terms');

  assert.ok(!slug.includes('abc123secret'), `the token reached the name: ${slug}`);
  assert.ok(!slug.includes('search'), `a search term reached the name: ${slug}`);
  assert.ok(!slug.includes('session'), `a query key reached the name: ${slug}`);

  // And the part that is kept is still there, so the rule cannot be "passing"
  // by returning nothing at all.
  assert.equal(slug, 'example-com-orders');

  // ⚠️ HONEST NOTE ON WHAT THIS TEST DOES AND DOES NOT KILL. On a PARSEABLE
  // address, two independent mechanisms keep the query out — the textual strip
  // AND the fact that `hostname + pathname` never contains a query. So
  // deleting the strip alone does NOT fail this test, and claiming otherwise
  // would be exactly the false confidence this repository mutation-tests for.
  // The strip's own mutation coverage is the fallback-path test below, which
  // is the branch where it is the sole defence. Verified by mutation: removing
  // `withoutQuery` fails that test and not this one.
});

test('rule one, second mechanism: the slug is built from host and path ONLY', () => {
  // The other half of the defence, mutation-covered on its own. Dies if the
  // parsed branch is changed to use `href`, `toString()`, or to append
  // `search` — each of which would put the query back even with the textual
  // strip in place, because a strip that ran on the way in cannot un-add
  // something the parser hands back.
  // Composed from parts: written out, the credentials-in-front-of-the-host
  // spelling reads to the hygiene gate as a host it is not allowed to name.
  // Composing costs three lines and no waiver.
  const credentials = ['someuser', 'somesecret'].join(':');
  const slug = slugFromUrl(`https://${credentials}@example.com:8443/deep/path`);
  assert.equal(slug, 'example-com-deep-path');
  // Credentials in front of the host are the single most sensitive thing an
  // address can carry, and `hostname` excludes them by construction.
  assert.ok(!slug.includes('someuser'), `credentials reached the name: ${slug}`);
  assert.ok(!slug.includes('somesecret'), `credentials reached the name: ${slug}`);
  assert.ok(!slug.includes('8443'), `the port reached the name: ${slug}`);
  assert.ok(!slug.includes('https'), `the scheme reached the name: ${slug}`);
});

test('rule one: a fragment is stripped too, on the same reasoning', () => {
  const slug = slugFromUrl('https://example.com/page#token-9f8e7d');
  assert.ok(!slug.includes('9f8e7d'), `a fragment reached the name: ${slug}`);
  assert.equal(slug, 'example-com-page');
});

test('rule one runs BEFORE the safe-character pass, not after it', () => {
  // The distinction this pins: a `?` collapsed to a hyphen by rule two would
  // leave the query's contents in the name, merely spelled differently. So the
  // assertion is not "no question mark" — it is that the material after it is
  // gone entirely.
  const slug = slugFromUrl('https://example.com/a?b=c');
  assert.equal(slug, 'example-com-a');
  // Dies if the strip is moved after the character pass, which would give
  // `example-com-a-b-c`.
  assert.ok(!slug.includes('b'), `query material survived reordering: ${slug}`);
});

test('rule two: only safe characters survive, whatever went in', () => {
  const slug = slugFromUrl('https://example.com/Path With Spaces/And%20Encoding!');
  assert.match(slug, /^[a-z0-9-]+$/, `unsafe characters survived: ${slug}`);
});

test('rule three: a deep path is truncated to the bound', () => {
  const deep = `https://example.com/${Array.from({ length: 40 }, (_, at) => `segment${String(at)}`).join('/')}`;
  const slug = slugFromUrl(deep);
  // Dies if the truncation is dropped: the untruncated slug is several hundred
  // characters.
  assert.ok(
    slug.length <= MAXIMUM_PART_LENGTH,
    `the slug was ${String(slug.length)} characters, past the bound of ${String(MAXIMUM_PART_LENGTH)}`,
  );
  assert.ok(slug.length > 0);
});

test('rule four: a name is ONE segment — no separator of either spelling survives', () => {
  const slug = slugFromUrl('https://example.com/a/b/c');
  // Both spellings, because the rule has to hold whichever platform runs it.
  assert.ok(!slug.includes('/'), `a forward separator survived: ${slug}`);
  assert.ok(!slug.includes(BACK), `a back separator survived: ${slug}`);
  // Dies if the safe set is widened to include the separator: joining a path
  // with hyphens is the whole point.
  assert.equal(slug, 'example-com-a-b-c');
});

test('rule four: a traversal in the address cannot become a traversal in the name', () => {
  const slug = slugFromUrl('https://example.com/../../etc/passwd');
  assert.ok(!slug.includes('..'), `a traversal survived: ${slug}`);
  assert.ok(!path.isAbsolute(slug));
  assert.match(slug, /^[a-z0-9-]+$/);
});

test('a label is held to rules two, three and four as well', () => {
  const label = sanitiseLabel(`../..${BACK}..${BACK}windows/system32`);
  assert.ok(!label.includes('..'), `a traversal survived a label: ${label}`);
  assert.ok(!label.includes('/'), `a separator survived a label: ${label}`);
  assert.ok(!label.includes(BACK), `a separator survived a label: ${label}`);
  assert.match(label, /^[a-z0-9-]+$/);
});

test('a label that pastes in a whole address does not smuggle a query through', () => {
  // Rule one is about addresses and a label is not one — so this asserts the
  // *fallback*: the safe-character pass alone is not enough to keep a token
  // out, which is exactly why the query strip is a separate first rule for the
  // slug. Here the token DOES survive, and the test says so rather than
  // pretending otherwise.
  const label = sanitiseLabel('checkout?session=abc123');
  assert.match(label, /^[a-z0-9-]+$/);
  assert.ok(!label.includes('?'));
  // Documented honestly: a caller that puts a secret in its own label has put
  // it there deliberately, and no rule in §1.7a claims to catch that.
  assert.equal(label, 'checkout-session-abc123');
});

test('a name is never empty, however unusable the input', () => {
  assert.equal(slugFromUrl(''), 'unnamed');
  assert.equal(slugFromUrl(undefined), 'unnamed');
  assert.equal(sanitiseLabel('!!!///???'), 'unnamed');
  // An empty part would collapse the five-part shape into one with a doubled
  // separator and make two different captures produce the same name.
});

test('THE STRIP IS THE SOLE DEFENCE on the fallback path, and this is its mutation test', () => {
  // A capture is never refused for the sake of its file name (§3.11: the only
  // refusals are argument mistakes), so an unparseable address must not throw
  // — it falls back to reducing the text directly. There is no parser on this
  // branch to be structurally safe about the query, so `withoutQuery` is the
  // only thing keeping a token out.
  //
  // ✔ MUTATION-PROVEN: a build in which the strip is skipped and the raw
  // address is reduced directly fails exactly this test, and no other in this
  // file. It is the named mutation for rule one.
  const slug = slugFromUrl('not a url at all?token=secretvalue');
  assert.match(slug, /^[a-z0-9-]+$/);
  assert.ok(!slug.includes('secretvalue'), `the fallback path leaked a token: ${slug}`);
  assert.ok(!slug.includes('token'), `the fallback path leaked a query key: ${slug}`);

  // The same on a fragment, and on a scheme the parser does not accept.
  assert.ok(!slugFromUrl('weird-scheme:://host/x#sessionfragment').includes('sessionfragment'));
});

test('the stamp is digits only and sorts in time order', () => {
  const earlier = stampFromInstant(new Date('2026-01-02T03:04:05.000Z'));
  const later = stampFromInstant(new Date('2026-01-02T03:04:06.000Z'));
  assert.match(earlier, /^[0-9]+$/);
  assert.ok(earlier < later, `${earlier} did not sort before ${later}`);
});

test('the five parts appear in the order §1.7a specifies', () => {
  const name = captureFileName({
    url: 'https://example.com/checkout?session=abc123secret',
    label: 'Collapsed Nav',
    viewportWidth: 390,
    takenAt: new Date('2026-01-02T03:04:05.000Z'),
    id: 'cafe1234',
  });

  // slug, label, width, when, id — dies if any two are swapped.
  assert.equal(name, 'example-com-checkout-collapsed-nav-390-20260102030405-cafe1234.png');
  // And the query is gone from the assembled name, not merely from the slug in
  // isolation: this is the assertion that survives someone assembling the name
  // from the raw address by mistake.
  assert.ok(!name.includes('abc123secret'), `the assembled name leaked a token: ${name}`);
});

test('an assembled name is a single path segment', () => {
  const name = captureFileName({
    url: `https://example.com/a/b?x=1`,
    label: `../${BACK}escape`,
    viewportWidth: 1280,
    takenAt: new Date('2026-01-02T03:04:05.000Z'),
    id: 'abc',
  });
  assert.equal(path.basename(name), name, `the name was more than one segment: ${name}`);
  assert.ok(!path.isAbsolute(name));
});
