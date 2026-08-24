import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { StartupRefusal } from '../errors.ts';
import { readDiscoveryRecord, verifyDiscoveryRecord } from './discovery.ts';
import type { BrowserMode, DiscoveryRecord } from './driver.ts';

/**
 * Starting a browser that nothing owns, and proving it actually started.
 *
 * ── Why the binary is spawned directly ──────────────────────────────────
 *
 * `SCHEMA.md` §1.2a, and it is measured rather than preferred. Three things
 * were tried:
 *
 * | What was tried | What happened |
 * |---|---|
 * | Launch through the automation library's own launcher, then close that client | **The browser was killed with it.** The launching call owns what it starts — correct for a test, fatal for a shared browser |
 * | Attach to an already-running browser, then close that client | **The browser was unaffected.** An attaching caller does not own what it did not start |
 * | Spawn the binary **detached**, then kill the spawning process uncleanly | **The browser survived**, healthy and re-attachable for around 90 minutes, pages intact |
 *
 * No process here lives long enough to be a browser's parent — the service is
 * spawned by a caller and exits with it — so a browser that belonged to a
 * process would die with the first caller that finished, taking every other
 * caller's tabs with it. The launcher's ownership is the whole problem and it
 * is not configurable away, so this module reaches for the process module
 * rather than the automation library. That is the `launch.detached` build
 * rule (§7.2), and it is why this file spawns rather than delegates.
 *
 * ── Why success is asserted and never inferred ──────────────────────────
 *
 * **Measured, and worse than a bad error message.** A second browser started
 * against a profile directory already in use does **not** report a lock
 * error. It hands its address to the browser already holding the profile and
 * **exits zero**, with nothing on the error stream and no debugging endpoint
 * opened. A launcher waiting on its own endpoint therefore waits for
 * something that will never appear.
 *
 * And the obvious cross-platform check does not work: the single-instance
 * lock file a POSIX system leaves in a profile directory **does not exist on
 * Windows**, so a check looking for it does not report *no lock* there — it
 * **always passes**. A guard that cannot fail on one platform is worse than
 * no guard, because it is trusted equally on both. So there is no lock-file
 * check here, deliberately.
 *
 * What establishes success instead is a **positive assertion**: an endpoint
 * exists, answers, and identifies itself as the browser this launch produced.
 * Anything else is a failure, including a launch whose command exited
 * zero.
 */

/** The refusals this module raises, spelled as `SCHEMA.md` §7.2 spells them. */
export const LAUNCH_RULES = {
  explicitProfileDir: 'launch.explicit_profile_dir',
  detached: 'launch.detached',
  defaultArgsIntact: 'launch.default_args_intact',
  captureSurface: 'launch.capture_surface',
} as const;

/**
 * The switches that keep a background tab rendering, which is what
 * `launch.capture_surface` (§7.2) is actually about.
 *
 * ── What was measured, because it corrects the obvious reading ──────────
 *
 * The rule says the browser must be launched "with the setting that makes
 * screenshots capture the right tab", and the obvious reading is that some
 * single flag selects a capture surface. **Measured, on this browser and this
 * library: that is not where the property comes from.** A background tab was
 * screenshotted in both a headed and a headless browser while a *different*
 * tab was in front, and both returned the background tab's own pixels
 * correctly. The library captures per target over the debugging protocol
 * rather than reading the window's surface, so it does not photograph
 * whatever happens to be in front.
 *
 * **So the failure the rule describes is not prevented by a capture flag —
 * it is prevented by the tab still rendering.** A browser is free to throttle
 * or stop compositing a window it believes nobody is looking at, and a tab
 * that has stopped compositing is the one that yields a stale or empty frame.
 * These switches are what keep that from happening, and that is why they are
 * additive settings rather than a mode.
 *
 * This is stated at length because the honest version matters more than the
 * tidy one: a constant named for a capture surface, holding a headless flag,
 * would have made `launch.capture_surface` look satisfied on the headed
 * browser — the **only** browser where the failure it names can occur — while
 * doing nothing about it. The rule is kept, and pointed at the thing that
 * actually carries it.
 */
export const CAPTURE_SURFACE_ARGUMENTS: readonly string[] = [
  // Keep rendering a window the browser thinks is covered.
  '--disable-backgrounding-occluded-windows',
  // Do not demote a background tab's renderer priority.
  '--disable-renderer-backgrounding',
  // Do not throttle timers and rasterisation in background tabs.
  '--disable-background-timer-throttling',
];

/**
 * What this service adds to the automation library's defaults.
 *
 * `launch.default_args_intact` (§7.2): the launch settings are the library's
 * defaults **plus** what this service adds, and **never its defaults minus
 * anything**. Those defaults include what keeps background tabs running at
 * full speed and what makes capturing them work; removing them is how a
 * service becomes mysteriously slow and mysteriously wrong at once.
 *
 * So this list is strictly additive and {@link assertDefaultArgsIntact}
 * refuses a launch that tries to subtract. Each entry earns its place:
 *
 * - The **profile directory**, which is mandatory and is the browser's
 *   identity (§1.2a). Written by the caller, never defaulted.
 * - The **debugging port, unspecified**, so the operating system assigns a
 *   free one and the browser records it (§1.2c).
 * - **No first-run and no default-browser check**, because a first-run
 *   interstitial is a page nobody asked for occupying the browser this
 *   service is about to count tabs in.
 */
