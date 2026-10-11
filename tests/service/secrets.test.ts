import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ActionRequest,
  BrowserSession,
  CaptureRequest,
  ReadArtifact,
  ReadOptions,
  SecretScope,
  TabHandle,
} from '../../src/browser/driver.ts';
import { BrokerError } from '../../src/errors.ts';
import type { ResolvedSecret, SecretResolver } from '../../src/secrets/resolver.ts';
import { claimInput, withBroker, type BrokerFixture } from '../helpers/broker.ts';

/**
 * The service's half of secrets (`SCHEMA.md` §3.8a): every rule that can be
 * decided without a page, and the plumbing that hands the driver its scope.
 *
 * Every refusal asserts **the physical side-effect** as well as the response:
 * that the driver was never asked to do anything. A refusal reported after the
 * value had been typed would be worse than none.
 */

/** The value the stand-in resolver answers with. Searched for in every row. */
const VALUE = 'SERVICE-FAKE-VALUE-4417';

/** A resolver that answers every name with {@link VALUE}, counting its calls. */
function countingResolver(): { resolver: SecretResolver; asked: string[] } {
  const asked: string[] = [];
  const resolver: SecretResolver = (name) => {
    asked.push(name);
    const answer: ResolvedSecret = {
      value: VALUE,
      origins: ['https://example.com'],
      fields: ['password'],
    };
    return Promise.resolve(answer);
  };
  return { resolver, asked };
}

interface Recorded {
  readonly calls: string[];
  readonly requests: ActionRequest[];
  /** The scope each call was handed, in call order, `undefined` included. */
  readonly scopes: (SecretScope | undefined)[];
  readonly session: BrowserSession;
}

/**
 * A session that records every call and the secret scope it was handed. When
 * `typeSecrets` is set, `act` behaves as the real driver does on success: it
 * resolves each sentinel and reports the use through the scope.
 */
function recordingSession(options: { typeSecrets?: boolean } = {}): Recorded {
  const calls: string[] = [];
  const requests: ActionRequest[] = [];
  const scopes: (SecretScope | undefined)[] = [];
  const handle: TabHandle = { browser: 'regular', driverTabId: 'driver-tab' };
  const artifact = { artifact: 'snapshot' as const, path: 'a/path', bytes: 1, truncated: false };

  const session = {
    describe: () => ({
      browser: 'regular' as const,
      mode: 'headless' as const,
      pid: 1,
      discovery: { endpoint: 'endpoint' },
    }),
    isConnected: () => true,
    openTab: async () => {
      calls.push('openTab');
      // Distinct per tab: two leases' tabs are two physical pages.
      return await Promise.resolve({
        browser: 'regular' as const,
        driverTabId: `fresh-tab-${String(calls.length)}`,
      });
    },
    listTabs: async () => await Promise.resolve([handle]),
    ensureKeeperTab: async () => await Promise.resolve(handle),
    detach: async () => {
      await Promise.resolve();
    },
    closeTab: async () => await Promise.resolve('closed' as const),
    navigate: async (tab: TabHandle, url: string, waitMs?: number, secrets?: SecretScope) => {
      calls.push('navigate');
      scopes.push(secrets);
      return await Promise.resolve({ url, title: 'a title', status: 200 });
    },
    act: async (tab: TabHandle, request: ActionRequest, secrets?: SecretScope) => {
      calls.push(`act:${request.action}`);
      requests.push(request);
      scopes.push(secrets);
      if (options.typeSecrets === true && secrets !== undefined && 'value' in request) {
        const name = /^\{\{secret:(.+)\}\}$/u.exec(request.value)?.[1];
        if (name !== undefined) {
          await secrets.resolve(name);
          secrets.record({
            name,
            origin: 'https://example.com',
            field: 'password',
            outcome: 'allow',
          });
        }
      }
      return await Promise.resolve(artifact);
    },
    read: async (tab: TabHandle, artifacts: readonly ReadArtifact[], options?: ReadOptions) => {
      calls.push('read');
      scopes.push(options?.secrets);
      return await Promise.resolve(artifacts.map((a) => ({ ...artifact, artifact: a })));
    },
    cookies: async () => await Promise.resolve([]),
    seedStorage: async () => {
      await Promise.resolve();
    },
    evaluate: async () => {
      calls.push('evaluate');
      return await Promise.resolve({ value: null, bytes: 4 });
    },
    settlePage: async () => {
      await Promise.resolve();
    },
    capture: async (tab: TabHandle, request: CaptureRequest) => {
      calls.push('capture');
      scopes.push(request.secrets);
      return await Promise.resolve({
        image: Buffer.alloc(0),
        width: 1,
        height: 1,
        viewportWidth: 1,
        url: 'https://example.com/',
      });
    },
  } as unknown as BrowserSession;

  return { calls, requests, scopes, session };
}

