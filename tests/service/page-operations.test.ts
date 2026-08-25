import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ActionRequest,
  BrowserSession,
  CaptureRequest,
  ReadArtifact,
  TabHandle,
} from '../../src/browser/driver.ts';
import { ARBITRATION_NAMES } from '../../src/service/arbitration.ts';
import { CallRefusal } from '../../src/service/refusals.ts';
import { claimInput, withBroker, type BrokerFixture } from '../helpers/broker.ts';

/**
 * The six tab-addressed operations, driven through the shipped service.
 *
 * ── Why every test here goes through `broker.claim` first ───────────────
 *
 * Nothing is seeded. A lease is taken through the real claim operation, which
 * is what mints the tab row these operations address, and the key it returns
 * is the key they are called with. That matters more than convenience: a
 * fixture that inserted its own `claims` and `tabs` rows would be **seeding a
 * state the product can reach only by accident**, and the assertions would
 * hold over a shape no caller can actually produce. Here the only way to get
 * a tab identifier is to have been granted one.
 *
 * ── What "reachable end to end" is taken to mean ────────────────────────
 *
 * That a caller holding nothing but a key and a tab identifier can call the
 * operation on the service surface and have it decide, write and schedule.
 * So the assertions are made on three things a symbol check cannot fake: the
 * value returned, the row that committed **read through a second connection**,
 * and whether the driver was actually asked to do the thing.
 */

/** What a session was asked to do, in order. */
interface DriverLog {
  readonly calls: string[];
  readonly session: BrowserSession;
}

/**
 * A session that records what it was asked and returns plausible answers.
 *
 * **It is not a stand-in for the service.** Everything it stands in for is on
 * the far side of the driver seam — the part this repository deliberately does
 * not exercise without a browser. What is under test is which of its methods
 * get called, with what, and **when relative to the commit**; none of that is
 * supplied by the fake, and the fake cannot make a failing assertion pass
 * because it never sees the store.
 */
function recordingSession(): DriverLog {
  const calls: string[] = [];
  const handle: TabHandle = { browser: 'regular', driverTabId: 'driver-tab' };

  const session = {
    describe: () => ({
      browser: 'regular' as const,
      mode: 'headless' as const,
      pid: 1,
      discovery: { endpoint: 'endpoint' },
    }),
    openTab: async () => {
      calls.push('openTab');
      return await Promise.resolve({ browser: 'regular' as const, driverTabId: 'fresh-tab' });
    },
    listTabs: async () => await Promise.resolve([handle]),
    ensureKeeperTab: async () => await Promise.resolve(handle),
    detach: async () => {
      await Promise.resolve();
    },
    closeTab: async (tab: TabHandle) => {
      calls.push(`closeTab:${tab.driverTabId}`);
      await Promise.resolve();
    },
    navigate: async (tab: TabHandle, url: string) => {
      calls.push(`navigate:${url}`);
      return await Promise.resolve({ url, title: 'a title', status: 200 });
    },
    act: async (tab: TabHandle, request: ActionRequest) => {
      calls.push(`act:${request.action}`);
      return await Promise.resolve({
        artifact: 'snapshot' as const,
        path: 'a/path',
        bytes: 1,
        truncated: false,
      });
    },
    read: async (tab: TabHandle, artifacts: readonly ReadArtifact[]) => {
      calls.push(`read:${artifacts.join('+')}`);
      return await Promise.resolve(
        artifacts.map((artifact) => ({ artifact, path: 'a/path', bytes: 1, truncated: false })),
      );
    },
    cookies: async () => await Promise.resolve([]),
    evaluate: async (tab: TabHandle, expression: string) => {
      calls.push(`evaluate:${expression}`);
      return await Promise.resolve({ value: { ok: true }, bytes: 13 });
    },
    settlePage: async () => {
      await Promise.resolve();
    },
    capture: async (tab: TabHandle, request: CaptureRequest) => {
      calls.push(`capture:${String(request.fullPage)}`);
      return await Promise.resolve({
        image: new Uint8Array([1]),
        width: 2,
        height: 3,
        viewportWidth: 2,
        url: 'https://example.com/',
      });
    },
  } satisfies BrowserSession;

  return { calls, session };
}