export const ADDED_ARGUMENT_PREFIXES: readonly string[] = [
  '--user-data-dir=',
  '--remote-debugging-port=',
  '--no-first-run',
  '--no-default-browser-check',
  ...CAPTURE_SURFACE_ARGUMENTS,
];

/**
 * Arguments that would remove a default, matched as **shapes**.
 *
 * `launch.default_args_intact` protects the library's defaults, and the way a
 * caller subtracts from them is a switch that turns one off. This is a shape
 * list rather than an exhaustive one, and the limit is stated rather than
 * implied: it catches the disable-shaped and clear-the-features-shaped
 * switches, which are the forms a subtraction actually takes, and it cannot
 * catch a switch that subtracts a default without looking like either.
 *
 * **The awkward part, kept rather than hidden.** The capture-surface switches
 * above are themselves disable-shaped, because the thing that has to be
 * turned off is the browser's own backgrounding behaviour. So the shape alone
 * cannot separate *this service adding a setting it needs* from *a caller
 * stripping a default*, and a check that matched on shape alone would refuse
 * the service's own launch.
 *
 * The distinction that does hold is **who is adding it**: the service's own
 * additions are a fixed, reviewed list in this file, and the extras are
 * whatever a caller passed. So the check runs against the caller's extras and
 * exempts the service's own set by exact membership rather than by shape.
 * That is a narrower claim than "no default is ever removed", and it is the
 * one this code can actually make good on.
 */
const SUBTRACTIVE_ARGUMENT_SHAPES: readonly RegExp[] = [/^--disable-/, /^--no-sandbox$/];

export interface LaunchRequest {
  /**
   * **Mandatory and never defaulted** (`launch.explicit_profile_dir`). Two
   * independent justifications, each sufficient alone: a default location is
   * shared with anything else that also takes the default, so an unrelated
   * run that started first would stop this service starting at all; and with
   * browsers adopted rather than owned, **profile identity is a path**, so
   * without a stable one there is nothing to attach to later.
   */
  readonly profileDirectory: string;
  readonly mode: BrowserMode;
  /** The browser binary. Resolved by the caller so this module spawns and does not search. */
  readonly executablePath: string;
  /** Extra switches, appended after the defaults. Never used to subtract. */
  readonly extraArguments?: readonly string[];
}

/**
 * Refuse a profile directory that is absent, empty or not a real path.
 *
 * A value can be **present and still be wrong**, which is why this is a
 * run-time refusal and not only a type. The type makes omitting it impossible;
 * this makes an empty string impossible.
 */
export function assertExplicitProfileDirectory(profileDirectory: string): void {
  if (profileDirectory.trim() === '') {
    throw new StartupRefusal(
      LAUNCH_RULES.explicitProfileDir,
      'A browser may not be launched without an explicit profile directory. A default profile location is shared with anything else that takes the default, and with browsers adopted rather than owned the directory is the only thing that says which browser this is.',
    );
  }
}

/**
 * Refuse a launch whose extra arguments subtract from the library's defaults.
 *
 * This is `launch.default_args_intact` at the only place it can be enforced
 * at run time: the point where arguments are assembled.
 */
export function assertDefaultArgsIntact(extraArguments: readonly string[]): void {
  for (const argument of extraArguments) {
    // The service's own capture-surface switches are disable-shaped by
    // necessity, so they are exempted by exact membership rather than by
    // shape. See the note on the shape list for why that is the honest
    // boundary and what it does not claim.
    if (CAPTURE_SURFACE_ARGUMENTS.includes(argument)) {
      continue;
    }
    for (const shape of SUBTRACTIVE_ARGUMENT_SHAPES) {
      if (shape.test(argument)) {
        throw new StartupRefusal(
          LAUNCH_RULES.defaultArgsIntact,
          `The launch argument ${argument} removes a default rather than adding to one. The launch settings are the automation library's defaults plus what this service adds, never its defaults minus anything: those defaults include what keeps background tabs running at full speed and what makes capturing them work.`,
        );
      }
    }
  }
}

/**
 * Assemble the command line: the additive set, then the mode, then extras.
 *
 * Exported so a test can assert the shape of what is spawned by reading it,
 * rather than by trusting a comment about it — the build rules this row ships
 * are claims about arguments, and a claim about arguments is checkable only
 * where the arguments are.
 */
