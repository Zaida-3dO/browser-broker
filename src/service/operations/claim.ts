import { randomUUID } from 'node:crypto';

import { BROWSER_CHOICE_GUIDANCE, type BrowserId } from '../../browser/driver.ts';
import { admits, countActiveClaims } from '../capacity.ts';
import { append } from '../events.ts';
import { hashKey, mintKey } from '../keys.ts';
import { nudgeIfOwnObstacle, type OwnObstacleNudge } from '../nudge.ts';
import { queuePosition, waitEstimateSeconds } from '../queue.ts';
import { CallRefusal } from '../refusals.ts';
import {
  StorageSeedRefusal,
  seedRecord,
  validateStorageSeed,
  type StorageSeedEntry,
} from '../storage-seed.ts';
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

/**
 * The purpose bound (§1.3), stated here because this is where it is enforced.
 *
 * **The same two numbers as `claims.purpose`'s `CHECK`**, and they have to
 * stay the same two: the guard's job is to make sure no caller ever reaches
 * that constraint, which it can only do if it refuses exactly what the column
 * would have refused. A guard with a *wider* bound would let a caller back
 * through to the crash it exists to prevent; a narrower one would refuse
 * purposes the store would have accepted.
 *
 * They are not imported from the schema module because the schema is SQL text
 * — there is nothing there to import — and duplicating the pair with the
 * reason stated is honest, where deriving one from a parse of the other would
 * be fragile in the direction that fails silently. A test pins them against
 * the live column instead (`tests/operations/claim-purpose.test.ts`), so the
 * two moving apart is a failing test rather than a returning crash.
 */
export const PURPOSE_MINIMUM = 3;
/** @see PURPOSE_MINIMUM */
export const PURPOSE_MAXIMUM = 200;

/**
 * The session-identity bound (§1.3), enforced here for the same reason the
 * purpose bound above is — and with one difference that makes it worse.
 *
 * **`claims.session_id` is `TEXT NOT NULL` with no `CHECK` at all.** The
 * purpose had a column constraint standing behind it, so the missing guard
 * showed itself as a crash: ugly, but loud, and fixed within a day of being
 * seen. An empty session identity satisfies `NOT NULL`, so there was nothing
 * behind it to fail — **the lease was granted, and the defect was silent.**
 *
 * ── Why an anonymous lease is not a cosmetic problem ────────────────────
 *
 * §1.3 makes `session_id` the attribution key, and §1.6 puts it on **every
 * refusal row** precisely so a denied request is not anonymous. An empty one
 * defeats both: the ledger records a grant and a denial with nothing saying
 * who. Worse, the you-are-your-own-obstacle nudge (§2.3a) selects live claims
 * by `session_id = @sessionId`, so **every anonymous caller matches every
 * other anonymous caller** — the nudge would list one caller's leases to a
 * different caller and advise it to release them.
 *
 * ── The bound, and why there is no maximum ──────────────────────────────
 *
 * A minimum of one: the identifier is opaque to this service (§1.3 calls it
 * "a key another system owns"), so its *content* is not this service's to
 * judge. What is judgeable is whether one arrived at all, which is the whole
 * defect. No maximum is imposed because the column imposes none, and a guard
 * that refused what the store would have accepted would be inventing a rule
 * rather than enforcing one — the mirror of the reasoning that keeps
 * {@link PURPOSE_MAXIMUM} pinned to its column's `CHECK`.
 */
export const SESSION_ID_MINIMUM = 1;

/**
 * How the refusal describes a missing session identity.
 *
 * Two cases rather than one, for the reason {@link describePurpose} gives:
 * "was not supplied" and "is blank" are the same mistake from the caller's
 * side, but a value that is present and of the wrong *type* is a different
 * one, and telling them apart is what stops a caller re-sending the same
 * malformed argument.
 */
function describeSessionId(sessionId: unknown): string {
  if (typeof sessionId !== 'string') {
    return sessionId === undefined
      ? 'was not supplied'
      : `arrived as ${typeof sessionId} rather than as text`;
  }
  return 'is empty';
}

