import type { Database } from 'better-sqlite3';

/**
 * Admission: one integer against one integer.
 *
 * §2.3 reduces the whole capacity model to one sentence, and everything in
 * this module is a consequence of it:
 *
 * > **Capacity, grants and tabs are the same integer.** The pool bound *is*
 * > the tab budget *is* the count of live claims. **Need two tabs? Claim
 * > twice.**
 *
 * ── The arithmetic a reader expects, and will not find ──────────────────
 *
 * Stated as an absence rather than left to be discovered, because each is a
 * mechanism somebody may arrive looking for (§2.3, `MILESTONES.md` #12):
 *
 * - **No request size.** A claim is one tab. There is no requested-count term
 *   to add to the count, and anyone implementing a `tabs` argument on the
 *   claim call is implementing a design that was deleted rather than
 *   re-tuned.
 * - **No per-lease allowance.** It would be the one number in this design
 *   answering to no prior decision, invented to stop one caller taking
 *   everything, and with a grant of one there is nothing for it to bound.
 * - **No reservation.** Nothing is held for a tab that has not opened,
 *   because the claim row **is** the capacity. There is no window in which
 *   granted and existing could differ and therefore no pair of numbers that
 *   could disagree.
 *
 * **So there is one predicate and it is one comparison.** A function taking a
 * count and a budget would be the natural place for a future size term to
 * arrive; this one takes a database handle and reads the count itself, so the
 * only thing a caller can vary is which store it asks.
 */

/**
 * Count the live claims.
 *
 * **`queued` counts as live and that is not an error.** A queued lease holds
 * no tab, so counting it would refuse capacity to somebody on the strength of
 * a lease holding nothing — but §2.1 calls both states live and the sweep
 * treats them alike, so the distinction has to be made *here*, in the one
 * place it matters, rather than by hoping every caller remembers it.
 * {@link countActiveClaims} is what admission uses; this is what the queue
 * and the ledger use.
 *
 * Both read `state` directly, which is safe **only** because every caller is
 * inside the arbitration transaction after the sweep has run (§2.4). Outside
 * that, `state` alone reports leases that do not exist — the standing rule
 * that stored state is provisional and derived state is the truth.
 */
export function countLiveClaims(db: Database): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM claims WHERE state IN ('queued', 'active')")
    .get() as { n: number };
  return row.n;
}

/**
 * Count the claims that hold a tab, which is what capacity is a count of.
 *
 * Reads the index-only partial index over the live claims (§1.11), which is
 * why the filter is spelled to match it: the answer comes out of the index
 * without touching the table, and this count is read inside the transaction
 * every arbitration call opens, with every other caller on the machine
 * waiting behind it.
 */
export function countActiveClaims(db: Database): number {
  const row = db.prepare("SELECT count(*) AS n FROM claims WHERE state = 'active'").get() as {
    n: number;
  };
  return row.n;
}

/**
 * The admission predicate, entire: `count of live claims + 1 <= budget`.
 *
 * The `+ 1` is the claim being decided, and it is written out rather than
 * folded into a `<` because §2.3 and `MILESTONES.md` #12 both spell it this
 * way — the one place the arithmetic of this design appears, spelled as its
 * specification spells it, so a reader comparing the two is comparing the
 * same sentence.
 *
 * **This reads a count the same transaction has just reconciled** (§7.1,
 * `capacity.admission`), so it can never admit against capacity held by a
 * lease that has already lapsed. That property is the runner's — it sweeps
 * before any handler runs — and not something this function can check.
 */
export function admits(activeClaims: number, budget: number): boolean {
  return activeClaims + 1 <= budget;
}
