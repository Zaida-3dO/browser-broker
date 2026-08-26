import type { BrowserId, BrowserSession } from '../driver.ts';
import { FakeBrowserDriver } from '../fake.ts';
import { CONFORMANCE_RECORD } from './cases.ts';

/**
 * How the suite reaches one implementation of the seam.
 *
 * ── The asymmetry this type exists to carry ─────────────────────────────
 *
 * The two implementations are not obtained the same way and cannot be. A fake
 * is constructed; a real driver **launches a browser**, needs a profile
 * directory, needs tearing down, and is unavailable on a machine with no
 * browser installed. Flattening that into one constructor would mean either
 * pretending the fake needs teardown or pretending the real one does not.
 *
 * So a subject carries three things: how to open a session, how to dispose of
 * it, and **whether it can run here at all** — the last being the one the
 * adapter suite next door never needed, because no route there depends on
 * software being installed.
 */
export interface SeamSubject {
  /** Read by a person when a property fails, and by the suite when it skips. */
  readonly name: string;
  /**
   * Whether this implementation can be exercised on this machine, and why not
   * when it cannot.
   *
   * **Returning a reason rather than a boolean is the honest shape.** A
   * subject that silently does not run is the failure this whole suite is
   * about, one layer up: a green pipeline that proves nothing. The reason is
   * printed, so a skip is visible in the output as a skip.
   */
  readonly unavailable: () => string | undefined;
  readonly open: (browser: BrowserId) => Promise<SeamSession>;
}

/** One session, and the way to end it. */
export interface SeamSession {
  readonly session: BrowserSession;
  readonly dispose: () => Promise<void>;
}

/**
 * The fake, which runs everywhere.
 *
 * A fresh driver per session rather than one shared across properties: the
 * properties open tabs and establish keepers, so a shared driver would let
 * one property's leftovers decide another's answer — and the two would then
 * be being asked different questions depending on the order they ran in.
 */
export const fakeSubject: SeamSubject = {
  name: 'fake',
  unavailable: () => undefined,
  open: async (browser) => {
    const driver = new FakeBrowserDriver();
    const session = await driver.attach(browser, CONFORMANCE_RECORD);
    return { session, dispose: () => Promise.resolve() };
  },
};
