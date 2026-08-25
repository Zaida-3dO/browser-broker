import type { ArbitrationOutcome, ArbitrationScope } from '../arbitration.ts';
import { BROWSER_IDS, BROWSER_CHOICE_GUIDANCE, type BrowserId } from '../../browser/driver.ts';
import { CallRefusal } from '../refusals.ts';
import { append } from '../events.ts';

/**
 * `broker login` — **the one time a person drives** (`SCHEMA.md` §5.5.1).
 *
 * ── Why this is a service operation and not a command that opens a window ──
 *
 * The obvious shape for "let a person sign in" is a command that launches a
 * browser and gets out of the way. §5.5.1 rejects that shape explicitly, and
 * the reason is the first of its four steps: it **refuses if any live lease
 * holds a tab on that browser**, naming them. *"Somebody is about to drive
 * the window by hand, and doing that underneath a caller's work would corrupt
 * it. That refusal is why signing in is a service operation and not something
 * a person does to the browser directly."*
 *
 * A command that reached for the browser itself could not make that check
 * mean anything. Leases live in the store, liveness is **derived rather than
 * stored** (§2.4), and the only place a lapsed lease is reconciled is inside
 * the arbitration transaction. So a check made outside it would read rows
 * that may have expired — refusing a person over a caller that is already
 * gone — or miss one that went live between the read and the hand-over. Both
 * halves are wrong in the direction that costs somebody their work.
 *
 * ── Nothing is stopped and nothing is relaunched ────────────────────────
 *
 * §5.5.1 is emphatic and the reason is the keeper-tab measurement (§3.15):
 * **the signed-in browser runs headed and stays headed**, so the window a
 * person signs into is the window that is already there. *"Nothing is stopped
 * and nothing is relaunched, which removes the step where a sign-in could be
 * lost."*
 *
 * That is why this operation moves a **state** and does no browser work at
 * all. It does not launch, attach, navigate or close anything — those are
 * browser calls, and browser calls never happen inside the arbitration
 * transaction (§2.4b). What it does is claim the browser for the person, so
 * that whoever hands them the window is handing them one nobody else is about
 * to touch.
 *
 * ── The interval, and why both edges are recorded ───────────────────────
 *
 * Between the two calls the browser is in `signing-in`, and §5.5.1's third
 * step is that *"requests for it are refused with a retry hint"* while
 * **"queued callers keep their places and their timers, because a sign-in is
 * a pause and not a cancellation"**. So this is the one interval in which the
 * service turns callers away on purpose, and §1.6 requires every decision
 * recorded. Both edges get a ledger row (schema step six) so that a run of
 * denials reads as a person signing in rather than as a browser fault.
 */

/** The refusal rules this module raises, spelled as §7.2 spells them. */
export const SIGN_IN_RULES = {
  /** A sign-in never happens underneath a caller's work (§5.5.1 step 1). */
  noLiveLeases: 'signin.no_live_leases',
  /** Only the browser that has a profile to sign into (§5.5.1, last line). */
  persistentProfileOnly: 'signin.persistent_profile_only',
  /** One sign-in at a time, and ending one that never began is a mistake. */
  stateOrder: 'signin.state_order',
} as const;

/**
 * The browser a person can sign into.
 *
 * **Not a preference and not a policy — a fact about where a sign-in goes.**
 * §5.5.1: *"Refused on the private browser. Signing into an ephemeral profile
 * produces nothing that outlives the browser, so the command would appear to
 * work and quietly do nothing — the worst of the available failures."*
 *
 * The private browser is the headless one (`modeFor`), and everything a
 * sign-in produces is written into the profile directory (§1.2). A private
 * profile is discarded, so the person would type a password, see it accepted,
 * and have nothing to show for it — a success that did nothing, which is the
 * failure this design is least able to detect after the fact.
 */
export const SIGNABLE_BROWSER: BrowserId = 'regular';

/** A lease named in a refusal, so a person knows who they would interrupt. */
export interface HoldingLease {
  readonly claimId: string;
  readonly sessionId: string;
  readonly purpose: string;
  readonly expiresAt: string;
}

export interface BeginSignInInput {
  readonly browser: string;
}

export interface BeginSignInResult {
  readonly browser: BrowserId;
  /** The state the browser is in now, which is what turns callers away. */
  readonly state: 'signing-in';
  /**
   * Where the profile is, **relative to the configured profile root**.
   *
   * Never absolute: §1.7a's rule is that no absolute path is reported,
   * because an absolute path names one machine.
   */
  readonly profileRelativePath: string;
  /** Whether a browser was already running to hand over, per the store. */
  readonly browserWasRunning: boolean;
}

export interface EndSignInInput {
  readonly browser: string;
}

export interface EndSignInResult {
  readonly browser: BrowserId;
  /** Back to serving. `stopped` when no browser was running to return to. */
  readonly state: 'running' | 'stopped';
  /** How many queued callers are waiting, having kept their places. */
  readonly queueDepth: number;
}

interface BrowserRow {
  readonly id: BrowserId;
  readonly state: string;
  readonly pid: number | null;
}

