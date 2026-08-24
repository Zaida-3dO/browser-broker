import type { Database } from 'better-sqlite3';

/**
 * The ledger append path: one row per decision, **allowed and refused
 * alike**.
 *
 * `SCHEMA.md` §1.6 states the reason in the sentence that sets this row's
 * scope: "a record containing only refusals cannot answer *was this rule ever
 * actually reached*, which is the first question anybody asks the day
 * something behaves oddly". The mirror of that failure is just as bad and
 * less often noticed — a ledger of grants alone can never show a guard
 * firing, so the two halves have to be written by the same code path or one
 * of them will be forgotten.
 *
 * **So there is one function, not an `allow` and a `deny`.** {@link append}
 * takes the outcome as an argument. Two entry points would let a refusal path
 * be written that simply never calls the second one, which is exactly the
 * ledger §1.6 exists to prevent, and nothing would report it.
 *
 * ── What this module does not do ────────────────────────────────────────
 *
 * It does not open a transaction and it never will. Every call takes the
 * caller's own {@link Database} handle, because a ledger row belongs to the
 * decision that produced it: written in the arbitration transaction, it is
 * committed with the decision or rolled back with it, and there is no state
 * in which the store did something the ledger does not have. Appending on a
 * second connection would produce the opposite — a ledger row for a
 * transaction that rolled back — and it would do so only under the
 * conditions nobody reproduces.
 *
 * It also does not decide *what* to record. The kind, the outcome and the
 * guard are the caller's, because the caller is what knows which decision it
 * just made.
 */

/**
 * The kinds, exactly as the schema's check constraint lists them.
 *
 * Written out here as a union rather than typed as `string`, so a kind the
 * store would refuse is a compile error at the call site instead of a
 * constraint violation at run time, inside a transaction, in production.
 * §1.6: "a fixed list rather than free text, because a typo in free text
 * creates a phantom category that every count then silently misses".
 *
 * **This list and the schema's are two spellings of one fact**, which is a
 * duplication with a real failure mode: adding a kind to one and not the
 * other. `tests/service/events.test.ts` reads the constraint back out of the
 * store and asserts the two sets are equal, so the duplication is checked
 * rather than trusted.
 */
export type EventKind =
  | 'claim_requested'
  | 'claim_granted'
  | 'claim_queued'
  | 'claim_promoted'
  | 'claim_renewed'
  | 'claim_released'
  | 'claim_expired'
  | 'claim_revoked'
  | 'tab_opening'
  | 'tab_open_failed'
  | 'tab_closing'
  | 'navigate'
  | 'act'
  | 'read'
  | 'evaluate'
  | 'capture'
  | 'compare'
  | 'browser_launched'
  | 'browser_adopted'
  | 'browser_exited'
  | 'launch_race_lost'
  | 'sweep';

/** The kinds as data, for the test that reconciles them with the store. */
export const EVENT_KINDS: readonly EventKind[] = [
  'claim_requested',
  'claim_granted',
  'claim_queued',
  'claim_promoted',
  'claim_renewed',
  'claim_released',
  'claim_expired',
  'claim_revoked',
  'tab_opening',
  'tab_open_failed',
  'tab_closing',
  'navigate',
  'act',
  'read',
  'evaluate',
  'capture',
  'compare',
  'browser_launched',
  'browser_adopted',
  'browser_exited',
  'launch_race_lost',
  'sweep',
];

/**
 * Which door the call came in through (§1.6).
 *
 * `internal` is the one worth reading twice: it is work the service did on
 * its own behalf **inside somebody else's call**, and §1.6 is emphatic that
 * this is not a background job — with no long-lived process there is nothing
 * running in the background, so a sweep is attributed to the call that
 * performed it.
 */
export type EventAdapter = 'tool-stdio' | 'tool-http' | 'cli' | 'internal';

/** The adapters as data, for the same reconciliation test. */
export const EVENT_ADAPTERS: readonly EventAdapter[] = [
  'tool-stdio',
  'tool-http',
  'cli',
  'internal',
];

/** `allow` or `deny`, and every decision is one of them. */
export type EventOutcome = 'allow' | 'deny';

/**
 * One row to append.
 *
 * ── The outcome and the guard are one field, not two ────────────────────
 *
 * The schema pairs them with a check constraint — a guard is required on a
 * denial and forbidden on an allow — and that constraint is the honest
 * expression of the rule. But a constraint fires at run time, inside a
 * transaction, and the two mistakes it catches are both easy to make: a
 * refusal recorded with no rule name (which is the anonymous refusal §1.6
 * exists to prevent) and an allow carrying a leftover guard from the branch
 * above (which invents a rule firing that never fired).
 *
 * A discriminated union moves both to compile time. `{ outcome: 'deny' }`
 * without a `guard` does not type-check, and `{ outcome: 'allow' }` with one
 * does not either. The constraint stays as the backstop for anything that
 * reaches the table by another route.
 */
