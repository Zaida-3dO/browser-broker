import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { RealBrowserDriver } from '../../src/browser/real.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { teardownBrowser, temporaryProfileRoot } from '../helpers/browser-fixture.ts';

/**
 * `foreground.never_moved`, proved empirically on a real browser (row #60,
 * `SCHEMA.md` §9.4).
 *
 * ── Why this test is owed, when three other checks already exist ─────────
 *
 * §9.4 is precise about the gap, and it is worth restating because the
 * existing checks look like they cover it and do not:
 *
 * - **The concurrency properties were proved against the automation
 *   *library*.** The service reaches them through a tool layered over that
 *   library, and **a layer can add a foreground move without saying so.**
 * - **`tests/service/pages.test.ts` proves the verb is unreachable by
 *   asking** — no action named `bringToFront`, `focus` or `activate` is on
 *   the list. That is about this service's own surface, not about what the
 *   tool does underneath on an operation nobody has exercised.
 * - **`tests/browser/capture-surface.test.ts` proves a background capture
 *   returns its own pixels.** That is a **different claim**, and conflating
 *   the two is the specific error this row exists to prevent: that
 *   measurement was about *which pixels come back*, not about *whether the
 *   foreground moves*. A capture could return the right pixels **and** have
 *   raised the tab to get them.
 *
 * So this drives a background tab through a navigation, an action and a
 * capture, and asserts the foreground did not move. It is a test on the real
 * thing rather than a code read, and §9.4 calls it *"the last place a proved
 * property can quietly stop being true"*.
 *
 * ── The signal, and why it is this one ──────────────────────────────────
 *
 * Finding an observable foreground took several attempts, and the ones that
 * failed are recorded here because each **would have produced a test that
 * could not fail** — the worst outcome available for this row:
 *
 * | Signal | Why it is unusable here |
 * |---|---|
 * | `document.hasFocus()` | Reports `true` for **every** tab, including a background one, and does not change when a tab is genuinely raised |
 * | `document.visibilityState` / `document.hidden` | Reports `visible` for every tab, **by this service's own design**: it launches with backgrounding, renderer-demotion and timer-throttling disabled (`CAPTURE_SURFACE_ARGUMENTS`), which is what makes background capture work at all. The flags that make the service correct are exactly the flags that flatten this signal |
 * | `visibilitychange` / `focus` / `blur` events | Never fire, for the same reason |
 * | Frames delivered to `requestAnimationFrame` | Background and foreground both animate — again by design, and the counts overlap run to run, so a threshold would be a coin toss |
 *
 * **What does discriminate is the browser's own target list**, read over its
 * debugging endpoint, which Chromium orders by **how recently each tab was
 * activated**. The active tab is first. That is not an inference about
 * rendering: it is the browser reporting which tab it considers current.
 *
 * ── The negative control is not optional here ───────────────────────────
 *
 * `CLAUDE.md`: a check that cannot fail is worse than no check, and every
 * rejected signal above passes vacuously. So the test **ends by moving the
 * foreground on purpose** and asserting the signal moves with it. Without
 * that, a signal that had quietly become constant would report success
 * forever — which is precisely how the four rejected candidates behaved.
 *
 * ── Where this runs ─────────────────────────────────────────────────────
 *
 * **Headed, and therefore not on continuous integration.** A foreground is a
 * thing a person can see, so a browser with no window has no foreground to
 * move and a headless run of this test would assert nothing. It skips with
 * its reason stated in the output rather than silently, in the same
 * per-test form as the other browser suites here.
 */

const available = browserAvailable();

/** The page targets the browser reports, most recently activated first. */
async function activationOrder(endpoint: string): Promise<readonly string[]> {
  const response = await fetch(`${endpoint}/json/list`);
  const targets = (await response.json()) as { type: string; title: string; id: string }[];
  return targets.filter((target) => target.type === 'page').map((target) => target.title);
}

/** The identifier of the target with this title, for the negative control. */
async function targetIdFor(endpoint: string, title: string): Promise<string> {
  const response = await fetch(`${endpoint}/json/list`);
  const targets = (await response.json()) as { type: string; title: string; id: string }[];
  const match = targets.find((target) => target.type === 'page' && target.title === title);
  assert.ok(match, `no target titled ${title}`);
  return match.id;
}

