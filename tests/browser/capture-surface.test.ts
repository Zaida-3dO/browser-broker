import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { RealBrowserDriver } from '../../src/browser/real.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { teardownBrowser, temporaryProfileRoot } from '../helpers/browser-fixture.ts';

/**
 * `capture.surface_required` and `foreground.never_moved`, proved on a real
 * browser.
 *
 * ── Why this suite exists rather than a comment claiming the property ────
 *
 * The seam states outright that the correct-surface property is *"owed by row
 * #20"* and is deliberately **not a parameter**, because a parameter would be
 * a way to disable it. A rule with no call site cannot be checked at run time,
 * so what can be checked is the observable consequence: **a capture returns
 * the tab it was asked for**, even when a different tab is in front.
 *
 * That is the whole failure the rule describes — *"in a windowed browser it
 * returns another tab's pixels, with no error, a wrong answer that looks
 * exactly like a right one"*. A wrong answer that looks like a right one is
 * not something a caller can be asked to notice, so it is asserted here.
 *
 * Needs a real browser, so it skips with a stated reason where there is none.
 */

const available = browserAvailable();

/** The centre pixel of a PNG, decoded by the browser that is already running. */
async function centrePixel(
  session: Awaited<ReturnType<RealBrowserDriver['coldStart']>>,
  image: Uint8Array,
): Promise<readonly [number, number, number]> {
  const scratch = await session.openTab();
  try {
    const encoded = Buffer.from(image).toString('base64');
    const evaluated = await session.evaluate(
      scratch,
      `(async () => {
         const img = new Image();
         img.src = 'data:image/png;base64,${encoded}';
         await img.decode();
         const canvas = document.createElement('canvas');
         canvas.width = img.width;
         canvas.height = img.height;
         const context = canvas.getContext('2d');
         context.drawImage(img, 0, 0);
         const data = context.getImageData(
           Math.floor(img.width / 2),
           Math.floor(img.height / 2),
           1,
           1,
         ).data;
         return [data[0], data[1], data[2]];
       })()`,
    );
    const value = evaluated.value as [number, number, number];
    return value;
  } finally {
    await session.closeTab(scratch);
  }
}

test(
  'a capture returns the tab it was ASKED for, not the one in front of it',
  { skip: available ? false : skipReason() },
  async () => {
    const root = temporaryProfileRoot();
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    // Headed, because that is the mode in which a windowed browser could
    // return the wrong surface at all. Headless has no window to photograph,
    // so a headless-only run of this test would assert nothing about the
    // browser the rule exists for.
    const session = await driver.coldStart({
      browser: 'regular',
      profileDirectory: path.join(root, 'regular'),
      mode: 'headed',
    });

    try {
      const background = await session.openTab();
      await session.navigate(
        background,
        'data:text/html,<body style="margin:0;background:rgb(255,0,0);width:100vw;height:100vh"></body>',
      );

      // Opened second, so it is the one in front. Its pixels are the wrong
      // answer, and they are a different colour so the two cannot be confused.
      const foreground = await session.openTab();
      await session.navigate(
        foreground,
        'data:text/html,<body style="margin:0;background:rgb(0,0,255);width:100vw;height:100vh"></body>',
      );

      const shot = await session.capture(background, { fullPage: false });
      const [red, green, blue] = await centrePixel(session, shot.image);

      assert.ok(
        red > 200 && green < 60 && blue < 60,
        `the background tab must capture its own pixels; got rgb(${String(red)},${String(green)},${String(blue)}) — blue would be the foreground tab`,
      );

      // And the picture describes itself honestly.
      assert.ok(shot.width > 0 && shot.height > 0);
      assert.ok(shot.viewportWidth > 0);
      assert.match(shot.url, /^data:text\/html/);

      await session.closeTab(foreground);
      await session.closeTab(background);
    } finally {
      await teardownBrowser(session, root);
    }
  },
);

