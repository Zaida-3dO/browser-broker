import fs from 'node:fs';

import { browserIsRunning, RealBrowserDriver, modeFor } from '../browser/real.ts';
import { BROWSER_IDS, type BrowserId, type BrowserSession } from '../browser/driver.ts';
import type { Environment } from '../config/environment.ts';
import { BrokerError } from '../errors.ts';
import type { Broker } from '../service/broker.ts';
import { SIGNABLE_BROWSER } from '../service/operations/sign-in.ts';
import { runSetupHandshake } from '../browser/setup.ts';
import type { StoreHandle } from '../store/open.ts';
import {
  COLLISION_HINT,
  NO_BROWSER_NOTE,
  relativeProfilePath,
  signInCompletion,
  signInInstructions,
  signInProfileDirectory,
} from './sign-in.ts';

/**
 * `broker login` — open the signed-in browser for a person, and wait.
 *
 * ── What this command is, in one sentence ───────────────────────────────
 *
 * It is the **only** part of this design a person has to perform by hand, and
 * everything about its shape follows from that: it takes no lease, spends no
 * tab budget, drives nothing, and its entire output is instructions.
 *
 * ── The four steps, and which of them are refusals ──────────────────────
 *
 * `SCHEMA.md` §5.5.1 gives the sequence and this file performs it in order:
 *
 * 1. **Claim the browser through the service** — which is where the refusals
 *    live: a live lease holding a tab, the private browser, a sign-in already
 *    in progress. None of them is checked here, deliberately: they are facts
 *    about leases and lease liveness is derived inside the arbitration
 *    transaction (§2.4). A check made in this file would read rows the sweep
 *    had not reconciled.
 * 2. **Get them a window**, against the configured profile.
 * 3. **Wait**, while they sign in.
 * 4. **Give the browser back**, whatever happened — including if this process
 *    is interrupted.
 *
 * ── Why the profile is asserted rather than trusted ─────────────────────
 *
 * **Measured, and it is the failure this command exists to prevent.** A
 * second browser launched against a profile directory already in use does not
 * report a lock error: it **hands its address to the browser already holding
 * the profile and exits zero**, with nothing on the error stream and no
 * endpoint of its own. A launcher waiting on its own endpoint therefore waits
 * for something that will never appear.
 *
 * And the obvious guard does not work: the single-instance lock file a POSIX
 * system leaves in a profile directory **does not exist on Windows**, so a
 * cross-platform check for it does not report *no lock* there — it **always
 * passes**. A guard that cannot fail on one platform is worse than no guard.
 *
 * So this file makes **no** negative inference. It asks `browserIsRunning`,
 * which verifies an endpoint answers *and* identifies itself as the expected
 * browser, and when it starts one it goes through `coldStart`, whose contract
 * is that success is an endpoint that answered — never a command that exited.
 * The positive assertion is the whole mechanism; there is no path here that
 * concludes a browser is available because nothing said otherwise.
 *
 * ── Why the profile is never recreated ──────────────────────────────────
 *
 * `runSetupHandshake` is called rather than respelled, and that is not
 * economy: it is the one implementation of **setup may create, and may never
 * destroy** (`setup.profile_never_destroyed`, §7.2). The profile holds a
 * sign-in a person put there by hand, and a second implementation of
 * "establish a profile" is exactly where the branch that clears a directory
 * because it looks unfamiliar would eventually be written.
 */

/** How the person's window is watched for, and how often. */
export const CLOSE_POLL_INTERVAL_MS = 1_000;

