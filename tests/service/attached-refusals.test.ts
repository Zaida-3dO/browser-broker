import assert from 'node:assert/strict';
import test from 'node:test';

import { AttachedError } from '../../src/attach/errors.ts';
import type {
  ActionRequest,
  BrowserSession,
  CaptureRequest,
  ReadArtifact,
  StorageSeedEntry,
  TabHandle,
} from '../../src/browser/driver.ts';
import { BrokerError } from '../../src/errors.ts';
import { blankImage, encodePng } from '../../src/diff/image.ts';
import type { SecretResolver } from '../../src/secrets/resolver.ts';
import { withBroker, type BrokerFixture } from '../helpers/broker.ts';

/**
 * Attached refusals decided **by the service** (§7.1's attached rows, §13n).
 *
 * ── Why these exist beside the session's own refusal tests ──────────────
 *
 * The session's refusals are complete and well tested — `attached.test.ts`
 * reads its call log for every one of them — but they fire **inside the
 * after-commit closure**, and by then the operation has been appended to
 * the ledger as `allow`, `pageFor` may have opened a tab in a person's
 * window, and the caller's answer is `outcome: accepted` with
 * `pageDriven: false`. A refusal that arrives like an accepted call is the
 * exact thing CLAUDE.md's rejection rule forbids in the other direction:
 * the response says one thing and the store says another.
 *
 * So every test here asserts the same four things through the shipped
 * service surface — `broker.act`/`evaluate`/`capture` — and the four
 * together are the point:
 *
 * 1. the call **throws** the named rule (the caller sees a refusal);
 * 2. the ledger holds a `deny` row for it and **no `allow` row** for the
 *    verb (what `broker events` will show);
 * 3. the session source was never asked for a session and the fake driver
 *    recorded **no call at all** (the browser was never asked);
 * 4. the tab row is still `opening` with no driver name — **no tab opened**
 *    in the person's window on the way to the refusal.
 */

const ATTACHED_OPTIONS = {
  attachedBrowsers: ['desktop'],
  attachedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
};

/** A granted lease on the attached browser, taken the way a caller takes one. */
async function attachedLease(fixture: BrokerFixture): Promise<{ key: string; tabId: string }> {
  const granted = await fixture.broker.claim({
    sessionId: 'session-a',
    browser: 'desktop',
    purpose: 'a lease on the configured attached browser',
  });
  assert.equal(granted.outcome, 'granted', 'the fixture needs an attached lease');
  if (granted.outcome !== 'granted') throw new Error('unreachable');
  return { key: granted.key, tabId: granted.tabId };
}

/** A session that records what it was asked, and counts being reached at all. */
function recordingSession(): { calls: string[]; session: BrowserSession } {
  const calls: string[] = [];
  const handle: TabHandle = { browser: 'desktop', driverTabId: 'tab-7' };
  // Every method records and answers with a resolved promise; none of them
  // is async, because an async body with no `await` is a lint error in this
  // repository and the promises are what the seam asks for, not the async.
  const session = {
    describe: () => ({
      browser: 'desktop' as const,
      mode: 'headed' as const,
      pid: 0,
      discovery: { endpoint: 'endpoint' },
    }),
    isConnected: () => true,
    openTab: () => {
      calls.push('openTab');
      return Promise.resolve({ browser: 'desktop' as const, driverTabId: 'tab-7' });
    },
    listTabs: () => Promise.resolve([handle]),
    ensureKeeperTab: () => Promise.resolve(handle),
    detach: () => Promise.resolve(),
    closeTab: () => Promise.resolve('closed' as const),
    navigate: (_tab: TabHandle, url: string) => {
      calls.push(`navigate:${url}`);
      return Promise.resolve({ url, title: 'a title', status: 200 });
    },
    act: (_tab: TabHandle, request: { action: string }) => {
      calls.push(`act:${request.action}`);
      return Promise.resolve({
        artifact: 'snapshot' as const,
        path: 'a/path',
        bytes: 1,
        truncated: false,
      });
    },
    read: (_tab: TabHandle, artifacts: readonly ReadArtifact[]) => {
      calls.push(`read:${artifacts.join('+')}`);
      return Promise.resolve(
        artifacts.map((artifact) => ({
          artifact,
          path: 'a/path',
          bytes: 1,
          truncated: false,
        })),
      );
    },
    cookies: () => Promise.resolve([]),
    seedStorage: (_tab: TabHandle, entries: readonly StorageSeedEntry[]) => {
      calls.push(`seedStorage:${String(entries.length)}`);
      return Promise.resolve();
    },
    evaluate: () => {
      calls.push('evaluate');
      return Promise.resolve({ value: { ok: true }, bytes: 13 });
    },
    settlePage: () => {
      calls.push('settlePage');
      return Promise.resolve();
    },
    capture: (_tab: TabHandle, request: CaptureRequest) => {
      calls.push(`capture:${String(request.fullPage)}`);
      return Promise.resolve({
        image: encodePng(blankImage(8, 6)),
        width: 8,
        height: 6,
        viewportWidth: 8,
        url: 'https://example.com/',
      });
    },
    download: () => Promise.reject(new Error('this test never downloads')),
  } satisfies BrowserSession;
  return { calls, session };
}

