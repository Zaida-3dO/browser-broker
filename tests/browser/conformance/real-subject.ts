import path from 'node:path';

import type { SeamSubject } from '../../../src/browser/conformance/subjects.ts';
import { RealBrowserDriver } from '../../../src/browser/real.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../../helpers/browser.ts';
import { teardownBrowser, temporaryProfileRoot } from '../../helpers/browser-fixture.ts';

/**
 * The real driver as a conformance subject.
 *
 * ── Why this lives under `tests/` and its fake counterpart lives in `src/` ─
 *
 * It needs `browserAvailable`, a temporary profile root and a teardown that
 * kills a process — all of which are **test fixtures**, and all of which live
 * in `tests/helpers/`. A module in `src/` importing them would make the
 * shipped tree depend on the test tree, which is backwards, and would put a
 * `process.kill` on a path that ships.
 *
 * The fake subject is in `src/` because it is constructed from a class that
 * already ships, needs nothing, and disposes of nothing. The asymmetry is
 * real rather than cosmetic, and putting each where its dependencies are is
 * what keeps it from leaking.
 */

/**
 * ⚠️ **This subject does not run in continuous integration, and that is the
 * limit this whole suite is honest about.** ⚠️
 *
 * Hosted runners have no browser installed and no display, so
 * {@link browserAvailable} is false there and every property below is skipped
 * **with its reason printed**. It runs on a developer machine with a browser,
 * which is where the properties were established.
 *
 * So: **a green pipeline is not evidence that the real driver satisfied these
 * properties.** It is evidence that the fake did. The suite reports which
 * subjects ran, the suite file asserts that at least one did, and the skip is
 * printed rather than swallowed — those three together are what stop a green
 * tick standing in for a run that never happened.
 *
 * ── Headless, and why that is sound here specifically ───────────────────
 *
 * The private browser is the headless one (§1.2), and this subject opens it.
 * That would be the wrong choice for the keeper-tab *measurement* — a headless
 * browser survives its last tab closing, so the behaviour the keeper prevents
 * does not occur and a headless test of it asserts nothing. That measurement
 * is `tests/browser/keeper-tab.test.ts`'s, it runs headed, and its header says
 * at length why it must stay that way.
 *
 * **This suite tests a different thing: the seam's contract.** Whether
 * `listTabs` excludes the keeper, whether `closeTab` can name it, whether
 * `ensureKeeperTab` is idempotent — none of those depend on the mode, and all
 * of them are the properties whose divergence made the fixture agree with the
 * destructive behaviour. Running them headless is what makes them affordable
 * enough to run at all, and it costs nothing they were measuring.
 */
export const realSubject: SeamSubject = {
  name: 'real',
  unavailable: () => (browserAvailable() ? undefined : skipReason()),
  open: async (browser) => {
    const profileRoot = temporaryProfileRoot();
    const driver = new RealBrowserDriver({ executablePath: browserExecutablePath() });
    const session = await driver.coldStart({
      browser,
      profileDirectory: path.join(profileRoot, browser),
      // Fixed by which browser it is (§1.2, §3.15) rather than chosen here,
      // so this subject cannot quietly run the signed-in browser headless.
      mode: browser === 'regular' ? 'headed' : 'headless',
    });

    return {
      session,
      dispose: () => teardownBrowser(session, profileRoot),
    };
  },
};
