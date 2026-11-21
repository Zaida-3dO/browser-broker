import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { BrowserSession, TabHandle } from '../../src/browser/driver.ts';
import { RealBrowserDriver } from '../../src/browser/real.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { teardownBrowser, temporaryProfileRoot } from '../helpers/browser-fixture.ts';

/**
 * A REAL browser fetching a REAL file over a loopback server, through the
 * download seam.
 *
 * ── Why the fake cannot carry these rows ─────────────────────────────────
 *
 * The fake hands back whatever it was configured to hand back, so every
 * assertion about the *fetch* against it is an assertion about this
 * repository's own fixture: that the body streamed, that the cap stopped it,
 * that the credentials rode along, that `finalUrl` is where the browser
 * actually landed. The seam conformance property pins one arithmetic fact
 * across implementations; the physical behaviour of the fixed expression —
 * the streaming cap, `credentials: 'include'`, a status that arrives as a
 * refusal rather than as bytes — lives only here, against a browser and a
 * server that answer for themselves.
 *
 * ── Loopback only ────────────────────────────────────────────────────────
 *
 * Every address is loopback on a port the operating system picked — spelled
 * `127.0.0.1` on one server and `localhost` on the other, so a redirect row
 * has two genuinely different hosts to cross without leaving the machine.
 * The file is a body of bytes this file generates, with a
 * `Content-Disposition` header a real download endpoint would send — kept on
 * purpose, to pin that the fetch route ignores the header and takes the
 * bytes, which is the route's whole difference from the browser's own
 * download machinery (`DECISIONS.md` §13p).
 *
 * ── Where this runs ──────────────────────────────────────────────────────
 *
 * It drives a real browser and **skips with a stated reason** where there is
 * none, exactly as the neighbouring real-browser suites do; a green pipeline
 * with no browser is not evidence this executed.
 */

const available = browserAvailable();

/** A body of 4096 deterministic bytes, with bytes a sloppy copy would drop. */
const FILE_BYTES = Buffer.alloc(4096, 0);
for (let at = 0; at < FILE_BYTES.length; at += 1) {
  FILE_BYTES[at] = (at * 7 + (at >> 3)) % 256;
}

/** The paths the server answers, and what each one means. */
const PAGE = '/the-page';
const FILE_PATH = '/downloads/spec.pdf';
const BIG_PATH = '/downloads/never-ends.bin';
/** Served only to a request carrying the cookie the page set. */
const GUARDED_PATH = '/downloads/needs-the-cookie.bin';
const MISSING_PATH = '/downloads/gone.bin';
/** 302 to `redirectTarget`, the way a real link hands off to a CDN. */
const REDIRECT_PATH = '/downloads/redirect.bin';
/** Sends a status, then a body that never finishes. The ordinary hang. */
const HANG_PATH = '/downloads/hang.bin';
const SESSION_COOKIE = 'broker-fixture-session=granted';

interface FixtureServer {
  readonly origin: string;
  /** Bytes this server had written for the endless body, when it serves one. */
  readonly bigBytesSent?: () => number;
  /** Whether the endless body's pump has been torn down by the client. */
  readonly bigBodyStopped?: () => boolean;
  readonly close: () => Promise<void>;
}

