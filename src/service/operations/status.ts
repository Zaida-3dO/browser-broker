import type { ArbitrationOutcome, ArbitrationScope } from '../arbitration.ts';
import { extendLease, resolveLease } from '../leases.ts';
import { queueDepth, queuePosition, waitEstimateSeconds } from '../queue.ts';
import { checkBackSeconds } from './claim.ts';

/**
 * `browser_status` (§3.3) — takes the key, returns where the caller stands,
 * and **extends the lease** (§3.1, row #14).
 *
 * ── This operation is why the standing invariant needs defending ────────
 *
 * It is the one that looks read-only, and it is the exact shape §1.0a warns
 * about:
 *
 * > **A read-only fast path — *"checking status does not need to sweep"* —
 * > silently reopens the hole, and it would pass a low-contention test
 * > suite.**
 *
 * It does not have a fast path and cannot be given one through the runner:
 * the sweep runs before this handler is called, unconditionally, and this
 * handler additionally renews — so the transaction is a writer twice over.
 * **Asking where you stand expires every lapsed lease in the store first**,
 * which is why the answer is a fact rather than a stale row.
 *
 * ── And it is what a queued caller polls with ───────────────────────────
 *
 * **Polling *is* renewing** (§2.5). A queued caller holds exactly the
 * instrument an active holder does and uses it exactly as often, which is
 * what makes one duration serve both states — and it is why the queued
 * response tells a caller to check back at just under the lifetime rather
 * than merely telling it how long the place lasts.
 *
 * ── What this operation deliberately does NOT know ──────────────────────
 *
 * **Whether the browser is still there.** Measured 2026-09-04: both browsers
 * were gone, the store went on granting leases against them, and this
 * operation reported every one `active` with the expiry advancing. Reading a
 * row is not the same as looking at the machine, and this operation only ever
 * does the first — everything it returns above is rows plus the expiry
 * derivation, and that derivation is about **time** and nothing else
 * (`operations/derive.ts`).
 *
 * It cannot be fixed by asking here. `arbitration.no_browser_io` (§2.4b)
 * forbids browser work inside the arbitration transaction, because one
 * unresponsive browser inside it blocks every arbitration call on the
 * machine — and a browser that has died is exactly the browser most likely to
 * be slow to answer. So the honest shape is: this operation says `unknown`,
 * and the layer that holds the browser seam settles it **after the commit**
 * and downgrades `active` to `expired` when the browser is gone
 * (`service/broker.ts`).
 *
 * The standing rule that makes that the right split rather than a workaround
 * is §2.4's, one level up from where it is usually applied: **stored state is
 * provisional, derived state is the truth.** A row saying `active` against a
 * dead browser is provisional in precisely the way a lapsed row is.
 */

export interface StatusInput {
  readonly key: string;
}

/**
 * What this operation can say about the browser behind an active lease.
 *
 * ── Why the unknown case is a word and not an absence ───────────────────
 *
 * A build with no way to probe (§2.4b's documented no-browser state, and
 * every test that runs without one) must be distinguishable from a build that
 * probed and found a browser answering. Collapsing the two onto a boolean
 * makes *not asked* and *asked and fine* the same value, which is the exact
 * confusion this whole row exists to remove — one level up.
 */
export type BrowserLiveness = 'live' | 'gone' | 'unknown';

export interface StatusResult {
  readonly claimId: string;
  /**
   * Where the lease stands.
   *
   * **`expired` is reachable without the lease's clock having run out**, and
   * that is the point of it: a lease whose browser is gone is not active,
   * whatever its expiry says. See {@link browser} for what settles it and
   * `service/broker.ts` for where the probe happens.
   */
  readonly state: 'queued' | 'active' | 'expired';
  readonly browserId: string;
  readonly purpose: string;
  /** The expiry **after** this call extended it. */
  readonly expiresAt: string;
  readonly ttlSeconds: number;
  readonly checkBackSeconds: number;
  readonly checkBack: string;
  /** Present only while queued. */
  readonly position?: number;
  readonly queueDepth?: number;
  readonly waitEstimateSeconds?: number;
  /** The tab, present only once the lease is active. */
  readonly tabId?: string;
  /**
   * Whether the browser this lease is held against is actually there.
   *
   * **Never settled inside the transaction.** Answering it means talking to a
   * browser, and `arbitration.no_browser_io` (§2.4b) forbids that here — one
   * unresponsive browser inside the arbitration transaction blocks every
   * arbitration call on the machine. So this operation returns `unknown` and
   * the layer holding the browser seam settles it after the commit.
   */
  readonly browser?: BrowserLiveness;
}

/**
 * **This one takes no settings, and the absence is deliberate.** Every
 * duration it reports comes off the lease's own row (§1.3): a renewal has to
 * extend by the duration the caller was told, so re-reading the environment
 * mid-lease would silently change a promise the caller has already acted on.
 * Taking a settings argument it did not use would invite exactly that.
 */
export function decideStatus(
  scope: ArbitrationScope,
  input: StatusInput,
): ArbitrationOutcome<StatusResult> {
  const { db, adapter, swept } = scope;

  const lease = resolveLease(db, input.key, {
    adapter,
    kind: 'claim_renewed',
    recordRefusal: scope.recordRefusal,
  });
  // Row #14: the extension is the effect of the call, not a verb of its own.
  const expiresAt = extendLease(db, lease, { adapter, now: swept.sweptAt });

  const checkBack = checkBackSeconds(lease.ttlSeconds);
  const advice =
    `Call in with this key at least every ${String(checkBack)} seconds. Any call carrying it extends the lease; there is no separate renew.` +
    (lease.state === 'queued'
      ? ` This place lives ${String(lease.ttlSeconds)} seconds, so check back at ${String(checkBack)} rather than at the deadline — a check made exactly at the deadline races the reclamation and loses about half the time.`
      : '');

  if (lease.state === 'queued') {
    const position = queuePosition(db, lease.claimId);
    const estimate = waitEstimateSeconds(db, position);
    return {
      value: {
        claimId: lease.claimId,
        state: 'queued',
        browserId: lease.browserId,
        purpose: lease.purpose,
        expiresAt,
        ttlSeconds: lease.ttlSeconds,
        checkBackSeconds: checkBack,
        checkBack: advice,
        position,
        queueDepth: queueDepth(db),
        ...(estimate === undefined ? {} : { waitEstimateSeconds: estimate }),
      },
    };
  }

  const tab = db
    .prepare(
      `SELECT id AS tabId FROM tabs
        WHERE claim_id = @claimId AND state IN ('opening', 'open')
        ORDER BY id LIMIT 1`,
    )
    .get({ claimId: lease.claimId }) as { tabId: string } | undefined;

  return {
    value: {
      claimId: lease.claimId,
      state: 'active',
      browserId: lease.browserId,
      purpose: lease.purpose,
      expiresAt,
      ttlSeconds: lease.ttlSeconds,
      checkBackSeconds: checkBack,
      checkBack: advice,
      ...(tab === undefined ? {} : { tabId: tab.tabId }),
      // **`unknown` rather than `live`, and the difference is the whole
      // defect.** Everything above is derived from rows and a clock, which is
      // what a lease is; whether the browser still exists is a fact about the
      // operating system and cannot be read here without breaking
      // `arbitration.no_browser_io`. Claiming `live` from this seat would be
      // asserting the very thing that was measured false — a store believing
      // in a browser that had been dead for minutes.
      browser: 'unknown',
    },
  };
}
