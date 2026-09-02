import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import type { Database } from 'better-sqlite3';

import type { StoreHandle } from '../../src/store/open.ts';
import {
  ARBITRATION_OPERATIONS,
  runArbitration,
  type ArbitrationOperation,
  type ArbitrationScope,
  type OrphanedTab,
  recordTabClosed,
  recordTabCloseFailed,
} from '../../src/service/arbitration.ts';
import { readSince } from '../../src/service/events.ts';
import { CallRefusal } from '../../src/service/refusals.ts';
import { withSteppedStore } from '../helpers/temp-store.ts';

/**
 * The arbitration transaction shape (`MILESTONES.md` #10's implementation
 * note): sweep, answer, commit, then close.
 *
 * ── Why these tests register their own operations ───────────────────────
 *
 * The shipped registry is empty in this row — the operations belong to #12
 * onward — so a test that could only exercise registered operations could
 * exercise nothing at all, and every assertion below would be vacuous. So the
 * tests install an operation into the real registry for the duration of one
 * test and remove it afterwards.
 *
 * **This tests the shipped runner, not a copy of it.** `runArbitration` is
 * imported from the module under test and is the thing being called; what is
 * seeded is its input. The alternative — a local reimplementation of the
 * dispatch loop — is the hollow shape this repository has already been caught
 * by once, where the shipped code was never executed and the suite was green.
 */

/**
 * A second connection to the same file, read-only.
 *
 * **This is the whole of what makes the after-the-commit assertion real**, and
 * it is worth saying why the obvious version is not. Reading through the
 * store's own handle sees that handle's uncommitted writes, so a close running
 * *inside* the transaction would observe the expiry just as a close running
 * after the commit does — and the test would pass either way. It was written
 * that way first and a hand-run mutation, closing the tabs inside the
 * transaction, survived it.
 *
 * Reached through `require` here rather than imported at the top, so the store
 * module stays the only place application code reaches the driver.
 */
function openStoreForRead(location: string): import('better-sqlite3').Database {
  const Database = createRequire(import.meta.url)(
    'better-sqlite3',
  ) as typeof import('better-sqlite3');
  return new Database(location, { readonly: true });
}

const registry = ARBITRATION_OPERATIONS as unknown as Record<string, ArbitrationOperation>;

/** Install an operation for one test, and take it out again afterwards. */
async function withOperation(
  name: string,
  operation: ArbitrationOperation,
  fn: () => Promise<void>,
): Promise<void> {
  registry[name] = operation;
  try {
    await fn();
  } finally {
    delete registry[name];
  }
}

/** A lease, seeded directly, so the sweep has something to find. */
function seedClaim(
  db: Database,
  options: { id: string; expiresAt: string; state?: string; session?: string },
): void {
  db.prepare(
    `INSERT INTO claims (id, key_hash, session_id, browser_id, state, purpose, expires_at, ttl_seconds, activated_at)
     VALUES (@id, @keyHash, @session, 'regular', @state, 'a seeded lease', @expiresAt, 600, @activatedAt)`,
  ).run({
    id: options.id,
    keyHash: `hash-of-${options.id}`,
    session: options.session ?? 'session-a',
    state: options.state ?? 'active',
    expiresAt: options.expiresAt,
    activatedAt: (options.state ?? 'active') === 'queued' ? null : '2020-01-01T00:00:00.000Z',
  });
}

/**
 * A tab, seeded in one of the two shapes a tab can really be in.
 *
 * **The default is `opening` with no driver name, because that is what the
 * product produces.** Granting a lease inserts exactly that (`claim.ts`), and
 * nothing in this build opens a tab — opening is M4.
 *
 * **This default is the whole point of the parameter.** Seeding only `open`
 * with a driver name tests a shape no code path produces, which leaves the
 * sweep green against a row it never meets while being broken against the row
 * it always meets — a failure worth naming because it costs nothing to write
 * and cannot be seen from a passing run. **A fixture that seeds a state the
 * product cannot reach is a test of something else.** So the default is the
 * reachable shape, and the M4 shape is opt-in and labelled as anticipatory.
 */
