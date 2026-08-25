import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import type { BrowserSession, TabHandle } from '../../src/browser/driver.ts';
import { type RasterImage, encodePng } from '../../src/diff/image.ts';
import { DEFAULT_DIFF_SETTINGS } from '../../src/diff/settings.ts';
import { claimInput, withBroker, type BrokerFixture } from '../helpers/broker.ts';
import {
  FAINT_GREY,
  WHITE,
  changedPairs,
  cleanPair,
  filled,
  withRectangle,
} from '../helpers/images.ts';

/**
 * The join between a capture and the comparison it names (`SCHEMA.md` §3.11,
 * §1.9).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE EXISTS TO CATCH, STATED AS THE DEFECT IT FOUND
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `browser_capture` **declared `compare_to` and dropped it.** The tool table
 * advertised the argument, the bridge's capture case read `full_page` and
 * `selector` and nothing else, `CaptureInput` had no field to put it in, and
 * `runComparison` — a complete, tested, reviewed diff implementation — had
 * **zero callers anywhere in `src/`**. A caller could pass a real earlier
 * capture identifier, get back a successful capture, and find no `comparisons`
 * row and no explanation. The surface promised what nothing implemented.
 *
 * So every test here drives **the service**, through `broker.capture`, rather
 * than calling `runComparison` directly. That is the whole point: the diff
 * arithmetic already had thorough tests (`tests/diff/`) and they all passed
 * throughout the entire period the feature was unreachable. **A test that
 * calls `runComparison` cannot fail for the reason this feature was broken.**
 *
 * ── The fixture rule this file is careful about ─────────────────────────
 *
 * A pair of images that differ so obviously that any comparison reports a
 * change proves nothing — it passes equally against a correct implementation
 * and against one that reports "changed" unconditionally. So the assertions
 * below are anchored on three things a blanket answer cannot satisfy at once:
 *
 * 1. **A known-clean pair must report no change** and write a row saying so.
 * 2. **A thin line must survive**, which a size filter without the allowance
 *    would eat — so "found something" is not enough, the region has to be
 *    *where the line was*.
 * 3. **A change fainter than the tolerance must report no change**, which is
 *    the same output as (1) from a different cause, and separates "reports
 *    what it sees" from "reports nothing ever".
 */

const CAPTURE_WIDTH = 800;
const CAPTURE_HEIGHT = 200;

/**
 * A browser that serves images a test chose, one per shutter.
 *
 * **The queue is the mechanism.** A capture is a moment, and the thing under
 * test is what happens when two moments differ — so the driver hands back a
 * different picture on each call rather than the same blank field twice. The
 * last image is repeated once the queue is exhausted, so a test that captures
 * a third time to prove nothing changed does not have to restate the picture.
 */
function imageServingSession(
  images: readonly RasterImage[],
  /**
   * Distinguishes this fixture's tabs from another fixture's.
   *
   * Needed because the counter below is per-session: two sessions in one test
   * each hand back their first tab as number one, which collides on the same
   * uniqueness constraint a constant would. Defaulted, so the single-session
   * tests say nothing about it.
   */
  name = 'a',
): {
  readonly session: BrowserSession;
  readonly shutters: () => number;
} {
  let taken = 0;
  let opened = 0;
  const session = {
    // **A fresh driver tab identifier per open.** `tabs` carries a uniqueness
    // constraint on `(browser_id, driver_tab_id)`, so a fixture handing back a
    // constant makes the *second* lease's capture fail on a database
    // constraint inside the after-commit work — where it is swallowed, so the
    // call still reports `accepted` and the test sees an absent capture with
    // no obvious cause. Found exactly that way while writing this file.
    openTab: async () => {
      opened += 1;
      return await Promise.resolve({
        driverTabId: `driver-tab-${name}-${String(opened)}`,
        handle: {},
      });
    },
    closeTab: async () => await Promise.resolve(),
    navigate: async () => await Promise.resolve({ url: 'https://example.com/', title: 'A page' }),
    act: async () => await Promise.resolve({ ok: true }),
    read: async (_tab: TabHandle, artifacts: readonly string[]) =>
      await Promise.resolve(
        artifacts.map((artifact) => ({ artifact, path: 'a/path', bytes: 1, truncated: false })),
      ),
    cookies: async () => await Promise.resolve([]),
    seedStorage: async () => await Promise.resolve(),
    evaluate: async () => await Promise.resolve({ value: null, bytes: 4 }),
    settlePage: async () => await Promise.resolve(),
    capture: async () => {
      const image = images[Math.min(taken, images.length - 1)];
      if (image === undefined) throw new Error('the fixture needs at least one image');
      taken += 1;
      return await Promise.resolve({
        image: encodePng(image),
        width: image.width,
        height: image.height,
        viewportWidth: image.width,
        url: 'https://example.com/',
      });
    },
  } as unknown as BrowserSession;

  return { session, shutters: () => taken };
}