/** A `SessionSource` that counts every time the service reached for a session. */
function countingSource(driver: { session: BrowserSession }): {
  asked: () => number;
  source: () => BrowserSession;
} {
  let asked = 0;
  return {
    asked: () => asked,
    source: () => {
      asked += 1;
      return driver.session;
    },
  };
}

function refusedWithRule(rule: string) {
  return (error: unknown) => error instanceof BrokerError && error.rule === rule;
}

/** Every `deny` row for one verb kind, with the guard that produced it. */
function denyGuards(fixture: BrokerFixture, kind: string): string[] {
  return fixture
    .readCommitted<{ guard: string }>(
      'SELECT guard FROM events WHERE kind = @kind AND outcome = @outcome ORDER BY id',
      { kind, outcome: 'deny' },
    )
    .map((row) => row.guard);
}

function allowCount(fixture: BrokerFixture, kind: string): number {
  return (
    fixture
      .readCommitted<{ n: number }>(
        'SELECT count(*) AS n FROM events WHERE kind = @kind AND outcome = @outcome',
        { kind, outcome: 'allow' },
      )
      .at(-1)?.n ?? -1
  );
}

/** The physical half that is not a call log: the tab row never opened. */
function assertTabUnopened(fixture: BrokerFixture, tabId: string): void {
  assert.deepEqual(
    fixture.readCommitted<{ state: string; driver_tab_id: string | null }>(
      'SELECT state, driver_tab_id FROM tabs WHERE id = @id',
      { id: tabId },
    ),
    [{ state: 'opening', driver_tab_id: null }],
    'the refusal happened, but a tab opened in the window first',
  );
}

const REFUSALS: {
  readonly name: string;
  readonly kind: 'act' | 'evaluate' | 'capture';
  readonly rule: string;
  readonly call: (
    fixture: BrokerFixture,
    lease: { key: string; tabId: string },
    source: () => BrowserSession,
  ) => Promise<unknown>;
}[] = [
  {
    name: 'a click',
    kind: 'act',
    rule: 'attached.read_only',
    call: (fixture, lease, source) =>
      fixture.broker.act({
        key: lease.key,
        tabId: lease.tabId,
        request: { action: 'click', ref: 'e1' },
        session: source,
      }),
  },
  {
    name: 'a press of a letter, which could reach a focused field',
    kind: 'act',
    rule: 'attached.read_only',
    call: (fixture, lease, source) =>
      fixture.broker.act({
        key: lease.key,
        tabId: lease.tabId,
        request: { action: 'press', value: 'a' },
        session: source,
      }),
  },
  {
    name: 'an evaluate',
    kind: 'evaluate',
    rule: 'attached.no_evaluate',
    call: (fixture, lease, source) =>
      fixture.broker.evaluate({
        key: lease.key,
        tabId: lease.tabId,
        expression: 'document.title.length',
        session: source,
      }),
  },
  {
    name: 'a full-page capture',
    kind: 'capture',
    rule: 'attached.no_full_page',
    call: (fixture, lease, source) =>
      fixture.broker.capture({
        key: lease.key,
        tabId: lease.tabId,
        fullPage: true,
        session: source,
      }),
  },
];

