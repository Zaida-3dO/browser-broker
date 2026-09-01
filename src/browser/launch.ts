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
 * error. It hands its address to the browser already holding the profile,
 * with nothing on the error stream and **no debugging endpoint of its own
 * ever opened**. A launcher waiting on its own endpoint therefore waits for
 * something that will never appear.
 *
 * **What it does NOT do is exit.** This file asserted for some time that the
 * losing process "exits zero on its own", and that claim was false on the
 * platform this runs on: measured on Windows, the losing `chrome.exe` stays
 * alive indefinitely — `HasExited=False`, `Responding=True`, long after the
 * process that spawned it has gone. See the kill-condition table below for
 * what is done about it, and §13k for why the correction did not reverse the
 * rule it was attached to.
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
 *
 * ── What happens to the process when the assertion fails ────────────────
 *
 * **Measured, 1,637 browser processes across 164 launches, and a frozen
 * machine.** A detached spawn whose endpoint never answered was thrown away
 * without being killed, on every failure path, and each one stayed alive: the
 * table at the top of this file records that a detached browser survives the
 * death of the process that spawned it by design, which is exactly why it
 * cannot be left behind by accident.
 *
 * The rule that made this easy to miss is a real one and it is kept:
 * **browsers are adopted, not owned, and a browser outlives every process
 * that touched it.** There is deliberately no close-browser operation on the
 * seam (`browser_scoped.never`, §7.3).
 *
 * That rule governs a browser that was **successfully launched and adopted**.
 * A browser whose endpoint never answered **was adopted by nobody**: nothing
 * holds a reference to it, no row names it, and the lazy global sweep
 * reconciles claims and tabs rather than orphaned operating-system processes.
 * It is unreachable by every reclamation path this design has, so if this
 * function does not end it here, nothing ever will. Cleaning up a launch that
 * failed is not owning a browser — there is no browser, only a process that
 * never became one.
 *
 * ── The kill-condition table: which failure paths kill, and which must not ──
 *
 * | Failure path | Kills? | Why |
 * |---|---|---|
 * | **No process identifier assigned** (the spawn was refused synchronously) | **No** | There is no process. Nothing was started, so there is nothing to end and no identifier to aim at |
 * | **Profile collision** — an endpoint answered and it is the *previous* record | **Yes — the spawned identifier, and NEVER what holds the profile** | Two different processes, and the distinction is the whole of this row. The browser **behind the answering endpoint** belongs to **somebody else** and is quite possibly the signed-in one carrying the shared sign-in: killing *that* destroys another caller's browser and the very thing the keeper tab exists to protect, so it is never done, on any path. But the process **this call spawned** is not that browser — it lost the race, opened no endpoint, was adopted by nobody, and (measured on Windows) **does not exit on its own**. It is reached only through the identifier the spawn returned, so ending it is the same narrow act as the rows below, not the forbidden one |
 * | **Spawn failure reported *during* the readiness loop** (the early-report race) | **Yes** | Same process, same reasoning — it just leaves the function from the race rather than from a `throw`. Called out separately because it is the **fast** path: a machine whose browser binary is broken takes this one every time, so a version that only cleaned up the two written `throw`s would still leak on the most common failure |
 * | **Spawn failure reported after the readiness loop** | **Yes** | An identifier was assigned before the failure arrived, so a process may exist. The failure says the browser could not start, so whatever is under that identifier never became an adoptable browser |
 * | **Readiness timeout** — spawned, but no endpoint of its own ever answered | **Yes** | This is the path that produced the incident. The process is alive and is the one this call started, and it is reachable by nothing else |
 *
 * The kill is therefore **narrow by construction**: only a process that (a)
 * this call spawned, and (b) never became adoptable. It is aimed at the
 * identifier the spawn returned and never at a profile directory, a browser
 * that answered, or an image name.
 *
 * **That construction is what makes the collision row safe, and it is the
 * only thing that does.** "Kill the browser on this profile" and "kill the
 * identifier this call spawned" read as near-synonyms on the collision path
 * and are opposite acts: on that path the profile is held by somebody else's
 * browser, so the first is the exact damage the keeper tab exists to prevent.
 * Measured: with the losing identifier signalled, the browser behind the
 * answering endpoint keeps serving `/json/version`. An implementation that
 * matched by profile directory or by image name would pass the same test
 * suite and do that damage in production.
 *
 * **The residual risk, named rather than left implicit:** an identifier can in
 * principle be reused by the operating system between the spawn and the
 * signal, in which case this signals an unrelated process. That risk is real,
 * is identical on all four killing rows, and is not specific to the collision
 * path — it is the price of holding an identifier at all, and it is bounded by
 * the swallow below.
 *
 * And it is **best effort**, because it is cleanup on a path that is already
 * reporting a refusal. An identifier that has already exited, one the
 * operating system will not let this process signal, and one that was never
 * assigned are all ordinary states here, and none of them is worse than the
 * refusal already being raised. So a failure to kill is swallowed and the
 * original refusal travels unchanged: turning a clean, explanatory refusal
 * into a crash from its own cleanup would be a worse bug than the leak.
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
  /**
   * How the browser is started. Injected so the failure paths can be driven
   * without a real browser: the leak this guards against is a *process left
   * alive*, and a test that spawned a real one to prove it gets killed would
   * be a test that leaks a browser whenever it fails.
   */
  readonly spawnImpl?: typeof spawn;
  /**
   * How a process this call spawned is ended. Injected for the same reason,
   * and separately from the spawn so a test can assert on **which identifier**
   * was signalled — the whole correctness of this fix is that it aims at the
   * process this call started and at nothing else.
   */
  readonly killImpl?: (pid: number) => void;
}

