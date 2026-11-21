import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type {
  BrowserSession,
  CaptureRequest,
  DownloadRequest,
  ReadArtifact,
  TabHandle,
} from '../../src/browser/driver.ts';
import { BrokerError } from '../../src/errors.ts';
import { blankImage, encodePng } from '../../src/diff/image.ts';
import { claimInput, withBroker, type BrokerFixture } from '../helpers/broker.ts';
import type { TempStoreOptions } from '../helpers/temp-store.ts';

/**
 * `download` driven through the shipped service (§3.18).
 *
 * ── What these rows exist to prove, beyond the happy path ──────────────
 *
 * Every refusal row here asserts the **physical** half beside the response,
 * which is this repository's rule and the whole reason the rows are separated
 * from the gate's own table tests:
 *
 * - a scheme refusal writes **no ledger row at all** and never reaches for a
 *   session — the refusal precedes `admit`;
 * - the fence refusals on an attached lease write their own `deny` row and
 *   **no `allow` row**, and the session was never asked — the tab stays
 *   `opening`;
 * - the over-ceiling refusal **saves no file**: `downloads/` is not merely
 *   empty on these paths, it does not exist, and the bytes the page did fetch
 *   went nowhere.
 *
 * And the accepted row asserts what the reply must **not** carry: the bytes,
 * the query string, and any name the caller or the server spelled.
 */

/** The body a stub fetch hands back — 37 ordinary bytes of text. */
const FAKE_BODY = 'a file the fake was never asked to fetch';
const FAKE_BASE64 = Buffer.from(FAKE_BODY, 'utf8').toString('base64');

/** What the download seam was asked, and everything else it was asked. */
interface DriverLog {
  readonly calls: string[];
  readonly requests: DownloadRequest[];
  readonly session: BrowserSession;
}

/**
 * A session that records being asked to download and answers with the canned
 * body — deliberately **ignoring `maxBytes`**, exactly as the fake driver
 * does, because the ceiling check these rows test is the service's, and a
 * stub that enforced it itself would leave that check untested.
 *
 * Two ways to be a more interesting browser than an echo, each used by rows
 * that would otherwise pass over a broken fence:
 *
 * - `finalHost`: the body **arrives from a different host** than the one
 *   asked — what a redirect does. Answering with `request.url` would pin a
 *   redirect-blind service into looking compliant.
 * - `arrivalOverride`: the navigation **reports an arrival other than the
 *   address it was given**, the way a real browser lands on an error page.
 *   `tabs.last_url` is written from this report, so a relative address later
 *   resolves against it.
 */
function recordingSession(
  browser: string,
  options: { finalHost?: string; arrivalOverride?: string } = {},
): DriverLog {
  const calls: string[] = [];
  const requests: DownloadRequest[] = [];
  const handle: TabHandle = { browser, driverTabId: 'driver-tab' };
  const session = {
    describe: () => ({
      browser,
      mode: 'headless' as const,
      pid: 1,
      discovery: { endpoint: 'endpoint' },
    }),
    isConnected: () => true,
    openTab: () => {
      calls.push('openTab');
      return Promise.resolve({ browser, driverTabId: 'driver-tab' } as TabHandle);
    },
    listTabs: () => Promise.resolve([handle]),
    ensureKeeperTab: () => Promise.resolve(handle),
    detach: () => Promise.resolve(),
    closeTab: () => Promise.resolve('closed' as const),
    navigate: (_tab: TabHandle, url: string) => {
      calls.push(`navigate:${url}`);
      return Promise.resolve({
        url: options.arrivalOverride ?? url,
        title: 'a title',
        status: 200,
      });
    },
    act: () =>
      Promise.resolve({
        artifact: 'snapshot' as const,
        path: 'a/path',
        bytes: 1,
        truncated: false,
      }),
    read: (_tab: TabHandle, artifacts: readonly ReadArtifact[]) =>
      Promise.resolve(
        artifacts.map((artifact) => ({
          artifact,
          path: 'a/path',
          bytes: 1,
          truncated: false,
        })),
      ),
    cookies: () => Promise.resolve([]),
    seedStorage: () => Promise.resolve(),
    evaluate: () => Promise.resolve({ value: null, bytes: 4 }),
    settlePage: () => Promise.resolve(),
    capture: (_tab: TabHandle, request: CaptureRequest) =>
      Promise.resolve({
        image: encodePng(blankImage(8, 6)),
        width: 8,
        height: 6,
        viewportWidth: 8,
        url: 'https://example.com/',
        fullPage: request.fullPage,
      }),
    download: (_tab: TabHandle, request: DownloadRequest) => {
      calls.push(`download:${request.url}`);
      requests.push(request);
      return Promise.resolve({
        base64: FAKE_BASE64,
        // **No media type**: the canned body is text the server never
        // described, which is the case the byte-sniffing branch of the
        // extension rule exists for.
        finalUrl:
          options.finalHost === undefined ? request.url : `https://${options.finalHost}/landed.bin`,
        bytes: Buffer.from(FAKE_BASE64, 'base64').length,
      });
    },
  } satisfies BrowserSession;
  return { calls, requests, session };
}

