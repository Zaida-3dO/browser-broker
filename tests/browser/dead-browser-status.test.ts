import assert from 'node:assert/strict';
import test from 'node:test';

import { profileDirectory } from '../../src/browser/discovery.ts';
import { RealBrowserDriver } from '../../src/browser/real.ts';
import { browserSessionProvider } from '../../src/service/browser-session.ts';
import { createBroker } from '../../src/service/broker.ts';
import { prepareStore } from '../../src/store/open.ts';
import { browserAvailable, skipReason } from '../helpers/browser.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * ⚠️ THIS SUITE DRIVES A **REAL** BROWSER AND THEN KILLS IT. ⚠️
 *
 * ── Why a fake driver cannot catch this, stated first because it is the
 *    single most important thing about the file ──────────────────────────
 *
 * **The defect is that the store's belief and the operating system
 * disagree.** A fake driver has no operating system to disagree with: it
 * reports whatever it was told to report, so a fake-driver test of "is the
 * browser alive" asserts only that the fake answered the way the test set it
 * up to. It would pass against the broken code and against the fixed code
 * alike, which makes it a check that cannot observe what it checks for.
 *
 * This repository has shipped three of those. The row this suite belongs to
 * says in as many words: **do not add a fourth.**
 *
 * So the browser here is genuine, it is started by the same launch path the
 * product uses, and it is ended with a real signal — which is exactly the
 * measured condition, reproduced 2026-09-04: *both browsers dead, the store
 * still granting leases against them, status reporting every one `active`
 * with the expiry advancing.*
 *
 * ── What was measured, and what the mechanism turned out to be ──────────
 *
 * Two things together produced the incident, and only the first is fixed
 * here:
 *
 * 1. **`status` never asked.** It is built from rows plus the expiry
 *    derivation, and that derivation is about *time* and nothing else. There
 *    was no code path from `status` to a liveness check at all — the real
 *    check, `browserIsRunning`, was reachable only from browser acquisition.
 * 2. **The session provider memoises.** Once a session settles it is handed
 *    back for the life of the process without revalidation, so a browser that
 *    died under it keeps being presented as a working connection. That is why
 *    a fresh command-line process appeared to recover: new process, empty
 *    cache, the launch race runs again and starts a browser.
 *
 * The probe asserted here therefore goes to the operating system rather than
 * to the cache — see `BrowserSessions.liveness`, which is deliberately not
 * built on the memoised session.
 *
 * **A browser dying with its client was ruled out as the cause**, and it is
 * worth recording so nobody re-derives it: `launch.ts` spawns detached with
 * released streams and an explicit `unref`, and carries a measured result
 * that a detached browser survives its spawning process being killed
 * uncleanly by about 90 minutes. Not dying with the client is the one
 * property that module exists to provide. Whatever ended those browsers, the
 * broker has to cope with a browser dying for *any* reason, which is why the
 * fix is detection rather than a change to process ownership.
 *
 * ── Where it runs ──────────────────────────────────────────────────────
 *
 * It needs a real browser, so it **skips when there is none and says so**
 * rather than passing quietly. Continuous integration runs on hosted runners
 * with no browser installed, so this is a test that runs locally and is
 * skipped there — recorded here so that a green pipeline is never read as
 * evidence that it executed.
 *
 * ── Hygiene ────────────────────────────────────────────────────────────
 *
 * Killing the browser is the *subject* of the test rather than its cleanup,
 * so the process is ended inside the test body and the teardown is written to
 * cope with it already being gone. A leaked browser here would be
 * particularly bad: this file exists because of an incident that reached
 * 1,637 processes and froze a machine.
 */

const available = browserAvailable();

