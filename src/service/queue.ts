import type { Database } from 'better-sqlite3';

import { admits, countActiveClaims } from './capacity.ts';
import { append, type EventAdapter } from './events.ts';

/**
 * The queue: strictly first in, first out (§1.5, §2.5).
 *
 * **There is no queue table.** The queue is simply the leases whose state is
 * `queued`, in the order they arrived. §1.5 argues the alternative looks
 * tidier and is worse: a queue table means a waiting lease exists twice, once
 * as a lease and once as an entry, and the moment the two disagree the
 * service has two answers to *"where am I"*. Admission is one field changing
 * on the row that was already there, which cannot half-happen.
 *
 * ── Why this is close to trivially correct, which is a consequence ──────
 *
 * Every request is one tab (§2.3), so a freed tab always fits the front of
 * the queue. That is not a rule anybody enforces here; it falls out of there
 * being no such thing as a larger or smaller request. What follows:
 *
 * - **Nothing to skip ahead of**, so there is no scheduling decision.
 * - **No aging rule**, because a caller cannot be overtaken forever by
 *   smaller requests when no such request exists.
 * - **A position only ever improves**, by exactly one each time a tab frees.
 *
 * **What is real is the dead entry at the head**, and it is the one failure
 * invisible in a capacity count — the count is correct the whole time while
 * an entry that will never take its tab blocks everyone behind it. Queue
 * entries therefore expire by the same sweep as leases (§2.4), and that
 * expiry is not housekeeping: **it is the only thing that makes strictness
 * safe.**
 */

/**
 * Where a lease sits in the queue, counting from one.
 *
 * **Computed rather than stored** (§1.3): storing it means rewriting every
 * waiting row each time one is admitted, and a stored position is a second
 * fact that can disagree with the order.
 *
 * **Ordered by `arrival`, a counter the database allocates at insert**, and
 * that column exists because the ordering §1.5 describes does not keep the
 * promise §2.5 makes. Ordering by `created_at` tie-broken by `id` is stable —
 * which is what §1.5 argues for — but the tie-break is a random identifier,
 * so among callers arriving inside one millisecond the order bears no
 * relation to arrival. **Measured: a caller told position 1 is told position
 * 2 on its next call**, because a caller that really did arrive earlier was
 * placed ahead of it afterwards. §2.5 promises a position that only ever
 * improves, and a counter has no ties to get that wrong with.
 *
 * It is not `activated_at`, which is null for everyone waiting and is set at
 * the moment you stop waiting — the answer rather than the question.
 */
export function queuePosition(db: Database, claimId: string): number {
  const row = db
    .prepare(
      `SELECT count(*) + 1 AS position
         FROM claims AS ahead
         WHERE ahead.state = 'queued'
           AND ahead.arrival <
               (SELECT self.arrival FROM claims AS self WHERE self.id = @claimId)`,
    )
    .get({ claimId }) as { position: number };
  return row.position;
}

/** How many leases are waiting, in total. */
export function queueDepth(db: Database): number {
  const row = db.prepare("SELECT count(*) AS n FROM claims WHERE state = 'queued'").get() as {
    n: number;
  };
  return row.n;
}

/**
 * How long recent leases were actually held, in seconds.
 *
 * **Deliberately not computed from the expiry** (§1.5): a lease that keeps
 * being renewed runs far past its expiry, so an estimate built on that would
 * be confidently wrong in the common case rather than vaguely wrong in all of
 * them. It is `ended_at` minus `activated_at` over leases that actually ended,
 * which is the only place that number can come from once the ledger has been
 * trimmed.
 *
 * Returns `undefined` when nothing has ended yet, because a fresh
 * installation has no history to average and inventing one would produce a
 * confident number from no evidence.
 */
export function recentHoldSeconds(db: Database, sample = 20): number | undefined {
  const rows = db
    .prepare(
      `SELECT (julianday(ended_at) - julianday(activated_at)) * 86400.0 AS held
         FROM claims
         WHERE activated_at IS NOT NULL AND ended_at IS NOT NULL
         ORDER BY ended_at DESC
         LIMIT @sample`,
    )
    .all({ sample }) as { held: number | null }[];

  const held = rows.map((row) => row.held).filter((value): value is number => value !== null);
  if (held.length === 0) {
    return undefined;
  }
  return held.reduce((total, value) => total + value, 0) / held.length;
}

