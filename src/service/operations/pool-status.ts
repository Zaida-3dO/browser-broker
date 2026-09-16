import type { Database } from 'better-sqlite3';

import { deriveClaimState, isLive, type StoredClaimState } from '../../operations/derive.ts';
import { readStoreClock, readTabBudget } from '../../operations/status.ts';

/**
 * `browser_status` with no lease key (§3.3) — where the **pool** stands.
 *
 * ── The condition this exists to be reachable in ────────────────────────
 *
 * `browser_status` is the call a caller reaches for when something has
 * already gone wrong. Requiring the lease key on it gates the diagnosis on
 * the very thing in trouble, which is why the key is optional. Two sessions
 * reported that friction independently, which is the signal: one was refused
 * with `key.present` while trying to work out why the `regular` browser was
 * inert, and one resorted to calling it with a key it knew was invalid just
 * to see whether the channel was alive.
 *
 * ── Why this is a separate read rather than a branch in `decideStatus` ───
 *
 * `decideStatus` is an arbitration handler. Everything it does is correct
 * *for a caller that holds a lease*: it sweeps, it resolves the lease, and it
 * renews it. **None of those is appropriate for a caller that holds
 * nothing.** There is no lease to renew, and sweeping on an unkeyed call
 * would make the cheapest question on the surface do work inside the
 * transaction every other caller on the machine waits behind — which is
 * precisely the shape `arbitration.no_read_only_path` (§7.3) warns a
 * "well-intentioned optimisation" arrives in, arriving from the other
 * direction.
 *
 * So this does not enter the arbitration transaction at all. It is a read of
 * derived state, and it writes nothing.
 *
 * ── Derived, never the stored column ────────────────────────────────────
 *
 * §2.4's standing rule: **stored state is provisional, derived state is the
 * truth.** A `claims` row saying `active` past its expiry is a lease that has
 * lapsed and not yet been swept, and reporting the stored column would tell a
 * caller the pool was full when it was not — the exact defect the reader rule
 * (§5.2) exists to prevent. So every count here is derived against one
 * instant read from the database's own clock, the same way §4.2's document
 * derives its own.
 *
 * ── What this may say, which is counts and never identities ─────────────
 *
 * The objection to answering an unkeyed caller at all is that it starts to
 * look like a read of other callers' state — the reasoning that governs
 * `compare_to` and that keeps `reconcile` off the agent surface. **That
 * objection is right about identities and does not reach counts.**
 *
 * So {@link PoolStatusResult} carries no session identifier, no purpose, no
 * claim or tab identifier, no address and no feedback. It says how many tabs
 * are in use and whether each browser is up. A caller learns the pool is
 * full; it does not learn whose work filled it, what that work is for, or
 * anything it could use to address another caller's tab.
 *
 * **This is deliberately not `readOperationsStatus`** (`operations/status.ts`)
 * even though that function already assembles a richer picture and reusing it
 * would have been less code. That picture is the *operator's* (§4.2) and
 * carries exactly what this must not: `sessionId` on every lease, `purpose`
 * on every lease and queue entry, and the text of callers' feedback. It stays
 * on the operator surface.
 */

/** One browser, as an unkeyed caller may see it. */
export interface PoolBrowserView {
  readonly id: string;
  /**
   * What the store says about this browser.
   *
   * **A claim rather than a proof** (§1.2c), and labelled as one: the record
   * survives the browser dying — verified, with the record still readable and
   * still naming a port that answered nothing. Confirming it means reaching
   * the endpoint, which is `browser_doctor`'s job because it can actually ask.
   * This field says what was recorded, and `browser_doctor` says whether it
   * checks out. A caller that needs certainty is told, in the tool
   * description, which of the two to call.
   */
  readonly state: string;
  /** Whether a discovery record is present at all. Present is not checked. */
  readonly discoveryRecorded: boolean;
  /** Live tabs this browser is holding. A count, never whose. */
  readonly liveTabs: number;
}

/**
 * The pool, in counts.
 *
 * Every field here is a fact about the shared resource rather than about any
 * caller, which is the property that makes it answerable without a key.
 */
export interface PoolStatusResult {
  /** The instant every count was derived against, from the store's own clock. */
  readonly at: string;
  readonly browsers: readonly PoolBrowserView[];
  /**
   * The tab budget, or null when no process has recorded one.
   *
   * Null is a real state rather than an error: the row is written by the
   * first process to open the store (§1.10), so a store created but never
   * arbitrated against has none. Reporting null says that; reporting a
   * default would report a number nobody chose.
   */
  readonly tabBudget: number | null;
  /** Live leases holding a tab. A lease is a tab (§2.3), so this is both. */
  readonly tabsInUse: number;
  /** Callers waiting for capacity. */
  readonly queueDepth: number;
  /**
   * What an unkeyed caller should do with this, in a sentence.
   *
   * Carried on the response for the same reason the refusals name their
   * remedy: this answer is most often read by a caller that is already stuck,
   * and a set of numbers does not tell it what to do next.
   */
  readonly advice: string;
}

