import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';

import {
  FEEDBACK_CATEGORY_NAMES,
  NOTE_MAXIMUM,
  NOTE_MINIMUM,
  RATING_ANCHORS,
  captureContext,
  recordFeedback,
  refuseSubmission,
} from '../../src/feedback/record.ts';
import { readFeedback } from '../../src/feedback/read.ts';
import type { StoreHandle } from '../../src/store/open.ts';
import { withSteppedStore } from '../helpers/temp-store.ts';

/**
 * `browser_feedback` — the write, its three auto-captured columns, and its
 * refusals.
 */

/**
 * Read the table through a **second, read-only connection**.
 *
 * `CLAUDE.md` and this repository's own record: a hollow test was caught here
 * that "read through the store's OWN handle, which sees uncommitted writes".
 * A write that was never committed is visible to the handle that made it and
 * invisible to everybody else — so an assertion about what *committed* has to
 * come from a connection that was not part of the transaction.
 *
 * The single-character change this catches: a write that never commits —
 * a bare statement outside any transaction, or a dropped `COMMIT`.
 */
function readCommitted(store: StoreHandle, path: string): Record<string, unknown>[] {
  const second = new Database(path, { readonly: true });
  try {
    return second.prepare('SELECT * FROM feedback ORDER BY id').all() as Record<string, unknown>[];
  } finally {
    second.close();
  }
}

/** Where the temporary store's file is, read from the handle itself. */
function pathOf(store: StoreHandle): string {
  return store.location;
}

const A_NOTE = 'Wanted the sign-in page at a narrow width; expected the header to reflow.';

test('a feedback row is COMMITTED — asserted from a second, read-only connection', async () => {
  await withSteppedStore(async (store) => {
    const recorded = await recordFeedback(store.db, {
      rating: 2,
      category: 'worked-around',
      note: A_NOTE,
      sessionId: 'session-a',
    });

    const rows = readCommitted(store, pathOf(store));
    assert.equal(rows.length, 1, 'the write was not visible to another connection');
    assert.equal(rows[0]?.['id'], recorded.id);
    assert.equal(rows[0]?.['rating'], 2);
    assert.equal(rows[0]?.['category'], 'worked-around');
    assert.equal(rows[0]?.['note'], A_NOTE);
    assert.equal(rows[0]?.['session_id'], 'session-a');
  });
});

test('NO LEASE IS REQUIRED — which is the point rather than a convenience', async () => {
  // §3.16: a caller whose claim was refused is the caller most likely to have
  // something worth recording. Requiring a lease would silence exactly the
  // population the tool exists to hear from.
  await withSteppedStore(async (store) => {
    const recorded = await recordFeedback(store.db, {
      rating: 1,
      category: 'no-path',
      note: 'Came for a capability this surface does not offer and could not find it.',
    });

    const rows = readCommitted(store, pathOf(store));
    assert.equal(rows.length, 1, 'a feedback row with no lease was not written');
    assert.equal(rows[0]?.['claim_id'], null);
    assert.equal(rows[0]?.['session_id'], null);
    assert.ok(recorded.id > 0);
  });
});

test('THE THREE AUTO-CAPTURED COLUMNS come from the store, not from the caller', async () => {
  await withSteppedStore(async (store) => {
    // A lease and a ledger the service already knows about.
    store.db
      .prepare(
        `INSERT INTO claims (id, key_hash, session_id, browser_id, purpose, state, expires_at, ttl_seconds)
         VALUES ('claim-1', 'a-hash-of-the-key', 'session-a', 'regular', 'a purpose', 'active', '2030-01-01T00:00:00Z', 600)`,
      )
      .run();
    store.db
      .prepare(
        `INSERT INTO events (kind, outcome, guard, claim_id, session_id, adapter)
         VALUES ('navigate', 'allow', NULL, 'claim-1', 'session-a', 'tool-stdio')`,
      )
      .run();
    const denial = store.db
      .prepare(
        `INSERT INTO events (kind, outcome, guard, claim_id, session_id, adapter)
         VALUES ('act', 'deny', 'act.verb_known', 'claim-1', 'session-a', 'tool-stdio')`,
      )
      .run();

    const recorded = await recordFeedback(store.db, {
      rating: 1,
      category: 'refusal-unclear',
      note: 'Tried an action and the refusal did not say which verbs exist.',
      leaseKeyHash: 'a-hash-of-the-key',
    });

    // The caller supplied a lease key and prose. All three of these came free.
    assert.equal(recorded.captured.claimId, 'claim-1');
    assert.equal(
      recorded.captured.lastEventId,
      Number(denial.lastInsertRowid),
      'the last operation was not the caller LAST operation',
    );
    assert.equal(recorded.captured.lastGuard, 'act.verb_known');

    const rows = readCommitted(store, pathOf(store));
    assert.equal(rows[0]?.['claim_id'], 'claim-1');
    assert.equal(rows[0]?.['last_event_id'], Number(denial.lastInsertRowid));
    assert.equal(rows[0]?.['last_guard'], 'act.verb_known');
  });
});

