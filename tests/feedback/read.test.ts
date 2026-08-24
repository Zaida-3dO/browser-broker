import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LIMIT,
  readFeedback,
  refuseFilters,
  renderFeedback,
  type FeedbackRow,
} from '../../src/feedback/read.ts';
import { FEEDBACK_CATEGORY_NAMES, recordFeedback } from '../../src/feedback/record.ts';
import type { StoreHandle } from '../../src/store/open.ts';
import { withSteppedStore } from '../helpers/temp-store.ts';

/**
 * `broker feedback` — the reading half, which has no tool behind it.
 */

const NOTES = {
  stalled: 'Wanted a capability this surface does not offer and had to abandon the task.',
  awkward: 'Got there by an indirect route: two navigations where one should have done.',
  good: 'The snapshot-then-act loop meant I never needed a picture to find an element.',
};

/** Seed three rows a person would want to tell apart. */
async function seed(store: StoreHandle): Promise<void> {
  await recordFeedback(store.db, { rating: 1, category: 'no-path', note: NOTES.stalled });
  await recordFeedback(store.db, { rating: 2, category: 'worked-around', note: NOTES.awkward });
  await recordFeedback(store.db, { rating: 5, category: 'worked-well', note: NOTES.good });
}

test('the rows come back MOST RECENT FIRST', async () => {
  await withSteppedStore(async (store) => {
    await seed(store);
    const rows = readFeedback(store.db);

    // Named by their notes rather than counted, and asserted as a whole
    // sequence: reversing the order fails this, and so does dropping a row.
    assert.deepEqual(
      rows.map((row) => row.note),
      [NOTES.good, NOTES.awkward, NOTES.stalled],
    );
  });
});

test('--rating narrows to that rating exactly', async () => {
  await withSteppedStore(async (store) => {
    await seed(store);
    assert.deepEqual(
      readFeedback(store.db, { rating: 5 }).map((row) => row.note),
      [NOTES.good],
    );
    assert.deepEqual(readFeedback(store.db, { rating: 3 }), []);
  });
});

test('--category narrows to that category exactly — the query that says what callers came for', async () => {
  await withSteppedStore(async (store) => {
    await seed(store);
    // §3.16: "`broker feedback --category no-path` is the query that says what
    // callers came for and did not find".
    assert.deepEqual(
      readFeedback(store.db, { category: 'no-path' }).map((row) => row.note),
      [NOTES.stalled],
    );
  });
});

test('the two filters compose, rather than one silently winning', async () => {
  await withSteppedStore(async (store) => {
    await seed(store);
    // A pair that matches nothing: the category is present and the rating is
    // not that row's. If one filter were dropped this would return a row.
    assert.deepEqual(readFeedback(store.db, { category: 'no-path', rating: 5 }), []);
    assert.deepEqual(
      readFeedback(store.db, { category: 'no-path', rating: 1 }).map((row) => row.note),
      [NOTES.stalled],
    );
  });
});

test('the limit bounds the reading, and defaults to a screenful', async () => {
  await withSteppedStore(async (store) => {
    for (let index = 0; index < DEFAULT_LIMIT + 5; index += 1) {
      await recordFeedback(store.db, {
        rating: 3,
        category: 'surprised-me',
        note: `${NOTES.awkward} Number ${String(index)}.`,
      });
    }
    assert.equal(readFeedback(store.db).length, DEFAULT_LIMIT);
    assert.equal(readFeedback(store.db, { limit: 3 }).length, 3);
  });
});

test('the three auto-captured columns are READ BACK, because they are what makes a row diagnosable', async () => {
  await withSteppedStore(async (store) => {
    store.db
      .prepare(
        `INSERT INTO claims (id, key_hash, session_id, browser_id, purpose, state, expires_at, ttl_seconds)
         VALUES ('claim-1', 'a-hash', 'session-a', 'regular', 'a purpose', 'active', '2030-01-01T00:00:00Z', 600)`,
      )
      .run();
    const denial = store.db
      .prepare(
        `INSERT INTO events (kind, outcome, guard, claim_id, session_id, adapter)
         VALUES ('act', 'deny', 'act.verb_known', 'claim-1', 'session-a', 'tool-stdio')`,
      )
      .run();

    await recordFeedback(store.db, {
      rating: 1,
      category: 'refusal-unclear',
      note: NOTES.stalled,
      leaseKeyHash: 'a-hash',
      sessionId: 'session-a',
    });

    const [row] = readFeedback(store.db);
    assert.ok(row !== undefined);
    assert.equal(row.claimId, 'claim-1');
    assert.equal(row.lastEventId, Number(denial.lastInsertRowid));
    assert.equal(row.lastGuard, 'act.verb_known');
    assert.equal(row.sessionId, 'session-a');
  });
});