function seedTab(
  db: Database,
  options: {
    id: string;
    claimId: string;
    /**
     * Seed the shape a tab has **once a driver has opened it** — `open` with
     * a driver name. Nothing produces this yet; it is what M4 will, and the
     * sweep has to handle both.
     */
    opened?: boolean;
  },
): void {
  if (options.opened === true) {
    db.prepare(
      `INSERT INTO tabs (id, claim_id, browser_id, driver_tab_id, state, opened_at)
       VALUES (@id, @claimId, 'regular', @driverTabId, 'open', '2020-01-01T00:00:00.000Z')`,
    ).run({ id: options.id, claimId: options.claimId, driverTabId: `driver-${options.id}` });
    return;
  }

  db.prepare(
    `INSERT INTO tabs (id, claim_id, browser_id, driver_tab_id, state)
     VALUES (@id, @claimId, 'regular', NULL, 'opening')`,
  ).run({ id: options.id, claimId: options.claimId });
}

/** Long past. Written as a literal so the sweep's comparison is unambiguous. */
const LAPSED = '2020-01-01T00:00:00.000Z';
/** Far enough ahead that no run of this suite reaches it. */
const LIVE = '2999-01-01T00:00:00.000Z';

function stateOf(store: StoreHandle, claimId: string): string {
  const row = store.db.prepare('SELECT state FROM claims WHERE id = ?').get(claimId) as {
    state: string;
  };
  return row.state;
}

// ── The sweep, which is what makes even a question a write ──────────────

test('a lapsed lease is expired by an unrelated call from another session', async () => {
  // `MILESTONES.md`: "assert the sweep is global. Seed a lapsed claim
  // belonging to session A, then have session B make an unrelated arbitration
  // call, and assert A's claim is expired. A sweep scoped to the caller
  // passes every test that only ever asks about the caller's own rows."
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED, session: 'session-a' });
    store.db.exec('COMMIT');

    await withOperation(
      'ask',
      {
        kind: 'sweep',
        summary: 'asks a question and writes nothing of its own',
        handler: () => ({ value: 'answered' }),
      },
      async () => {
        const answer = await runArbitration({
          store,
          name: 'ask',
          adapter: 'cli',
          input: { session: 'session-b' },
        });
        assert.equal(answer, 'answered');
      },
    );

    assert.equal(
      stateOf(store, 'claim-a'),
      'expired',
      "session B's call did not reclaim session A's lapsed capacity",
    );
  });
});

test('a live lease is left alone by the sweep', async () => {
  // The control. Without it, a sweep that expired everything it touched
  // would pass the test above and destroy every lease in use.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-live', expiresAt: LIVE });
    seedClaim(store.db, { id: 'claim-lapsed', expiresAt: LAPSED });
    store.db.exec('COMMIT');

    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: null }) },
      async () => {
        await runArbitration({ store, name: 'ask', adapter: 'cli', input: null });
      },
    );

    assert.equal(stateOf(store, 'claim-live'), 'active');
    assert.equal(stateOf(store, 'claim-lapsed'), 'expired');
  });
});

test('a lapsed queue entry expires the same way an active lease does', async () => {
  // §2.4: "every arbitration call first expires every lapsed claim **and
  // every lapsed queue entry**". One duration, one rule (§2.5) — a sweep that
  // only looked at active leases would leave the queue full of callers that
  // stopped waiting, and everyone behind them stuck.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-queued', expiresAt: LAPSED, state: 'queued' });
    store.db.exec('COMMIT');

    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: null }) },
      async () => {
        await runArbitration({ store, name: 'ask', adapter: 'cli', input: null });
      },
    );

    assert.equal(stateOf(store, 'claim-queued'), 'expired');
  });
});

