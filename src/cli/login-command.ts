import fs from 'node:fs';

import { browserIsRunning, RealBrowserDriver, modeFor } from '../browser/real.ts';
import { DEFAULT_BROWSER_IDS, type BrowserId, type BrowserSession } from '../browser/driver.ts';
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
 * 4. **Give the browser back** on every path out of the command, and on an
 *    interruption — by a signal handler, because a `finally` does not run on
 *    a signal. What that does and does not cover is stated exactly at step
 *    four's own comment below; the short version is that a handler covers the
 *    deaths that let a process run code and nothing else, so the store also
 *    records who holds a sign-in and a later `broker login` reclaims one whose
 *    process is gone.
 *
 * ── Why the profile is asserted rather than trusted ─────────────────────
 *
 * **Measured, and it is the failure this command exists to prevent.** A
 * second browser launched against a profile directory already in use does not
 * report a lock error: it **hands its address to the browser already holding
 * the profile**, with nothing on the error stream and no endpoint of its own.
 * A launcher waiting on its own endpoint therefore waits for something that
 * will never appear. (The losing process does not exit on its own either;
 * `launch.ts` ends it by the identifier it spawned.)
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

/**
 * The signals a person's interruption arrives as.
 *
 * `SIGINT` is Ctrl-C, which is the one that matters: it is how anybody stops
 * a command that is sitting there waiting, and it is the keystroke that used
 * to strand the browser. `SIGTERM` is the ordinary polite termination — what
 * a supervisor, a shell logout or a `taskkill` without `/F` sends.
 *
 * **`SIGKILL` is deliberately absent and cannot be added.** It is not
 * deliverable to a handler by design, which is precisely why the recovery
 * path in `service/signin-recovery.ts` exists rather than this list being
 * extended until it feels complete.
 */
export const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export type InterruptSignal = (typeof INTERRUPT_SIGNALS)[number];

/**
 * Installing and removing the interruption handler.
 *
 * A seam rather than a direct `process.on`, so a test drives the whole
 * interrupted path — including that the browser is actually given back —
 * without signalling the process running the tests, which would take the test
 * runner down with it.
 */
export interface InterruptHandling {
  /**
   * Register `onInterrupt`, and return a function that unregisters it.
   *
   * The disposer is what keeps a completed `broker login` from leaving a
   * listener behind on a long-lived process.
   */
  readonly install: (onInterrupt: (signal: InterruptSignal) => void) => () => void;
}

/**
 * The real one: process signal handlers, and an exit once the browser is back.
 *
 * ── Why this exits rather than letting the process continue ─────────────
 *
 * Installing a handler for `SIGINT` **takes over the default disposition**: a
 * process carrying one runs the handler and carries on waiting rather than
 * ending, which from a person's side is a command that has stopped responding
 * to Ctrl-C. That would trade one bad outcome for another, so the handler does
 * the work and then ends the process itself.
 *
 * The exit code is the conventional `128 + signal number`, which is what a
 * shell reports for a process killed by that signal — so a script watching
 * this command sees what it saw before rather than a new number to learn.
 */
export function realInterruptHandling(): InterruptHandling {
  return {
    install: (onInterrupt) => {
      const registered = INTERRUPT_SIGNALS.map((signal) => {
        const listener = (): void => {
          onInterrupt(signal);
        };
        process.on(signal, listener);
        return { signal, listener };
      });

      return () => {
        for (const { signal, listener } of registered) {
          process.off(signal, listener);
        }
      };
    },
  };
}

/** `128 + n`, the exit code a shell reports for a death by signal. */
export const SIGNAL_EXIT_CODES: Readonly<Record<InterruptSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * The exit code when an interruption was caught and the browser could **not**
 * be given back.
 *
 * Distinct from the signal codes on purpose: those say "this process was
 * interrupted", which is ordinary and is what a script expects. This one says
 * the interruption was handled and the cleanup it exists to perform failed, so
 * something is left behind — a different fact, and one a script watching this
 * command should be able to tell apart without parsing English.
 */
