/**
 * The operations every route offers, named once.
 *
 * `SCHEMA.md` §8 is the claim this file exists to make checkable: *the same
 * rules through every door*. A rule implemented inside one route is enforced
 * for that route's callers and for nobody else, **and nothing reports it** —
 * so the names an adapter is measured against cannot be written down once per
 * adapter. They are written down here, and every adapter is measured against
 * this list.
 *
 * ── Why a closed union rather than a string ─────────────────────────────
 *
 * {@link OperationName} is a union of literals, so an adapter claiming to
 * expose an operation this service does not have is a **type error** rather
 * than a case that quietly never runs. That matters more than it looks: the
 * conformance runner takes the cross product of cases with the adapters
 * exposing each operation, and an adapter that misspells a name would
 * otherwise contribute an empty row to the matrix and pass vacuously.
 * `MILESTONES.md` names that failure directly — an assertion evaluated over
 * an empty set "passes forever and silently".
 */

/**
 * The thirteen operations of `SCHEMA.md` §3.1, in the order it lists them.
 *
 * Twelve of them are tools with a command each (§5.3). The diff rides on
 * `capture` as an argument rather than being an operation of its own (§3.11),
 * and the two removed tools are absent rather than deprecated (§3.1) —
 * `browser_compare` folded into capture, and `browser_tab_close` deleted
 * outright because it produced a lease owning nothing while still consuming
 * budget.
 *
 * ── The thirteenth is `doctor`, and it is the first that does not write ──
 *
 * It is here because a caller whose browser is wedged has to be able to ask
 * what is wrong **from the surface it is already on**. §3.13's evidence is
 * that both halves of the remedy were reachable only from a shell: an
 * MCP-only caller met granted claims and dead navigates with no way to see
 * why, which is the one condition this service can be in where its own
 * diagnosis is unreachable to the caller who needs it.
 *
 * **Only the diagnosis crosses.** `reconcile` stays off this list and off the
 * agent surface: it closes pages across a whole browser on the strength of a
 * proof about the whole browser, so a bug in that proof closes somebody
 * else's tab. That is `browser_scoped.never` (§7.3) and it is a build rule
 * rather than a preference — see §3.13, which names reaping and restarting in
 * the same breath and puts all three on the administrative surface (§4.3).
 * Diagnosis is admissible precisely and only because it is read-only.
 *
 * ── Why the eleventh and twelfth are two names rather than one ──────────
 *
 * `sign_in` and `sign_in_done` are the two halves of asking a person to sign
 * in (§5.5.2), and they are separate operations for the reason §3.1 gives
 * when it reconciles folding comparison into capture: **a destructive
 * operation keeps its own name; a non-destructive one may be an argument on
 * another.** Both halves move the browser's state under every other caller —
 * one takes it away and one gives it back — so a rule matching on the
 * operation name has to be able to see each. Folding the second into the
 * first as a `done: true` argument would hide precisely the transition an
 * operator reading the ledger is trying to find.
 *
 * **They are not `begin_sign_in`/`end_sign_in`.** That pair is a person's,
 * takes no key, and is deliberately absent from this list: §3.13's ceiling is
 * that *"the worst thing an agent can do through this surface is close its
 * own tab"*, and an unkeyed verb that ends a sign-in by naming a browser
 * would end a person's, mid-password. These two are keyed, and the key is
 * what makes each answerable — which lease to exempt, and which lease is
 * entitled to finish.
 */
export const OPERATION_NAMES = [
  'claim',
  'status',
  'release',
  'tab_replace',
  'navigate',
  'act',
  'read',
  'evaluate',
  'capture',
  'feedback',
  'sign_in',
  'sign_in_done',
  'doctor',
] as const;

/** One operation, named. */
export type OperationName = (typeof OPERATION_NAMES)[number];

/**
 * Whether an operation changes anything a later caller can observe.
 *
 * Recorded here rather than inferred by an adapter, because it decides what a
 * waiver may cover: `MILESTONES.md` requires that a route exposing **any**
 * write operation may not waive an operation any registered rule can refuse.
 * "A route is read-only by declaration, or fully covered, with nothing in
 * between — otherwise a driver that declines to expose anything passes the
 * first assertion vacuously."
 *
 * `feedback` is a write and is deliberately marked as one even though it
 * takes no lease (§3.16): it appends a row to the installation's own store.
 */
const WRITE_OPERATIONS: ReadonlySet<OperationName> = new Set<OperationName>([
  'claim',
  'status',
  'release',
  'tab_replace',
  'navigate',
  'act',
  'read',
  'evaluate',
  'capture',
  'feedback',
  // Both halves of a requested sign-in write: each moves the browser's state,
  // each appends a ledger row, and each renews the lease that called it.
  'sign_in',
  'sign_in_done',
  // **`doctor` is deliberately absent**, and its absence is the whole of what
  // makes it admissible on the agent surface. See below.
]);

/**
 * Every *arbitration* operation writes, and `doctor` is the one that is not
 * an arbitration operation.
 *
 * `SCHEMA.md` §7.1 `arbitration.writes`: *"every arbitration path declares its
 * intent to write when it opens its transaction, and every one of them does
 * write"*, and §5.2 spells out the consequence for this route — any command
 * that goes through arbitration performs the lazy sweep, so even a listing
 * command closes somebody's lapsed tabs. `status` is the one that surprises
 * people, and it is a write for exactly that reason: it extends the lease
 * (§3.1, "there is no keyed call that does not extend").
 *
 * ── Why this is a predicate and not a constant ──────────────────────────
 *
 * This is a predicate rather than a constant `true` because *an operation
 * that genuinely reads is a thing this list may hold*, and `doctor` is that
 * operation — a function returning `true` unconditionally would be a rule
 * nobody could ever see fail. It runs `runDoctor`
 * (`src/doctor/report.ts`), which **never opens the arbitration transaction
 * at all**: no registered handler, no sweep, no ledger row, no lease renewal,
 * and no browser is launched or attached to. So
 * `arbitration.no_read_only_path` (§7.3) is untouched by it — that rule says
 * no *arbitration path* answers without writing, and this is not one. The
 * rule would be breached by a status that skipped the sweep, which is the
 * "well-intentioned optimisation" it names, and nothing here does that.
 *
 * **The one write it does make, stated rather than glossed**, because a claim
 * of "reads nothing" that is not literally true is worse than a precise one:
 * `checkRootWritable` writes a probe file into the artifact and profile roots
 * and removes it in a `finally`. That is how it answers *"is this directory
 * writable"*, which cannot be answered without trying. It touches no browser,
 * no tab, no lease and no other caller's state, and it is a check on the
 * service's own directories. The category this predicate feeds is about
 * operations that change what a **later caller can observe**, and a probe
 * file that is created and removed within one call changes nothing anybody
 * can observe.
 */
export function isWriteOperation(operation: OperationName): boolean {
  return WRITE_OPERATIONS.has(operation);
}