test(
  'a lease whose browser was killed is NOT reported active, and reclaiming recovers',
  { skip: available ? false : skipReason() },
  async () => {
    const temp = makeTempStore();
    const store = await prepareStore(temp.environment);
    const browsers = browserSessionProvider({
      store,
      environment: temp.environment,
      // ── Why the readiness bound is raised rather than left at the default ──
      //
      // This test starts **two** browsers in sequence — one to kill, one to
      // prove the way back — and the whole file runs alongside every other
      // suite that drives a browser. Startup on a machine already busy
      // starting browsers is slow enough to reach the default bound, and a
      // launch that times out fails this test for a reason that has nothing
      // to do with what it asserts.
      //
      // **The bound is the only thing relaxed, and it cannot mask the
      // defect.** Waiting longer for a browser that is starting changes
      // nothing about a browser that is *gone*: the killed one is asserted
      // absent through the same verified-record check the product uses, which
      // fails immediately rather than after a wait. A generous bound here buys
      // tolerance of a slow machine and buys nothing else.
      driver: new RealBrowserDriver({
        engine: temp.environment.regularBrowserEngine,
        launch: { readinessTimeoutMs: 60_000 },
      }),
    });
    const broker = createBroker({
      store,
      environment: temp.environment,
      adapter: 'cli',
      session: browsers.session,
      checkBrowser: browsers.liveness,
    });

    let pid: number | undefined;
    try {
      const granted = await broker.claim({
        sessionId: 'dead-browser-suite',
        browser: 'regular',
        purpose: 'proving status tells the truth when the browser dies',
      });
      assert.equal(granted.outcome, 'granted');
      const key = granted.key;
      assert.ok(key !== undefined, 'a granted claim carries the key its holder calls back with');

      // ── A browser that was never started is not a browser that died ────
      //
      // Asserted **before** anything launches, because this is the ordinary
      // path rather than an edge case: acquisition is lazy, so the normal
      // life of a lease is claim, then status, then a page verb that finally
      // causes the launch. A probe that read "no browser answering" as "the
      // browser died" would report this perfectly good lease expired — and on
      // a machine with no browser installed it would do that to every lease
      // there has ever been, which is a far worse failure than the one this
      // file exists to fix.
      const unlaunched = await broker.status({ key });
      assert.equal(unlaunched.state, 'active', 'a lease whose browser has yet to start is active');
      assert.equal(
        unlaunched.browser,
        'unknown',
        'nothing has been observed about a browser that was never asked to start',
      );

      // Force the browser to actually exist. Nothing is launched until a page
      // verb needs one — which is what keeps every other path working on a
      // machine with no browser — so a test that only claimed would be
      // asserting against a browser that had never started, and would pass
      // with the fix removed.
      const session = await browsers.session('regular');
      pid = session.describe().pid;
      assert.ok(pid > 0, 'a started browser has a process identifier');

      // The browser is genuinely alive, and status says so. This half is what
      // stops the test passing for the wrong reason: without it, a `liveness`
      // that returned `gone` unconditionally would satisfy every assertion
      // below while breaking every working lease in the product.
      const before = await broker.status({ key });
      assert.equal(before.state, 'active');
      assert.equal(
        before.browser,
        'live',
        'a lease whose browser is running and identifies itself reports live',
      );

      // ── The condition, reproduced ────────────────────────────────────
      //
      // A real signal to a real browser. The discovery record it wrote stays
      // on disk naming a port that now answers nothing, which is precisely
      // the measured state: `discovery.ts` records that the file survives the
      // process, "still present, still readable, and still naming a port that
      // answered nothing".
      process.kill(pid, 'SIGKILL');
      await settle(temp.environment.profileRoot, pid);

      const after = await broker.status({ key });

      // **The assertion this whole file exists for.** Before the fix this was
      // `active`, with `ttlSeconds` intact and `expiresAt` advancing, and a
      // caller polling exactly as documented was told everything was fine.
      assert.notEqual(
        after.state,
        'active',
        'the browser is gone, so the lease must not be reported active',
      );
      assert.equal(after.state, 'expired');
      assert.equal(after.browser, 'gone');

      // A refusal that does not say what to do next is half a refusal — the
      // project's own standard, and acceptance criterion 3: the recovery path
      // has to be reachable from what the caller is told.
      assert.match(
        after.checkBack,
        /release/i,
        'the answer names the way out rather than only reporting the problem',
      );
      assert.match(after.checkBack, /claim again/i);

      // The tab names a page inside a browser that is gone. Handing it back
      // would invite a caller to address it.
      assert.equal(after.tabId, undefined, 'a dead browser leaves no addressable tab');

      // ── The recovery path the answer just promised (criterion 3) ──────
      //
      // Asserted rather than described, because the whole complaint was that
      // release-and-reclaim is the obvious remedy and did not work: nothing
      // noticed the browser was gone, so nothing relaunched it. A stated
      // recovery path that is never exercised is the same class of thing as
      // a check that cannot observe what it checks for.
      await broker.release({ key });
      const again = await broker.claim({
        sessionId: 'dead-browser-suite',
        browser: 'regular',
        purpose: 'proving the way out actually works',
      });
      assert.equal(again.outcome, 'granted');
      assert.ok(again.key !== undefined);

      // **What is asserted is that the dead session was let go of**, which is
      // the thing this change actually does and the thing whose absence made
      // recovery impossible. The memoised entry was handed to every page verb
      // for the life of the process, so while it was held there was no way
      // back from the tool surface at all; once it is dropped, the next caller
      // goes through the ordinary acquisition path and the launch race starts
      // a browser.
      //
      // ── Why the relaunch itself is deliberately NOT asserted here ───────
      //
      // Starting the replacement is the operating system's ordinary work, not
      // this change's, and asserting it makes the test fail for a reason it is
      // not about: ending a browser leaves its process tree holding the
      // profile directory for a while, and `launch.ts` records that a browser
      // started against a profile directory already in use **opens no endpoint
      // and reports nothing**. Under load that window is long enough to be
      // hit, so the assertion would be measuring how busy the machine is.
      //
      // Nothing is lost by leaving it out. Whether acquisition can start a
      // browser is covered where it belongs — the adoption and launch suites —
      // and the eviction below is the one link that was missing.
      assert.equal(
        browsers.holds('regular'),
        false,
        'the dead session is let go of, so the next caller acquires afresh rather than reusing it',
      );
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone — the expected path, since ending it is the subject
          // of this test rather than its cleanup.
        }
      }
      await browsers.close();
      store.close();
      temp.remove();
    }
  },
);