async function grantedLease(fixture: BrokerFixture): Promise<{ key: string; tabId: string }> {
  const granted = await fixture.broker.claim(claimInput());
  assert.equal(granted.outcome, 'granted', 'the fixture needs a granted lease');
  if (granted.outcome !== 'granted') throw new Error('unreachable');
  return { key: granted.key, tabId: granted.tabId };
}

/**
 * Comparisons as they **committed**, read through the second connection.
 *
 * The house rule: a read through the store's own handle sees uncommitted work,
 * so it cannot distinguish a row that is durable from one about to roll back.
 */
function committedComparisons(fixture: BrokerFixture): {
  id: string;
  changed: number;
  truncated: number;
  regions: string;
  overlay_path: string;
  source_capture_id: string;
  target_capture_id: string;
  colour_tolerance: number;
}[] {
  return fixture.readCommitted(
    `SELECT id, changed, truncated, regions, overlay_path, source_capture_id,
            target_capture_id, colour_tolerance
       FROM comparisons ORDER BY at, id`,
  );
}

test('a capture naming an earlier one writes a comparisons row and returns the diff', async () => {
  const pair = changedPairs().find((entry) => entry.name === 'a block repainting');
  assert.ok(pair !== undefined, 'the fixture set must carry the unmissable-change pair');

  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = imageServingSession([pair.earlier, pair.current]);

    const first = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
    });
    assert.ok(first.capture !== undefined, 'the first capture must have been written');

    // Nothing was compared, because nothing was named — and the field is
    // absent rather than a null-ish result, which is what distinguishes "you
    // did not ask" from "it could not run".
    assert.equal(
      first.comparison,
      undefined,
      'a capture that named no target must carry no comparison at all',
    );
    assert.equal(
      committedComparisons(fixture).length,
      0,
      'naming no target must write no comparisons row',
    );

    const second = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
      compareTo: first.capture.captureId,
    });

    // ── The result the caller gets back ────────────────────────────────
    assert.ok(second.capture !== undefined, 'the second capture is still taken');
    const comparison = second.comparison;
    assert.ok(comparison !== undefined, 'naming a target must produce a comparison');
    assert.equal(comparison.diffed, true, 'the comparison ran');
    assert.equal(comparison.changed, true, 'a whole block repainting must be reported as changed');

    // `compared_against` echoed back rather than assumed (§1.9).
    assert.deepEqual(
      comparison.comparedAgainst,
      { captureId: first.capture.captureId, path: first.capture.path },
      'the capture the caller named must be echoed back, id and path',
    );
    assert.equal(comparison.truncated, false, 'five regions is under the cap of twelve');

    // ── The row that committed ─────────────────────────────────────────
    const rows = committedComparisons(fixture);
    assert.equal(rows.length, 1, 'exactly one comparisons row must have committed');
    const row = rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.id, comparison.comparisonId, 'the row returned is the row written');
    assert.equal(row.changed, 1);
    assert.equal(row.source_capture_id, second.capture.captureId);
    assert.equal(row.target_capture_id, first.capture.captureId);
    // The settings are copied onto the row, which is §1.9's whole argument for
    // the table existing: a rerun after tuning answers a different question.
    assert.equal(row.colour_tolerance, DEFAULT_DIFF_SETTINGS.colourTolerance);

    // ── The crops on disk ──────────────────────────────────────────────
    //
    // Asserted as **files that exist**, not as paths that were returned. A
    // path in a result is a string; the feature's promise is a picture.
    assert.ok(comparison.regions.length > 0, 'a change must produce at least one region');
    for (const region of comparison.regions) {
      for (const stored of [region.beforePath, region.afterPath]) {
        const bytes = await fs.readFile(fixture.artifacts.resolve(stored));
        assert.ok(bytes.byteLength > 0, `${stored} must be a real file with contents`);
      }
    }
    const overlay = comparison.overlayPath;
    assert.ok(overlay !== null, 'a comparison that ran writes an overlay');
    assert.ok(
      (await fs.readFile(fixture.artifacts.resolve(overlay))).byteLength > 0,
      'the overlay must be on disk',
    );

    // The region has to be **where the change was**, not merely somewhere. A
    // comparison reporting one region covering the whole page would satisfy
    // "found something" and be useless.
    const target = pair.changedAt;
    assert.ok(target !== null);
    assert.ok(
      comparison.regions.some(
        (region) =>
          region.x <= target.x + target.width &&
          region.x + region.width >= target.x &&
          region.y <= target.y + target.height &&
          region.y + region.height >= target.y,
      ),
      'the reported region must overlap the rectangle the fixture actually changed',
    );
  });
});

