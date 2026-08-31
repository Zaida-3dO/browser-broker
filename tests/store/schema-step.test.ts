import assert from 'node:assert/strict';
import test from 'node:test';

import { StartupRefusal } from '../../src/errors.ts';
import { openStoreForDiagnosis as openStore, type StoreHandle } from '../../src/store/open.ts';

// `openStoreForDiagnosis` is the raw open — no schema step, no budget
// agreement — aliased here because that is exactly what these tests are about:
// the open itself, below the spawn path. It is the only export that reaches
// the raw open, deliberately, so that a caller wanting one has to name what it
// is doing (see `src/store/open.ts`); a test of the open qualifies.
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

test('the step list is one-based, contiguous, and ends at the version this build expects', () => {
  // The version is stamped rather than counted, so the two can disagree —
  // and this is the assertion that says so if they ever do.
  STEPS.forEach((step, index) => {
    assert.equal(step.version, index + 1);
  });
  assert.equal(STEPS.at(-1)?.version, EXPECTED_VERSION);
});

test(
  'a fresh store is at version zero and stepping it applies every step in order',
  withStore(async (store) => {
    assert.equal(readStoreVersion(store.db), 0);
    const result = await stepSchema(store.db);
    assert.equal(result.from, 0);
    assert.equal(result.to, EXPECTED_VERSION);
    assert.deepEqual(
      result.applied,
      STEPS.map((step) => step.version),
    );
  }),
);

test(
  'stepping a store that is already at the expected version does nothing',
  withStore(async (store) => {
    await stepSchema(store.db);
    // The second call is the one every spawn after the first makes.
    const again = await stepSchema(store.db);
    assert.deepEqual(again, { from: EXPECTED_VERSION, to: EXPECTED_VERSION, applied: [] });
  }),
);

test(
  'a store newer than the build refuses rather than downgrading',
  withStore(async (store) => {
    // Two callers on different builds against one store is an ordinary
    // situation here, and guessing is how one of them corrupts it.
    // One past what this build knows how to step to, so it stays "newer"
    // whatever that number is. Written as a literal rather than derived from
    // EXPECTED_VERSION deliberately: deriving it would make the test agree
    // with the build by construction, and the assertion is precisely that a
    // build refuses a version it does not know.
    store.db.pragma('user_version = 10');
    await assert.rejects(stepSchema(store.db), (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.equal(error.rule, 'startup.schema_stepped');
      assert.match(error.message, /10/);
      return true;
    });
    // Nothing was written: the version is untouched, not reset.
    assert.equal(readStoreVersion(store.db), 10);
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

/**
 * ── Stepping a store that has REAL data in it ────────────────────────────
 *
 * The tests above step empty stores, which is the state a fixture reaches and
 * **not** the state an installation reaches. That gap shipped a defect: step
 * five rebuilds `events` to widen a check constraint, and rebuilding means
 * dropping — which violates `feedback.last_event_id`'s reference to
 * `events (id)` on any store where a caller has left feedback naming an event.
 *
 * Every existing feedback fixture omits `last_event_id`, so nothing reached
 * the state that breaks. **The fixtures were cleaner than production**, which
 * is the mirror image of seeding a state the product cannot reach and is just
 * as capable of turning a whole suite green over a broken migration.
 *
 * The consequence was total for the affected installation: the stepper runs on
 * every spawn, `prepareStore` rethrows, and there is no long-lived process to
 * still be serving — so the store simply stops opening, and it stops opening
 * for exactly the installations that have been used enough to collect
 * feedback.
 */

/** Step a store to an intermediate version, the way a real store arrives at one. */
async function stepTo(store: StoreHandle, version: number): Promise<void> {
  await stepSchema(
    store.db,
    STEPS.filter((step) => step.version <= version),
    version,
  );
}

test(
  'A STORE WITH FEEDBACK NAMING AN EVENT STEPS TO THE CURRENT VERSION',
  withStore(async (store) => {
    // The production shape the fixtures were missing: feedback that points at
    // a ledger row, which is what `feedback.last_event_id` exists to hold.
    await stepTo(store, 4);

    store.db
      .prepare(
        `INSERT INTO events (kind, outcome, adapter) VALUES ('claim_requested', 'allow', 'cli')`,
      )
      .run();
    const event = store.db.prepare('SELECT id FROM events').get() as { id: number };
    store.db
      .prepare(
        `INSERT INTO feedback (session_id, last_event_id, rating, category, note)
         VALUES ('session-1', ?, 3, 'no-path', 'a note comfortably over the length floor')`,
      )
      .run(event.id);

    // References are enforced on this handle, exactly as `openStore` leaves
    // them — so this is the real path and not a relaxed one.
    assert.equal(store.pragma('foreign_keys'), 1);

    await stepSchema(store.db);

    assert.equal(readStoreVersion(store.db), EXPECTED_VERSION);

    // The row survived the rebuild and still names the event it named.
    const feedback = store.db
      .prepare('SELECT last_event_id AS lastEventId FROM feedback')
      .get() as { lastEventId: number };
    assert.equal(
      feedback.lastEventId,
      event.id,
      'the reference must survive the rebuild, not merely be permitted to break',
    );

    // And the reference actually resolves, rather than pointing at nothing.
    assert.deepEqual(
      store.db.pragma('foreign_key_check'),
      [],
      'no row may name something that does not exist after stepping',
    );
  }),
);

test(
  'stepping LEAVES REFERENCES ENFORCED, so a later write is still checked',
  withStore(async (store) => {
    // The pragma is suspended for the rebuild. If it were left off, the
    // handle the caller goes on to use would silently stop enforcing every
    // reference in the schema — a far quieter defect than the one being
    // fixed, and one no other test would notice.
    await stepSchema(store.db);

    assert.equal(store.pragma('foreign_keys'), 1, 'references are enforced again after stepping');

    assert.throws(
      () => {
        store.db
          .prepare(
            `INSERT INTO feedback (session_id, last_event_id, rating, category, note)
             VALUES ('session-1', 999999, 3, 'no-path', 'a note comfortably over the length floor')`,
          )
          .run();
      },
      /FOREIGN KEY constraint failed/,
      'a feedback row naming an event that does not exist must still be refused',
    );
  }),
);

test(
  'a step that BREAKS a reference is refused rather than committed',
  withStore(async (store) => {
    // Suspending enforcement for the rebuild is only safe because something
    // checks the result before it commits. This proves that check is real: a
    // deliberately bad step deletes a referenced row, and the integrity check
    // inside the transaction must catch what the pragma was not enforcing.
    await stepTo(store, 4);
    store.db
      .prepare(
        `INSERT INTO events (kind, outcome, adapter) VALUES ('claim_requested', 'allow', 'cli')`,
      )
      .run();
    const event = store.db.prepare('SELECT id FROM events').get() as { id: number };
    store.db
      .prepare(
        `INSERT INTO feedback (session_id, last_event_id, rating, category, note)
         VALUES ('session-1', ?, 3, 'no-path', 'a note comfortably over the length floor')`,
      )
      .run(event.id);

    const orphaning: Step = {
      version: 5,
      summary: 'A step that leaves feedback naming an event which is absent.',
      apply: (db) => {
        db.exec('DELETE FROM events');
      },
    };

    await assert.rejects(
      stepSchema(store.db, [...STEPS.filter((step) => step.version <= 4), orphaning], 5),
      StartupRefusal,
    );

    // Rolled back: the version did not move and the data is untouched.
    assert.equal(readStoreVersion(store.db), 4);
    assert.equal(store.db.prepare('SELECT id FROM events').all().length, 1);
  }),
);
