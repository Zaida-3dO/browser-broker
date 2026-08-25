import path from 'node:path';

import { profileDirectory } from '../browser/discovery.ts';
import {
  decideAdoption,
  recordLaunched,
  recordLaunchFailed,
  type AdoptionDecision,
} from '../browser/adoption.ts';
import type { BrowserDriver, BrowserId, BrowserSession } from '../browser/driver.ts';
import { browserIsRunning, modeFor, RealBrowserDriver } from '../browser/real.ts';
import type { ArtifactStore } from '../artifacts/store.ts';
import type { Environment } from '../config/environment.ts';
import { StartupRefusal } from '../errors.ts';
import type { StoreHandle } from '../store/open.ts';

/**
 * **How a shipped binary gets a browser.** The join between the adoption
 * arbitration and the driver that performs what it decides.
 *
 * ── Why this file exists, stated as the thing that was missing ───────────
 *
 * Every part of this was already built and tested. `decideAdoption` arbitrates
 * the launch race in the same transaction that arbitrates claims;
 * `RealBrowserDriver` attaches to a running browser or cold-starts a detached
 * one; `recordLaunched` and `recordLaunchFailed` close the `starting` window
 * either way. **Nothing in `src/` called any of them.** The adoption module
 * had tests and no production caller, so the store's `browsers` table
 * described a launch race that no shipped code ever ran.
 *
 * That is the gap this closes, and it is closed by *composing* those pieces
 * rather than by writing a second launch path beside them.
 *
 * ── Lazy, and that is load-bearing rather than an optimisation ───────────
 *
 * **Nothing here touches a browser until a page verb actually needs one.** A
 * spawn that acquired a browser eagerly would make every command that reaches
 * the service — `claim`, `status`, `release`, `feedback`, a refusal — depend
 * on a browser installation, and the two most common states of this service
 * are *no browser installed* and *no page driven yet*. It would also make the
 * continuous-integration `operations` job, which spawns the real executables
 * on a runner with no browser at all, depend on one.
 *
 * So {@link browserSessionProvider} returns a function, and the function is
 * what `operations/pages.ts` calls **inside an after-commit closure**. A
 * caller that only ever claims and releases never causes a launch.
 *
 * ── Memoised per process, because adoption is not idempotent ─────────────
 *
 * The six page verbs each resolve a session, and a session is a live
 * connection over the debugging protocol. Resolving one per call would open a
 * new connection per verb and run the adoption transaction per verb — and the
 * second of those is worse than wasteful: the race is decided in the store,
 * so a process that re-entered it would keep re-answering a question it had
 * already answered. One session per browser per process, held until the
 * process exits.
 *
 * The memo holds the **promise**, not the resolved session, so two verbs
 * racing in the same process await one acquisition rather than starting two.
 *
 * ── A failed acquisition is not cached ───────────────────────────────────
 *
 * If acquiring throws, the memo is cleared, so the next call tries again. The
 * alternative — caching the rejection — turns one transient failure (a browser
 * still finishing its start-up, a machine that was briefly out of memory) into
 * a process that can never drive a page again, and the process serves a whole
 * session.
 */

/** How long a launch-race loser waits before giving up on the winner. */
export const WAIT_TIMEOUT_MS = 30_000;

/** How often a launch-race loser re-asks whether the winner's browser is up. */
export const WAIT_POLL_INTERVAL_MS = 100;

/**
 * What a caller must supply to get browsers, beyond the store.
 *
 * The driver is a parameter rather than constructed here so a test can hand in
 * a fake and drive the whole adoption path with no browser installed. The
 * default is the real one.
 */
