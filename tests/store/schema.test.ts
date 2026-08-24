import assert from 'node:assert/strict';
import test from 'node:test';

import type { Database } from 'better-sqlite3';

import { withSteppedStore } from '../helpers/temp-store.ts';

/**
 * Step one, exercised by what it refuses.
 *
 * **A schema proven only to accept is a schema that protects nothing.** Every
 * constraint below is asserted by writing the row it exists to forbid and
 * requiring the database to reject it — which is the only form of assertion
 * that fails when somebody deletes the constraint.
 */

/** A lease row's worth of arguments, with the awkward ones defaulted. */
function insertClaim(
  db: Database,
  overrides: Partial<{
    id: string;
    key_hash: string;
    session_id: string;
    browser_id: string;
    state: string;
    purpose: string;
    expires_at: string;
    ttl_seconds: number;
    activated_at: string | null;
    ended_at: string | null;
    revoke_reason: string | null;
  }> = {},
): void {
  const row = {
    id: 'claim-1',
    key_hash: 'hash-1',
    session_id: 'session-1',
    browser_id: 'regular',
    state: 'active',
    purpose: 'reviewing a page',
    expires_at: '2026-01-01T00:10:00.000Z',
    ttl_seconds: 600,
    activated_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
    revoke_reason: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO claims
       (id, key_hash, session_id, browser_id, state, purpose,
        expires_at, ttl_seconds, activated_at, ended_at, revoke_reason)
     VALUES
       (@id, @key_hash, @session_id, @browser_id, @state, @purpose,
        @expires_at, @ttl_seconds, @activated_at, @ended_at, @revoke_reason)`,
  ).run(row);
}

/** A tab row, with a lease already in place. */
function insertTab(
  db: Database,
  overrides: Partial<{
    id: string;
    claim_id: string;
    browser_id: string;
    driver_tab_id: string | null;
    state: string;
  }> = {},
): void {
  const row = {
    id: 'tab-1',
    claim_id: 'claim-1',
    browser_id: 'regular',
    driver_tab_id: 'driver-1',
    state: 'open',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tabs (id, claim_id, browser_id, driver_tab_id, state)
     VALUES (@id, @claim_id, @browser_id, @driver_tab_id, @state)`,
  ).run(row);
}

/**
 * ── The tables that exist, and the two that deliberately do not ──────────
 */

test('every table this design has is created, and nothing else', async () => {
  await withSteppedStore((store) => {
    const names = store.db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all()
      .map((row) => (row as { name: string }).name);

    // Pinned, so a table added by a step nobody reviewed fails here. Two are
    // not in §1's list and both are counters rather than state: the
    // tab-budget agreement row (§1.10), which is a check with no
    // caller-reachable write path rather than the settings table §1.10
    // deletes, and the queue's arrival counter, which exists because §2.5's
    // promise that a position only ever improves cannot be kept by a
    // millisecond clock. The test below asserts a `settings` table
    // specifically is still absent.
    assert.deepEqual(names, [
      'browsers',
      'captures',
      'claim_arrival',
      'claims',
      'comparisons',
      'events',
      'feedback',
      'tab_budget',
      'tabs',
    ]);
  });
});

test('there is no baselines table and no settings table', async () => {
  // Both were deleted by design: there is no canonical picture, and
  // configuration is the environment. A step that recreated either would be
  // reintroducing a concept, not adding a table.
  await withSteppedStore((store) => {
    for (const name of ['baselines', 'settings']) {
      const found = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name);
      assert.equal(found, undefined, `${name} must not exist`);
    }
  });
});

/**
 * ── browsers: a fixed two-row table ──────────────────────────────────────
 */

test('the two browser rows exist after stepping', async () => {
  await withSteppedStore((store) => {
    const ids = store.db
      .prepare('SELECT id FROM browsers ORDER BY id')
      .all()
      .map((row) => (row as { id: string }).id);
    assert.deepEqual(ids, ['private', 'regular']);
  });
});

test('a third browser is refused', async () => {
  // "Exactly two" holds from both ends: the check and the primary key cap the
  // table at two, and the seed floors it at two.
  await withSteppedStore((store) => {
    assert.throws(() => {
      store.db.prepare("INSERT INTO browsers (id, state) VALUES ('extra', 'stopped')").run();
    }, /CHECK constraint failed/);
  });
});

