import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { openStore, type StoreHandle } from '../../src/store/open.ts';
import { BEGIN_STATEMENT } from '../../src/store/transaction.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/** A second connection to the same file, for the outside-the-transaction check. */
function openStoreForRead(location: string): import('better-sqlite3').Database {
  // Reached through require here rather than imported at the top, so the
  // store module stays the only place application code reaches the driver.
  const Database = createRequire(import.meta.url)(
    'better-sqlite3',
  ) as typeof import('better-sqlite3');
  return new Database(location, { readonly: true });
}

function withStore(fn: (store: StoreHandle) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const temp = makeTempStore();
    try {
      const store = openStore(temp.environment);
      try {
        store.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)');
        await fn(store);
      } finally {
        store.close();
      }
    } finally {
      temp.remove();
    }
  };
}

// The single-character change that breaks this test is dropping IMMEDIATE.
// The mode is correctness rather than tuning: 30 concurrent processes on an
// immediate transaction all succeeded, and the same test deferred failed 15
// times in 25 with an error the busy timeout cannot retry.
test('the transaction declares its intent to write when it opens', () => {
  assert.equal(BEGIN_STATEMENT, 'BEGIN IMMEDIATE');
});

test(
  'the statement the helper actually issues contains the immediate keyword',
  withStore(async (store) => {
    // Asserting the constant alone would pass if the helper stopped using it.
    // This records what is prepared, so renaming the constant or bypassing it
    // fails here.
    const prepared: string[] = [];
    const original = store.db.prepare.bind(store.db);
    const spy = (sql: string): ReturnType<typeof original> => {
      prepared.push(sql);
      return original(sql);
    };
    Object.defineProperty(store.db, 'prepare', { value: spy, configurable: true });

    await store.immediate(() => ({ value: null }));

    Object.defineProperty(store.db, 'prepare', { value: original, configurable: true });
    assert.ok(
      prepared.some((sql) => /^BEGIN\s+IMMEDIATE$/i.test(sql.trim())),
      `no immediate begin was issued; statements were ${JSON.stringify(prepared)}`,
    );
  }),
);

test(
  'a committed transaction keeps its writes',
  withStore(async (store) => {
    const value = await store.immediate(({ db }) => {
      db.prepare('INSERT INTO t (id, note) VALUES (1, ?)').run('kept');
      return { value: 'done' };
    });
    assert.equal(value, 'done');
    const row = store.db.prepare('SELECT note FROM t WHERE id = 1').get() as
      { note: string } | undefined;
    assert.equal(row?.note, 'kept');
  }),
);

test(
  'a throw rolls back — the write is absent, not merely reported as failed',
  withStore(async (store) => {
    await assert.rejects(
      store.immediate(({ db }) => {
        db.prepare('INSERT INTO t (id, note) VALUES (2, ?)').run('discarded');
        throw new Error('deliberate');
      }),
      /deliberate/,
    );
    // The assertion that matters: the row is gone. A helper that reported the
    // throw but committed anyway would pass a test that only checked it threw.
    const row = store.db.prepare('SELECT note FROM t WHERE id = 2').get();
    assert.equal(row, undefined);
    // And the transaction is closed, so the next one can open.
    await store.immediate(() => ({ value: null }));
  }),
);

test(
  'after-commit actions run after the commit, not inside it',
  withStore(async (store) => {
    let noteAtActionTime: string | undefined;
    await store.immediate(({ db }) => {
      db.prepare('INSERT INTO t (id, note) VALUES (3, ?)').run('visible');
      return {
        value: null,
        afterCommit: [
          () => {
            // If this ran inside the transaction, a separate connection would
            // not see the row. Reading it back on a fresh handle is what
            // distinguishes the two.
            const other = openStoreForRead(store.location);
            try {
              const row = other.prepare('SELECT note FROM t WHERE id = 3').get() as
                { note: string } | undefined;
              noteAtActionTime = row?.note;
            } finally {
              other.close();
            }
          },
        ],
      };
    });
    assert.equal(noteAtActionTime, 'visible');
  }),
);

test(
  'an after-commit failure does not undo the commit',
  withStore(async (store) => {
    // Best effort by design: closing a tab that will not close is not a
    // reason to report failed work that succeeded.
    const value = await store.immediate(({ db }) => {
      db.prepare('INSERT INTO t (id, note) VALUES (4, ?)').run('committed');
      return {
        value: 'ok',
        afterCommit: [
          () => {
            throw new Error('the tab would not close');
          },
        ],
      };
    });
    assert.equal(value, 'ok');
    const row = store.db.prepare('SELECT note FROM t WHERE id = 4').get() as
      { note: string } | undefined;
    assert.equal(row?.note, 'committed');
  }),
);
