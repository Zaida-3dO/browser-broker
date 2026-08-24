import assert from 'node:assert/strict';

import test from 'node:test';

import {
  EVENT_ADAPTERS,
  EVENT_KINDS,
  append,
  readSince,
  type EventKind,
} from '../../src/service/events.ts';
import { withSteppedStore } from '../helpers/temp-store.ts';

/**
 * The ledger, and the thing it exists to make possible: answering "was this
 * rule ever actually reached" (`SCHEMA.md` §1.6).
 *
 * The assertion that carries the row is the one about **both** outcomes. A
 * ledger of refusals cannot answer that question and a ledger of grants
 * cannot show a guard firing, so a test that only exercised one of them would
 * pass over exactly the half that was missing.
 */

test('a decision is recorded whether it was allowed or refused', async () => {
  await withSteppedStore(async (store) => {
    await store.immediate(({ db }) => {
      append(db, {
        kind: 'claim_requested',
        outcome: 'allow',
        adapter: 'cli',
        sessionId: 'session-a',
      });
      append(db, {
        kind: 'claim_requested',
        outcome: 'deny',
        guard: 'claim.browser_known',
        adapter: 'cli',
        sessionId: 'session-b',
      });
      return { value: null };
    });

    const rows = readSince(store.db, 0, 10);
    assert.equal(rows.length, 2);

    // Named individually rather than counted. A crew on this repository
    // shipped a check that iterated a list instead of naming its entries, so
    // deleting an entry stayed green; asserting the pair by name is what
    // makes dropping either half fail here.
    const allowed = rows.find((row) => row.outcome === 'allow');
    const refused = rows.find((row) => row.outcome === 'deny');

    assert.ok(allowed, 'no allowed decision was recorded');
    assert.equal(allowed.guard, null, 'an allow carries no guard — nothing refused it');
    assert.equal(allowed.sessionId, 'session-a');

    assert.ok(refused, 'no refused decision was recorded');
    assert.equal(refused.guard, 'claim.browser_known', 'a denial names the rule that refused');
    assert.equal(refused.sessionId, 'session-b');
  });
});

test('a refusal before any lease existed is still attributable to a session', async () => {
  // §1.6 calls session_id "the one denormalisation in the schema that earns
  // its place outright": a refused request never becomes a lease, so without
  // this column every refusal on the busiest rule in the service is
  // anonymous.
  await withSteppedStore(async (store) => {
    await store.immediate(({ db }) => {
      append(db, {
        kind: 'claim_requested',
        outcome: 'deny',
        guard: 'browser.serving',
        adapter: 'tool-stdio',
        sessionId: 'session-c',
        claimId: null,
      });
      return { value: null };
    });

    const [row] = readSince(store.db, 0, 10);
    assert.ok(row);
    assert.equal(row.claimId, null, 'there was no lease, so there is no lease to name');
    assert.equal(row.sessionId, 'session-c', 'and yet the refusal is not anonymous');
  });
});

test('the store refuses a denial with no rule name', async () => {
  // The type system refuses this at every call site in this repository; the
  // constraint is the backstop for anything reaching the table another way.
  // Asserting it here is what proves the backstop is real rather than
  // assumed — the single change that breaks this test is dropping the CHECK
  // from the schema.
  await withSteppedStore(async (store) => {
    await assert.rejects(
      store.immediate(({ db }) => {
        db.prepare(
          `INSERT INTO events (kind, outcome, guard, adapter) VALUES ('sweep', 'deny', NULL, 'internal')`,
        ).run();
        return { value: null };
      }),
      /CHECK constraint failed/,
    );
  });
});

test('the store refuses an allow that names a rule', async () => {
  // The mirror, and the one more likely to happen by accident: a guard left
  // over from the branch above invents a rule firing that never fired.
  await withSteppedStore(async (store) => {
    await assert.rejects(
      store.immediate(({ db }) => {
        db.prepare(
          `INSERT INTO events (kind, outcome, guard, adapter) VALUES ('sweep', 'allow', 'key.valid', 'internal')`,
        ).run();
        return { value: null };
      }),
      /CHECK constraint failed/,
    );
  });
});

