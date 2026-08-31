import type { ArbitrationOutcome, ArbitrationScope } from '../arbitration.ts';
import { BROWSER_CHOICE_GUIDANCE, type BrowserId, type BrowserKind } from '../../browser/driver.ts';
import { CallRefusal } from '../refusals.ts';
import { append } from '../events.ts';
import { extendLease, resolveLease } from '../leases.ts';
import {
  classifySignIn,
  processIsRunning,
  SIGN_IN_OWNER_UNKNOWN_REMEDY,
  type ProcessLiveness,
} from '../signin-recovery.ts';

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

/**
 * The refusal rules this module raises, **spelled as §7.1 spells them**.
 *
 * Named from the design's own table rather than invented here, which is what
 * §8's fourth parity assertion counts over: *every rule in §7 appears in at
 * least one refusal the service actually produced*. A rule this file made up
 * would satisfy nothing and would be invisible to that count — and the build
 * check that reconciles cited rules against the design refuses it outright.
 */
export const SIGN_IN_RULES = {
  /**
   * §7.1 `browser.busy_for_login`: *"Signing in is refused while any live
   * lease holds a tab on that browser"*, refused *"naming the leases"*.
   */
  busyForLogin: 'browser.busy_for_login',
  /**
   * §7.1 `browser.serving`, whose entry says outright that it *"covers
   * signing-in"* — so a browser handed to a person is refused by the same
   * rule as one that is failed, starting or stopped. That is the design's
   * grouping and not this module's: from a caller's side all four are *the
   * browser is not available right now*, and the retry hint is what
   * distinguishes the pause from the fault.
   */
  serving: 'browser.serving',
  /**
   * §7.1 `signin.what_bounded`. The sentence a person reads to know which
   * sign-in wall this is, bounded exactly as `claims.purpose` is (§1.3).
   *
   * **A rule of its own rather than a reuse of `claim.purpose_bounded`**, for
   * the reason `refusals.ts` gives about those two being the same *shape* of
   * defect and not the same refusal: a caller branching on the purpose rule
   * would go and rewrite a purpose that was never wrong.
   */
  whatBounded: 'signin.what_bounded',
  /**
   * §7.1 `signin.requester_holds_tab`. A request comes from a lease that is
   * holding an open tab, because the person signs in **on that tab** — there
   * is nothing to hand them otherwise.
   */
  requesterHoldsTab: 'signin.requester_holds_tab',
  /**
   * §7.1 `signin.finish_owned`. Only the lease that asked may finish the
   * request it made. Without it, a caller could end a person's `broker login`
   * mid-password by naming a browser, which is the browser-scoped destructive
   * verb §3.13 says must never exist on this surface.
   */
  finishOwned: 'signin.finish_owned',
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

/**
 * The kind of browser a person can sign into.
 *
 * The kind rather than the name, because a name says nothing about the kind
 * once names are configured (`DECISIONS.md` §13i). This is what the store's
 * `kind` column is compared against, and the reasoning for *why* clean-room
 * browsers are refused is on {@link SIGNABLE_BROWSER} above — it is a fact
 * about ephemeral profiles, which is a property of the kind and never of the
 * word.
 */
export const SIGNABLE_KIND: BrowserKind = 'regular';

/** A lease named in a refusal, so a person knows who they would interrupt. */
export interface HoldingLease {
  readonly claimId: string;
  readonly sessionId: string;
  readonly purpose: string;
  readonly expiresAt: string;
}

export interface BeginSignInInput {
  readonly browser: string;
  /**
   * The process that will hold this sign-in, recorded so an abandoned one is
   * recoverable.
   *
   * Supplied by the command rather than read from `process.pid` here, because
   * this module runs inside the service and the owner is the **command's**
   * process. In this build they are the same process — the service is spawned
   * by its caller and exits with it (§1.0a) — but they are the same by
   * arrangement rather than by necessity, and a service that read its own
   * identifier would be recording the wrong one the moment that arrangement
   * changed.
   */
  readonly ownerPid?: number;
  /**
   * How the owner's liveness is asked, injected so the reclaim path is
   * reachable from a test without killing a real process.
   */
  readonly isRunning?: ProcessLiveness;
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
  /** Which process began the sign-in, when the browser is in one (step eight). */
  readonly signin_owner_pid: number | null;
  /** When a *requested* sign-in lapses, when the browser is in one (step ten). */
  readonly signin_deadline: string | null;
  /** Which lease asked for it, when a caller did rather than a person (step ten). */
  readonly signin_claim_id: string | null;
}

function readBrowser(scope: ArbitrationScope, browser: BrowserId): BrowserRow {
  return scope.db
    .prepare<{ id: string }, BrowserRow>(
      'SELECT id, state, pid, signin_owner_pid, signin_deadline, signin_claim_id FROM browsers WHERE id = @id',
    )
    .get({ id: browser }) as BrowserRow;
}

/**
 * Refuse anything that is not a browser with a profile to sign into.
 *
 * Two refusals rather than one, because they are two different mistakes and
 * merging them sends the second person hunting for a typo they did not make:
 * a name that is not a browser at all, and a clean-room browser — which *is*
 * a browser, and is the one where signing in would appear to work.
 *
 * ── Why the store answers this rather than a constant ───────────────────
 *
 * A browser's name does not say what kind it is (`DECISIONS.md` §13i), so
 * *"is this signable"* is a question about the browser rather than a
 * comparison against the word `regular` — which the store answers from
 * the `kind` column schema step nine added, under the same check constraint
 * that makes the kind total. **The row is the right authority here** for the
 * same reason §1.2 gives about `pid`: the service acts on what it has
 * recorded, and a browser with no row is a browser this service does not
 * manage, whatever a configuration elsewhere on the machine may say.
 *
 * A browser configured but never launched therefore has no row and is
 * refused as unknown. That is the honest answer rather than a gap: signing in
 * is a claim over a **profile**, and §5.5.1 has the caller establish the
 * profile and the row before it asks — `login-command.ts` runs the setup
 * handshake first for exactly this reason.
 */
function resolveSignableBrowser(scope: ArbitrationScope, requested: string): BrowserId {
  const { adapter } = scope;

  const known = scope.db
    .prepare<[], { id: string; kind: string }>('SELECT id, kind FROM browsers ORDER BY id')
    .all();

  const match = known.find((row) => row.id === requested);

  if (match === undefined) {
    const names = known.map((row) => row.id);
    scope.recordRefusal({
      kind: 'browser_signin_began',
      outcome: 'deny',
      guard: 'claim.browser_known',
      adapter,
      detail: { requested, known: names },
    });
    throw new CallRefusal(
      'unknown_browser',
      `There is no browser named ${JSON.stringify(requested)}. This service has ${names.join(' and ')}. ${BROWSER_CHOICE_GUIDANCE}`,
      { detail: { requested, known: names } },
    );
  }

  if (match.kind !== SIGNABLE_KIND) {
    const signable = known.filter((row) => row.kind === SIGNABLE_KIND).map((row) => row.id);
    scope.recordRefusal({
      kind: 'browser_signin_began',
      outcome: 'deny',
      guard: SIGN_IN_RULES.serving,
      adapter,
      browserId: requested,
      detail: { requested, signable },
    });
    throw new CallRefusal(
      // **Not `unknown_browser`.** A clean-room browser is a real browser, and
      // refusing it with the code for a name that does not exist made the
      // command report `claim.browser_known` — telling a person their browser
      // name was wrong when it was right. See the taxonomy entry.
      'cannot_sign_in',
      `The ${requested} browser cannot be signed into. Its profile is ephemeral, so everything a sign-in produces is discarded with the browser — the command would appear to work and leave you signed into nothing. Sign in to ${signable.join(' or ')}, whose profile persists and is an identity callers share.`,
      { detail: { requested, signable } },
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

  // ── Already signing in: whose, and are they still there? ──────────────
  //
  // **Refusing unconditionally here is what made an interrupted `broker login`
  // unrecoverable.** A `finally` does not run on a signal, so a person who
  // pressed Ctrl-C left this state behind with nothing able to move it; this
  // refusal then turned away every caller *and* the second `broker login` that
  // would have ended it. The only exit was editing the database by hand.
  //
  // So the question asked is **"is anybody still signing in"** rather than
  // merely "is it signing in", and the two answers are kept apart:
  //
  // - **Owner still running** — refused, exactly as before and for the
  //   original reason: two people handed the same window would each believe
  //   they had it to themselves, and whichever finished first would end the
  //   other's by moving the state back underneath them.
  // - **Owner gone** — reclaimed. Nothing is being taken from anybody,
  //   because the process that was holding it does not exist. Recorded in the
  //   ledger as its own decision so a reclamation is legible afterwards rather
  //   than looking like a sign-in that ended itself.
  // - **Owner unknown** — refused, and this is deliberate. A row written
  //   before the owner column existed records nobody, and reclaiming on the
  //   strength of a missing record would end a live sign-in because an old
  //   build did not write down who started it. The refusal says so and says
  //   what to do.
  if (row.state === 'signing-in') {
    const owner = classifySignIn(row, input.isRunning ?? processIsRunning);

    if (owner.kind === 'owner-running') {
      scope.recordRefusal({
        kind: 'browser_signin_began',
        outcome: 'deny',
        guard: SIGN_IN_RULES.serving,
        adapter,
        browserId: browser,
        detail: { state: row.state, ownerPid: owner.pid, owner: 'running' },
      });
      throw new CallRefusal(
        'browser_unavailable',
        `The ${browser} browser is already being signed into, by a process that is still running. Only one sign-in happens at a time — a second would hand the same window to two people, and whichever finished first would end the other's. Finish that one, or stop it.`,
        { detail: { browser, state: row.state, ownerPid: owner.pid } },
      );
    }

    if (owner.kind === 'owner-unknown') {
      scope.recordRefusal({
        kind: 'browser_signin_began',
        outcome: 'deny',
        guard: SIGN_IN_RULES.serving,
        adapter,
        browserId: browser,
        detail: { state: row.state, owner: 'unknown' },
      });
      throw new CallRefusal(
        'browser_unavailable',
        `The ${browser} browser is recorded as being signed into, but this store does not say which process began it — so it cannot be confirmed abandoned and is not ended on a guess. ${SIGN_IN_OWNER_UNKNOWN_REMEDY}`,
        { detail: { browser, state: row.state } },
      );
    }

    // `owner-gone`. Reclaimed, and recorded as a reclamation on its own row:
    // §1.6 keeps one row per decision, and a reclamation is a different
    // decision from a person finishing. A run of these reads as a command
    // being interrupted repeatedly, which is exactly the pattern somebody
    // debugging would want to see.
    append(db, {
      kind: 'browser_signin_ended',
      outcome: 'allow',
      adapter,
      browserId: browser,
      detail: {
        reclaimed: true,
        ownerPid: owner.kind === 'owner-gone' ? owner.pid : null,
        reason: 'the process holding this sign-in has gone',
      },
    });
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
      guard: SIGN_IN_RULES.busyForLogin,
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

  // **The owner is written in the same statement that moves the state**, so
  // there is no instant at which a browser is `signing-in` with nobody
  // recorded against it. Two statements would leave exactly that window, and
  // a process killed inside it would produce the unrecoverable row this whole
  // mechanism exists to remove — rarely, which is the worst frequency for a
  // defect of this kind.
  const ownerPid = input.ownerPid ?? null;
  // **The request columns are cleared as the owner is written**, so a browser
  // is never held by a process *and* a deadline at once. This path is reached
  // after a lapsed or reclaimed request as well as from a clean state, and a
  // deadline left behind from one would lapse a person's `broker login` out
  // from under them at a moment nothing here chose.
  db.prepare(
    `UPDATE browsers
        SET state = 'signing-in', signin_owner_pid = @ownerPid,
            signin_deadline = NULL, signin_claim_id = NULL, updated_at = @now
      WHERE id = @id`,
  ).run({
    id: browser,
    ownerPid,
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
      guard: SIGN_IN_RULES.serving,
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

  // **The owner is cleared with the state**, for the same reason it was set
  // with it: a browser that is not signing in has no owner, and a stale
  // identifier left behind would be a record of a process that is not holding
  // anything — the kind of leftover a later reader trusts.
  // **All three sign-in columns cleared, not just the owner.** Step ten added
  // a deadline and an asking lease for a *requested* sign-in, and this command
  // path can meet one: `broker login` reclaims a sign-in whose owner is gone,
  // and a request that lapsed leaves rows this same statement has to clean.
  // Leaving them set would record a deadline and a claim against a browser
  // that is serving — exactly the leftover step eight's own header warns a
  // later reader will trust.
  db.prepare(
    `UPDATE browsers
        SET state = @state, signin_owner_pid = NULL, signin_deadline = NULL,
            signin_claim_id = NULL, updated_at = @now
      WHERE id = @id`,
  ).run({
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

/**
 * ════════════════════════════════════════════════════════════════════════
 * REQUESTING A SIGN-IN — the operation a caller can actually reach
 * ════════════════════════════════════════════════════════════════════════
 *
 * `SCHEMA.md` §5.5.2, `DECISIONS.md` §13j.
 *
 * ── The gap, stated as the measurement rather than as a feature ─────────
 *
 * The two operations above are complete, and **neither is reachable by an
 * agent**. `begin_sign_in` and `end_sign_in` are called by `broker login`,
 * which is a command a person types. Nothing on the tool surface moves a
 * browser into `signing-in`, so a caller that navigated to a page and got a
 * login form had two moves available: abandon the task, or fabricate a
 * session.
 *
 * §1.2 measured which one they took. **25 sessions in one month hand-seeded
 * authentication tokens into an isolated browser while the signed-in browser
 * sat unused.** That is usually read as a browser-choice failure and §13i
 * treats it as one — but a caller that chose correctly and still hit a login
 * wall was in exactly the same position, and that position had no exit that
 * involved asking. **This is the exit that involves asking.**
 *
 * ── Why this is not `begin_sign_in` with a different caller ─────────────
 *
 * It reuses the state machine and deliberately does not reuse the entry
 * point, because the two differ on the one refusal that makes
 * `begin_sign_in` a service operation at all.
 *
 * §5.5.1 step 1 refuses a sign-in **while any live lease holds a tab on that
 * browser**, and the reason is exact: *"somebody is about to drive the window
 * by hand, and doing that underneath a caller's work would corrupt it."*
 * **The requesting caller is such a lease.** It is holding the very tab
 * sitting on the login page — that is the point of the request, since the
 * person has to sign in where the work already is.
 *
 * So an agent calling `begin_sign_in` is refused by its own request, every
 * time, naming itself as the obstacle. The refusal is not wrong; it is
 * answering a question about a different situation.
 *
 * **The exemption is exactly one lease wide, and that is the design.** The
 * asking lease is skipped and every other live lease still refuses, because
 * the corruption §5.5.1 protects against is real for all of them and is not
 * real for the one whose work the sign-in is for. Expressing this as a flag
 * on the browser — *"this sign-in was requested, so skip the check"* — would
 * exempt all of them, which is why the asking lease's identifier goes into
 * the row (schema step ten) rather than a boolean.
 */

/**
 * How long a requested sign-in holds the browser before it lapses.
 *
 * ── Why there is a number here when §5.5.1 says there is not ────────────
 *
 * §5.5.1: *"A sign-in has no expiry — a person takes as long as they take,
 * and a timeout would end a sign-in that was going fine."* **That is right
 * for the command and wrong for the request**, and the difference is what is
 * on the other end.
 *
 * `broker login` is a person at a keyboard with a process blocked on them.
 * That process is the evidence somebody is still there, which is why step
 * eight can recover an abandoned sign-in by asking whether it is running.
 *
 * A requested sign-in has **no such process**. The service returns
 * immediately, and the request is relayed onward by the calling agent to a
 * person who may be away from the machine, may not read it for an hour, and
 * may never read it. Nothing on this host can be asked whether they are
 * coming. Left unbounded, one unanswered request holds the browser against
 * every other caller forever — the same unrecoverable state step eight was
 * written to remove, arriving through a door step eight cannot watch.
 *
 * **So the deadline is the evidence-substitute:** no process to interrogate,
 * so a number instead.
 *
 * ── Why fifteen minutes ─────────────────────────────────────────────────
 *
 * It is `BROKER_LEASE_SECONDS` (ten minutes) plus a margin, and the
 * relationship is the reason rather than the roundness. The requesting lease
 * survives the wait by being renewed — every keyed call extends it (§3.1) —
 * so the caller polls throughout. A deadline **shorter** than the lease
 * lifetime would let the sign-in lapse while the caller that asked for it was
 * still healthy and still waiting, which is the confusing failure: the agent
 * is told to keep waiting by its own live lease and told the request is gone
 * by the browser. A deadline longer than the lease gives the caller room to
 * notice its own expiry first, which is the failure it can explain.
 *
 * **What it is not:** a promise that a person answers within fifteen minutes,
 * and it is not tuned to human behaviour at all. It bounds how long an
 * *unanswered* request may cost every other caller, and the cost of getting
 * it wrong in the generous direction is a browser nobody can use. A person
 * who arrives late asks the agent to request again; nothing is lost but the
 * request.
 */
export const SIGN_IN_REQUEST_SECONDS = 900;

/**
 * How close to the deadline a caller is told to check back.
 *
 * The same shape `checkBackSeconds` gives a queued caller, and for the same
 * reason: *"a check made exactly at the deadline races the reclamation and
 * loses about half the time."*
 */
export const SIGN_IN_REQUEST_CHECK_BACK_SECONDS = 30;

/**
 * The bounds on what a caller says is being signed into.
 *
 * The same three-to-two-hundred bound `claims.purpose` carries (§1.3), and
 * deliberately the same numbers rather than new ones: it is the same kind of
 * field — a short human sentence a person reads to decide what to do — and a
 * second set of limits would be a second thing to remember for no gain.
 */
export const SIGN_IN_WHAT_MIN = 3;
export const SIGN_IN_WHAT_MAX = 200;

export interface RequestSignInInput {
  /** The asking lease's key. This operation is keyed, unlike the two above. */
  readonly key: string;
  /**
   * What is being signed into, in the caller's own words.
   *
   * **Required, and it is the whole of what makes the result relayable.**
   * The service never speaks to a person — the calling agent does — so the
   * result has to carry enough for that agent to say *which* login wall this
   * is. A request that said only "please sign in" would send a person to a
   * browser with no idea what they are signing into, and this is the one fact
   * the service cannot derive: the tab's address is known to the browser
   * rather than to the store, since §13f deleted the cached column precisely
   * because it *"cached something the browser knows"*.
   */
  readonly what: string;
  /**
   * A shorter deadline than the default, when the caller wants one.
   *
   * ── Bounded above, and the bound is the point ───────────────────────────
   *
   * **A caller may ask for less time and may never ask for more.** The
   * deadline exists to bound what an unanswered request costs *other* callers
   * (see {@link SIGN_IN_REQUEST_SECONDS}), and a bound a caller can raise is
   * not a bound — it is a default with extra steps, and the first caller to
   * pass a large number reinstates exactly the unrecoverable state this was
   * written to prevent.
   *
   * So a value above the ceiling is **clamped rather than refused**, which is
   * the one place this operation does not follow §6.3's *"refuse, never
   * silently default"*. The reasoning is that §6.3 is about **configuration**
   * — a value an operator set and would otherwise never learn was ignored —
   * and this is a per-call argument whose effective value is returned in
   * `requestSeconds` on the very same response. A caller that asks for an
   * hour is told it got fifteen minutes, in the field it reads to know when
   * to stop waiting, so nothing is silent.
   *
   * A non-positive or non-numeric value is treated as absent, which is what
   * a command line that cannot type its arguments will otherwise produce.
   */
  readonly requestSeconds?: number;
}

export interface RequestSignInResult {
  readonly browser: BrowserId;
  readonly state: 'signing-in';
  /** The lease that asked, unchanged and still holding its tab. */
  readonly claimId: string;
  /** The tab the person will sign in on — the one already open. */
  readonly tabId: string;
  /** Echoed back, because the calling agent relays this onward. */
  readonly what: string;
  /** When this request lapses if nobody answers it. */
  readonly deadline: string;
  readonly requestSeconds: number;
  /** The expiry of the asking lease **after** this call renewed it. */
  readonly leaseExpiresAt: string;
  /**
   * What the calling agent should say to the person, and what to do next.
   * Assembled here rather than by each surface, so both say it once.
   */
  readonly relay: string;
  readonly checkBackSeconds: number;
}

/**
 * What the calling agent says to the person, and what it does next.
 *
 * ── Why the service writes this sentence at all ─────────────────────────
 *
 * **The service never speaks to a person; the calling agent does.** This is
 * the only place in the design where that indirection matters, because
 * everywhere else the audience for a message is whoever made the call. Here
 * the message has to survive being read by an agent and repeated to a human
 * who has none of the context — so it names the browser, says what is being
 * signed into, says the tab is already open and waiting, and says the person
 * should confirm when they are done.
 *
 * Assembled here rather than at each surface for the reason
 * `SIGN_IN_OWNER_UNKNOWN_REMEDY` is: two spellings of one instruction is how
 * they come to disagree, and the disagreement is found by somebody who is
 * already stuck.
 *
 * **It is not a refusal message and is not worded like one.** §3.14 says
 * refusal sentences are worded per transport and never compared between them;
 * this is a *result* field, identical on every surface, and a caller relays
 * it rather than reading it.
 */
export function relaySentence(options: {
  readonly browser: BrowserId;
  readonly what: string;
  readonly requestSeconds: number;
}): string {
  const minutes = Math.round(options.requestSeconds / 60);
  return (
    `Tell the person: the ${options.browser} browser has a tab open on the sign-in page for ${options.what} — ` +
    `please sign in there, then say when you are done. The tab is already on the page, so nothing needs opening. ` +
    `While you wait, keep calling browser_status to hold your lease; your lease and your tab are untouched by the sign-in. ` +
    `Call browser_sign_in_done once they confirm. If nobody answers within about ${String(minutes)} minutes the request lapses ` +
    `and the browser serves other callers again — ask again if that happens.`
  );
}

/**
 * Ask a person to sign in, on the tab this lease already holds.
 *
 * **Keyed, unlike the two operations above**, and that is what makes the
 * exemption expressible: the key resolves to exactly one lease, so the
 * operation knows which lease is asking and can protect every other one.
 */
export function decideRequestSignIn(
  scope: ArbitrationScope,
  input: RequestSignInInput,
): ArbitrationOutcome<RequestSignInResult> {
  const { db, adapter, swept } = scope;

  // The lease first, and the renewal with it. **Before any other check**, for
  // the reason `claim.ts` gives about the position of its own refusals: a
  // caller whose key is wrong should hear about the key, not about a browser
  // it was never going to be allowed to touch. Renewing first also means a
  // caller refused for any reason below still had its lease extended by the
  // call — §3.1's rule that there is no keyed call that does not extend, and
  // the rule that keeps a caller from expiring while being told why it cannot
  // have something.
  const lease = resolveLease(db, input.key, {
    adapter,
    kind: 'claim_renewed',
    recordRefusal: scope.recordRefusal,
  });
  const leaseExpiresAt = extendLease(db, lease, { adapter, now: swept.sweptAt });

  // The sentence a person will read, bounded exactly as a purpose is (§1.3).
  // Checked here rather than left to a column, because **there is no column**:
  // a request is not a row, so nothing downstream would refuse an empty one
  // and a person would be handed a window with no idea what it is for.
  const what = typeof input.what === 'string' ? input.what.trim() : '';
  if (what.length < SIGN_IN_WHAT_MIN || what.length > SIGN_IN_WHAT_MAX) {
    scope.recordRefusal({
      kind: 'browser_signin_began',
      outcome: 'deny',
      guard: SIGN_IN_RULES.whatBounded,
      adapter,
      sessionId: lease.sessionId,
      browserId: lease.browserId,
      detail: { length: what.length },
    });
    throw new CallRefusal(
      'sign_in_what_out_of_bounds',
      `A sign-in request says what is being signed into, ${String(SIGN_IN_WHAT_MIN)} to ${String(SIGN_IN_WHAT_MAX)} characters — it is relayed to a person verbatim and is the only thing telling them which sign-in wall this is. Name the site or the account rather than the task: "the account dashboard" rather than "step three".`,
      { detail: { length: what.length } },
    );
  }

  // A queued lease has never had a tab (§1.3), so it has no page to be stuck
  // on. Refused rather than allowed to move a browser it is not yet using.
  //
  // ── This check is redundant in this build, and is kept anyway ──────────
  //
  // **Measured rather than assumed**, by deleting it and watching the suite
  // stay green: a queued lease reaches the tab lookup below, finds nothing
  // open, and is refused there — under the same rule, with a different code.
  // So no reachable state separates the two, and a mutation removing this
  // branch survives.
  //
  // It is kept for the reason `decideBeginSignIn`'s holder query gives about
  // its own surviving condition: **the redundancy is a property of this build
  // rather than of the design.** The two refusals answer different questions —
  // *you are not holding anything yet* against *the thing you were holding is
  // gone* — and they send a caller to different next actions: wait for the
  // queue, or replace a wedged tab. Collapsing them because they presently
  // coincide would give a queued caller advice about a tab it never had.
  //
  // Written down rather than left as a surviving mutation somebody
  // rediscovers: the branch is deliberate, it is not independently covered,
  // and the reason it is not covered is that the product cannot produce a
  // state that separates it from the one below.
  if (lease.state !== 'active') {
    scope.recordRefusal({
      kind: 'browser_signin_began',
      outcome: 'deny',
      guard: SIGN_IN_RULES.requesterHoldsTab,
      adapter,
      sessionId: lease.sessionId,
      browserId: lease.browserId,
      detail: { state: lease.state },
    });
    throw new CallRefusal(
      'browser_unavailable',
      'That lease is queued rather than active, so it holds no tab and there is no page for anybody to sign in on. Poll browser_status until it turns active, open the page that wants a sign-in, and ask then.',
      { detail: { state: lease.state } },
    );
  }

  const browser = resolveSignableBrowser(scope, lease.browserId);
  const row = readBrowser(scope, browser);

  // The tab this lease holds. **Read rather than taken from the caller**, for
  // the reason `bridge.ts` gives about `tabForKey`: a lease is one tab (§2.3),
  // so the tab is a fact about the lease, and a caller naming one could only
  // ever be naming a different one.
  const tab = db
    .prepare<{ claimId: string }, { tabId: string }>(
      `SELECT id AS tabId FROM tabs
        WHERE claim_id = @claimId AND state IN ('opening', 'open')
        ORDER BY id LIMIT 1`,
    )
    .get({ claimId: lease.claimId });

  if (tab === undefined) {
    // Active with no open tab. The note on `decideBeginSignIn`'s holder query
    // records that this pair does not come apart on any path this build can
    // reach — so this is the honest refusal for a state that should not occur,
    // rather than a branch with a scenario behind it, and it refuses rather
    // than handing a person a window with no page in it.
    scope.recordRefusal({
      kind: 'browser_signin_began',
      outcome: 'deny',
      guard: SIGN_IN_RULES.requesterHoldsTab,
      adapter,
      sessionId: lease.sessionId,
      browserId: browser,
      detail: { claimId: lease.claimId, state: lease.state },
    });
    throw new CallRefusal(
      'tab_not_found',
      'That lease is active but holds no open tab, so there is no page to sign in on. Call browser_tab_replace to take a fresh one, open the page that wants a sign-in, and ask again.',
      { detail: { claimId: lease.claimId } },
    );
  }

  // ── Already signing in ────────────────────────────────────────────────
  //
  // Refused, and **not reclaimed here even when the deadline has passed**.
  // The lapse is the sweep's job, and the sweep has already run by the time
  // this handler executes — so a browser still reading `signing-in` here is
  // one whose sign-in is genuinely live, and reclaiming it would take a
  // window out from under whoever has it.
  if (row.state === 'signing-in') {
    scope.recordRefusal({
      kind: 'browser_signin_began',
      outcome: 'deny',
      guard: SIGN_IN_RULES.serving,
      adapter,
      sessionId: lease.sessionId,
      browserId: browser,
      detail: { state: row.state, requestedBy: row.signin_claim_id },
    });
    throw new CallRefusal(
      'browser_unavailable',
      row.signin_claim_id === lease.claimId
        ? `You have already asked for a sign-in on the ${browser} browser and it is still open. Keep calling browser_status to hold your lease, and tell the person the tab is waiting for them — asking twice does not reach them twice.`
        : `The ${browser} browser is already being signed into, so a second person cannot be handed the same window. This is a pause rather than a fault: it serves again as soon as they are finished. Keep calling browser_status to hold your lease, and ask again once it is serving.`,
      { detail: { browser, state: row.state } },
    );
  }

  // ── §5.5.1 step 1, with the requester exempted ────────────────────────
  //
  // **The same query as `decideBeginSignIn`'s, minus this one lease.** It is
  // written out rather than shared with that function, and the duplication is
  // deliberate: the two ask different questions, and a shared helper taking
  // an "except this one" argument would make the exemption look like a
  // parameter of the original rule rather than a second rule. The original
  // must keep refusing every live lease without exception, because a person
  // typing `broker login` holds no lease and is exempt from nothing.
  const holders = db
    .prepare<{ browserId: string; claimId: string }, HoldingLease>(
      `SELECT c.id AS claimId, c.session_id AS sessionId, c.purpose AS purpose,
              c.expires_at AS expiresAt
         FROM claims c
         JOIN tabs t ON t.claim_id = c.id
        WHERE c.browser_id = @browserId
          AND c.state = 'active'
          AND t.state IN ('opening', 'open')
          AND c.id != @claimId
        ORDER BY c.id`,
    )
    .all({ browserId: browser, claimId: lease.claimId });

  if (holders.length > 0) {
    scope.recordRefusal({
      kind: 'browser_signin_began',
      outcome: 'deny',
      guard: SIGN_IN_RULES.busyForLogin,
      adapter,
      sessionId: lease.sessionId,
      browserId: browser,
      // The same detail shape `decideBeginSignIn` records, and deliberately
      // never the keys (§5.6).
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
      `The ${browser} browser has ${String(holders.length)} other live lease(s) holding a tab, so a person cannot be handed the window yet: driving it by hand underneath somebody else's work would corrupt it. Your own lease is not the obstacle and is untouched. Waiting is enough — every lease expires on its own if its holder stops calling in. Holding: ${described}`,
      { detail: { browser, holders: [...holders] } },
    );
  }

  // ── The request is granted ────────────────────────────────────────────
  //
  // The state moves and **nothing about the asking lease moves with it**. No
  // claim row is touched beyond the renewal above, no tab is closed, no
  // capacity is returned. That is §5.5.1's *"a sign-in is a pause and not a
  // cancellation"* extended to the requester — the property most likely to be
  // got wrong here, because a caller that lost its work by asking for help is
  // a caller that never asks again.
  // Clamped, never widened. See {@link RequestSignInInput.requestSeconds} for
  // why this is a clamp rather than a refusal, and why the ceiling is not a
  // caller's to move.
  const asked = input.requestSeconds;
  const requestSeconds =
    typeof asked === 'number' && Number.isFinite(asked) && asked > 0
      ? Math.min(Math.floor(asked), SIGN_IN_REQUEST_SECONDS)
      : SIGN_IN_REQUEST_SECONDS;

  const deadlineRow = db
    .prepare<{ id: string; now: string; claimId: string; extend: string }, { deadline: string }>(
      `UPDATE browsers
          SET state = 'signing-in',
              signin_owner_pid = NULL,
              signin_deadline = strftime('%Y-%m-%dT%H:%M:%fZ', @now, @extend),
              signin_claim_id = @claimId,
              updated_at = @now
        WHERE id = @id
    RETURNING signin_deadline AS deadline`,
    )
    .get({
      id: browser,
      now: swept.sweptAt,
      claimId: lease.claimId,
      // Assembled from a number this build owns, never from caller text.
      extend: `+${String(requestSeconds)} seconds`,
    }) as { deadline: string };

  append(db, {
    kind: 'browser_signin_began',
    outcome: 'allow',
    adapter,
    sessionId: lease.sessionId,
    browserId: browser,
    // **Which lease asked and when it lapses, and nothing a person typed.**
    // `what` is deliberately absent: it is free text from a caller, it is
    // relayed to a person rather than acted on, and step six's header is
    // explicit that this row is built by hand and that a well-meaning
    // addition is how it stops being true.
    detail: {
      requested: true,
      claimId: lease.claimId,
      deadline: deadlineRow.deadline,
      previousState: row.state,
      browserWasRunning: row.pid !== null,
    },
  });

  return {
    value: {
      browser,
      state: 'signing-in',
      claimId: lease.claimId,
      tabId: tab.tabId,
      what,
      deadline: deadlineRow.deadline,
      requestSeconds,
      leaseExpiresAt,
      checkBackSeconds: SIGN_IN_REQUEST_CHECK_BACK_SECONDS,
      relay: relaySentence({ browser, what, requestSeconds }),
    },
  };
}

export interface FinishSignInInput {
  /** The asking lease's key. Only the lease that asked may finish it. */
  readonly key: string;
}

export interface FinishSignInResult {
  readonly browser: BrowserId;
  /** Back to serving. `stopped` when no browser was running to return to. */
  readonly state: 'running' | 'stopped';
  readonly claimId: string;
  /** The tab the lease still holds — the same one it held throughout. */
  readonly tabId: string;
  readonly leaseExpiresAt: string;
  readonly queueDepth: number;
}

/**
 * The person is done — give the browser back, keeping the lease.
 *
 * ── Why this is not `end_sign_in` ───────────────────────────────────────
 *
 * `end_sign_in` takes a browser name and no key, because the thing calling it
 * is a command a person ran and there is no lease in the picture. Exposing
 * *that* on the tool surface would hand every caller a verb that ends
 * **somebody else's** sign-in by naming a browser — including a person's
 * `broker login`, mid-password.
 *
 * So the caller-facing half is keyed, and the key must be the one that asked.
 * **This is the same reasoning §3.13 gives for there being no browser-scoped
 * destructive verb on the surface**: the worst thing an agent can do through
 * this surface is give back something it asked for itself.
 */
export function decideFinishSignIn(
  scope: ArbitrationScope,
  input: FinishSignInInput,
): ArbitrationOutcome<FinishSignInResult> {
  const { db, adapter, swept } = scope;

  const lease = resolveLease(db, input.key, {
    adapter,
    kind: 'claim_renewed',
    recordRefusal: scope.recordRefusal,
  });
  const leaseExpiresAt = extendLease(db, lease, { adapter, now: swept.sweptAt });

  const browser = resolveSignableBrowser(scope, lease.browserId);
  const row = readBrowser(scope, browser);

  if (row.state !== 'signing-in') {
    scope.recordRefusal({
      kind: 'browser_signin_ended',
      outcome: 'deny',
      guard: SIGN_IN_RULES.serving,
      adapter,
      sessionId: lease.sessionId,
      browserId: browser,
      detail: { state: row.state },
    });
    throw new CallRefusal(
      'browser_unavailable',
      `The ${browser} browser is not being signed into — it is ${row.state}. Your request may have lapsed while nobody answered it, in which case the browser is already serving and your lease and tab are untouched: look at the page, and ask again if it is still showing a sign-in wall.`,
      { detail: { browser, state: row.state } },
    );
  }

  // **Only the lease that asked may finish it**, which is the whole reason
  // this operation is keyed. A different lease calling this would be ending a
  // sign-in it did not ask for — and a sign-in begun by `broker login` records
  // no claim at all, so no lease can end one and a person's command keeps the
  // window until they close it.
  if (row.signin_claim_id !== lease.claimId) {
    scope.recordRefusal({
      kind: 'browser_signin_ended',
      outcome: 'deny',
      guard: SIGN_IN_RULES.finishOwned,
      adapter,
      sessionId: lease.sessionId,
      browserId: browser,
      detail: { requestedBy: row.signin_claim_id, asking: lease.claimId },
    });
    throw new CallRefusal(
      'browser_unavailable',
      row.signin_claim_id === null
        ? `The ${browser} browser is being signed into by a person who ran the sign-in command directly, so there is no request of yours to finish — and ending theirs from here would take the window out from under them mid-password. Keep calling browser_status to hold your lease; it serves again when they close it.`
        : `The ${browser} browser is being signed into at another lease's request, so it is not yours to finish. Keep calling browser_status to hold your lease, and try your page again once it is serving.`,
      { detail: { browser } },
    );
  }

  const tab = db
    .prepare<{ claimId: string }, { tabId: string }>(
      `SELECT id AS tabId FROM tabs
        WHERE claim_id = @claimId AND state IN ('opening', 'open')
        ORDER BY id LIMIT 1`,
    )
    .get({ claimId: lease.claimId });

  // Back to what the pid says it is, exactly as `decideEndSignIn` does and for
  // the same constraint: `stopped` requires a null pid and every other state
  // requires one.
  const state: 'running' | 'stopped' = row.pid === null ? 'stopped' : 'running';

  // **All three sign-in columns cleared together.** A browser that is not
  // signing in has no owner, no deadline and no asking lease, and a stale
  // value in any of them is a leftover a later reader trusts.
  db.prepare(
    `UPDATE browsers
        SET state = @state, signin_owner_pid = NULL, signin_deadline = NULL,
            signin_claim_id = NULL, updated_at = @now
      WHERE id = @id`,
  ).run({ id: browser, state, now: swept.sweptAt });

  const queued = db
    .prepare<[], { depth: number }>(`SELECT COUNT(*) AS depth FROM claims WHERE state = 'queued'`)
    .get() as { depth: number };

  append(db, {
    kind: 'browser_signin_ended',
    outcome: 'allow',
    adapter,
    sessionId: lease.sessionId,
    browserId: browser,
    detail: { state, queueDepth: queued.depth, claimId: lease.claimId, confirmed: true },
  });

  return {
    value: {
      browser,
      state,
      claimId: lease.claimId,
      tabId: tab?.tabId ?? '',
      leaseExpiresAt,
      queueDepth: queued.depth,
    },
  };
}