export function launchArguments(request: LaunchRequest): readonly string[] {
  assertExplicitProfileDirectory(request.profileDirectory);
  const extras = request.extraArguments ?? [];
  assertDefaultArgsIntact(extras);

  const args = [
    `--user-data-dir=${request.profileDirectory}`,
    // Unspecified, so the operating system assigns a free one and the browser
    // records what it chose (§1.2c). A fixed port is a guess about what else
    // is running on the host.
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    // On every launch, in both modes. The failure `launch.capture_surface`
    // names — a capture returning something other than the tab that was asked
    // for — is a background tab that stopped rendering, and that is a risk in
    // the headed browser specifically. Applied to both because a setting that
    // is only present in the mode where it is not needed is a setting nobody
    // has tested in the mode where it is.
    ...CAPTURE_SURFACE_ARGUMENTS,
  ];

  if (request.mode === 'headless') {
    args.push('--headless=new');
  }

  args.push(...extras);
  // A blank page to start on, so the browser has a tab and the keeper tab
  // (#56) has something to be established against.
  args.push('about:blank');
  return args;
}

export interface LaunchOutcome {
  readonly pid: number;
  readonly record: DiscoveryRecord;
}

export interface LaunchOptions {
  /** How long to wait for the endpoint to appear and answer. */
  readonly readinessTimeoutMs?: number;
  /** How often to re-check. */
  readonly pollIntervalMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * How long a cold start waits for its endpoint before declaring failure.
 *
 * **This is a bound, not the answer to §1.2b.** Row #55 owns what a caller
 * that *lost* the launch race waits for and for how long, and that question
 * is recorded as genuinely open. This number is the narrower one this row
 * cannot ship without: the process this call itself spawned either produces
 * an endpoint or it did not start, and without a bound the silent-collision
 * case — exit zero, no endpoint, ever — hangs forever rather than reporting.
 */
export const READINESS_TIMEOUT_MS = 30_000;
export const POLL_INTERVAL_MS = 100;

/**
 * Spawn the browser detached and **assert** that it came up.
 *
 * The spawn is detached and its streams are released so the browser is not
 * tied to this process's lifetime in either direction: a detached child with
 * inherited pipes still dies with its parent on some platforms, which would
 * reintroduce the exact ownership this arrangement exists to remove.
 */
export async function coldStartDetached(
  request: LaunchRequest,
  options: LaunchOptions = {},
): Promise<LaunchOutcome> {
  assertExplicitProfileDirectory(request.profileDirectory);

  const timeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
  const pollMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const args = launchArguments(request);

  // The profile directory has to exist for the browser to write its record
  // into it. Created, never cleared — `setup.profile_never_destroyed` (§7.2).
  fs.mkdirSync(request.profileDirectory, { recursive: true });

  // Any record from a previous browser is a claim about a browser that is not
  // this one. It is read and remembered rather than deleted, because deleting
  // it would destroy the only evidence that something else may already hold
  // this profile — which is the collision case below.
  const previous = readDiscoveryRecord(request.profileDirectory);

  const child = spawn(request.executablePath, [...args], {
    // The whole point of this module. See the header: the library's launcher
    // owns what it starts, and this must not be owned.
    detached: true,
    // Released rather than inherited, so nothing ties the browser's lifetime
    // to this process's streams.
    stdio: 'ignore',
  });
  // Let this process exit without waiting for the browser it started.
  child.unref();

  const pid = child.pid;
  if (pid === undefined) {
    throw new StartupRefusal(
      LAUNCH_RULES.detached,
      'The browser process could not be spawned, so no process identifier was assigned. Nothing was started and nothing is attachable.',
    );
  }

  const deadline = Date.now() + timeoutMs;
  let lastDetail = 'the record never appeared';

  while (Date.now() < deadline) {
    const current = readDiscoveryRecord(request.profileDirectory);

    if (current !== undefined) {
      const isPrevious =
        previous !== undefined &&
        current.record.endpoint === previous.record.endpoint &&
        current.expectedUuid === previous.expectedUuid;

      const outcome = await verifyDiscoveryRecord(current.record, current.expectedUuid, {
        fetchImpl: options.fetchImpl,
      });

      if (outcome.ok) {
        if (isPrevious) {
          // The measured silent-collision case, and the reason this branch
          // is not simply "an endpoint answered, so we are done": the record
          // is the one that was already there, belonging to a browser this
          // call did not start. The spawned process handed its address to
          // the browser already holding the profile and exited zero. Serving
          // this would mean reporting a launch that did not happen and
          // recording a process identifier that is not the browser's.
          throw new StartupRefusal(
            LAUNCH_RULES.explicitProfileDir,
            'A browser is already running against this profile directory. The launch exited without opening its own endpoint and without reporting an error, which is what a profile collision looks like: the second process hands its address to the first and exits successfully. Attach to the running browser instead of starting a second one.',
          );
        }
        return { pid, record: outcome.record };
      }

      lastDetail = outcome.detail;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new StartupRefusal(
    LAUNCH_RULES.explicitProfileDir,
    `The browser was spawned but no debugging endpoint of its own ever answered (${lastDetail}). A launch is never inferred from the command exiting: a browser started against a profile directory already in use exits zero, opens no endpoint, and reports nothing.`,
  );
}
