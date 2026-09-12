import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ActionRequest,
  BrowserSession,
  ReadArtifact,
  TabHandle,
} from '../../src/browser/driver.ts';
import { claimInput, withBroker, type BrokerFixture } from '../helpers/broker.ts';

/**
 * **`navigate` reports where the page ARRIVED, not where it was SENT.**
 *
 * ── The defect this file exists to catch, stated as a mechanism ──────────
 *
 * The handler validated the caller's address, scheduled the navigation as
 * after-commit work, threw the driver's answer away, and reported the
 * validated *request* as `url`. The driver had the right value the whole time
 * — `real.ts` reads `page.url()` after the load settles — so this was a field
 * being dropped, not a fact being unavailable.
 *
 * Measured against the shipped binary over real pipes: `navigate` to a
 * three-hop redirect answered with the address that was typed, while
 * `evaluate location.href` on the same lease reported somewhere else, and a
 * cross-origin redirect reported the original host after the tab had moved to
 * a different site.
 *
 * ── Why a redirect is the only shape that can prove this ────────────────
 *
 * **A non-redirecting navigation cannot distinguish the two implementations.**
 * When the requested address and the arrived address are equal, reporting
 * either one produces the same string, so a test built on an ordinary URL
 * passes identically against the defect and against the fix — which is
 * precisely why this survived a suite that already had navigation tests. The
 * defect is only observable in the case where the field carries information.
 *
 * That is also why the fake driver needs a configurable redirect. A fake that
 * answers with the address it was handed makes *every* fake navigation the
 * indistinguishable case, and a fake that cannot move the page cannot test a
 * field about the page having moved.
 *
 * ── The control, and what it is controlling for ─────────────────────────
 *
 * The non-redirecting test below is kept deliberately, and it is not
 * redundant. A "fix" that always reported some other address — the last URL
 * seen, a hard-coded value, the tab's previous location — would satisfy the
 * redirect assertion and be wrong. The pair says: the field follows the page,
 * both when the page moves and when it does not.
 */

/** Where the redirecting fixture is sent, and where it ends up. */
const REQUESTED = 'https://example.com/redirect-chain';
const ARRIVED = 'https://example.org/final-destination';

interface DriverLog {
  readonly session: BrowserSession;
  readonly calls: string[];
}

/**
 * A session whose navigation lands somewhere other than where it was aimed.
 *
 * `arriveAt` is a function of the request rather than a constant so one
 * fixture serves both halves of the pair: the redirecting test sends the one
 * address it rewrites, the control sends anything else and arrives there.
 */
function redirectingSession(
  arriveAt: (requested: string) => string,
  title = 'the page that was arrived at',
  status: number | null = 200,
): DriverLog {
  const calls: string[] = [];
  const handle: TabHandle = { browser: 'regular', driverTabId: 'driver-tab' };

  const session: BrowserSession = {
    describe: () => ({
      browser: 'regular' as const,
      mode: 'headless' as const,
      pid: 1,
      discovery: { endpoint: 'endpoint' },
    }),
    openTab: async () =>
      await Promise.resolve({ browser: 'regular' as const, driverTabId: 'fresh-tab' }),
    listTabs: async () => await Promise.resolve([handle]),
    ensureKeeperTab: async () => await Promise.resolve(handle),
    detach: async () => {
      await Promise.resolve();
    },
    closeTab: async () => {
      await Promise.resolve();
    },
    navigate: async (_tab: TabHandle, url: string) => {
      calls.push(`navigate:${url}`);
      // The shape of a real redirect: asked for one address, answers with
      // another. The title is derived from the ARRIVED address, because a
      // fixture titling the requested one would hide the same bug one field
      // across.
      return await Promise.resolve({ url: arriveAt(url), title, status });
    },
    seedStorage: async () => {
      await Promise.resolve();
    },
    act: async (_tab: TabHandle, request: ActionRequest) =>
      await Promise.resolve({
        artifact: 'snapshot' as const,
        path: `a/path/${request.action}`,
        bytes: 1,
        truncated: false,
      }),
    read: async (_tab: TabHandle, artifacts: readonly ReadArtifact[]) =>
      await Promise.resolve(
        artifacts.map((artifact) => ({ artifact, path: 'a/path', bytes: 1, truncated: false })),
      ),
    cookies: async () => await Promise.resolve([]),
    evaluate: async () => await Promise.resolve({ value: undefined, bytes: 0 }),
    settlePage: async () => {
      await Promise.resolve();
    },
    // Never called by any test here — navigation is the whole subject — but
    // the seam requires it, and a stub that does not typecheck is a stub
    // nobody can extend.
    capture: async () =>
      await Promise.resolve({
        image: Buffer.alloc(0),
        width: 1,
        height: 1,
        viewportWidth: 1,
        url: 'https://example.com/',
      }),
  };

  return { session, calls };
}

