import type { Database } from 'better-sqlite3';

import { immediate } from '../store/transaction.ts';

/**
 * `browser_feedback` — the tenth tool's write, and the one built to be
 * removed.
 *
 * ── ITS EXIT CONDITION, WRITTEN DOWN, BECAUSE THAT IS PART OF THE ROW ────
 *
 * **This is v0 scaffolding. The signal to remove it is a long stretch in
 * which nothing is logged** (`SCHEMA.md` §3.16). Silence is the success
 * condition, not a failure to collect: once callers have stopped finding
 * things to report, a channel for reporting them has nothing left to carry
 * and it goes.
 *
 * Three consequences the implementation has to honour, and does:
 *
 * 1. **No migration story is owed.** Nothing later is expected to read these
 *    rows, so this table does not have to be one anybody would want to keep.
 * 2. **It does not have to be beautiful.** Trivially callable, trivially
 *    readable, and nothing else. That is why this file is short and why there
 *    is no abstraction over it.
 * 3. **Removing it stays a DELETION, not an extraction.** Nothing else reads
 *    this table, no operation depends on a row existing, and no refusal
 *    changes shape when it goes. **Whoever removes this deletes this file,
 *    the reader beside it, the tool, the command and the table — and nothing
 *    else moves.** That property is worth protecting deliberately as the rest
 *    of the service grows, so: do not join anything to this table, and do not
 *    make any operation's behaviour depend on a row in it.
 *
 * It is its own table rather than an event kind precisely to keep that true
 * (§3.16): the ledger records what the service *did*, this records what a
 * caller *thought*, and folding it in would make every count over `events`
 * start by excluding a kind that is not an event.
 *
 * ── It is local, and it has no route out ────────────────────────────────
 *
 * The store is the installation's own file. **There is no outbound path in
 * this module and there must never be one.** Nothing else in this design
 * opens an outbound connection and nothing listens, so a feedback channel
 * that transmitted would be the only component with a reason to reach the
 * network — carrying prose written by a caller about a page it was looking
 * at, next to a lease identifier and a session identity. The consequence is
 * accepted: feedback is per-installation and read by somebody with access to
 * the machine.
 */

/**
 * The five categories, and the reason the set is exactly this.
 *
 * **Small, fixed, disjoint, and one of them is positive.** A category list
 * with no positive value collects only complaints, and a channel that can
 * only ever report problems produces a picture in which nothing works. The
 * exit condition above depends on being able to tell *nothing to report*
 * apart from *nobody bothered*, and `worked-well` is the entry that makes
 * that distinction possible.
 *
 * Two categories that overlap get chosen by coin-flip and their counts mean
 * nothing, which is why these are disjoint rather than merely different.
 */
export const FEEDBACK_CATEGORIES = {
  'refusal-unclear': 'The service refused, and the message did not say what to do next',
  'no-path': 'The task could not be accomplished at all with the tools available',
  'worked-around': 'The caller got there, but by an awkward or indirect route',
  'surprised-me': 'It worked — but not the way the caller expected',
  'worked-well': 'Positive. Something helped, and it is worth knowing which thing',
} as const;

export type FeedbackCategory = keyof typeof FEEDBACK_CATEGORIES;

/** Every category, in a stable order. */
export const FEEDBACK_CATEGORY_NAMES: readonly FeedbackCategory[] = Object.keys(
  FEEDBACK_CATEGORIES,
) as FeedbackCategory[];

export function isFeedbackCategory(value: string): value is FeedbackCategory {
  return Object.prototype.hasOwnProperty.call(FEEDBACK_CATEGORIES, value);
}

/**
 * The rating scale, with both ends and the middle written out.
 *
 * **An unanchored scale is used differently by every caller and produces
 * numbers that cannot be compared** — which defeats the only reason to have a
 * number at all. So the anchors live here, in code, and are what the tool
 * description and the reader both quote.
 *
 * **The axis is not satisfaction.** It is not whether the caller liked the
 * service. It is whether the service moved the caller's actual work forward
 * or got in its way.
 */
