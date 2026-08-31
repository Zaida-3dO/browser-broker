import fs from 'node:fs';

/**
 * Remove a temporary directory, and **say so when it cannot be removed.**
 *
 * Two failures were folded into `fs.rmSync(dir, { recursive: true, force: true })`,
 * and they pull in opposite directions:
 *
 * 1. **`force` does not mean "retry".** It suppresses `ENOENT` — a path that
 *    was already gone — and nothing else. On Windows an open handle makes the
 *    unlink fail with `EPERM` (or `EBUSY`), which `force` happily rethrows.
 *    SQLite in WAL mode holds `-wal` and `-shm` alongside the database, so a
 *    teardown racing a handle that has been closed but not yet released by
 *    the OS is a real and load-dependent window.
 * 2. **A throw from teardown is attributed to the file, not the test.** When
 *    that `EPERM` escapes a `finally`, `node --test` reports a bare file-level
 *    failure with every subtest passing — a signature that reads like a
 *    fixture problem because it *is* one, but which names nothing that would
 *    let a reader find it.
 *
 * The remedy for the first is to retry. **Not `fs.rmSync`'s own
 * `maxRetries`/`retryDelay`, which do not help here** — measured on this
 * platform, `{ maxRetries: 20, retryDelay: 100 }` rejects an open-handle
 * directory in 0.1ms, identically to `{ maxRetries: 0 }`, so the built-in
 * budget never engages on this failure. Retrying therefore has to be explicit,
 * and the wait has to be a genuinely *blocking* one: `rmSync` is synchronous,
 * so a handle scheduled to close on this event loop could never close during
 * the loop, and a timer-based wait would deadlock rather than help. What the
 * loop does buy is time for a release the OS (or another process) is already
 * performing — which is exactly the load-dependent window being closed.
 *
 * The remedy for the second is **not** to swallow what survives the retries.
 * A teardown that silently gives up leaves a directory nobody is told about,
 * and this project has twice been bitten by a signal that could not be told
 * apart from a non-signal. So a genuine, persistent failure to remove still
 * throws — but with a message that names the directory, what is still inside
 * it, and the underlying error, so the next reader is not left with `EPERM`
 * and a path.
 *
 * @param directory the directory to remove, recursively
 * @throws if the directory still exists after the retries are exhausted
 */
/**
 * How long removal is retried before the failure is reported.
 *
 * ── Why this is seconds and not milliseconds ────────────────────────────
 *
 * The header above describes the wait as buying time "for a release the OS is
 * already performing". How long that actually takes is the whole question, and
 * a sub-second figure is an order of magnitude short of it — which is a
 * mistake about the platform rather than about the approach, and therefore one
 * that a plausible-looking number hides very well.
 *
 * MEASURED 2026-08-31 on Windows, timing from the browser's process actually
 * exiting to `rmSync` first succeeding against a real profile directory:
 *
 *   quiet machine        194ms, 367ms, 2113ms, 3300ms   -> 3 of 4 over 300ms
 *   40-way CPU load      334ms, 464ms, 502ms, 826ms,
 *                        1945ms, 2712ms, 2830ms, 4056ms -> 8 of 8 over 300ms
 *
 * A sub-second budget therefore expires on essentially every removal on a
 * loaded machine, and the resulting `EPERM` is thrown from a `finally` and
 * attributed by `node --test` to the FILE rather than to any test — the exact
 * names-nothing signature this module's header sets out to eliminate. On a
 * quiet machine it lands inside a short budget about half the time, which is
 * what makes a too-small figure here look survivable.
 *
 * **This is a bound on a condition, not a guess at a duration.** The loop
 * below returns the instant the removal succeeds, so a quiet machine still
 * pays only the ~200ms it actually needs; the budget is only how long the
 * wait is willing to last before it reports a genuine, persistent failure.
 * It is set well above the slowest figure measured so that ordinary
 * contention cannot expire it, because expiring early here does not degrade
 * gracefully — it turns a passing run red with a message about the wrong
 * thing.
 */
const REMOVE_BUDGET_MS = 30_000;

/** How long to wait between attempts, in milliseconds. */
const REMOVE_RETRY_DELAY_MS = 30;

/** How many times removal is attempted before the failure is reported. */
const REMOVE_ATTEMPTS = Math.ceil(REMOVE_BUDGET_MS / REMOVE_RETRY_DELAY_MS);

/**
 * Block this thread for `ms`.
 *
 * Deliberately blocking. The caller is synchronous, and the point of the wait
 * is to let *another* thread of control — the OS releasing a handle, or another
 * process exiting — make progress. `Atomics.wait` on a throwaway buffer is the
 * standard way to do that without a busy loop burning the CPU it is waiting on.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function removeDirectory(directory: string): void {
  let lastError: unknown;

  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
    try {
      // `force` remains, so a directory already gone is not an error — an
      // exit sweep may legitimately have removed it first.
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      // No point sleeping after the final attempt; the failure is reported
      // immediately below.
      if (attempt < REMOVE_ATTEMPTS - 1) {
        sleepSync(REMOVE_RETRY_DELAY_MS);
      }
    }
  }

  // Retries exhausted. Report what is *actually* still there — a bare
  // `broker.db` means a handle on the database, a `-wal`/`-shm` pair means
  // a connection that never checkpointed, and that distinction is the whole
  // diagnosis for whoever reads this next.
  let remaining: string[] = [];
  try {
    remaining = fs.readdirSync(directory);
  } catch {
    // The listing is best-effort context for the message below; if it
    // fails too, the original error is still the thing worth reporting.
  }
  throw new Error(
    `could not remove the temporary store at ${directory} — ` +
      `${String(remaining.length)} entr${remaining.length === 1 ? 'y' : 'ies'} remain` +
      (remaining.length > 0 ? ` (${remaining.join(', ')})` : '') +
      '. A handle on the database was most likely still open when teardown ran; ' +
      'close the store (and any second connection opened on the same file) before removing it.',
    { cause: lastError },
  );
}