/**
 * End a process this launch spawned that never became an adoptable browser.
 *
 * **Best effort, and silent about its own failures on purpose.** Every caller
 * is on a path that is already raising a refusal, and every plausible failure
 * here — the process exited on its own between the check and the signal, the
 * operating system refuses this process permission to signal it, no
 * identifier was ever assigned — means either *there is nothing left to kill*
 * or *this process cannot do anything about it*. Neither is news the caller
 * can act on, and neither is worth losing the refusal over: it explains what
 * actually went wrong, and a crash raised by the cleanup would not.
 *
 * See the kill-condition table in the module header for **which** paths call
 * this and, more importantly, which one must not.
 *
 * **The identifier is a `number`, not an optional one, deliberately.** The
 * no-identifier case is refused before the readiness loop begins, so every
 * caller here has already been narrowed to a definite identifier. Accepting
 * an optional one and returning early on `undefined` would look more careful
 * and would in fact be *less* safe: the branch is unreachable, so nothing can
 * test it, and an unreachable branch is exactly the shape that quietly starts
 * swallowing a real identifier when a later caller is added. The type is what
 * enforces the table's first row instead.
 */
function killSpawnedProcess(pid: number, killImpl: (pid: number) => void): void {
  try {
    killImpl(pid);
  } catch {
    // Already gone, or not ours to signal. Both are fine here: the refusal
    // this cleanup runs alongside is the thing the caller needs, and it must
    // reach them unchanged.
  }
}

/** Signal a process by identifier, and only by identifier. */
function defaultKill(pid: number): void {
  // By process identifier, never by image name: this must end the one process
  // this call spawned, and a name matches every browser on the machine
  // including other callers' adopted ones.
  process.kill(pid);
}

