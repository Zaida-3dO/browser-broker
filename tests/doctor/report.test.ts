import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { DOCTOR_EXIT } from '../../src/doctor/checks.ts';
import { formatReport, readDiscoveryRecords, runDoctor } from '../../src/doctor/report.ts';
import { makeTempStore, withSteppedStore } from '../helpers/temp-store.ts';

/**
 * The doctor run as a whole (`SCHEMA.md` §5.5, §4.4).
 *
 * The property under test in this file is the one that makes this command
 * usable as a readiness check: **every precondition reported separately,
 * never collapsed into a verdict.**
 */
describe('the doctor report', () => {
  it('reports every precondition §5.5 lists, each on its own', async () => {
    // Named individually rather than counted. A run that emitted the store
    // checks three times and dropped the keeper tab would keep a length
    // assertion green — which is exactly the hollow shape this repository has
    // already been caught by.
    await withSteppedStore(async (store) => {
      const temp = makeTempStore();
      try {
        const report = runDoctor(temp.environment, store.db);
        const ids = new Set(report.checks.map((check) => check.id));

        assert.ok(
          ids.has('store.not_on_network_filesystem'),
          'the network-location check is missing',
        );
        assert.ok(ids.has('store.present'), 'the store-present check is missing');
        assert.ok(ids.has('store.version'), 'the version check is missing');
        assert.ok(ids.has('automation.present'), 'the automation check is missing');
        assert.ok(ids.has('roots.artifacts_writable'), 'the artifact-root check is missing');
        assert.ok(ids.has('roots.profiles_writable'), 'the profile-root check is missing');
        assert.ok(ids.has('browser.regular.discovery'), 'the regular browser’s record is missing');
        assert.ok(ids.has('browser.private.discovery'), 'the private browser’s record is missing');
        assert.ok(ids.has('capture.surface'), 'the capture-surface check is missing');
        assert.ok(ids.has('browser.regular.keeper_tab'), 'the regular keeper tab is missing');
        assert.ok(ids.has('browser.private.keeper_tab'), 'the private keeper tab is missing');
        assert.ok(ids.has('config.tab_budget_agrees'), 'the tab-budget check is missing');
      } finally {
        temp.remove();
      }
      await Promise.resolve();
    });
  });

  it('changes nothing in the store', async () => {
    // The rule this command exists under: "what state is this installation
    // in" never requires running the thing that would change it.
    //
    // **Asserted through a second, read-only connection**, because the store's
    // own handle sees uncommitted writes and would report a change that had
    // not committed as absent — or an absent one as present.
    const temp = makeTempStore();
    try {
      const { prepareStore } = await import('../../src/store/open.ts');
      const store = await prepareStore(temp.environment);

      const versionBefore = store.db.pragma('user_version', { simple: true });
      store.close();

      // A separate process would be the strongest form; a separate connection
      // is the strongest available in one test, and it is the one that fixes
      // the specific hollowness — it cannot see anything this run did not
      // commit.
      const before = new Database(temp.environment.databasePath, { readonly: true });
      const claimsBefore = before.prepare('SELECT COUNT(*) AS n FROM claims').get() as {
        n: number;
      };
      const eventsBefore = before.prepare('SELECT COUNT(*) AS n FROM events').get() as {
        n: number;
      };
      before.close();

      const reopened = await prepareStore(temp.environment);
      runDoctor(temp.environment, reopened.db);
      reopened.close();

      const after = new Database(temp.environment.databasePath, { readonly: true });
      const claimsAfter = after.prepare('SELECT COUNT(*) AS n FROM claims').get() as { n: number };
      const eventsAfter = after.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
      const versionAfter = after.pragma('user_version', { simple: true });
      after.close();

      assert.equal(claimsAfter.n, claimsBefore.n);
      // The one that matters most: every other route records what it did.
      // This did nothing, so there is nothing to record.
      assert.equal(eventsAfter.n, eventsBefore.n);
      assert.equal(versionAfter, versionBefore);
    } finally {
      temp.remove();
    }
  });

  it('answers without a store at all', async () => {
    // A store that does not exist is a legitimate state to ask about, and
    // arguably the one where the answer is most useful. Breaks if the run
    // requires a database handle.
    const temp = makeTempStore();
    try {
      const report = runDoctor(temp.environment, undefined);

      assert.ok(report.checks.length > 0);
      const version = report.checks.find((check) => check.id === 'store.version');
      assert.ok(version);
      assert.equal(version.status, 'unknown');
      // No store, nothing recorded, nothing wrong.
      assert.equal(report.exitCode, DOCTOR_EXIT.ok);
    } finally {
      temp.remove();
    }
    await Promise.resolve();
  });

  it('exits non-zero when a precondition fails', async () => {
    await withSteppedStore(async (store) => {
      const temp = makeTempStore();
      try {
        // ── The budget row is the product's, not the fixture's ─────────────
        //
        // `withSteppedStore` is the spawn path, so opening it recorded this
        // store's budget of 15 — the same way a real installation gets one.
        // A fixture that created a budget table and inserted into it would
        // pass whether or not the doctor's read names the table the product
        // actually writes, which is precisely how a read pointed at a table
        // nothing writes can sit here reporting `unknown` forever.
        assert.equal(
          runDoctor(temp.environment, store.db, { configuredTabBudget: 15 }).exitCode,
          DOCTOR_EXIT.ok,
          'an agreeing budget is not a failed precondition',
        );

        const disagreeing = runDoctor(temp.environment, store.db, { configuredTabBudget: 30 });
        assert.equal(disagreeing.exitCode, DOCTOR_EXIT.budget);
      } finally {
        temp.remove();
      }
      await Promise.resolve();
    });
  });

  it('has no summary verdict', async () => {
    // §4.4: "a health verdict collapses every precondition into one word, and
    // the word does not say which one failed". A summary line would be that
    // word with extra arithmetic.
    const temp = makeTempStore();
    try {
      const lines = formatReport(runDoctor(temp.environment, undefined)).join('\n');
      assert.ok(!/\bhealthy\b/i.test(lines));
      assert.ok(!/\bunhealthy\b/i.test(lines));
      assert.ok(!/\ball (checks|preconditions) (passed|ok)\b/i.test(lines));
    } finally {
      temp.remove();
    }
    await Promise.resolve();
  });

  it('prints a line per precondition, and the remedies for what failed', async () => {
    await withSteppedStore(async (store) => {
      const temp = makeTempStore();
      try {
        // The store's own recorded budget is 15, written by the spawn that
        // opened it; 30 below is the disagreeing environment.
        const lines = formatReport(
          runDoctor(temp.environment, store.db, { configuredTabBudget: 30 }),
        ).join('\n');

        assert.match(lines, /FAIL/);
        assert.match(lines, /What to do:/);
        assert.match(lines, /config\.tab_budget_agrees/);
        assert.match(lines, /exit code: 16/);
      } finally {
        temp.remove();
      }
      await Promise.resolve();
    });
  });

  it('says outright that an unevaluable check is not a failure', async () => {
    // A reader who assumed otherwise would treat a fresh install as broken.
    const temp = makeTempStore();
    try {
      const lines = formatReport(runDoctor(temp.environment, undefined)).join('\n');
      assert.match(lines, /That is not a failure/);
    } finally {
      temp.remove();
    }
    await Promise.resolve();
  });
});

describe('reading the discovery records out of the store', () => {
  it('returns both browsers’ records without checking them', async () => {
    // §1.2c: the record is a claim, not a proof. This reads; only a probe
    // that reaches the endpoint can say whether it checks out.
    await withSteppedStore(async (store) => {
      store.db
        .prepare(
          `UPDATE browsers SET endpoint = 'http://127.0.0.1:1/', browser_uuid = 'uuid-a'
             WHERE id = 'regular'`,
        )
        .run();

      const records = readDiscoveryRecords(store.db);

      assert.equal(records.regular?.browserUuid, 'uuid-a');
      assert.equal(records.private?.endpoint, null);
      await Promise.resolve();
    });
  });
});