test(
  'a full-page capture reports the size the browser produced, not the viewport',
  { skip: available ? false : skipReason() },
  async () => {
    const root = temporaryProfileRoot();
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });
    const session = await driver.coldStart({
      browser: 'private',
      profileDirectory: path.join(root, 'private'),
      mode: 'headless',
    });

    try {
      const tab = await session.openTab();
      // Deliberately taller than any viewport, so the two answers differ.
      await session.navigate(
        tab,
        'data:text/html,<body style="margin:0"><div style="height:4000px;background:%230a0"></div></body>',
      );

      const viewportShot = await session.capture(tab, { fullPage: false });
      const fullShot = await session.capture(tab, { fullPage: true });

      // The mutation this catches: reporting the measured viewport instead of
      // reading the image header. `captures.source_*` is what the browser
      // produced, and for a full-page capture that is taller than the
      // viewport by definition.
      assert.ok(
        fullShot.height > viewportShot.height,
        `a full-page capture must be taller than a viewport one; got ${String(fullShot.height)} and ${String(viewportShot.height)}`,
      );

      // The breakpoint is the viewport either way — it is a property of the
      // page, not of how much of it was photographed.
      assert.equal(fullShot.viewportWidth, viewportShot.viewportWidth);

      await session.closeTab(tab);
    } finally {
      await teardownBrowser(session, root);
    }
  },
);

test(
  'settling stops the page moving, so an identical page produces identical pixels',
  { skip: available ? false : skipReason() },
  async () => {
    const root = temporaryProfileRoot();
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });
    const session = await driver.coldStart({
      browser: 'private',
      profileDirectory: path.join(root, 'private'),
      mode: 'headless',
    });

    try {
      const tab = await session.openTab();
      // A page that is always mid-animation: without settling, two captures
      // taken a moment apart catch it at different points.
      await session.navigate(
        tab,
        'data:text/html,<body style="margin:0"><style>@keyframes slide{from{transform:translateX(0)}to{transform:translateX(300px)}}div{width:100px;height:100px;background:%23333;animation:slide 1s linear infinite}</style><div></div></body>',
      );

      await session.settlePage(tab);

      const first = await session.capture(tab, { fullPage: false });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const second = await session.capture(tab, { fullPage: false });

      // The mutation this catches: dropping the animation rules from the
      // settle style sheet. Without them these two captures differ, because
      // the element has moved between them.
      assert.deepEqual(
        Buffer.from(first.image),
        Buffer.from(second.image),
        'a settled page must produce the same pixels twice',
      );

      await session.closeTab(tab);
    } finally {
      await teardownBrowser(session, root);
    }
  },
);

test(
  'a mask is painted before the shutter, and removed afterwards',
  { skip: available ? false : skipReason() },
  async () => {
    const root = temporaryProfileRoot();
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });
    const session = await driver.coldStart({
      browser: 'private',
      profileDirectory: path.join(root, 'private'),
      mode: 'headless',
    });

    try {
      const tab = await session.openTab();
      await session.navigate(
        tab,
        'data:text/html,<body style="margin:0;background:rgb(255,255,255);width:100vw;height:100vh"></body>',
      );

      const unmasked = await session.capture(tab, { fullPage: false });
      const masked = await session.capture(tab, {
        fullPage: false,
        mask: [{ x: 0, y: 0, width: 10_000, height: 10_000 }],
      });

      // The mutation this catches: applying the mask after the shutter, or not
      // at all. Either leaves the two captures identical.
      assert.notDeepEqual(
        Buffer.from(masked.image),
        Buffer.from(unmasked.image),
        'a masked capture must differ from an unmasked one',
      );

      // And the page is handed back as it was found: a mask that outlived its
      // capture would leave a black rectangle over a live lease.
      const afterwards = await session.capture(tab, { fullPage: false });
      assert.deepEqual(
        Buffer.from(afterwards.image),
        Buffer.from(unmasked.image),
        'the mask must be removed after the capture that needed it',
      );

      await session.closeTab(tab);
    } finally {
      await teardownBrowser(session, root);
    }
  },
);