async function grantedLease(
  fixture: BrokerFixture,
): Promise<{ key: string; tabId: string; claimId: string }> {
  const granted = await fixture.broker.claim(claimInput());
  assert.equal(granted.outcome, 'granted');
  if (granted.outcome !== 'granted') throw new Error('unreachable');
  return { key: granted.key, tabId: granted.tabId, claimId: granted.claimId };
}

/** Assert a call refused with a given rule, and that the value appears nowhere in it. */
function refusedWith(rule: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof BrokerError, `expected a refusal, got ${String(error)}`);
    assert.equal(error.rule, rule, error.message);
    assert.ok(!error.message.includes(VALUE));
    return true;
  };
}

/** Every event row's text, for searching for the value. */
function ledgerText(fixture: BrokerFixture): string {
  return JSON.stringify(fixture.readCommitted('SELECT * FROM events'));
}

/* ───────────────────── refused before anything happens ───────────────────── */

test('with no resolver configured, a sentinel is refused and the driver is never asked', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();

    await assert.rejects(
      fixture.broker.act({
        key: lease.key,
        tabId: lease.tabId,
        request: { action: 'fill', ref: 'e1', value: '{{secret:login}}' },
        session: () => driver.session,
      }),
      (error: unknown) => {
        refusedWith('act.secret_resolver_configured')(error);
        assert.match((error as Error).message, /BROKER_SECRET_RESOLVER/u);
        return true;
      },
    );
    assert.deepEqual(driver.calls, []);
    assert.deepEqual(fixture.readCommitted("SELECT * FROM events WHERE kind = 'act'"), []);
    assert.deepEqual(fixture.readCommitted('SELECT * FROM tab_secrets'), []);
  });
});

test('a sentinel anywhere it is not resolved is refused, and the driver is never asked', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const { resolver, asked } = countingResolver();
    const driver = recordingSession();

    const misplaced: unknown[] = [
      { action: 'press', value: '{{secret:login}}' },
      { action: 'select', ref: 'e1', value: '{{secret:login}}' },
      { action: 'dialog', response: { accept: true, promptText: '{{secret:login}}' } },
      // Embedded in other text, and malformed.
      { action: 'fill', ref: 'e1', value: 'prefix-{{secret:login}}' },
      { action: 'type', ref: 'e1', value: '{{secret:bad name}}' },
      { action: 'fill_form', fields: [{ ref: 'e1', value: 'x{{secret:login}}' }] },
    ];
    for (const request of misplaced) {
      await assert.rejects(
        fixture.broker.act({
          key: lease.key,
          tabId: lease.tabId,
          request,
          session: () => driver.session,
          secretResolver: resolver,
        }),
        refusedWith('act.secret_placement'),
        JSON.stringify(request),
      );
    }

    await assert.rejects(
      fixture.broker.navigate({
        key: lease.key,
        tabId: lease.tabId,
        url: 'https://example.com/?q={{secret:login}}',
        session: () => driver.session,
        secretResolver: resolver,
      }),
      refusedWith('navigate.secret_placement'),
    );
    await assert.rejects(
      fixture.broker.evaluate({
        key: lease.key,
        tabId: lease.tabId,
        expression: '"{{secret:login}}"',
        session: () => driver.session,
        secretResolver: resolver,
      }),
      refusedWith('evaluate.secret_placement'),
    );

    assert.deepEqual(driver.calls, [], 'a misplaced sentinel reached the driver');
    assert.deepEqual(asked, [], 'a misplaced sentinel was resolved');
    assert.deepEqual(fixture.readCommitted('SELECT * FROM tab_secrets'), []);
  });
});

