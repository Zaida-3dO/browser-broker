import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  ActionRequest,
  BrowserSession,
  CaptureRequest,
  ReadArtifact,
  StorageSeedEntry,
  TabHandle,
} from '../../src/browser/driver.ts';
import { claimInput, withBroker, type BrokerFixture } from '../helpers/broker.ts';

/**
 * `upload` driven through the shipped service.
 *
 * ── What these assert that a unit test cannot ───────────────────────────
 *
 * Two things, and both are about **when** rather than about what:
 *
 * 1. **That an unconfigured upload root refuses before a tab is touched.** A
 *    guard that returned "denied" after the tab had opened would satisfy an
 *    assertion made on the error alone, which is the failure this repository
 *    is built around. So the refusal tests assert on the driver's call log
 *    being empty as well as on the refusal.
 * 2. **That what reaches the driver is bytes and not a name.** The request the
 *    seam receives is recorded whole, so a change that started handing the
 *    automation library a path would be visible here rather than only in a
 *    type that somebody could widen.
 *
 * The root is supplied through the fixture rather than the process
 * environment, so a test proving the off state does not depend on what happens
 * to be set on the machine running it — in either direction.
 */

/** What the driver was asked, and the whole request it was asked with. */
interface DriverLog {
  readonly calls: string[];
  readonly requests: ActionRequest[];
  readonly session: BrowserSession;
}

function recordingSession(): DriverLog {
  const calls: string[] = [];
  const requests: ActionRequest[] = [];
  const handle: TabHandle = { browser: 'regular', driverTabId: 'driver-tab' };

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
      return await Promise.resolve({ browser: 'regular' as const, driverTabId: 'fresh-tab' });
    },
    listTabs: async () => await Promise.resolve([handle]),
    ensureKeeperTab: async () => await Promise.resolve(handle),
    detach: async () => {
      await Promise.resolve();
    },
    closeTab: async () => await Promise.resolve('closed' as const),
    navigate: async (tab: TabHandle, url: string) =>
      await Promise.resolve({ url, title: 'a title', status: 200 }),
    act: async (tab: TabHandle, request: ActionRequest) => {
      calls.push(`act:${request.action}`);
      // The whole request, so an assertion can ask what the seam actually
      // received rather than trusting the type that describes it.
      requests.push(request);
      return await Promise.resolve({
        artifact: 'snapshot' as const,
        path: 'a/path',
        bytes: 1,
        truncated: false,
      });
    },
    read: async (tab: TabHandle, artifacts: readonly ReadArtifact[]) =>
      await Promise.resolve(
        artifacts.map((artifact) => ({ artifact, path: 'a/path', bytes: 1, truncated: false })),
      ),
    cookies: async () => await Promise.resolve([]),
    seedStorage: async (tab: TabHandle, entries: readonly StorageSeedEntry[]) => {
      await Promise.resolve(entries.length);
    },
    evaluate: async () => await Promise.resolve({ value: null, bytes: 4 }),
    settlePage: async () => {
      await Promise.resolve();
    },
    capture: async (tab: TabHandle, request: CaptureRequest) =>
      await Promise.resolve({
        image: Buffer.alloc(0),
        width: 1,
        height: 1,
        viewportWidth: 1,
        url: 'https://example.com/',
        fullPage: request.fullPage,
      }),
  } as unknown as BrowserSession;

  return { calls, requests, session };
}

async function grantedLease(fixture: BrokerFixture): Promise<{ key: string; tabId: string }> {
  const granted = await fixture.broker.claim(claimInput());
  assert.equal(granted.outcome, 'granted');
  if (granted.outcome !== 'granted') throw new Error('unreachable');
  return { key: granted.key, tabId: granted.tabId };
}

/** A directory of uploadable files, outside everything the service owns. */
function withUploadRoot(run: (root: string) => Promise<void>): Promise<void> {
  // Resolved, because the containment guard compares resolved paths and the
  // temporary directory is reached through a link on some platforms.
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'up-'));
  return run(root).finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
}

/* ───────────── the verb is off until an operator switches it on ───────────── */

test('with no upload root configured, upload refuses and the driver is never asked', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();

    await assert.rejects(
      fixture.broker.act({
        key: lease.key,
        tabId: lease.tabId,
        request: { action: 'upload', ref: 'e1', paths: ['anything.txt'] },
        session: () => driver.session,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // The refusal names the variable and what to do with it. An operator
        // reading this is the only person who can fix it, and this sentence
        // is the one moment they will read about the capability at all.
        assert.match(error.message, /BROKER_UPLOAD_ROOT/u);
        return true;
      },
    );

    // **The physical side-effect, not just the response.** No tab was opened
    // and nothing was asked of the driver — the refusal happens before
    // `admit`, so no lease was renewed either.
    assert.deepEqual(driver.calls, []);
  });
});