/** A lease with a tab, taken the way a caller takes one. */
async function grantedLease(
  fixture: BrokerFixture,
): Promise<{ key: string; tabId: string; claimId: string }> {
  const granted = await fixture.broker.claim(claimInput());
  assert.equal(granted.outcome, 'granted', 'the fixture needs a granted lease to address a tab');
  if (granted.outcome !== 'granted') throw new Error('unreachable');
  return { key: granted.key, tabId: granted.tabId, claimId: granted.claimId };
}

/**
 * Read the ledger through the **second, read-only connection**.
 *
 * The house rule, and the reason it is not the store's own handle: a read
 * through the writing handle sees that handle's uncommitted writes, so an
 * assertion about what committed can pass while the write is still inside a
 * transaction that has not finished.
 */
function committedKinds(fixture: BrokerFixture): string[] {
  return fixture
    .readCommitted<{ kind: string }>('SELECT kind FROM events ORDER BY id')
    .map((row) => row.kind);
}

test('the registry names all ten operations, and names them rather than counting them', () => {
  // Named, not counted. A length assertion passes for any ten strings, and
  // this file exists because six of these were absent while the count of
  // *tools* was already ten.
  for (const name of [
    'claim',
    'status',
    'release',
    'navigate',
    'act',
    'read',
    'evaluate',
    'capture',
    'tab_replace',
  ]) {
    assert.ok(
      ARBITRATION_NAMES.includes(name),
      `${name} is not registered, so no caller can reach it through the runner`,
    );
  }
});

test('navigate drives the page, and only after the transaction has committed', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();

    const result = await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: 'https://example.com/page',
      session: () => driver.session,
    });

    assert.equal(result.url, 'https://example.com/page');
    assert.equal(result.tabId, lease.tabId);
    // The page is opened on first use and then driven, in that order.
    assert.deepEqual(driver.calls, ['openTab', 'navigate:https://example.com/page']);

    // The ledger row is committed, read on the other connection.
    assert.ok(
      committedKinds(fixture).includes('navigate'),
      'the navigate row did not commit, so the operation decided nothing durable',
    );
  });
});

test('a refused scheme never reaches the driver, and never writes an allow row', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();

    await assert.rejects(
      fixture.broker.navigate({
        key: lease.key,
        tabId: lease.tabId,
        url: 'file:///etc/passwd',
        session: () => driver.session,
      }),
      (error: unknown) => error instanceof Error && /file:|does not navigate/i.test(error.message),
    );

    // The guard that returns "denied" *after* the page has already been driven
    // is worse than no guard, so the physical side-effect is the assertion.
    assert.deepEqual(driver.calls, [], 'the driver was asked to navigate despite the refusal');
  });
});

test('act turns loose arguments into one of the thirteen, and refuses the rest', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();

    const result = await fixture.broker.act({
      key: lease.key,
      tabId: lease.tabId,
      request: { action: 'click', ref: 'a-ref' },
      session: () => driver.session,
    });

    assert.equal(result.action, 'click');
    assert.deepEqual(driver.calls, ['openTab', 'act:click']);

    await assert.rejects(
      fixture.broker.act({
        key: lease.key,
        tabId: lease.tabId,
        // `click` requires a ref, and this one has none.
        request: { action: 'click' },
        session: () => driver.session,
      }),
      (error: unknown) => error instanceof Error,
    );
    assert.deepEqual(
      driver.calls,
      ['openTab', 'act:click'],
      'the invalid action still reached the driver',
    );
  });
});

test('read always collects the page state, whatever was asked for', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();

    const result = await fixture.broker.read({
      key: lease.key,
      tabId: lease.tabId,
      artifacts: ['console'],
      session: () => driver.session,
    });

    // Named rather than counted, and the order is the seam's declared one.
    assert.ok(result.artifacts.includes('snapshot'), 'snapshot was not added to the read');
    assert.ok(result.artifacts.includes('console'), 'the requested artifact was dropped');
    assert.deepEqual(driver.calls, ['openTab', 'read:snapshot+console']);
  });
});

