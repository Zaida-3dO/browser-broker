import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { DOCTOR_EXIT } from '../../src/doctor/checks.ts';
import {
  browserIsRunning,
  discoveryProbesFromStore,
  formatReport,
  readDiscoveryRecords,
  runDoctor,
} from '../../src/doctor/report.ts';
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

  // The mutation this catches: walking `DEFAULT_BROWSER_IDS` instead of the
  // configured lists. That constant is the fixed pair, so a third configured
  // browser vanishes from the report — silently, which is the whole defect:
  // nothing in the output says a browser was not looked at.
  //
  // Named browsers allow up to three per kind, so five here is deliberately
  // more than the default two and covers both kinds having extras.
  it('reports on EVERY configured browser, not just the default pair', async () => {
    await withSteppedStore(async (store) => {
      const temp = makeTempStore({
        regularBrowsers: ['regular', 'work', 'personal'],
        privateBrowsers: ['private', 'scratch'],
      });
      try {
        const report = runDoctor(temp.environment, store.db);
        const ids = new Set(report.checks.map((check) => check.id));

        for (const browser of ['regular', 'work', 'personal', 'private', 'scratch']) {
          assert.ok(
            ids.has(`browser.${browser}.discovery`),
            `the ${browser} browser's discovery check is missing`,
          );
          assert.ok(
            ids.has(`browser.${browser}.keeper_tab`),
            `the ${browser} browser's keeper-tab check is missing`,
          );
        }

        // And nothing is reported about a browser this installation does not
        // have — a doctor that walked a union of configured-and-default would
        // pass the loop above while inventing rows.
        assert.ok(
          !ids.has('browser.default.discovery'),
          'no check may be reported for a browser that is not configured',
        );
      } finally {
        temp.remove();
      }
      await Promise.resolve();
    });
  });

  // The doctor's existing contract, asserted here because the loop above is
  // what would break it: a keeper-tab check with no probe supplied is
  // UNEVALUATED, and unevaluated must not move the exit code. A third browser
  // must not be able to fail a run merely by existing.
  it('leaves a third browser’s unprobed keeper tab unevaluated, and the exit code alone', async () => {
    await withSteppedStore(async (store) => {
      const pair = makeTempStore();
      const trio = makeTempStore({
        regularBrowsers: ['regular', 'work'],
        privateBrowsers: ['private'],
      });
      try {
        const withPair = runDoctor(pair.environment, store.db, { configuredTabBudget: 15 });
        const withTrio = runDoctor(trio.environment, store.db, { configuredTabBudget: 15 });

        const extra = withTrio.checks.find((check) => check.id === 'browser.work.keeper_tab');
        assert.ok(extra, 'the third browser’s keeper-tab check must be present');
        assert.equal(
          extra.status,
          'unknown',
          'nobody probed it, so it is unevaluated rather than failing',
        );
        assert.equal(
          withTrio.exitCode,
          withPair.exitCode,
          'an unevaluated check must not change the exit code',
        );
      } finally {
        pair.remove();
        trio.remove();
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

describe('turning discovery records into probes', () => {
  it('reports a browser with no endpoint as recorded-false, and one with an endpoint as recorded', async () => {
    await withSteppedStore(async (store) => {
      store.db
        .prepare(
          `UPDATE browsers SET endpoint = 'http://127.0.0.1:1/', browser_uuid = 'uuid-a'
             WHERE id = 'regular'`,
        )
        .run();

      const probes = discoveryProbesFromStore(store.db);

      assert.equal(probes?.regular?.recorded, true);
      assert.equal(probes.regular?.expectedUuid, 'uuid-a');
      assert.equal(probes.private?.recorded, false);

      // **`answered` is left unset, and that is the honest half.** Reaching
      // the endpoint needs a driver and the doctor opens no connections, so
      // a store read can say a record exists and cannot say whether the
      // browser behind it is alive.
      assert.equal(probes.regular?.answered, undefined);
      await Promise.resolve();
    });
  });

  it('reports nothing rather than an empty map when there is no store', () => {
    // An empty map would say every browser was looked at and none had a
    // record, which is a measurement nobody took.
    assert.equal(discoveryProbesFromStore(undefined), undefined);
  });
});

describe('whether a browser is running, in three values', () => {
  it('SEPARATES unasked from measured-not-running, which a boolean cannot', () => {
    // Collapsing this to a `boolean` is what produces the defect: an
    // expression of the form `recorded === true && answered === true` yields
    // `false` when no probe was supplied, and `false` is what licenses the
    // negative sign-in verdict.
    assert.equal(browserIsRunning(undefined), undefined, 'no probe was read as a measurement');
    assert.equal(
      browserIsRunning({ recorded: true }),
      undefined,
      'a record whose endpoint nobody reached was read as a measurement',
    );

    // A browser never launched is the one genuine negative a row supports.
    assert.equal(browserIsRunning({ recorded: false }), false);
    // And a probe that did reach the endpoint answers with what it found.
    assert.equal(browserIsRunning({ recorded: true, answered: true }), true);
    assert.equal(browserIsRunning({ recorded: true, answered: false }), false);
  });
});

describe('the discovery probe reaching runDoctor from a production route', () => {
  it('WIRES THE DISCOVERY PROBE THROUGH `runDoctorCommand` — every unit test passed while this did not', async () => {
    // **The test the defect needed and did not have.** Every assertion in
    // this file and in `session.test.ts` passed on a build where no
    // production caller supplied `probes.discovery` at all, so `runDoctor`
    // substituted a fabricated `{recorded: false}`, `browserRunning` was
    // permanently `false`, and the sign-in check read every zero cookie
    // count as a verdict. The checks were all correct functions of inputs
    // nobody gave them.
    //
    // So this drives the real command and asserts on the observable that
    // separates *probed* from *not probed*: a browser with a discovery
    // record in the store. Unwired, `checkDiscoveryRecord` is handed
    // `{recorded: false}` and says the browser has not been launched. Wired,
    // it is handed the record and says one exists. Delete either call site's
    // `discovery` argument and this fails.
    const { runDoctorCommand } = await import('../../src/cli/operations-commands.ts');

    await withSteppedStore(async (store, temp) => {
      store.db
        .prepare(
          `UPDATE browsers SET endpoint = 'http://127.0.0.1:1/', browser_uuid = 'uuid-a'
             WHERE id = 'regular'`,
        )
        .run();

      const lines: string[] = [];
      runDoctorCommand({
        db: store.db,
        environment: temp.environment,
        streams: { out: (line: string) => lines.push(line), err: () => undefined },
        json: true,
        automationProbe: { present: true, detail: 'stubbed' },
      });

      const first = lines[0];
      assert.ok(first);
      const parsed = JSON.parse(first) as {
        checks: { id: string; status: string; detail: string }[];
      };

      const discovery = parsed.checks.find((check) => check.id === 'browser.regular.discovery');
      assert.ok(discovery, 'the discovery check is missing from the report');
      assert.doesNotMatch(
        discovery.detail,
        /has not been launched/u,
        'the report says this browser has never been launched while its record sits in the store — the probe did not reach runDoctor',
      );
      assert.match(discovery.detail, /record is present/u);

      // The private browser has no record, so it reads as the genuine
      // negative — which is also what proves the probe is per-browser rather
      // than a blanket substitution.
      const privateRow = parsed.checks.find((check) => check.id === 'browser.private.discovery');
      assert.ok(privateRow);
      assert.match(privateRow.detail, /has not been launched/u);
      await Promise.resolve();
    });
  });

  it('does not go red merely because a record exists whose endpoint was not reached', async () => {
    // A record the doctor did not verify is `unknown`, never `failed`. The
    // alternative regresses the exit code on every installation that has
    // ever launched a browser — the command reads rows and opens no
    // connections, so it can never supply the `answered` half on its own.
    const { runDoctorCommand } = await import('../../src/cli/operations-commands.ts');

    await withSteppedStore(async (store, temp) => {
      store.db
        .prepare(
          `UPDATE browsers SET endpoint = 'http://127.0.0.1:1/', browser_uuid = 'uuid-a'
             WHERE id = 'regular'`,
        )
        .run();

      const lines: string[] = [];
      const code = runDoctorCommand({
        db: store.db,
        environment: temp.environment,
        streams: { out: (line: string) => lines.push(line), err: () => undefined },
        json: true,
        automationProbe: { present: true, detail: 'stubbed' },
      });

      const first = lines[0];
      assert.ok(first);
      const parsed = JSON.parse(first) as { checks: { id: string; status: string }[] };
      const discovery = parsed.checks.find((check) => check.id === 'browser.regular.discovery');
      assert.equal(discovery?.status, 'unknown');
      assert.notEqual(
        code,
        DOCTOR_EXIT.browsers,
        'an unverified discovery record failed the command',
      );
      await Promise.resolve();
    });
  });
});