/**
 * Read the pool.
 *
 * Takes the handle and nothing else. **No transaction is opened**, which is
 * the point: this is outside arbitration, so it cannot renew, cannot sweep
 * and cannot block anybody.
 */
export function readPoolStatus(db: Database): PoolStatusResult {
  // One instant for the whole read, not one per count. Two counts derived
  // against two clocks can disagree about whether a lease is live, and an
  // answer that contradicts itself is worse than one that is slightly old.
  const at = readStoreClock(db);

  const browserRows = db.prepare(`SELECT id, state, endpoint FROM browsers ORDER BY id`).all() as {
    id: string;
    state: string;
    endpoint: string | null;
  }[];

  // Every claim whose *stored* state is live, which is the complete candidate
  // set: a claim whose stored state is final cannot become live again, so the
  // derivation can only move a row out of this set and never into it.
  const claimRows = db
    .prepare(
      `SELECT c.id, c.browser_id, c.state, c.expires_at, c.created_at, c.activated_at,
              (SELECT t.id FROM tabs t
                WHERE t.claim_id = c.id AND t.state IN ('opening', 'open', 'closing')
                ORDER BY t.created_at LIMIT 1) AS tab_id
         FROM claims c
        WHERE c.state IN ('queued', 'active')
        ORDER BY c.created_at, c.id`,
    )
    .all() as {
    id: string;
    browser_id: string;
    // The stored column, and it is typed as the stored union so that
    // `isLive` and `deriveClaimState` — which take the timing, not a string —
    // are reached with the shape they declare rather than through a cast at
    // the call site. The `WHERE` above already restricts it to two of them.
    state: StoredClaimState;
    expires_at: string;
    created_at: string;
    activated_at: string | null;
    tab_id: string | null;
  }[];

  const live = claimRows.filter((claim) => isLive(claim, at));
  const active = live.filter((claim) => deriveClaimState(claim, at) === 'active');
  const queued = live.filter((claim) => deriveClaimState(claim, at) === 'queued');

  const liveTabsByBrowser = new Map<string, number>();
  for (const claim of active) {
    if (claim.tab_id !== null) {
      liveTabsByBrowser.set(claim.browser_id, (liveTabsByBrowser.get(claim.browser_id) ?? 0) + 1);
    }
  }

  const tabBudget = readTabBudget(db);
  const tabsInUse = active.length;
  const queueDepth = queued.length;

  return {
    at,
    browsers: browserRows.map((row) => ({
      id: row.id,
      state: row.state,
      discoveryRecorded: row.endpoint !== null,
      liveTabs: liveTabsByBrowser.get(row.id) ?? 0,
    })),
    tabBudget,
    tabsInUse,
    queueDepth,
    advice: poolAdvice(tabBudget, tabsInUse, queueDepth),
  };
}

/**
 * The sentence on the response.
 *
 * Three cases, because they need different things done about them, and a
 * caller cannot always tell them apart from the numbers alone:
 *
 * - **Full.** Waiting is the answer; a claim will be queued rather than
 *   refused, and queued is an outcome rather than a failure (§3.2).
 * - **Room, which is the interesting one.** A caller reading this is usually
 *   here because something is not working, and free capacity means the fault
 *   is not capacity — so the next question is which precondition is broken,
 *   and that is `browser_doctor`. Saying so is what turns this from a number
 *   into a next step.
 * - **No budget recorded**, meaning nothing has opened this store yet.
 */
function poolAdvice(tabBudget: number | null, tabsInUse: number, queueDepth: number): string {
  if (tabBudget === null) {
    return 'No tab budget has been recorded yet, which means no process has opened this store. A claim is what starts a browser.';
  }
  if (tabsInUse >= tabBudget) {
    return `Every tab is in use (${String(tabsInUse)} of ${String(tabBudget)})${queueDepth > 0 ? `, with ${String(queueDepth)} waiting` : ''}. A claim now will be queued rather than refused, and a queued place is polled with this same call.`;
  }
  return `There is room: ${String(tabsInUse)} of ${String(tabBudget)} tabs are in use. If a claim is failing or a tab is not working, capacity is not the reason — call browser_doctor, which checks each precondition and names the remedy.`;
}
