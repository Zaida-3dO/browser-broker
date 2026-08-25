import assert from 'node:assert/strict';
import test from 'node:test';

import { contend } from './harness.ts';
import { seedLapsedClaim } from './seed.ts';
import { withArbitrationStore } from './stores.ts';

/**
 * The global sweep, under several processes sweeping at once.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT MAKES THIS TEST ABLE TO FAIL
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §2.4 and the runner's own comment: the sweep is **global rather than scoped
 * to the caller**, unconditional, and unskippable. Capacity held by something
 * that died must come back on the next call from *anyone*.
 *
 * `MILESTONES.md` names the hollow version outright: *"a sweep scoped to the
 * caller passes every test that only ever asks about the caller's own rows"*.
 * So the lapsed claim here belongs to a session that **never makes a call**.
 * Every process that sweeps it is a stranger to it. A sweep that reconciled
 * only the caller's own leases would leave the row untouched and this test
 * would fail — which is the point.
 *
 * The second property is the one contention adds: several processes sweep the
 * same lapsed claim simultaneously, and **the claim must be expired exactly
 * once**. Each caller opens an immediate transaction, so the sweeps are
 * serialised; the ones that arrive after the first find nothing to do. A
 * ledger carrying the expiry twice would mean two processes both believed
 * they reclaimed it, which is capacity counted back twice.
 */

const BROWSER = 'regular';

test('a lapsed claim belonging to a session that never calls is reclaimed by strangers sweeping at once', async () => {
  const budget = 2;
  // Two callers, and the budget is two — but one unit is held by a lapsed
  // claim at the start, so without reclamation only one could be granted.
  const processes = 2;

  await withArbitrationStore(
    async (fixture) => {
      // The dead caller. It holds a tab, its lease elapsed, and it will never
      // make another call — nothing in this test acts on its behalf.
      seedLapsedClaim(fixture.databasePath, {
        id: 'lapsed-of-a-session-that-never-returns',
        arrival: 1,
        browserId: BROWSER,
        // **A namespace no live caller shares.** The children call themselves
        // `session-0`, `session-1` and so on; this one deliberately looks
        // nothing like them, so a sweep scoped to the callers — by session, by
        // prefix, or by any resemblance to who is asking — excludes this row
        // and the test fails. Naming it `session-that-died` would have shared
        // the callers' own prefix and let a caller-scoped sweep pass.
        sessionId: 'a-departed-caller-from-another-namespace',
        expiresAt: '2020-01-01T00:00:00.000Z',
        tabId: 'tab-of-the-lapsed-lease',
      });

      // Both callers are strangers to it.
      const run = await contend({
        worker: 'worker-claim.mjs',
        processes,
        argv: [BROWSER],
        env: fixture.childEnv,
      });

      assert.equal(
        run.failed.length,
        0,
        `Every process must get an answer rather than an error. First failure: ${String(run.failed[0]?.message)}`,
      );

      // ── The reclamation itself, read from what committed ──────────────
      const lapsed = fixture.readCommitted<{ state: string; expiredAt: string | null }>(
        'SELECT state, expired_at AS expiredAt FROM claims WHERE id = @id',
        { id: 'lapsed-of-a-session-that-never-returns' },
      );
      assert.equal(
        lapsed[0]?.state,
        'expired',
        'A lapsed lease must be expired by the next arbitration call from anyone. A sweep scoped to the caller would leave this row active, because its own session never called.',
      );

      // §2.4a: the lapse time is when it lapsed, not when a sweep noticed.
      // Stamping the sweep's own moment would produce leases expiring in
      // clusters at instants when nothing happened to them.
      assert.equal(
        lapsed[0]?.expiredAt,
        '2020-01-01T00:00:00.000Z',
        'The expiry must be stamped with the moment the lease lapsed rather than the moment a sweep ran, so the record does not invent a pattern the observer created.',
      );

      // The tab follows its claim, and it is `closing` rather than `closed`:
      // the close happens after the commit and these callers supplied no
      // driver, so the honest state is that the tool has not answered.
      const tab = fixture.readCommitted<{ state: string }>(
        'SELECT state FROM tabs WHERE id = @id',
        { id: 'tab-of-the-lapsed-lease' },
      );
      assert.equal(
        tab[0]?.state,
        'closing',
        "The lapsed lease's tab must follow its claim, in the state that says the close was asked for and has not been confirmed.",
      );

      // ── Reclaimed once, not once per sweeper ──────────────────────────
      //
      // Several processes swept simultaneously. The ledger must carry exactly
      // one expiry for this claim: two would mean two callers each believed
      // they reclaimed the same unit of capacity.
      const expiries = fixture.readCommitted<{ n: number }>(
        "SELECT count(*) AS n FROM events WHERE kind = 'claim_expired' AND claim_id = @id",
        { id: 'lapsed-of-a-session-that-never-returns' },
      );
      assert.equal(
        expiries[0]?.n,
        1,
        'A lapsed claim must be expired exactly once however many processes sweep it at the same moment. More than one means the same capacity was reclaimed twice.',
      );

      // ── And the capacity actually came back ───────────────────────────
      //
      // The budget is two and one unit was held by the dead caller. Both live
      // callers are granted only because the sweep returned that unit; if the
      // sweep had not run, one of them would have been queued.
      const granted = run.succeeded.filter((outcome) => outcome.detail['outcome'] === 'granted');
      assert.equal(
        granted.length,
        processes,
        'Both callers must be granted, which is only possible because the capacity held by the dead caller came back. One grant and one queue placement would mean the sweep did not reclaim it.',
      );

      const active = fixture.readCommitted<{ n: number }>(
        "SELECT count(*) AS n FROM claims WHERE state = 'active'",
      );
      assert.equal(
        active[0]?.n,
        budget,
        'The store must hold exactly the budget in active claims: the reclaimed unit was reissued rather than double-counted.',
      );
    },
    { tabBudget: budget },
  );
});
