import assert from 'node:assert/strict';
import test from 'node:test';

import { isReadingFeedback, run } from '../../src/cli/index.ts';
import { recordFeedback } from '../../src/feedback/record.ts';
import { prepareStore } from '../../src/store/open.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * `broker feedback` end to end: **both halves on one command** (§5.3).
 *
 * The reading half is dispatched before the operation path, so these drive
 * the real entry point with an argument vector rather than calling the reader
 * directly — the same rule the conformance drivers hold themselves to.
 */

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Drive the command line against a temporary store, as a caller would. */
async function broker(argv: readonly string[], directory: () => string): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    streams: { out: (line) => out.push(line), err: (line) => err.push(line) },
    env: { BROKER_DB: `${directory()}/broker.db` },
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('with no arguments it READS THE ROWS BACK, most recent first', async () => {
  const temp = makeTempStore();
  try {
    const store = await prepareStore(temp.environment);
    try {
      await recordFeedback(store.db, {
        rating: 1,
        category: 'no-path',
        note: 'Came for a capability this surface does not offer and could not find it.',
      });
      await recordFeedback(store.db, {
        rating: 5,
        category: 'worked-well',
        note: 'The snapshot-then-act loop meant I never needed a picture to find an element.',
      });
    } finally {
      store.close();
    }

    const result = await broker(['feedback'], () => temp.directory);
    assert.equal(result.code, 0, result.err);
    // Most recent first: the positive row, written second, comes first.
    assert.ok(
      result.out.indexOf('worked-well') < result.out.indexOf('no-path'),
      'the rows were not most recent first',
    );
    assert.match(result.out, /5\/5/u);
    assert.match(result.out, /1\/5/u);
  } finally {
    temp.remove();
  }
});

test('--category narrows the reading', async () => {
  const temp = makeTempStore();
  try {
    const store = await prepareStore(temp.environment);
    try {
      await recordFeedback(store.db, {
        rating: 1,
        category: 'no-path',
        note: 'Came for a capability this surface does not offer and could not find it.',
      });
      await recordFeedback(store.db, {
        rating: 5,
        category: 'worked-well',
        note: 'The snapshot-then-act loop meant I never needed a picture to find an element.',
      });
    } finally {
      store.close();
    }

    const result = await broker(['feedback', '--category', 'no-path'], () => temp.directory);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /no-path/u);
    assert.equal(/worked-well/u.test(result.out), false, 'the filter did not narrow anything');
  } finally {
    temp.remove();
  }
});

test('an empty store reports SILENCE in words, and says what it means', async () => {
  const temp = makeTempStore();
  try {
    const result = await broker(['feedback'], () => temp.directory);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /No feedback has been recorded/u);
    assert.match(result.out, /silence is its success condition/u);
  } finally {
    temp.remove();
  }
});

test('a misspelled category is refused with the list, rather than reading as silence', async () => {
  const temp = makeTempStore();
  try {
    const result = await broker(['feedback', '--category', 'nopath'], () => temp.directory);
    assert.notEqual(result.code, 0, 'a misspelled category was accepted');
    assert.match(result.err, /unknown_category/u);
    assert.match(result.err, /no-path/u);
    // And it did not print an empty listing, which is the reading that would
    // have been mistaken for the exit condition.
    assert.equal(/No feedback has been recorded/u.test(result.out), false);
  } finally {
    temp.remove();
  }
});

test('--json produces one document, with the rows as data', async () => {
  const temp = makeTempStore();
  try {
    const store = await prepareStore(temp.environment);
    try {
      await recordFeedback(store.db, {
        rating: 3,
        category: 'surprised-me',
        note: 'It worked, but the result came back as a path rather than the content.',
      });
    } finally {
      store.close();
    }

    const result = await broker(['feedback', '--json'], () => temp.directory);
    assert.equal(result.code, 0, result.err);
    const document = JSON.parse(result.out) as {
      outcome: string;
      value: { feedback: { rating: number; category: string }[] };
    };
    assert.equal(document.outcome, 'accepted');
    assert.equal(document.value.feedback.length, 1);
    assert.equal(document.value.feedback[0]?.rating, 3);
    assert.equal(document.value.feedback[0]?.category, 'surprised-me');
  } finally {
    temp.remove();
  }
});

test('READING IS THE DEFAULT and writing is the flagged case', () => {
  // A caller that meant to read never accidentally writes, and a caller that
  // meant to write and mistyped the flag gets a listing rather than a row it
  // did not intend.
  assert.equal(isReadingFeedback([]), true);
  assert.equal(isReadingFeedback(['--category', 'no-path']), true);
  assert.equal(isReadingFeedback(['--json']), true);
  assert.equal(isReadingFeedback(['--rating', '4', '--category', 'worked-well']), false);
  assert.equal(isReadingFeedback(['--rating=4']), false);
});

test('the WRITING half still routes to the service, not to the reader', async () => {
  // With no service supplied the command line refuses honestly rather than
  // pretending (`serviceUnavailable`). What this asserts is the routing: a
  // submission reaches the operation path, so it is NOT answered with a
  // listing.
  const temp = makeTempStore();
  try {
    const result = await broker(
      [
        'feedback',
        '--rating',
        '4',
        '--category',
        'worked-well',
        '--note',
        'The snapshot-then-act loop meant I never needed a picture to find an element.',
      ],
      () => temp.directory,
    );
    assert.notEqual(result.code, 0, 'a write was answered as though it had succeeded');
    assert.equal(
      /No feedback has been recorded/u.test(result.out),
      false,
      'a submission was answered with a listing',
    );
    assert.match(result.err, /service/u);
  } finally {
    temp.remove();
  }
});