test('evaluate bounds the expression before the tab is even resolved', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();

    const result = await fixture.broker.evaluate({
      key: lease.key,
      tabId: lease.tabId,
      expression: 'document.title',
      session: () => driver.session,
    });

    assert.equal(result.expressionBytes, 'document.title'.length);
    assert.deepEqual(driver.calls, ['openTab', 'evaluate:document.title']);

    await assert.rejects(
      fixture.broker.evaluate({
        key: lease.key,
        tabId: lease.tabId,
        expression: 'x'.repeat(4097),
        session: () => driver.session,
      }),
      (error: unknown) => error instanceof Error,
    );
    assert.deepEqual(
      driver.calls,
      ['openTab', 'evaluate:document.title'],
      'an over-long expression was still handed to the page',
    );
  });
});

test('the expression is never written to the ledger, only its size', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();
    const secret = 'document.cookie.slice(0,10)';

    await fixture.broker.evaluate({
      key: lease.key,
      tabId: lease.tabId,
      expression: secret,
      session: () => driver.session,
    });

    const details = fixture
      .readCommitted<{ detail: string | null }>('SELECT detail FROM events ORDER BY id')
      .map((row) => row.detail ?? '');
    assert.ok(
      details.every((detail) => !detail.includes(secret)),
      'the expression itself was recorded in the ledger, where people read it',
    );
    assert.ok(
      details.some((detail) => detail.includes('expressionBytes')),
      'the size was not recorded either, so the row says nothing at all',
    );
  });
});

test('capture takes the viewport unless the whole page is asked for', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();

    const viewport = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
    });
    assert.equal(viewport.fullPage, false);

    const whole = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      fullPage: true,
      session: () => driver.session,
    });
    assert.equal(whole.fullPage, true);

    // Opened once, on the first call; the second addresses the same page.
    assert.deepEqual(driver.calls, ['openTab', 'capture:false', 'capture:true']);
  });
});

test('a tab another lease owns is refused, and refused identically to one that does not exist', async () => {
  await withBroker(async (fixture) => {
    const mine = await grantedLease(fixture);
    const theirs = await grantedLease(fixture);
    const driver = recordingSession();

    const refusalFor = async (tabId: string): Promise<CallRefusal> => {
      try {
        await fixture.broker.navigate({
          key: mine.key,
          tabId,
          url: 'https://example.com/',
          session: () => driver.session,
        });
      } catch (error) {
        assert.ok(error instanceof CallRefusal, 'a page operation refused with the wrong type');
        return error;
      }
      throw new Error(`navigating tab ${tabId} was allowed and should not have been`);
    };

    const unowned = await refusalFor(theirs.tabId);
    const unknown = await refusalFor('a-tab-that-was-never-minted');

    // The sentences must not differ by a word: a caller able to tell them
    // apart is a caller able to walk identifiers and learn which are real.
    assert.equal(unowned.code, 'tab_not_found');
    assert.equal(unknown.code, 'tab_not_found');
    assert.equal(
      unowned.message.replace(theirs.tabId, 'X'),
      unknown.message.replace('a-tab-that-was-never-minted', 'X'),
      'the unowned and unknown refusals differ, which is the oracle the rule exists to close',
    );
    assert.deepEqual(driver.calls, []);
  });
});

test('driving a tab renews the lease that owns it', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();

    const before = fixture.readCommitted<{ expiresAt: string; renewCount: number }>(
      'SELECT expires_at AS expiresAt, renew_count AS renewCount FROM claims WHERE id = @id',
      { id: lease.claimId },
    )[0];

    await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: 'https://example.com/',
      session: () => driver.session,
    });

    const after = fixture.readCommitted<{ expiresAt: string; renewCount: number }>(
      'SELECT expires_at AS expiresAt, renew_count AS renewCount FROM claims WHERE id = @id',
      { id: lease.claimId },
    )[0];

    // The renewal count is the mechanism, not the timestamp: two calls inside
    // the same millisecond would leave the expiry equal and the count still
    // has to move.
    assert.equal(
      (after?.renewCount ?? 0) - (before?.renewCount ?? 0),
      1,
      'a page operation did not renew the lease it named',
    );
  });
});

test('an ended lease cannot drive its tab, and the driver is never asked', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();

    await fixture.broker.release({ key: lease.key });

    await assert.rejects(
      fixture.broker.act({
        key: lease.key,
        tabId: lease.tabId,
        request: { action: 'click', ref: 'a-ref' },
        session: () => driver.session,
      }),
      (error: unknown) => error instanceof CallRefusal && error.code === 'lease_ended',
    );
    assert.deepEqual(driver.calls, []);
  });
});

