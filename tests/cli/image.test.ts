import assert from 'node:assert/strict';
import test from 'node:test';

import type { Database } from 'better-sqlite3';

import { ArtifactStore } from '../../src/artifacts/store.ts';
import {
  captureLookup,
  IMAGE_EXIT,
  NOT_FOUND_MESSAGE,
  parseImageArguments,
  runImage,
} from '../../src/cli/image.ts';
import { decodePng } from '../../src/diff/image.ts';
import { DEFAULT_DIFF_SETTINGS } from '../../src/diff/settings.ts';
import { ARTIFACT_NOT_FOUND_MESSAGE } from '../../src/service/artifacts.ts';
import { insertComparison } from '../../src/service/comparison-store.ts';
import { runComparison } from '../../src/service/comparison.ts';
import { hashKey } from '../../src/service/keys.ts';
import { prepareStore } from '../../src/store/open.ts';
import {
  insertCapture,
  insertClaim,
  insertTab,
  storeBackedCaptureSource,
} from '../helpers/comparison-fixtures.ts';
import { BLACK, WHITE, filled, withRectangle } from '../helpers/images.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * `broker image` — delivering the bytes (`MILESTONES.md` #49, `SCHEMA.md` §1.9).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN OF THIS FILE MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **What it means:** the command serves real bytes for a capture and for a
 * crop through **one shape**, writes them only for the lease that owns them,
 * and refuses everything else in one indistinguishable sentence.
 *
 * **What it does not mean:** that traversal is impossible because these
 * refusals hold. §1.9's mechanism is the *absence of a path-shaped input*
 * rather than validation — and **these tests cannot express a traversal attempt
 * at all**, because no argument on this command selects a file to read. That
 * absence is enforced as a build rule by `scripts/check-artifact-path.mjs`,
 * which is the thing that would catch somebody adding one. This file is the
 * weaker of the two on that specific question, deliberately, and says so.
 *
 * ── The fixture trap this file has to avoid ─────────────────────────────
 *
 * "One shape" is the claim, and the way to test it wrongly is to assert each
 * shape separately — capture writes a file, crop writes a file — which passes
 * just as happily if the two return **different** shapes. So the one-shape
 * tests below compare the two outputs **against each other**, structurally,
 * rather than each against a fixed expectation.
 */

interface Harness {
  readonly db: Database;
  readonly artifacts: ArtifactStore;
  readonly leaseKey: string;
  readonly otherLeaseKey: string;
  readonly captureId: string;
  readonly comparisonId: string;
  readonly regionCount: number;
}