test('the recorded lapse time is when the lease lapsed, not when the sweep noticed', async () => {
  // §2.4a, and the reason it is a column rather than a comment: stamping the
  // sweep's own moment produces a record in which leases expire in clusters
  // at instants when nothing happened to them — "a strong, clean, entirely
  // fictitious pattern".
  //
  // The single change that breaks this test is setting expired_at to the
  // sweep's `now` instead of the row's own expires_at, which is the shorter
  // and more obvious way to write the statement.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    store.db.exec('COMMIT');

    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: null }) },
      async () => {
        await runArbitration({ store, name: 'ask', adapter: 'cli', input: null });
      },
    );

    const row = store.db
      .prepare('SELECT expired_at AS expiredAt, ended_at AS endedAt FROM claims WHERE id = ?')
      .get('claim-a') as { expiredAt: string; endedAt: string };

    assert.equal(row.expiredAt, LAPSED, 'the lapse time is the expiry, not the observation');
    assert.equal(row.endedAt, LAPSED);
  });
});

test('the handler sees the reconciled state, not the state before the sweep', async () => {
  // The implementation note: "step 1 is in the same transaction as step 2,
  // not before it. A reconciliation whose result a separate statement reads
  // is a race... a caller can be told no capacity on the strength of leases
  // the very same call has just decided are dead."
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    store.db.exec('COMMIT');

    let liveSeenByHandler = -1;

    await withOperation(
      'count',
      {
        kind: 'sweep',
        summary: 'counts what is live',
        handler: (scope: ArbitrationScope) => {
          const row = scope.db
            .prepare(`SELECT count(*) AS live FROM claims WHERE state IN ('queued', 'active')`)
            .get() as { live: number };
          liveSeenByHandler = row.live;
          return { value: null };
        },
      },
      async () => {
        await runArbitration({ store, name: 'count', adapter: 'cli', input: null });
      },
    );

    assert.equal(liveSeenByHandler, 0, 'the handler counted a lease its own call had expired');
  });
});

test('the handler is told what the sweep did', async () => {
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    seedTab(store.db, { id: 'tab-a', claimId: 'claim-a', opened: true });
    store.db.exec('COMMIT');

    let seen: { expired: readonly string[]; orphans: readonly OrphanedTab[] } | undefined;

    await withOperation(
      'ask',
      {
        kind: 'sweep',
        summary: 'asks',
        handler: (scope: ArbitrationScope) => {
          seen = { expired: scope.swept.expiredClaimIds, orphans: scope.swept.orphanedTabs };
          return { value: null };
        },
      },
      async () => {
        await runArbitration({ store, name: 'ask', adapter: 'cli', input: null });
      },
    );

    assert.deepEqual(seen?.expired, ['claim-a']);
    assert.deepEqual(seen?.orphans, [{ tabId: 'tab-a', claimId: 'claim-a', browserId: 'regular' }]);
  });
});

// ── Step three: outside the transaction, after the commit ───────────────

test('a swept tab is closed after the commit, never inside the transaction', async () => {
  // §2.4b, the hard rule: "inside the transaction, one unresponsive browser
  // blocks every arbitration call on the machine". The assertion that proves
  // *after* rather than merely *eventually* is reading the committed state on
  // a second connection from inside the close — if the close ran inside the
  // transaction, the second connection would not see the expiry.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    seedTab(store.db, { id: 'tab-a', claimId: 'claim-a', opened: true });
    store.db.exec('COMMIT');

    const closed: OrphanedTab[] = [];
    let stateVisibleDuringClose: string | undefined;

    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: null }) },
      async () => {
        await runArbitration({
          store,
          name: 'ask',
          adapter: 'cli',
          input: null,
          closeTab: (tab) => {
            closed.push(tab);
            // Read on a connection that cannot see an open transaction's
            // writes. If this close is running inside the transaction, the
            // lease still reads 'active' here.
            const other = openStoreForRead(store.location);
            try {
              const row = other
                .prepare('SELECT state FROM claims WHERE id = ?')
                .get(tab.claimId) as { state: string } | undefined;
              stateVisibleDuringClose = row?.state;
            } finally {
              other.close();
            }
          },
        });
      },
    );

    assert.deepEqual(closed, [{ tabId: 'tab-a', claimId: 'claim-a', browserId: 'regular' }]);
    assert.equal(
      stateVisibleDuringClose,
      'expired',
      'a separate connection could not see the expiry, so the close ran inside the transaction — which is the violation section 2.4b calls the worst',
    );
  });
});

