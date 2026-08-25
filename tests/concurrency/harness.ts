import { spawn } from 'node:child_process';
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
 * Every child therefore receives one wall-clock instant and spins until it
 * arrives, so the transactions overlap rather than queue. With the barrier in
 * place the same deferred run fails 21–24 times in 25, every run.
 *
 * The lead time has to cover process startup on the slowest runner. It is
 * generous on purpose: too short degrades to the no-barrier case above, which
 * fails **open** — a control that stops controlling while still reporting
 * success. {@link CONTENTION_LEAD_MS} carries the number and the reasoning.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * How long children are given to reach the barrier before it opens.
 *
 * Sized for the slowest hosted runner rather than for this machine: a child
 * that arrives *after* the instant has passed does not wait at all, and every
 * child that misses it is one fewer transaction in the overlap. Missing the
 * barrier does not fail loudly — it quietly reduces contention — so the
 * number is set well above what is needed rather than trimmed to what is.
 *
 * The cost of being generous is this many seconds per contention test, paid
 * once each; the cost of being mean is a control that silently stops
 * controlling.
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

  const children = Array.from(
    { length: options.processes },
    async (_unused, index): Promise<ChildOutcome> =>
      runOne(workerPath, [String(startAt), String(index), ...options.argv], options.env),
  );

  const outcomes = await Promise.all(children);
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
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, ...argv], {
      env: { ...process.env, ...env },
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
