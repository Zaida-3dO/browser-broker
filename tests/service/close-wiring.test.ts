import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import { runDoctor } from '../../src/doctor/report.ts';
import { createRuntime } from '../../src/service/runtime.ts';
import { removeDirectory } from '../helpers/remove-directory.ts';

/**
 * **That releasing a lease actually writes down what happened to its tab.**
 *
 * ── Why this file exists rather than another case beside the SQL ────────
 *
 * `arbitration.test.ts` calls `recordTabClosed` directly and proves the
 * statement does what it says. That is worth having and it is not this: it
 * proves the writer works, never that anything *calls* it. Deleting the call
 * from `runtime.ts` left the whole suite green — 1484 tests — while
 * restoring the field defect exactly.
 *
 * This repository names that failure shape itself: a feature that is
 * documented, tested, and called by nothing in `src`. The only way to
 * exclude it is to drive the seam a caller drives, so this builds the real
 * runtime, takes a real lease, releases it, and reads the row.
 *
 * ── What the row said when this was broken ──────────────────────────────
 *
 * `state = 'closing'`, `close_attempts = 0` — the tool never asked, and the
 * row waits for an answer nobody is coming to give. Twenty-two of those
 * accumulated in a real store over two days, and eight pages sat open on a
 * person's browser owned by no lease.
 */
test('RELEASING A LEASE RECORDS THE CLOSE — the wiring, not the statement', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-close-wiring-'));
  const driver = new FakeBrowserDriver();
  const runtime = await createRuntime({
    adapter: 'cli',
    driver,
    env: {
      BROKER_DB: path.join(directory, 'broker.db'),
      BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
      BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
    },
  });

  try {
    const claimed = await runtime.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: {
        session_id: 'close-wiring',
        browser: 'regular',
        purpose: 'Proving a release writes down what became of its tab.',
      },
    });
    assert.equal(claimed.outcome, 'accepted');
    const granted = (claimed as { value: Record<string, unknown> }).value;
    assert.equal(granted['outcome'], 'granted', 'the lease queued rather than taking a tab');
    const key = String(granted['key']);
    const tabId = String(granted['tabId']);

    // A navigate, so the tab is genuinely opened by the driver rather than
    // being a reservation that never became a page. A row that never opened
    // takes a different branch entirely, and testing that one would leave
    // the branch this file is about untouched.
    const navigated = await runtime.service.perform({
      operation: 'navigate',
      adapter: 'cli',
      arguments: { key, url: 'https://example.com/' },
    });
    assert.equal(navigated.outcome, 'accepted', JSON.stringify(navigated));

    const released = await runtime.service.perform({
      operation: 'release',
      adapter: 'cli',
      arguments: { key },
    });
    assert.equal(released.outcome, 'accepted', JSON.stringify(released));

    const row = runtime.store.db
      .prepare(
        `SELECT state, closed_at AS closedAt, close_attempts AS closeAttempts,
                close_failed AS closeFailed
           FROM tabs WHERE id = ?`,
      )
      .get(tabId) as {
      state: string;
      closedAt: string | null;
      closeAttempts: number;
      closeFailed: number;
    };

    assert.equal(
      row.state,
      'closed',
      'THE FIELD BUG: the row was left waiting on a close nobody was coming to answer',
    );
    assert.notEqual(row.closedAt, null, 'a closed tab with no close time');
    // The count is the diagnostic that made the field investigation possible:
    // zero means never asked, which is a different fault from asked-and-refused.
    assert.equal(row.closeAttempts, 1);
    assert.equal(row.closeFailed, 0);
  } finally {
    runtime.close();
    removeDirectory(directory);
  }
});

test('THE DOCTOR COUNTS A STRANDED ROW — the query, not the sentence', async () => {
  // `checks.test.ts` exercises `checkStrandedTabs(22, 600)`, which is the
  // formatting of a number it is handed. The query that *produces* the
  // number has its own test here, because a body that answers zero without
  // looking sends the whole suite green while "doctor exits 0 while tabs
  // strand" holds — the precise defect the check exists to kill, invisible.
  //
  // So this drives the real report against a real store holding a row aged
  // past a lease's lifetime, and asserts the failure is reported.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-stranded-count-'));
  const driver = new FakeBrowserDriver();
  const runtime = await createRuntime({
    adapter: 'cli',
    driver,
    env: {
      BROKER_DB: path.join(directory, 'broker.db'),
      BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
      BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
    },
  });

  try {
    const claimed = await runtime.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: {
        session_id: 'stranded-count',
        browser: 'regular',
        purpose: 'Aging a row into the state the doctor is meant to notice.',
      },
    });
    const granted = (claimed as { value: Record<string, unknown> }).value;
    const tabId = String(granted['tabId']);
    await runtime.service.perform({
      operation: 'navigate',
      adapter: 'cli',
      arguments: { key: String(granted['key']), url: 'https://example.com/' },
    });

    // Aged past any plausible lease: the row is asserted to be stranded by
    // its clock rather than by its state alone, which is the distinction the
    // check is built on — a close still in flight must not be reported.
    const longAgo = new Date(Date.now() - 86_400_000).toISOString();
    runtime.store.db
      .prepare("UPDATE tabs SET state = 'closing', updated_at = ? WHERE id = ?")
      .run(longAgo, tabId);

    const report = runDoctor(runtime.environment, runtime.store.db);
    const stranded = report.checks.find((check) => check.id === 'store.stranded_tabs');

    assert.ok(stranded !== undefined, 'the report carries no stranded-tab row at all');
    assert.equal(
      stranded.status,
      'failed',
      'a row waiting a day on a close was reported as healthy',
    );
    assert.notEqual(report.exitCode, 0, 'the report exited clean with a tab stranded');
  } finally {
    runtime.close();
    removeDirectory(directory);
  }
});
