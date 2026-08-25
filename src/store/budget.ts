import type { Database } from 'better-sqlite3';

import { StartupRefusal } from '../errors.ts';
import { BEGIN_STATEMENT } from './transaction.ts';

/**
 * `budget.agrees_with_store` (§7.2) — the one configuration value that is not
 * only an environment variable.
 *
 * ── Why this value gets a row and no other one does ─────────────────────
 *
 * §1.10 states the reason, and it is worth reading as a distinction rather
 * than as an exception, because the distinction is what keeps this to one row
 * instead of growing into the settings table §1.10 deletes:
 *
 * > **Several processes arbitrate against the tab budget simultaneously**
 * > (§1.0a). In one process's environment the budget can be fifteen; in
 * > another's, thirty. Each admits callers against its own belief, each is
 * > internally consistent, and **the ceiling silently stops being a
 * > ceiling.** Nothing reports this. The count is correct in every process
 * > and the machine is over budget anyway.
 *
 * That is a **broken invariant**, not degraded behaviour: the one number the
 * whole capacity model is a comparison against, disagreed upon by the things
 * doing the comparing.
 *
 * **The lease lifetime deliberately gets no such check.** Two processes
 * disagreeing there expires something a little early or a little late, which
 * is degraded behaviour — no bound is violated and no capacity is
 * over-allocated. **The rule is the distinction: a value several processes
 * must *agree* on gets the row; a value they merely each *use* does not.**
 *
 * ── Why neither number wins ─────────────────────────────────────────────
 *
 * Both of the accommodating answers are worse than the refusal:
 *
 * - **Adopting the stored value** runs a process against a bound it was not
 *   configured for. Somebody set a number and is not getting it, with nothing
 *   to notice by — which is the same silent-configuration failure §6.3
 *   refuses a bad value to avoid.
 * - **Overwriting the stored value** lets whichever process started most
 *   recently move a bound the others are **mid-arbitration against**. A
 *   process that admitted a caller under fifteen would find itself over a
 *   ceiling of ten, having done nothing wrong.
 *
 * So the refusal names both numbers, at the loudest and cheapest possible
 * moment, and the operator decides which one was meant.
 *
 * **The table itself belongs to the schema stepper**
 * (`schema/step-002-tab-budget.ts`), not to this module. A table created on
 * the side by whatever happens to need it is invisible to the version stamp,
 * so two installations could report the same schema version with different
 * tables — which is the failure the stepper's own rule exists to prevent.
 */

/** What the check found, for the ledger and for a caller that wants to say so. */
export interface BudgetAgreement {
  /** The budget in force, which is this process's own value in every case that returns. */
  readonly tabs: number;
  /** Was this process the one that wrote it in? */
  readonly recorded: boolean;
}

/**
 * Compare this process's tab budget against the store's, and refuse on a
 * disagreement.
 *
 * **The read and the write are one transaction, and that is not tidiness.**
 * Two processes opening an empty store within the same instant would
 * otherwise both read nothing and both write, and the second write is what
 * decides — so the value recorded would be whichever process happened to be
 * slower, and a genuine disagreement between them would be silently resolved
 * in favour of nobody in particular. Inside one immediate transaction the
 * loser reads the winner's row and compares against it, which is the intended
 * behaviour rather than a race.
 *
 * **This is not an arbitration path**, so it opens its own transaction rather
 * than going through the arbitration runner: it runs once per spawn, before
 * any operation exists to arbitrate, and there is nothing to sweep on behalf
 * of. It uses the same immediate mode for the same reason — the read-then-
 * write window above is exactly the shape §1.0a measures as failing when the
 * transaction does not declare its intent to write.
 *
 * The transaction is issued here rather than through `immediate()` from
 * `transaction.ts` only because that helper is asynchronous and a spawn's
 * startup checks are a synchronous sequence; the mode is identical and the
 * literal is imported from that module so the two cannot drift.
 */
export function agreeOnTabBudget(db: Database, tabs: number): BudgetAgreement {
  const recorded = readAndRecord(db, tabs);

  if (recorded.stored !== tabs) {
    throw new StartupRefusal(
      'budget.agrees_with_store',
      `This process is configured for a tab budget of ${String(tabs)} and the store records ${String(recorded.stored)}. ` +
        'Several processes arbitrate against this bound at the same moment, so two of them believing different numbers means each admits correctly against its own belief and the ceiling stops being one. ' +
        'Neither number is adopted and neither is overwritten: set BROKER_TAB_BUDGET to ' +
        `${String(recorded.stored)} in this process's environment, or start against a different store.`,
    );
  }

  return { tabs, recorded: recorded.wrote };
}

/**
 * Read the recorded budget, writing this process's value if there is none.
 *
 * Returns what the store holds **after** this transaction, which is the value
 * the caller above compares against — so a process that arrives second
 * compares against the first's number rather than against its own.
 *
 * The insert tolerates a row appearing between the read and the write. That
 * cannot happen inside an immediate transaction on this store, and the clause
 * is there because the cost of being wrong about that is a spawn that fails
 * with a constraint error naming nothing a person can act on, while the cost
 * of the clause is one keyword. The re-read afterwards is what makes the
 * tolerance safe: whatever ends up in the row is what gets compared.
 */
function readAndRecord(db: Database, tabs: number): { stored: number; wrote: boolean } {
  db.prepare(BEGIN_STATEMENT).run();
  try {
    const before = db.prepare('SELECT tabs FROM tab_budget WHERE only_row = 1').get() as
      { tabs: number } | undefined;

    if (before !== undefined) {
      db.prepare('COMMIT').run();
      return { stored: before.tabs, wrote: false };
    }

    db.prepare('INSERT OR IGNORE INTO tab_budget (only_row, tabs) VALUES (1, ?)').run(tabs);

    const after = db.prepare('SELECT tabs FROM tab_budget WHERE only_row = 1').get() as {
      tabs: number;
    };
    db.prepare('COMMIT').run();
    return { stored: after.tabs, wrote: after.tabs === tabs };
  } catch (error) {
    // ── Why the rollback is guarded and the original error is rethrown ────
    //
    // **Both success paths above have already issued their own `COMMIT`**, so
    // for any failure at or after that point there is no transaction left to
    // roll back and this statement throws `SQLITE_ERROR: cannot rollback - no
    // transaction is active`. An unguarded rollback therefore **replaces the
    // real error with a meaningless one** on its way out of this catch.
    //
    // Measured before this guard existed: calling `prepareStore` with an
    // environment lacking `tabBudget` surfaced only "cannot rollback - no
    // transaction is active", while a statement-level trace showed `ROLLBACK`
    // was the only statement that threw — the actual cause being a
    // `CHECK (tabs > 0)` violation from `schema/step-002-tab-budget.ts`,
    // because `undefined` binds as NULL. `agreeOnTabBudget` runs on **every
    // spawn**, so this masking sat on the startup path of every process.
    //
    // The rollback is still attempted, because the failure that lands here
    // may well be one that left a transaction open, and leaving it open would
    // hold a write lock every other process is waiting behind. What changes
    // is that failing to roll back is no longer allowed to speak over the
    // reason we are here at all. `tests/concurrency/worker-transaction-mode.mjs`
    // already carries this reasoning; this is the one site that lacked it.
    try {
      db.prepare('ROLLBACK').run();
    } catch {
      // A transaction the engine already ended cannot be rolled back, and
      // saying so would replace the useful error with a meaningless one.
    }
    throw error;
  }
}