test('detail is stored as text and absent detail is null rather than the word null', async () => {
  await withSteppedStore(async (store) => {
    await store.immediate(({ db }) => {
      append(db, { kind: 'sweep', outcome: 'allow', adapter: 'internal', detail: { expired: 3 } });
      append(db, { kind: 'sweep', outcome: 'allow', adapter: 'internal' });
      return { value: null };
    });

    const [withDetail, without] = readSince(store.db, 0, 10);
    assert.ok(withDetail && without);
    assert.deepEqual(JSON.parse(withDetail.detail ?? ''), { expired: 3 });
    // The four characters `null` in the column would be a detail object
    // saying nothing, which reads differently from no detail at all.
    assert.equal(without.detail, null);
  });
});

test('the ledger reads back in order, from a cursor, without repeating or skipping', async () => {
  await withSteppedStore(async (store) => {
    await store.immediate(({ db }) => {
      for (let index = 0; index < 5; index += 1) {
        append(db, { kind: 'sweep', outcome: 'allow', adapter: 'internal', detail: { index } });
      }
      return { value: null };
    });

    const first = readSince(store.db, 0, 2);
    assert.deepEqual(
      first.map((row) => (JSON.parse(row.detail ?? '') as { index: number }).index),
      [0, 1],
      'the slice is oldest first',
    );

    const second = readSince(store.db, first[1]?.id ?? 0, 2);
    assert.deepEqual(
      second.map((row) => (JSON.parse(row.detail ?? '') as { index: number }).index),
      [2, 3],
      'the cursor is exclusive, so nothing repeats across the boundary',
    );
  });
});

test('the slice follows the cursor even when the timestamps disagree with it', async () => {
  // The assertion that separates the two orderings, which the test above
  // cannot: written normally, every row in one transaction shares a timestamp
  // to the millisecond, and the engine happens to return them in insertion
  // order anyway — so a hand-run mutation swapping `ORDER BY id` for
  // `ORDER BY at` survived it.
  //
  // Here the timestamps are set deliberately backwards, so the two orderings
  // give different answers and only one of them is the cursor's. Section 1.6
  // makes the counter the cursor precisely because `at` has ties and no
  // defined order within them, which is how a page over the ledger comes to
  // skip or repeat a row at a boundary.
  await withSteppedStore(async (store) => {
    await store.immediate(({ db }) => {
      for (let index = 0; index < 4; index += 1) {
        const id = append(db, {
          kind: 'sweep',
          outcome: 'allow',
          adapter: 'internal',
          detail: { index },
        });
        // Later rows get earlier stamps. Nothing in the service writes `at`
        // by hand — this is the test manufacturing the disagreement.
        db.prepare('UPDATE events SET at = ? WHERE id = ?').run(
          `2020-01-0${String(4 - index)}T00:00:00.000Z`,
          id,
        );
      }
      return { value: null };
    });

    const indexOf = (row: { detail: string | null }): number =>
      (JSON.parse(row.detail ?? '') as { index: number }).index;

    assert.deepEqual(
      readSince(store.db, 0, 10).map(indexOf),
      [0, 1, 2, 3],
      'the slice came back in timestamp order, not cursor order',
    );

    // And the disagreement is real rather than assumed: by timestamp the same
    // rows are the other way round.
    assert.deepEqual(
      [...readSince(store.db, 0, 10)].sort((a, b) => a.at.localeCompare(b.at)).map(indexOf),
      [3, 2, 1, 0],
    );
  });
});

test('the identifier counts upward, which is what makes it usable as a cursor', async () => {
  await withSteppedStore(async (store) => {
    const ids = await store.immediate(({ db }) => ({
      value: {
        first: append(db, { kind: 'sweep', outcome: 'allow', adapter: 'internal' }),
        second: append(db, { kind: 'sweep', outcome: 'allow', adapter: 'internal' }),
      },
    }));
    assert.ok(ids.second > ids.first, `identifiers did not increase: ${JSON.stringify(ids)}`);
  });
});