test('a tab that will not close is a leaked tab, not a leaked lease', async () => {
  // §2.4b, stated exactly: "the capacity came back at commit; the lease is
  // over; the count is right. What remains is a page in a browser that nobody
  // owns." The single change that breaks this is letting the close failure
  // propagate, which would report failed work that succeeded.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    seedTab(store.db, { id: 'tab-a', claimId: 'claim-a', opened: true });
    store.db.exec('COMMIT');

    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: 'answered' }) },
      async () => {
        const answer = await runArbitration({
          store,
          name: 'ask',
          adapter: 'cli',
          input: null,
          closeTab: () => {
            throw new Error('the browser did not answer');
          },
        });
        assert.equal(answer, 'answered', 'a wedged browser was reported as a failed call');
      },
    );

    assert.equal(stateOf(store, 'claim-a'), 'expired', 'the lease leaked with the tab');
  });
});

test('a swept tab is left in the closing state, which is not free capacity', async () => {
  // §1.4: 'closing' is "the honest representation of the tool was asked and
  // has not answered, and it is what stops a page that may still exist being
  // counted as free". Marking it 'closed' inside the transaction would be a
  // claim about a round trip that has not happened yet.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    seedTab(store.db, { id: 'tab-a', claimId: 'claim-a', opened: true });
    store.db.exec('COMMIT');

    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: null }) },
      async () => {
        await runArbitration({ store, name: 'ask', adapter: 'cli', input: null });
      },
    );

    const row = store.db.prepare('SELECT state FROM tabs WHERE id = ?').get('tab-a') as {
      state: string;
    };
    assert.equal(row.state, 'closing');
  });
});

test("the sweep's closes are scheduled before the operation's own after-commit work", async () => {
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    seedTab(store.db, { id: 'tab-a', claimId: 'claim-a', opened: true });
    store.db.exec('COMMIT');

    const order: string[] = [];

    await withOperation(
      'ask',
      {
        kind: 'sweep',
        summary: 'asks',
        handler: () => ({
          value: null,
          afterCommit: [
            () => {
              order.push('operation');
            },
          ],
        }),
      },
      async () => {
        await runArbitration({
          store,
          name: 'ask',
          adapter: 'cli',
          input: null,
          closeTab: () => {
            order.push('reclaim');
          },
        });
      },
    );

    assert.deepEqual(order, ['reclaim', 'operation']);
  });
});

test('with no way to close a tab, the lease still ends and the tab is left recorded', async () => {
  // The documented consequence of omitting `closeTab` rather than a gap: a
  // caller with no browser session has nothing to close with, and the
  // capacity still came back at commit.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    seedTab(store.db, { id: 'tab-a', claimId: 'claim-a', opened: true });
    store.db.exec('COMMIT');

    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: null }) },
      async () => {
        await runArbitration({ store, name: 'ask', adapter: 'cli', input: null });
      },
    );

    assert.equal(stateOf(store, 'claim-a'), 'expired');
    const row = store.db.prepare('SELECT state FROM tabs WHERE id = ?').get('tab-a') as {
      state: string;
    };
    assert.equal(row.state, 'closing');
  });
});

// ── The ledger, written from inside the same transaction ────────────────

