import assert from 'node:assert/strict';
import test from 'node:test';

import { StartupRefusal } from '../../src/errors.ts';
import { openStore, type StoreHandle } from '../../src/store/open.ts';
import { readStoreVersion, stepSchema } from '../../src/store/schema/step.ts';
import { EXPECTED_VERSION, STEPS, type Step } from '../../src/store/schema/steps.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

function withStore(fn: (store: StoreHandle) => Promise<void>): () => Promise<void> {
  return async () => {
    const temp = makeTempStore();
    try {
      const store = openStore(temp.environment);
      try {
        await fn(store);
      } finally {
        store.close();
      }
    } finally {
      temp.remove();
    }
  };
}

test('the step list is empty — step one is the whole schema and belongs to a later row', () => {
  assert.equal(STEPS.length, 0);
  assert.equal(EXPECTED_VERSION, 0);
});

test(
  'a fresh store reports version zero and stepping it is a no-op',
  withStore(async (store) => {
    assert.equal(readStoreVersion(store.db), 0);
    const result = await stepSchema(store.db);
    assert.deepEqual(result, { from: 0, to: 0, applied: [] });
  }),
);

test(
  'a store newer than the build refuses rather than downgrading',
  withStore(async (store) => {
    // Two callers on different builds against one store is an ordinary
    // situation here, and guessing is how one of them corrupts it.
    store.db.pragma('user_version = 9');
    await assert.rejects(stepSchema(store.db), (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.equal(error.rule, 'startup.schema_stepped');
      assert.match(error.message, /9/);
      return true;
    });
    // Nothing was written: the version is untouched, not reset.
    assert.equal(readStoreVersion(store.db), 9);
  }),
);

test(
  'steps are applied in order and the version is stamped',
  withStore(async (store) => {
    const order: number[] = [];
    const steps: Step[] = [
      {
        version: 2,
        summary: 'second',
        apply: (db) => {
          order.push(2);
          db.exec('CREATE TABLE second (id INTEGER PRIMARY KEY)');
        },
      },
      {
        version: 1,
        summary: 'first',
        apply: (db) => {
          order.push(1);
          db.exec('CREATE TABLE first (id INTEGER PRIMARY KEY)');
        },
      },
    ];

    const result = await stepSchema(store.db, steps, 2);
    // Declared out of order above, applied in order here.
    assert.deepEqual(order, [1, 2]);
    assert.deepEqual(result, { from: 0, to: 2, applied: [1, 2] });
    assert.equal(readStoreVersion(store.db), 2);
  }),
);

test(
  'only the steps after the store’s version are applied',
  withStore(async (store) => {
    store.db.pragma('user_version = 1');
    const applied: number[] = [];
    const steps: Step[] = [
      {
        version: 1,
        summary: 'already run',
        apply: () => {
          applied.push(1);
        },
      },
      {
        version: 2,
        summary: 'pending',
        apply: () => {
          applied.push(2);
        },
      },
    ];
    const result = await stepSchema(store.db, steps, 2);
    // A step that has run somewhere is history; re-running it is how two
    // installations end up reporting one version with different schemas.
    assert.deepEqual(applied, [2]);
    assert.deepEqual(result.applied, [2]);
  }),
);

test(
  'a failing step leaves the store at the version it started at',
  withStore(async (store) => {
    const steps: Step[] = [
      {
        version: 1,
        summary: 'creates a table',
        apply: (db) => {
          db.exec('CREATE TABLE partial (id INTEGER PRIMARY KEY)');
        },
      },
      {
        version: 2,
        summary: 'fails',
        apply: () => {
          throw new Error('step two failed');
        },
      },
    ];
    await assert.rejects(stepSchema(store.db, steps, 2), /step two failed/);
    // The steps run in one transaction, so the half-applied schema is gone
    // and the version never moved.
    assert.equal(readStoreVersion(store.db), 0);
    const table = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial'")
      .get();
    assert.equal(table, undefined);
  }),
);