export const RATING_ANCHORS: Readonly<Record<number, string>> = {
  1: 'It stalled the work — could not do what it came to do, or spent more effort working around this service than on the task',
  2: 'Substantial friction — the work got done, but the detour was a significant part of the effort',
  3: 'Neutral — neither sped the work up nor got in its way',
  4: 'It helped — the work went faster, with a rough edge worth mentioning',
  5: 'It made the work faster — got where it was going quicker than by any other available route',
};

export const RATING_MINIMUM = 1;
export const RATING_MAXIMUM = 5;

/**
 * The note's bounds. **The floor is deliberate** — twenty characters is
 * roughly the shortest useful sentence, and it stops a reflexive one-word row.
 */
export const NOTE_MINIMUM = 20;
export const NOTE_MAXIMUM = 2000;

/** What a caller supplies. Everything else is captured for it. */
export interface FeedbackSubmission {
  readonly rating: number;
  readonly category: FeedbackCategory;
  readonly note: string;
  /** Supplied when there is no lease to read an identity from. */
  readonly sessionId?: string;
  /**
   * The **hash** of the lease key, when one was supplied.
   *
   * ── Why this is a hash and not the key ──────────────────────────────
   *
   * **The secret key is never stored** (§1.4, §1.3): `claims.key_hash` is a
   * one-way hash of it, and every call carrying a key hashes what it was
   * handed and looks the lease up by that value. So this module, which reads
   * the claims table, is handed the hash rather than the key — it has no
   * business holding a secret it would only hash and discard, and a plain
   * key reaching this far is a key one careless log line away from a store
   * that §5.6 says must never print it.
   *
   * **The hashing itself belongs to the service layer (row #10) and is not
   * built here.** Stated plainly rather than stubbed: this row cannot invent
   * the hash function, because a second implementation of it would look up
   * nothing and this column would silently be null forever. Until that lands,
   * the adapters supply `sessionId` and this stays null — which is the
   * documented no-lease path, not a failure.
   *
   * Its only effect is to attach the row to a lease. **It is not an
   * authorisation**, and no lease is required at all (§3.16).
   */
  readonly leaseKeyHash?: string;
}

/**
 * The three columns the service fills in, which are the design.
 *
 * `claim_id`, `last_event_id` and `last_guard` are the ones that make a row
 * diagnosable, and **none of them costs the caller a keystroke or can be
 * misremembered**. A row with those three plus prose is a report; prose alone
 * is an anecdote. The tool's guidance says outright not to supply them.
 */
export interface CapturedContext {
  readonly claimId: string | null;
  readonly lastEventId: number | null;
  readonly lastGuard: string | null;
}

export interface RecordedFeedback {
  readonly id: number;
  readonly captured: CapturedContext;
}

/**
 * Read the three auto-captured columns from what the store already knows.
 *
 * **The caller's last operation is read from the ledger**, so it names what
 * was actually attempted rather than what the caller remembers attempting —
 * and `last_guard` comes off that same row rather than being asked for, so
 * the refusal recorded is the refusal that happened.
 *
 * Resolution order, and it matters: a lease key identifies one claim exactly,
 * so it is preferred. Failing that, a session identity finds that session's
 * most recent event. Failing both, the row carries prose and a rating and
 * nothing else, which is still a row worth having — a caller whose very first
 * call was refused before any lease existed is exactly the population §3.16
 * exists to hear from.
 */
export function captureContext(db: Database, submission: FeedbackSubmission): CapturedContext {
  let claimId: string | null = null;

  if (submission.leaseKeyHash !== undefined) {
    // Looked up by hash, because the key itself is never stored (§1.4).
    const claim = db
      .prepare('SELECT id FROM claims WHERE key_hash = ? ORDER BY created_at DESC LIMIT 1')
      .get(submission.leaseKeyHash) as { id?: string } | undefined;
    claimId = claim?.id ?? null;
  }

  // The most recent event this caller produced. Ordered by the ledger's own
  // counter rather than by its timestamp: two rows written in the same second
  // are ordered by the counter and are not ordered by the clock, and "the
  // caller's LAST operation" is a claim about order.
  const lastEvent = (
    claimId !== null
      ? db
          .prepare('SELECT id, guard FROM events WHERE claim_id = ? ORDER BY id DESC LIMIT 1')
          .get(claimId)
      : submission.sessionId !== undefined
        ? db
            .prepare('SELECT id, guard FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 1')
            .get(submission.sessionId)
        : undefined
  ) as { id?: number; guard?: string | null } | undefined;

  return {
    claimId,
    lastEventId: lastEvent?.id ?? null,
    // Null when the last event was an allow: `guard` is null on an allow by
    // the table's own constraint, so this carries "the refusal it hit" and
    // not "the last rule that happened to be mentioned".
    lastGuard: lastEvent?.guard ?? null,
  };
}

