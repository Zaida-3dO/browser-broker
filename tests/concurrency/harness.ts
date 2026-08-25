import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The contention harness: real operating-system processes, started together.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS SPAWNS PROCESSES AND WILL NOT BE SIMPLIFIED INTO PROMISES
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `SCHEMA.md` §1.0a and `MILESTONES.md` #12–#17: the contention this design
 * has is between **separate operating-system processes**. There is no
 * long-lived process — the service is spawned by its caller, serves that
 * session and exits — so several of them run against one store file by
 * construction.
 *
 * A version of this harness using promises, worker threads or several
 * connections inside one process would be **easier to write, faster to run,
 * and would exercise a mechanism this design does not have**. One process can
 * hold a lock in memory and can serialise its own callers before the database
 * ever sees them; none of the real callers can do either. Such a suite can be
 * made green by code that would double-issue in use, which is the precise
 * shape of a check that cannot fail.
 *
 * So: `spawn`, one child per caller, no exceptions.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE START BARRIER IS LOAD-BEARING, NOT TIDINESS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **Measured while building this harness, and it is the single detail the
 * suite's honesty rests on.** Spawning N children and letting each begin when
 * it is ready produces almost no contention: process startup costs far more
 * than the transaction does, so the children arrive spread out and each finds
 * the store idle. Under that arrangement the deferred control — the variant
 * that is *supposed* to fail — **passed 25 of 25**, and a suite shipping it
 * would have reported a green failing-control and proved nothing at all.
 *
 * Every child therefore waits for a shared release before beginning, so the
 * transactions overlap rather than queue. With the barrier in place the same
 * deferred run fails 19–23 times in 25, every run.
 *
 * ── Why the barrier is a rendezvous rather than a fixed deadline ────────
 *
 * **A wall-clock instant alone fails open.** The parent picks `now + lead`
 * and each child spins until it arrives — but a child that takes longer to
 * start than the lead allows finds the instant already past and *does not
 * wait at all*. It goes straight into its transaction while its siblings are
 * still starting. Nothing reports this; contention simply thins.
 *
 * Measured here by varying only the lead time, deferred failures out of 25:
 *
 * | lead    | failures per run   |
 * |---------|--------------------|
 * | 4000 ms | 22, 23, 23, 23, 23 |
 * | 800 ms  | 23, 23, 22         |
 * | 400 ms  | 10, 7, 10          |
 * | 100 ms  | 8, 9, 4, 7         |
 * | 50 ms   | 4, 5, 6, 4         |
 *
 * A slow or busy hosted runner is the same condition as a short lead, which
 * is how a deferred control can come back green on one CI run and red on the
 * next. **Every run in that table still satisfies a bare `failed.length > 0`
 * assertion**, so the erosion stays invisible right up until it reaches
 * zero — which is why the control asserts a quantity.
 *
 * So readiness is **signalled rather than predicted**: each child checks in
 * once it is loaded and connected, and the parent publishes the release
 * instant only after every child has checked in. The lead time stops being a
 * guess about the slowest runner and becomes a timeout on a condition that is
 * actually observed. Measured with the rendezvous in place, the same lead
 * times produce 19–23 failures throughout: the lead stops being
 * load-bearing.
 *
 * A child that is never released **raises rather than running alone**, so a
 * barrier that fails now fails loudly instead of quietly returning a number
 * the suite would read as a result. {@link CONTENTION_LEAD_MS} remains for
 * the workers that pass a bare instant.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The bare wall-clock instant handed to every child, kept for the workers
 * that do not join the rendezvous.
 *
 * **This is not what delivers contention** — the rendezvous is, and it waits
 * for a condition rather than predicting one. A child that reaches the
 * barrier late under a rendezvous still waits, because the release has not
 * been published yet; under this instant alone it would not wait at all,
 * which is the fail-open documented in this file's header.
 *
 * It remains generous because it is still the fallback when
 * {@link ContentionOptions.rendezvous} is off, and because the value is what
 * the earlier measurements in the header were taken against.
 */
export const CONTENTION_LEAD_MS = 4000;

/** What one child reports back on its single line of output. */
export interface ChildOutcome {
  /** Did the child's own transaction commit? */
  readonly ok: boolean;
  /** The driver's error code when it did not — `SQLITE_BUSY_SNAPSHOT` and friends. */
  readonly code: string | null;
  /** The message, for a failure the assertion wants to describe. */
  readonly message: string | null;
  /** Whatever the worker chose to report about what it did. */
  readonly detail: Record<string, unknown>;
}

export interface ContentionRun {
  readonly outcomes: readonly ChildOutcome[];
  /** The children whose transaction committed. */
  readonly succeeded: readonly ChildOutcome[];
  /** The children whose transaction did not. */
  readonly failed: readonly ChildOutcome[];
  /** How many children reported each driver error code. */
  readonly codes: Readonly<Record<string, number>>;
}

export interface ContentionOptions {
  /** The worker script, resolved against this directory. */
  readonly worker: string;
  /** How many operating-system processes to start. */
  readonly processes: number;
  /** Arguments every child receives after the barrier instant. */
  readonly argv: readonly string[];
  /** Environment for every child, merged over this process's own. */
  readonly env?: Readonly<Record<string, string>>;
  /** Override the lead time. Tests that do not contend can afford a short one. */
  readonly leadMs?: number;
  /**
   * Wait for every child to signal readiness before releasing them.
   *
   * **On by default, because the alternative fails open.** A bare deadline
   * silently stops producing contention on a runner slower than the lead
   * time, and nothing reports that it has — which is how a deliberately-
   * failing control comes back green. Turning this off is for a test that is
   * measuring something other than contention and can afford not to wait.
   */
  readonly rendezvous?: boolean;
  /** Override how long the parent waits for every child to check in. */
  readonly readyTimeoutMs?: number;
}

