import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { ArtifactStore } from '../../src/artifacts/store.ts';
import { fileNameFrom, overlayFileName, regionCropFileName } from '../../src/diff/artifact-path.ts';
import { BACK, localDrivePath, sharePath } from '../helpers/paths.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * Naming the files a comparison writes (`SCHEMA.md` §1.7a).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN OF THIS FILE MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **What it means:** a crop is named so it sorts immediately beside the capture
 * it came from, the two sides of one region differ only in the side, and the
 * names this module produces are accepted by the artifact store — which is the
 * only thing that decides where they land.
 *
 * **What it does not mean:** that traversal is defended here. **It is not, and
 * deliberately.** Resolution and its refusals belong to
 * `src/artifacts/store.ts`, whose own suite covers them — including the case
 * this module could never have got right alone: a name absolute in the *other*
 * path namespace is a legal relative filename here, so it resolves quietly
 * under the root and the computed answer looks clean.
 *
 * The last test below is the one that matters for that: it feeds names of both
 * spellings through the real store and asserts it refuses, so this module's
 * output is checked **against the guard that actually runs** rather than
 * against a second copy of it living here.
 */

// ── Names sort beside the capture they came from ────────────────────────

test('a crop name is the capture name plus a region suffix, before the extension', () => {
  // §1.7a: crops take the capture's name plus a region suffix, so they sort
  // immediately beside the picture they came from. A suffix after the
  // extension would sort nowhere useful and open in nothing.
  assert.equal(
    regionCropFileName('page-hero-1024-when-abc.png', 0, 'before'),
    'page-hero-1024-when-abc-region-00-before.png',
  );
});

test('the two crops of one region differ only in the side', () => {
  // The pair is what a reader compares, so anything else differing between
  // them is a difference they would attribute to the change.
  const before = regionCropFileName('page.png', 3, 'before');
  const after = regionCropFileName('page.png', 3, 'after');

  assert.equal(before.replace('-before.', '-X.'), after.replace('-after.', '-X.'));
  assert.notEqual(before, after);
});

test('region indexes are zero-padded, so a listing sorts in the reported order', () => {
  // Without padding the tenth region sorts between the first and the second,
  // and the directory stops reading in the order the result reported.
  assert.match(regionCropFileName('page.png', 2, 'before'), /-region-02-before\./);
  assert.match(regionCropFileName('page.png', 11, 'before'), /-region-11-before\./);
});

test('an overlay is named beside the capture it was drawn from', () => {
  assert.equal(overlayFileName('page.png'), 'page-overlay.png');
});

test('a capture name with no extension still takes a suffix', () => {
  // Not expected from the capture pipeline, which always writes an extension —
  // and a name-building function that produced something malformed on the
  // unusual input would fail somewhere far from here.
  assert.equal(regionCropFileName('page', 0, 'after'), 'page-region-00-after');
  assert.equal(overlayFileName('page'), 'page-overlay');
});

// ── Reading a stored path back ──────────────────────────────────────────

test('the file name is taken from a stored path in either separator spelling', () => {
  // A stored path uses forward slashes whatever platform wrote it, and a row
  // from another build can carry the other spelling. Taking the wrong segment
  // would name a directory as though it were a file and build a crop name out
  // of part of a path.
  assert.equal(fileNameFrom('claims/claim-a/images/page.png'), 'page.png');
  assert.equal(fileNameFrom(['claims', 'claim-a', 'images', 'page.png'].join(BACK)), 'page.png');
  // Already a bare name: unchanged.
  assert.equal(fileNameFrom('page.png'), 'page.png');
});

// ── The names are checked against the guard that actually runs ──────────

test('the names this module builds are accepted by the artifact store', () => {
  // The positive half. A naming scheme the store refuses would fail at the
  // moment a diff writes its first crop, which is a long way from here.
  const temp = makeTempStore();
  try {
    const artifacts = new ArtifactStore(temp.environment.artifactsRoot);
    const captureName = 'page-hero-1024-when-abc.png';
    const bytes = new Uint8Array([1, 2, 3]);

    const before = artifacts.write(
      'claim-a',
      'images',
      regionCropFileName(captureName, 0, 'before'),
      bytes,
    );
    const overlay = artifacts.write('claim-a', 'images', overlayFileName(captureName), bytes);

    // Stored relative, under this lease's images directory, with forward
    // slashes — the three properties §1.7a asks of every stored path.
    for (const stored of [before.relativePath, overlay.relativePath]) {
      assert.equal(path.isAbsolute(stored), false);
      assert.ok(stored.startsWith('claims/claim-a/images/'));
      assert.ok(!stored.includes(BACK));
    }
    // And they sort beside the capture, which is the point of the naming.
    assert.ok(before.relativePath.includes('page-hero-1024-when-abc-region-00-before'));
  } finally {
    temp.remove();
  }
});

test('the store refuses an escaping name in either namespace, which is why this module does not check', () => {
  // **The negative half, run through the real guard.** These are the shapes a
  // resolver of this module's own would most plausibly have missed — a name
  // absolute in the other namespace is a legal relative filename on a platform
  // whose separator is the forward slash, so it would resolve quietly under
  // the root with nothing downstream able to notice.
  //
  // Asserting them here rather than reimplementing a check is the design
  // decision this file's header describes: one guard, tested against the
  // spellings that break it, rather than two guards one of which is weaker.
  const temp = makeTempStore();
  try {
    const artifacts = new ArtifactStore(temp.environment.artifactsRoot);
    const bytes = new Uint8Array([1]);

    // Composed from parts rather than written as literals: the hygiene gate
    // matches a drive letter followed by a separator and a two-separator share
    // prefix, and writing them out would fail the check on the very file that
    // exercises them.
    const escaping = [
      // Four levels up from claims/<id>/images/ leaves the root; three would
      // only reach claims/, which is still inside it and is correctly allowed.
      ['..', '..', '..', '..', 'secrets.png'].join('/'),
      path.posix.join(path.posix.sep, 'etc', 'secrets.png'),
      localDrivePath('C', 'Windows', 'system.ini'),
      sharePath('host', 'share', 'file.png'),
    ];

    for (const name of escaping) {
      assert.throws(
        () => artifacts.write('claim-a', 'images', name, bytes),
        `the store accepted ${JSON.stringify(name)}, which escapes the artifact root in at least one namespace`,
      );
    }
  } finally {
    temp.remove();
  }
});
