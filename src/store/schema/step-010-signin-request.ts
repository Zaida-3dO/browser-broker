import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step ten: a sign-in can be **asked for by a caller**, and one asked for
 * that way has a deadline and a lease behind it.
 *
 * ── The gap this closes, stated as the thing that happened ──────────────
 *
 * §1.2 records **25 sessions that hand-seeded authentication tokens into an
 * isolated browser while the signed-in browser sat unused**. That measurement
 * is usually read as a browser-choice problem, and `DECISIONS.md` §13i reads
 * it that way when it makes `browser` optional. **It has a second half.** A
 * caller that picked the right browser and still landed on a login page had
 * no call available to it that asks a person to sign in: `broker login` is a
 * command a person types, and the ten tools contain nothing that moves a
 * browser into `signing-in`. So the only moves left to such a caller were to
 * abandon the task or to fabricate a session — and fabricating a session is
 * precisely what those 25 sessions did.
 *
 * ── Why the existing two columns do not cover this ──────────────────────
 *
 * Step eight added `signin_owner_pid` so that a sign-in whose *command*
 * died is recoverable. That column answers **"is the person's command still
 * running"**, and it is exactly right for `broker login`, where a person is
 * sitting in front of a process that stays up for the duration.
 *
 * **A requested sign-in has no such process.** The caller that asked is a
 * connected session which returns from the call immediately and goes back to
 * polling; nothing on the machine is blocked on the person, so there is no
 * identifier whose death means *nobody is signing in any more*. Recording the
 * requesting service's own identifier would be worse than recording nothing,
 * because that process stays alive for the whole session: the row would look
 * permanently live, and the recovery step eight exists to provide would never
 * fire for the one path that most needs it.
 *
 * So the two ways in are recorded differently on purpose, and the columns are
 * separate rather than one column meaning two things:
 *
 * | Began by | Held by | Ends when |
 * |---|---|---|
 * | `broker login` | a process (`signin_owner_pid`) | the person closes the window, or the process dies |
 * | a caller asking | a deadline (`signin_deadline`) and the asking lease (`signin_claim_id`) | the person confirms, or the deadline passes |
 *
 * ── Why a deadline at all, when §5.5.1 says a sign-in has no expiry ─────
 *
 * §5.5.1's *"a person takes as long as they take"* is a statement about a
 * person **who is already at the keyboard**, and it is right for the command:
 * a timeout there would end a sign-in that was going fine while somebody was
 * halfway through a password, and the process holding it is evidence enough
 * that somebody is still there.
 *
 * A requested sign-in has no such evidence, and the failure it makes possible
 * is new. The request is relayed by an agent to a person **who may not be at
 * the keyboard at all** — who may not read the message for an hour, or ever.
 * Left unbounded, one such request holds the browser in `signing-in` against
 * every other caller indefinitely, which is the same unrecoverable state step
 * eight was written to remove, arriving through a door step eight cannot
 * watch. **The deadline is the evidence-substitute**: no process to ask about,
 * so a number instead.
 *
 * ── Why the deadline is a stored column rather than a computed one ──────
 *
 * §1.12's rule is that a value is stored when it cannot be derived from what
 * is already there. `browsers.updated_at` moves on every write to the row, so
 * *"when did this sign-in start"* is not recoverable from it after any other
 * update, and a deadline computed from a moving column is a deadline that
 * moves. The alternative — reading the last `browser_signin_began` ledger row
 * — makes an operational decision depend on scanning an append-only log whose
 * whole design is that it is written and never read back for control flow
 * (§1.6). So the moment is written down once, at the instant it is decided.
 *
 * ── Why the asking lease is recorded ────────────────────────────────────
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * 1. **So the requester is not refused by its own request.** §5.5.1's first
 *    step refuses a sign-in while any live lease holds a tab on that browser,
 *    and the requesting caller *is* such a lease — it is holding the very tab
 *    sitting on the login page. Without knowing which lease asked, the
 *    operation cannot tell the caller it is serving from the callers it is
 *    protecting, and the request refuses itself every time.
 * 2. **So the exemption is exactly one lease wide.** Recording the identifier
 *    means the refusal still fires for every *other* live lease, which is the
 *    property §5.5.1 calls "why signing in is a service operation": a person
 *    driving a window by hand underneath somebody else's work corrupts it.
 *    An exemption expressed as a flag — *"this sign-in was requested, so skip
 *    the check"* — would be an exemption for all of them.
 *
 * ── Nullable, because the older path sets neither ───────────────────────
 *
 * Both columns are null for a `broker login` sign-in, and that is the shape
 * rather than a gap: a null deadline means **this sign-in is held by a
 * process, ask step eight's column about it**. The two are not made mutually
 * exclusive by a check constraint, and the reason is worth recording rather
 * than being discovered as an omission: a constraint spanning them would
 * have to be rebuilt to change, and the invariant it would express — that a
 * sign-in has exactly one kind of owner — is one the operations enforce by
 * refusing a second sign-in at all. There is no path that writes both.
 *
 * ── A new step, and no rebuild ──────────────────────────────────────────
 *
 * Two `ALTER TABLE ... ADD COLUMN` statements, which SQLite performs in place.
 * Step nine had to rebuild because it dropped a check; nothing here changes a
 * constraint, so nothing here needs the table copied. Adding a step rather
 * than editing step nine is the rule in `steps.ts`: a step that has run
 * somewhere is history.
 */
const ADDITIONS: readonly string[] = [
  // When this sign-in stops being somebody's and starts being nobody's.
  // ISO-8601 in the same spelling every other instant in this store uses, so
  // the comparison against `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` that the
  // sweep already runs against `claims.expires_at` compares like with like.
  `ALTER TABLE browsers ADD COLUMN signin_deadline TEXT`,
  // Which lease asked. **Deliberately not a foreign key**, and this is the one
  // decision in the step that is not obvious.
  //
  // `claims` rows are never deleted — a lease ends by moving to a terminal
  // state (§2.2) — so a reference would not dangle. What a foreign key would
  // do is make the *order* of two writes load-bearing: clearing this column
  // and ending the claim would have to happen in an order the constraint
  // permits, on a path whose whole job is to run during a sweep that is
  // already updating claims. The column is read for exactly one comparison —
  // is this the lease that asked — and a value naming a claim absent from the
  // table gives that comparison the same answer as a null would.
  `ALTER TABLE browsers ADD COLUMN signin_claim_id TEXT`,
];

/** Every statement this step runs, in order. */
export const STEP_TEN_SQL: readonly string[] = ADDITIONS;

export const stepTen: Step = {
  version: 10,
  summary:
    'A sign-in can be requested by a caller: a deadline and the asking lease (§5.5.2, DECISIONS.md §13j).',
  apply: (db: Database) => {
    for (const statement of STEP_TEN_SQL) {
      db.exec(statement);
    }
  },
};