test('a ledger row rolls back with the decision that wrote it', async () => {
  // The reason `append` takes the caller's handle rather than opening its
  // own connection: a ledger row for a transaction that rolled back is a
  // record of something that did not happen.
  await withSteppedStore(async (store) => {
    await assert.rejects(
      store.immediate(({ db }) => {
        append(db, { kind: 'claim_granted', outcome: 'allow', adapter: 'cli' });
        throw new Error('deliberate');
      }),
      /deliberate/,
    );
    assert.deepEqual(readSince(store.db, 0, 10), []);
  });
});

test('every kind this module declares is one the store accepts', async () => {
  // The duplication between this module's union and the schema's CHECK
  // constraint is real and has a real failure mode: adding a kind to one and
  // not the other. Rather than trusting them to stay equal, each declared
  // kind is inserted — so a kind in the union that the store refuses fails
  // here, naming itself.
  await withSteppedStore(async (store) => {
    for (const kind of EVENT_KINDS) {
      await store.immediate(({ db }) => {
        append(db, { kind, outcome: 'allow', adapter: 'internal' });
        return { value: null };
      });
    }
    const rows = readSince(store.db, 0, 100);
    assert.deepEqual(
      rows.map((row) => row.kind),
      [...EVENT_KINDS],
    );
  });
});

test('every kind the store accepts is one this module declares', async () => {
  // The other direction, and the one the loop above cannot catch: a kind
  // added to the schema and forgotten here would leave this module unable to
  // record it, silently, with no test failing. Read out of the constraint
  // rather than written down a third time.
  await withSteppedStore((store) => {
    const schema = store.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'`)
      .get() as { sql: string };

    const clause = /kind\s+TEXT\s+NOT NULL\s+CHECK\s*\(kind IN \(([\s\S]*?)\)\)/.exec(schema.sql);
    assert.ok(clause, 'the events table does not constrain kind to a fixed list');

    const listed = clause[1] ?? '';
    const inStore = [...listed.matchAll(/'([^']+)'/g)].map((match) => match[1] as EventKind);
    assert.deepEqual([...inStore].sort(), [...EVENT_KINDS].sort());
  });
});

test('the four doors are named, and each is one the store accepts', async () => {
  // Named rather than iterated. A loop over EVENT_ADAPTERS asserting the rows
  // equal EVENT_ADAPTERS is true for *any* list, including one an entry has
  // been deleted from — a hand-run mutation removing 'internal' survived
  // exactly that shape. Section 1.6 fixes the set at four, so the four are
  // written out and the count is asserted.
  assert.deepEqual([...EVENT_ADAPTERS].sort(), ['cli', 'internal', 'tool-http', 'tool-stdio']);

  await withSteppedStore(async (store) => {
    for (const adapter of ['tool-stdio', 'tool-http', 'cli', 'internal'] as const) {
      await store.immediate(({ db }) => {
        append(db, { kind: 'sweep', outcome: 'allow', adapter });
        return { value: null };
      });
    }
    assert.deepEqual(
      readSince(store.db, 0, 100).map((row) => row.adapter),
      ['tool-stdio', 'tool-http', 'cli', 'internal'],
    );
  });
});

test('every adapter the store accepts is one this module declares', async () => {
  // The other direction, read out of the constraint the store actually
  // carries — so an adapter added to the schema and forgotten here fails,
  // naming itself, rather than leaving this module unable to record a door
  // that exists.
  await withSteppedStore((store) => {
    const schema = store.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'`)
      .get() as { sql: string };

    const clause = /adapter[\s\S]*?CHECK \(adapter IN \(([\s\S]*?)\)\)/.exec(schema.sql);
    assert.ok(clause, 'the events table does not constrain adapter to a fixed list');

    const listed = clause[1] ?? '';
    const inStore = [...listed.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual([...inStore].sort(), [...EVENT_ADAPTERS].sort());
  });
});

test('an unrecognised kind is refused by the store, not silently stored', async () => {
  // The control for the two walks above. Without it, a store that accepted
  // anything would satisfy both of them and neither would be a check.
  await withSteppedStore(async (store) => {
    await assert.rejects(
      store.immediate(({ db }) => {
        append(db, {
          kind: 'not_a_kind' as EventKind,
          outcome: 'allow',
          adapter: 'internal',
        });
        return { value: null };
      }),
      /CHECK constraint failed/,
    );
  });
});