/**
 * The wait estimate: how many are ahead, multiplied by how long leases are
 * held.
 *
 * **A weak number, and it is labelled as one everywhere it appears** (§1.5).
 * It is, however, a better number than it would be under variable request
 * sizes: with every request the same size, "how many are ahead of me"
 * translates directly into how many tabs have to come free, which is one
 * fewer piece of guesswork in the same calculation.
 *
 * `undefined` when there is no history to base it on, so a caller can say
 * *"no estimate yet"* rather than print a zero that reads as *"any moment
 * now"*.
 */
export function waitEstimateSeconds(db: Database, position: number): number | undefined {
  const held = recentHoldSeconds(db);
  if (held === undefined) {
    return undefined;
  }
  // Position counts from one and the caller ahead of nobody still waits for
  // one lease to end, so the multiplier is the position itself.
  return Math.round(position * held);
}

/** The lease at the front of the queue, or nothing if none is waiting. */
export function headOfQueue(db: Database): { id: string; browserId: string } | undefined {
  return db
    .prepare(
      `SELECT id, browser_id AS browserId
         FROM claims
         WHERE state = 'queued'
         ORDER BY arrival
         LIMIT 1`,
    )
    .get() as { id: string; browserId: string } | undefined;
}

/** A lease that was promoted, and the tab that has to be opened for it. */
export interface Promotion {
  readonly claimId: string;
  readonly browserId: string;
  readonly sessionId: string;
}

/**
 * Promote the front of the queue for as long as capacity exists.
 *
 * **This is the whole scheduling rule** (§2.5): the sweep promotes the front
 * while capacity exists and stops when it does not. There is no arithmetic in
 * the step — no size to check a freed tab against — because every waiting
 * request is the same size as every freed tab.
 *
 * ── What a promotion does and does not do here ──────────────────────────
 *
 * It flips the lease to `active`, stamps `activated_at`, and puts the lease
 * on a **fresh** lifetime: the promoted caller has just been given a tab and
 * its clock starts now rather than continuing from a queue place it has
 * already spent. `ttl_seconds` moves to the active duration with it, because
 * §1.3 requires a renewal to extend by the duration the caller was told and
 * the caller is being told this one on this response.
 *
 * **It does not open the tab.** Opening is browser work and browser work
 * never happens inside the arbitration transaction (§2.4b) — one wedged
 * browser inside it blocks every arbitration call on the machine. The tab row
 * is created `opening`, and the driver call belongs to the caller's
 * after-commit work.
 *
 * The loop is bounded by capacity and by the queue's own length, both of
 * which shrink on each pass, so it terminates on the smaller of the two.
 */
export function promoteWhileCapacity(
  db: Database,
  options: {
    readonly budget: number;
    readonly leaseSeconds: number;
    readonly adapter: EventAdapter;
    readonly now: string;
  },
): readonly Promotion[] {
  const promoted: Promotion[] = [];

  for (;;) {
    if (!admits(countActiveClaims(db), options.budget)) {
      break;
    }
    const head = headOfQueue(db);
    if (head === undefined) {
      break;
    }

    const row = db
      .prepare(
        `UPDATE claims
            SET state = 'active',
                activated_at = @now,
                expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', @now, @extend),
                ttl_seconds = @ttl,
                updated_at = @now
          WHERE id = @id AND state = 'queued'
      RETURNING session_id AS sessionId, browser_id AS browserId`,
      )
      .get({
        id: head.id,
        now: options.now,
        // The modifier is assembled from a number this process computed, not
        // from anything a caller supplied.
        extend: `+${String(options.leaseSeconds)} seconds`,
        ttl: options.leaseSeconds,
      }) as { sessionId: string; browserId: string } | undefined;

    if (row === undefined) {
      // The lease stopped being queued between the read and the write. Inside
      // one immediate transaction nothing else can have done that, so this is
      // a bug rather than a race — but breaking is the safe response either
      // way, and looping again on an unchanged head would not terminate.
      break;
    }

    append(db, {
      kind: 'claim_promoted',
      outcome: 'allow',
      adapter: options.adapter,
      claimId: head.id,
      sessionId: row.sessionId,
      browserId: row.browserId,
      detail: { promotedAt: options.now },
    });

    promoted.push({ claimId: head.id, browserId: row.browserId, sessionId: row.sessionId });
  }

  return promoted;
}