test('the sweep records each expiry against the call that performed it', async () => {
  // §1.6's `internal` adapter is for work the service did on its own behalf,
  // and the note that matters: "a sweep is attributed to the call that
  // performed it". So the adapter on the row is the caller's.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    seedClaim(store.db, { id: 'claim-b', expiresAt: LAPSED });
    store.db.exec('COMMIT');

    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: null }) },
      async () => {
        await runArbitration({ store, name: 'ask', adapter: 'tool-http', input: null });
      },
    );

    const rows = readSince(store.db, 0, 10);
    assert.deepEqual(
      rows.map((row) => [row.kind, row.outcome, row.claimId, row.adapter]),
      [
        ['claim_expired', 'allow', 'claim-a', 'tool-http'],
        ['claim_expired', 'allow', 'claim-b', 'tool-http'],
      ],
    );
  });
});

test('a sweep that found nothing writes no ledger row', async () => {
  // The ledger records decisions, and finding nothing to expire is not one.
  // A row per call on a quiet installation would be the ledger's largest
  // category and would carry no information.
  await withSteppedStore(async (store) => {
    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: null }) },
      async () => {
        await runArbitration({ store, name: 'ask', adapter: 'cli', input: null });
      },
    );
    assert.deepEqual(readSince(store.db, 0, 10), []);
  });
});

test('a handler that throws leaves neither the expiry nor its ledger row behind', async () => {
  // One atomic act. A sweep that survived a failed answer would expire leases
  // on behalf of a call that did not happen, and the ledger would say so.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    store.db.exec('COMMIT');

    await withOperation(
      'fail',
      {
        kind: 'sweep',
        summary: 'throws',
        handler: () => {
          throw new Error('deliberate');
        },
      },
      async () => {
        await assert.rejects(
          runArbitration({ store, name: 'fail', adapter: 'cli', input: null }),
          /deliberate/,
        );
      },
    );

    assert.equal(stateOf(store, 'claim-a'), 'active', 'the expiry survived a failed call');
    assert.deepEqual(readSince(store.db, 0, 10), []);
  });
});

test('a handler that throws does not run the after-commit work of the sweep', async () => {
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    seedTab(store.db, { id: 'tab-a', claimId: 'claim-a', opened: true });
    store.db.exec('COMMIT');

    let closes = 0;

    await withOperation(
      'fail',
      {
        kind: 'sweep',
        summary: 'throws',
        handler: () => {
          throw new Error('deliberate');
        },
      },
      async () => {
        await assert.rejects(
          runArbitration({
            store,
            name: 'fail',
            adapter: 'cli',
            input: null,
            closeTab: () => {
              closes += 1;
            },
          }),
          /deliberate/,
        );
      },
    );

    // The tab is still owned by a live lease. Closing it would take a page
    // away from a caller that still holds it.
    assert.equal(closes, 0);
  });
});

// ── Dispatch ────────────────────────────────────────────────────────────

test('an unregistered operation is refused, and refused before the transaction opens', async () => {
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    store.db.exec('COMMIT');

    await assert.rejects(
      runArbitration({ store, name: 'no_such_operation', adapter: 'cli', input: null }),
      (error: unknown) => {
        assert.ok(error instanceof CallRefusal);
        assert.equal(error.code, 'unknown_operation');
        assert.equal(error.rule, 'arbitration.registered');
        assert.equal(error.detail.requested, 'no_such_operation');
        return true;
      },
    );

    // Opening a transaction to refuse a mistyped name would serialise every
    // caller on the machine behind it — and it would sweep on behalf of a
    // call that was never a decision about capacity.
    assert.equal(stateOf(store, 'claim-a'), 'active');
  });
});

test('the handler receives the input it was dispatched with, and returns its own value', async () => {
  await withSteppedStore(async (store) => {
    let received: unknown;
    await withOperation(
      'echo',
      {
        kind: 'sweep',
        summary: 'echoes',
        handler: (_scope: ArbitrationScope, input: unknown) => {
          received = input;
          return { value: { echoed: input } };
        },
      },
      async () => {
        const answer = await runArbitration({
          store,
          name: 'echo',
          adapter: 'cli',
          input: { session: 'session-a' },
        });
        assert.deepEqual(answer, { echoed: { session: 'session-a' } });
      },
    );
    assert.deepEqual(received, { session: 'session-a' });
  });
});