test('the last operation is the LATEST one, so a later allow clears the guard', async () => {
  // The mutation this kills: ordering by `at` instead of by `id`. Two rows
  // written in the same second are ordered by the counter and are NOT ordered
  // by the clock, so an `at` ordering returns whichever row the engine
  // happened to reach first — and "the refusal it hit" becomes a coin flip.
  await withSteppedStore((store) => {
    store.db
      .prepare(
        `INSERT INTO claims (id, key_hash, session_id, browser_id, purpose, state, expires_at, ttl_seconds)
         VALUES ('claim-1', 'a-hash-of-the-key', 'session-a', 'regular', 'a purpose', 'active', '2030-01-01T00:00:00Z', 600)`,
      )
      .run();
    store.db
      .prepare(
        `INSERT INTO events (kind, outcome, guard, claim_id, session_id, adapter, at)
         VALUES ('act', 'deny', 'act.verb_known', 'claim-1', 'session-a', 'cli', '2026-01-01T00:00:00Z')`,
      )
      .run();
    const later = store.db
      .prepare(
        `INSERT INTO events (kind, outcome, guard, claim_id, session_id, adapter, at)
         VALUES ('navigate', 'allow', NULL, 'claim-1', 'session-a', 'cli', '2026-01-01T00:00:00Z')`,
      )
      .run();

    const captured = captureContext(store.db, {
      rating: 3,
      category: 'surprised-me',
      note: A_NOTE,
      leaseKeyHash: 'a-hash-of-the-key',
    });

    assert.equal(captured.lastEventId, Number(later.lastInsertRowid));
    // The last event was an allow, so there is no refusal to name. A guard
    // here would be "the last rule that happened to be mentioned" rather than
    // "the refusal it hit".
    assert.equal(captured.lastGuard, null);
  });
});

test('with no lease, the context is found by session identity instead', async () => {
  await withSteppedStore((store) => {
    const refused = store.db
      .prepare(
        `INSERT INTO events (kind, outcome, guard, claim_id, session_id, adapter)
         VALUES ('claim_requested', 'deny', 'capacity.admission', NULL, 'session-b', 'tool-stdio')`,
      )
      .run();

    const captured = captureContext(store.db, {
      rating: 1,
      category: 'refusal-unclear',
      note: 'My claim was refused for capacity and I could not tell whether waiting would help.',
      sessionId: 'session-b',
    });

    // This is the population §3.16 exists to hear from: a caller with no
    // lease, because its claim was the thing that was refused.
    assert.equal(captured.claimId, null);
    assert.equal(captured.lastEventId, Number(refused.lastInsertRowid));
    assert.equal(captured.lastGuard, 'capacity.admission');
  });
});

test('a rating outside the scale is refused, and the refusal ANCHORS the scale', () => {
  for (const rating of [0, 6, -1, 2.5, '3', null, undefined]) {
    const refusal = refuseSubmission({ rating, category: 'worked-well', note: A_NOTE });
    assert.ok(refusal !== undefined, `${String(rating)} was accepted as a rating`);
    assert.equal(refusal.code, 'rating_out_of_range');
    assert.equal(refusal.rule, 'feedback.rating_in_scale');
    // §3.14: every refusal names the way forward. Here that means writing the
    // anchors out — a caller told only "1 to 5" still does not know what 3
    // means, and an unanchored scale produces numbers nobody can compare.
    assert.match(refusal.message, /stalled the work/u);
    assert.match(refusal.message, /Neutral/u);
    assert.match(refusal.message, /faster/u);
  }
});

test('every rating in the scale is accepted, named one by one', () => {
  // Named rather than a loop over a range: this asserts 1, 2, 3, 4 and 5 are
  // each accepted, so narrowing the scale fails here.
  for (const rating of [1, 2, 3, 4, 5]) {
    assert.equal(
      refuseSubmission({ rating, category: 'worked-well', note: A_NOTE }),
      undefined,
      `${String(rating)} was refused`,
    );
  }
});

test('the five anchors are written out — an unanchored scale defeats the number', () => {
  assert.deepEqual(Object.keys(RATING_ANCHORS), ['1', '2', '3', '4', '5']);
  for (const [value, anchor] of Object.entries(RATING_ANCHORS)) {
    assert.ok(anchor.length > 30, `rating ${value} has no real anchor`);
  }
});

test('a category outside the five is refused WITH the full list', () => {
  const refusal = refuseSubmission({ rating: 3, category: 'helped', note: A_NOTE });
  assert.ok(refusal !== undefined, 'an unknown category was accepted');
  assert.equal(refusal.code, 'unknown_category');
  for (const category of FEEDBACK_CATEGORY_NAMES) {
    assert.ok(refusal.message.includes(category), `the refusal did not list ${category}`);
  }
});

