import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ADAPTER_IDS, ADAPTER_REGISTRY, isAdapterId } from '../../src/adapter/contract.ts';
import {
  ADAPTER_SOURCE_ROOTS,
  discoverAdapters,
  unregisteredAdapters,
} from '../../src/adapter/conformance/discovery.ts';

/**
 * The property row #25 is defined by: **an unregistered adapter fails the
 * suite.**
 *
 * `MILESTONES.md` M5 is done when "adding a new one without registering it
 * fails", and this repository's own standard says a claim of that shape is
 * exactly the kind that can be hollow. So it is not asserted by inspection —
 * an unregistered adapter is **actually written into a tree** and the check is
 * watched to return it.
 */

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A throwaway tree with a `src` directory, so the walk has somewhere real to
 * look. Built rather than mocked: a discovery check that has only ever run
 * against a fake filesystem has never been run against the thing it exists to
 * catch.
 */
function makeTree(): { readonly root: string; readonly remove: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-adapters-'));
  fs.mkdirSync(path.join(root, 'src', 'somewhere'), { recursive: true });
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** The text of an adapter module, with whichever id the caller wants. */
function anAdapterModule(id: string, declaration = 'someAdapter'): string {
  return [
    "import type { Adapter } from '../adapter/contract.ts';",
    '',
    `export const ${declaration}: Adapter = {`,
    `  id: '${id}',`,
    "  description: 'A route.',",
    '  readOnly: false,',
    '  operations: [],',
    '  waivers: [],',
    '  invoke: async () => ({ outcome: "accepted", value: {} }),',
    '};',
  ].join('\n');
}

test('an UNREGISTERED adapter fails the check — the defining property of this row', () => {
  const tree = makeTree();
  try {
    // A real adapter module, written to disk, that nothing mounts.
    fs.writeFileSync(
      path.join(tree.root, 'src', 'somewhere', 'rogue.ts'),
      anAdapterModule('rogue', 'rogueAdapter'),
    );

    const unregistered = unregisteredAdapters(tree.root);

    assert.equal(unregistered.length, 1, 'the unregistered adapter was not caught');
    assert.equal(unregistered[0]?.id, 'rogue');
    assert.equal(unregistered[0]?.declaration, 'rogueAdapter');
    assert.match(unregistered[0]?.why ?? '', /registry/u);
  } finally {
    tree.remove();
  }
});

test('a REGISTERED adapter passes the same check — so the check is not simply always failing', () => {
  // The companion to the test above, and it is not decoration: a check that
  // returned every adapter it found would pass the test above while being
  // useless. One of these two alone proves nothing.
  const tree = makeTree();
  try {
    fs.writeFileSync(
      path.join(tree.root, 'src', 'somewhere', 'known.ts'),
      anAdapterModule('cli', 'knownAdapter'),
    );

    assert.deepEqual(unregisteredAdapters(tree.root), []);
    assert.equal(
      discoverAdapters(tree.root).length,
      1,
      'the registered adapter was not discovered',
    );
  } finally {
    tree.remove();
  }
});

test('an adapter whose id is not a literal is refused, because nothing can check it', () => {
  const tree = makeTree();
  try {
    fs.writeFileSync(
      path.join(tree.root, 'src', 'somewhere', 'computed.ts'),
      [
        "import type { Adapter } from '../adapter/contract.ts';",
        'const chosen = process.env.WHICH ?? "cli";',
        'export const computedAdapter: Adapter = {',
        '  id: chosen,',
        '  description: "A route.",',
        '  readOnly: false,',
        '  operations: [],',
        '  waivers: [],',
        '  invoke: async () => ({ outcome: "accepted", value: {} }),',
        '};',
      ].join('\n'),
    );

    const unregistered = unregisteredAdapters(tree.root);
    assert.equal(unregistered.length, 1);
    assert.match(unregistered[0]?.why ?? '', /not a literal/u);
  } finally {
    tree.remove();
  }
});

test('this repository has no unregistered adapter', () => {
  // The check applied to the real tree. It is the assertion that would fail
  // the day somebody adds an adapter and forgets the registry — which is the
  // whole reason the two tests above exist to prove it can fail.
  assert.deepEqual(unregisteredAdapters(repositoryRoot), []);
});

test('the real tree contains at least one adapter, so the check above is not vacuous', () => {
  // Without this, the assertion above passes forever on an empty result — the
  // failure `MILESTONES.md` names outright: "an assertion evaluated over an
  // empty set passes forever and silently".
  const found = discoverAdapters(repositoryRoot);
  assert.ok(found.length > 0, 'no adapter was discovered in this repository at all');
  assert.ok(
    found.some((adapter) => adapter.id === 'cli'),
    'the command-line adapter was not discovered',
  );
});

test('an adapter DESCRIBED in a comment is not mistaken for one that exists', () => {
  // Not hypothetical. This module's own header quotes the shape it matches,
  // and the walk reported that quotation as an unregistered adapter until
  // comments were blanked — the first run of this suite failed on it. The
  // test exists so the fix cannot be undone silently.
  const tree = makeTree();
  try {
    fs.writeFileSync(
      path.join(tree.root, 'src', 'somewhere', 'prose.ts'),
      [
        '/**',
        ' * How an adapter is written:',
        " * `export const exampleAdapter: Adapter = { id: 'made-up', ... }`",
        ' */',
        "// export const commentedOut: Adapter = { id: 'also-made-up' };",
        'export const notAnAdapter = 1;',
      ].join('\n'),
    );

    assert.deepEqual(discoverAdapters(tree.root), []);
    assert.deepEqual(unregisteredAdapters(tree.root), []);
  } finally {
    tree.remove();
  }
});

test('the discovery roots are pinned, so narrowing them is a visible change', () => {
  // A walk-based check is only as good as where it looks. Naming the roots
  // here means a future change that quietly stopped searching most of the
  // tree fails this test rather than silently reducing coverage.
  assert.deepEqual([...ADAPTER_SOURCE_ROOTS], ['src']);
});

test('the registry names every mounted route, by name', () => {
  // Named rather than counted. `MILESTONES.md` records a hollow test that
  // "iterated a list rather than naming its entries, so deleting an entry
  // stayed green" — a length assertion here would have exactly that shape.
  assert.deepEqual([...ADAPTER_IDS], ['cli']);
  assert.ok(isAdapterId('cli'));
  assert.equal(isAdapterId('not-a-route'), false);
});

test('every registry entry describes itself, so the registry is readable as documentation', () => {
  for (const id of ADAPTER_IDS) {
    const description = ADAPTER_REGISTRY[id];
    assert.ok(description.length > 20, `${id} has no real description`);
  }
});
