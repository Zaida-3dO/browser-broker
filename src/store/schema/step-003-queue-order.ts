import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step three: the queue's order becomes a counter rather than a clock.
 *
 * **A new step rather than an edit to step one**, per the rule that a step
 * which has run somewhere is history (`CLAUDE.md`, `SCHEMA.md` §1.2d).
 *
 * ── The defect this fixes, because it is not obvious from the outside ────
 *
 * §1.5 orders the queue by `created_at`, tie-broken by `id`, and says exactly
 * what the tie-break buys: "two requests in the same millisecond share a
 * `created_at`, and without a tie-break the front of the queue flips between
 * reads". That reasoning is sound and the tie-break does deliver a **stable**
 * order.
 *
 * What it does not deliver is the other promise §2.5 makes:
 *
 * > **A caller's position only ever improves**, and it improves by exactly
 * > one each time a tab comes free.
 *
 * **Measured, and it is reproducible in a few hundred rounds:** three callers
 * arriving inside one millisecond share a `created_at`, so the order between
 * them is decided by `id` — which is a random identifier, unrelated to
 * arrival. A caller whose identifier sorts low is told *position 1* while
 * a caller that genuinely arrived earlier is later told *position 1* as well,
 * and the first caller's next answer is *position 2*. **Its position got
 * worse**, which is the one thing §2.5 promises cannot happen, and it costs
 * exactly the trust the queued response is trying to build when it asks a
 * caller to schedule a check and wait.
 *
 * ── Why a counter and not a finer clock ─────────────────────────────────
 *
 * A higher-resolution timestamp makes ties rarer without making them
 * impossible, which turns a reproducible defect into a rare one — the worst
 * of the available outcomes, because the promise stays false and the evidence
 * goes away. A counter allocated by the database at insert has no ties by
 * construction, in the same way and for the same reason the ledger's cursor
 * has none (§1.6).
 *
 * **`created_at` keeps its own job.** It is when the lease was asked for,
 * which is a fact about the lease that a person reads; it simply stops being
 * the thing that decides who is next.
 */
const ARRIVAL = `
ALTER TABLE claims ADD COLUMN arrival INTEGER
`;

/**
 * Existing rows get an arrival consistent with the order they would have been
 * served in under the previous rule.
 *
 * A store stepped from version two has live queue entries whose relative
 * order callers have already been told. Backfilling in `created_at`, `id`
 * order preserves every answer already given; assigning arbitrarily would
 * reorder a queue that people are waiting in.
 */
const BACKFILL = `
UPDATE claims
   SET arrival = (
     SELECT count(*)
       FROM claims AS earlier
      WHERE (earlier.created_at, earlier.id) <= (claims.created_at, claims.id)
   )
`;

/**
 * The counter itself: one row, holding the highest arrival handed out.
 *
 * A table rather than `AUTOINCREMENT` on the column, because `arrival` is
 * being added to a table that already has a primary key — a second
 * autoincrementing column is not something the engine offers — and because
 * the allocation has to happen inside the arbitration transaction, where it
 * is serialised with everything else by construction (§1.0a).
 */
const SEQUENCE = `
CREATE TABLE claim_arrival (
  only_row INTEGER PRIMARY KEY
           CHECK (only_row = 1),
  next     INTEGER NOT NULL
           CHECK (next >= 0)
) STRICT
`;

/** Start above whatever the backfill used, so no arrival is ever reused. */
const SEED_SEQUENCE = `
INSERT INTO claim_arrival (only_row, next)
VALUES (1, (SELECT coalesce(max(arrival), 0) FROM claims))
`;

/**
 * The order the queue is read in, now with no ties to break.
 *
 * It supersedes nothing at read time — `claims_state_created` still serves
 * the historical queries that order by when a lease was asked for.
 */
const INDEX = `
CREATE INDEX claims_state_arrival ON claims (state, arrival)
`;

/** Every statement this step runs, in order. */
export const STEP_THREE_SQL: readonly string[] = [
  ARRIVAL,
  BACKFILL,
  SEQUENCE,
  SEED_SEQUENCE,
  INDEX,
];

export const stepThree: Step = {
  version: 3,
  summary: 'The queue orders by an arrival counter, so a position can never get worse.',
  apply: (db: Database) => {
    for (const statement of STEP_THREE_SQL) {
      db.exec(statement);
    }
  },
};
