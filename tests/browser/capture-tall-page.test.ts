import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ArtifactStore } from '../../src/artifacts/store.ts';
import { RealBrowserDriver } from '../../src/browser/real.ts';
import { takeCapture } from '../../src/capture/pipeline.ts';
import { describeReduction } from '../../src/capture/tiers.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { teardownBrowser, temporaryProfileRoot } from '../helpers/browser-fixture.ts';

/**
 * The tall-page capture defect, proved on a **real** browser.
 *
 * ── Why a real browser, and not the fake ────────────────────────────────
 *
 * The fake driver returns a fixed 1280 x 720 and **ignores `fullPage`
 * entirely**. So a fake-driven test cannot produce a tall picture unless the
 * test itself hands one over — which means the fake can check what the
 * pipeline does with a tall image, but it is structurally incapable of
 * checking that asking for a full page *produces* one. That gap is exactly
 * the shape of the defect this file exists for: a page six screens tall came
 * back at about sixteen per cent, and every fake-based test in the suite was
 * blind to it because no fake-based test had a tall page to be blind about.
 *
 * A sibling suite makes the same point in its own words: the drawn fixtures
 * are exact but synthetic, and a real browser is the only thing that can say
 * what a real page measures.
 *
 * ── What is asserted, and what deliberately is not ──────────────────────
 *
 * **Not** that a particular page yields particular dimensions — that would be
 * a test of one article's length. What is asserted is the *relationship* the
 * defect broke:
 *
 * 1. A page far taller than the viewport is written **narrower than its own
 *    width** — the reduction is real, and the test says so rather than
 *    assuming it.
 * 2. The response **says** it was reduced. That is the defect: it did not.
 * 3. A higher rung **returns more pixels**. That is the second defect: the
 *    tier was validated, carried, and dropped before the pipeline saw it, so
 *    every rung returned the same picture.
 *
 * ── Every browser this file starts is reaped, including on failure ──────
 *
 * `teardownBrowser` runs in a `finally`, so a failing assertion above still
 * ends the browser it started. The teardown is scoped to the handle this file
 * created and touches nothing else on the machine.
 */

const available = browserAvailable();

/**
 * A page that is genuinely taller than any rung, built rather than fetched.
 *
 * **Local, so the test does not depend on a network or on somebody else's
 * article staying long.** The prose is real text at a real font size, because
 * the question the reduction bears on is whether text survives, and a page of
 * solid colour would shrink just as far while proving nothing about that.
 */
function tallPage(lines: number): string {
  const body = Array.from(
    { length: lines },
    (_, index) => `<p>Line ${String(index)}: minimum illumination in a nimble mnemonic manner.</p>`,
  ).join('');
  return `data:text/html,${encodeURIComponent(
    `<body style="margin:0;font:14px sans-serif;width:100%">${body}</body>`,
  )}`;
}

test(
  'a full-page capture of a REAL tall page is reduced, and the response says so',
  { skip: available ? false : skipReason() },
  async () => {
    const root = temporaryProfileRoot();
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });
    const session = await driver.coldStart({
      browser: 'regular',
      profileDirectory: path.join(root, 'regular'),
      mode: 'headed',
    });
    const artifacts = new ArtifactStore(path.join(root, 'artifacts'));

    try {
      const tab = await session.openTab();
      await session.navigate(tab, tallPage(400));

      const base = await takeCapture(
        { tabs: session, artifacts },
        'claim-tall',
        tab,
        {
          fullPage: true,
        },
        0,
      );

      // The page really is taller than it is wide, or the rest asserts nothing.
      assert.ok(
        base.sourceHeight > base.sourceWidth * 2,
        `the fixture page is not tall: ${String(base.sourceWidth)}x${String(base.sourceHeight)}`,
      );

      // ── 1. The reduction is real ──────────────────────────────────────
      assert.ok(
        base.width < base.sourceWidth,
        `a page ${String(base.sourceWidth)} wide was written at ${String(base.width)} — ` +
          'if this ever stops being true the cap has changed and the rest of this test is stale',
      );

      // ── 2. It is disclosed ────────────────────────────────────────────
      //
      // Asserted against the same helper the service response uses, so this
      // proves the disclosure is derivable from what a real browser produced
      // rather than only from numbers a test made up.
      const reduced = describeReduction(
        { width: base.sourceWidth, height: base.sourceHeight },
        { width: base.width, height: base.height },
        base.tier,
      );
      assert.ok(reduced, 'a real tall page was crushed and nothing reported it');
      assert.ok(
        reduced.scale < 0.5,
        `expected a substantial reduction, got ${String(reduced.scale)}`,
      );
      assert.match(reduced.note, /REDUCED/);

      // ── 3. The rung reaches the pipeline ──────────────────────────────
      const detail = await takeCapture(
        { tabs: session, artifacts },
        'claim-tall',
        tab,
        {
          fullPage: true,
          tier: 'detail',
        },
        1,
      );
      const max = await takeCapture(
        { tabs: session, artifacts },
        'claim-tall',
        tab,
        {
          fullPage: true,
          tier: 'max',
          reason:
            'Verifying on a real browser that the top rung returns more pixels than the default.',
        },
        2,
      );

      assert.ok(
        detail.width > base.width,
        `tier="detail" returned no more pixels than the default on a real page: ${String(detail.width)} vs ${String(base.width)}`,
      );
      assert.ok(
        max.width > detail.width,
        `tier="max" returned no more pixels than "detail" on a real page: ${String(max.width)} vs ${String(detail.width)}`,
      );

      // Each picture is genuinely on disk at the size it claims, so none of
      // the above is a number the pipeline reported without writing.
      for (const shot of [base, detail, max]) {
        const written = path.join(artifacts.root, shot.path);
        assert.ok(fs.existsSync(written), `no file at ${shot.path}`);
        assert.ok(fs.statSync(written).size > 0, `an empty file at ${shot.path}`);
      }

      await session.closeTab(tab);
    } finally {
      await teardownBrowser(session, root);
    }
  },
);