test('a known-clean pair reports no change, and still records that it looked', async () => {
  const clean = cleanPair();

  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = imageServingSession([clean.earlier, clean.current]);

    const first = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
    });
    assert.ok(first.capture !== undefined);

    const second = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
      compareTo: first.capture.captureId,
    });

    const comparison = second.comparison;
    assert.ok(comparison !== undefined);
    // **The two halves that must not be collapsed.** It ran, and it found
    // nothing — which is a different answer from "it could not run", and the
    // control that stops every other assertion in this file being satisfied
    // by an implementation that reports a change unconditionally.
    assert.equal(comparison.diffed, true, 'the comparison ran');
    assert.equal(comparison.changed, false, 'two identical pages must report no change');
    assert.equal(comparison.regions.length, 0, 'nothing changed, so there is nothing to crop');
    assert.equal(comparison.changedPixels, 0);

    // The row is still written. A comparison that found nothing is exactly
    // what tuning needs to see — §1.9's warning is that a run of unchanged
    // rows at a raised tolerance is indistinguishable from the feature working.
    const rows = committedComparisons(fixture);
    assert.equal(rows.length, 1, 'a clean comparison is still recorded');
    assert.equal(rows[0]?.changed, 0, 'and recorded as unchanged');
  });
});

test('a thin line survives the size filter, at the same geometry', async () => {
  // The ordinary review case: **only pixels change, the page stays the same
  // size.** A resize changes geometry and takes a different branch entirely,
  // so a suite that only ever resized would never exercise this one.
  const underline = changedPairs().find(
    (entry) => entry.name === 'an underline under one short word',
  );
  assert.ok(underline !== undefined, 'the fixture set must carry the thin-underline pair');

  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = imageServingSession([underline.earlier, underline.current]);

    const first = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
    });
    assert.ok(first.capture !== undefined);

    const second = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
      compareTo: first.capture.captureId,
    });

    const comparison = second.comparison;
    assert.ok(comparison !== undefined);
    assert.equal(comparison.diffed, true);
    // Area 44, below the default minimum of 64 — **only the thin-line
    // allowance keeps this**. Dropping the allowance leaves this region
    // filtered out and `changed` false, which is precisely the change a
    // reviewer most needs to see and least expects to be dropped.
    assert.equal(
      comparison.changed,
      true,
      'a two-pixel underline must survive: its area is below the minimum and only the thin-line allowance keeps it',
    );

    const target = underline.changedAt;
    assert.ok(target !== null);
    assert.ok(
      comparison.regions.some(
        (region) =>
          region.x <= target.x + target.width &&
          region.x + region.width >= target.x &&
          region.y <= target.y + target.height &&
          region.y + region.height >= target.y,
      ),
      'the region must be where the underline was drawn',
    );

    // Both geometries identical, so neither the width mismatch nor the page
    // length branch may fire — this is the pixels-only case.
    assert.equal(comparison.widthMismatch, false);
    assert.equal(comparison.pageLengthChange, null);
  });
});