/**
 * How long a cold start waits for its endpoint before declaring failure.
 *
 * **This is a bound, not the answer to §1.2b.** Row #55 owns what a caller
 * that *lost* the launch race waits for and for how long, and that question
 * is recorded as genuinely open. This number is the narrower one this row
 * cannot ship without: the process this call itself spawned either produces
 * an endpoint or it did not start, and without a bound the silent-collision
 * case — no endpoint, ever — hangs forever rather than reporting.
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
  const spawnImpl = options.spawnImpl ?? spawn;
  const killImpl = options.killImpl ?? defaultKill;
  const args = launchArguments(request);

  // The profile directory has to exist for the browser to write its record
  // into it. Created, never cleared — `setup.profile_never_destroyed` (§7.2).
  fs.mkdirSync(request.profileDirectory, { recursive: true });

  // Any record from a previous browser is a claim about a browser that is not
  // this one. It is read and remembered rather than deleted, because deleting
  // it would destroy the only evidence that something else may already hold
  // this profile — which is the collision case below.
  const previous = readDiscoveryRecord(request.profileDirectory);

  const child = spawnImpl(request.executablePath, [...args], {
    // The whole point of this module. See the header: the library's launcher
    // owns what it starts, and this must not be owned.
    detached: true,
    // Released rather than inherited, so nothing ties the browser's lifetime
    // to this process's streams.
    stdio: 'ignore',
  });

  // ── A spawn that fails does so ASYNCHRONOUSLY, and unhandled it is fatal ──
  //
  // **Measured, on a machine with no browser installed:** spawning a path that
  // does not exist **still returns a child and still assigns a process
  // identifier**, and reports the failure moments later by emitting `error` on
  // the child. With nothing listening, that is an unhandled error event, which
  // does not reject this promise — it **ends the process**, escaping every
  // `catch` between here and the caller.
  //
  // That is the worst available shape for this particular failure. A browser
  // that is not installed is an ordinary state (§2.4b's after-commit work is
  // best effort precisely so it can be), and the caller's own handling turns
  // it into an honest `pageDriven: false`. An unhandled event instead takes
  // the whole process down, so a page verb against a machine with no browser
  // would kill the service rather than answer.
  //
  // A listener is therefore attached **before the first await**, and it turns
  // the event into a rejection this function's caller can handle like any
  // other refusal. `pid` being assigned is why the check below is not
  // sufficient on its own.
  let spawnFailure: Error | undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    child.once('error', (error: Error) => {
      spawnFailure = error;
      reject(
        new StartupRefusal(
          LAUNCH_RULES.detached,
          `The browser could not be started: ${error.message}. Nothing was launched, so there is nothing to attach to. This is the ordinary state of a machine with no browser installed.`,
          { cause: error },
        ),
      );
    });
  });
  // Nothing waits on this promise unless it rejects, and an unobserved
  // rejection is itself a process-level warning — so it is given a handler
  // that does nothing, and the rejection is observed by the races below.
  failed.catch(() => undefined);

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
          // the browser already holding the profile. Serving this would mean
          // reporting a launch that did not happen and recording a process
          // identifier that is not the browser's.
          //
          // ── TWO PROCESSES HERE, AND ONLY ONE OF THEM MAY BE ENDED ───────
          //
          // **This path is the one that matters most to get right**, because
          // the two processes involved are easy to conflate and the wrong
          // one is somebody else's browser.
          //
          // What is alive and **must never be touched** is the browser behind
          // the endpoint that just answered: another caller's adopted
          // browser, quite possibly the signed-in one whose keeper tab holds
          // the shared sign-in open. Nothing on any path in this file signals
          // it. It is reached only through the discovery record, and the
          // record is read here, never acted on destructively.
          //
          // What is *also* alive is **the process this call spawned**. It
          // does not exit on its own: measured on Windows it stays alive
          // indefinitely (`HasExited=False`, `Responding=True`) long after
          // this process is gone — a collision is the losing process handing
          // its address over, not the losing process ending. It opened no
          // endpoint of its own, no row
          // names it and the lazy global sweep reconciles claims and tabs
          // rather than orphaned operating-system processes — so, exactly as
          // on the readiness-timeout path below, if this function does not
          // end it here nothing ever will.
          //
          // So it is ended, **by the identifier the spawn returned and by
          // nothing else**. That is not the forbidden act: an implementation
          // that killed "the browser on this profile" would read as
          // symmetrical and would destroy the sign-in. Measured: with this
          // identifier signalled, the browser behind the answering endpoint
          // keeps serving. See §13k.
          killSpawnedProcess(pid, killImpl);
          throw new StartupRefusal(
            LAUNCH_RULES.explicitProfileDir,
            'A browser is already running against this profile directory. The launch opened no endpoint of its own and reported no error, which is what a profile collision looks like: the second process hands its address to the first. That losing process has been ended; the browser already holding the profile was left untouched. Attach to the running browser instead of starting a second one.',
          );
        }
        return { pid, record: outcome.record };
      }

      lastDetail = outcome.detail;
    }

    // Raced against the spawn failure, so a browser that could not start is
    // reported the moment it says so rather than after the readiness timeout
    // has elapsed. Waiting out the full timeout would turn *no browser
    // installed* — an instant, knowable answer — into the slowest path here.
    //
    // The rejection is caught **only** to run the cleanup, and is then
    // re-thrown exactly as it was. This is a fourth way out of this function
    // and it is easy to miss when reading for `throw`, because the refusal is
    // constructed far above and escapes from here without one: a spawn
    // failure arriving *during* the loop leaves by this line rather than by
    // the check below it. Without this, the early-report optimisation would
    // be the one path that still leaked — and it is the fast path, so it is
    // the one a machine with a broken browser binary would take every time.
    try {
      await Promise.race([new Promise((resolve) => setTimeout(resolve, pollMs)), failed]);
    } catch (error) {
      killSpawnedProcess(pid, killImpl);
      throw error;
    }
  }

  if (spawnFailure !== undefined) {
    // An identifier was assigned before the failure arrived — that is the
    // measured shape of an asynchronous spawn failure — so a process may
    // exist under it, and whatever it is, it never became a browser anything
    // could adopt. Best effort, so the refusal below is what the caller sees.
    killSpawnedProcess(pid, killImpl);
    throw new StartupRefusal(
      LAUNCH_RULES.detached,
      `The browser could not be started: ${spawnFailure.message}. Nothing was launched, so there is nothing to attach to.`,
      { cause: spawnFailure },
    );
  }

  // ── The path that produced the incident ────────────────────────────────
  //
  // Spawned, alive, and no endpoint of its own ever answered. Nothing holds a
  // reference to this process, no row names it, and the sweep that reclaims
  // abandoned work reconciles claims and tabs rather than orphaned processes
  // — so this function is the only thing that will ever end it. Left alone it
  // accumulates one browser per failed launch, which is how 164 launches
  // became 1,637 processes and a machine that stopped responding.
  killSpawnedProcess(pid, killImpl);
  throw new StartupRefusal(
    LAUNCH_RULES.explicitProfileDir,
    `The browser was spawned but no debugging endpoint of its own ever answered (${lastDetail}). A launch is never inferred from the command exiting: a browser started against a profile directory already in use opens no endpoint and reports nothing, whether or not its process is still alive.`,
  );
}