function readBrowser(scope: ArbitrationScope, browser: BrowserId): BrowserRow {
  return scope.db
    .prepare<{ id: string }, BrowserRow>('SELECT id, state, pid FROM browsers WHERE id = @id')
    .get({ id: browser }) as BrowserRow;
}

/**
 * Refuse anything that is not the browser with a profile to sign into.
 *
 * Two refusals rather than one, because they are two different mistakes and
 * merging them sends the second person hunting for a typo they did not make:
 * a name that is not a browser at all, and the private browser — which *is* a
 * browser, and is the one where signing in would appear to work.
 */
function resolveSignableBrowser(scope: ArbitrationScope, requested: string): BrowserId {
  const { adapter } = scope;

  if (!BROWSER_IDS.includes(requested as BrowserId)) {
    scope.recordRefusal({
      kind: 'browser_signin_began',
      outcome: 'deny',
      guard: 'claim.browser_known',
      adapter,
      detail: { requested, known: BROWSER_IDS },
    });
    throw new CallRefusal(
      'unknown_browser',
      `There is no browser named ${JSON.stringify(requested)}. This service has exactly two: ${BROWSER_IDS.join(' and ')}. ${BROWSER_CHOICE_GUIDANCE}`,
      { detail: { requested, known: BROWSER_IDS } },
    );
  }

  if (requested !== SIGNABLE_BROWSER) {
    scope.recordRefusal({
      kind: 'browser_signin_began',
      outcome: 'deny',
      guard: SIGN_IN_RULES.persistentProfileOnly,
      adapter,
      browserId: requested,
      detail: { requested, signable: SIGNABLE_BROWSER },
    });
    throw new CallRefusal(
      'unknown_browser',
      `The ${requested} browser cannot be signed into. Its profile is ephemeral, so everything a sign-in produces is discarded with the browser — the command would appear to work and leave you signed into nothing. Sign in to the ${SIGNABLE_BROWSER} browser, whose profile persists and is the identity every caller shares.`,
      { detail: { requested, signable: SIGNABLE_BROWSER } },
    );
  }

  return requested;
}

/**
 * Begin: claim the browser for the person (§5.5.1 steps 1 and 2).
 *
 * **The live-lease check runs against the state this transaction's own sweep
 * reconciled**, which is the whole reason it is here rather than in a
 * command. A lease that lapsed a second ago has already been expired by the
 * runner before this handler was called, so it does not refuse a person over
 * a caller that is gone; and one granted a moment ago is committed and
 * visible, so it does not miss a caller that is live.
 */