test('a sentinel in a storage seed refuses the claim, and no lease is granted', async () => {
  await withBroker(async (fixture) => {
    await assert.rejects(
      fixture.broker.claim(
        claimInput({
          storageSeed: [
            {
              origin: 'https://example.com',
              area: 'local',
              key: 'token',
              value: '{{secret:login}}',
            },
          ],
        }),
      ),
      refusedWith('claim.secret_placement'),
    );
    assert.deepEqual(fixture.readCommitted('SELECT * FROM claims'), []);
  });
});

/* ───────────────────── a resolvable sentinel ───────────────────── */

test('a sentinel reaches the driver unresolved, and the ledger holds the name only', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const { resolver, asked } = countingResolver();
    const driver = recordingSession({ typeSecrets: true });

    const result = await fixture.broker.act({
      key: lease.key,
      tabId: lease.tabId,
      request: { action: 'fill', ref: 'e1', value: '{{secret:login/main}}' },
      session: () => driver.session,
      secretResolver: resolver,
    });
    assert.equal(result.pageDriven, true);
    assert.ok(!JSON.stringify(result).includes(VALUE), 'the result echoed the value');

    // The driver got the sentinel, never the value, and a scope to resolve it.
    const request = driver.requests[0];
    assert.ok(request?.action === 'fill');
    assert.equal(request.value, '{{secret:login/main}}');
    const scope = driver.scopes[0];
    assert.ok(scope !== undefined, 'the driver was not handed a scope');
    assert.deepEqual(scope.received, [], 'nothing was received before this call');
    assert.deepEqual(asked, ['login/main'], 'resolution happened at the sink, once');

    // The act row names the secret; the audit row records name, origin and
    // field; nothing anywhere holds the value.
    const acts = fixture.readCommitted<{ detail: string }>(
      "SELECT detail FROM events WHERE kind = 'act'",
    );
    assert.deepEqual(JSON.parse(acts[0]?.detail ?? '{}'), {
      action: 'fill',
      secrets: ['login/main'],
    });
    const audits = fixture.readCommitted<{ outcome: string; detail: string }>(
      "SELECT outcome, detail FROM events WHERE kind = 'secret_filled'",
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.outcome, 'allow');
    assert.deepEqual(JSON.parse(audits[0]?.detail ?? '{}'), {
      name: 'login/main',
      origin: 'https://example.com',
      field: 'password',
    });
    assert.ok(!ledgerText(fixture).includes(VALUE), 'the ledger holds the value');

    assert.deepEqual(
      fixture.readCommitted<{ name: string }>('SELECT name FROM tab_secrets').map((r) => r.name),
      ['login/main'],
    );
  });
});

test('a refused use is recorded as a denial carrying the rule', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const { resolver } = countingResolver();
    const driver = recordingSession();
    // A driver that refuses on the binding, as the real one does for a wrong origin.
    const refusing = {
      ...driver.session,
      act: async (tab: TabHandle, request: ActionRequest, secrets?: SecretScope) => {
        secrets?.record({
          name: 'login',
          origin: 'https://example.org',
          field: undefined,
          outcome: 'deny',
          rule: 'act.secret_origin_bound',
        });
        return await Promise.reject(new BrokerError('act.secret_origin_bound', 'refused'));
      },
    } as BrowserSession;

    const result = await fixture.broker.act({
      key: lease.key,
      tabId: lease.tabId,
      request: { action: 'type', ref: 'e1', value: '{{secret:login}}' },
      session: () => refusing,
      secretResolver: resolver,
    });
    assert.equal(result.pageDriven, false);
    assert.match(result.notDrivenReason ?? '', /act\.secret_origin_bound/u);

    const denials = fixture.readCommitted<{ outcome: string; guard: string; detail: string }>(
      "SELECT outcome, guard, detail FROM events WHERE kind = 'secret_filled'",
    );
    assert.deepEqual(
      denials.map((row) => [row.outcome, row.guard, JSON.parse(row.detail) as unknown]),
      [['deny', 'act.secret_origin_bound', { name: 'login', origin: 'https://example.org' }]],
    );
  });
});

/* ───────────────────── for the rest of the lease ───────────────────── */

