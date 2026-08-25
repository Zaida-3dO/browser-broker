import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXPECTED_VERSION } from '../../../src/store/schema/steps.ts';

/**
 * The first two spawns on a machine that has never run this.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS SPAWNS REAL PROCESSES AND WILL NOT BE SIMPLIFIED INTO PROMISES
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The service is **spawned per session and exits with it**, so two callers
 * starting at once is not an exotic race — it is the ordinary case, and it is
 * precisely the case a fresh install hits: the first two agents to reach for a
 * browser on a machine with no store yet.
 *
 * The hazard is a check-then-act across a transaction boundary. When the
 * version read sits **outside** the transaction, two processes both read zero,
 * both decide to apply step one, and the loser runs a `CREATE TABLE` the winner
 * has already committed — `table browsers already exists`.
 *
 * A version of this using promises, worker threads or two connections inside
 * one process would be easier to write, faster to run, and **would exercise a
 * mechanism this design does not have**: one process can serialise its own
 * callers in memory before the database ever sees them, and none of the real
 * callers can.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE START BARRIER IS LOAD-BEARING, NOT TIDINESS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Measured in the cross-process suite this borrows its shape from: without a
 * barrier, process startup costs far more than the work does, the children
 * arrive spread out, each finds the store already stepped — and a control that
 * is *supposed* to fail passed 25 of 25.
 *
 * Here the effect is worse than a weak signal, because the window is narrower
 * than an arbitration transaction's: the loser only collides if it reads the
 * version before the winner commits step one, which is a few milliseconds on a
 * fresh file. Without a barrier this test would pass with the defect fully
 * present. Every child therefore receives one wall-clock instant and spins
 * until it arrives.
 *
 * **Missing the barrier fails open** — it quietly removes the contention while
 * still reporting success — so the lead is generous rather than trimmed.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE CHILD GOES THROUGH `prepareStore`
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **A reproduction that passes is not a test that passes.** An earlier attempt
 * at this fix returned the transaction promise without awaiting it, so a
 * `finally` restored a suspended pragma before the transaction had begun. A
 * hand-rolled reproduction that called the stepper directly passed; only a
 * caller coming through the real entry point caught it. The child therefore
 * calls `prepareStore` and nothing else, so every pragma and every `await` in
 * the startup path is inside the measurement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE FIXTURE IS THE REAL FIRST-SPAWN CONDITION, NOT A TIDIED ONE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Nothing is seeded. The directory holds **no store file at all** — not an
 * empty one, not a stepped one, not one at version zero created by the test.
 * `openStore` creates the file and the stepper steps it from nothing, which is
 * the condition a fresh install is actually in. A fixture that pre-created the
 * file would be a state cleaner than production, and the collision being
 * measured happens during creation.
 */

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'worker-first-spawn.mjs');

/**
 * How long children are given to reach the barrier before it opens.
 *
 * Sized for the slowest hosted runner rather than for this machine, and larger
 * than the arbitration suite's because these children import and type-strip
 * the application's startup path before they arrive. A child that reaches the
 * barrier after the instant has passed does not wait at all, and every child
 * that misses it is one fewer process in the collision window.
 */
const LEAD_MS = 6000;

/**
 * How many processes race for the empty store.
 *
 * Two is the number the defect is stated in and the number a fresh install
 * actually produces. More would collide more reliably; using more would also
 * let a fix that merely narrowed the window pass while two still raced, which
 * is the case that matters.
 */
const PROCESSES = 2;

interface ChildOutcome {
  readonly ok: boolean;
  readonly code: string | null;
  readonly message: string | null;
  readonly detail: Record<string, unknown>;
}

/**
 * Start N processes against one barrier and collect what each reported.
 *
 * A child that writes nothing parseable is reported as a failure rather than
 * dropped: a worker that crashed before it could speak is a result, and
 * discarding it silently would let this go green on children that never ran.
 */
async function spawnTogether(
  directory: string,
  processes: number,
  leadMs: number,
): Promise<ChildOutcome[]> {
  const startAt = Date.now() + leadMs;
  const env = {
    ...process.env,
    BROKER_DB: path.join(directory, 'broker.db'),
    BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
    BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
    BROKER_TAB_BUDGET: '15',
    BROKER_LEASE_SECONDS: '600',
    BROKER_QUEUE_SECONDS: '600',
  };

  return Promise.all(
    Array.from(
      { length: processes },
      () =>
        new Promise<ChildOutcome>((resolve) => {
          // An argument vector and no shell, so a temporary path containing a
          // space is not a quoting problem on any platform in the matrix.
          const child = spawn(process.execPath, [WORKER, String(startAt)], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let out = '';
          let err = '';
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => (out += chunk));
          child.stderr.on('data', (chunk: string) => (err += chunk));

          child.on('close', () => {
            const line = out.trim().split('\n').at(-1) ?? '';
            if (line === '') {
              resolve({
                ok: false,
                code: 'no-output',
                message: err.trim() === '' ? 'the child produced no output' : err.trim(),
                detail: {},
              });
              return;
            }
            try {
              const parsed = JSON.parse(line) as Partial<ChildOutcome>;
              resolve({
                ok: parsed.ok === true,
                code: parsed.code ?? null,
                message: parsed.message ?? null,
                detail: parsed.detail ?? {},
              });
            } catch {
              resolve({ ok: false, code: 'unparseable-output', message: line, detail: {} });
            }
          });
        }),
    ),
  );
}