/**
 * Wait until the killed browser's endpoint has actually stopped answering.
 *
 * **A signal returning is not the process having finished exiting.** The
 * browser fixture's teardown documents the same gap from the other side: the
 * operating system releases handles a moment after the kill returns. Probing
 * in that window can still get an answer, which would make this suite flaky
 * in the one direction that matters — green while the defect is present.
 *
 * So this polls the same check the product uses rather than sleeping a
 * guessed interval, and gives up after a bound. Giving up does not fail the
 * test here: the assertions that follow are what decide the outcome, and if
 * the endpoint really is still answering they will say so plainly rather than
 * being pre-empted by a timeout with a less useful message.
 */
async function settle(profileRoot: string, pid: number): Promise<void> {
  const { browserIsRunning } = await import('../../src/browser/real.ts');
  const directory = profileDirectory(profileRoot, 'regular');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await browserIsRunning(directory);
    if (record === undefined && !stillRunning(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Whether the killed process has actually finished exiting.
 *
 * **Waiting for the endpoint to stop answering is not enough**, and the
 * distinction is what the launch path itself warns about: a browser started
 * against a profile directory **already in use** opens no endpoint of its own
 * and reports nothing. The signal returns long before the process tree lets go
 * of the profile, so a relaunch attempted in that window hits exactly that
 * silent collision and fails for a reason unrelated to what is being asserted.
 *
 * Signal zero asks whether a process exists without sending anything to it,
 * which is the cheapest available way to ask. A permission error means it
 * exists and is somebody else's, so it counts as running.
 */
function stillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