/** A `SessionSource` that counts every time the service reached for one. */
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

interface Lease {
  readonly key: string;
  readonly tabId: string;
  readonly claimId: string;
}

async function grantedLease(fixture: BrokerFixture, browser?: string): Promise<Lease> {
  const granted = await fixture.broker.claim(claimInput(browser === undefined ? {} : { browser }));
  assert.equal(granted.outcome, 'granted');
  if (granted.outcome !== 'granted') throw new Error('unreachable');
  return { key: granted.key, tabId: granted.tabId, claimId: granted.claimId };
}

function eventCount(fixture: BrokerFixture, kind: string, outcome: string): number {
  return (
    fixture
      .readCommitted<{ n: number }>(
        'SELECT count(*) AS n FROM events WHERE kind = @kind AND outcome = @outcome',
        { kind, outcome },
      )
      .at(-1)?.n ?? -1
  );
}

function denyGuards(fixture: BrokerFixture, kind: string): string[] {
  return fixture
    .readCommitted<{ guard: string }>(
      'SELECT guard FROM events WHERE kind = @kind AND outcome = @outcome ORDER BY id',
      { kind, outcome: 'deny' },
    )
    .map((row) => row.guard);
}

/**
 * The physical side-effect every refusal row asserts: not an empty
 * `downloads/` folder — **no folder at all**. `ArtifactStore` creates the
 * directory lazily, in the same breath as the write, so its absence is proof
 * nothing was written; an assertion on empty contents could pass over a
 * refusal that wrote first and deleted after.
 */
function assertNoDownloads(fixture: BrokerFixture, claimId: string): void {
  assert.equal(
    fs.existsSync(path.join(fixture.artifacts.root, 'claims', claimId, 'downloads')),
    false,
    'a download refusal left a downloads directory behind',
  );
}

/* ───────────────── the scheme fence, before anything ───────────────── */

const BAD_ADDRESSES: readonly { readonly name: string; readonly url: unknown }[] = [
  { name: 'nothing at all', url: '' },
  { name: 'a local-file address', url: 'file:///etc/passwd' },
  { name: 'an inline-data address', url: 'data:text/plain;base64,QUJD' },
  { name: 'a script address', url: 'javascript:alert(1)' },
  { name: 'not a string', url: 42 },
];

for (const row of BAD_ADDRESSES) {
  test(`a download to ${row.name} is refused before anything is admitted, fetched or written`, async () => {
    await withBroker(async (fixture) => {
      const lease = await grantedLease(fixture);
      const driver = recordingSession('regular');
      const reached = countingSource(driver);

      await assert.rejects(
        fixture.broker.download({
          key: lease.key,
          tabId: lease.tabId,
          url: row.url,
          session: reached.source,
        }),
        refusedWithRule('download.scheme_allowed'),
      );

      // No session sought, no call logged, no row written either way, and no
      // downloads directory — the refusal precedes `admit`, so the lease was
      // not even renewed.
      assert.equal(reached.asked(), 0, 'the service reached for a session to refuse without it');
      assert.deepEqual(driver.calls, []);
      assert.equal(eventCount(fixture, 'download', 'allow'), 0);
      assert.equal(eventCount(fixture, 'download', 'deny'), 0);
      assertNoDownloads(fixture, lease.claimId);
    });
  });
}

