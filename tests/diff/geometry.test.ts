import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileGeometry } from '../../src/diff/geometry.ts';

/**
 * Geometry reconciliation (`MILESTONES.md` #40).
 *
 * ── What a green run of this file means, and what it does not ───────────
 *
 * **What it means:** every branch of the reconciliation has been asserted on
 * its outputs individually — the shared width, the compared height, the page
 * length change, and whether the pair is comparable at all. The single-character
 * change each test catches is named in its own comment.
 *
 * **What it does not mean:** that the *result* a caller sees carries these
 * facts. This module returns them; `comparison.ts` is what puts them on a
 * response, and `tests/diff/comparison.test.ts` is where that is asserted.
 */

test('two identical geometries compare over the whole image and say nothing', () => {
  const result = reconcileGeometry(
    { width: 800, height: 600 },
    { width: 800, height: 600 },
    'viewport',
  );

  assert.equal(result.comparable, true);
  assert.equal(result.width, 800);
  assert.equal(result.comparableHeight, 600);
  assert.equal(result.widthMismatch, false);
  assert.equal(result.pageLengthChange, null);
  // Named explicitly: an explanation on an unremarkable pair is noise on every
  // ordinary diff, and a caller that printed it would print it always.
  assert.equal(result.explanation, null);
});

test('a width mismatch is reported in the result and stops the comparison', () => {
  const result = reconcileGeometry(
    { width: 1024, height: 600 },
    { width: 1440, height: 600 },
    'viewport',
  );

  // The row's own words: "a width mismatch is REPORTED IN THE RESULT rather
  // than pre-empted". Reported means these three fields, not a throw.
  assert.equal(result.widthMismatch, true);
  assert.equal(result.comparable, false);
  assert.equal(result.comparableHeight, null);
  assert.notEqual(result.explanation, null);
  // Both numbers appear, so a caller can see which is which without going
  // back to the two captures. Dropping either from the sentence fails here.
  assert.match(result.explanation ?? '', /1024/);
  assert.match(result.explanation ?? '', /1440/);
});

test('a width mismatch reports no page length change, even when the heights also differ', () => {
  const result = reconcileGeometry(
    { width: 1024, height: 600 },
    { width: 1440, height: 900 },
    'full_page',
  );

  // The heights differ by 300, and reporting that would be a fact about two
  // pages of different widths — which is not a page that got longer, it is two
  // different renderings. The width mismatch is the whole finding.
  assert.equal(result.pageLengthChange, null);
  assert.equal(result.comparable, false);
});

test("a full page's height is allowed to differ, and the change in length is its own fact", () => {
  const result = reconcileGeometry(
    { width: 800, height: 1000 },
    { width: 800, height: 1240 },
    'full_page',
  );

  // §3.11: "two full-page pictures of one page legitimately differ in height
  // when the content gets longer". Comparable stays true.
  assert.equal(result.comparable, true);
  assert.equal(result.widthMismatch, false);
  // Its own fact, signed: 240 longer rather than an unsigned difference, so a
  // page that got shorter is distinguishable from one that got longer.
  assert.equal(result.pageLengthChange, 240);
  // "The comparison runs over the height they share" — the shorter of the two.
  assert.equal(result.comparableHeight, 1000);
  assert.match(result.explanation ?? '', /longer/);
  assert.match(result.explanation ?? '', /240/);
});

test('a full page that got shorter reports a negative length change and says shorter', () => {
  const result = reconcileGeometry(
    { width: 800, height: 1240 },
    { width: 800, height: 1000 },
    'full_page',
  );

  assert.equal(result.comparable, true);
  assert.equal(result.pageLengthChange, -240);
  assert.equal(result.comparableHeight, 1000);
  // A sign flip in the sentence is invisible to a test that only checks the
  // number, and "the page got longer by 240" on a page that shrank is worse
  // than saying nothing.
  assert.match(result.explanation ?? '', /shorter/);
});

test('a viewport capture whose height differs is not comparable', () => {
  const result = reconcileGeometry(
    { width: 800, height: 600 },
    { width: 800, height: 700 },
    'viewport',
  );

  // The allowance is for a full page and nothing else. A viewport is a fixed
  // rectangle, so two viewport pictures of different heights were taken at
  // different viewport sizes — comparing their shared rows would report a
  // confident number about two different windows.
  assert.equal(result.comparable, false);
  assert.equal(result.comparableHeight, null);
  assert.equal(result.pageLengthChange, null);
  assert.match(result.explanation ?? '', /viewport/);
});

test('an element capture whose height differs is not comparable', () => {
  const result = reconcileGeometry(
    { width: 300, height: 40 },
    { width: 300, height: 64 },
    'element',
  );

  assert.equal(result.comparable, false);
  assert.match(result.explanation ?? '', /element/);
});

test('two full pages that share no rows are not comparable, rather than reporting nothing changed', () => {
  const result = reconcileGeometry(
    { width: 800, height: 0 },
    { width: 800, height: 900 },
    'full_page',
  );

  // A comparison over zero rows finds zero changed pixels, which reads as
  // "nothing changed" — the one answer this must never give for two pictures
  // it could not compare.
  assert.equal(result.comparable, false);
  assert.equal(result.comparableHeight, null);
  // The length change survives, because it is the only fact there is.
  assert.equal(result.pageLengthChange, 900);
});