/**
 * Everything both cases assert about the store two racing spawns left behind.
 *
 * Read on a connection that took no part in the contention. **This is the
 * house rule and it is not optional:** a read through a handle that
 * participated sees that connection's own view rather than what committed, and
 * can pass while the violation is present.
 */
function assertStoreIsWhole(databasePath: string, outcomes: readonly ChildOutcome[]): void {
  const reader = new Database(databasePath, { readonly: true });
  const version = reader.pragma('user_version', { simple: true }) as number;
  const tables = reader
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'browsers'`)
    .all();
  reader.close();

  assert.equal(
    version,
    EXPECTED_VERSION,
    'The store the two processes left behind must be stamped at the version this build expects.',
  );
  assert.equal(
    tables.length,
    1,
    'The schema must actually have been created, rather than the version being stamped over an empty file.',
  );

  // Every child reports the version it observed after its own `prepareStore`
  // returned, so a child that "succeeded" against an unstepped store would be
  // visible here rather than hidden behind the reader's later view.
  for (const outcome of outcomes) {
    assert.equal(
      outcome.detail['version'],
      EXPECTED_VERSION,
      `Each process must return a handle on a store at the expected version; one saw ${String(outcome.detail['version'])}.`,
    );
  }
}

/** A temporary directory with no store in it, removed however the body ends. */
async function withEmptyDirectory(fn: (directory: string) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-first-spawn-'));
  try {
    await fn(directory);
  } finally {
    // `force` because a child on one platform may still be releasing its
    // handle as the test ends, and a teardown that throws would fail a test
    // whose property held.
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('two processes spawning at once against a store that does not exist both succeed', async () => {
  await withEmptyDirectory(async (directory) => {
    const outcomes = await spawnTogether(directory, PROCESSES, LEAD_MS);
    const failed = outcomes.filter((outcome) => !outcome.ok);

    // ── The assertion the whole file exists for ──────────────────────────
    //
    // With the version read outside the transaction this fails with
    // `table browsers already exists`: both children read version zero, both
    // decide step one is pending, and the loser creates a table the winner
    // already committed. §1.2d promises every spawn steps the schema and that a
    // store already at the right version is left untouched — true once the
    // store exists, and this is the assertion that it is also true for the
    // first two.
    assert.equal(
      failed.length,
      0,
      `Every process spawning against an empty store must succeed; ${String(failed.length)} of ${String(PROCESSES)} did not. ` +
        `The first said: ${String(failed[0]?.message)}. ` +
        `An "already exists" here is the schema stepper racing: the version read must happen inside the same ` +
        `transaction as the steps, so the loser of the race reads the version the winner committed rather than the ` +
        `zero it read before the winner started.`,
    );

    assertStoreIsWhole(path.join(directory, 'broker.db'), outcomes);
  });
});

test('two processes spawning at once against an unstepped store both succeed, and one steps it', async () => {
  await withEmptyDirectory(async (directory) => {
    const databasePath = path.join(directory, 'broker.db');

    // ══════════════════════════════════════════════════════════════════════
    // WHY THIS CASE EXISTS SEPARATELY, AND WHY THE FIXTURE IS NOT A TIDIED ONE
    // ══════════════════════════════════════════════════════════════════════
    //
    // **The two defects on this path mask each other, which was measured.**
    // Converting a fresh file to write-ahead-log mode takes an exclusive lock,
    // so on a genuinely empty directory that conversion *itself* serialises the
    // two spawns: the loser reaches the stepper only after the winner has
    // finished stepping, and never enters the stepper's race at all. With the
    // conversion fixed and the stepper's version read moved back outside its
    // transaction, the case above **passed 4 runs in 5** — a mutation surviving
    // for a reason that has nothing to do with the stepper. Shrinking the
    // retry's pause did not help either; it is the conversion that serialises
    // them, not the waiting.
    //
    // So the store is put into the state the conversion leaves behind, and the
    // race that remains is purely the stepper's. Under that same mutation this
    // case reproduces `table browsers already exists` **5 runs in 5**.
    //
    // **This is a state the product reaches, not one invented for the test.**
    // A file in write-ahead-log mode at `user_version` zero with no tables is
    // exactly what exists in the window between the first spawn's conversion
    // and its first schema step — and it is also what any spawn that converted
    // and then died would leave. Seeding a state no code path produces is the
    // hollow shape this suite is written against; this is the opposite of that,
    // and the pre-creation touches nothing the stepper reads except the journal
    // mode.
    const seed = new Database(databasePath);
    seed.pragma('journal_mode = WAL');
    seed.close();

    const outcomes = await spawnTogether(directory, PROCESSES, LEAD_MS);
    const failed = outcomes.filter((outcome) => !outcome.ok);

    assert.equal(
      failed.length,
      0,
      `Every process spawning against an unstepped store must succeed; ${String(failed.length)} of ${String(PROCESSES)} did not. ` +
        `The first said: ${String(failed[0]?.message)}. ` +
        `An "already exists" here is the schema stepper racing: the version read must happen inside the same ` +
        `transaction as the steps, so the loser of the race reads the version the winner committed rather than the ` +
        `zero it read before the winner started.`,
    );

    assertStoreIsWhole(databasePath, outcomes);
  });
});