/** Why a submission was refused. Codes are stable; a caller branches on them. */
export interface FeedbackRefusal {
  readonly code: string;
  readonly rule: string;
  readonly message: string;
}

/**
 * Check a submission, returning the refusal or nothing.
 *
 * Every refusal names the way forward (§3.14) — which matters more here than
 * anywhere, because this is the tool whose whole purpose is learning that a
 * refusal failed to guide. A refusal from *this* tool that did not guide
 * would be the one nobody could report.
 */
export function refuseSubmission(submission: {
  readonly rating: unknown;
  readonly category: unknown;
  readonly note: unknown;
}): FeedbackRefusal | undefined {
  const { rating } = submission;
  if (
    typeof rating !== 'number' ||
    !Number.isInteger(rating) ||
    rating < RATING_MINIMUM ||
    rating > RATING_MAXIMUM
  ) {
    return {
      code: 'rating_out_of_range',
      rule: 'feedback.rating_in_scale',
      message: `The rating is a whole number from ${String(RATING_MINIMUM)} to ${String(RATING_MAXIMUM)}, on a help-versus-hinder axis rather than a satisfaction one. ${RATING_MINIMUM}: ${RATING_ANCHORS[RATING_MINIMUM] ?? ''}. 3: ${RATING_ANCHORS[3] ?? ''}. ${RATING_MAXIMUM}: ${RATING_ANCHORS[RATING_MAXIMUM] ?? ''}.`,
    };
  }

  const { category } = submission;
  if (typeof category !== 'string' || !isFeedbackCategory(category)) {
    // Refused with the full list (§3.16), because a caller that guessed wrong
    // cannot guess better without seeing the set.
    return {
      code: 'unknown_category',
      rule: 'feedback.category_known',
      message: `The category is one of these five: ${FEEDBACK_CATEGORY_NAMES.map((name) => `${name} (${FEEDBACK_CATEGORIES[name]})`).join('; ')}.`,
    };
  }

  const { note } = submission;
  if (typeof note !== 'string' || note.length < NOTE_MINIMUM || note.length > NOTE_MAXIMUM) {
    return {
      code: 'note_out_of_bounds',
      rule: 'feedback.note_bounded',
      message: `The note is ${String(NOTE_MINIMUM)} to ${String(NOTE_MAXIMUM)} characters. Say what you were trying to achieve, what you expected to happen, and what you did instead. Do not supply the lease id, the operation or the rule that refused — all three are captured for you.`,
    };
  }

  return undefined;
}

/**
 * Write one feedback row.
 *
 * **Nothing about it is rate-limited or gated** (§3.16). It writes a row and
 * returns. The worst case is a noisy caller writing many rows into a table
 * nothing depends on, in a store that gets deleted when the tool does.
 */
export async function recordFeedback(
  db: Database,
  submission: FeedbackSubmission,
): Promise<RecordedFeedback> {
  return immediate(db, (scope) => {
    const captured = captureContext(scope.db, submission);
    const inserted = scope.db
      .prepare(
        `INSERT INTO feedback (session_id, claim_id, last_event_id, last_guard, rating, category, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        submission.sessionId ?? null,
        captured.claimId,
        captured.lastEventId,
        captured.lastGuard,
        submission.rating,
        submission.category,
        submission.note,
      );

    return { value: { id: Number(inserted.lastInsertRowid), captured } };
  });
}
