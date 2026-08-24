import type { Database } from 'better-sqlite3';

/**
 * The immediate-transaction primitive every arbitration path is built from.
 *
 * ── Why the mode is correctness rather than tuning ──────────────────────
 *
 * `SCHEMA.md` §1.0a: an immediate transaction declares its intent to write
 * **at the moment it opens**, which makes the store serialise the writers
 * itself instead of discovering a conflict at the end. Measured: 30
 * concurrent processes on an immediate transaction all succeeded, with no
 * repeats and no lost writes. The same test on a deferred transaction with a
 * widened read-then-write window failed 15 times in 25, with a busy-snapshot
 * error **the busy-timeout setting cannot retry** — the transaction holds a
 * read snapshot it has lost the right to upgrade, so there is nothing to wait
 * for. The arbitration shape is a wide read-then-write window by
 * construction, which is the worst possible shape for the mode that fails.
 *
 * **The trap is that deferred passes at low contention.** A test suite is not
 * what catches this, which is why `arbitration.immediate_transaction` (§7.3)
 * is a build rule.
 *
 * ── Why the statement is written out rather than delegated ──────────────
 *
 * The driver ships `.immediate()`, `.deferred()` and `.exclusive()` variants
 * on its own transaction helper. This issues the literal instead, for one
 * reason: the mode has to be assertable by a test that names it, and
 * `MILESTONES.md` puts it plainly — "the single-character change that breaks
 * this test is dropping `IMMEDIATE`". A wrapper around the driver's helper
 * would leave a later cleanup free to simplify it to the bare form, which is
 * **deferred by default**, and nothing in the diff would say so.
 *
 * ── What this shape does and does not guarantee ─────────────────────────
 *
 * This is the only transaction affordance the store handle exports, and that
 * is a convention rather than a construction. It is worth being exact,
 * because the check row #50 owes depends on knowing the difference: a
 * savepoint opens a transaction with no `BEGIN` token to find, and a bare
 * statement outside any transaction takes its lock at statement time, which
 * is precisely the not-declared-at-open case the rule exists to prevent.
 * Both were tried and both work. So narrowing the surface makes the rule
 * **greppable** and makes the obvious path the correct one; it does not make
 * the rule true by construction, and #50's check has to be built against
 * that rather than against a single identifier.
 */

/**
 * Work to run after the commit, outside every transaction.
 *
 * `SCHEMA.md` §2.4b and `arbitration.no_browser_io` (§7.3): no browser call
 * happens inside the arbitration transaction, because one unresponsive
 * browser inside it blocks every arbitration call on the machine. The
 * arbitration shape is therefore *collect inside, act outside* — the sweep
 * gathers the tabs it has to close, the transaction commits, and only then
 * are they closed, best effort.
 *
 * That collection is in this signature from the start so the correct shape is
 * the path of least resistance. A helper that only offered "run this inside"
 * would leave the author of the first arbitration path to invent the
 * outside-the-transaction seam, and the most natural way to invent it is by
 * widening the callback — which is the violation.
 */
export interface TransactionResult<T> {
  readonly value: T;
  /** Ran after the commit, in order, each failure swallowed. */
  readonly afterCommit?: readonly (() => void | Promise<void>)[];
}

/** What the callback may do inside the transaction. */
export interface TransactionScope {
  readonly db: Database;
}

/**
 * The statement that opens the transaction. Exported so a test can assert the
 * mode by naming the literal rather than by trusting this comment.
 */
export const BEGIN_STATEMENT = 'BEGIN IMMEDIATE';

/**
 * Run `fn` inside an immediate transaction: commit on success, roll back and
 * rethrow on a throw.
 *
 * After-commit actions run once the transaction has ended, and a failure in
 * one does not undo the commit — the work is done and the store says so. They
 * are best effort by design (§2.4b), not by oversight.
 */
export async function immediate<T>(
  db: Database,
  fn: (scope: TransactionScope) => TransactionResult<T> | Promise<TransactionResult<T>>,
): Promise<T> {
  db.prepare(BEGIN_STATEMENT).run();

  let result: TransactionResult<T>;
  try {
    result = await fn({ db });
  } catch (error) {
    // Rolling back is the point of this branch: the caller must not be able
    // to leave a partial write behind by throwing.
    db.prepare('ROLLBACK').run();
    throw error;
  }

  db.prepare('COMMIT').run();

  for (const action of result.afterCommit ?? []) {
    try {
      await action();
    } catch {
      // Best effort, outside the transaction, after the commit. A tab that
      // will not close is not a reason to report failed work that succeeded.
    }
  }

  return result.value;
}
