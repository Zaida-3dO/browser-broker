import type { Database } from 'better-sqlite3';

import { append, type AppendEvent, type EventAdapter } from './events.ts';
import { hashKey } from './keys.ts';
import { CallRefusal } from './refusals.ts';

/**
 * Resolving a key to a lease, and the effect every keyed call has.
 *
 * ── There is no renew operation, and that is row #14 in one sentence ────
 *
 * §3.1 and `MILESTONES.md` #14: **every keyed call extends the lease**,
 * because a dedicated verb would be a second name for an effect every call
 * already has. The consequence worth following through is §2.5's — **polling
 * *is* renewing**, so a queued caller holds exactly the instrument an active
 * holder does and uses it exactly as often, which is what makes one duration
 * serve both states.
 *
 * **So the extension lives here, in the resolution**, rather than in each
 * operation. An operation that had to remember to renew is an operation that
 * can forget, and the one that forgets would silently expire its callers
 * while they were talking to it.
 */

/** A live lease, as every keyed operation sees it. */
export interface ResolvedLease {
  readonly claimId: string;
  readonly sessionId: string;
  readonly browserId: string;
  readonly state: 'queued' | 'active';
  readonly purpose: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
  readonly renewCount: number;
}

/**
 * The row as it comes back, before the state has been narrowed.
 *
 * `state` is the store's own five-value enum read as text: a lease that has
 * ended is a perfectly ordinary row, and the refusal below is what turns one
 * into a refusal that names the state and when.
 */
interface LeaseRow {
  readonly claimId: string;
  readonly sessionId: string;
  readonly browserId: string;
  readonly state: string;
  readonly purpose: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
  readonly renewCount: number;
  readonly endedAt: string | null;
  readonly revokeReason: string | null;
}

/**
 * Find the lease a key names, refusing when it does not name a live one.
 *
 * **Two refusals, deliberately separate** (§7.1). A key this store has never
 * seen is `key.valid`; a key naming a lease that ended is `claim.live`, and
 * that one **names the state and when** (§2.2) — a caller told only "no"
 * cannot tell a revoke it should escalate from an expiry it should simply
 * retry with a fresh lease.
 *
 * **It must be called inside the arbitration transaction, after the sweep.**
 * Reading `state` directly is correct only there: outside it, a row saying
 * `active` whose expiry has elapsed is not an active lease, it is one that
 * lapsed and has not been swept yet (§2.4). The sweep has already run by the
 * time any handler executes, so a lease this returns as live is one this call
 * reconciled.
 */
export function resolveLease(
  db: Database,
  key: string,
  options: {
    readonly adapter: EventAdapter;
    readonly kind: 'claim_renewed';
    /**
     * Where a denial goes.
     *
     * **Not `append`**, because a refusal throws and a throw rolls the
     * transaction back — taking an ordinary append with it and leaving the
     * ledger with grants only (§1.6). The runner hands this in and writes
     * what it collects after the rollback.
     */
    readonly recordRefusal: (event: AppendEvent) => void;
  },
): ResolvedLease {
  const row = db
    .prepare(
      `SELECT id AS claimId, session_id AS sessionId, browser_id AS browserId, state,
              purpose, expires_at AS expiresAt, ttl_seconds AS ttlSeconds,
              renew_count AS renewCount, ended_at AS endedAt, revoke_reason AS revokeReason
         FROM claims
         WHERE key_hash = @keyHash`,
    )
    .get({ keyHash: hashKey(key) }) as LeaseRow | undefined;

  if (row === undefined) {
    options.recordRefusal({
      kind: options.kind,
      outcome: 'deny',
      guard: 'key.valid',
      adapter: options.adapter,
    });
    throw new CallRefusal(
      'unrecognised_key',
      'That key does not match any lease in this store. A key is returned once and is never recoverable, so a lost key cannot be looked up — wait for the lease to lapse, or ask an operator to revoke it.',
    );
  }

  if (row.state !== 'queued' && row.state !== 'active') {
    // Everything that is not live is final (§2.1), so this branch covers the
    // three ended states and nothing else.
    options.recordRefusal({
      kind: options.kind,
      outcome: 'deny',
      guard: 'claim.live',
      adapter: options.adapter,
      claimId: row.claimId,
      sessionId: row.sessionId,
      browserId: row.browserId,
      detail: { state: row.state, endedAt: row.endedAt },
    });
    throw new CallRefusal('lease_ended', endedSentence(row), {
      detail: {
        claimId: row.claimId,
        state: row.state,
        endedAt: row.endedAt,
        ...(row.revokeReason === null ? {} : { revokeReason: row.revokeReason }),
      },
    });
  }

  // The two refusals above have eliminated every other value, so this is the
  // narrowing the checks already performed, restated for the type system.
  return { ...row, state: row.state === 'queued' ? 'queued' : 'active' };
}