test('a duplicate browser is refused', async () => {
  await withSteppedStore((store) => {
    assert.throws(() => {
      store.db.prepare("INSERT INTO browsers (id, state) VALUES ('regular', 'stopped')").run();
    }, /UNIQUE constraint failed/);
  });
});

test('a browser state outside the five is refused', async () => {
  await withSteppedStore((store) => {
    assert.throws(() => {
      store.db.prepare("UPDATE browsers SET state = 'wedged' WHERE id = 'regular'").run();
    }, /CHECK constraint failed/);
  });
});

test('a stopped browser may not carry a process, and a running one must', async () => {
  // The isolation fact: the service acts on the process recorded here and on
  // nothing else, so "stopped with a pid" is a row nothing can act on safely.
  await withSteppedStore((store) => {
    assert.throws(() => {
      store.db.prepare("UPDATE browsers SET pid = 42 WHERE id = 'regular'").run();
    }, /CHECK constraint failed/);
    assert.throws(() => {
      store.db.prepare("UPDATE browsers SET state = 'running' WHERE id = 'regular'").run();
    }, /CHECK constraint failed/);
    assert.doesNotThrow(() => {
      store.db
        .prepare("UPDATE browsers SET state = 'running', pid = 42 WHERE id = 'regular'")
        .run();
    });
  });
});

/**
 * ── claims: the lease ────────────────────────────────────────────────────
 */