test('a relative address on a tab with no page refuses, and the refusal is recorded', async () => {
  // `download.address_resolvable` — the one refusal that arrives *after*
  // admission, because only the store knows whether this tab has a page to
  // resolve against. It owes a ledger row: §1.6's question, *was the rule
  // ever reached*, is exactly interesting on this path.
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession('regular');
    const reached = countingSource(driver);

    // A **signed** relative address: the refusal names the file so the
    // caller knows which call failed, and writes neither it nor its token.
    // The error text travels into the caller's logs and the detail into the
    // ledger — a query string that reaches either is a credential written
    // down twice.
    await assert.rejects(
      fixture.broker.download({
        key: lease.key,
        tabId: lease.tabId,
        url: 'files/spec.pdf?token=secret123',
        session: reached.source,
      }),
      (error: unknown) => {
        assert.ok(error instanceof BrokerError && error.rule === 'download.address_resolvable');
        assert.match(error.message, /files\/spec\.pdf/u);
        assert.doesNotMatch(error.message, /token|secret123/u);
        return true;
      },
    );

    assert.equal(reached.asked(), 0);
    assert.deepEqual(driver.calls, []);
    assert.deepEqual(denyGuards(fixture, 'download'), ['download.address_resolvable']);
    const denyDetail = fixture.readCommitted<{ detail: string }>(
      "SELECT detail FROM events WHERE kind = 'download' AND outcome = 'deny' ORDER BY id DESC LIMIT 1",
    )[0]?.detail;
    assert.doesNotMatch(denyDetail ?? '', /token|secret123/u);
    assert.match(denyDetail ?? '', /files\/spec\.pdf/u);
    assert.equal(eventCount(fixture, 'download', 'allow'), 0);
    assertNoDownloads(fixture, lease.claimId);
  });
});

/* ───────────────────── the accepted path ───────────────────── */

test('a linked file is fetched relative to the page, saved under the lease, and reported without bytes', async () => {
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession('regular');

    await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: 'https://example.com/reports',
      session: () => driver.session,
    });

    const result = await fixture.broker.download({
      key: lease.key,
      tabId: lease.tabId,
      // A signed-looking address: whatever else happens, its query must not
      // reach the name, the reply, or the ledger.
      url: 'files/spec.pdf?token=secret123',
      label: 'Spec!men',
      // The store travels per call, as `capture` and the evaluation spill
      // receive it — the fixture deliberately does not bind it globally, so
      // the no-store path stays reachable from a test.
      artifacts: fixture.artifacts,
      session: () => driver.session,
    });

    assert.equal(result.pageDriven, true, 'the fetch never ran');
    const file = result.download;
    assert.ok(file, 'an accepted driven download carried no file record');

    // **What the seam was asked.** The relative address arrived resolved
    // against the page the last navigation *arrived at*, query intact — the
    // fence is on schemes and hosts, not on the file's own parameters.
    assert.deepEqual(
      driver.requests.map((request) => request.url),
      ['https://example.com/files/spec.pdf?token=secret123'],
    );
    assert.equal(
      driver.requests[0]?.maxBytes,
      8388608,
      'the declared default ceiling did not travel',
    );

    // **The name.** label first (reduced), then the page slug, then the
    // stamp, then the hash tail — and the extension chosen by sniffing a body
    // no media type described: `bin`, an admission rather than a guess.
    assert.match(file.name, /^spec-men-example-com-reports-\d{14}-[0-9a-f]{12}\.bin$/u);
    // The query appears nowhere in the name, though it was in the address.
    assert.doesNotMatch(file.name, /token|secret/u);

    // **The path is relative, forward-slashed, and reads back the same bytes.**
    assert.match(file.path, /^claims\/[a-z0-9-]+\/downloads\/spec-men-/u);
    const onDisk = fs.readFileSync(fixture.artifacts.resolve(file.path));
    assert.equal(onDisk.toString('utf8'), FAKE_BODY);

    // **The digest is of the bytes**, not of the encoding they travelled in.
    assert.equal(file.sha256, createHash('sha256').update(onDisk).digest('hex'));
    assert.equal(file.bytes, onDisk.byteLength);
    assert.equal('mime' in file, false, 'a media type was claimed for an undescribed body');
    assert.equal(file.sourceHost, 'example.com');

    // The ledger row: host and ceiling, never the address with its query.
    const detail = JSON.parse(
      fixture.readCommitted<{ detail: string }>(
        "SELECT detail FROM events WHERE kind = 'download' AND outcome = 'allow' ORDER BY id DESC LIMIT 1",
      )[0]?.detail ?? '{}',
    ) as Record<string, unknown>;
    assert.deepEqual(detail, { host: 'example.com', maxBytes: 8388608 });
    assert.equal(eventCount(fixture, 'download', 'deny'), 0);
  });
});

/* ──────────────────── the ceiling, asked twice ──────────────────── */