// ── The shape the product actually produces ─────────────────────────────
//
// Every tab this build creates is `opening` with no driver name, because
// granting a lease inserts exactly that and nothing opens a tab: opening is
// M4. The tests above seed the shape M4 will produce and are labelled as
// anticipatory; these are the ones about the shape this build reaches.

test('a lapsed lease whose tab never opened is swept, and does not throw', async () => {
  // The defect this pins: both writers moved every tab to `closing`, which
  // the schema refused for a tab with no driver name — and because the sweep
  // runs before every handler, one such lease made every arbitration call by
  // every caller throw, permanently and across spawns.
  //
  // The mutation that breaks this is moving a never-opened tab to `closing`
  // instead of `closed` in `updateSweptTabs`.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    seedTab(store.db, { id: 'tab-a', claimId: 'claim-a' });
    store.db.exec('COMMIT');

    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: null }) },
      async () => {
        await runArbitration({ store, name: 'ask', adapter: 'cli', input: null });
      },
    );

    assert.equal(stateOf(store, 'claim-a'), 'expired');
  });
});

test('a tab that never opened ends as closed, not closing — there was nothing to ask', async () => {
  // §1.4: `closing` is "the honest representation of *the tool was asked and
  // has not answered*", and it exists to stop **a page that may still exist**
  // being counted as free. A tab with no driver name was never asked and no
  // page ever existed, so `closing` would assert an outstanding round trip
  // that is not outstanding — and would leave the row waiting forever for an
  // answer nobody is coming to give.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    seedTab(store.db, { id: 'tab-a', claimId: 'claim-a' });
    store.db.exec('COMMIT');

    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: null }) },
      async () => {
        await runArbitration({ store, name: 'ask', adapter: 'cli', input: null });
      },
    );

    const tab = store.db
      .prepare('SELECT state, driver_tab_id AS driverTabId, closed_at AS closedAt FROM tabs')
      .get() as { state: string; driverTabId: string | null; closedAt: string | null };
    assert.equal(tab.state, 'closed');
    assert.equal(tab.driverTabId, null);
    assert.notEqual(tab.closedAt, null, 'a closed tab records when it closed');
  });
});

test('a tab that never opened is not scheduled for a close', async () => {
  // Asking a driver to close a page that does not exist is a round trip that
  // can only fail, and it would be attributed to a tab as a close failure.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    seedTab(store.db, { id: 'tab-a', claimId: 'claim-a' });
    store.db.exec('COMMIT');

    const closed: OrphanedTab[] = [];
    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: null }) },
      async () => {
        await runArbitration({
          store,
          name: 'ask',
          adapter: 'cli',
          input: null,
          closeTab: (tab) => {
            closed.push(tab);
          },
        });
      },
    );

    assert.deepEqual(closed, [], 'a tab that never opened was handed to the driver to close');
  });
});

test('one lapsed never-opened lease does not wedge later calls, or a later spawn', async () => {
  // The escalation that made this critical rather than merely broken: the
  // sweep is unconditional before every handler, so a row it cannot sweep
  // fails every caller forever — including a fresh process, because the row
  // is still there.
  await withSteppedStore(async (store) => {
    store.db.exec('BEGIN');
    seedClaim(store.db, { id: 'claim-a', expiresAt: LAPSED });
    seedTab(store.db, { id: 'tab-a', claimId: 'claim-a' });
    seedClaim(store.db, { id: 'claim-healthy', expiresAt: LIVE, session: 'session-b' });
    store.db.exec('COMMIT');

    await withOperation(
      'ask',
      { kind: 'sweep', summary: 'asks', handler: () => ({ value: null }) },
      async () => {
        // Three consecutive calls by an unrelated caller. The second and
        // third are the ones that would have failed on a store the first
        // could not reconcile.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await runArbitration({ store, name: 'ask', adapter: 'cli', input: null });
        }
      },
    );

    assert.equal(stateOf(store, 'claim-a'), 'expired');
    assert.equal(stateOf(store, 'claim-healthy'), 'active', 'an unrelated lease was disturbed');
  });
});

