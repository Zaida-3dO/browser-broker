import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ArtifactStore } from '../../src/artifacts/store.ts';
import { BrokerError } from '../../src/errors.ts';
import { BACK, localDrivePath, sharePath } from '../helpers/paths.ts';

/**
 * `SCHEMA.md` §1.7a: one directory per lease, nothing outside it, every stored
 * path relative to the root.
 *
 * The temporary root is computed from the platform's own temporary directory
 * rather than written down, for the same reason `tests/helpers/temp-store.ts`
 * computes its own: a literal path names one machine, and the hygiene gate
 * refuses one in a tracked file.
 */
function withStore(fn: (store: ArtifactStore, root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-artefacts-'));
  try {
    fn(new ArtifactStore(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the tree is claims/<claim>/<kind>, and each folder is named outright', () => {
  withStore((store, root) => {
    // NAMED, never iterated. A test that walked `ARTIFACT_KINDS` and asserted
    // each entry exists goes green when an entry is DELETED, because it would
    // then be walking a shorter list — that is one of the hollow shapes this
    // repository has already been bitten by. Naming each one means deleting
    // `downloads` fails this test.
    for (const kind of ['images', 'snapshots', 'console', 'network', 'downloads']) {
      const directory = store.directoryFor('claim1', kind as never);
      assert.ok(fs.existsSync(directory), `${kind} was not created`);
      assert.equal(directory, path.join(root, 'claims', 'claim1', kind));
    }
  });
});

test('a written path is RELATIVE to the root — never absolute', () => {
  withStore((store, root) => {
    const stored = store.write('claim1', 'images', 'picture.png', new Uint8Array([1, 2, 3]));

    // The mutation this dies on: returning `absolutePath` as `relativePath`.
    // That is the plausible mistake, and it is invisible until the root moves.
    assert.equal(stored.relativePath, 'claims/claim1/images/picture.png');
    assert.ok(!path.isAbsolute(stored.relativePath), `stored an absolute path: ${stored.relativePath}`);
    assert.ok(
      !stored.relativePath.includes(root),
      `the root leaked into the stored path: ${stored.relativePath}`,
    );
    // And the absolute one is still available for the process that wrote it.
    assert.ok(path.isAbsolute(stored.absolutePath));
    assert.equal(fs.readFileSync(stored.absolutePath).length, 3);
  });
});

test('a stored path uses forward slashes whatever platform wrote it', () => {
  withStore((store) => {
    const stored = store.write('claim1', 'images', 'picture.png', new Uint8Array([1]));
    // A row written on one machine has to read on another; a separator baked
    // into the stored value reintroduces machine-specificity one layer down.
    assert.ok(!stored.relativePath.includes(BACK), `a back separator was stored: ${stored.relativePath}`);
    assert.equal(stored.relativePath.split('/').length, 4);
  });
});

test('the relative path resolves back to exactly the file that was written', () => {
  withStore((store) => {
    const stored = store.write('claim1', 'images', 'picture.png', new Uint8Array([9, 9]));
    // The round trip is the property that makes rule one usable: a row records
    // the relative path, and the image endpoint resolves it under the root.
    assert.equal(path.resolve(store.resolve(stored.relativePath)), path.resolve(stored.absolutePath));
    assert.equal(fs.readFileSync(store.resolve(stored.relativePath))[0], 9);
  });
});

test('bytes reports what was written', () => {
  withStore((store) => {
    const stored = store.write('claim1', 'images', 'p.png', new Uint8Array([1, 2, 3, 4, 5]));
    assert.equal(stored.bytes, 5);
    assert.equal(fs.statSync(stored.absolutePath).size, 5);
  });
});

test('a name that would climb out of the root is REFUSED, and nothing is written', () => {
  withStore((store, root) => {
    // Four levels up from `claims/<claim>/images/` clears the root itself.
    // Three would land ON the root and two inside it, and neither is an
    // escape — the guard is about leaving the tree, not about the spelling
    // `..`, and a test that asserted otherwise would be asserting a rule this
    // service does not have.
    const escape = ['..', '..', '..', '..', 'escaped.png'].join(path.sep);
    assert.throws(
      () => store.write('claim1', 'images', escape, new Uint8Array([1])),
      (error: unknown) => error instanceof BrokerError && error.rule === 'artifact.no_request_path',
    );
    // **The physical side-effect, not just the response.** A refusal that
    // returned after writing the file is worse than no refusal — so this
    // asserts the file is absent, which is the half a response-only test
    // misses. Checked against where the traversal would have landed.
    assert.ok(
      !fs.existsSync(path.resolve(root, '..', 'escaped.png')),
      'the refusal came after the write',
    );
  });
});

test('the refusal is about leaving the tree, not about the spelling `..`', () => {
  withStore((store) => {
    // The boundary of the refusal above, stated outright because a reader who
    // saw only that test would reasonably assume `..` itself is what is
    // refused. Climbing from `claims/<claim>/images/` to a sibling kind stays
    // inside the root, so `resolve` allows it — the guard compares against the
    // root, not against a pattern.
    //
    // `write` would additionally need that sibling directory to exist, which
    // is why this asserts through `resolve`: it isolates the rule from the
    // filesystem's own requirements, which are not what is under test.
    const inside = store.resolve('claims/claim1/images/../snapshots/note.txt');
    assert.ok(inside.startsWith(store.root), `${inside} was not under the root`);
    assert.ok(!inside.includes('..'), 'the resolved path was not normalised');
  });
});

test('an absolute name is refused rather than written to', () => {
  withStore((store) => {
    // Composed from parts through the helper: a literal drive-letter path
    // fails the hygiene gate on the very file proving this refusal.
    const absolute = localDrivePath('C', 'somewhere', 'picture.png');
    assert.throws(
      () => store.write('claim1', 'images', absolute, new Uint8Array([1])),
      (error: unknown) => error instanceof BrokerError && error.rule === 'artifact.no_request_path',
    );
  });
});

test('resolve refuses a recorded path that escapes — traversal has no input to arrive through', () => {
  withStore((store) => {
    // `artifact.no_request_path` (§7.3): the path that serves bytes resolves a
    // recorded path under the root or serves nothing.
    for (const escaping of ['../outside.png', '../../outside.png', `..${BACK}outside.png`]) {
      assert.throws(
        () => store.resolve(escaping),
        (error: unknown) => error instanceof BrokerError && error.rule === 'artifact.no_request_path',
        `resolve allowed ${escaping}`,
      );
    }
  });
});

test('resolve refuses an absolute recorded path in either spelling', () => {
  withStore((store) => {
    for (const absolute of [
      localDrivePath('C', 'windows', 'system32'),
      sharePath('host', 'share', 'file.png'),
      '/etc/passwd',
    ]) {
      assert.throws(
        () => store.resolve(absolute),
        (error: unknown) => error instanceof BrokerError && error.rule === 'artifact.no_request_path',
        `resolve allowed ${absolute}`,
      );
    }
  });
});

test('a claim identifier that is not a plain segment is refused', () => {
  withStore((store, root) => {
    for (const bad of ['../escape', `..${BACK}escape`, 'a/b', '']) {
      assert.throws(
        () => store.directoryFor(bad, 'images'),
        (error: unknown) => error instanceof BrokerError && error.rule === 'artifact.no_request_path',
        `a claim identifier of ${JSON.stringify(bad)} was accepted`,
      );
    }
    // Nothing was created outside the root by the attempts above.
    assert.ok(!fs.existsSync(path.resolve(root, '..', 'escape')));
  });
});

test('two leases get two directories, so a lease is the unit you delete', () => {
  withStore((store, root) => {
    const one = store.write('claima', 'images', 'a.png', new Uint8Array([1]));
    const two = store.write('claimb', 'images', 'b.png', new Uint8Array([2]));
    assert.notEqual(path.dirname(one.absolutePath), path.dirname(two.absolutePath));

    // Deleting one lease's directory takes everything it produced and touches
    // nothing else — the property §1.7a's one-folder-per-lease exists for.
    fs.rmSync(path.join(root, 'claims', 'claima'), { recursive: true });
    assert.ok(!fs.existsSync(one.absolutePath));
    assert.ok(fs.existsSync(two.absolutePath), "deleting one lease removed another lease's file");
  });
});