export const EXIT_INTERRUPT_INCOMPLETE = 70;

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
  /**
   * How an interruption is caught, injected so a test proves the browser is
   * given back on one without signalling the test runner.
   */
  readonly interrupts?: InterruptHandling;
  /**
   * How the process is ended after an interruption has been handled.
   *
   * Injected for the same reason: the real one ends this process, and a test
   * that called it would end the run rather than assert on it.
   */
  readonly exit?: (code: number) => void;
  /** This process's identifier, recorded as the sign-in's owner. */
  readonly ownerPid?: number;
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
  await runSetupHandshake(options.store, environment.profileRoot, {
    browsers: [...environment.regularBrowsers, ...environment.privateBrowsers],
  });

  // Step 1. Every refusal is the service's; this route adds none of its own.
  //
  // **The owner is recorded as part of taking the claim**, so a sign-in is
  // never held by a process the store cannot name. See step eight of the
  // schema for why this is the command's identifier rather than the browser's.
  const began = await broker.begin_sign_in({
    browser: requested,
    ownerPid: options.ownerPid ?? process.pid,
  });
  const browser: BrowserId = began.browser;
  const profileDir = signInProfileDirectory(environment.profileRoot, browser);

  // ── The interruption handler, installed as soon as there is something to
  //    give back and not one line earlier ──────────────────────────────────
  //
  // **Ordering is the whole correctness argument here.** Installed before the
  // claim, it could fire when there is no claim to release and would call
  // `end_sign_in` against a browser that is not signing in — which the service
  // refuses, so a person interrupting an early failure would be handed a
  // confusing refusal on their way out. Installed after the window opens, a
  // Ctrl-C during the launch — which is a slow step and therefore a likely
  // moment to press it — would strand exactly the state this is here to
  // prevent.
  //
  // So it goes immediately after the claim is taken and immediately before
  // anything slow, and it is removed in the `finally` so a completed command
  // leaves no listener behind.
  const handling = options.interrupts ?? { install: () => () => {} };
  const endProcess = options.exit ?? ((code: number) => process.exit(code));

  let interrupted = false;
  const remove = handling.install((signal) => {
    // **Re-entrancy matters more than it looks.** A person who presses Ctrl-C
    // and sees nothing happen immediately presses it again, and a second run
    // through here would call `end_sign_in` twice — the second against a
    // browser already given back, which refuses. Latching means the extra
    // presses are ignored rather than producing a refusal on the way out.
    if (interrupted) {
      return;
    }
    interrupted = true;

    streams.err('');
    streams.err(
      `Interrupted. Giving the ${browser} browser back before exiting — it would otherwise refuse every caller until somebody intervened.`,
    );

    void (async () => {
      let code = SIGNAL_EXIT_CODES[signal];
      try {
        await broker.end_sign_in({ browser });
        streams.err(`The ${browser} browser is serving again.`);
      } catch (error) {
        // Reported, and it changes the exit code: a person whose browser was
        // **not** given back needs to know that the thing this message
        // promised did not happen. Exiting zero-shaped here would be the same
        // class of defect as the comment that used to claim a `finally`
        // covered a signal.
        streams.err(
          `The browser could not be returned to service: ${error instanceof Error ? error.message : String(error)}`,
        );
        streams.err(
          'It is recorded as signing-in and this process is about to exit. The next `broker login` will reclaim it, because the sign-in records which process was holding it.',
        );
        code = EXIT_INTERRUPT_INCOMPLETE;
      }
      endProcess(code);
    })();
  });

  const signals = { dispose: remove };

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
    // ── Step 4, and what this `finally` actually guarantees ─────────────
    //
    // A browser left in `signing-in` refuses **every** caller with a message
    // about a person who has walked away, so the browser is given back on
    // every path out of here — a normal completion and a refusal from the
    // window alike.
    //
    // **It does not cover an interruption, and it never did.** A `finally`
    // is ordinary control flow: the runtime unwinds to it when a call
    // returns or throws. A signal is not either of those, and with no
    // handler installed the default disposition for `SIGINT` terminates the
    // process without unwinding anything — so this block does not run, and
    // before the handler below existed a Ctrl-C left the browser
    // unrecoverable. That is why the handler is installed rather than being
    // relied upon from here, and it is why the store records an owner as
    // well: a handler cannot run on `SIGKILL` or on a power cut.
    signals.dispose();

    // **Nothing is given back twice.** When the handler ran it has already
    // called `end_sign_in`, and calling it again would hit the service's own
    // refusal for ending a sign-in that never began — turning a clean
    // interruption into an error message on the way out. The handler owns the
    // release from the moment it fires, and this block owns every other path.
    //
    // Written as a condition around the work rather than as an early `return`,
    // deliberately: a `return` inside a `finally` **discards an exception the
    // `try` was throwing**, so the one shape that reads most naturally here is
    // the one that would silently swallow a genuine launch failure.
    if (!interrupted) {
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
export const LOGIN_BROWSERS: readonly BrowserId[] = DEFAULT_BROWSER_IDS;
