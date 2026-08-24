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
 * The ten operations of `SCHEMA.md` §3.1, in the order it lists them.
 *
 * Ten tools, ten commands (§5.3), one list. The diff rides on `capture` as an
 * argument rather than being an eleventh operation (§3.11), and the two
 * removed tools are absent rather than deprecated (§3.1) — `browser_compare`
 * folded into capture, and `browser_tab_close` deleted outright because it
 * produced a lease owning nothing while still consuming budget.
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
]);

/**
 * Every operation here writes, and that is the design rather than an
 * oversight worth flagging.
 *
 * `SCHEMA.md` §7.1 `arbitration.writes`: *"every arbitration path declares its
 * intent to write when it opens its transaction, and every one of them does
 * write"*, and §5.2 spells out the consequence for this route — any command
 * that goes through arbitration performs the lazy sweep, so even a listing
 * command closes somebody's lapsed tabs. `status` is the one that surprises
 * people, and it is a write for exactly that reason: it extends the lease
 * (§3.1, "there is no keyed call that does not extend").
 *
 * The predicate is kept as a predicate rather than collapsed to `true`
 * because the waiver rule it feeds is about the *category*, and an operation
 * that genuinely reads is a thing a later row may add. A function that
 * returned `true` unconditionally would be a rule nobody could ever see fail.
 */
export function isWriteOperation(operation: OperationName): boolean {
  return WRITE_OPERATIONS.has(operation);
}