export interface LoginStreams {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface LoginOptions {
  readonly broker: Broker;
  readonly store: StoreHandle;
  readonly environment: Environment;
  readonly streams: LoginStreams;
  readonly json: boolean;
  /** Which browser, defaulting to the only one that can be signed into. */
  readonly browser?: string;
  /**
   * How the window is opened and watched, injected so a test drives the whole
   * command without a display.
   *
   * **This is the seam that makes the sequence testable, and it is worth
   * being exact about what it does and does not buy.** With it, every
   * refusal, the ordering of the four steps, and the give-the-browser-back
   * guarantee are asserted by ordinary tests on every platform. What it
   * cannot prove is that a real headed browser appears and survives — that
   * needs a display, so it is a separate headed test that skips on a runner
   * with none, and says so.
   */
  readonly window?: SignInWindow;
}

/**
 * Opening a window for a person and waiting for them to close it.
 *
 * Two members rather than one because the two failure modes are different:
 * getting a window can refuse (the collision above), and waiting cannot — it
 * only ends.
 */
export interface SignInWindow {
  /**
   * Produce a window against this exact profile directory, headed.
   *
   * Returns the process identifier of the browser the person will use, which
   * is what the waiting half watches. Refuses rather than returning if it
   * could not **positively establish** an endpoint of its own.
   */
  readonly open: (request: {
    readonly browser: BrowserId;
    readonly profileDirectory: string;
    readonly alreadyRunning: boolean;
  }) => Promise<{ readonly pid: number; readonly startedIt: boolean }>;
  /** Resolve once the person has closed the window. */
  readonly waitForClose: (request: {
    readonly profileDirectory: string;
    readonly pid: number;
  }) => Promise<void>;
}

/**
 * The real window: a headed browser against the configured profile.
 *
 * It attaches to one that is already running and starts one otherwise, which
 * is the arrangement §5.5.1 describes — *"nothing is stopped and nothing is
 * relaunched"*, because relaunching is a chance to lose the very thing being
 * protected.
 */
export function realSignInWindow(
  options: { readonly fetchImpl?: typeof fetch } = {},
): SignInWindow {
  const driver = new RealBrowserDriver(
    options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
  );

  return {
    open: async (request) => {
      if (request.alreadyRunning) {
        const record = await browserIsRunning(request.profileDirectory, options);
        if (record === undefined) {
          // The record stopped checking out between the caller's look and
          // this one. Treated as not running rather than as an error, because
          // that is exactly what a stale record means (§1.2c).
          const session = await driver.coldStart({
            browser: request.browser,
            profileDirectory: request.profileDirectory,
            mode: modeFor(request.browser),
          });
          return finishOpen(session, true);
        }
        const session = await driver.attach(request.browser, record);
        // Attaching is non-destructive and the browser was not started here,
        // so the person is being handed a window that already existed.
        return finishOpen(session, false);
      }

      const session = await driver.coldStart({
        browser: request.browser,
        profileDirectory: request.profileDirectory,
        mode: modeFor(request.browser),
      });
      return finishOpen(session, true);
    },

    waitForClose: async (request) => {
      // **Watched by asking the endpoint, not by watching the process.** A
      // process identifier can be reused, and a browser that is exiting holds
      // its identifier for a moment after its window has gone. The endpoint
      // answering with the expected identity is the same positive test
      // everything else here uses, and its *absence* is the only negative
      // conclusion this file draws — which is sound in this direction: an
      // endpoint that does not answer is not serving anybody.
      for (;;) {
        const record = await browserIsRunning(request.profileDirectory, options);
        if (record === undefined) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, CLOSE_POLL_INTERVAL_MS));
      }
    },
  };
}

/**
 * Release this process's connection and report the browser's identifier.
 *
 * **Detaching is not closing.** Measured (`real.ts`): attaching and detaching
 * are non-destructive to tabs and cookies, and the browser is adopted rather
 * than owned — so letting go of the connection leaves the person's window
 * exactly where it was, which is the point. This process must not be holding
 * a connection while a person drives the window, because this process is
 * going to exit.
 */
async function finishOpen(
  session: BrowserSession,
  startedIt: boolean,
): Promise<{ pid: number; startedIt: boolean }> {
  const { pid } = session.describe();
  await session.detach();
  return { pid, startedIt };
}

/**
 * Run the command.
 *
 * Returns an exit code rather than calling out to the process, like every
 * other command here, so the whole of it is reachable from a test.
 */
