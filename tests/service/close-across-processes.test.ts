import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { BrowserDriver, BrowserSession, TabHandle } from '../../src/browser/driver.ts';
import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import { createRuntime } from '../../src/service/runtime.ts';
import { removeDirectory } from '../helpers/remove-directory.ts';

/**
 * **That a close which did nothing is never written down as a close that
 * happened.**
 *
 * ── The field report this file is the regression guard for ──────────────
 *
 * Three pages from already-released leases sat visibly open in a browser
 * while the store recorded twelve rows `closed, close_failed = 0`. Both
 * halves of that sentence were produced by one line: `closeTab` in `real.ts`
 * resolved the page from the session's own in-process map and **returned** on
 * a miss. A process that had not opened the tab therefore closed nothing,
 * said nothing about it, and `runtime.ts` recorded a clean close.
 *
 * This service is daemonless — spawned per caller, serving one session and
 * exiting with it — so "a process that did not open this tab" is the ordinary
 * case, not an exotic one. A fleet running one broker per task hit it by
 * default.
 *
 * ── Why this is the more valuable of the two tests, and not the obvious one ─
 *
 * The obvious test drives a real browser and asserts the page is gone. It is
 * worth having and it lives in `tests/browser/cross-process-tab.test.ts`,
 * where a real browser can be asked. **This one asserts the half that made
 * the bug survive two days of looking at it: the store lied in the direction
 * that silenced every instrument.**
 *
 * `doctor` counts rows stranded at `closing` (`src/doctor/checks.ts`), and
 * `status` selects `close_failed = 1` (`src/operations/status.ts`). A row that
 * goes straight to `closed, close_failed = 0` answers to neither query. So the
 * failure mode was not merely "a page leaked" — it was "a page leaked and the
 * two tools built to find leaked pages both reported everything was fine".
 * A fix that closed the page but kept writing an unconditional success would
 * still be one refactor away from restoring exactly that, and no real-browser
 * test would notice, because the page really would be gone.
 *
 * Hence the assertion here is about the **row**, driven through the real
 * service, over a driver that reports the truth it is specified to report.
 */

/**
 * A driver whose sessions cannot close anything, and say so.
 *
 * This is the whole fixture, and its shape is the argument. It delegates
 * every call to a real {@link FakeBrowserDriver} — a real store, a real
 * broker, real arbitration, a real release path — and overrides exactly one
 * method, to return `not_found`.
 *
 * **`not_found` is not an invented condition.** It is what the seam now
 * answers when no page in the browser holds that name, which is precisely
 * what a freshly spawned process used to get for every tab it had not opened
 * itself. Modelling it at this seam rather than by contorting the fake's
 * internals keeps the test about the thing under test: what the *service*
 * records when the driver tells it nothing was closed.
 */
function driverThatClosesNothing(): { driver: BrowserDriver; asked: string[] } {
  const underlying = new FakeBrowserDriver();
  const asked: string[] = [];

  const bend = (session: BrowserSession): BrowserSession => ({
    ...session,
    closeTab: async (tab: TabHandle) => {
      asked.push(tab.driverTabId);
      // Deliberately does NOT delegate. The page stays open in the fake,
      // which is the state being modelled: the lease is over, the row is
      // being written, and the page is still on the screen.
      return await Promise.resolve('not_found' as const);
    },
  });

  const driver: BrowserDriver = {
    attach: async (browser, record) => bend(await underlying.attach(browser, record)),
    coldStart: async (request) => bend(await underlying.coldStart(request)),
  };

  return { driver, asked };
}

test('A CLOSE THAT FOUND NOTHING IS NOT RECORDED AS A CLOSE — the self-masking half', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-close-cross-process-'));
  const { driver, asked } = driverThatClosesNothing();
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
        session_id: 'close-across-processes',
        browser: 'regular',
        purpose: 'Proving a close that found nothing is not recorded as a success.',
      },
    });
    assert.equal(claimed.outcome, 'accepted');
    const granted = (claimed as { value: Record<string, unknown> }).value;
    assert.equal(granted['outcome'], 'granted', 'the lease queued rather than taking a tab');
    const key = String(granted['key']);
    const tabId = String(granted['tabId']);

    // A navigate, so the row genuinely holds a driver name. A tab that never
    // opened takes a different branch in `runtime.ts` entirely — it returns
    // before asking the driver at all — and testing that one would leave the
    // branch this file is about completely untouched.
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
    // **The release still succeeds**, and that is not incidental. §2.4b: a tab
    // that will not close is a leaked tab and not a leaked lease — the
    // capacity is already back, and failing the release over the page would
    // fail a call that did its job. The signal is for the row, never for the
    // caller.
    assert.equal(released.outcome, 'accepted', JSON.stringify(released));

    // The driver was actually asked. Without this, everything below would
    // also hold for a service that never called `closeTab` at all — which is
    // a different bug with an identical row, and one this repository has
    // already shipped once.
    assert.equal(asked.length, 1, 'the service did not ask the driver to close the tab');

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

    // ── The assertion, stated as the row that must NOT appear ─────────────
    //
    // `closed` with `close_failed = 0` is the exact pair the field store held
    // twelve of while three pages stayed open. It is invisible to `doctor`
    // (which counts `closing`) and to `status` (which selects
    // `close_failed = 1`), so if this pair is ever written for a page that
    // survived, nothing downstream will ever mention it again.
    assert.ok(
      !(row.state === 'closed' && row.closeFailed === 0),
      'THE FIELD BUG: the row claims a clean close for a page the driver said it never found — ' +
        'and that exact pair is invisible to both `doctor` and `status`',
    );

    // Positively: the attempt is recorded as one that did not succeed, which
    // is what puts the row in front of an operator. This is the flag `status`
    // selects on, so it is the difference between a leak that surfaces and a
    // leak that does not.
    assert.equal(row.closeFailed, 1, 'the unsuccessful close was not flagged for the operator');
    assert.equal(row.closeAttempts, 1, 'the attempt itself was not counted');
  } finally {
    runtime.close();
    removeDirectory(directory);
  }
});

test('A CLOSE THAT REALLY CLOSED IS STILL RECORDED CLEANLY — the control', async () => {
  // Without this, the test above is satisfied by a service that flags every
  // close as failed, which would bury every honest release under a permanent
  // false alarm and make `status` useless in the opposite direction. The two
  // tests differ in exactly one thing: what the driver answers.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-close-control-'));
  const runtime = await createRuntime({
    adapter: 'cli',
    driver: new FakeBrowserDriver(),
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
        session_id: 'close-across-processes-control',
        browser: 'regular',
        purpose: 'The control: a driver that really closes the page.',
      },
    });
    const granted = (claimed as { value: Record<string, unknown> }).value;
    const key = String(granted['key']);
    const tabId = String(granted['tabId']);

    await runtime.service.perform({
      operation: 'navigate',
      adapter: 'cli',
      arguments: { key, url: 'https://example.com/' },
    });
    const released = await runtime.service.perform({
      operation: 'release',
      adapter: 'cli',
      arguments: { key },
    });
    assert.equal(released.outcome, 'accepted', JSON.stringify(released));

    const row = runtime.store.db
      .prepare(
        `SELECT state, close_attempts AS closeAttempts, close_failed AS closeFailed
           FROM tabs WHERE id = ?`,
      )
      .get(tabId) as { state: string; closeAttempts: number; closeFailed: number };

    assert.equal(row.state, 'closed');
    assert.equal(row.closeFailed, 0, 'an honest close was flagged as a failure');
    assert.equal(row.closeAttempts, 1);
  } finally {
    runtime.close();
    removeDirectory(directory);
  }
});
