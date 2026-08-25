import {
  updateSweptTabs,
  type ArbitrationOutcome,
  type ArbitrationScope,
  type OrphanedTab,
} from '../arbitration.ts';
import { append } from '../events.ts';
import { hashKey } from '../keys.ts';
import { promoteWhileCapacity } from '../queue.ts';
import { CallRefusal } from '../refusals.ts';
import type { ArbitrationSettings } from './claim.ts';

/**
 * `browser_release` (§3.4) — **whatever you are holding, releasing gives it
 * back.**
 *
 * One verb, both live states, and the generalisation is what makes the verb
 * memorable (§2.5). Rows #15 and #72 are two rows only because the queue has
 * to exist before its half can be written; the branch below is one function
 * because the caller's intent is identical in both cases: *I am done, take it
 * back.*
 *
 * | The lease is | What is given back |
 * |---|---|
 * | `active` | Its tab is closed — one tab, one close — and the capacity is freed |
 * | `queued` | Its place, so everyone behind it moves up immediately |
 *
 * ── Why the queued half is not optional ─────────────────────────────────
 *
 * §2.5: a queued caller that changes its mind otherwise has **no way out**.
 * It occupies its place until it lapses, blocking everyone behind it for no
 * reason at all — the same failure as a dead entry at the head, with the
 * aggravating detail that this one is alive and would happily have stood
 * aside if asked.
 *
 * ── Forgiving, and only this operation is ───────────────────────────────
 *
 * **Releasing a lease that already ended succeeds and says so** (§2.2, §3.4).
 * The only refusal is an unrecognised key. The asymmetry with every other
 * keyed call is about what the caller is about to do: a caller tidying up in
 * a cleanup path and again on shutdown must not see an error for tidying
 * twice, and there is nothing to corrupt. A caller about to do *work* it
 * cannot do should be told now.
 *
 * **So this operation does not go through `resolveLease`**, which refuses a
 * lease that ended. That is the one place the shared resolution would be
 * wrong, and it is why the lookup is written out here.
 */

/** What a caller supplies to release. */
export interface ReleaseInput {
  readonly key: string;
}

/** What a release reports. */
export interface ReleaseResult {
  /** What the lease was holding when it was asked to give it back. */
  readonly released: 'tab' | 'queue-place' | 'nothing';
  readonly claimId: string;
  /**
   * True when the lease had already ended before this call.
   *
   * **Not an error, and the field is how a caller can tell without one.** A
   * caller tidying up twice gets `true` and carries on.
   */
  readonly alreadyEnded: boolean;
  /** The state the lease is in now. */
  readonly state: string;
  /**
   * Whether the work is finished at the moment this returned.
   *
   * **The queued half is complete at commit and the active half is not**
   * (§3.4, §2.4b), and this reports the difference rather than leaving a
   * caller to infer it. On an active lease the capacity has definitely come
   * back and the page has *probably* closed; on a queued one there was
   * nothing to close, so there is no caveat to make.
   */
  readonly completeAtCommit: boolean;
  /** How many waiting leases this release promoted. */
  readonly promoted: number;
}

/**
 * Release whatever the lease holds.
 *
 * The tab to close is **collected, not closed**. §2.4b is the hard rule and
 * the reason is worth restating at the site rather than only in the header:
 * closing a tab is a round trip to a browser process that can hang, and a
 * wedged browser does not refuse — it accepts the request and never answers.
 * Inside the transaction that blocks every arbitration call on the machine,
 * including every caller with no interest in that browser, because they are
 * all serialised behind the same writer.
 */
