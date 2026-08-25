import assert from 'node:assert/strict';
import test from 'node:test';

import { contend } from './harness.ts';
import { withArbitrationStore } from './stores.ts';

/**
 * The arbitration properties, proved against the real operations under real
 * contention.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THESE ARE HERE AND NOT IN THE SERVICE TESTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The service tests call the operations in one process, one at a time. They
 * are the right shape for what a claim *decides*, and they are the wrong
 * shape for what several claims decide *about each other* — a budget of one
 * is never exceeded by a caller that is the only caller.
 *
 * Every child here runs the application's own path: it opens the store the
 * way a spawn opens it and calls the service the way an adapter calls it. So
 * a read-only fast path added to the real code would be exercised by these
 * tests, which is the half source scanning cannot cover
 * (`scripts/check-arbitration.mjs` states its own edges, and names this suite
 * as its counterpart).
 *
 * ── What these tests do NOT prove, stated rather than implied ───────────
 *
 * - **Nothing about browsers.** No driver is supplied, so no tab is ever
 *   opened or closed. The claim row is the capacity (§2.3), which is what
 *   makes that omission sound here rather than a hole — but an assertion
 *   about a browser round trip is not in this file and must not be read into
 *   it.
 * - **Nothing about a lease being renewed by its holder over time.** These
 *   are single-shot callers.
 * - **Nothing about the transaction mode itself.** That is
 *   `transaction-mode.test.ts`, whose deferred control is what gives the
 *   results here their meaning.
 */

/** A browser this build knows. Both tests contend over the same one. */
const BROWSER = 'regular';

test('a budget of K under N racing processes yields exactly K grants and never K plus one', async () => {
  const budget = 3;
  const processes = 12;

  await withArbitrationStore(
    async (fixture) => {
      const run = await contend({
        worker: 'worker-claim.mjs',
        processes,
        argv: [BROWSER],
        env: fixture.childEnv,
      });

      assert.equal(
        run.failed.length,
        0,
        `Every process must get an answer rather than an error: a claim that cannot be granted is queued, not refused. ${String(run.failed.length)} failed, the first with: ${String(run.failed[0]?.message)}`,
      );

      const granted = run.succeeded.filter((outcome) => outcome.detail['outcome'] === 'granted');
      const queued = run.succeeded.filter((outcome) => outcome.detail['outcome'] === 'queued');

      assert.equal(
        granted.length,
        budget,
        `Exactly the budget may be granted. ${String(granted.length)} processes were told they hold a tab against a budget of ${String(budget)} — over the budget is the ceiling silently failing to be one, and under it is capacity nobody can use.`,
      );
      assert.equal(
        queued.length,
        processes - budget,
        'Every process that was not granted must be queued, so no caller is left without an answer.',
      );

      // ── The same claim, read from what committed ──────────────────────
      //
      // The counts above are what the processes were *told*. This is what the
      // store actually holds, read on a connection that took no part in the
      // contention — the two agreeing is the property, and asserting only the
      // first would pass if the service returned "granted" to a caller whose
      // row never landed.
      const active = fixture.readCommitted<{ n: number }>(
        "SELECT count(*) AS n FROM claims WHERE state = 'active'",
      );
      assert.equal(
        active[0]?.n,
        budget,
        'The store must hold exactly the budget in active claims, which is what capacity is a count of.',
      );

      const queuedRows = fixture.readCommitted<{ n: number }>(
        "SELECT count(*) AS n FROM claims WHERE state = 'queued'",
      );
      assert.equal(
        queuedRows[0]?.n,
        processes - budget,
        'Every queued caller must have a row: a queue place that exists only in a response is a promise with nothing behind it.',
      );
    },
    { tabBudget: budget },
  );
});

test('no two granted callers hold the same tab row, and every grant has exactly one', async () => {
  const budget = 5;
  const processes = 14;

  await withArbitrationStore(
    async (fixture) => {
      const run = await contend({
        worker: 'worker-claim.mjs',
        processes,
        argv: [BROWSER],
        env: fixture.childEnv,
      });

      assert.equal(run.failed.length, 0, 'Every process must get an answer rather than an error.');

      const granted = run.succeeded.filter((outcome) => outcome.detail['outcome'] === 'granted');
      assert.equal(granted.length, budget, 'Exactly the budget may be granted.');

      // One tab per granted claim, and no tab shared between two claims.
      // `tabs.claim_id` is set once and never changed, which is what makes
      // "one live lease per tab" structural (§1.4) — this asserts the
      // structure actually held while several processes wrote at once.
      const tabs = fixture.readCommitted<{ tabId: string; claimId: string }>(
        `SELECT t.id AS tabId, t.claim_id AS claimId
           FROM tabs AS t
           JOIN claims AS c ON c.id = t.claim_id
          WHERE c.state = 'active'`,
      );

      assert.equal(
        tabs.length,
        budget,
        'Each granted lease holds exactly one tab, so the tab count must equal the grant count.',
      );
      assert.equal(
        new Set(tabs.map((tab) => tab.tabId)).size,
        tabs.length,
        'No tab row may appear twice.',
      );
      assert.equal(
        new Set(tabs.map((tab) => tab.claimId)).size,
        tabs.length,
        'No two tabs may belong to one claim, and no two claims to one tab: a shared tab is two callers driving one page.',
      );

      // The claim identifiers the processes were told match the rows that
      // committed — named individually rather than counted, so a grant
      // reported to a caller whose row is missing fails here.
      const grantedIds = granted.map((outcome) => outcome.detail['claimId'] as string);
      const activeIds = fixture
        .readCommitted<{ id: string }>("SELECT id FROM claims WHERE state = 'active'")
        .map((row) => row.id);
      assert.deepEqual(
        [...grantedIds].sort(),
        [...activeIds].sort(),
        'Every caller told it was granted must be one of the active rows, and there must be no active row nobody was told about.',
      );
    },
    { tabBudget: budget },
  );
});