test('once a tab has received a secret, evaluate on it is refused and never reaches the page', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const { resolver } = countingResolver();
    const driver = recordingSession({ typeSecrets: true });

    // Before: evaluate works, so the refusal below is caused by the secret.
    await fixture.broker.evaluate({
      key: lease.key,
      tabId: lease.tabId,
      expression: '1 + 1',
      session: () => driver.session,
    });
    assert.deepEqual(
      driver.calls.filter((c) => c === 'evaluate'),
      ['evaluate'],
    );

    await fixture.broker.act({
      key: lease.key,
      tabId: lease.tabId,
      request: { action: 'fill', ref: 'e1', value: '{{secret:login}}' },
      session: () => driver.session,
      secretResolver: resolver,
    });

    await assert.rejects(
      fixture.broker.evaluate({
        key: lease.key,
        tabId: lease.tabId,
        expression: "document.querySelector('input[type=password]').value",
        session: () => driver.session,
        secretResolver: resolver,
      }),
      refusedWith('evaluate.secret_tab'),
    );
    assert.deepEqual(
      driver.calls.filter((c) => c === 'evaluate'),
      ['evaluate'],
      'the refused evaluation reached the driver',
    );
    const denied = fixture.readCommitted<{ guard: string }>(
      "SELECT guard FROM events WHERE kind = 'evaluate' AND outcome = 'deny'",
    );
    assert.deepEqual(
      denied.map((row) => row.guard),
      ['evaluate.secret_tab'],
    );
  });
});

test('a tab that has received a secret hands every later read, capture, navigate and act a scope', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const { resolver } = countingResolver();
    const driver = recordingSession({ typeSecrets: true });
    const base = { key: lease.key, tabId: lease.tabId, session: () => driver.session };

    // Before any secret: no scope at all, so nothing is resolved or scrubbed.
    await fixture.broker.read({ ...base, secretResolver: resolver });
    assert.equal(driver.scopes.at(-1), undefined, 'an untouched tab was handed a scope');

    await fixture.broker.act({
      ...base,
      request: { action: 'fill_form', fields: [{ ref: 'e1', value: '{{secret:login}}' }] },
      secretResolver: resolver,
    });

    await fixture.broker.read({ ...base, secretResolver: resolver });
    await fixture.broker.navigate({
      ...base,
      url: 'https://example.com/',
      secretResolver: resolver,
    });
    await fixture.broker.capture({
      ...base,
      secretResolver: resolver,
      artifacts: fixture.artifacts,
    });
    await fixture.broker.act({
      ...base,
      request: { action: 'click', ref: 'e2' },
      secretResolver: resolver,
    });

    const later = driver.scopes.slice(2);
    assert.equal(later.length, 4);
    for (const scope of later) {
      assert.ok(scope !== undefined, 'a later call on a secret-bearing tab had no scope');
      assert.deepEqual(scope.received, ['login']);
    }
  });
});

test('a secret-bearing tab with no resolver left fails closed rather than unscrubbed', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const { resolver } = countingResolver();
    const driver = recordingSession({ typeSecrets: true });
    const base = { key: lease.key, tabId: lease.tabId, session: () => driver.session };
    await fixture.broker.act({
      ...base,
      request: { action: 'fill', ref: 'e1', value: '{{secret:login}}' },
      secretResolver: resolver,
    });

    // A read from a process with no resolver configured: the scope is still
    // supplied, and its resolution refuses.
    await fixture.broker.read(base);
    const scope = driver.scopes.at(-1);
    assert.ok(scope !== undefined, 'no scope: the read would have been written unscrubbed');
    await assert.rejects(scope.resolve('login'), refusedWith('act.secret_resolver_configured'));
  });
});

test('a new lease starts clean: another tab is not treated as secret-bearing', async () => {
  await withBroker(async (fixture) => {
    const first = await grantedLease(fixture);
    const { resolver } = countingResolver();
    const driver = recordingSession({ typeSecrets: true });
    await fixture.broker.act({
      key: first.key,
      tabId: first.tabId,
      request: { action: 'fill', ref: 'e1', value: '{{secret:login}}' },
      session: () => driver.session,
      secretResolver: resolver,
    });

    const second = await fixture.broker.claim(claimInput({ sessionId: 'session-b' }));
    assert.ok(second.outcome === 'granted');
    await fixture.broker.evaluate({
      key: second.key,
      tabId: second.tabId,
      expression: '1',
      session: () => driver.session,
      secretResolver: resolver,
    });
    assert.ok(driver.calls.includes('evaluate'), 'a clean tab was refused evaluate');
  });
});