test('a change fainter than the tolerance reports no change, at the pinned default', async () => {
  // The mirror of the clean pair, and the reason it matters: this pair is
  // **genuinely different**, and the correct answer is still "nothing
  // changed", because the default tolerance is deliberately insensitive. A
  // fixture set without this case cannot tell a working threshold from one
  // that reports every non-identical pair.
  const base = filled(CAPTURE_WIDTH, CAPTURE_HEIGHT, WHITE);
  const faint = withRectangle(base, { x: 100, y: 60, width: 200, height: 40 }, FAINT_GREY);

  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    // Grey 220 on white **is** caught at the default tolerance of 0.1 — the
    // measured table in `helpers/images.ts` records it as the faintest that
    // is. So this asserts the catch, and the next block asserts the miss just
    // beyond it, which together pin the cutoff from both sides.
    const driver = imageServingSession([base, faint]);

    const first = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
    });
    assert.ok(first.capture !== undefined);

    const second = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
      compareTo: first.capture.captureId,
    });
    assert.equal(
      second.comparison?.changed,
      true,
      'grey 220 on white is inside the default tolerance and must be caught',
    );
  });

  // Just beyond the measured cutoff: grey 232 is invisible at the default.
  const nearlyWhite = withRectangle(
    base,
    { x: 100, y: 60, width: 200, height: 40 },
    { red: 232, green: 232, blue: 232, alpha: 255 },
  );

  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = imageServingSession([base, nearlyWhite]);

    const first = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
    });
    assert.ok(first.capture !== undefined);

    const second = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
      compareTo: first.capture.captureId,
    });
    assert.equal(
      second.comparison?.diffed,
      true,
      'the comparison ran — this is a threshold outcome, not a failure to run',
    );
    assert.equal(
      second.comparison?.changed,
      false,
      'a change fainter than roughly grey 225 on white is not reported at the default tolerance',
    );
  });
});

test('a missing target returns the full screenshot with an explanation, never a refusal', async () => {
  const pair = changedPairs()[0];
  assert.ok(pair !== undefined);

  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = imageServingSession([pair.earlier, pair.current]);

    // **No capture is taken first.** The identifier below names nothing at
    // all, which is §1.9's stated ordinary case: "the ordinary reason it does
    // not find it is that the caller named the wrong thing".
    const result = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
      compareTo: 'a-capture-that-does-not-exist',
    });

    // ── The picture, which is the whole point ──────────────────────────
    //
    // The caller asked for a screenshot and gets a screenshot. This is the
    // assertion that would fail if a later edit turned the missing target
    // into a refusal, which is the settled design decision most likely to be
    // "tidied" by somebody who reads a failed lookup as an error.
    assert.ok(
      result.capture !== undefined,
      'the capture must be returned in full: a diff is an optional argument and may not withhold the picture',
    );
    assert.ok(result.capture.path.length > 0, 'and it must name a real written file');
    assert.ok(
      (await fs.readFile(fixture.artifacts.resolve(result.capture.path))).byteLength > 0,
      'the screenshot must actually be on disk, not merely named',
    );
    assert.equal(result.pageDriven, true, 'the page was driven and the shutter did fire');

    // ── The explanation, rather than silence ───────────────────────────
    const comparison = result.comparison;
    assert.ok(comparison !== undefined, 'asking for a diff must produce an answer about the diff');
    assert.equal(comparison.diffed, false, 'no comparison ran');
    assert.equal(comparison.changed, false, 'and `changed` is false because nothing was compared');
    assert.equal(comparison.comparisonId, null, 'nothing was recorded');
    assert.ok(
      comparison.explanation !== null && comparison.explanation.length > 0,
      'a diff that did not happen must say so in plain words',
    );
    assert.match(
      comparison.explanation,
      /no capture with the identifier/i,
      'the explanation must name the problem: the identifier found nothing',
    );

    // No row, because no comparison happened. `diffed: false` and an empty
    // table have to agree, or the listing surface would show a diff that did
    // not run.
    assert.equal(
      committedComparisons(fixture).length,
      0,
      'a comparison that did not run must write no row',
    );
  });
});