export type EventDecision =
  | { readonly outcome: 'allow'; readonly guard?: undefined }
  | {
      readonly outcome: 'deny';
      /** Which rule refused, named from §7's list. */
      readonly guard: string;
    };

export type AppendEvent = EventDecision & {
  readonly kind: EventKind;
  readonly adapter: EventAdapter;
  /** Null on a service-level row and on a request refused before a lease existed. */
  readonly claimId?: string | null;
  readonly tabId?: string | null;
  /**
   * A copy of the lease's session identity. §1.6 calls this "the one
   * denormalisation in the schema that earns its place outright": a refused
   * request never becomes a lease, so without this column every refusal on
   * the busiest rule in the service is anonymous.
   */
  readonly sessionId?: string | null;
  readonly browserId?: string | null;
  /**
   * The rest, shaped per kind. Serialised here rather than by the caller so
   * every row in the column is the same kind of text and a reader never has
   * to guess whether a given row was encoded.
   *
   * **`undefined` and `null` both store null**, because a caller that built
   * its detail object conditionally should not get the four characters
   * `null` in the column for a field it decided not to send.
   */
  readonly detail?: Readonly<Record<string, unknown>> | null;
};

/**
 * The row as it comes back out. `id` counts upward and doubles as the
 * "everything since here" cursor (§1.6).
 */
export interface EventRow {
  readonly id: number;
  readonly at: string;
  readonly kind: EventKind;
  readonly outcome: EventOutcome;
  readonly guard: string | null;
  readonly claimId: string | null;
  readonly tabId: string | null;
  readonly sessionId: string | null;
  readonly adapter: EventAdapter;
  readonly browserId: string | null;
  readonly detail: string | null;
}

const INSERT = `
INSERT INTO events (kind, outcome, guard, claim_id, tab_id, session_id, adapter, browser_id, detail)
VALUES (@kind, @outcome, @guard, @claimId, @tabId, @sessionId, @adapter, @browserId, @detail)
`;

/**
 * Append one row and return its identifier.
 *
 * **`at` is not a parameter and is never supplied by a caller.** It is left
 * to the column default, which reads the database's own clock (§1.1): several
 * processes are running by design (§1.0a), and two of them disagreeing by a
 * second would put the ledger subtly out of order in a way nothing reproduces
 * — the cursor would still count upward, so the disorder would be invisible
 * to every query that reads it.
 *
 * §2.4a is the related fact worth not confusing with this one: for an expiry,
 * `at` is when the sweep ran and `claims.expired_at` is when the lease
 * actually lapsed. Two facts, two columns, and only one of them is about the
 * lease.
 */
export function append(db: Database, event: AppendEvent): number {
  const result = db.prepare(INSERT).run({
    kind: event.kind,
    outcome: event.outcome,
    guard: event.guard ?? null,
    claimId: event.claimId ?? null,
    tabId: event.tabId ?? null,
    sessionId: event.sessionId ?? null,
    adapter: event.adapter,
    browserId: event.browserId ?? null,
    detail: event.detail == null ? null : JSON.stringify(event.detail),
  });
  return Number(result.lastInsertRowid);
}

const SELECT_SINCE = `
SELECT id, at, kind, outcome, guard,
       claim_id AS claimId, tab_id AS tabId, session_id AS sessionId,
       adapter, browser_id AS browserId, detail
FROM events
WHERE id > @after
ORDER BY id
LIMIT @limit
`;

/**
 * Read a slice, oldest first, starting after a cursor.
 *
 * §1.6: "events are meant to be looked at, not merely written". The read is
 * here rather than in whatever eventually displays it because the ledger is
 * one stream with one cursor, and a second reader written against the table
 * directly is a second place the ordering rule can be got wrong.
 *
 * **Ordered by `id`, not by `at`.** Two rows written in the same millisecond
 * share a timestamp, and ordering by a column with ties makes a page over the
 * ledger able to skip or repeat a row at the boundary. The counter has no
 * ties by construction, which is why §1.6 makes it the cursor.
 */
export function readSince(db: Database, after: number, limit: number): readonly EventRow[] {
  return db.prepare(SELECT_SINCE).all({ after, limit }) as EventRow[];
}