for (const row of REFUSALS) {
  test(`on an attached lease, ${row.name} is refused by the service, not reported as accepted`, async () => {
    await withBroker(async (fixture) => {
      const lease = await attachedLease(fixture);
      const driver = recordingSession();
      const reached = countingSource(driver);

      await assert.rejects(row.call(fixture, lease, reached.source), refusedWithRule(row.rule));

      // (3) the browser was never asked, and never even a session sought:
      assert.equal(reached.asked(), 0, 'the service reached for a session it decided not to use');
      assert.deepEqual(driver.calls, [], 'the refusal was decided after the browser was asked');

      // (4) and no tab opened in the person's window on the way there:
      assertTabUnopened(fixture, lease.tabId);

      // (1)+(2) the ledger and the wire agree: one deny row naming the rule,
      // and the verb's allow row was never written at all.
      assert.deepEqual(denyGuards(fixture, row.kind), [row.rule]);
      assert.equal(allowCount(fixture, row.kind), 0, 'the ledger shows the call as allowed');
    }, ATTACHED_OPTIONS);
  });
}

test('a movement key the page refuses on focus keeps its decision row and writes its own denial', async () => {
  // The split the door work cannot close: whether *this* press could reach
  // a focused field is the page's fact, knowable only at execution, so the
  // decide-time `allow` row was and stays true. What this pins is that the
  // refusal then reaches the store too: one `allow` row (the decision, the
  // lease, the renewal) **and** one `deny` row naming the guard, so
  // `broker events` never reads the press as simply allowed. The wire
  // answer stays `accepted` with `pageDriven: false` and the rule in
  // `notDrivenReason` — the lease is real even though the key never moved,
  // and the key-never-crossed half is the session test's call log.
  await withBroker(async (fixture) => {
    const lease = await attachedLease(fixture);
    const driver = recordingSession();
    // The gate branch: an on-list key that the session refuses with the
    // focus rule — exactly what `attached.test.ts` proves the session does
    // with an empty `Input.dispatchKeyEvent` log behind it.
    const gate = {
      ...driver.session,
      act: (_tab: TabHandle, request: ActionRequest) => {
        driver.calls.push(`act:${request.action}`);
        return Promise.reject(
          new AttachedError(
            'attached.read_only',
            "press of the key is refused while a form control holds the page's focus",
          ),
        );
      },
    } satisfies BrowserSession;

    const result = await fixture.broker.act({
      key: lease.key,
      tabId: lease.tabId,
      request: { action: 'press', value: 'ArrowDown' },
      session: () => gate,
    });
    assert.equal(
      result.pageDriven,
      false,
      'the press reported as driven although the session refused it',
    );
    assert.match(result.notDrivenReason ?? '', /attached\.read_only/);

    // Both halves in the ledger: the decision stays, the refusal joins it.
    assert.deepEqual(denyGuards(fixture, 'act'), ['attached.read_only']);
    assert.equal(
      allowCount(fixture, 'act'),
      1,
      'the split replaced the decision row instead of adding to it',
    );
    assert.deepEqual(
      fixture
        .readCommitted<{ detail: string }>(
          "SELECT detail FROM events WHERE kind = 'act' AND outcome = 'deny' ORDER BY id",
        )
        .map((row) => JSON.parse(row.detail) as unknown),
      [{ action: 'press' }],
    );
    assert.deepEqual(driver.calls, ['openTab', 'act:press']);
  }, ATTACHED_OPTIONS);
});

test('a secret placeholder on an attached act is refused at the service before anything resolves, and the resolver never runs', async () => {
  // The secret half of the same promise. It is carried by the general
  // secret rule, which refuses in this handler **before admission** for
  // every browser — so the attached door needs no secret branch, and the
  // attached lease is refused without a resolver call, without a row, and
  // without a tab.
  const asked: string[] = [];
  const resolver: SecretResolver = (name) => {
    asked.push(name);
    return Promise.resolve({
      value: 'a-value-never-needed',
      origins: ['https://example.com'],
      fields: ['password'],
    });
  };

  await withBroker(async (fixture) => {
    const lease = await attachedLease(fixture);
    const driver = recordingSession();
    const reached = countingSource(driver);

    await assert.rejects(
      fixture.broker.act({
        key: lease.key,
        tabId: lease.tabId,
        request: { action: 'press', value: '{{secret:dashboard-login}}' },
        session: reached.source,
        secretResolver: resolver,
      }),
      refusedWithRule('act.secret_placement'),
    );

    assert.deepEqual(asked, [], 'the secret was resolved on the way to refusing it');
    assert.equal(reached.asked(), 0);
    assert.deepEqual(driver.calls, []);
    assertTabUnopened(fixture, lease.tabId);
    assert.equal(allowCount(fixture, 'act'), 0);
  }, ATTACHED_OPTIONS);
});