test('an unrecognised category is REFUSED, not matched against nothing', () => {
  // The reason this is a refusal rather than an empty reading: no rows is
  // also what "nothing to report" looks like, and that reading is the exit
  // condition this whole mechanism turns on. A typo that produced silence
  // would be read as the success condition.
  const refusal = refuseFilters({ category: 'no-paths' });
  assert.ok(refusal !== undefined, 'a misspelled category was accepted');
  assert.equal(refusal.code, 'unknown_category');
  for (const category of FEEDBACK_CATEGORY_NAMES) {
    assert.ok(refusal.message.includes(category), `the refusal did not list ${category}`);
  }
});

test('a rating filter outside the scale is refused', () => {
  for (const rating of [0, 6, 2.5, 'five']) {
    assert.ok(refuseFilters({ rating }) !== undefined, `${String(rating)} was accepted`);
  }
  for (const rating of [1, 2, 3, 4, 5]) {
    assert.equal(refuseFilters({ rating }), undefined, `${String(rating)} was refused`);
  }
});

test('a limit below one is refused', () => {
  assert.ok(refuseFilters({ limit: 0 }) !== undefined);
  assert.ok(refuseFilters({ limit: -3 }) !== undefined);
  assert.equal(refuseFilters({ limit: 1 }), undefined);
});

test('no filters at all is not a refusal — reading everything is the default', () => {
  assert.equal(refuseFilters({}), undefined);
});

test('AN EMPTY READING SAYS SO IN WORDS, and says what silence means', () => {
  // A blank screen reads as a broken command. The one reading that must not
  // be mistaken for a malfunction is the one that means the tool has done its
  // job, so it is spelled out.
  const rendered = renderFeedback([], false);
  assert.match(rendered, /No feedback has been recorded/u);
  assert.match(rendered, /silence is its success condition/u);
  assert.match(rendered, /deletion/u);
});

test('an empty FILTERED reading does not claim nothing was ever recorded', () => {
  // The distinction matters: "nothing matched your filter" and "nothing has
  // ever been logged" are different facts, and only the second is the exit
  // condition. Conflating them would report the exit condition every time
  // somebody typed a narrow filter.
  const rendered = renderFeedback([], true);
  assert.match(rendered, /No feedback matches those filters/u);
  assert.equal(/silence is its success condition/u.test(rendered), false);
});

test('a rendered row carries the rating, the category and the captured context', () => {
  const row: FeedbackRow = {
    id: 4,
    at: '2026-01-01T00:00:00Z',
    sessionId: 'session-a',
    claimId: 'claim-1',
    lastEventId: 17,
    lastGuard: 'act.verb_known',
    rating: 1,
    category: 'refusal-unclear',
    note: NOTES.stalled,
  };

  const rendered = renderFeedback([row], false);
  assert.match(rendered, /1\/5/u);
  assert.match(rendered, /refusal-unclear/u);
  assert.match(rendered, /claim-1/u);
  assert.match(rendered, /#17/u);
  assert.match(rendered, /act\.verb_known/u);
  assert.ok(rendered.includes(NOTES.stalled));
});

test('a row with no captured context says so rather than rendering blanks', () => {
  const rendered = renderFeedback(
    [
      {
        id: 1,
        at: '2026-01-01T00:00:00Z',
        sessionId: null,
        claimId: null,
        lastEventId: null,
        lastGuard: null,
        rating: 3,
        category: 'surprised-me',
        note: NOTES.awkward,
      },
    ],
    false,
  );
  assert.match(rendered, /no context was captured/u);
});
