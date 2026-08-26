import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LINK_KEYWORDS,
  SCANNED_DIR,
  danglingLinks,
  declaredNamesIn,
  linkTargetsIn,
  sourceFilesIn,
} from '../scripts/check-doc-links.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * The self-test for the dangling-link build rule.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN OF THIS FILE MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `CLAUDE.md`: a script used as a gate "must ship a test proving it fails on a
 * seeded violation, not merely that it passes on clean input", and must "state
 * plainly what a green result does, and does not, mean".
 *
 * **What it means:** the scan has been run against sources that violate it and
 * refused each one — including the *real* text that motivated the rule, taken
 * verbatim rather than invented, so this is a regression test for an actual
 * defect and not only for a hypothetical one. The resolution senses are each
 * exercised against a link that genuinely needs them, so a sense that stopped
 * working fails here rather than silently turning correct links into failures.
 *
 * **What it does not mean:** that documentation is accurate. The rule sees a
 * name that does not exist; it cannot see a name that exists and is the wrong
 * one, and it cannot see a claim made in prose instead of a link. The script's
 * header sets out all three limits and they are real.
 */

/* ─────────────────── it fails on a seeded violation ─────────────────── */

test('a link to a name that exists nowhere is refused', () => {
  const found = danglingLinks({
    'src/service/example.ts': `/** See {@link somethingNeverWritten} for the rule. */\nexport function real() {}\n`,
  });

  assert.equal(found.length, 1);
  assert.equal(found[0]?.target, 'somethingNeverWritten');
});

test('THE REAL DEFECT THIS RULE EXISTS FOR IS CAUGHT, on the text that carried it', () => {
  // Not a synthetic seed: this is the shape of the header that pointed at a
  // `reconcileBrowser` which existed at no commit, alongside a link that did
  // resolve. Both are present so this asserts the scan discriminates rather
  // than simply reporting everything in a file it dislikes.
  const header = [
    '/**',
    ' * Tab lifecycle.',
    ' *',
    ' * {@link findOpenOwnedTab} takes an opaque identifier and a lease.',
    ' *',
    ' * Hence {@link reconcileBrowser}, whose two halves are asymmetric.',
    ' */',
    'export function findOpenOwnedTab() {}',
    '',
  ].join('\n');

  const found = danglingLinks({ 'src/service/tabs.ts': header });

  assert.equal(found.length, 1);
  assert.equal(found[0]?.target, 'reconcileBrowser');
  // The line is reported against the unmodified source, because a rule that
  // reports the wrong line sends its reader to innocent code.
  assert.equal(found[0]?.line, 6);
});

test('a link is refused even when the name exists only in a test, not in the scanned tree', () => {
  // The scanned tree is the product. A helper that exists only under tests/
  // is not something a reader of src/ can go and look at.
  const found = danglingLinks({
    'src/service/example.ts': '/** See {@link seedClaim}. */\nexport function real() {}\n',
  });

  assert.deepEqual(
    found.map((failure) => failure.target),
    ['seedClaim'],
  );
});

test('several dangling links are all reported, not just the first', () => {
  const found = danglingLinks({
    'src/a.ts': '/** {@link missingOne} */\nexport const a = 1;\n',
    'src/b.ts': '/** {@link missingTwo} */\nexport const b = 2;\n',
  });

  assert.deepEqual(found.map((failure) => failure.target).sort(), ['missingOne', 'missingTwo']);
});

/* ─────────────── each resolution sense earns its place ─────────────── */

test('a link resolves against a top-level declaration of every kind', () => {
  const sources = {
    'src/decls.ts': [
      'export function aFunction() {}',
      'export class AClass {}',
      'export interface AnInterface { readonly x: string }',
      'export type AType = string;',
      'export const aConst = 1;',
      'enum AnEnum { One }',
    ].join('\n'),
    'src/links.ts': [
      '/** {@link aFunction} {@link AClass} {@link AnInterface} */',
      '/** {@link AType} {@link aConst} {@link AnEnum} */',
      'export const linked = 1;',
    ].join('\n'),
  };

  assert.deepEqual(danglingLinks(sources), []);
});

test('a link resolves against an interface member, which four real links need', () => {
  const sources = {
    'src/driver.ts': 'export interface Driver {\n  readonly listTabs: () => Promise<void>;\n}\n',
    'src/use.ts': '/** {@link listTabs} is the call. */\nexport const use = 1;\n',
  };

  assert.deepEqual(danglingLinks(sources), []);
  // And the member really is what resolves it: without the interface the same
  // link fails, so this is not passing for some unrelated reason.
  assert.equal(danglingLinks({ 'src/use.ts': sources['src/use.ts'] }).length, 1);
});

test('a link resolves against a method written in shorthand', () => {
  const sources = {
    'src/real.ts':
      'export class Real {\n  async coldStart(request) {\n    return request;\n  }\n}\n',
    'src/use.ts': '/** {@link coldStart} launches it. */\nexport const use = 1;\n',
  };

  assert.deepEqual(danglingLinks(sources), []);
});

test('a link resolves against an imported binding, including a type-only import', () => {
  const sources = {
    'src/use.ts': [
      "import type { Database } from 'better-sqlite3';",
      "import { readFileSync as read } from 'node:fs';",
      '/** {@link Database} and {@link read}. */',
      'export const use = 1;',
    ].join('\n'),
  };

  assert.deepEqual(danglingLinks(sources), []);
});

test('a link target is taken up to the first separator, so member and call forms resolve', () => {
  const targets = linkTargetsIn(
    '/** {@link Foo.bar} {@link baz()} {@link Qux#quux} {@link plain} */',
  ).map((link) => link.target);

  assert.deepEqual(targets, ['Foo', 'baz', 'Qux', 'plain']);
});

/* ─────────────────── the exemption list is pinned ─────────────────── */

test('LINK_KEYWORDS contains only the language keyword, so it cannot absorb a deletion', () => {
  // Pinned deliberately. The failure this gate exists to report is a name that
  // is missing because it was deleted, and the cheapest way to make such a
  // failure disappear is to add the name here. If this assertion is failing,
  // that is the question to answer first.
  assert.deepEqual([...LINK_KEYWORDS], ['import']);
});

test('a made-up name is not silently exempt', () => {
  assert.equal(LINK_KEYWORDS.includes('reconcileBrowser'), false);
});

/* ─────────────────── and it passes on the real tree ─────────────────── */

test('every {@link} in the shipped tree resolves', () => {
  const files = sourceFilesIn(SCANNED_DIR);
  // A tree this found nothing in would make the assertion below vacuous — the
  // prepareStore lesson is that coverage of something unreached proves nothing.
  assert.ok(files.length > 50, `expected a populated tree, found ${files.length} files`);

  const sources = {};
  for (const file of files) {
    sources[file] = readFileSync(join(ROOT_DIR, file), 'utf8');
  }

  const linkCount = Object.values(sources).reduce(
    (total, source) => total + linkTargetsIn(source).length,
    0,
  );
  assert.ok(linkCount > 100, `expected the tree to contain links, found ${linkCount}`);

  assert.deepEqual(danglingLinks(sources), []);
});

test('declaredNamesIn finds something in a real source, so an empty set is not why the tree passes', () => {
  const names = declaredNamesIn(readFileSync(join(ROOT_DIR, 'src/service/tabs.ts'), 'utf8'));
  assert.ok(names.has('reserveTab'));
  assert.ok(names.has('recordTabOpened'));
  assert.equal(names.has('reconcileBrowser'), false);
});