test('the door is about the attached rules, not about this browser: scroll and read still run', async () => {
  // The control. Without it, "the guard fired" and "every call to this
  // browser was refused" are the same observation.
  await withBroker(async (fixture) => {
    const lease = await attachedLease(fixture);
    const driver = recordingSession();
    const reached = countingSource(driver);

    const scrolled = await fixture.broker.act({
      key: lease.key,
      tabId: lease.tabId,
      request: { action: 'scroll' },
      session: reached.source,
    });
    assert.equal(scrolled.pageDriven, true, 'the allowed verb did not reach the page');

    const read = await fixture.broker.read({
      key: lease.key,
      tabId: lease.tabId,
      artifacts: ['snapshot'],
      session: () => driver.session,
    });
    assert.equal(read.pageDriven, true);

    // The tab is opened **once**: the act's `pageFor` opened it and recorded
    // the driver name, so the read resolves the same handle from the row.
    assert.deepEqual(driver.calls, ['openTab', 'act:scroll', 'read:snapshot']);
    assert.deepEqual(denyGuards(fixture, 'act'), []);
    assert.equal(allowCount(fixture, 'act'), 1);
  }, ATTACHED_OPTIONS);
});

// ── S2: the site fence at the door, and the grant that rides through ────
//
// Same four assertions per row as every refusal above — the response, the
// rows, the call log, the tab. The fence is where S2 moved the decision
// from: an off-list act must refuse **on the wire**, so the session is
// never reached and no tab opens on the way to the refusal. And the grant
// is the one new piece of data that must provably go in without staying
// anywhere: rows, details, messages and results are all searched for it.

const LISTED_ACT_OPTIONS = { ...ATTACHED_OPTIONS, attachedActSites: ['example.com'] };
const OFF_LIST_ACT_OPTIONS = { ...ATTACHED_OPTIONS, attachedActSites: ['other.example.net'] };

/** Navigate the fake way: requested url, same url back as the arrival. */
async function arriveAt(
  fixture: BrokerFixture,
  lease: { key: string; tabId: string },
  driver: { session: BrowserSession },
  url: string,
): Promise<void> {
  await fixture.broker.navigate({
    key: lease.key,
    tabId: lease.tabId,
    url,
    session: () => driver.session,
  });
}

test('an act on a listed site is not refused by the fence: it reaches the session and keeps its allow row', async () => {
  await withBroker(async (fixture) => {
    const lease = await attachedLease(fixture);
    const driver = recordingSession();
    await arriveAt(fixture, lease, driver, 'https://example.com/checkout');
    const result = await fixture.broker.act({
      key: lease.key,
      tabId: lease.tabId,
      request: { action: 'click', ref: 'e1' },
      session: () => driver.session,
    });
    assert.equal(result.pageDriven, true, 'the listed act never reached the session');
    assert.deepEqual(driver.calls, [
      'openTab',
      'navigate:https://example.com/checkout',
      'act:click',
    ]);
    assert.equal(allowCount(fixture, 'act'), 1);
    assert.deepEqual(denyGuards(fixture, 'act'), []);
  }, LISTED_ACT_OPTIONS);
});

test('an act on an arrival the list does not name refuses at the door: no act row, no session act, and the denial reaches the ledger', async () => {
  await withBroker(async (fixture) => {
    const lease = await attachedLease(fixture);
    const driver = recordingSession();
    await arriveAt(fixture, lease, driver, 'https://example.com/checkout');
    await assert.rejects(
      fixture.broker.act({
        key: lease.key,
        tabId: lease.tabId,
        request: { action: 'click', ref: 'e1' },
        session: () => driver.session,
      }),
      refusedWithRule('attached.act_site_off_list'),
    );
    assert.equal(allowCount(fixture, 'act'), 0, 'the fence wrote an allow anyway');
    assert.deepEqual(denyGuards(fixture, 'act'), ['attached.act_site_off_list']);
    assert.ok(
      !driver.calls.some((call) => call.startsWith('act:')),
      'the session was asked to act after being refused',
    );
  }, OFF_LIST_ACT_OPTIONS);
});

