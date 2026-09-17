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
 * A REAL browser's REAL requests, and what the network log says became of
 * them.
 *
 * ── Why this cannot be proved against the fake ──────────────────────────
 *
 * The fake driver fabricates artefact contents. A fake-based test of this
 * would assert that a string this repository wrote came back, which is true by
 * construction and says nothing about whether the recorder in `real.ts`
 * observes a status at all. The defect being closed here is precisely that the
 * recorder listened for `request` and for nothing else — an omission no fake
 * can exhibit, because a fake has no listeners to omit.
 *
 * So these drive a real browser against a loopback server that answers with
 * the outcomes under test: a 200, a 404, and a connection that is accepted and
 * then destroyed without an answer.
 *
 * ── Where this runs, stated so a green pipeline is not misread ──────────
 *
 * It needs a browser, so it **skips with a stated reason** when there is not
 * one. Continuous integration has no browser, so this is local-only and a
 * green pipeline is not evidence that it executed — the same arrangement, and
 * recorded for the same reason, as the neighbouring browser suites.
 *
 * ── The mutations these kill ────────────────────────────────────────────
 *
 * - Deleting the `response` listener in `real.ts` — every status becomes
 *   `PENDING` and the 404 assertion fails. This is the shipped defect.
 * - Deleting the `requestfailed` listener — a destroyed connection reads as
 *   `PENDING` forever and the failure assertion fails.
 * - Modelling a failure as a synthetic status (`0`, `500`) instead of its own
 *   shape — the `FAILED` assertion fails.
 * - Formatting the outcome at `request` time, which is the shape that caused
 *   the original defect — nothing would ever settle.
 * - Moving the index AFTER the outcome (`404 [7] GET …`) — that displaces the
 *   outcome as the first thing said about the request, and costs the method
 *   its predictable offset. The ordering assertion fails.
 * - Numbering from zero, or renumbering per read — the stable-handle
 *   assertion fails.
 */

const available = browserAvailable();

/** Answered 200. */
const OK = '/answered-fine';
/** Answered 404. */
const MISSING = '/no-such-thing';
/** Accepted, then the socket is destroyed with no response at all. */
const DROPPED = '/connection-goes-away';
/** Held open, answered only when the test releases it. */
const SLOW = '/still-thinking';

interface TestServer {
  readonly origin: string;
  /** Answer the held `SLOW` request, if one is waiting. */
  readonly releaseSlow: () => void;
  readonly close: () => Promise<void>;
}

/**
 * A loopback server with one path per outcome.
 *
 * Bound to port 0 so the operating system picks a free one: a fixed port
 * collides with whatever else is on the machine, which is a flake that looks
 * like a failure of the thing under test.
 */