test('a body past the ceiling arrives, is measured, and is never saved', async () => {
  // The service's second reading of the ceiling: the page (here, a stub that
  // deliberately ignores `maxBytes`) says it fetched 37 bytes against an
  // 8-byte ceiling. The decision row stays — the call really was allowed —
  // but nothing reaches disk and nothing reaches the caller.
  await withBroker(
    async (fixture) => {
      const lease = await grantedLease(fixture);
      const driver = recordingSession('regular');

      const result = await fixture.broker.download({
        key: lease.key,
        tabId: lease.tabId,
        url: 'https://example.com/f.bin',
        artifacts: fixture.artifacts,
        session: () => driver.session,
      });

      assert.equal(result.pageDriven, false);
      assert.match(result.notDrivenReason ?? '', /download\.size_bounded/u);
      assert.equal(result.download, undefined, 'an over-ceiling body was handed to the caller');
      assert.deepEqual(driver.calls, ['openTab', 'download:https://example.com/f.bin']);
      assert.deepEqual(denyGuards(fixture, 'download'), []);
      assert.equal(eventCount(fixture, 'download', 'allow'), 1, 'the decision row itself vanished');
      assertNoDownloads(fixture, lease.claimId);
    },
    { downloadMaxBytes: 8 },
  );
});

/* ──────────────── the attached fence, at the door ──────────────── */

const ATTACHED_BASE = {
  attachedBrowsers: ['desktop'],
  attachedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
};

async function attachedLease(fixture: BrokerFixture): Promise<Lease> {
  const granted = await fixture.broker.claim({
    sessionId: 'session-a',
    browser: 'desktop',
    purpose: 'a lease on the configured attached browser',
  });
  assert.equal(granted.outcome, 'granted', 'the fixture needs an attached lease');
  if (granted.outcome !== 'granted') throw new Error('unreachable');
  return { key: granted.key, tabId: granted.tabId, claimId: granted.claimId };
}

const FENCE_ROWS: readonly {
  readonly name: string;
  readonly options: TempStoreOptions;
  readonly pageUrl: string | null;
  readonly fileUrl: string;
  readonly rule: string;
}[] = [
  {
    name: 'no act list at all',
    options: ATTACHED_BASE,
    pageUrl: null,
    fileUrl: 'https://example.com/files/spec.pdf',
    rule: 'attached.read_only',
  },
  {
    // The page and the file deliberately sit on **different hosts** — the
    // page off-list, the file on it. If both hosts were the same host, an
    // implementation that fed one host into both halves of the fence would
    // refuse for the wrong reason and pass this row anyway.
    name: 'a page the list does not name, fetching a file on a host it does',
    options: { ...ATTACHED_BASE, attachedActSites: ['example.com'] },
    pageUrl: 'https://example.org/reports',
    fileUrl: 'https://example.com/files/spec.pdf',
    rule: 'attached.act_site_off_list',
  },
  {
    name: 'a file host the list does not name, from a listed page',
    options: { ...ATTACHED_BASE, attachedActSites: ['example.com'] },
    pageUrl: 'https://example.com/reports',
    fileUrl: 'https://example.org/spec.pdf',
    rule: 'attached.act_site_off_list',
  },
];

for (const row of FENCE_ROWS) {
  test(`an attached download is refused for ${row.name}: at the door, before the browser`, async () => {
    await withBroker(async (fixture) => {
      const lease = await attachedLease(fixture);
      const driver = recordingSession('desktop');
      const reached = countingSource(driver);

      if (row.pageUrl !== null) {
        await fixture.broker.navigate({
          key: lease.key,
          tabId: lease.tabId,
          url: row.pageUrl,
          session: () => driver.session,
        });
      }

      await assert.rejects(
        fixture.broker.download({
          key: lease.key,
          tabId: lease.tabId,
          url: row.fileUrl,
          session: reached.source,
        }),
        (error: unknown) => {
          assert.ok(error instanceof BrokerError && error.rule === row.rule);
          // The gate's own sentences, reused not renamed: an operator is
          // told which variable to set, whichever verb reached them.
          assert.match(error.message, /BROKER_ATTACHED_ACT_SITES/u);
          return true;
        },
      );

      // The door decided before any session was sought or work scheduled.
      assert.equal(reached.asked(), 0, 'the service reached for a session it decided not to use');
      assert.ok(
        !driver.calls.some((call) => call.startsWith('download')),
        'the fence fired after the browser was asked to fetch',
      );
      assert.equal(eventCount(fixture, 'download', 'allow'), 0, 'the fence wrote an allow anyway');
      assert.deepEqual(denyGuards(fixture, 'download'), [row.rule]);
      assertNoDownloads(fixture, lease.claimId);
    }, row.options);
  });
}