/**
 * How the refusal describes what was wrong, in the caller's own terms.
 *
 * Three sentences rather than one, because "missing", "too short" and "too
 * long" are three different mistakes with three different fixes, and a single
 * "invalid purpose" would make the caller work out which it made.
 */
function describePurpose(purpose: unknown): string {
  if (typeof purpose !== 'string' || purpose.length === 0) {
    // Covers both the argument that was never supplied and the empty string a
    // surface produces from a missing one — indistinguishable by the time
    // they arrive here, and the same mistake from the caller's side.
    return 'is missing';
  }
  if (purpose.length < PURPOSE_MINIMUM) {
    return `is ${String(purpose.length)} character${purpose.length === 1 ? '' : 's'} long`;
  }
  return `is ${String(purpose.length)} characters long`;
}

/** What a caller supplies to ask for a lease. */
export interface ClaimInput {
  /** The caller's identity (§1.3). **Not a limit** — a session may hold many leases. */
  readonly sessionId: string;
  /**
   * Which browser, **optional** (§3.2, `DECISIONS.md` §13i).
   *
   * Unstated resolves to the first signed-in browser; `regular` or `private`
   * resolves to the first of that kind; a configured name resolves to that
   * browser exactly.
   */
  readonly browser?: string;
  /** What this lease is for, in human words. What an operator reads when revoking. */
  readonly purpose: string;
  /**
   * Optional storage entries written into their origins **before the tab's
   * first navigation** (§3.2, row #65).
   *
   * `unknown` rather than the validated type, deliberately: it arrives from a
   * caller across a surface, and declaring it already-validated here would
   * make {@link validateStorageSeed} something a surface could skip by
   * constructing the object itself.
   */
  readonly storageSeed?: unknown;
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
  /**
   * What the service must write into the tab **before its first navigation**,
   * and the reason this is returned rather than done here: writing storage is
   * browser work, and browser work never happens inside the arbitration
   * transaction (§2.4b). The entries are validated, so what is handed back is
   * the shape the driver seam declares.
   *
   * Empty on a lease that seeded nothing, which is the ordinary case.
   */
  readonly storageSeed: readonly StorageSeedEntry[];
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
  /**
   * The configured persistent, signed-in browsers, in configured order
   * (§1.2). Never empty.
   *
   * **The first is what an unstated `browser` resolves to** (§3.2).
   */
  readonly regularBrowsers: readonly string[];
  /** The configured ephemeral, clean-room browsers, in configured order (§1.2). */
  readonly privateBrowsers: readonly string[];
}

/**
 * What a caller asked for, turned into the browser it gets (§3.2).
 *
 * **Three forms, and a name is checked last rather than first.** The two kind
 * words are the ones the default configuration also uses as names, so an
 * installation that has renamed nothing resolves `regular` by kind and lands
 * on the browser called `regular` either way — the orders agree. Where they
 * would disagree is an installation whose signed-in list does not contain a
 * browser named `regular`, and there the kind reading is the one that keeps
 * working, which is why it wins.
 *
 * That ordering has a consequence worth stating rather than discovering: a
 * browser **named** `regular` sitting in the *private* list would be
 * unreachable by name. It cannot arise, because a name in both lists is
 * refused at startup and `regular` in the private list still resolves as a
 * kind — but the reason it cannot arise is the startup refusal, not this
 * function.
 *
 * Returns `undefined` for a name no configured browser has, which the caller
 * turns into the refusal; this function does not refuse, so that the ledger
 * write and the refusal text stay in one place.
 */