async function outcomeServer(): Promise<TestServer> {
  let held: http.ServerResponse | undefined;

  const server = http.createServer((request, response) => {
    if (request.url === MISSING) {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Not Found</title><h1>Missing</h1>');
      return;
    }
    if (request.url === DROPPED) {
      // No status line, no headers, no body — the socket simply goes away.
      // That is a request that FAILED as distinct from one that was answered
      // badly, which is the distinction under test.
      response.destroy();
      return;
    }
    if (request.url === SLOW) {
      held = response;
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Fine</title><h1>Fine</h1>');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the test server reported no port');

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    releaseSlow: () => {
      if (held === undefined) return;
      held.writeHead(200, { 'content-type': 'text/plain' });
      held.end('eventually');
      held = undefined;
    },
    close: () =>
      new Promise<void>((resolve) => {
        // A held response would keep the server from closing, so it is
        // released first. `closeAllConnections` handles the keep-alive sockets
        // the browser leaves behind.
        held?.destroy();
        held = undefined;
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** One browser and one tab, torn down whatever the assertions do. */
async function withTab(
  fn: (session: BrowserSession, tab: TabHandle) => Promise<void>,
): Promise<void> {
  const profileRoot = temporaryProfileRoot();
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-network-outcomes-'));
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
    await fn(session, tab);
  } finally {
    await teardownBrowser(session, profileRoot);
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
}

/** Read the network artefact and return the file's contents. */
async function networkLog(session: BrowserSession, tab: TabHandle): Promise<string> {
  const results = await session.read(tab, ['network']);
  const written = results.find((result) => result.artifact === 'network');
  assert.ok(written !== undefined, 'the read returned no network artefact');
  return fs.readFileSync(written.path, 'utf8');
}

/** The log's line for one address, which is where the outcome has to appear. */
function lineFor(log: string, url: string): string {
  const line = log.split('\n').find((candidate) => candidate.includes(url));
  assert.ok(line !== undefined, `the network log has no line for ${url}\n---\n${log}\n---`);
  return line;
}

/**
 * A line with its `[n]` index removed, so the outcome assertions can go on
 * asserting what they were written to assert: that the outcome is the first
 * thing said **about the request**.
 *
 * The index is checked separately and deliberately — folding it into every
 * regular expression here would mean an index that silently vanished still
 * passed several of them.
 */
function afterIndex(line: string): string {
  const match = /^\[\d+\] (?<rest>.*)$/su.exec(line);
  assert.ok(match?.groups !== undefined, `the line carries no [n] index at all: ${line}`);
  return match.groups['rest'] ?? '';
}

/**
 * THE HEADLINE: on a page that 404s, the log says 404.
 *
 * The reported defect was that nothing in the network log did. A recorder with
 * no `response` listener passes no part of this.
 */
test(
  'a network read shows the status a request was answered with, including a 404',
  { skip: !available && skipReason() },
  async () => {
    const server = await outcomeServer();

    try {
      await withTab(async (session, tab) => {
        await session.navigate(tab, `${server.origin}${MISSING}`, 20_000);

        const log = await networkLog(session, tab);
        const line = lineFor(log, MISSING);

        assert.match(
          afterIndex(line),
          /^404\b/,
          `the 404 is not visible as a 404 in its own line: ${line}\n---\n${log}\n---`,
        );
        // The method and the address travel with it — a status alone would not
        // tell a caller which request it belongs to.
        assert.match(line, /\bGET\b/);
        assert.ok(line.includes(`${server.origin}${MISSING}`));
        // Nothing is left unsettled, and the header says so rather than
        // leaving the caller to count.
        assert.match(log, /^\d+ requests?, all settled\.$/m);
      });
    } finally {
      await server.close();
    }
  },
);

/**
 * The control that makes the test above mean something.
 *
 * A recorder that hard-coded `404`, or that reported the last status it saw
 * for every line, passes the 404 assertion and fails here.
 */
test(
  'a successful request is visibly distinct from a failed one in the same log',
  { skip: !available && skipReason() },
  async () => {
    const server = await outcomeServer();

    try {
      await withTab(async (session, tab) => {
        await session.navigate(tab, `${server.origin}${OK}`, 20_000);

        // A subresource that is accepted and then dropped. Fetched from the
        // page so that both outcomes land in one log, which is the comparison
        // a reviewer actually makes.
        await session.evaluate(
          tab,
          `fetch(${JSON.stringify(DROPPED)}).catch(() => 'expected to fail')`,
        );

        // The failure is reported by the browser asynchronously, so the log is
        // re-read until it settles rather than once after a fixed sleep — a
        // sleep long enough to be reliable is a slow test, and one short
        // enough to be fast is a flaky one.
        let log = '';
        for (let attempt = 0; attempt < 40; attempt += 1) {
          log = await networkLog(session, tab);
          if (/^(FAILED|\d+)\s/m.test(afterIndex(lineFor(log, DROPPED)))) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const good = lineFor(log, OK);
        const bad = lineFor(log, DROPPED);

        assert.match(
          afterIndex(good),
          /^200\b/,
          `the successful request does not read as a 200: ${good}`,
        );
        assert.match(
          afterIndex(bad),
          /^FAILED\b/,
          `a request the server dropped does not read as failed: ${bad}\n---\n${log}\n---`,
        );
        // A failure is NOT a status: flattening it into a synthetic code is
        // the mutation this assertion exists to kill.
        assert.doesNotMatch(afterIndex(bad), /^\d/);
        // The browser's own words for why, carried through rather than
        // replaced with a generic phrase.
        assert.ok(
          afterIndex(bad).length > 'FAILED  GET '.length + `${server.origin}${DROPPED}`.length,
          `the failure line carries no reason at all: ${bad}`,
        );
      });
    } finally {
      await server.close();
    }
  },
);

/**
 * A request still in flight is said to be in flight — not dropped, and not
 * reported as though it had completed.
 *
 * A recorder that only ever appended settled requests would show nothing here
 * and pass every other test in this file.
 */
test(
  'a request with no response yet is reported as pending rather than omitted',
  { skip: !available && skipReason() },
  async () => {
    const server = await outcomeServer();

    try {
      await withTab(async (session, tab) => {
        await session.navigate(tab, `${server.origin}${OK}`, 20_000);

        // Started and deliberately not awaited: the server holds it open, so
        // it is genuinely unanswered at the moment of the read.
        await session.evaluate(tab, `void fetch(${JSON.stringify(SLOW)}); 'started'`);

        let log = '';
        for (let attempt = 0; attempt < 40; attempt += 1) {
          log = await networkLog(session, tab);
          if (log.includes(SLOW)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const line = lineFor(log, SLOW);
        assert.match(
          afterIndex(line),
          /^PENDING\b/,
          `an unanswered request does not read as pending: ${line}\n---\n${log}\n---`,
        );
        // And the header warns that the log is a partial picture of the page,
        // which is the thing a caller would otherwise have to notice alone.
        assert.match(log, /still in flight when this was written/);

        // The index this request was given while pending. It is a handle, so
        // the point of it is that it still names this request afterwards.
        const indexWhilePending = /^\[(?<n>\d+)\]/u.exec(line)?.[1];
        assert.ok(indexWhilePending !== undefined, `the pending line carries no index: ${line}`);

        // Now let it finish, and the SAME entry settles — it does not appear a
        // second time. A recorder that appended an outcome line instead of
        // settling the request's own entry fails here.
        server.releaseSlow();

        let settled = '';
        for (let attempt = 0; attempt < 40; attempt += 1) {
          settled = await networkLog(session, tab);
          if (/^\[\d+\] 200\s.*still-thinking/m.test(settled)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const linesForSlow = settled.split('\n').filter((candidate) => candidate.includes(SLOW));
        assert.equal(
          linesForSlow.length,
          1,
          `one request produced ${String(linesForSlow.length)} lines:\n${settled}`,
        );
        assert.match(afterIndex(linesForSlow[0] ?? ''), /^200\b/);
        assert.match(settled, /all settled\./);

        // THE STABLE HANDLE: the request kept its number when its outcome
        // arrived. An index recomputed per read — or one derived from
        // anything but array position, such as a counter over settled
        // requests — renumbers here and fails.
        assert.match(
          linesForSlow[0] ?? '',
          new RegExp(`^\\[${indexWhilePending}\\] `, 'u'),
          `the request changed index when it settled: was [${indexWhilePending}], now ${linesForSlow[0] ?? ''}`,
        );
      });
    } finally {
      await server.close();
    }
  },
);

/**
 * Every line is numbered, the numbers are contiguous from 1, and the number
 * sits BEFORE the outcome.
 *
 * ── Why before, and why that is worth an assertion of its own ───────────
 *
 * `real.ts` argues the outcome goes first because it is the column a caller
 * scans — `FAILED` and `PENDING` occupy that same column deliberately, so
 * that "did this work" is one token per line whatever happened. An index
 * placed after the outcome (`404 [7] GET …`) puts a variable-width number
 * between the status and the request, which costs the method its predictable
 * offset. The index therefore has to sit outside that column entirely, which
 * is what the bracket and the position express.
 */
test(
  'every request is numbered, from 1, with the number before the outcome',
  { skip: !available && skipReason() },
  async () => {
    const server = await outcomeServer();

    try {
      await withTab(async (session, tab) => {
        await session.navigate(tab, `${server.origin}${OK}`, 20_000);
        // A second request, so "contiguous" is a claim about more than one
        // line and an off-by-one in the numbering has somewhere to show.
        await session.evaluate(tab, `fetch(${JSON.stringify(MISSING)}).catch(() => 'ignored')`);

        let log = '';
        for (let attempt = 0; attempt < 40; attempt += 1) {
          log = await networkLog(session, tab);
          if (log.split('\n').length > 2) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const lines = log
          .split('\n')
          .slice(1)
          .filter((line) => line.trim() !== '');
        assert.ok(lines.length >= 2, `expected at least two requests:\n${log}`);

        lines.forEach((line, position) => {
          // One-based and in array order. A zero-based index, or one derived
          // from a filtered subset, fails on the first line.
          assert.match(
            line,
            new RegExp(`^\\[${String(position + 1)}\\] `, 'u'),
            `line ${String(position + 1)} is not numbered ${String(position + 1)}: ${line}\n---\n${log}\n---`,
          );
          // And what follows the index is immediately the outcome — nothing
          // is allowed to slip between the number and the scanned column.
          assert.match(
            afterIndex(line),
            /^(\d{3}|FAILED|PENDING)\b/,
            `the outcome does not immediately follow the index: ${line}`,
          );
        });

        // The header's count and the last index agree, which is what lets a
        // caller see at a glance that it has the whole log rather than a
        // window onto it.
        const counted = /^(?<n>\d+) requests?/u.exec(log)?.groups?.['n'];
        assert.equal(
          counted,
          String(lines.length),
          `the header counts ${String(counted)} requests but ${String(lines.length)} lines follow:\n${log}`,
        );
      });
    } finally {
      await server.close();
    }
  },
);

/**
 * "No request was made" is a third state, and reads as itself.
 *
 * The item asks a caller to be able to tell a succeeded request from a failed
 * one from one that never happened. An empty log that rendered as an empty
 * file would be indistinguishable from an artefact that failed to write.
 */
test(
  'a tab that has requested nothing says so rather than returning nothing',
  { skip: !available && skipReason() },
  async () => {
    await withTab(async (session, tab) => {
      const log = await networkLog(session, tab);
      assert.match(log, /No requests were observed/);
    });
  },
);