test('an attached download on a listed page for a listed file host is fetched and kept', async () => {
  await withBroker(
    async (fixture) => {
      const lease = await attachedLease(fixture);
      const driver = recordingSession('desktop');

      await fixture.broker.navigate({
        key: lease.key,
        tabId: lease.tabId,
        url: 'https://example.com/reports',
        session: () => driver.session,
      });

      const result = await fixture.broker.download({
        key: lease.key,
        tabId: lease.tabId,
        url: 'https://example.org/spec.pdf',
        artifacts: fixture.artifacts,
        session: () => driver.session,
      });

      assert.equal(result.pageDriven, true, 'the allowed fetch never reached the session');
      assert.ok(result.download);
      assert.equal(result.download.sourceHost, 'example.org');
      assert.equal(eventCount(fixture, 'download', 'allow'), 1);
      assert.deepEqual(denyGuards(fixture, 'download'), []);
      // The name's page slug is the *page*, not the file's host — the file is
      // named for where it was linked from, which is what tells two downloads
      // of the same attachment from two pages apart.
      assert.match(result.download.name, /^unnamed-example-com-reports-/u);
    },
    { ...ATTACHED_BASE, attachedActSites: ['example.com', 'example.org'] },
  );
});

test('an attached download whose fetch lands off the list is refused after the fetch, saving nothing', async () => {
  // The door can only fence the address it was **given**; fetch follows
  // redirects, and a listed host's 302 hands back bytes from somewhere the
  // list does not name — with his cookies on the request. So the gate is
  // asked a third time of the arrival, and the half of this row that matters
  // is the half a response assertion cannot see: the fetch really ran
  // (`pageDriven` records the arrival), and **no byte was written**.
  await withBroker(
    async (fixture) => {
      const lease = await attachedLease(fixture);
      const driver = recordingSession('desktop', { finalHost: 'example.org' });

      await fixture.broker.navigate({
        key: lease.key,
        tabId: lease.tabId,
        url: 'https://example.com/reports',
        session: () => driver.session,
      });

      // The requested address passes every door-fence there is: listed page,
      // listed file host. Only the arrival is off-list.
      const result = await fixture.broker.download({
        key: lease.key,
        tabId: lease.tabId,
        url: 'https://example.com/files/spec.pdf',
        artifacts: fixture.artifacts,
        session: () => driver.session,
      });

      // Refused, under the gate's own name, at the completion — the same
      // shape the ceiling refusal takes: the decision row stays, the
      // completion says what refused it, and no file record travels.
      assert.equal(result.pageDriven, false);
      assert.match(result.notDrivenReason ?? '', /attached\.act_site_off_list/u);
      assert.equal(result.download, undefined, 'off-list bytes were handed to the caller');

      assert.deepEqual(
        driver.calls.filter((call) => call.startsWith('download')),
        ['download:https://example.com/files/spec.pdf'],
        'the arrival fence fired before the fetch instead of after it',
      );
      assert.equal(eventCount(fixture, 'download', 'allow'), 1, 'the door row itself vanished');
      assert.deepEqual(denyGuards(fixture, 'download'), ['attached.act_site_off_list']);
      assertNoDownloads(fixture, lease.claimId);
    },
    // The list names the page and the **requested** file host — and nothing
    // else. `example.org`, where the body arrived, is deliberately absent.
    { ...ATTACHED_BASE, attachedActSites: ['example.com'] },
  );
});

test('a relative address resolving against a non-web arrival is refused before the fetch', async () => {
  // The argument scheme fence catches; this catches the **resolved**
  // address. A tab parked on a browser-internal error page has an arrival
  // the store will happily resolve against — and `new URL('files/x',
  // 'chrome-error://…')` produces an address no web fetch should be asked
  // to make. The scheme of what resolution *produced* has to be fenced too.
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const driver = recordingSession('regular', {
      arrivalOverride: 'chrome-error://chromewebdata/',
    });

    await fixture.broker.navigate({
      key: lease.key,
      tabId: lease.tabId,
      url: 'http://127.0.0.1:9/never-arrives',
      session: () => driver.session,
    });

    await assert.rejects(
      fixture.broker.download({
        key: lease.key,
        tabId: lease.tabId,
        url: 'files/spec.pdf',
        artifacts: fixture.artifacts,
        session: () => driver.session,
      }),
      refusedWithRule('download.scheme_allowed'),
    );

    assert.ok(
      !driver.calls.some((call) => call.startsWith('download')),
      'a resolved non-web address reached the fetch',
    );
    assert.deepEqual(denyGuards(fixture, 'download'), ['download.scheme_allowed']);
    assert.equal(eventCount(fixture, 'download', 'allow'), 0);
    assertNoDownloads(fixture, lease.claimId);
  });
});