/** A lease holding a tab, which is what every navigation below needs. */
async function grantedLease(
  fixture: BrokerFixture,
): Promise<{ readonly key: string; readonly tabId: string }> {
  const granted = await fixture.broker.claim(claimInput());
  assert.equal(granted.outcome, 'granted', 'the fixture could not obtain a lease to navigate');
  return { key: granted.key, tabId: granted.tabId };
}

/**
 * THE MUTATION THIS CATCHES: reporting the requested address.
 *
 * Restoring the defect — `url` on the value object instead of the getter over
 * the driver's answer — makes this assert `https://example.com/redirect-chain`
 * against `https://example.org/final-destination` and fail. Verified by
 * making that exact change.
 */
test('navigate through a redirect reports the FINAL address, not the requested one', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = redirectingSession((requested) =>
      requested === REQUESTED ? ARRIVED : requested,
    );

    const result = await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: REQUESTED,
      session: () => driver.session,
    });

    // Stated as an inequality first, because that is the defect in its own
    // terms: the field must not be an echo of the input.
    assert.notEqual(
      result.url,
      REQUESTED,
      'navigate echoed the requested address back — the tab redirected elsewhere and the caller was told it had not',
    );
    assert.equal(result.url, ARRIVED);

    // The driver was genuinely asked for the address the caller gave, so the
    // difference above is a redirect rather than the service rewriting the
    // request before sending it.
    assert.deepEqual(driver.calls, [`navigate:${REQUESTED}`]);

    // And the page really was driven, so this is not the fallback path
    // reporting the request for the honest reason.
    assert.equal(result.pageDriven, true);
  });
});

/**
 * The control described in the header: the field follows the page when the
 * page does not move either.
 *
 * THE MUTATION THIS CATCHES: a fix that reports some address other than the
 * arrived one — a constant, or a stale previous location — which the
 * redirecting test alone would accept.
 */
test('navigate without a redirect reports the address it was given', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    // Rewrites only REQUESTED, and this test does not send that.
    const driver = redirectingSession((requested) =>
      requested === REQUESTED ? ARRIVED : requested,
    );
    const direct = 'https://example.com/a-page-that-does-not-redirect';

    const result = await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: direct,
      session: () => driver.session,
    });

    assert.equal(result.url, direct);
    assert.equal(result.pageDriven, true);
  });
});

/**
 * The two fields the tool description advertised and the response never
 * carried. The driver collected both all along.
 *
 * THE MUTATION THIS CATCHES: dropping either getter from the value object,
 * which returns the response to the shape the defect report measured —
 * `{claimId, tabId, expiresAt, url, pageDriven}` and nothing else.
 */
test('navigate returns the title and the status the driver collected', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = redirectingSession((requested) => requested, 'The Arrived Title', 404);

    const result = await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: 'https://example.com/missing',
      session: () => driver.session,
    });

    assert.equal(result.title, 'The Arrived Title');
    assert.equal(result.status, 404);
  });
});

/**
 * A navigation with no response to have a status from — `about:blank` and its
 * kind — is `null`, and `null` is not `undefined`.
 *
 * THE MUTATION THIS CATCHES: spelling the getter `arrived?.status ?? undefined`
 * or coercing with a falsy test, either of which would turn a genuine "there
 * was no response" into "the browser was never driven" and lose the
 * distinction the driver is careful to preserve.
 */
test('a navigation with no response reports a null status, distinct from an absent one', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = redirectingSession((requested) => requested, 'blank', null);

    const result = await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: 'about:blank',
      session: () => driver.session,
    });

    assert.equal(result.status, null);
    assert.ok('status' in result, 'the status key was absent, not null');
  });
});

/**
 * The not-driven path: no browser, so nothing redirected, so reporting the
 * request is the honest answer — and the title and status say nothing rather
 * than inventing something.
 *
 * THE MUTATION THIS CATCHES: giving `title` a default such as `''`, which
 * would make a page that was never loaded indistinguishable from one that
 * loaded with an empty title.
 */
test('with no browser, navigate reports the requested address and no title or status', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);

    const result = await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: REQUESTED,
      // No session: this build has no browser to drive.
    });

    assert.equal(result.pageDriven, false);
    // Honest, because nothing redirected — there was no navigation at all.
    assert.equal(result.url, REQUESTED);
    assert.equal(result.title, undefined);
    assert.equal(result.status, undefined);
  });
});

/**
 * A browser that fails partway leaves the same absence, and must not report a
 * final address it never reached.
 *
 * THE MUTATION THIS CATCHES: assigning the driver's answer before awaiting
 * it, or catching the failure inside the closure — either would let a failed
 * navigation report a URL as though it had arrived.
 */
test('a navigation that fails reports the requested address and stays not-driven', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = redirectingSession((requested) => requested);
    const failing: BrowserSession = {
      ...driver.session,
      navigate: () => {
        throw new Error('the browser stopped answering');
      },
    };

    const result = await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: REQUESTED,
      session: () => failing,
    });

    assert.equal(result.pageDriven, false);
    assert.equal(result.url, REQUESTED);
    assert.equal(result.title, undefined);
  });
});
