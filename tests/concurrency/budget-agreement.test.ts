import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { contend } from './harness.ts';

/**
 * The one configuration value several processes must *agree* on.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS BELONGS IN THE CONCURRENCY SUITE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §1.10 and §7.2: the tab budget is written to the store because **several
 * processes arbitrate against it simultaneously**. In one process's
 * environment it can be fifteen and in another's thirty; each admits callers
 * correctly against its own belief, and **the ceiling silently stops being a
 * ceiling**. Nothing reports it — the count is right in every process and the
 * machine is over budget anyway.
 *
 * That is a broken invariant rather than degraded behaviour, and it is only
 * expressible across processes. A single-process test can assert the
 * comparison; it cannot show the thing the comparison is for.
 *
 * `MILESTONES.md` names the mutation this must survive: **the change somebody
 * makes to be helpful** — turning the refusal into an adoption of the stored
 * value. Under that change the second process starts happily against a bound
 * it was not configured for, so the assertion below is that it **did not
 * start**, and that its refusal named the rule.
 */

/** Two processes, two beliefs, one store. */
const FIRST_BUDGET = 4;
const SECOND_BUDGET = 9;

test('a process whose budget disagrees with the store refuses to start, and names the rule', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-budget-'));
  try {
    const databasePath = path.join(directory, 'broker.db');
    const base = {
      BROKER_DB: databasePath,
      BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
      BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
    };

    // The first process records its belief into an empty store.
    const first = await contend({
      worker: 'worker-budget.mjs',
      processes: 1,
      argv: [],
      env: { ...base, BROKER_TAB_BUDGET: String(FIRST_BUDGET) },
      // Nothing to contend with, so no barrier lead is needed.
      leadMs: 0,
    });

    assert.equal(
      first.failed.length,
      0,
      `The first process opens an empty store and has nothing to disagree with, so it must start. It failed with: ${String(first.failed[0]?.message)}`,
    );

    // The second believes something else about the same store.
    const second = await contend({
      worker: 'worker-budget.mjs',
      processes: 1,
      argv: [],
      env: { ...base, BROKER_TAB_BUDGET: String(SECOND_BUDGET) },
      leadMs: 0,
    });

    // ── The refusal ───────────────────────────────────────────────────
    //
    // The single change that breaks this assertion is adopting the stored
    // value instead of refusing — which reads as helpful and runs a process
    // against a bound nobody configured it for.
    assert.equal(
      second.failed.length,
      1,
      `A process configured for a budget of ${String(SECOND_BUDGET)} against a store recording ${String(FIRST_BUDGET)} must refuse to start. Starting anyway means two processes admitting callers against different ceilings, which is the ceiling silently failing to be one.`,
    );

    const refusal = second.failed[0];
    assert.equal(
      refusal?.detail['rule'],
      'budget.agrees_with_store',
      'The refusal must carry the rule that refused, as data rather than as English, so a caller can branch on it.',
    );

    // **Both numbers, so the operator can decide which was meant.** Neither
    // is adopted and neither is overwritten, so the message is the only thing
    // that tells them what to change.
    const message = String(refusal?.message);
    assert.ok(
      message.includes(String(SECOND_BUDGET)),
      `The refusal must name the number this process was configured for. It said: ${message}`,
    );
    assert.ok(
      message.includes(String(FIRST_BUDGET)),
      `The refusal must name the number the store records. It said: ${message}`,
    );

    // ── And the store was not changed by the process that refused ──────
    //
    // Overwriting would let whichever process started most recently move a
    // bound the others are mid-arbitration against. Read on a connection of
    // this test's own, after both children have exited.
    const { createRequire } = await import('node:module');
    const Database = createRequire(import.meta.url)(
      'better-sqlite3',
    ) as typeof import('better-sqlite3');
    const reader = new Database(databasePath, { readonly: true });
    const stored = reader.prepare('SELECT tabs FROM tab_budget WHERE only_row = 1').get() as {
      tabs: number;
    };
    reader.close();

    assert.equal(
      stored.tabs,
      FIRST_BUDGET,
      'The refusing process must not have overwritten the recorded budget: doing so moves a bound other processes are already arbitrating against.',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('processes starting together against a stepped store settle on one budget rather than each writing its own', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-budget-race-'));
  try {
    const databasePath = path.join(directory, 'broker.db');

    // ══════════════════════════════════════════════════════════════════
    // THE STORE IS STEPPED FIRST, AND THAT IS NOT A CONVENIENCE
    // ══════════════════════════════════════════════════════════════════
    //
    // **Measured while building this suite, and it is a finding about the
    // startup path rather than about this test:** processes spawning
    // simultaneously against an *empty* store race in the schema stepper, and
    // some of them fail with `table browsers already exists`. Two processes
    // as well as eight; the count barely matters.
    //
    // The mechanism is a check-then-act across a transaction boundary.
    // `stepSchema` reads `user_version` **outside** the transaction, decides
    // there is work to do, and only then opens one — so two processes both
    // read zero, both decide to apply step one, and the loser runs a
    // `CREATE TABLE` the winner has already committed. It is the same
    // read-then-write hazard the arbitration transaction exists to prevent,
    // on the one path that does not go through the arbitration runner.
    //
    // **This test is about the budget agreement, so it steps the store first
    // and leaves that defect to the row that owns the stepper.** Racing an
    // empty store here would be testing the stepper through the budget
    // check, and the failure would be attributed to the wrong thing. What
    // this asserts is what happens once the schema exists: several processes
    // reading and recording the budget in one transaction leave exactly one
    // row.
    //
    // The finding is recorded in this suite's README rather than asserted,
    // because asserting it would pin the defect in place as though it were
    // intended.
    const { prepareStore } = await import('../../src/store/open.ts');
    const stepped = await prepareStore({
      databasePath,
      configuredDatabasePath: databasePath,
      artifactsRoot: path.join(directory, 'artefacts'),
      profileRoot: path.join(directory, 'profiles'),
      tabBudget: FIRST_BUDGET,
      leaseSeconds: 600,
      queueSeconds: 600,
      launchReadinessTimeoutSeconds: 30,
      regularBrowsers: ['regular'],
      privateBrowsers: ['private'],
      regularBrowserEngine: 'msedge',
      privateBrowserEngine: 'msedge',
    });
    stepped.close();

    // Every process believes the same thing here, which is the ordinary case:
    // the question is whether the read-and-record transaction leaves exactly
    // one row when several processes run it at the same instant.
    const run = await contend({
      worker: 'worker-budget.mjs',
      processes: 8,
      argv: [],
      env: {
        BROKER_DB: databasePath,
        BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
        BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
        BROKER_TAB_BUDGET: String(FIRST_BUDGET),
      },
    });

    assert.equal(
      run.failed.length,
      0,
      `Processes that agree must all start. First failure: ${String(run.failed[0]?.message)}`,
    );

    const { createRequire } = await import('node:module');
    const Database = createRequire(import.meta.url)(
      'better-sqlite3',
    ) as typeof import('better-sqlite3');
    const reader = new Database(databasePath, { readonly: true });
    const rows = reader.prepare('SELECT only_row, tabs FROM tab_budget').all() as {
      only_row: number;
      tabs: number;
    }[];
    reader.close();

    assert.equal(
      rows.length,
      1,
      'The budget is one row however many processes raced to write it. More than one would mean two answers to the question every process compares against.',
    );
    assert.equal(
      rows[0]?.tabs,
      FIRST_BUDGET,
      'The recorded budget must be the one they agreed on.',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
