import { randomUUID } from 'node:crypto';

import { BROWSER_IDS, type BrowserId } from '../../browser/driver.ts';
import { admits, countActiveClaims } from '../capacity.ts';
import { append } from '../events.ts';
import { hashKey, mintKey } from '../keys.ts';
import { nudgeIfOwnObstacle, type OwnObstacleNudge } from '../nudge.ts';
import { queuePosition, waitEstimateSeconds } from '../queue.ts';
import { CallRefusal } from '../refusals.ts';
import type { ArbitrationOutcome, ArbitrationScope } from '../arbitration.ts';

/**
 * `browser_claim` (§3.2) — atomic grant-or-queue for exactly one tab.
 *
 * **One claim, one tab, one row** (`MILESTONES.md` #13). There is no `tabs`
 * argument and its absence is the model (§2.3): a caller that wants three
 * calls this three times, and should read §2.3a first, because doing so while
 * other callers do the same is a named limit rather than a solved problem.
 *
 * ── Why grant and queue are one operation rather than two ───────────────
 *
 * They are the two outcomes of one decision, taken against a count the same
 * transaction has just reconciled (§7.1 `capacity.admission`). Splitting them
 * would mean a caller asking "is there room" and then asking to be granted,
 * with every other process free to take the room in between — which is the
 * read-then-write window §1.0a measures as failing. **The count is read and
 * the row is written inside one transaction, or the answer is a guess.**
 *
 * ── What is not decided here ────────────────────────────────────────────
 *
 * The sweep. It has already run by the time this handler is called, because
 * the runner sweeps unconditionally before any handler (`arbitration.ts`), so
 * every count below is over reconciled state. A handler cannot skip it, opt
 * out of it, or run before it — which is the standing invariant made
 * mechanical rather than remembered.
 */

/** What a caller supplies to ask for a lease. */
export interface ClaimInput {
  /** The caller's identity (§1.3). **Not a limit** — a session may hold many leases. */
  readonly sessionId: string;
  /** Which browser. **No default, deliberately** (§3.2): neither is a safe guess. */
  readonly browser: string;
  /** What this lease is for, in human words. What an operator reads when revoking. */
  readonly purpose: string;
}

/** The grant: a live lease holding one tab. */
export interface ClaimGranted {
  readonly outcome: 'granted';
  readonly claimId: string;
  /** **Returned once and never recoverable** (§2.2). Not stored; only its hash is. */
  readonly key: string;
  readonly browserId: BrowserId;
  readonly tabId: string;
  readonly expiresAt: string;
  readonly leaseSeconds: number;
  readonly nudge?: OwnObstacleNudge;
}

/** The queue placement: a lease and a key, and no tab. */
export interface ClaimQueued {
  readonly outcome: 'queued';
  readonly claimId: string;
  readonly key: string;
  readonly browserId: BrowserId;
  readonly position: number;
  readonly queueSeconds: number;
  readonly expiresAt: string;
  /** Seconds, and **a weak number, labelled as one** (§1.5). Absent with no history. */
  readonly waitEstimateSeconds?: number;
  /**
   * The obligation, the number **and the mechanism** (§2.5, `MILESTONES.md` #17).
   *
   * A caller told *your place expires in ten minutes* will agree, intend to
   * return, and be gone — the obligation understood and unmet, and the place
   * lost without anybody deciding to lose it. So this says **check back at
   * just under the lifetime**, because a check scheduled exactly at the
   * deadline races the sweep and loses about half the time.
   */
  readonly checkBack: string;
  readonly checkBackSeconds: number;
  readonly nudge?: OwnObstacleNudge;
}

export type ClaimResult = ClaimGranted | ClaimQueued;

/**
 * How far under the lifetime a caller is told to check back.
 *
 * Nine parts in ten, which against the ten-minute default is the nine minutes
 * §2.5 and `MILESTONES.md` #17 both name. **Expressed as a fraction rather
 * than as a fixed sixty seconds** so it stays *under* the lifetime when the
 * lifetime is configured shorter — a fixed subtraction would become zero or
 * negative on a short queue place, and would tell a caller to check back in
 * the past.
 */
export const CHECK_BACK_FRACTION = 0.9;

/** The check-back deadline in seconds, always at least one. */
export function checkBackSeconds(lifetimeSeconds: number): number {
  return Math.max(1, Math.floor(lifetimeSeconds * CHECK_BACK_FRACTION));
}

/**
 * The settings the claim decides against, read from the process environment
 * once on the way in (§6.3).
 *
 * Passed rather than read here so the handler has no way to reach a different
 * snapshot than the rest of the call — every rule inside one operation sees
 * one configuration.
 */
