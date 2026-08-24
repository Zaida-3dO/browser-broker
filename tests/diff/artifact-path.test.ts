import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  ArtifactPathError,
  imagesDirectory,
  overlayPath,
  regionCropPath,
  resolveArtifact,
} from '../../src/diff/artifact-path.ts';
import { BACK, localDrivePath, sharePath } from '../helpers/paths.ts';

/**
 * Artifact paths (`SCHEMA.md` §1.7a, §1.9).
 *
 * ── What a green run means, and what it does not ────────────────────────
 *
 * **What it means:** every path this feature stores is relative and stays under
 * the artifact root, and the resolver refuses the shapes that would escape it —
 * including the ones that only escape *after* resolution, which a check on the
 * stored string would pass.
 *
 * **What it does not mean:** that the bytes surface is safe because of these
 * refusals. §1.9 is explicit that the mechanism is the *absence of a
 * path-shaped input*, not a sanitiser: "there is no traversal to defend
 * against: the only strings it can be asked for are identifiers of rows".
 * `scripts/check-artifact-path.mjs` is what enforces that absence.
 *
 * So the refusals below guard against **this service** constructing a path
 * wrongly — a file-name derivation that let a separator through, a row from an
 * older build. They are a correctness assertion on our own data. Reading them
 * as the security boundary would be reading the design backwards, and it is
 * exactly the misreading that would make somebody comfortable adding a path
 * argument later "because it is validated anyway".
 */

// ── Stored paths are relative, and shaped so crops sort beside their capture

test('a stored path is relative, never absolute', () => {
  // The database enforces this too, with a check constraint on both spellings
  // of a root. Asserted here as well because a row that reached the constraint
  // would fail a write halfway through a capture, which is a much worse place
  // to find out.
  const stored = regionCropPath('claim-a', 'page-view-1024-when-id.png', 0, 'before');

  assert.equal(path.isAbsolute(stored), false);
  assert.ok(!stored.startsWith('/'));
  assert.ok(!stored.startsWith(BACK));
  assert.ok(!/^[A-Za-z]:/.test(stored));
});

test('a crop sits in the lease own images directory', () => {
  // §1.7a: one tree, everything under a lease, because a lease is the unit you
  // delete. A crop written anywhere else would outlive the deletion of the
  // work that produced it.
  const stored = regionCropPath('claim-a', 'page.png', 0, 'before');

  assert.ok(stored.startsWith(imagesDirectory('claim-a')));
  assert.equal(imagesDirectory('claim-a'), 'claims/claim-a/images');
});

test('a crop name is the capture name plus a region suffix, before the extension', () => {
  // §1.7a: crops "take the capture's name plus a region suffix, so they sort
  // immediately beside the picture they came from". A suffix after the
  // extension would sort nowhere useful and open in nothing.
  const stored = regionCropPath('claim-a', 'page-hero-1024-when-abc.png', 0, 'before');

  assert.equal(stored, 'claims/claim-a/images/page-hero-1024-when-abc-region-00-before.png');
});

test('the two crops of one region differ only in the side', () => {
  // The pair is what a reader compares, so anything else differing between
  // them is a difference they would attribute to the change.
  const before = regionCropPath('claim-a', 'page.png', 3, 'before');
  const after = regionCropPath('claim-a', 'page.png', 3, 'after');

  assert.equal(before.replace('-before.', '-XX.'), after.replace('-after.', '-XX.'));
});

test('region indexes are zero-padded, so a listing sorts in the reported order', () => {
  // Without padding, the tenth region sorts between the first and the second,
  // and the directory stops reading in the order the result reported.
  const second = regionCropPath('claim-a', 'page.png', 2, 'before');
  const eleventh = regionCropPath('claim-a', 'page.png', 11, 'before');

  assert.match(second, /-region-02-before\./);
  assert.match(eleventh, /-region-11-before\./);
});

test('an overlay sits beside the capture it was drawn from', () => {
  assert.equal(overlayPath('claim-a', 'page.png'), 'claims/claim-a/images/page-overlay.png');
});

// ── The resolver ────────────────────────────────────────────────────────

const ROOT = path.join(path.sep, 'artefacts');