/**
 * The sentence a caller gets for a lease that has ended.
 *
 * **It names the state and when** (§2.2, §7.1 `claim.live`), because the
 * three ended states call for three different responses: an expiry is retried
 * with a fresh request, a release was the caller's own doing and usually
 * means two code paths tidying up, and a revoke is an operator taking
 * capacity back with a reason the caller is owed. A refusal that said only
 * "that lease is not usable" would send all three to the same wrong place.
 */
function endedSentence(row: LeaseRow): string {
  const when = row.endedAt === null ? 'at an unrecorded moment' : `at ${row.endedAt}`;
  if (row.state === 'revoked') {
    return `That lease was revoked ${when}: ${row.revokeReason ?? 'no reason was recorded'}. An operator took the capacity back; a fresh request is the way on.`;
  }
  if (row.state === 'expired') {
    return `That lease expired ${when} — nobody called in before it lapsed, so its tab is gone. Ask for a fresh lease; there is no way to revive this one.`;
  }
  return `That lease was released ${when}, so its tab is closed. Releasing is final; ask for a fresh lease to work again.`;
}

/**
 * Extend a lease by the duration in force for it.
 *
 * **This is row #14, and it is a function every keyed operation calls rather
 * than an operation of its own.** `MILESTONES.md` #14: a dedicated verb would
 * be a second name for an effect every call already has.
 *
 * ── The duration comes off the row, not out of the environment ──────────
 *
 * §1.3 is explicit, and the reasoning is the part worth keeping: `ttl_seconds`
 * is "the duration in force for this lease, fixed when it entered its current
 * state. Stored rather than read from settings on each renewal, **because a
 * renewal has to extend by the duration the caller was told** — re-reading a
 * setting mid-lease silently changes a promise the caller has already acted
 * on."
 *
 * So a caller told ten minutes keeps getting ten minutes even after the
 * environment moves, and the new number reaches it on its next lease.
 *
 * **The extension runs from the moment of the call.** A lease renewed with
 * two minutes left gets a full duration from now rather than a duration
 * stacked on the remainder — the promise is *keep calling in or lose
 * it*, not *call in to accumulate*, and stacking would let a caller poll its
 * way to an unbounded hold.
 */
export function extendLease(
  db: Database,
  lease: ResolvedLease,
  options: { readonly adapter: EventAdapter; readonly now: string },
): string {
  const row = db
    .prepare(
      `UPDATE claims
          SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', @now, @extend),
              renew_count = renew_count + 1,
              updated_at = @now
        WHERE id = @id AND state IN ('queued', 'active')
    RETURNING expires_at AS expiresAt, renew_count AS renewCount`,
    )
    .get({
      id: lease.claimId,
      now: options.now,
      // Assembled from the row's own duration, which is a number this store
      // wrote. Nothing a caller supplied reaches this modifier.
      extend: `+${String(lease.ttlSeconds)} seconds`,
    }) as { expiresAt: string; renewCount: number } | undefined;

  if (row === undefined) {
    // The lease was live when it was resolved, moments ago, in this same
    // transaction. Nothing else can have ended it, so this is a bug rather
    // than a race — and returning an unchanged expiry would quietly report a
    // renewal that did not happen.
    throw new Error(
      `The lease ${lease.claimId} was live when it was resolved and is not live now, inside one transaction.`,
    );
  }

  append(db, {
    kind: 'claim_renewed',
    outcome: 'allow',
    adapter: options.adapter,
    claimId: lease.claimId,
    sessionId: lease.sessionId,
    browserId: lease.browserId,
    detail: {
      expiresAt: row.expiresAt,
      ttlSeconds: lease.ttlSeconds,
      renewCount: row.renewCount,
      // What distinguishes a caller doing work from one polling to hold
      // capacity it is not using (§1.3). Nothing acts on it in this version.
      state: lease.state,
    },
  });

  return row.expiresAt;
}