export interface BrowserSessionProviderOptions {
  readonly store: StoreHandle;
  readonly environment: Environment;
  /** Defaults to {@link RealBrowserDriver}. */
  readonly driver?: BrowserDriver;
  /**
   * Where `act` and `read` write the artefacts they hand back paths to.
   *
   * `real.ts` states the rule this satisfies: the driver *"refuses to choose a
   * location while still choosing a name"*, and the seam it leaves is closed
   * by **the wiring row handing over a directory the store decided**. This is
   * that row, so this is where the artifact store arrives, and the default —
   * a temporary directory of the driver's own — stops being what is used.
   *
   * ── What this does NOT achieve, said plainly ────────────────────────────
   *
   * The directory handed over is **not lease-scoped**, and it cannot be from
   * here. `ArtifactStore.directoryFor` is keyed by claim, whereas
   * `outputDirectory` is fixed when a session is constructed and **one session
   * serves every lease in this process** — so binding one lease's directory to
   * the session would file every later lease's artefacts under the first
   * lease's claim, which is worse than not scoping them at all.
   *
   * So what lands here is the `snapshots` tree under the artifact root, shared
   * across leases, and the files inside it are still named by `names.ts` and
   * still cannot climb out of the root. Per-lease scoping for `act` and `read`
   * needs the directory to arrive **per call** rather than per session, which
   * is a change to the driver seam and belongs to the row that makes those two
   * verbs report their paths to callers. Those paths are discarded before they
   * reach a surface, so no caller can observe where the files were filed.
   */
  readonly artifacts?: ArtifactStore;
  /** Injected so a test can observe the running check without a browser. */
  readonly isRunning?: typeof browserIsRunning;
  /** Injected so a test does not wait in real time. */
  readonly waitTimeoutMs?: number;
  readonly waitPollIntervalMs?: number;
}

/** Resolve a session for one browser. Memoised; see the header. */
export type BrowserSessionProvider = (browser: BrowserId) => Promise<BrowserSession>;

/**
 * Build the provider a runtime hands to the page operations.
 *
 * Returns a `close` alongside it so the process that built it can let go of
 * whatever connections it opened. **Letting go is not closing the browser** —
 * `real.ts` measures that attaching and detaching are non-destructive, and the
 * browser is adopted rather than owned, so a process exiting must leave the
 * browser exactly where it found it.
 */
export interface BrowserSessions {
  readonly session: BrowserSessionProvider;
  /**
   * Detach from every session this process opened.
   *
   * Every failure is swallowed: this runs while a process is exiting, the
   * browser outlives it either way, and an error detaching cannot be acted on
   * by anybody.
   */
  readonly close: () => Promise<void>;
}

export function browserSessionProvider(options: BrowserSessionProviderOptions): BrowserSessions {
  const driver =
    options.driver ??
    new RealBrowserDriver(
      options.artifacts === undefined
        ? {}
        : // The driver names a file; the store decided the directory. See
          // `RealDriverOptions.outputDirectory` for why the split is the rule
          // rather than a preference, and {@link
          // BrowserSessionProviderOptions.artifacts} for why this is the
          // shared tree rather than one lease's.
          { outputDirectory: path.join(options.artifacts.root, 'snapshots') },
    );

  const inFlight = new Map<BrowserId, Promise<BrowserSession>>();
  const settled = new Map<BrowserId, BrowserSession>();

  const session: BrowserSessionProvider = (browser) => {
    const existing = inFlight.get(browser);
    if (existing !== undefined) {
      return existing;
    }

    const acquiring = acquire(driver, browser, options)
      .then((acquired) => {
        settled.set(browser, acquired);
        return acquired;
      })
      .catch((error: unknown) => {
        // Not cached. See the header: a cached rejection would end this
        // process's ability to drive a page for the rest of its life.
        inFlight.delete(browser);
        throw error;
      });

    inFlight.set(browser, acquiring);
    return acquiring;
  };

  return {
    session,
    close: async () => {
      for (const open of settled.values()) {
        try {
          await open.detach();
        } catch {
          // The browser is adopted and outlives this process regardless.
        }
      }
      settled.clear();
      inFlight.clear();
    },
  };
}

/**
 * Perform one adoption: ask the store what to do, then do it.
 *
 * ── The order is the rule, and it is the reason this is not two lines ────
 *
 * `SCHEMA.md` §2.4b: no browser work inside the arbitration transaction. So
 * the observation is made **before** the transaction opens, the transaction
 * decides, and the launch happens **after** it commits. `adoption.ts` says the
 * same thing from the other side — its `runningRecord` is a parameter *"for
 * one reason: reading it means talking to a browser, and this runs inside the
 * transaction"*.
 *
 * The consequence, which `decideAdoption` also states: the observation can be
 * stale by the time the transaction opens, and the `starting` state is what
 * covers the gap rather than the observation being made more carefully.
 */