test('a relative stored path resolves under the root', () => {
  const resolved = resolveArtifact(ROOT, 'claims/claim-a/images/page.png');

  assert.equal(resolved, path.resolve(ROOT, 'claims', 'claim-a', 'images', 'page.png'));
  // Under the root, positively asserted rather than inferred from the absence
  // of a throw.
  assert.ok(!path.relative(path.resolve(ROOT), resolved).startsWith('..'));
});

test('a backslash-spelled stored path resolves to the same place', () => {
  // A row written on one platform is read on another. Paths are stored with
  // forward slashes, and a row from a build that stored the other spelling
  // still has to resolve rather than escape.
  const forward = resolveArtifact(ROOT, 'claims/claim-a/images/page.png');
  const back = resolveArtifact(ROOT, ['claims', 'claim-a', 'images', 'page.png'].join(BACK));

  // On a platform whose separator is the forward slash, a backslash is an
  // ordinary character in a name — so these agree only where the separator
  // makes them agree. What must hold everywhere is that neither escapes.
  assert.ok(!path.relative(path.resolve(ROOT), forward).startsWith('..'));
  assert.ok(!path.relative(path.resolve(ROOT), back).startsWith('..'));
});

test('an empty stored path refuses rather than resolving to the root itself', () => {
  // An empty string resolves to the root directory, which is not a file and is
  // the one place a mistake would be least visible.
  assert.throws(() => resolveArtifact(ROOT, ''), ArtifactPathError);
});

test('a stored path that resolves to the root itself refuses', () => {
  // `.` and a trailing traversal both land on the root. Serving the root would
  // be serving a directory, and the read would fail with a message about a
  // directory rather than about a bad path.
  assert.throws(() => resolveArtifact(ROOT, '.'), ArtifactPathError);
  assert.throws(() => resolveArtifact(ROOT, 'claims/..'), ArtifactPathError);
});

test('an absolute stored path refuses, in every spelling', () => {
  // Three spellings, each asserted. A test naming one would pass on a check
  // that only handled that one, and which spelling reaches a row depends on
  // which platform wrote it.
  assert.throws(
    () => resolveArtifact(ROOT, path.join(path.sep, 'etc', 'shadow')),
    ArtifactPathError,
  );
  assert.throws(
    () => resolveArtifact(ROOT, localDrivePath('C', 'Windows', 'system.ini')),
    ArtifactPathError,
  );
  assert.throws(
    () => resolveArtifact(ROOT, sharePath('host', 'share', 'file.png')),
    ArtifactPathError,
  );
});

test('a stored path that escapes only after resolution refuses', () => {
  // **The case a check on the stored string would pass.** Nothing about
  // `claims/claim-a/../../../secrets.png` looks absolute, and every segment is
  // an ordinary name. It escapes only once the segments are applied, which is
  // why the containment assertion is on the resolved value.
  assert.throws(
    () => resolveArtifact(ROOT, 'claims/claim-a/../../../secrets.png'),
    ArtifactPathError,
  );
  assert.throws(() => resolveArtifact(ROOT, '../secrets.png'), ArtifactPathError);
  assert.throws(() => resolveArtifact(ROOT, 'a/../../b'), ArtifactPathError);
});

test('a traversal that stays inside the root is allowed', () => {
  // The counterweight: the rule is containment, not a ban on the two-dot
  // segment. A check that refused any path containing `..` would pass every
  // assertion above and would be a different, stricter rule than the one §1.7a
  // states — and it would refuse a legitimately-normalised row.
  const resolved = resolveArtifact(ROOT, 'claims/claim-a/../claim-b/images/page.png');

  assert.equal(resolved, path.resolve(ROOT, 'claims', 'claim-b', 'images', 'page.png'));
});

test('the refusal explains that this is a constructed path rather than a refused request', () => {
  // The message matters more here than usual: somebody hitting this is
  // debugging our own data, and a message that read like an access denial
  // would send them looking for a caller that does not exist.
  assert.throws(
    () => resolveArtifact(ROOT, '../secrets.png'),
    (error: unknown) =>
      error instanceof ArtifactPathError && /constructed path that is wrong/.test(error.message),
  );
});
