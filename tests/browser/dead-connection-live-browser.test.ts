import assert from 'node:assert/strict';
import test from 'node:test';

import { RealBrowserDriver } from '../../src/browser/real.ts';
import { browserSessionProvider } from '../../src/service/browser-session.ts';
import { prepareStore } from '../../src/store/open.ts';
import { browserAvailable, skipReason } from '../helpers/browser.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * ⚠️ THIS SUITE DRIVES A **REAL** BROWSER AND ENDS ITS CONNECTION. ⚠️
 *
 * ── Why this file exists, stated first ─────────────────────────────────
 *
 * The session provider learned to ask a memoised session whether its
 * connection is still usable, and to drop it if not. That guard was reviewed,
 * merged into a branch, passed sixteen continuous-integration jobs — and
 * **changed nothing for any real caller**, because {@link RealBrowserSession}
 * never implemented the member it asks for. The member was declared optional,
 * absence deliberately meant "assume usable", and the sole production session
 * was silently absent. Every real call took the assume-usable branch.
 *
 * Two gates were open at once and neither could close:
 *
 * 1. **The type checker could not object.** An optional member is satisfied by
 *    omission, so `RealBrowserSession implements BrowserSession` compiled
 *    clean without it. That hole is now shut at the seam: `isConnected` is
 *    **required**, so omitting it is a compile error.
 * 2. **Continuous integration could not observe it.** Every real-browser test
 *    skips on a hosted runner with no browser binary, so a green pipeline was
 *    never evidence about this path. That hole is shut by this file — but only
 *    on a machine that has a browser, which is why the skip below says so by
 *    name rather than passing quietly.
 *
 * ── Why a fake driver cannot catch this ────────────────────────────────
 *
 * **The subject is the delegation itself** — whether the production session
 * forwards the question to the connection it holds. A fake session answers
 * from a flag the test set, so it exercises the provider's branch and says
 * nothing whatever about `real.ts`. That is exactly the gap that let this
 * ship: the provider's guard was mutation-tested and sound, and the code
 * feeding it did not exist. A test that swaps in a fake here would pass
 * against the broken tree and the fixed tree alike.
 *
 * So the browser is genuine, the connection is ended through the real
 * `detach`, and the browser is deliberately **left running** afterwards —
 * because a live browser with a dead connection is the precise state that
 * defeats the other half of the logic: `liveness` asks the operating system
 * whether a browser is running, gets `live`, and correctly evicts nothing.
 *
 * ── Hygiene ────────────────────────────────────────────────────────────
 *
 * The browser outlives the connection on purpose, so it must be ended in the
 * teardown rather than by the body. A leaked browser here would be
 * particularly bad: this project once reached 1,637 processes and froze a
 * machine.
 */

const available = browserAvailable();

test(
  'a real session whose connection ended is not handed back, though its browser still runs',
  { skip: available ? false : skipReason() },
  async () => {
    const temp = makeTempStore();
    const store = await prepareStore(temp.environment);
    const browsers = browserSessionProvider({
      store,
      environment: temp.environment,
      // Startup on a machine already busy starting browsers is slow enough to
      // reach the default bound, and a launch that times out would fail this
      // test for a reason unrelated to what it asserts. The bound is the only
      // thing relaxed and it cannot mask the defect: waiting longer for a
      // browser that is starting says nothing about a connection that ended.
      driver: new RealBrowserDriver({
        engine: temp.environment.regularBrowserEngine,
        launch: { readinessTimeoutMs: 60_000 },
      }),
    });

    let pid: number | undefined;
    try {
      const first = await browsers.session('regular');
      pid = first.describe().pid;
      assert.ok(pid > 0, 'a started browser has a process identifier');

      // ── The production session answers the question at all ────────────
      //
      // This is the assertion whose absence was the whole defect. It is not a
      // restatement of the interface: `isConnected` was declared on the seam
      // and this class did not implement it, so this line is the difference
      // between a member that exists and one that only appears to.
      assert.equal(
        typeof first.isConnected,
        'function',
        'the production session implements the member the provider asks for',
      );
      assert.equal(first.isConnected(), true, 'and reports the live connection as connected');

      // The memo is doing its job while the connection is up. Without this
      // half, a delegation hard-coded to `false` would satisfy everything
      // below while re-acquiring a browser on every single page verb.
      assert.equal(await browsers.session('regular'), first, 'a live session is still reused');

      // ── The condition, reproduced against a real browser ──────────────
      //
      // `detach` closes **this process's connection** and leaves the browser
      // running — the measured property the whole shared-session design rests
      // on. That is the state five sessions reported: the browser answers the
      // operating system, and every page verb over the dead connection fails
      // with `Target page, context or browser has been closed`.
      await first.detach();
      assert.equal(
        first.isConnected(),
        false,
        'the connection reports itself ended, which is what the guard consults',
      );

      // The browser is deliberately still alive, so `liveness` says `live` and
      // evicts nothing. Asserted rather than assumed, because if the browser
      // had died here the eviction below could be credited to the pre-existing
      // liveness path and this test would prove nothing new.
      assert.equal(
        await browsers.liveness('regular'),
        'live',
        'the browser outlived the connection, which is the state that defeats liveness',
      );

      // **The assertion this file exists for.** With the delegation absent the
      // guard reads an undefined member, takes the assume-usable branch, and
      // hands back this very object — dead connection and all.
      const next = await browsers.session('regular');
      assert.notEqual(
        next,
        first,
        'the dead connection is dropped rather than handed to the next page verb',
      );
      assert.equal(next.isConnected(), true, 'and the session handed back is genuinely usable');
    } finally {
      await browsers.close();
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone. `close` detaches rather than ending browsers, so
          // this is the path that actually reclaims the one this test started.
        }
      }
      store.close();
      temp.remove();
    }
  },
);