async function acquire(
  driver: BrowserDriver,
  browser: BrowserId,
  options: BrowserSessionProviderOptions,
): Promise<BrowserSession> {
  const isRunning = options.isRunning ?? browserIsRunning;
  const profileDir = profileDirectory(options.environment.profileRoot, browser);

  const observed = await isRunning(profileDir);
  const decision = await decideAdoption(
    options.store,
    browser,
    observed === undefined || observed.browserUuid === undefined
      ? undefined
      : { endpoint: observed.endpoint, browserUuid: observed.browserUuid },
  );

  return performDecision(driver, decision, profileDir, options);
}

/** Do what the transaction decided, outside it. */
async function performDecision(
  driver: BrowserDriver,
  decision: AdoptionDecision,
  profileDir: string,
  options: BrowserSessionProviderOptions,
): Promise<BrowserSession> {
  const { browser } = decision;

  if (decision.action === 'attach') {
    return driver.attach(browser, {
      endpoint: decision.endpoint,
      browserUuid: decision.browserUuid,
    });
  }

  if (decision.action === 'wait') {
    return waitForWinner(driver, browser, profileDir, options);
  }

  // This caller won the race, and the row says `starting` until it says
  // otherwise. **Both outcomes have to be recorded**: `adoption.ts` is
  // explicit that a winner which fails and does not release the race leaves
  // every later caller waiting for a launch that is never coming.
  try {
    const started = await driver.coldStart({
      browser,
      profileDirectory: profileDir,
      mode: modeFor(browser),
    });
    const described = started.describe();
    await recordLaunched(options.store, browser, {
      pid: described.pid,
      endpoint: described.discovery.endpoint,
      // A session that connected has read the browser's own identifier, so
      // this is the verified one rather than the one off disk.
      browserUuid: described.discovery.browserUuid ?? '',
    });
    return started;
  } catch (error) {
    await recordLaunchFailed(options.store, browser);
    throw error;
  }
}

/**
 * Wait for the caller that won the race, and attach to what it started.
 *
 * ── ⚠️ This does not answer row #55, and must not be read as answering it ──
 *
 * `adoption.ts` records the open question in as many words: *"what the loser
 * waits for, and for how long, is row #55's open question… this decision
 * reports the state and stops; it does not invent a bound."* That is a
 * decision about the **design**, and it stands.
 *
 * What is here is a bound in **this process**, and the distinction is the
 * whole of why it is acceptable. Somebody has to do something when the
 * decision comes back `wait`, and there are exactly three options: return a
 * session that is not one, block forever, or poll with a ceiling. The first is
 * the dishonesty this whole row exists to remove and the second turns one
 * failed launch elsewhere into a hung process here — so this polls, and when
 * the ceiling is reached it **refuses, naming what it waited for**, rather
 * than proceeding as if it had a browser.
 *
 * It is deliberately the most minimal shape that can be correct:
 *
 * - **It launches nothing.** A loser that started its own browser would be the
 *   second process against one profile directory, which is the measured
 *   silent-collision failure the race exists to prevent.
 * - **It concludes nothing from the ceiling.** Timing out is reported as *this
 *   caller stopped waiting*, not as *the winner failed*. Nothing here writes
 *   to the `browsers` row, so the winner keeps its race and the next caller
 *   asks the same question again.
 * - **It is the ordinary positive test.** The loop asks `browserIsRunning`,
 *   which verifies the endpoint answers **and** that the browser identifies
 *   itself as the one on the record — the same check every other path here
 *   makes, and the reason a stale record plus a reused port cannot be mistaken
 *   for a live browser.
 *
 * Whether the bound should be a fixed ceiling at all, and what it should be,
 * remains #55's to settle.
 */
async function waitForWinner(
  driver: BrowserDriver,
  browser: BrowserId,
  profileDir: string,
  options: BrowserSessionProviderOptions,
): Promise<BrowserSession> {
  const isRunning = options.isRunning ?? browserIsRunning;
  const timeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  const intervalMs = options.waitPollIntervalMs ?? WAIT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const record = await isRunning(profileDir);
    if (record !== undefined && record.browserUuid !== undefined) {
      return driver.attach(browser, record);
    }

    if (Date.now() >= deadline) {
      throw new StartupRefusal(
        'launch.explicit_profile_dir',
        `Another caller is starting the ${browser} browser and it did not become reachable within ${String(timeoutMs)}ms. Nothing was launched here: a second browser against one profile directory hands its address to the first and opens no endpoint of its own. Try again — the browser may still be starting.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