test('the fence asks where the tab ARRIVED, not where it was sent: a redirect off-list is fenced', async () => {
  await withBroker(async (fixture) => {
    const lease = await attachedLease(fixture);
    const driver = recordingSession();
    // The fake that answers the navigation with a different address than it
    // was asked for — the redirect case the row in `decideNavigate` keeps
    // the whole comment about.
    const redirecting = {
      ...driver.session,
      navigate: (_tab: TabHandle, url: string) => {
        driver.calls.push(`navigate:${url}`);
        return Promise.resolve({
          url: 'https://example.net/landed',
          title: 'somewhere else',
          status: 200,
        });
      },
    } satisfies BrowserSession;
    await arriveAt(fixture, lease, { session: redirecting }, 'https://example.com/start');
    await assert.rejects(
      fixture.broker.act({
        key: lease.key,
        tabId: lease.tabId,
        request: { action: 'click', ref: 'e1' },
        session: () => redirecting,
      }),
      refusedWithRule('attached.act_site_off_list'),
      'the requested address fenced the call while the browser sat on another site',
    );
    assert.equal(allowCount(fixture, 'act'), 0);
  }, LISTED_ACT_OPTIONS);
});

test('a tab that has never navigated is on no list: the act refuses before the session is reached', async () => {
  await withBroker(async (fixture) => {
    const lease = await attachedLease(fixture);
    const driver = recordingSession();
    const reached = countingSource(driver);
    await assert.rejects(
      fixture.broker.act({
        key: lease.key,
        tabId: lease.tabId,
        request: { action: 'click', ref: 'e1' },
        session: reached.source,
      }),
      refusedWithRule('attached.act_site_off_list'),
    );
    assert.equal(reached.asked(), 0);
    assertTabUnopened(fixture, lease.tabId);
    assert.equal(allowCount(fixture, 'act'), 0);
    assert.deepEqual(denyGuards(fixture, 'act'), ['attached.act_site_off_list']);
  }, LISTED_ACT_OPTIONS);
});

test('a gate refusal at the session door joins the ledger beside its decision row, and the split survives', async () => {
  await withBroker(async (fixture) => {
    const lease = await attachedLease(fixture);
    const driver = recordingSession();
    // The session's fuller gate — page facts the door cannot hold — refuses
    // a call the door let through. The decision row stays; the refusal
    // joins it naming **its own** rule, not `read_only`.
    const gate = {
      ...driver.session,
      act: (_tab: TabHandle, request: ActionRequest) => {
        driver.calls.push(`act:${request.action}`);
        return Promise.reject(
          new AttachedError(
            'attached.needs_owner',
            'This step is consequential, so the owner does it: call browser_sign_in with what to press.',
          ),
        );
      },
    } satisfies BrowserSession;
    await arriveAt(fixture, lease, driver, 'https://example.com/checkout');
    const result = await fixture.broker.act({
      key: lease.key,
      tabId: lease.tabId,
      request: { action: 'click', ref: 'e1' },
      session: () => gate,
    });
    assert.equal(result.pageDriven, false);
    assert.match(result.notDrivenReason ?? '', /attached\.needs_owner/);
    assert.deepEqual(denyGuards(fixture, 'act'), ['attached.needs_owner']);
    assert.equal(allowCount(fixture, 'act'), 1);
  }, LISTED_ACT_OPTIONS);
});

test('an owner grant carried by a retry appears in no ledger row, detail, or result', async () => {
  const TOKEN = 'opaque-grant-token-never-printed';
  await withBroker(async (fixture) => {
    const lease = await attachedLease(fixture);
    const driver = recordingSession();
    await arriveAt(fixture, lease, driver, 'https://example.com/checkout');
    const result = await fixture.broker.act({
      key: lease.key,
      tabId: lease.tabId,
      request: { action: 'click', ref: 'e1' },
      ownerGrant: TOKEN,
      session: () => driver.session,
    });
    assert.equal(result.pageDriven, true);
    // Every event the call wrote, searched whole — rows and details alike.
    const rows = fixture.readCommitted<{ detail: string | null }>(
      'SELECT detail FROM events ORDER BY id',
    );
    assert.ok(rows.length > 0, 'the fixture wrote no rows to search');
    for (const row of rows) {
      assert.ok(!(row.detail ?? '').includes(TOKEN), 'a ledger row carried the grant token');
    }
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }, LISTED_ACT_OPTIONS);
});