test('THE FIVE CATEGORIES ARE THESE FIVE, and one of them is positive', () => {
  // Named, not counted. A count stays green when one is replaced by another.
  assert.deepEqual(
    [...FEEDBACK_CATEGORY_NAMES],
    ['refusal-unclear', 'no-path', 'worked-around', 'surprised-me', 'worked-well'],
  );
  // The positive one is in the set deliberately: the exit condition depends
  // on telling "nothing to report" apart from "nobody bothered", and a
  // complaints-only channel cannot.
  assert.ok(FEEDBACK_CATEGORY_NAMES.includes('worked-well'));
});

test('every category is accepted, one at a time', async () => {
  await withSteppedStore(async (store) => {
    for (const category of FEEDBACK_CATEGORY_NAMES) {
      assert.equal(
        refuseSubmission({ rating: 3, category, note: A_NOTE }),
        undefined,
        `${category} was refused`,
      );
      await recordFeedback(store.db, { rating: 3, category, note: A_NOTE });
    }
    const rows = readCommitted(store, pathOf(store));
    assert.deepEqual(
      rows.map((row) => row['category']),
      [...FEEDBACK_CATEGORY_NAMES],
    );
  });
});

test('a note below the floor is refused — it stops a reflexive one-word row', () => {
  const refusal = refuseSubmission({ rating: 5, category: 'worked-well', note: 'good' });
  assert.ok(refusal !== undefined, 'a one-word note was accepted');
  assert.equal(refusal.code, 'note_out_of_bounds');
  // The refusal tells the caller what to write instead, and tells it NOT to
  // type the three things that are captured for it.
  assert.match(refusal.message, /trying to achieve/u);
  assert.match(refusal.message, /expected/u);
  assert.match(refusal.message, /captured for you/u);
});

test('the note bounds are exact at both edges', () => {
  assert.ok(
    refuseSubmission({ rating: 3, category: 'no-path', note: 'x'.repeat(NOTE_MINIMUM - 1) }) !==
      undefined,
    'one character below the floor was accepted',
  );
  assert.equal(
    refuseSubmission({ rating: 3, category: 'no-path', note: 'x'.repeat(NOTE_MINIMUM) }),
    undefined,
    'exactly the floor was refused',
  );
  assert.equal(
    refuseSubmission({ rating: 3, category: 'no-path', note: 'x'.repeat(NOTE_MAXIMUM) }),
    undefined,
    'exactly the ceiling was refused',
  );
  assert.ok(
    refuseSubmission({ rating: 3, category: 'no-path', note: 'x'.repeat(NOTE_MAXIMUM + 1) }) !==
      undefined,
    'one character above the ceiling was accepted',
  );
});

test('nothing is rate-limited: a noisy caller writes many rows and none is refused', async () => {
  await withSteppedStore(async (store) => {
    for (let index = 0; index < 12; index += 1) {
      await recordFeedback(store.db, {
        rating: 3,
        category: 'surprised-me',
        note: `${A_NOTE} Attempt ${String(index)}.`,
      });
    }
    assert.equal(readCommitted(store, pathOf(store)).length, 12);
  });
});

test('THE TABLE IS AN ISLAND — no other table references it, so removal is a deletion', async () => {
  // §3.16's third consequence, asserted rather than promised: "removing it
  // must stay a deletion rather than an extraction". If some later table
  // grows a foreign key into `feedback`, dropping the table stops being a
  // deletion and this test is where that is noticed.
  await withSteppedStore((store) => {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];

    for (const { name } of tables) {
      if (name === 'feedback') {
        continue;
      }
      const keys = store.db.pragma(`foreign_key_list(${name})`) as { table: string }[];
      for (const key of keys) {
        assert.notEqual(
          key.table,
          'feedback',
          `${name} references feedback, so removing the tool would be an extraction rather than a deletion`,
        );
      }
    }
    // And the island is genuinely there to be checked, rather than this
    // passing because the table does not exist.
    assert.ok(
      tables.some((table) => table.name === 'feedback'),
      'there is no feedback table at all',
    );
  });
});

test('a rating the store would refuse never reaches it — the guard is checked first', async () => {
  // The physical side-effect, not just the response: a refused submission
  // leaves no row. A guard that returned "refused" after writing would be
  // worse than no guard.
  await withSteppedStore((store) => {
    const refusal = refuseSubmission({ rating: 9, category: 'worked-well', note: A_NOTE });
    assert.ok(refusal !== undefined);
    assert.equal(readCommitted(store, pathOf(store)).length, 0);
    assert.deepEqual(readFeedback(store.db), []);
  });
});