/**
 * Start N processes against one barrier and collect what each reported.
 *
 * A child that writes nothing parseable is reported as a failure with the
 * code `no-output` rather than being dropped: a worker that crashed before it
 * could speak is a result, and silently discarding it would let a suite go
 * green on children that never ran.
 */
export async function contend(options: ContentionOptions): Promise<ContentionRun> {
  const workerPath = path.join(HERE, options.worker);
  const startAt = Date.now() + (options.leadMs ?? CONTENTION_LEAD_MS);

  // The rendezvous directory, if this run wants a signalled barrier rather
  // than a bare deadline. See {@link rendezvous} for why the default is on.
  const wantsRendezvous = options.rendezvous ?? true;
  const rendezvousDirectory = wantsRendezvous
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'broker-rendezvous-'))
    : null;

  try {
    const childEnv =
      rendezvousDirectory === null
        ? options.env
        : { ...options.env, BROKER_RENDEZVOUS_DIR: rendezvousDirectory };

    const children = Array.from(
      { length: options.processes },
      async (_unused, index): Promise<ChildOutcome> =>
        runOne(workerPath, [String(startAt), String(index), ...options.argv], childEnv, index),
    );

    // Release only once every child has said it is ready. A fixed lead time is
    // a guess about the slowest runner; this is the condition that guess was
    // standing in for, observed rather than assumed.
    const release =
      rendezvousDirectory === null ? null : releaseWhenAllReady(rendezvousDirectory, options);

    const outcomes = await Promise.all(children);
    if (release !== null) await release;
    return summarise(outcomes);
  } finally {
    if (rendezvousDirectory !== null) {
      fs.rmSync(rendezvousDirectory, { recursive: true, force: true });
    }
  }
}

/**
 * Wait for every child to check in, then publish the instant they all leave
 * at.
 *
 * **The lead time is now a timeout on an observed condition rather than a
 * prediction.** If the children check in quickly the release is soon; if the
 * runner is slow it is later, and the overlap is the same either way. That is
 * the whole repair: the previous barrier degraded silently on a slow machine
 * because a late child simply found its deadline already past and never
 * waited.
 *
 * If they do not all arrive, this publishes nothing and the children time out
 * and say so — loudly, rather than contending in a thin group and reporting a
 * number the suite would read as a result.
 */
async function releaseWhenAllReady(directory: string, options: ContentionOptions): Promise<void> {
  const deadline = Date.now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);

  while (Date.now() < deadline) {
    const ready = fs.readdirSync(directory).filter((name) => name.startsWith('ready-')).length;
    if (ready >= options.processes) {
      // Every child is loaded and waiting. A small margin so that the write
      // below is visible to all of them before the instant it names arrives.
      fs.writeFileSync(path.join(directory, 'release'), String(Date.now() + RELEASE_MARGIN_MS));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  // Deliberately publishes nothing: the children raise the error, so the
  // failure arrives as a per-child outcome the assertions can describe.
}

/** How long the parent waits for every child to check in. */
const READY_TIMEOUT_MS = 45000;

/**
 * How long after the last check-in the children are released.
 *
 * Small, because every child is already spinning on the release file by the
 * time it is written — this only has to cover the write becoming visible.
 */
const RELEASE_MARGIN_MS = 25;

function summarise(outcomes: readonly ChildOutcome[]): ContentionRun {
  const codes: Record<string, number> = {};
  for (const outcome of outcomes) {
    if (outcome.ok) {
      continue;
    }
    const key = outcome.code ?? 'unknown';
    codes[key] = (codes[key] ?? 0) + 1;
  }

  return {
    outcomes,
    succeeded: outcomes.filter((outcome) => outcome.ok),
    failed: outcomes.filter((outcome) => !outcome.ok),
    codes,
  };
}

/**
 * One child, and everything it said.
 *
 * The child is given no shell — `spawn` with an argument vector, so a path
 * containing a space is not a quoting problem and the same call works on
 * every platform the pipeline runs.
 */
function runOne(
  workerPath: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>> | undefined,
  index: number,
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, ...argv], {
      env: { ...process.env, ...env, BROKER_RENDEZVOUS_INDEX: String(index) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.stderr.on('data', (chunk: string) => (err += chunk));

    child.on('close', () => {
      resolve(parseOutcome(out, err));
    });
  });
}

/**
 * Read a child's line, treating anything unparseable as a failed child rather
 * than as no child at all.
 */
function parseOutcome(out: string, err: string): ChildOutcome {
  const line = out.trim().split('\n').at(-1) ?? '';
  if (line === '') {
    return {
      ok: false,
      code: 'no-output',
      message: err.trim() === '' ? 'the child produced no output' : err.trim(),
      detail: {},
    };
  }
  try {
    const parsed = JSON.parse(line) as Partial<ChildOutcome>;
    return {
      ok: parsed.ok === true,
      code: parsed.code ?? null,
      message: parsed.message ?? null,
      detail: parsed.detail ?? {},
    };
  } catch {
    return { ok: false, code: 'unparseable-output', message: line, detail: {} };
  }
}