test('another lease’s capture is refused as indistinguishable from one that does not exist', async () => {
  const clean = cleanPair();

  await withBroker(async (fixture) => {
    const mine = await grantedLease(fixture);
    const theirs = await grantedLease(fixture);
    // **A driver each.** The queue is per-session, so sharing one would let
    // the first lease's capture consume the image the second lease is about
    // to be asserted against.
    const theirDriver = imageServingSession([clean.earlier], 'theirs');
    const myDriver = imageServingSession([clean.current], 'mine');

    const theirCapture = await fixture.broker.capture({
      key: theirs.key,
      tabId: theirs.tabId,
      session: () => theirDriver.session,
      artifacts: fixture.artifacts,
    });
    assert.ok(theirCapture.capture !== undefined);

    const mineResult = await fixture.broker.capture({
      key: mine.key,
      tabId: mine.tabId,
      session: () => myDriver.session,
      artifacts: fixture.artifacts,
      compareTo: theirCapture.capture.captureId,
    });

    // **Asserted before the comparison is read**, because every failure in
    // after-commit work is swallowed by design: a capture that died on a
    // database constraint also returns `comparison: undefined`, and without
    // this line the test would pass for a reason that has nothing to do with
    // ownership. That is not hypothetical — a constant driver-tab identifier
    // in this fixture produced exactly that false pass.
    assert.equal(
      mineResult.pageDriven,
      true,
      'the capture itself must have succeeded, or the missing comparison proves nothing about ownership',
    );

    const comparison = mineResult.comparison;
    assert.ok(comparison !== undefined);
    assert.equal(comparison.diffed, false, 'another lease’s capture is not comparable');
    // **The identical sentence** a wholly unknown identifier produces.
    // Distinguishing them would turn `compare_to` into a way to enumerate
    // other leases' captures by watching which identifiers answer differently.
    assert.match(comparison.explanation ?? '', /no capture with the identifier/i);
    assert.ok(
      mineResult.capture !== undefined,
      'and the picture is still returned, as for any other diff that could not run',
    );
  });
});

test('the diff settings are one snapshot, and they land on the row that used them', async () => {
  const pair = changedPairs().find((entry) => entry.name === 'a block repainting');
  assert.ok(pair !== undefined);

  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = imageServingSession([pair.earlier, pair.current]);

    const first = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
    });
    assert.ok(first.capture !== undefined);

    const second = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
      artifacts: fixture.artifacts,
      compareTo: first.capture.captureId,
    });

    // The settings the result reports and the settings on the row have to be
    // the same three numbers. Two snapshots taken at different instants would
    // let a row describe a configuration no call ever ran under.
    const comparison = second.comparison;
    assert.ok(comparison !== undefined);
    const rows = committedComparisons(fixture);
    assert.equal(rows[0]?.colour_tolerance, comparison.settingsApplied.colourTolerance);
    assert.equal(
      comparison.settingsApplied.colourTolerance,
      DEFAULT_DIFF_SETTINGS.colourTolerance,
      'with nothing set in the environment, the shipped default is what ran',
    );
  });
});