export async function runLoginCommand(options: LoginOptions): Promise<number> {
  const { broker, environment, streams, json } = options;
  const requested = options.browser ?? SIGNABLE_BROWSER;

  // Establish the profile **before** claiming the browser, because a claim
  // that succeeded and then failed to find a profile would leave the browser
  // in `signing-in` over a directory that was never there. It creates what is
  // absent and leaves alone what is present — never recreating one that
  // exists, which is the whole of `setup.profile_never_destroyed`.
  await runSetupHandshake(options.store, environment.profileRoot);

  // Step 1. Every refusal is the service's; this route adds none of its own.
  const began = await broker.begin_sign_in({ browser: requested });
  const browser: BrowserId = began.browser;
  const profileDir = signInProfileDirectory(environment.profileRoot, browser);

  let opened: { pid: number; startedIt: boolean } | undefined;
  try {
    const window = options.window ?? realSignInWindow();

    // Asked positively, and the answer is used only in the direction where it
    // is meaningful: a verified record means a browser is there to attach to.
    // A missing one means *this call could not verify one*, which is why the
    // branch it leads to starts a browser and asserts an endpoint rather than
    // assuming the profile is free.
    const running = await browserIsRunning(profileDir);

    opened = await window.open({
      browser,
      profileDirectory: profileDir,
      alreadyRunning: running !== undefined,
    });

    const relative = relativeProfilePath(environment.profileRoot, browser);

    if (json) {
      // One document, and the human text goes to the error stream (§5.6).
      streams.out(
        JSON.stringify({
          outcome: 'accepted',
          value: {
            browser,
            state: began.state,
            profileRelativePath: relative,
            startedBrowser: opened.startedIt,
            pid: opened.pid,
          },
        }),
      );
      for (const line of signInInstructions(browser, relative)) {
        streams.err(line);
      }
    } else {
      if (opened.startedIt) {
        streams.out(NO_BROWSER_NOTE);
        streams.out('');
      }
      for (const line of signInInstructions(browser, relative)) {
        streams.out(line);
      }
    }

    // Step 3. The person signs in. Nothing happens here until they close it.
    await window.waitForClose({ profileDirectory: profileDir, pid: opened.pid });
  } finally {
    // Step 4, and it is in a `finally` for a reason worth stating: a browser
    // left in `signing-in` refuses **every** caller, permanently, with a
    // message about a person who has walked away. That is a worse outcome
    // than any failure this block could be recovering from, so the browser is
    // given back on every path out of here — including a refusal from the
    // window and an interruption.
    try {
      const ended = await broker.end_sign_in({ browser });
      if (!json) {
        streams.out('');
        for (const line of signInCompletion(browser, ended.queueDepth)) {
          streams.out(line);
        }
      } else {
        streams.err(`The ${browser} browser is serving again.`);
      }
    } catch (error) {
      // Reported rather than swallowed and never allowed to replace the
      // original failure: if this is running because something above threw,
      // that is the thing the person needs to read.
      streams.err(
        `The browser could not be returned to service: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return 0;
}

/**
 * Turn a launch refusal into something a person can act on.
 *
 * The launch's own message is accurate and is about endpoints; this adds what
 * to *do*, which is the part a person needs and the part a message about
 * endpoints cannot supply.
 */
export function explainLoginFailure(error: unknown): string {
  if (error instanceof BrokerError && error.message.includes('already running against this')) {
    return `${error.message}\n\n${COLLISION_HINT}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a profile directory exists at all, for the caller that wants to
 * report rather than create.
 */
export function profileExists(profileRoot: string, browser: BrowserId): boolean {
  try {
    return fs.statSync(signInProfileDirectory(profileRoot, browser)).isDirectory();
  } catch {
    return false;
  }
}

/** The browsers this command will answer for, for a usage message. */
export const LOGIN_BROWSERS: readonly BrowserId[] = BROWSER_IDS;