const LEASE_KEY = 'a-key-this-test-controls';
const OTHER_LEASE_KEY = 'a-different-lease-entirely';

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const temp = makeTempStore();
  try {
    const store = await prepareStore(temp.environment);
    try {
      const artifacts = new ArtifactStore(temp.environment.artifactsRoot);

      const claimId = insertClaim(store.db);
      const tabId = insertTab(store.db, claimId);
      // The lease is found by hashing the key, so the fixture writes the hash
      // the command will compute rather than a value it would never match.
      store.db
        .prepare('UPDATE claims SET key_hash = ? WHERE id = ?')
        .run(hashKey(LEASE_KEY), claimId);

      const otherClaimId = insertClaim(store.db);
      store.db
        .prepare('UPDATE claims SET key_hash = ? WHERE id = ?')
        .run(hashKey(OTHER_LEASE_KEY), otherClaimId);

      const before = filled(120, 90, WHITE);
      const after = withRectangle(
        filled(120, 90, WHITE),
        { x: 20, y: 20, width: 40, height: 30 },
        BLACK,
      );

      const target = await insertCapture(store.db, { claimId, tabId, image: before, artifacts });
      const current = await insertCapture(store.db, { claimId, tabId, image: after, artifacts });

      const source = storeBackedCaptureSource(store.db, artifacts);
      const result = await runComparison({
        capture: current,
        captureBytes: await source.readBytes(current),
        targetCaptureId: target.id,
        source,
        settings: DEFAULT_DIFF_SETTINGS,
        artifacts,
        writeRow: (row) => insertComparison(store.db, row),
      });

      await fn({
        db: store.db,
        artifacts,
        leaseKey: LEASE_KEY,
        otherLeaseKey: OTHER_LEASE_KEY,
        captureId: current.id,
        comparisonId: result.comparisonId ?? '',
        regionCount: result.regions.length,
      });
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
}

/** Run the command, capturing the bytes it wrote instead of touching a disk. */
async function invoke(
  harness: Harness,
  argv: readonly string[],
): Promise<{ code: number; out: string[]; err: string[]; written: Map<string, Uint8Array> }> {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, Uint8Array>();

  const code = await runImage(argv, {
    db: harness.db,
    artifacts: harness.artifacts,
    streams: { out: (l) => out.push(l), err: (l) => err.push(l) },
    write: (destination, bytes) => {
      written.set(destination, bytes);
      return Promise.resolve();
    },
  });

  return { code, out, err, written };
}

// ══════════════════════════════════════════════════════════════════════════
// One endpoint, one return shape
// ══════════════════════════════════════════════════════════════════════════

test('ONE SHAPE: a capture and a crop arrive identically, differing only in the bytes', async () => {
  await withHarness(async (harness) => {
    const capture = await invoke(harness, [
      '--lease-key',
      harness.leaseKey,
      '--capture',
      harness.captureId,
      '--out',
      'capture.png',
      '--json',
    ]);
    const crop = await invoke(harness, [
      '--lease-key',
      harness.leaseKey,
      '--region',
      harness.comparisonId,
      '--out',
      'crop.png',
      '--json',
    ]);

    assert.equal(capture.code, IMAGE_EXIT.served);
    assert.equal(crop.code, IMAGE_EXIT.served, 'a crop must be served exactly as a capture is');

    // **Compared against each other, not against a fixed expectation.** Two
    // separate assertions that each output "looks right" would pass even if
    // the two shapes differed, which is the whole claim under test.
    const first = JSON.parse(capture.out[0] ?? '{}') as Record<string, unknown>;
    const second = JSON.parse(crop.out[0] ?? '{}') as Record<string, unknown>;

    assert.deepEqual(
      Object.keys(first).sort(),
      Object.keys(second).sort(),
      'the two responses must have the same fields',
    );
    assert.deepEqual(
      Object.keys(first['value'] as object).sort(),
      Object.keys(second['value'] as object).sort(),
      'and the same fields inside the value',
    );
    assert.equal(first['outcome'], second['outcome'], 'and report the same outcome');
  });
});

test('the bytes are a real image, and a crop is genuinely smaller than its capture', async () => {
  await withHarness(async (harness) => {
    const capture = await invoke(harness, [
      '--lease-key',
      harness.leaseKey,
      '--capture',
      harness.captureId,
      '--out',
      'capture.png',
    ]);
    const crop = await invoke(harness, [
      '--lease-key',
      harness.leaseKey,
      '--region',
      harness.comparisonId,
      '--out',
      'crop.png',
    ]);

    // Decoded rather than merely counted: a test asserting "some bytes were
    // written" passes on any garbage, including an empty buffer.
    const whole = decodePng(Buffer.from(capture.written.get('capture.png') ?? new Uint8Array()));
    const piece = decodePng(Buffer.from(crop.written.get('crop.png') ?? new Uint8Array()));

    assert.equal(whole.width, 120);
    assert.equal(whole.height, 90);
    assert.ok(
      piece.width < whole.width && piece.height < whole.height,
      `a crop should be smaller than the capture it came from; got ${String(piece.width)}x${String(piece.height)}`,
    );
  });
});

test('NO SIZE BRANCH: a crop is written to the file exactly as a capture is', async () => {
  // §1.9 rejects returning small crops inline and paths for large ones, because
  // you cannot know a diff is small. This asserts the consequence directly:
  // both kinds put their bytes in the same place, so nothing about the delivery
  // depends on how big the result turned out to be.
  await withHarness(async (harness) => {
    const capture = await invoke(harness, [
      '--lease-key',
      harness.leaseKey,
      '--capture',
      harness.captureId,
      '--out',
      'a.png',
    ]);
    const crop = await invoke(harness, [
      '--lease-key',
      harness.leaseKey,
      '--region',
      harness.comparisonId,
      '--out',
      'b.png',
    ]);

    assert.equal(capture.written.size, 1, 'a capture writes exactly one file');
    assert.equal(crop.written.size, 1, 'and so does a crop, however small it is');
    assert.ok(capture.written.has('a.png'));
    assert.ok(crop.written.has('b.png'));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Only this lease's artifacts, and one indistinguishable refusal
// ══════════════════════════════════════════════════════════════════════════

test("ANOTHER LEASE'S ARTIFACT IS REFUSED, and nothing is written", async () => {
  await withHarness(async (harness) => {
    const stolen = await invoke(harness, [
      '--lease-key',
      harness.otherLeaseKey,
      '--capture',
      harness.captureId,
      '--out',
      'stolen.png',
    ]);

    assert.equal(stolen.code, IMAGE_EXIT.refused);
    // The physical side-effect is what matters: a refusal that still wrote the
    // file would be a refusal in name only.
    assert.equal(stolen.written.size, 0, 'a refused request must not write anything');
  });
});

test('NOT YOURS, NOT THERE, AND A KEY THAT NAMES NOTHING ARE INDISTINGUISHABLE', async () => {
  await withHarness(async (harness) => {
    const notYours = await invoke(harness, [
      '--lease-key',
      harness.otherLeaseKey,
      '--capture',
      harness.captureId,
      '--out',
      'x.png',
    ]);
    const notThere = await invoke(harness, [
      '--lease-key',
      harness.leaseKey,
      '--capture',
      'no-such-capture-at-all',
      '--out',
      'x.png',
    ]);
    const noLease = await invoke(harness, [
      '--lease-key',
      'a-key-belonging-to-nobody',
      '--capture',
      harness.captureId,
      '--out',
      'x.png',
    ]);

    // §1.9: the same non-disclosing wording, "so probing cannot discover
    // another lease's files". A caller able to tell these three apart is a
    // caller able to enumerate what exists.
    assert.deepEqual(
      [notYours.err.join('\n'), notThere.err.join('\n')],
      [noLease.err.join('\n'), noLease.err.join('\n')],
      'the three refusals must be byte-identical',
    );
    assert.equal(notYours.code, noLease.code);
    assert.equal(notThere.code, noLease.code);
  });
});

test('the refusal wording is the SAME STRING the service uses, not a second copy', () => {
  // Two spellings of one deliberately-identical message is how they come to
  // disagree, and the disagreement would silently reopen the enumeration hole.
  assert.equal(NOT_FOUND_MESSAGE, ARTIFACT_NOT_FOUND_MESSAGE);
});

test('the lease key is never printed, on success or on refusal (§5.6)', async () => {
  await withHarness(async (harness) => {
    const served = await invoke(harness, [
      '--lease-key',
      harness.leaseKey,
      '--capture',
      harness.captureId,
      '--out',
      'x.png',
      '--json',
    ]);
    const refused = await invoke(harness, [
      '--lease-key',
      harness.leaseKey,
      '--capture',
      'nothing-here',
      '--out',
      'x.png',
    ]);

    for (const line of [...served.out, ...served.err, ...refused.out, ...refused.err]) {
      assert.ok(!line.includes(harness.leaseKey), `the key appeared in output: ${line}`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The arguments name rows, and refuse rather than guess
// ══════════════════════════════════════════════════════════════════════════

test('exactly one artifact is named — none and two are both refused', () => {
  const none = parseImageArguments(['--lease-key', 'k', '--out', 'x.png']);
  assert.equal(none.ok, false);

  const two = parseImageArguments([
    '--lease-key',
    'k',
    '--capture',
    'a',
    '--overlay',
    'b',
    '--out',
    'x.png',
  ]);
  assert.equal(two.ok, false);
  // Named in the message, so the person can see which two they passed.
  assert.match(two.ok ? '' : two.message, /--capture and --overlay/);
});

test('an unrecognised flag refuses rather than being ignored', () => {
  const parsed = parseImageArguments([
    '--lease-key',
    'k',
    '--capture',
    'a',
    '--out',
    'x.png',
    '--full-page',
  ]);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.message, /--full-page/);
});

test('--index and --side are refused where they mean nothing', () => {
  const parsed = parseImageArguments([
    '--lease-key',
    'k',
    '--capture',
    'a',
    '--index',
    '2',
    '--out',
    'x.png',
  ]);
  assert.equal(parsed.ok, false, 'they describe a region, so they only apply to --region');
});

test('a region defaults to the largest, from the new capture', () => {
  const parsed = parseImageArguments(['--lease-key', 'k', '--region', 'c', '--out', 'x.png']);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.request : null, {
    kind: 'region',
    comparisonId: 'c',
    // The list is ordered largest first (§1.9).
    index: 0,
    side: 'after',
  });
});

test('--side takes only the two sides a crop can come from', () => {
  const wrong = parseImageArguments([
    '--lease-key',
    'k',
    '--region',
    'c',
    '--side',
    'middle',
    '--out',
    'x.png',
  ]);
  assert.equal(wrong.ok, false);

  const right = parseImageArguments([
    '--lease-key',
    'k',
    '--region',
    'c',
    '--side',
    'before',
    '--out',
    'x.png',
  ]);
  assert.equal(right.ok, true);
});

test('--out is required, because an image on a terminal is not an image', () => {
  const parsed = parseImageArguments(['--lease-key', 'k', '--capture', 'a']);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.message, /--out/);
});

test('--lease-key is required: an artifact belongs to the lease that took it', () => {
  const parsed = parseImageArguments(['--capture', 'a', '--out', 'x.png']);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.message, /--lease-key/);
});

test('a malformed call exits differently from a refused one', async () => {
  await withHarness(async (harness) => {
    const malformed = await invoke(harness, ['--capture', 'a', '--out', 'x.png']);
    assert.equal(malformed.code, IMAGE_EXIT.malformed);
    assert.notEqual(
      malformed.code,
      IMAGE_EXIT.refused,
      'a caller that typed the command wrong has a different problem from one refused',
    );
  });
});

test('the capture lookup finds a row by identifier and reports its owner', async () => {
  await withHarness((harness) => {
    const found = captureLookup(harness.db).find(harness.captureId);
    assert.notEqual(found, null);
    assert.ok((found?.path ?? '').length > 0, 'the stored path is what gets resolved');

    assert.equal(
      captureLookup(harness.db).find('not-a-capture'),
      null,
      'and an unknown identifier finds nothing rather than throwing',
    );
    return Promise.resolve();
  });
});