export interface ArbitrationSettings {
  readonly tabBudget: number;
  readonly leaseSeconds: number;
  readonly queueSeconds: number;
}

/**
 * Decide one claim: grant it a tab, or put it at the back of the queue.
 *
 * The order of the two refusals below is deliberate. **An unknown browser is
 * refused before anything is written**, because nothing will ever make it
 * valid (§2.2) — waiting does not help and a queue entry would be a promise
 * the service cannot keep. Both refusals leave the ledger with a row and the
 * claims table without one, which is what makes a refused request anonymous
 * without `events.session_id` (§1.6) and is why that column exists.
 */
export function decideClaim(
  scope: ArbitrationScope,
  input: ClaimInput,
  settings: ArbitrationSettings,
): ArbitrationOutcome<ClaimResult> {
  const { db, swept, adapter } = scope;

  if (!isKnownBrowser(input.browser)) {
    scope.recordRefusal({
      kind: 'claim_requested',
      outcome: 'deny',
      guard: 'claim.browser_known',
      adapter,
      sessionId: input.sessionId,
      detail: { requested: input.browser, known: BROWSER_IDS },
    });
    throw new CallRefusal(
      'unknown_browser',
      `There is no browser named ${JSON.stringify(input.browser)}. This service has exactly two: ${BROWSER_IDS.join(' and ')}.`,
      { detail: { requested: input.browser, known: BROWSER_IDS } },
    );
  }

  const browserId = input.browser;
  const now = swept.sweptAt;
  const claimId = randomUUID();
  const key = mintKey();

  // Admission: one integer against one integer, over a count this same
  // transaction reconciled (§7.1 `capacity.admission`). This is the whole of
  // the capacity model — there is no request size to add and no reservation
  // to arithmetic against.
  const granted = admits(countActiveClaims(db), settings.tabBudget);

  const ttlSeconds = granted ? settings.leaseSeconds : settings.queueSeconds;

  // The arrival counter, allocated inside this transaction and therefore
  // serialised with every other caller by construction (§1.0a). It is what
  // orders the queue: `created_at` has millisecond resolution and callers
  // arriving inside one millisecond are ordinary at this rate, so ordering by
  // it would leave the order between them to a random identifier — and a
  // position decided that way can get *worse*, which §2.5 promises it never
  // does.
  const arrival = (
    db
      .prepare('UPDATE claim_arrival SET next = next + 1 WHERE only_row = 1 RETURNING next')
      .get() as { next: number }
  ).next;

  db.prepare(
    `INSERT INTO claims
       (id, key_hash, session_id, browser_id, state, purpose,
        expires_at, ttl_seconds, activated_at, arrival, created_at, updated_at)
     VALUES
       (@id, @keyHash, @sessionId, @browserId, @state, @purpose,
        strftime('%Y-%m-%dT%H:%M:%fZ', @now, @extend), @ttl, @activatedAt, @arrival, @now, @now)`,
  ).run({
    arrival,
    id: claimId,
    keyHash: hashKey(key),
    sessionId: input.sessionId,
    browserId,
    state: granted ? 'active' : 'queued',
    purpose: input.purpose,
    now,
    extend: `+${String(ttlSeconds)} seconds`,
    ttl: ttlSeconds,
    // Null forever on a lease that expired while waiting, and set at the
    // moment a lease stops waiting (§1.3). A queued lease has never had a tab.
    activatedAt: granted ? now : null,
  });

  append(db, {
    kind: 'claim_requested',
    outcome: 'allow',
    adapter,
    claimId,
    sessionId: input.sessionId,
    browserId,
    detail: { purpose: input.purpose, granted },
  });

  return granted
    ? grant({ scope, input, settings, claimId, key, browserId, now })
    : queue({ scope, input, settings, claimId, key, browserId, now });
}

/** Is this one of the two? Narrowing, so the browser identifier is typed downstream. */
function isKnownBrowser(value: string): value is BrowserId {
  return (BROWSER_IDS as readonly string[]).includes(value);
}

/** What both branches are handed, so neither can read a different instant. */
interface Branch {
  readonly scope: ArbitrationScope;
  readonly input: ClaimInput;
  readonly settings: ArbitrationSettings;
  readonly claimId: string;
  readonly key: string;
  readonly browserId: BrowserId;
  readonly now: string;
}

