/**
 * The expiry derivation, on its own, so that everything reporting state
 * applies the same one.
 *
 * ── Why this is a module and not three lines inlined at each reader ──────
 *
 * `SCHEMA.md` §2.4 states the standing rule this whole file exists to serve:
 *
 * > **Stored state is provisional, derived state is the truth.**
 *
 * Nothing expires on a timer, because there is nothing running to hold one
 * (§1.0a). A row saying `active` whose expiry has elapsed is **not** an
 * active lease — it is a lease that lapsed and has not been swept yet, and
 * **the difference is invisible in the row.** So a reader that renders
 * `claims.state` reports leases that do not exist, and does it *most* on the
 * busiest installation, where the gap between lapsing and being noticed is
 * exactly the interval somebody is looking at the document.
 *
 * §2.4 names this as "the rule most likely to be broken by a well-meaning
 * addition, because reading a column is the obvious thing to do and it is
 * wrong here", and §4.5 binds the generated operations document to it
 * explicitly: it "is a reader like any other".
 *
 * Keeping the derivation in one named function is what makes that rule
 * **checkable** rather than merely written down: a reader either calls
 * {@link deriveClaimState} or it does not, and a test can delete this
 * function's comparison and watch a rendering test fail.
 *
 * ── What this does not do, said plainly ─────────────────────────────────
 *
 * **It does not sweep, and it writes nothing.** Sweeping is the arbitration
 * transaction's job (§2.4) and belongs to the service layer. This is the
 * read-side half: given a row and an instant, say what is *true* about that
 * row at that instant. The two must agree, and they agree because they apply
 * the same comparison — but a document generator must never be the thing that
 * expires somebody's lease as a side effect of being looked at.
 *
 * **It cannot stop a reader going around it.** Nothing in a type signature
 * prevents a module selecting `state` and printing it. What this buys is that
 * the correct path is one import away and named for what it does, and that
 * the mutation tests over the document renderer have a single line to kill.
 */

/** The five states a lease row can be stored in (`SCHEMA.md` §2.1, §1.3). */
export type StoredClaimState = 'queued' | 'active' | 'released' | 'expired' | 'revoked';

/**
 * The state a lease is actually in, right now.
 *
 * The same five words, deliberately: the derivation does not invent a sixth
 * state such as `lapsed`, because what a caller experiences when its lease
 * has run out is `expired` — the sweep, when it arrives, will write exactly
 * that word into exactly that row. A reader inventing its own vocabulary
 * would produce a document whose words do not appear anywhere else in the
 * system.
 */
export type DerivedClaimState = StoredClaimState;

/** The columns of a claim row this derivation needs, and no others. */
export interface ClaimTiming {
  readonly state: StoredClaimState;
  /** The instant this lease lapses, in the store's fixed textual form. */
  readonly expires_at: string;
}

/**
 * Comparing two of the store's timestamps.
 *
 * `SCHEMA.md` §1.1: time is "stored in a single fixed textual form that sorts
 * in chronological order, so a comparison is a comparison and needs no
 * conversion". So this is a string comparison **on purpose** — parsing to a
 * date here would introduce a second interpretation of the same column, and a
 * time zone for it to be wrong in.
 */
function hasElapsed(expiresAt: string, at: string): boolean {
  return expiresAt <= at;
}

/**
 * What a lease's state actually is at instant `at`.
 *
 * **A final state is final** (§2.1): released, expired and revoked are
 * outcomes that already happened, and no passage of time changes one. Only
 * the two live states — `queued` and `active` — can have lapsed without
 * anybody noticing.
 *
 * The boundary is **inclusive**: a lease whose expiry is exactly now has
 * elapsed. That matches the sweep, which selects the live rows at or past
 * their expiry, and the two must not disagree by one instant — a document
 * saying `active` for a lease the very next call will expire is the failure
 * this module exists to prevent, in miniature.
 */
export function deriveClaimState(claim: ClaimTiming, at: string): DerivedClaimState {
  if (claim.state !== 'queued' && claim.state !== 'active') {
    return claim.state;
  }
  return hasElapsed(claim.expires_at, at) ? 'expired' : claim.state;
}

/**
 * Whether a lease is live at instant `at` — holding a tab, or holding a
 * place in the queue.
 *
 * This is the predicate the budget count is over, and it is derived for the
 * same reason everything else here is: counting rows whose stored state is
 * live would count leases that have lapsed, and would report an installation
 * as fuller than it is.
 */
export function isLive(claim: ClaimTiming, at: string): boolean {
  const derived = deriveClaimState(claim, at);
  return derived === 'queued' || derived === 'active';
}

/**
 * Whole seconds between two of the store's timestamps, `later - earlier`.
 *
 * Negative when `later` is before `earlier`, which is not guarded against:
 * the callers here are reporting how long something has been waiting or how
 * long until it lapses, and a negative number is the honest answer to "how
 * long until an expiry that has already passed". Clamping it would hide
 * exactly the case §2.4 is about.
 *
 * Parsing is safe here in a way it is not in {@link hasElapsed}, because the
 * question is arithmetic rather than ordering — but the values still come
 * from one clock (the database's own, §1.1), so the subtraction is between
 * two readings of the same clock and not across two machines'.
 */
export function secondsBetween(earlier: string, later: string): number {
  const from = Date.parse(earlier);
  const to = Date.parse(later);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return 0;
  }
  return Math.round((to - from) / 1000);
}