export function resolveBrowser(
  requested: string | undefined,
  settings: ArbitrationSettings,
): string | undefined {
  // Nothing stated: the first signed-in browser. **Not a guess between two
  // symmetric wrongs** (`DECISIONS.md` §13i) — defaulting to clean-room when
  // a sign-in was wanted returns a login redirect, a wrong page that looks
  // like a right one; defaulting to signed-in when clean-room was wanted
  // returns a personalised page, which is the page most callers asked for.
  if (requested === undefined) {
    return settings.regularBrowsers[0];
  }

  if (requested === 'regular') {
    return settings.regularBrowsers[0];
  }
  if (requested === 'private') {
    return settings.privateBrowsers[0];
  }

  if (
    settings.regularBrowsers.includes(requested) ||
    settings.privateBrowsers.includes(requested)
  ) {
    return requested;
  }

  return undefined;
}

/** Every configured browser, both kinds, for a refusal that lists them. */
export function configuredBrowsers(settings: ArbitrationSettings): readonly string[] {
  return [...settings.regularBrowsers, ...settings.privateBrowsers];
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

  // **The session identity, checked here rather than by the column** (§7.1
  // `claim.session_bounded`).
  //
  // ── Why this is first, ahead of even the browser check ────────────────
  //
  // Every refusal below records `sessionId: input.sessionId` on the ledger
  // row, because §1.6 exists so that a denied request is attributable. If the
  // identity is the thing that is missing, those rows are anonymous — so the
  // ordering that puts this first is not a preference, it is what makes every
  // *other* refusal on this operation carry a caller. The purpose guard sits
  // after the browser guard because a caller that named a browser that does
  // not exist should hear about the name first; nothing outranks knowing who
  // is asking.
  //
  // ── What the store would have done, which is the point ────────────────
  //
  // Accepted it. `claims.session_id` is `TEXT NOT NULL` with no `CHECK`, and
  // `''` satisfies `NOT NULL` — so unlike the purpose, there is no backstop
  // here and never was. Before this guard, `broker claim` with no
  // `--session-id` returned a granted lease with a real key and a real tab,
  // and wrote `session_id = ''` to the claims row and to all three of its
  // ledger events. Nothing failed, which is why it lasted.
  //
  // Refused **before the first insert and before the arrival counter is
  // allocated**, so a refused caller is not charged capacity, holds no key,
  // and has nothing to release — the position every other argument refusal
  // on this operation takes, for that same reason.
  if (typeof input.sessionId !== 'string' || input.sessionId.length < SESSION_ID_MINIMUM) {
    scope.recordRefusal({
      kind: 'claim_requested',
      outcome: 'deny',
      guard: 'claim.session_bounded',
      adapter,
      // Deliberately **not** `sessionId: input.sessionId`. Every other
      // refusal here attaches the caller; this is the one call where doing so
      // would write the empty string this guard exists to keep out, turning
      // the record of the defect into an instance of it. The column is
      // nullable on `events` (§1.6), so absent is expressible and honest.
      detail: {
        supplied: typeof input.sessionId === 'string' ? input.sessionId.length : null,
        minimum: SESSION_ID_MINIMUM,
      },
    });
    throw new CallRefusal(
      'session_id_missing',
      // Names the argument, says what is wrong with it, and says what it is
      // *for* — a caller that thinks this is a formality supplies a constant
      // and defeats the attribution just as thoroughly as omitting it.
      `A claim carries the identity of the session asking for it, and this one ${describeSessionId(input.sessionId)}. Pass a stable identifier for your session: it is what attributes this lease and every refusal on it in the ledger, and it is how the service can tell you when you are waiting on capacity you are already holding.`,
      {
        detail: {
          supplied: typeof input.sessionId === 'string' ? input.sessionId.length : null,
          minimum: SESSION_ID_MINIMUM,
        },
      },
    );
  }

  // **Resolved rather than merely checked** (§3.2, `DECISIONS.md` §13i).
  // Nothing stated resolves to the first signed-in browser, a kind word to
  // the first of that kind, and a name to that browser exactly.
  const resolvedBrowser = resolveBrowser(input.browser, settings);
  if (resolvedBrowser === undefined) {
    const known = configuredBrowsers(settings);
    scope.recordRefusal({
      kind: 'claim_requested',
      outcome: 'deny',
      guard: 'claim.browser_known',
      adapter,
      sessionId: input.sessionId,
      detail: { requested: input.browser, known },
    });
    // **The refusal carries the choice guidance** (§3.2, row #66): a caller
    // re-reading a refusal is a caller re-making this decision, and telling
    // it only which names exist leaves it to guess which one it wanted.
    throw new CallRefusal(
      'unknown_browser',
      `There is no browser named ${JSON.stringify(input.browser)}. This service has ${known.join(', ')}. ${BROWSER_CHOICE_GUIDANCE}`,
      { detail: { requested: input.browser, known } },
    );
  }

  // **The purpose, checked here rather than by the column** (§7.1
  // `claim.purpose_bounded`).
  //
  // ── Why this guard exists, given the column already had a CHECK ────────
  //
  // Because a `CHECK` is not a refusal. Before this guard the bound was
  // enforced only by `claims.purpose`'s own
  // `CHECK (length(purpose) BETWEEN 3 AND 200)`, which fires *after* the
  // insert is handed to the store — so the command line died with an
  // unhandled `SqliteError` and exit 1, and the tool surface answered
  // `unexpected_failure` with the constraint text in it. A caller was told
  // the name of a database constraint rather than the name of the argument
  // it got wrong, on the first command anybody runs.
  //
  // The column keeps its CHECK, and that is deliberate: it is the backstop
  // for a writer that is not this function. What changes is that no caller
  // reaches it any more, because the argument is refused before a statement
  // is built.
  //
  // ── The position ──────────────────────────────────────────────────────
  //
  // **Before the first insert and before the arrival counter is allocated**,
  // for the reason the seed check below gives: a refused caller is not
  // charged capacity, holds no key, and has nothing to release. It sits
  // *after* the browser check because a caller that named a browser that does
  // not exist should hear about the name first — the same ordering, and the
  // same reasoning, that puts the sign-in check after both.
  //
  // Length is counted in UTF-16 code units, which is what SQLite's `length()`
  // counts over a `TEXT` value and therefore what the column would have
  // measured. Counting anything else here would refuse strings the store
  // would have taken, or take strings it would have refused.
  if (
    typeof input.purpose !== 'string' ||
    input.purpose.length < PURPOSE_MINIMUM ||
    input.purpose.length > PURPOSE_MAXIMUM
  ) {
    scope.recordRefusal({
      kind: 'claim_requested',
      outcome: 'deny',
      guard: 'claim.purpose_bounded',
      adapter,
      sessionId: input.sessionId,
      // The length and the bounds, and **never the purpose itself** — the
      // same discipline the seed refusal keeps, for the same reason: a
      // refusal's detail is read by whoever reads the ledger.
      detail: {
        length: typeof input.purpose === 'string' ? input.purpose.length : null,
        minimum: PURPOSE_MINIMUM,
        maximum: PURPOSE_MAXIMUM,
      },
    });
    throw new CallRefusal(
      'purpose_out_of_bounds',
      // Names the argument and what is wrong with it, and says what the
      // purpose is *for* — an operator deciding whether to revoke this lease
      // reads it, so "one line about the work" is the guidance that produces
      // a useful one rather than three filler characters.
      `A claim carries a purpose of ${String(PURPOSE_MINIMUM)} to ${String(PURPOSE_MAXIMUM)} characters, and this one ${describePurpose(input.purpose)}. Say what the lease is for in one line — it is what an operator reads when deciding whether to revoke it, so name the work rather than the tool.`,
      {
        detail: {
          length: typeof input.purpose === 'string' ? input.purpose.length : null,
          minimum: PURPOSE_MINIMUM,
          maximum: PURPOSE_MAXIMUM,
        },
      },
    );
  }

  // Validated **before the first insert**, so a refused seed leaves no lease
  // behind: the caller is not charged capacity for it, holds no key, and has
  // nothing to release. This is the position the unknown-browser refusal
  // occupies, and it is here for the same reason (§2.2) — nothing about
  // waiting makes a malformed argument valid.
  //
  // The fifth refusal §3.2 lists — **any entry on a lease that is not the
  // caller's** — needs no check here and could not be written as one: the
  // seed is an argument on the claim, so it applies once, to the tab that
  // claim grants. There is no parameter naming another lease, so there is no
  // path to seeding somebody else's. That is structural, and it is stated
  // rather than implemented because implementing it would mean inventing the
  // parameter first.
  //
  // **The refusal is recorded through `recordRefusal`, not `append`**, for
  // the reason that scope explains at length: a refusal throws, the throw
  // rolls the transaction back, and an ordinary append goes with it — leaving
  // a ledger of grants that can never show a guard firing. §1.6 requires
  // every decision, allowed and refused alike.
  let storageSeed: readonly StorageSeedEntry[];
  try {
    storageSeed = validateStorageSeed(input.storageSeed);
  } catch (error) {
    if (error instanceof StorageSeedRefusal) {
      scope.recordRefusal({
        kind: 'claim_requested',
        outcome: 'deny',
        guard: error.rule,
        adapter,
        sessionId: input.sessionId,
        // The refusal's own detail, which carries counts, byte sizes, the
        // scheme and the area — **and never a value**, because nothing in
        // this module ever puts one in a refusal's detail.
        detail: { ...error.detail },
      });
    }
    throw error;
  }

  const browserId = resolvedBrowser;

  // **The row for a configured browser is created here, on the way to its
  // first launch** (§1.2, `DECISIONS.md` §13i).
  //
  // ── Why a row has to exist before the insert below ────────────────────
  //
  // `claims.browser_id` is `REFERENCES browsers (id)`, and `tabs` carries a
  // composite key back to `(claims.id, claims.browser_id)`. Those constraints
  // are what keep a claim pointing at a browser this service actually
  // manages, and they are worth keeping. Without a row, a claim on a
  // configured browser fails as a foreign-key violation — a database error
  // naming neither the browser nor the argument, which is precisely the
  // shape of failure the `claim.browser_known` guard above exists to replace.
  //
  // ── Why this is not seeding from configuration ────────────────────────
  //
  // §13i rules that rows are created **on first launch of a named browser,
  // not from configuration at startup**, so that two processes holding
  // different lists only ever create rows for browsers somebody actually
  // asked for. This is that rule, at the moment it applies: a claim is what
  // causes a launch — §2.4b puts the launch after the commit — so a granted
  // claim is the first point at which a browser is genuinely going to be
  // started. **No row is created for a browser merely because configuration
  // names it**, and the resolution above has already refused any name the
  // configured lists do not carry, so nothing here can mint a row for a
  // browser nobody configured.
  //
  // ── Why the race needs nothing new ────────────────────────────────────
  //
  // §1.2a already arbitrates the launch race through this same transaction —
  // *"one row, one winner"*. Two processes claiming the same new browser at
  // once are serialised here like every other writer, and `OR IGNORE` makes
  // the loser's insert a no-op rather than an error: the row it wanted
  // exists, which is the outcome it was asking for.
  //
  // The kind is written from the list the name was found in, which is the
  // only place it is known — the name itself carries no kind once names are
  // configured, which is why the column exists (schema step nine).
  db.prepare<{ id: string; kind: string }>(
    "INSERT OR IGNORE INTO browsers (id, kind, state) VALUES (@id, @kind, 'stopped')",
  ).run({
    id: browserId,
    kind: settings.privateBrowsers.includes(browserId) ? 'private' : 'regular',
  });

  // **A browser being signed into is not available, and this is what makes
  // that state mean anything** (§5.5.1 step 2: "From that moment, requests
  // for it are refused with a retry hint").
  //
  // ── Why refused here, and why refused rather than queued ──────────────
  //
  // The position is load-bearing in both directions. It is **after** the
  // argument checks, because nothing about a sign-in makes a malformed
  // request valid — a caller naming a browser that does not exist should hear
  // about the name, not about somebody's sign-in. It is **before** the
  // admission arithmetic and before any row is written, so a refused caller
  // is not charged capacity, holds no key, and has nothing to release: the
  // same position, and the same reason, as the two refusals above it.
  //
  // Refused rather than queued because §2.2 draws that line by what the queue
  // promises: **the queue's promise is that capacity frees up**, and a browser
  // handed to a person is not a capacity shortage. Queuing here would give a
  // caller a place in a line whose length says nothing about how long a human
  // takes to type a password. So it is `retryable`, with the hint on the
  // sentence, and the caller decides when to come back.
  //
  // **Queued callers already waiting are untouched** — this reads the browser
  // row and writes nothing, so §5.5.1's "queued callers keep their places and
  // their timers" holds by there being no code here that could take one.
  const browserState = db
    .prepare<{ id: string }, { state: string }>('SELECT state FROM browsers WHERE id = @id')
    .get({ id: browserId });

  if (browserState?.state === 'signing-in') {
    scope.recordRefusal({
      kind: 'claim_requested',
      outcome: 'deny',
      guard: 'browser.serving',
      adapter,
      sessionId: input.sessionId,
      detail: { browser: browserId, state: browserState.state },
    });
    throw new CallRefusal(
      'browser_unavailable',
      `The ${browserId} browser is being signed into by a person right now, so it is not serving callers. This is a pause rather than a fault: it will serve again as soon as they are finished, and a place in the queue would not help because nothing here is waiting on capacity. Try again shortly.`,
      { detail: { browser: browserId, state: browserState.state } },
    );
  }

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
    ? grant({ scope, input, settings, claimId, key, browserId, now, storageSeed })
    : // A queued lease has no tab, so there is nothing to seed into and the
      // entries are deliberately dropped rather than held. §2.5 is why: a
      // place that is promoted is promoted by a **fresh** call carrying the
      // key, and holding a caller's credential across an unbounded wait to
      // replay it later is a longer custody than this service should have.
      queue({ scope, input, settings, claimId, key, browserId, now });
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
  readonly storageSeed?: readonly StorageSeedEntry[];
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
  const storageSeed = branch.storageSeed ?? [];
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

  if (storageSeed.length > 0) {
    // **Origins and keys, never values** (§3.2). The redaction is
    // `seedRecord`'s and it is structural — the type it returns has no field
    // a value could live in — so this call site cannot leak one by being
    // written carelessly, and a later edit here cannot either.
    //
    // ── What this row asserts, and what it deliberately does not ──────────
    //
    // **It records that a seed was ACCEPTED, not that storage was written**,
    // and it stays that way now that the write exists. The claim path still
    // cannot do the writing: it runs inside the arbitration transaction, and
    // §2.4b keeps browser work outside it — the tab is a row in `opening`
    // with no page behind it yet.
    //
    // What changed is that there is now a **second** row. `pageFor` opens the
    // page on the tab's first use, seeds it before any navigation, and
    // appends `seed: 'applied'` once the driver has returned
    // (`operations/pages.ts`). So the pair reads as a request and its
    // outcome, and a lease that was granted a seed which never reached a
    // browser has the first row and not the second.
    //
    // That asymmetry is the point. A row saying the lease *started life
    // holding a credential* on the strength of the ask alone would assert
    // something the system may not have done — a ledger that overstates is
    // worse than one that is silent, because the question §3.2 wants answered
    // is a security question and a false negative in it is read as an
    // all-clear. `requested` is the true fact available at this point;
    // `applied` is the true fact available at the other one.
    append(scope.db, {
      kind: 'storage_seeded',
      outcome: 'allow',
      adapter: scope.adapter,
      claimId,
      tabId,
      sessionId: input.sessionId,
      browserId,
      detail: { entries: seedRecord(storageSeed), seed: 'requested' },
    });
  }

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
      storageSeed,
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