/**
 * The grant: the lease is active, so it has a tab.
 *
 * **The tab row is created `opening` and no browser is called.** §2.4b is
 * absolute about this — a round trip to a browser inside the transaction lets
 * one wedged browser block every arbitration call on the machine, because
 * every caller is serialised behind the same writer. `opening` is the honest
 * state for a tab the tool has been asked for and has not answered about.
 *
 * **Capacity is taken by the claim row, not by the tab** (§2.3): the claim
 * *is* the capacity, so there is no window in which capacity is reserved for
 * a tab that does not exist yet. If the tab fails to open, the lease ends and
 * the count follows immediately, because it is a count of claims.
 */
function grant(branch: Branch): ArbitrationOutcome<ClaimResult> {
  const { scope, input, settings, claimId, key, browserId, now } = branch;
  const tabId = randomUUID();

  scope.db
    .prepare(
      `INSERT INTO tabs (id, claim_id, browser_id, state, created_at, updated_at)
       VALUES (@tabId, @claimId, @browserId, 'opening', @now, @now)`,
    )
    .run({ tabId, claimId, browserId, now });

  const expiresAt = readExpiry(scope, claimId);

  append(scope.db, {
    kind: 'claim_granted',
    outcome: 'allow',
    adapter: scope.adapter,
    claimId,
    tabId,
    sessionId: input.sessionId,
    browserId,
    detail: { expiresAt, leaseSeconds: settings.leaseSeconds },
  });

  append(scope.db, {
    kind: 'tab_opening',
    outcome: 'allow',
    adapter: scope.adapter,
    claimId,
    tabId,
    sessionId: input.sessionId,
    browserId,
  });

  // A granted caller may still be its own obstacle — it has just taken the
  // last unit and the rest of its work is now queued behind other callers.
  // §2.3a scopes the nudge to a refusal or a queue placement, so nothing is
  // attached here; the ledger already records the grant.
  return {
    value: {
      outcome: 'granted',
      claimId,
      key,
      browserId,
      tabId,
      expiresAt,
      leaseSeconds: settings.leaseSeconds,
    },
  };
}

/**
 * The queue placement: a lease and a key, and no tab.
 *
 * The response carries the position, a weak estimate labelled as one, and —
 * the substance of `MILESTONES.md` #17 rather than its wording — **the
 * mechanism**: check back at just under the lifetime, because a check
 * scheduled exactly at the deadline races the sweep and loses about half the
 * time.
 */
function queue(branch: Branch): ArbitrationOutcome<ClaimResult> {
  const { scope, input, settings, claimId, key, browserId, now } = branch;

  const position = queuePosition(scope.db, claimId);
  const estimate = waitEstimateSeconds(scope.db, position);
  const expiresAt = readExpiry(scope, claimId);
  const checkBack = checkBackSeconds(settings.queueSeconds);

  append(scope.db, {
    kind: 'claim_queued',
    outcome: 'allow',
    adapter: scope.adapter,
    claimId,
    sessionId: input.sessionId,
    browserId,
    detail: { position, expiresAt, queueSeconds: settings.queueSeconds, queuedAt: now },
  });

  const nudge = nudgeIfOwnObstacle(scope.db, {
    sessionId: input.sessionId,
    claimId,
    adapter: scope.adapter,
    outcome: 'queued',
  });

  return {
    value: {
      outcome: 'queued',
      claimId,
      key,
      browserId,
      position,
      queueSeconds: settings.queueSeconds,
      expiresAt,
      ...(estimate === undefined ? {} : { waitEstimateSeconds: estimate }),
      checkBackSeconds: checkBack,
      checkBack:
        `Call in with this key at least every ${String(checkBack)} seconds, or this place is lost and a fresh request queues at the back with a new key. ` +
        `The place lives ${String(settings.queueSeconds)} seconds; set up a recurring check at ${String(checkBack)} seconds rather than at the deadline, because a check made exactly at the deadline races the reclamation and loses about half the time. ` +
        'Any call carrying this key extends the place — asking where you stand is how you hold it.',
      ...(nudge === undefined ? {} : { nudge }),
    },
  };
}

/**
 * Read the expiry back out of the row rather than recomputing it.
 *
 * The value was written by the database's own clock arithmetic, and computing
 * the same instant a second time in this process would produce a string that
 * agrees under one set of rounding rules and disagrees under another. What
 * the caller is told is therefore read back from the row, so it is exactly
 * what the sweep will compare against.
 */
function readExpiry(scope: ArbitrationScope, claimId: string): string {
  const row = scope.db
    .prepare('SELECT expires_at AS expiresAt FROM claims WHERE id = @claimId')
    .get({
      claimId,
    }) as { expiresAt: string };
  return row.expiresAt;
}