export function decideRelease(
  scope: ArbitrationScope,
  input: ReleaseInput,
  settings: ArbitrationSettings,
): ArbitrationOutcome<ReleaseResult> {
  const { db, adapter, swept } = scope;
  const now = swept.sweptAt;

  const row = db
    .prepare(
      `SELECT id AS claimId, session_id AS sessionId, browser_id AS browserId,
              state, ended_at AS endedAt
         FROM claims
         WHERE key_hash = @keyHash`,
    )
    .get({ keyHash: hashKey(input.key) }) as
    | {
        claimId: string;
        sessionId: string;
        browserId: string;
        state: string;
        endedAt: string | null;
      }
    | undefined;

  if (row === undefined) {
    // The only refusal (§3.4). A key this store has never seen names nothing
    // to give back, and forgiving that would mean reporting success for a
    // lease that never existed.
    scope.recordRefusal({
      kind: 'claim_released',
      outcome: 'deny',
      guard: 'key.valid',
      adapter,
    });
    throw new CallRefusal(
      'unrecognised_key',
      'That key does not match any lease in this store, so there is nothing to give back.',
    );
  }

  if (row.state !== 'queued' && row.state !== 'active') {
    // Forgiving: succeeds, and says the lease had already ended.
    append(db, {
      kind: 'claim_released',
      outcome: 'allow',
      adapter,
      claimId: row.claimId,
      sessionId: row.sessionId,
      browserId: row.browserId,
      detail: { alreadyEnded: true, state: row.state, endedAt: row.endedAt },
    });
    return {
      value: {
        released: 'nothing',
        claimId: row.claimId,
        alreadyEnded: true,
        state: row.state,
        // Nothing was held, so nothing is outstanding.
        completeAtCommit: true,
        promoted: 0,
      },
    };
  }

  const wasQueued = row.state === 'queued';

  db.prepare(
    `UPDATE claims
        SET state = 'released', ended_at = @now, updated_at = @now
      WHERE id = @id`,
  ).run({ id: row.claimId, now });

  // On a queued lease this finds nothing, which is the whole difference
  // between the two halves: there was never a tab to collect.
  const tabs = db
    .prepare(
      `SELECT id AS tabId, claim_id AS claimId, browser_id AS browserId
         FROM tabs
         WHERE claim_id = @claimId AND state IN ('opening', 'open')
         ORDER BY id`,
    )
    .all({ claimId: row.claimId }) as OrphanedTab[];

  // The same rule the sweep uses, from the same function, because two writers
  // spelling it separately is how they come to disagree — and they did: both
  // moved every tab to `closing`, which the schema refuses for a tab that
  // never opened, and every tab this build creates is one of those.
  //
  // What comes back is the subset a browser still owes an answer about.
  const pendingCloses = updateSweptTabs(db, tabs, now);

  append(db, {
    kind: 'claim_released',
    outcome: 'allow',
    adapter,
    claimId: row.claimId,
    sessionId: row.sessionId,
    browserId: row.browserId,
    detail: {
      released: wasQueued ? 'queue-place' : 'tab',
      tabs: tabs.length,
      releasedAt: now,
    },
  });

  for (const tab of pendingCloses) {
    // Collected inside, closed outside (§2.4b). This schedules; it cannot
    // call a browser, because the scope carries no driver to call one with.
    scope.closeAfterCommit(tab);
    append(db, {
      kind: 'tab_closing',
      outcome: 'allow',
      adapter,
      claimId: row.claimId,
      tabId: tab.tabId,
      sessionId: row.sessionId,
      browserId: tab.browserId,
    });
  }

  // **Everyone behind moves up immediately** (§2.5, #72). Releasing a queue
  // place frees no capacity, so this promotes nobody in that case — the
  // people behind move up because the position is a count of the queued
  // leases ahead, and one of them just stopped being queued.
  const promoted = promoteWhileCapacity(db, {
    budget: settings.tabBudget,
    leaseSeconds: settings.leaseSeconds,
    adapter,
    now,
  });

  return {
    value: {
      released: wasQueued ? 'queue-place' : 'tab',
      claimId: row.claimId,
      alreadyEnded: false,
      state: 'released',
      // A queued release is complete at commit, because there is no browser
      // round trip in it — the one case where the best-effort caveat in
      // §2.4b's step three does not apply and the response can say so
      // without qualification.
      completeAtCommit: wasQueued,
      promoted: promoted.length,
    },
  };
}