async function fileServer(
  options: { redirectTarget?: string } = {},
): Promise<Required<FixtureServer>> {
  // What the endless body did. The ceiling row reads these to prove the
  // client **stopped the stream**, not merely stopped counting: a cap
  // enforced while streaming cancels the body, and `close` fires on this
  // side; a cap enforced after buffering leaves the exchange alive and the
  // pump running. The byte count is kept only for the failure message —
  // how much Chromium's own read-ahead and the socket buffers absorb before
  // a cancel propagates is a property of the transport, not of the cap, and
  // measuring it would be measuring TCP.
  let bigBytesSent = 0;
  let bigBodyStopped = false;

  const pumpEndless = (response: http.ServerResponse): void => {
    let stopped = false;
    // The client's cancel of a ReadableStream tears the request down; on
    // `close` the pump must stop, or the server writes a body into a
    // connection nobody is reading — and `close` is also the fact the
    // ceiling row asserts back.
    response.on('close', () => {
      stopped = true;
      bigBodyStopped = true;
    });
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    const pump = (): void => {
      // Write until the socket says it has had enough, then resume on
      // `drain`. A single scheduled write would trickle one chunk and stop —
      // the client would see a stalled body, not an endless one, and the row
      // would measure patience rather than the cap.
      //
      // No content-length either: an unknown-length body is exactly the case
      // a pre-flight check cannot see, and the streaming cap exists for.
      while (!stopped && !response.writableEnded) {
        bigBytesSent += 512;
        if (!response.write(Buffer.alloc(512, 0x5a))) {
          response.once('drain', pump);
          return;
        }
      }
    };
    pump();
  };

  const server = http.createServer((request, response) => {
    if (request.url === PAGE) {
      response.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': `${SESSION_COOKIE}; Path=/`,
      });
      response.end('<!doctype html><title>The Page</title><a href="./spec.pdf">the file</a>');
      return;
    }
    if (request.url === FILE_PATH) {
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="spec.pdf"',
      });
      response.end(FILE_BYTES);
      return;
    }
    if (request.url === BIG_PATH) {
      pumpEndless(response);
      return;
    }
    if (request.url === REDIRECT_PATH) {
      response.writeHead(302, { location: options.redirectTarget ?? '/' });
      response.end();
      return;
    }
    if (request.url === HANG_PATH) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write('some bytes, then silence');
      // Deliberately never ended: the row against it is refused by the clock,
      // and the process running this file must be able to finish.
      return;
    }
    if (request.url === GUARDED_PATH) {
      const carries = (request.headers.cookie ?? '').includes(SESSION_COOKIE);
      response.writeHead(carries ? 200 : 403, { 'content-type': 'application/octet-stream' });
      response.end(carries ? FILE_BYTES.subarray(0, 64) : 'no session');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('gone');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the test server reported no port');

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    bigBytesSent: () => bigBytesSent,
    bigBodyStopped: () => bigBodyStopped,
    close: () =>
      new Promise<void>((resolve) => {
        // The endless pump and the hang route hold their connections open on
        // purpose; `close` alone would wait for them forever.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * A second server whose **origin is spelled `localhost`**: same machine,
 * different host, so a redirect between them is a cross-host redirect that
 * any host-based fence can see. It answers the cross-origin fetch with the
 * origin reflected and credentials allowed — the exact shape a real
 * signed-CDN hop sends, and what `credentials: 'include'` demands (a wildcard
 * `Access-Control-Allow-Origin` is refused by the browser for a credentialed
 * request, which would turn this row green-or-red on the wrong thing).
 */
async function redirectTargetServer(): Promise<FixtureServer> {
  const server = http.createServer((request, response) => {
    if (request.url === FILE_PATH) {
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'access-control-allow-origin': request.headers.origin ?? 'http://localhost',
        'access-control-allow-credentials': 'true',
      });
      response.end(FILE_BYTES);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('gone');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the test server reported no port');

  return {
    origin: `http://localhost:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** One browser and one tab on the page, torn down whatever the assertions do. */
async function withPageOn(
  origin: string,
  fn: (session: BrowserSession, tab: TabHandle) => Promise<void>,
): Promise<void> {
  const profileRoot = temporaryProfileRoot();
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-download-real-'));
  const driver = new RealBrowserDriver({
    executablePath: browserExecutablePath(),
    outputDirectory,
  });
  const session = await driver.coldStart({
    browser: 'private',
    profileDirectory: path.join(profileRoot, 'private'),
    mode: 'headless',
  });

  try {
    const tab = await session.openTab();
    // The fetch runs in the page, so the page has to be where its cookies
    // live — a fetch from `about:blank` is a different origin talking to
    // itself, which is a CORS refusal and not the thing under test.
    await session.navigate(tab, `${origin}${PAGE}`, 20_000);
    await fn(session, tab);
  } finally {
    await teardownBrowser(session, profileRoot);
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
}

/**
 * THE MUTATION THIS CATCHES: the fixed expression losing bytes on the way
 * home — a base64 pass that encodes each chunk alone, a `bytes` field fed
 * from the encoded length, or the reader left half-read. Every one of those
 * survives the fake, whose answer never went through the expression at all.
 */
test(
  'the real driver fetches a file through the page, and the bytes that arrive are the bytes the server sent',
  { skip: !available && skipReason() },
  async () => {
    const server = await fileServer();
    try {
      await withPageOn(server.origin, async (session, tab) => {
        const result = await session.download(tab, {
          url: `${server.origin}${FILE_PATH}`,
          maxBytes: 64 * 1024,
        });

        const decoded = Buffer.from(result.base64, 'base64');
        assert.deepEqual(
          decoded,
          FILE_BYTES,
          'the bytes that crossed the seam are not the bytes the server wrote — a chunked base64 pass corrupts exactly this way',
        );
        assert.equal(result.bytes, FILE_BYTES.length);
        assert.equal(result.mime, 'application/pdf');
        // No redirect happened, so the fetch ended where it was pointed; the
        // field is read from the response, not echoed back.
        assert.equal(result.finalUrl, `${server.origin}${FILE_PATH}`);
      });
    } finally {
      await server.close();
    }
  },
);

/**
 * THE MUTATION THIS CATCHES: a cap checked after the body is in memory, or
 * not at all — the review's point being that a *finite* oversized body cannot
 * tell those apart from a cap enforced while streaming, because buffering a
 * 4 KiB body still ends in the same refusal. So the body here **never ends**.
 * A driver that caps while streaming refuses in milliseconds and **cancels
 * the body**, which the server can see as the request closing; a driver that
 * caps after buffering reads forever, which the race below fails as a hang —
 * and if it refused without cancelling, the server is still streaming when
 * the row asks.
 */
test(
  'the in-page fetch stops at the ceiling instead of buffering past it',
  { skip: !available && skipReason() },
  async () => {
    const server = await fileServer();
    try {
      await withPageOn(server.origin, async (session, tab) => {
        const refusal = session.download(tab, {
          url: `${server.origin}${BIG_PATH}`,
          maxBytes: 1024,
        });
        const hung = new Promise<'hung'>((resolve) => {
          const timer = setTimeout(() => resolve('hung'), 8_000);
          timer.unref();
        });
        const raced = await Promise.race([refusal.catch(() => 'refused' as const), hung]);
        assert.notEqual(
          raced,
          'hung',
          'a cap enforced after buffering reads an endless body forever',
        );
        await assert.rejects(
          refusal,
          /ceiling/,
          'over the cap is a refusal naming the ceiling, not a truncated file',
        );

        // **The physical half: the stream itself was torn down.** The reader
        // that caps while streaming *cancels*, and the server sees the
        // request close; a reader that caps after buffering never cancels,
        // so its exchange stays open. The short grace is only for the cancel
        // to cross the loopback. Deliberately **not** a byte-count check:
        // how much Chromium's read-ahead and the socket buffers absorb
        // before a cancel propagates is a property of the transport — the
        // first version of this row measured that and correctly red on a
        // cap that was working. The counter stays in the failure message
        // because megabytes still streaming is the sound of the defect.
        await new Promise((resolve) => {
          setTimeout(resolve, 300);
        });
        assert.equal(
          server.bigBodyStopped(),
          true,
          `the server is still streaming (it took ${String(server.bigBytesSent())} bytes) — the fetch never cancelled the body`,
        );
      });
    } finally {
      await server.close();
    }
  },
);

/**
 * THE MUTATION THIS CATCHES: a fetch of the page's own session that does not
 * actually carry it — `credentials` omitted, or the page never navigated so
 * the cookie was never set. The server answers 403 without the cookie and
 * 200 with it, so only the real combination returns bytes.
 */
test(
  "the fetch carries the page's own credentials",
  { skip: !available && skipReason() },
  async () => {
    const server = await fileServer();
    try {
      await withPageOn(server.origin, async (session, tab) => {
        const result = await session.download(tab, {
          url: `${server.origin}${GUARDED_PATH}`,
          maxBytes: 64 * 1024,
        });
        assert.deepEqual(Buffer.from(result.base64, 'base64'), FILE_BYTES.subarray(0, 64));
      });
    } finally {
      await server.close();
    }
  },
);

/**
 * THE MUTATION THIS CATCHES: an unsuccessful response being reported as an
 * empty success. A `!response.ok` check that went missing hands back
 * `"gone"` as if it were the file.
 */
test(
  'a missing file comes back as a refusal that names the status, not as bytes',
  { skip: !available && skipReason() },
  async () => {
    const server = await fileServer();
    try {
      await withPageOn(server.origin, async (session, tab) => {
        await assert.rejects(
          session.download(tab, {
            url: `${server.origin}${MISSING_PATH}`,
            maxBytes: 64 * 1024,
          }),
          /404/,
          'the status belongs in the sentence a caller acts on',
        );
      });
    } finally {
      await server.close();
    }
  },
);

/**
 * THE MUTATION THIS CATCHES: `finalUrl` echoed from the request instead of
 * read from the response. Every service-side fence that decides on the
 * **arrived** host (§13p) trusts this field; an echo would make those fences
 * structurally blind while every unit test stayed green, because only a real
 * fetch following a real 302 knows where it landed. Two loopback origins,
 * spelled differently, so the landing host differs from the asked host.
 */
test(
  'the real driver reports where the fetch actually landed, not where it was pointed',
  { skip: !available && skipReason() },
  async () => {
    const target = await redirectTargetServer();
    const server = await fileServer({ redirectTarget: `${target.origin}${FILE_PATH}` });
    try {
      await withPageOn(server.origin, async (session, tab) => {
        const result = await session.download(tab, {
          url: `${server.origin}${REDIRECT_PATH}`,
          maxBytes: 64 * 1024,
        });

        // The report is the browser's arrival, on the other host, at the
        // other server's path — not the address handed in.
        assert.equal(result.finalUrl, `${target.origin}${FILE_PATH}`);
        assert.notEqual(result.finalUrl, `${server.origin}${REDIRECT_PATH}`);
        // And the bytes crossed the redirect intact, cookies arrangement and
        // all: same body as the direct row.
        assert.deepEqual(Buffer.from(result.base64, 'base64'), FILE_BYTES);
      });
    } finally {
      await server.close();
      await target.close();
    }
  },
);

/**
 * THE MUTATION THIS CATCHES: a fetch with no clock on it. A server that
 * answers with a status and then stops mid-body is the ordinary hang — a
 * link to a dying host — and without the bound it holds the lease's
 * after-commit work open indefinitely. `timeoutMs` is passed short here so
 * the row runs in seconds; the default bound is the same mechanism.
 */
test(
  'a body that never finishes is refused by the clock, not waited on forever',
  { skip: !available && skipReason() },
  async () => {
    const server = await fileServer();
    try {
      await withPageOn(server.origin, async (session, tab) => {
        await assert.rejects(
          session.download(tab, {
            url: `${server.origin}${HANG_PATH}`,
            maxBytes: 64 * 1024,
            timeoutMs: 1_500,
          }),
          /timed out/u,
          'the clock is part of the refusal sentence a caller acts on',
        );
      });
    } finally {
      await server.close();
    }
  },
);