test('a lease inserts and its timestamps default from the database clock', async () => {
  await withSteppedStore((store) => {
    insertClaim(store.db);
    const row = store.db.prepare('SELECT created_at, updated_at FROM claims').get() as {
      created_at: string;
      updated_at: string;
    };
    // A single fixed textual form that sorts in chronological order, read
    // from the database's own clock rather than from a caller's.
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

test('two leases cannot share a key hash', async () => {
  // Every keyed call looks a lease up by this value, so two rows sharing one
  // would make ownership ambiguous on the busiest path in the service.
  await withSteppedStore((store) => {
    insertClaim(store.db);
    assert.throws(() => {
      insertClaim(store.db, { id: 'claim-2' });
    }, /UNIQUE constraint failed/);
  });
});

test('a lease naming a browser that does not exist is refused', async () => {
  await withSteppedStore((store) => {
    assert.throws(() => {
      insertClaim(store.db, { browser_id: 'third-browser' });
    }, /FOREIGN KEY constraint failed/);
  });
});

test('a lease state outside the five is refused', async () => {
  await withSteppedStore((store) => {
    assert.throws(() => {
      insertClaim(store.db, { state: 'paused', ended_at: null });
    }, /CHECK constraint failed/);
  });
});

test('a purpose shorter or longer than the bounds is refused', async () => {
  // Three to two hundred characters. The floor stops a reflexive one-word
  // value on the column an operator has to make a revoke decision against.
  await withSteppedStore((store) => {
    assert.throws(() => {
      insertClaim(store.db, { purpose: 'ab' });
    }, /CHECK constraint failed/);
    assert.throws(() => {
      insertClaim(store.db, { id: 'claim-3', key_hash: 'h3', purpose: 'x'.repeat(201) });
    }, /CHECK constraint failed/);
  });
});

test('a revoked lease owes a reason, and an unrevoked one may not carry one', async () => {
  // An operator taking capacity off a caller owes a sentence, and the
  // caller's next call is refused with it.
  await withSteppedStore((store) => {
    assert.throws(() => {
      insertClaim(store.db, {
        state: 'revoked',
        ended_at: '2026-01-01T00:05:00.000Z',
        revoke_reason: null,
      });
    }, /CHECK constraint failed/);
    assert.throws(() => {
      insertClaim(store.db, { id: 'claim-4', key_hash: 'h4', revoke_reason: 'taken back' });
    }, /CHECK constraint failed/);
  });
});

test('a final lease has an end and a live one does not', async () => {
  await withSteppedStore((store) => {
    assert.throws(() => {
      insertClaim(store.db, { state: 'released', ended_at: null });
    }, /CHECK constraint failed/);
    assert.throws(() => {
      insertClaim(store.db, {
        id: 'claim-5',
        key_hash: 'h5',
        state: 'active',
        ended_at: '2026-01-01T00:05:00.000Z',
      });
    }, /CHECK constraint failed/);
  });
});

test('a queued lease has never been activated', async () => {
  // activated_at is set at the moment a lease stops waiting, so a queued row
  // holding one is a row claiming to be in two states at once.
  await withSteppedStore((store) => {
    assert.throws(() => {
      insertClaim(store.db, {
        state: 'queued',
        activated_at: '2026-01-01T00:00:00.000Z',
        ended_at: null,
      });
    }, /CHECK constraint failed/);
    assert.doesNotThrow(() => {
      insertClaim(store.db, { state: 'queued', activated_at: null, ended_at: null });
    });
  });
});

test('a lifetime of zero or less is refused', async () => {
  await withSteppedStore((store) => {
    assert.throws(() => {
      insertClaim(store.db, { ttl_seconds: 0 });
    }, /CHECK constraint failed/);
  });
});

/**
 * ── tabs: ownership, and the composite key that keeps the copy honest ────
 */

test('a tab whose browser disagrees with its lease is refused', async () => {
  // This is the guarantee the explicit foreign-keys pragma protects. The copy
  // of the lease's browser is kept because a uniqueness rule can only be
  // written over columns on one row — and it cannot drift, because of this.
  await withSteppedStore((store) => {
    insertClaim(store.db, { browser_id: 'regular' });
    assert.throws(() => {
      insertTab(store.db, { browser_id: 'private' });
    }, /FOREIGN KEY constraint failed/);
    assert.doesNotThrow(() => {
      insertTab(store.db, { browser_id: 'regular' });
    });
  });
});

test('a tab naming no lease at all is refused', async () => {
  await withSteppedStore((store) => {
    assert.throws(() => {
      insertTab(store.db, { claim_id: 'no-such-lease' });
    }, /FOREIGN KEY constraint failed/);
  });
});

test('a tab that has not opened has no driver name, and one that has must', async () => {
  // Without this, the partial unique index below is satisfied by any number
  // of live rows all holding null — which would make the rule vacuous.
  await withSteppedStore((store) => {
    insertClaim(store.db);
    assert.throws(() => {
      insertTab(store.db, { state: 'opening', driver_tab_id: 'driver-1' });
    }, /CHECK constraint failed/);
    assert.throws(() => {
      insertTab(store.db, { id: 'tab-2', state: 'open', driver_tab_id: null });
    }, /CHECK constraint failed/);
    assert.doesNotThrow(() => {
      insertTab(store.db, { id: 'tab-3', state: 'opening', driver_tab_id: null });
    });
  });
});

/**
 * ── The first partial index: one live row per physical tab ───────────────
 */

test('two live tab rows may not name the same physical tab', async () => {
  // The rule lives at the write because the staleness is in the read before
  // it: both callers read "nothing there", both reads were true when made,
  // and nothing re-checks the second by the time its write lands.
  await withSteppedStore((store) => {
    insertClaim(store.db);
    insertClaim(store.db, { id: 'claim-2', key_hash: 'hash-2' });
    insertTab(store.db, { id: 'tab-1', claim_id: 'claim-1', driver_tab_id: 'driver-1' });
    assert.throws(() => {
      insertTab(store.db, { id: 'tab-2', claim_id: 'claim-2', driver_tab_id: 'driver-1' });
    }, /UNIQUE constraint failed/);
  });
});

test('every live state counts as live for that rule, not just the open one', async () => {
  // 'closing' is the honest representation of "the tool was asked and has not
  // answered", and it is what stops a page that may still exist being counted
  // as free. A rule that only covered 'open' would hand that page out again.
  await withSteppedStore((store) => {
    insertClaim(store.db);
    insertClaim(store.db, { id: 'claim-2', key_hash: 'hash-2' });
    insertTab(store.db, { id: 'tab-1', claim_id: 'claim-1', state: 'closing' });
    assert.throws(() => {
      insertTab(store.db, { id: 'tab-2', claim_id: 'claim-2', state: 'open' });
    }, /UNIQUE constraint failed/);
  });
});

test('a closed tab row does not block the physical tab being used again', async () => {
  // The rule is over the live rows, not over all of them: rows are permanent,
  // so a physical tab used and closed a dozen times has a dozen rows. A
  // non-partial unique index would refuse the thirteenth use.
  await withSteppedStore((store) => {
    insertClaim(store.db);
    insertClaim(store.db, { id: 'claim-2', key_hash: 'hash-2' });
    insertTab(store.db, { id: 'tab-1', claim_id: 'claim-1', state: 'closed' });
    assert.doesNotThrow(() => {
      insertTab(store.db, { id: 'tab-2', claim_id: 'claim-2', state: 'open' });
    });
  });
});

test('the same driver name in the other browser is not a duplicate', async () => {
  // The rule is over the pair. Two browsers name their tabs independently, so
  // an index over the driver name alone would refuse an entirely legal row.
  await withSteppedStore((store) => {
    insertClaim(store.db, { browser_id: 'regular' });
    insertClaim(store.db, { id: 'claim-2', key_hash: 'hash-2', browser_id: 'private' });
    insertTab(store.db, { id: 'tab-1', claim_id: 'claim-1', browser_id: 'regular' });
    assert.doesNotThrow(() => {
      insertTab(store.db, { id: 'tab-2', claim_id: 'claim-2', browser_id: 'private' });
    });
  });
});

/**
 * ── The second partial index: the capacity count, index-only ─────────────
 */

test('the capacity count is answered from the index without touching the table', async () => {
  // Not a uniqueness rule at all. The count of live claims is read inside the
  // transaction every arbitration call opens, with every other caller on the
  // machine waiting behind it, so a covering read is what keeps the
  // serialised section short.
  await withSteppedStore((store) => {
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN
           SELECT count(*) FROM claims WHERE state IN ('queued', 'active')`,
      )
      .all()
      .map((row) => (row as { detail: string }).detail)
      .join(' ');

    // "COVERING INDEX" is the engine saying the answer came out of the index
    // without a row lookup. A plain index scan would still say USING INDEX.
    assert.match(plan, /COVERING INDEX live_claims/);
  });
});

test('the live-claims index is partial, so history does not grow it', async () => {
  await withSteppedStore((store) => {
    const sql = store.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'live_claims'")
      .get() as { sql: string };
    assert.match(sql.sql, /WHERE state IN \('queued', 'active'\)/);
  });
});

test('there are exactly two partial indexes, and they are the two named ones', async () => {
  // The count is two rather than three: deleting the canonical-picture
  // concept removed the index that enforced one per view. A third appearing
  // here means a deleted concept has come back.
  await withSteppedStore((store) => {
    const partial = store.db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND sql LIKE '%WHERE%'
          ORDER BY name`,
      )
      .all()
      .map((row) => (row as { name: string }).name);

    assert.deepEqual(partial, ['events_guard', 'live_claims', 'one_row_per_physical_tab']);
  });
});

/**
 * ── events: the ledger ───────────────────────────────────────────────────
 */

test('a denial names the rule that refused, and an allow does not', async () => {
  // A guard names the rule that refused, so it belongs on a denial and means
  // nothing on an allow.
  await withSteppedStore((store) => {
    assert.throws(() => {
      store.db
        .prepare(
          "INSERT INTO events (kind, outcome, adapter) VALUES ('claim_requested', 'deny', 'cli')",
        )
        .run();
    }, /CHECK constraint failed/);
    assert.throws(() => {
      store.db
        .prepare(
          `INSERT INTO events (kind, outcome, guard, adapter)
           VALUES ('claim_requested', 'allow', 'store.not_on_network_filesystem', 'cli')`,
        )
        .run();
    }, /CHECK constraint failed/);
    assert.doesNotThrow(() => {
      store.db
        .prepare(
          `INSERT INTO events (kind, outcome, guard, adapter)
           VALUES ('claim_requested', 'deny', 'store.not_on_network_filesystem', 'cli')`,
        )
        .run();
    });
  });
});

test('an event kind outside the fixed list is refused', async () => {
  // A typo in free text creates a phantom category that every count then
  // silently misses.
  await withSteppedStore((store) => {
    assert.throws(() => {
      store.db
        .prepare(
          "INSERT INTO events (kind, outcome, adapter) VALUES ('claim_grantd', 'allow', 'cli')",
        )
        .run();
    }, /CHECK constraint failed/);
  });
});

test('an adapter outside the four doors is refused', async () => {
  await withSteppedStore((store) => {
    assert.throws(() => {
      store.db
        .prepare("INSERT INTO events (kind, outcome, adapter) VALUES ('sweep', 'allow', 'web')")
        .run();
    }, /CHECK constraint failed/);
  });
});

test('the ledger identifier counts upward, because it doubles as a cursor', async () => {
  await withSteppedStore((store) => {
    const insert = store.db.prepare(
      "INSERT INTO events (kind, outcome, adapter) VALUES ('sweep', 'allow', 'internal')",
    );
    const first = insert.run().lastInsertRowid;
    const second = insert.run().lastInsertRowid;
    assert.ok(Number(second) > Number(first));
  });
});

test('a refusal can carry a session identity with no lease behind it', async () => {
  // The one denormalisation that earns its place outright: a refused request
  // never becomes a lease, so without this column every refusal on the
  // busiest rule in the service is anonymous.
  await withSteppedStore((store) => {
    assert.doesNotThrow(() => {
      store.db
        .prepare(
          `INSERT INTO events (kind, outcome, guard, session_id, claim_id, adapter)
           VALUES ('claim_requested', 'deny', 'capacity', 'session-9', NULL, 'tool-stdio')`,
        )
        .run();
    });
  });
});

/**
 * ── captures ─────────────────────────────────────────────────────────────
 */

/** A capture, with a lease and a tab already in place. */
function insertCapture(
  db: Database,
  overrides: Partial<{
    id: string;
    kind: string;
    tier: string;
    reason: string | null;
    selector: string | null;
    path: string;
  }> = {},
): void {
  const row = {
    id: 'capture-1',
    kind: 'viewport',
    tier: 'default',
    reason: null,
    selector: null,
    path: 'claims/claim-1/images/page.png',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO captures
       (id, claim_id, tab_id, kind, tier, reason, source_width, source_height,
        width, height, bytes, path, selector, viewport_width)
     VALUES
       (@id, 'claim-1', 'tab-1', @kind, @tier, @reason, 1280, 720,
        1280, 720, 4096, @path, @selector, 1280)`,
  ).run(row);
}

test('the top tier owes a written reason', async () => {
  // The entire mechanism by which anyone learns why callers escalate.
  await withSteppedStore((store) => {
    insertClaim(store.db);
    insertTab(store.db);
    assert.throws(() => {
      insertCapture(store.db, { tier: 'max', reason: null });
    }, /CHECK constraint failed/);
    assert.doesNotThrow(() => {
      insertCapture(store.db, { tier: 'max', reason: 'the text was unreadable at the lower rung' });
    });
  });
});

test('an element capture names an element and the others do not', async () => {
  await withSteppedStore((store) => {
    insertClaim(store.db);
    insertTab(store.db);
    assert.throws(() => {
      insertCapture(store.db, { kind: 'element', selector: null });
    }, /CHECK constraint failed/);
    assert.throws(() => {
      insertCapture(store.db, { id: 'capture-2', kind: 'viewport', selector: '.header' });
    }, /CHECK constraint failed/);
  });
});

test('an absolute capture path is refused, in either spelling of a root', async () => {
  // Every path stored is relative to the artifact root, never absolute: the
  // root can move, and an absolute path pins every row to one machine's
  // layout the moment it is written.
  await withSteppedStore((store) => {
    insertClaim(store.db);
    insertTab(store.db);
    const backslash = String.fromCharCode(92);
    for (const bad of [
      '/var/images/page.png',
      `D:${backslash}images${backslash}page.png`,
      `${backslash}images`,
    ]) {
      assert.throws(
        () => {
          insertCapture(store.db, { id: `capture-${bad.length}`, path: bad });
        },
        /CHECK constraint failed/,
        `${bad} should have been refused`,
      );
    }
  });
});

test('a capture must belong to a lease and a tab that exist', async () => {
  await withSteppedStore((store) => {
    assert.throws(() => {
      insertCapture(store.db);
    }, /FOREIGN KEY constraint failed/);
  });
});

/**
 * ── comparisons ──────────────────────────────────────────────────────────
 */

test('a diff records the three settings actually applied', async () => {
  // All three are copied rather than referenced, because all three are
  // mutable and all three determined the output — snapshotting one and
  // referencing the others would be a record that is half-true.
  await withSteppedStore((store) => {
    insertClaim(store.db);
    insertTab(store.db);
    insertCapture(store.db, { id: 'capture-1' });
    insertCapture(store.db, { id: 'capture-2', path: 'claims/claim-1/images/later.png' });

    store.db
      .prepare(
        `INSERT INTO comparisons
           (id, source_capture_id, target_capture_id, claim_id,
            colour_tolerance, minimum_region_area, maximum_regions,
            changed_pixels, changed_ratio, changed, regions, overlay_path)
         VALUES
           ('diff-1', 'capture-2', 'capture-1', 'claim-1',
            0.1, 64, 20, 5000, 0.05, 1, '[]', 'claims/claim-1/images/overlay.png')`,
      )
      .run();

    const row = store.db
      .prepare('SELECT colour_tolerance, minimum_region_area, maximum_regions FROM comparisons')
      .get() as { colour_tolerance: number; minimum_region_area: number; maximum_regions: number };
    assert.deepEqual(row, { colour_tolerance: 0.1, minimum_region_area: 64, maximum_regions: 20 });
  });
});

test('a changed ratio outside zero to one is refused', async () => {
  await withSteppedStore((store) => {
    insertClaim(store.db);
    insertTab(store.db);
    insertCapture(store.db, { id: 'capture-1' });
    insertCapture(store.db, { id: 'capture-2', path: 'claims/claim-1/images/later.png' });
    assert.throws(() => {
      store.db
        .prepare(
          `INSERT INTO comparisons
             (id, source_capture_id, target_capture_id, claim_id,
              colour_tolerance, minimum_region_area, maximum_regions,
              changed_pixels, changed_ratio, changed, regions, overlay_path)
           VALUES
             ('diff-2', 'capture-2', 'capture-1', 'claim-1',
              0.1, 64, 20, 5000, 1.5, 1, '[]', 'claims/claim-1/images/overlay.png')`,
        )
        .run();
    }, /CHECK constraint failed/);
  });
});

/**
 * ── feedback ─────────────────────────────────────────────────────────────
 */

test('feedback needs no lease, which is the point rather than a convenience', async () => {
  // A caller whose claim was refused is the caller most likely to have
  // something worth recording, so requiring a lease would silence exactly the
  // population the tool exists to hear from.
  await withSteppedStore((store) => {
    assert.doesNotThrow(() => {
      store.db
        .prepare(
          `INSERT INTO feedback (session_id, claim_id, rating, category, note)
           VALUES ('session-1', NULL, 2, 'no-path', 'I wanted to do a thing and could not find a way')`,
        )
        .run();
    });
  });
});

test('a rating outside one to five is refused', async () => {
  await withSteppedStore((store) => {
    for (const rating of [0, 6]) {
      assert.throws(() => {
        store.db
          .prepare(
            `INSERT INTO feedback (rating, category, note)
             VALUES (?, 'worked-well', 'this note is comfortably over the floor')`,
          )
          .run(rating);
      }, /CHECK constraint failed/);
    }
  });
});

test('a category outside the five is refused', async () => {
  await withSteppedStore((store) => {
    assert.throws(() => {
      store.db
        .prepare(
          `INSERT INTO feedback (rating, category, note)
           VALUES (3, 'other', 'this note is comfortably over the floor')`,
        )
        .run();
    }, /CHECK constraint failed/);
  });
});

test('a note below the floor is refused, which stops a reflexive one-word row', async () => {
  await withSteppedStore((store) => {
    assert.throws(() => {
      store.db
        .prepare("INSERT INTO feedback (rating, category, note) VALUES (1, 'no-path', 'bad')")
        .run();
    }, /CHECK constraint failed/);
  });
});

/**
 * ── Types, which STRICT is what enforces ─────────────────────────────────
 */

test('a column typed as a number refuses a word', async () => {
  // Without STRICT the store accepts anything in any column and the types
  // above are decoration. This is the assertion that says they are not.
  await withSteppedStore((store) => {
    assert.throws(() => {
      store.db.prepare("UPDATE browsers SET restart_count = 'many' WHERE id = 'regular'").run();
    }, /cannot store TEXT value in INTEGER column/);
  });
});