test('A CLOSE THAT SUCCEEDS IS WRITTEN DOWN — the state a tab was left in for two days', async () => {
  // `closing` means "the tool was asked and has not answered". Nothing ever
  // wrote the answer, so a tab that closed perfectly well stayed in that
  // state for the life of the store — holding its slot in the partial unique
  // index on (browser_id, driver_tab_id), and making the ledger disagree
  // with the browser permanently. A real store was found with 22 such rows.
  await withSteppedStore(({ db }) => {
    seedClaim(db, { id: 'claim-closed', expiresAt: '2020-01-01T00:00:00.000Z' });
    seedTab(db, { id: 'tab-closed', claimId: 'claim-closed', opened: true });
    // Ended the way the schema insists on: its CHECK ties a final state to
    // an end time, so seeding one without the other is a shape the product
    // cannot produce.
    db.prepare("UPDATE claims SET state = 'released', ended_at = ? WHERE id = ?").run(
      '2020-01-01T00:05:00.000Z',
      'claim-closed',
    );
    db.prepare("UPDATE tabs SET state = 'closing' WHERE id = ?").run('tab-closed');

    recordTabClosed(db, 'tab-closed', '2020-01-01T00:10:00.000Z');

    const tab = db
      .prepare(
        `SELECT state, closed_at AS closedAt, close_failed AS closeFailed,
                close_attempts AS closeAttempts
           FROM tabs WHERE id = ?`,
      )
      .get('tab-closed') as {
      state: string;
      closedAt: string | null;
      closeFailed: number;
      closeAttempts: number;
    };

    assert.equal(tab.state, 'closed');
    assert.equal(tab.closedAt, '2020-01-01T00:10:00.000Z');
    // Counted even on success: this column is what distinguishes "tried and
    // failed" from "never tried", and an investigation could say with
    // certainty which it faced only because the count was zero, not absent.
    assert.equal(tab.closeAttempts, 1);
    assert.equal(tab.closeFailed, 0);
  });
});

test('a close the browser REFUSES is recorded, and the row stays closing', async () => {
  // 2.4b: a leaked tab is not a leaked lease. The capacity is already back
  // and a page is what is left, so the failure is recorded rather than
  // raised — throwing would fail a release that succeeded at the thing
  // releases are for. The row stays `closing`, which is honest: the page may
  // well still be there.
  await withSteppedStore(({ db }) => {
    seedClaim(db, { id: 'claim-stuck', expiresAt: '2020-01-01T00:00:00.000Z' });
    seedTab(db, { id: 'tab-stuck', claimId: 'claim-stuck', opened: true });
    db.prepare("UPDATE claims SET state = 'released', ended_at = ? WHERE id = ?").run(
      '2020-01-01T00:05:00.000Z',
      'claim-stuck',
    );
    db.prepare("UPDATE tabs SET state = 'closing' WHERE id = ?").run('tab-stuck');

    recordTabCloseFailed(db, 'tab-stuck', '2020-01-01T00:10:00.000Z');

    const tab = db
      .prepare(
        `SELECT state, close_failed AS closeFailed, close_attempts AS closeAttempts
           FROM tabs WHERE id = ?`,
      )
      .get('tab-stuck') as { state: string; closeFailed: number; closeAttempts: number };

    assert.equal(tab.state, 'closing', 'a refused close must not read as closed');
    assert.equal(tab.closeFailed, 1);
    assert.equal(tab.closeAttempts, 1);
  });
});
