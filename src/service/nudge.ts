import type { Database } from 'better-sqlite3';

import { append, type EventAdapter } from './events.ts';

/**
 * The you-are-your-own-obstacle nudge (§2.3a, `MILESTONES.md` #51).
 *
 * ── What this is instead of, which is the point ─────────────────────────
 *
 * **Nothing is added to admission.** No request size, no all-or-nothing
 * grant, no acquisition protocol the service describes and cannot enforce.
 * §2.3a names the starvation case plainly — a caller that needs three tabs
 * claims three times, is granted two and queues for a third *while holding
 * the first two*, opposite another caller doing the same thing — and then
 * rules that it is **an information problem before it is a scheduling
 * problem**:
 *
 * > Every mechanism considered above builds machinery to prevent a situation
 * > the caller could resolve itself in one step, if it simply knew.
 *
 * So the response carries three things: the leases the session already holds
 * **with their keys**, the advice to start with what it holds, and the offer
 * to release and retry.
 *
 * ── Why the keys are in it, which looks wrong and is not ────────────────
 *
 * A caller that lost track of its own grants can carry on with what it has
 * instead of waiting for something it does not need — and it cannot, because
 * a key is returned once and is never recoverable (§2.2). **The keys named
 * here are the ones the same caller was handed on the same responses**; this
 * is not a lookup of a stored secret, because none is stored (§1.3). The
 * service holds the hashes and cannot produce a key it was not just given, so
 * whoever assembles this response supplies them from the grants it made.
 *
 * ── The ledger row is the part that is not optional ─────────────────────
 *
 * **Each occurrence resolves itself invisibly**, which is exactly why it is
 * logged: without a record there is no way to learn that it has become
 * common, and *common* is the signal that the budget is too tight or that a
 * caller is misbehaving. **The nudge is advice; the ledger row is the
 * evidence.**
 */

/** One lease the asking session already holds. */
export interface HeldLease {
  readonly claimId: string;
  readonly state: 'queued' | 'active';
  readonly purpose: string;
  readonly browserId: string;
  readonly expiresAt: string;
}

/** What a caller is told when it is waiting on capacity it is partly holding. */
export interface OwnObstacleNudge {
  /**
   * The leases this session already holds.
   *
   * **Without their keys**, and the omission is structural rather than a
   * decision taken here: §1.3 stores only a hash, so there is no key to
   * attach. §2.3a asks for the keys and this is the one place this
   * implementation cannot give what it asks for — the surface that made the
   * grants is the only thing that ever had them, and it is where a caller
   * that kept them would look. Said outright rather than implied, per the
   * house rule that a seam is described honestly.
   */
  readonly holding: readonly HeldLease[];
  /** The strongest advice, because it is frequently self-solving. */
  readonly advice: string;
}

/**
 * The leases a session already holds, other than the one being decided.
 *
 * **One comparison over data already in hand** (§2.3a): the admission
 * transaction already counts live claims and already knows the asking
 * session. No new table, no new state, no second query outside the
 * transaction — this is a filter, and it reads the index §1.11 keeps for
 * exactly this query.
 *
 * `state` is read directly, which is correct **only** inside the arbitration
 * transaction after the sweep (§2.4). A lease this reports as held is one the
 * same call has just reconciled.
 */
export function liveLeasesOfSession(
  db: Database,
  sessionId: string,
  excludingClaimId?: string,
): readonly HeldLease[] {
  return db
    .prepare(
      `SELECT id AS claimId, state, purpose, browser_id AS browserId, expires_at AS expiresAt
         FROM claims
         WHERE session_id = @sessionId
           AND state IN ('queued', 'active')
           AND (@excluding IS NULL OR id <> @excluding)
         ORDER BY created_at, id`,
    )
    .all({ sessionId, excluding: excludingClaimId ?? null }) as HeldLease[];
}

/**
 * Build the nudge, and record that it fired.
 *
 * Returns `undefined` when the session holds nothing — which is the ordinary
 * case, and the case where the advice would be actively wrong: telling a
 * caller holding nothing to start with what it holds is telling it to do
 * nothing.
 *
 * **The ledger row is written here rather than by the caller**, so a surface
 * cannot attach the advice and forget the evidence. The row is an `allow`,
 * because the nudge is not itself a refusal — whatever refused or queued the
 * claim wrote its own row, and this one records that the caller was told it
 * was its own obstacle.
 */
export function nudgeIfOwnObstacle(
  db: Database,
  options: {
    readonly sessionId: string;
    readonly claimId: string;
    readonly adapter: EventAdapter;
    readonly outcome: 'queued' | 'refused';
  },
): OwnObstacleNudge | undefined {
  const holding = liveLeasesOfSession(db, options.sessionId, options.claimId);
  if (holding.length === 0) {
    return undefined;
  }

  const active = holding.filter((lease) => lease.state === 'active').length;

  append(db, {
    kind: 'claim_queued',
    outcome: 'allow',
    adapter: options.adapter,
    claimId: options.claimId,
    sessionId: options.sessionId,
    detail: {
      nudge: 'own_obstacle',
      outcome: options.outcome,
      holding: holding.length,
      holdingActive: active,
      heldClaimIds: holding.map((lease) => lease.claimId),
    },
  });

  return {
    holding,
    advice:
      `This session already holds ${String(holding.length)} live lease${holding.length === 1 ? '' : 's'}` +
      `${active > 0 ? ` (${String(active)} holding a tab)` : ''}, so some of the capacity being waited for is capacity being held. ` +
      'Start with what is already held: finishing work on a held tab frees capacity this same session can reuse, which unblocks by working rather than by waiting. ' +
      'If the work genuinely cannot be serialised, release what is held and ask again.',
  };
}