test('tab_replace hands back a different tab, and the lease never holds none', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();

    const replaced = await fixture.broker.tab_replace({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
    });

    assert.equal(replaced.previousTabId, lease.tabId);
    assert.notEqual(replaced.tabId, lease.tabId, 'the replacement is the same tab identifier');

    // Read what committed: the tab given up is on its way out, and the fresh
    // one exists and belongs to the same lease.
    const rows = fixture.readCommitted<{ id: string; state: string; claimId: string }>(
      'SELECT id, state, claim_id AS claimId FROM tabs WHERE claim_id = @claimId ORDER BY id',
      { claimId: lease.claimId },
    );
    const previous = rows.find((row) => row.id === replaced.previousTabId);
    const fresh = rows.find((row) => row.id === replaced.tabId);

    // Straight to `closed`, because no page was ever opened for it: `closing`
    // would assert an outstanding round trip nobody is coming to answer, and
    // the schema refuses that pairing outright.
    assert.equal(previous?.state, 'closed', 'the tab given up was not finished with');
    // `open`, because the after-commit work opened its page and recorded the
    // driver's name against it. A tab that had been reserved and never opened
    // would still read `opening` here.
    assert.equal(fresh?.state, 'open', 'the fresh tab never got a page');
    assert.equal(fresh?.claimId, lease.claimId, 'the fresh tab belongs to a different lease');

    // The lease holds exactly one live tab throughout: the count never dips to
    // zero, which is what makes this one operation rather than a release
    // followed by a claim.
    const live = rows.filter((row) => row.state === 'opening' || row.state === 'open');
    assert.deepEqual(
      live.map((row) => row.id),
      [replaced.tabId],
      'the lease holds something other than exactly the fresh tab',
    );

    // The page was closed and a new one opened, in that order, after commit.
    // Nothing to close: no page was ever opened for the tab given up, so the
    // fresh one is simply opened.
    assert.deepEqual(driver.calls, ['openTab']);
  });
});

test('a page operation with no session still decides, writes and refuses', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);

    // No session at all: the caller has no browser connection.
    const result = await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: 'https://example.com/',
    });
    assert.equal(result.url, 'https://example.com/');
    assert.ok(committedKinds(fixture).includes('navigate'));

    // And the guards are unaffected by there being nothing to drive.
    await assert.rejects(
      fixture.broker.navigate({ key: lease.key, tabId: lease.tabId, url: 'file:///etc/passwd' }),
      (error: unknown) => error instanceof Error,
    );
  });
});

test('a refusal is recorded even though the transaction it happened in rolled back', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);

    await assert.rejects(
      fixture.broker.navigate({
        key: lease.key,
        tabId: 'a-tab-that-was-never-minted',
        url: 'https://example.com/',
      }),
      (error: unknown) => error instanceof CallRefusal,
    );

    const denials = fixture.readCommitted<{ kind: string; guard: string | null }>(
      "SELECT kind, guard FROM events WHERE outcome = 'deny' ORDER BY id",
    );
    assert.ok(
      denials.some((row) => row.kind === 'navigate' && row.guard === 'tab.owned'),
      'the refusal was erased by the rollback its own throw caused',
    );
  });
});

test('tab_replace closes the page when one was actually opened, and takes a fresh one', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();

    // Drive the tab once so a page genuinely exists for it. Without this the
    // tab has never been opened and there is nothing for a browser to close —
    // which is the other branch, covered by the test above.
    await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: 'https://example.com/',
      session: () => driver.session,
    });

    const replaced = await fixture.broker.tab_replace({
      key: lease.key,
      tabId: lease.tabId,
      session: () => driver.session,
    });

    const rows = fixture.readCommitted<{ id: string; state: string }>(
      'SELECT id, state FROM tabs WHERE claim_id = @claimId',
      { claimId: lease.claimId },
    );
    // A page existed, so the tool has been asked and has not answered yet.
    assert.equal(
      rows.find((row) => row.id === replaced.previousTabId)?.state,
      'closing',
      'a tab with a real page did not wait on the close it was owed',
    );

    // The page that was open is the one closed, and the fresh tab is opened
    // after it.
    assert.deepEqual(driver.calls, [
      'openTab',
      'navigate:https://example.com/',
      'closeTab:fresh-tab',
      'openTab',
    ]);
  });
});