test('another verb still works with no upload root, so the refusal is upload’s alone', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession();
    // The mutation this catches: a guard that refuses on the absent root for
    // every action rather than for the one that needs it.
    const result = await fixture.broker.act({
      key: lease.key,
      tabId: lease.tabId,
      request: { action: 'click', ref: 'e1' },
      session: () => driver.session,
    });
    assert.equal(result.action, 'click');
    assert.deepEqual(driver.calls, ['openTab', 'act:click']);
  });
});

/* ───────────── with a root: bytes reach the driver, names do not ───────────── */

test('a configured root lets an upload through, and the driver receives bytes', async () => {
  await withUploadRoot(async (root) => {
    fs.writeFileSync(path.join(root, 'invoice.pdf'), 'pdf bytes here');
    await withBroker(
      async (fixture) => {
        const lease = await grantedLease(fixture);
        const driver = recordingSession();

        const result = await fixture.broker.act({
          key: lease.key,
          tabId: lease.tabId,
          request: { action: 'upload', ref: 'e1', paths: ['invoice.pdf'] },
          session: () => driver.session,
        });

        assert.equal(result.action, 'upload');
        assert.deepEqual(driver.calls, ['openTab', 'act:upload']);

        const request = driver.requests[0];
        assert.ok(request !== undefined && request.action === 'upload');
        // **The seam received bytes.** There is no path on the request at all,
        // which is the property that keeps the automation library from being a
        // second path resolver behind this service's containment guard.
        assert.equal(request.files.length, 1);
        assert.equal(request.files[0]?.name, 'invoice.pdf');
        assert.equal(request.files[0]?.mimeType, 'application/pdf');
        assert.equal(Buffer.from(request.files[0]?.bytes ?? []).toString(), 'pdf bytes here');
        assert.equal('paths' in request, false);
      },
      { uploadRoot: root },
    );
  });
});

test('an escape is refused with a root configured, and no tab is touched', async () => {
  await withUploadRoot(async (root) => {
    await withBroker(
      async (fixture) => {
        const lease = await grantedLease(fixture);
        const driver = recordingSession();

        await assert.rejects(
          fixture.broker.act({
            key: lease.key,
            tabId: lease.tabId,
            request: { action: 'upload', ref: 'e1', paths: ['../../secret.txt'] },
            session: () => driver.session,
          }),
          (error: unknown) => error instanceof Error,
        );

        // The read happens before `admit`, so a containment refusal behaves
        // like every other conventional refusal: nothing opened, nothing
        // renewed, nothing appended.
        assert.deepEqual(driver.calls, []);
      },
      { uploadRoot: root },
    );
  });
});

test('a missing file is refused before a tab is touched, and not as a raw errno', async () => {
  await withUploadRoot(async (root) => {
    await withBroker(
      async (fixture) => {
        const lease = await grantedLease(fixture);
        const driver = recordingSession();

        await assert.rejects(
          fixture.broker.act({
            key: lease.key,
            tabId: lease.tabId,
            request: { action: 'upload', ref: 'e1', paths: ['not-here.pdf'] },
            session: () => driver.session,
          }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            // The defect the argument-refusal check exists to prevent: a
            // caller handed a mechanism it cannot act on.
            assert.doesNotMatch(error.message, /ENOENT/u);
            return true;
          },
        );
        assert.deepEqual(driver.calls, []);
      },
      { uploadRoot: root },
    );
  });
});

/* ───────────────────────── what the ledger records ───────────────────────── */

test('the ledger records an upload with its file count, bytes and names — never a path', async () => {
  await withUploadRoot(async (root) => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'aaaa');
    fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'nested', 'b.txt'), 'bb');
    await withBroker(
      async (fixture) => {
        const lease = await grantedLease(fixture);
        const driver = recordingSession();

        await fixture.broker.act({
          key: lease.key,
          tabId: lease.tabId,
          request: { action: 'upload', ref: 'e1', paths: ['a.txt', 'nested/b.txt'] },
          session: () => driver.session,
        });

        // Read through the second connection, so this asserts what committed.
        const rows = fixture.readCommitted<{ detail: string }>(
          "SELECT detail FROM events WHERE kind = 'act' ORDER BY id DESC LIMIT 1",
        );
        const detail = JSON.parse(rows[0]?.detail ?? '{}') as Record<string, unknown>;

        assert.equal(detail.action, 'upload');
        assert.equal(detail.files, 2);
        assert.equal(detail.bytes, 6);
        // **Names, and the basename at that.** The relative name is what
        // identifies the file to whoever reads the ledger; the absolute path
        // is specific to one machine, which is rule one of the artifact store.
        assert.deepEqual(detail.names, ['a.txt', 'b.txt']);
        const serialised = JSON.stringify(detail);
        assert.doesNotMatch(serialised, new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')));
        assert.doesNotMatch(serialised, /nested/u);
      },
      { uploadRoot: root },
    );
  });
});