export function decideBeginSignIn(
  scope: ArbitrationScope,
  input: BeginSignInInput,
): ArbitrationOutcome<BeginSignInResult> {
  const { db, adapter, swept } = scope;
  const browser = resolveSignableBrowser(scope, input.browser);
  const row = readBrowser(scope, browser);

  // Already signing in. Refused rather than treated as success: two people
  // handed the same window would each believe they had it to themselves, and
  // whichever finished first would end the other's sign-in by moving the
  // state back underneath them.
  if (row.state === 'signing-in') {
    scope.recordRefusal({
      kind: 'browser_signin_began',
      outcome: 'deny',
      guard: SIGN_IN_RULES.stateOrder,
      adapter,
      browserId: browser,
      detail: { state: row.state },
    });
    throw new CallRefusal(
      'browser_unavailable',
      `The ${browser} browser is already being signed into. Only one sign-in happens at a time — a second would hand the same window to two people, and whichever finished first would end the other's. Finish that one, or end it if it was abandoned.`,
      { detail: { browser, state: row.state } },
    );
  }

  // §5.5.1 step 1, and the reason this is a service operation at all. The
  // rows read here are the ones this transaction's sweep has already
  // reconciled, so `active` means active now rather than active when
  // somebody last looked.
  //
  // ── What the two conditions each carry, stated because one of them is
  //    not falsifiable by any test this build can write ─────────────────
  //
  // The query requires **both** a live claim and an open tab. In this build
  // those two move together on every path the product can reach — a grant
  // makes the pair (`active`, `opening`), a release makes it (`released`,
  // `closed`), and an expiry makes it (`expired`, `closed`) — so **no
  // reachable state separates them**, and a mutation that drops either
  // condition alone survives the suite. That was measured rather than
  // assumed, by removing each in turn and watching the tests stay green.
  //
  // Both are kept anyway, and the reason is that the redundancy is a
  // property of this build rather than of the design. A lease is one tab
  // (§2.3), and the tab-addressed operations that give a tab up and take a
  // fresh one need a browser to run at all — so the state where a live claim
  // has no open tab is unreachable while no browser runs, and becomes
  // reachable once one does. Narrowing the query to whichever half suffices
  // for the reachable states would be correct against those states and wrong
  // against the rest, and the failure it produces is a person handed a
  // window a caller is holding.
  //
  // This is written down rather than left as a surviving mutation somebody
  // rediscovers: the condition is deliberate, it is not covered, and the
  // reason it is not covered is that the product cannot yet produce the
  // state that would cover it.
  const holders = db
    .prepare<{ browserId: string }, HoldingLease>(
      `SELECT c.id AS claimId, c.session_id AS sessionId, c.purpose AS purpose,
              c.expires_at AS expiresAt
         FROM claims c
         JOIN tabs t ON t.claim_id = c.id
        WHERE c.browser_id = @browserId
          AND c.state = 'active'
          AND t.state IN ('opening', 'open')
        ORDER BY c.id`,
    )
    .all({ browserId: browser });

  if (holders.length > 0) {
    scope.recordRefusal({
      kind: 'browser_signin_began',
      outcome: 'deny',
      guard: SIGN_IN_RULES.noLiveLeases,
      adapter,
      browserId: browser,
      // Which leases, so a person knows who they would interrupt — and
      // deliberately not the keys, which §5.6 says are never printed by any
      // surface. A claim identifier addresses nothing without its key.
      detail: {
        holders: holders.map((holder) => ({
          claimId: holder.claimId,
          sessionId: holder.sessionId,
          purpose: holder.purpose,
          expiresAt: holder.expiresAt,
        })),
      },
    });
    const described = holders
      .map(
        (holder) =>
          `${holder.claimId} (session ${holder.sessionId}, ${holder.purpose}, until ${holder.expiresAt})`,
      )
      .join('; ');
    throw new CallRefusal(
      'browser_unavailable',
      `The ${browser} browser has ${String(holders.length)} live lease(s) holding a tab, so it cannot be handed to a person right now: driving the window by hand underneath a caller's work would corrupt it. Waiting is enough — every lease expires on its own if its holder stops calling in. Holding: ${described}`,
      { detail: { browser, holders: [...holders] } },
    );
  }

  // §5.5.1 step 2. The state is the whole mechanism: it is what later callers
  // are refused against, and moving it is the only thing this operation does
  // to the world.
  //
  // **The process identifier is left exactly as it is**, which is what keeps
  // "nothing is stopped and nothing is relaunched" true through this path. A
  // browser that is running stays running and keeps its row's pid; one that
  // is not stays stopped. The table's own check constraint ties `stopped` to
  // a null pid, so this preserves the pid rather than setting it.
  const browserWasRunning = row.pid !== null;
  db.prepare(`UPDATE browsers SET state = 'signing-in', updated_at = @now WHERE id = @id`).run({
    id: browser,
    now: swept.sweptAt,
  });

  append(db, {
    kind: 'browser_signin_began',
    outcome: 'allow',
    adapter,
    browserId: browser,
    // Which browser and when, and nothing a person typed. See step six's
    // header: this row is built by hand, and a well-meaning addition is how
    // it would stop being true.
    detail: { browserWasRunning, previousState: row.state },
  });

  return {
    value: {
      browser,
      state: 'signing-in',
      // Relative, per §1.7a. The root is configuration the reader already has.
      profileRelativePath: browser,
      browserWasRunning,
    },
  };
}

/**
 * End: give the browser back (§5.5.1 step 4).
 *
 * *"On their confirmation, the browser goes back to `running` and the queue
 * is swept."* The sweep is the runner's, and it has already happened by the
 * time this is called — which is the point: **queued callers kept their
 * places and their timers throughout**, because nothing in this file touches
 * a claim row. A sign-in is a pause, not a cancellation.
 */
export function decideEndSignIn(
  scope: ArbitrationScope,
  input: EndSignInInput,
): ArbitrationOutcome<EndSignInResult> {
  const { db, adapter, swept } = scope;
  const browser = resolveSignableBrowser(scope, input.browser);
  const row = readBrowser(scope, browser);

  if (row.state !== 'signing-in') {
    scope.recordRefusal({
      kind: 'browser_signin_ended',
      outcome: 'deny',
      guard: SIGN_IN_RULES.stateOrder,
      adapter,
      browserId: browser,
      detail: { state: row.state },
    });
    throw new CallRefusal(
      'browser_unavailable',
      `The ${browser} browser is not being signed into — it is ${row.state}. Ending a sign-in that never began would move the browser's state on the strength of a call that corresponds to nothing.`,
      { detail: { browser, state: row.state } },
    );
  }

  // Back to what the pid says it is, rather than to a fixed value. The
  // table's check constraint requires `stopped` to have no process and every
  // other state to have one, so deriving the destination from the pid is what
  // makes this legal for both cases — a browser that was running when the
  // person started, and one that was never up.
  const state: 'running' | 'stopped' = row.pid === null ? 'stopped' : 'running';

  db.prepare(`UPDATE browsers SET state = @state, updated_at = @now WHERE id = @id`).run({
    id: browser,
    state,
    now: swept.sweptAt,
  });

  const queued = db
    .prepare<[], { depth: number }>(`SELECT COUNT(*) AS depth FROM claims WHERE state = 'queued'`)
    .get() as { depth: number };

  append(db, {
    kind: 'browser_signin_ended',
    outcome: 'allow',
    adapter,
    browserId: browser,
    detail: { state, queueDepth: queued.depth },
  });

  return { value: { browser, state, queueDepth: queued.depth } };
}