test(
  'A BACKGROUND TAB CAN BE DRIVEN THROUGH NAVIGATE, ACT AND CAPTURE WITHOUT MOVING THE FOREGROUND',
  { skip: available ? false : skipReason() },
  async () => {
    const root = temporaryProfileRoot();
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });

    // Headed, because a headless browser has no foreground to move. This test
    // must NEVER be converted to headless to make it run on a hosted runner —
    // headless is exactly the mode in which it cannot fail.
    const session = await driver.coldStart({
      browser: 'regular',
      profileDirectory: path.join(root, 'regular'),
      mode: 'headed',
    });

    try {
      const endpoint = session.describe().discovery.endpoint;

      const background = await session.openTab();
      await session.navigate(background, 'data:text/html,<title>BACKGROUND</title><body>b');

      // Opened second and therefore in front. Everything below happens to the
      // *other* tab, and this one must stay where it is.
      const foreground = await session.openTab();
      await session.navigate(foreground, 'data:text/html,<title>FOREGROUND</title><body>f');

      const before = await activationOrder(endpoint);
      assert.equal(
        before[0],
        'FOREGROUND',
        'the tab opened last must start in front, or this test is measuring nothing',
      );

      // ── A navigation on the background tab ──
      await session.navigate(background, 'data:text/html,<title>NAVIGATED</title><body>b2');
      assert.equal(
        (await activationOrder(endpoint))[0],
        'FOREGROUND',
        'navigating a background tab must not raise it',
      );

      // ── An action on the background tab ──
      //
      // `act` is row #22's and is not implemented on the real driver yet, so
      // the action exercised here is the one that **is** implemented and does
      // real work inside the page: evaluating in it, plus settling it, which
      // injects a stylesheet and waits on the page's own font loading. Both
      // reach into the page the way a click would.
      //
      // **Stated rather than glossed:** when #22 lands, its verbs belong in
      // this test. What is proved here is that the operations this build
      // implements do not move the foreground — which is what this row can
      // honestly claim, and not that every verb added later will behave.
      await session.evaluate(background, 'document.title = "ACTED"; document.title');
      await session.settlePage(background);
      assert.equal(
        (await activationOrder(endpoint))[0],
        'FOREGROUND',
        'acting inside a background tab must not raise it',
      );

      // ── A capture of the background tab ──
      //
      // The operation most likely to move a foreground, because a naive
      // implementation raises the tab in order to photograph it — which is
      // exactly what `capture.surface_required` exists to avoid needing.
      const shot = await session.capture(background, { fullPage: false });
      assert.ok(shot.image.byteLength > 0, 'the capture produced an image');
      assert.equal(
        (await activationOrder(endpoint))[0],
        'FOREGROUND',
        'capturing a background tab must not raise it',
      );

      // ── The negative control: prove the signal can move ──
      //
      // Every rejected candidate signal in this file's header passed the three
      // assertions above vacuously. This is what tells them apart: the
      // foreground is moved deliberately, through the browser's own endpoint
      // rather than through this service — which has no operation that could
      // do it — and the signal must follow.
      const backgroundId = await targetIdFor(endpoint, 'ACTED');
      await fetch(`${endpoint}/json/activate/${backgroundId}`);

      // The browser applies the activation asynchronously, so this polls
      // rather than sleeping a fixed time — a fixed pause is too long on
      // every fast machine and too short on the one slow machine.
      let moved: readonly string[] = [];
      for (let attempt = 0; attempt < 40; attempt += 1) {
        moved = await activationOrder(endpoint);
        if (moved[0] === 'ACTED') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.equal(
        moved[0],
        'ACTED',
        'THE NEGATIVE CONTROL FAILED: deliberately activating a tab did not move this signal, ' +
          'so the three assertions above proved nothing. Do not weaken them — find a signal that moves.',
      );

      await session.closeTab(foreground);
      await session.closeTab(background);
    } finally {
      await teardownBrowser(session, root);
    }
  },
);
