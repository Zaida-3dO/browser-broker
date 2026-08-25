import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXIT_INTERRUPT_INCOMPLETE,
  INTERRUPT_SIGNALS,
  realInterruptHandling,
  runLoginCommand,
  SIGNAL_EXIT_CODES,
  type InterruptHandling,
  type InterruptSignal,
} from '../../src/cli/login-command.ts';
import { SIGNABLE_BROWSER } from '../../src/service/operations/sign-in.ts';
import { withBroker } from '../helpers/broker.ts';

/**
 * **An interrupted `broker login` gives the browser back** (`SCHEMA.md` §5.5.1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE FIXTURE PROBLEM THIS FILE HAD TO SOLVE FIRST
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The obvious test — interrupt a login and assert the browser is serving —
 * **proves nothing**, and it is worth being explicit about why, because it is
 * the shape that would naturally have been written.
 *
 * `runLoginCommand` already returns the browser in a `finally` on every
 * ordinary path. So a test that lets the command run to completion *and* fires
 * an interrupt sees a browser that is serving again — but it would have seen
 * exactly that with **no handler at all**, because the `finally` did it. Correct
 * and incorrect behaviour coincide, and the test passes against the bug.
 *
 * **So every test here forces the case where the handler is the only thing
 * that could have returned the browser**, by interrupting a login that is
 * *still waiting* and never allowing `waitForClose` to resolve. The `finally`
 * cannot have run, because the `try` has not finished. If the browser is
 * serving, the handler is what did it — there is nothing else it could be.
 *
 * The first test below makes that argument checkable rather than merely
 * asserted: it runs the identical scenario with the handler suppressed, and
 * requires the browser to be stranded. A fixture that cannot produce the
 * failure is not evidence about the fix.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE SIGNAL IS INJECTED RATHER THAN SENT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A test that sent a real signal would send it to **the process running the
 * tests**, taking the runner down with it. The handler is therefore installed
 * through {@link InterruptHandling}, and a separate test asserts that the real
 * implementation registers for the signals it claims to — so the seam cannot
 * drift away from what ships.
 *
 * **What that leaves unproven is stated rather than papered over**: that the
 * host actually delivers `SIGINT` to this process. That is a property of the
 * operating system, not of this code, and it is one of the reasons the design
 * does not rest on the handler alone — `service/signin-recovery.ts` makes the
 * state recoverable when nothing ran at all, and its tests do not depend on
 * signals in any way.
 */

/** A handler seam a test fires by hand, standing in for the operating system. */
function controllableInterrupts(): InterruptHandling & {
  readonly fire: (signal?: InterruptSignal) => void;
  readonly installed: () => number;
  readonly removed: () => number;
} {
  let handler: ((signal: InterruptSignal) => void) | undefined;
  let installs = 0;
  let removals = 0;

  return {
    install: (onInterrupt) => {
      installs += 1;
      handler = onInterrupt;
      return () => {
        removals += 1;
        handler = undefined;
      };
    },
    fire: (signal = 'SIGINT') => {
      assert.ok(handler !== undefined, 'nothing was listening for an interrupt');
      handler(signal);
    },
    installed: () => installs,
    removed: () => removals,
  };
}

/** A seam that registers nothing — the code as it behaved before the fix. */
const noInterruptHandling: InterruptHandling = {
  install: () => () => {
    /* nothing was ever registered, so there is nothing to remove */
  },
};

const streamsCollecting = (): {
  streams: { out: (line: string) => void; err: (line: string) => void };
  out: string[];
  err: string[];
} => {
  const out: string[] = [];
  const err: string[] = [];
  return { streams: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
};

/** Read the browser's state directly, which is what a later caller is refused on. */
function browserState(db: { prepare: (sql: string) => { get: (id: string) => unknown } }): string {
  const row = db.prepare('SELECT state FROM browsers WHERE id = ?').get(SIGNABLE_BROWSER) as
    { state: string } | undefined;
  return row?.state ?? 'missing';
}

/**
 * Run a login that hangs in `waitForClose`, interrupt it, and report what the
 * store said **while the command was still inside its `try`**.
 *
 * Returns once the handler's own asynchronous work has settled. The command's
 * promise is deliberately left pending: that is the whole point — a `finally`
 * that has not run cannot be what returned the browser.
 */
async function interruptedMidWait(options: {
  readonly interrupts: InterruptHandling;
  readonly fire?: () => void;
  readonly failEndSignIn?: boolean;
}): Promise<{ state: string; exitCodes: number[]; err: string[] }> {
  let result!: { state: string; exitCodes: number[]; err: string[] };

  await withBroker(async ({ broker, store, environment }) => {
    const collected = streamsCollecting();
    const exitCodes: number[] = [];

    const wrapped = options.failEndSignIn
      ? {
          ...broker,
          end_sign_in: () => Promise.reject(new Error('the store went away')),
        }
      : broker;

    // Never resolves. The command sits in step three exactly as it does while
    // a person is signing in, so its `finally` cannot have run.
    const neverCloses = new Promise<void>(() => {
      /* deliberately pending for the life of the test */
    });

    void runLoginCommand({
      broker: wrapped,
      store,
      environment,
      streams: collected.streams,
      json: false,
      interrupts: options.interrupts,
      exit: (code) => exitCodes.push(code),
      window: {
        open: () => Promise.resolve({ pid: 4242, startedIt: true }),
        waitForClose: () => neverCloses,
      },
    });

    // Let the command reach `waitForClose`.
    await new Promise((resolve) => setImmediate(resolve));

    options.fire?.();

    // Let the handler's asynchronous release settle.
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    result = { state: browserState(store.db), exitCodes, err: collected.err };
  });

  return result;
}

test('THE FIXTURE IS HONEST: with no handler, an interrupted login strands the browser', async () => {
  // This is the bug, reproduced. It is a test about the *fixture* rather than
  // about the fix: it proves that in this scenario the browser is stranded
  // unless something actively returns it, so the next test's pass cannot be
  // explained by the `finally` having quietly done the work.
  const stranded = await interruptedMidWait({ interrupts: noInterruptHandling });

  assert.equal(
    stranded.state,
    'signing-in',
    'without a handler the browser must still be stranded — if it is not, this scenario proves nothing about the handler',
  );
});

test('THE FIX: an interrupted login returns the browser, and only the handler could have', async () => {
  const interrupts = controllableInterrupts();
  const recovered = await interruptedMidWait({
    interrupts,
    fire: () => {
      interrupts.fire('SIGINT');
    },
  });

  // The command is still inside its `try` — `waitForClose` never resolved — so
  // the `finally` has not run and cannot be what moved this.
  assert.notEqual(recovered.state, 'signing-in', 'the browser was left stranded');
  assert.equal(recovered.state, 'stopped', 'the browser should be back to what its pid says it is');
});

test('the interrupted command exits with the code a shell reports for that signal', async () => {
  for (const signal of INTERRUPT_SIGNALS) {
    const interrupts = controllableInterrupts();
    const outcome = await interruptedMidWait({
      interrupts,
      fire: () => {
        interrupts.fire(signal);
      },
    });

    assert.deepEqual(
      outcome.exitCodes,
      [SIGNAL_EXIT_CODES[signal]],
      `${signal} should exit ${String(SIGNAL_EXIT_CODES[signal])}`,
    );
  }
});

test('a second interrupt does not release twice', async () => {
  // A person who presses Ctrl-C and sees nothing happen presses it again. A
  // second release would hit the service's refusal for ending a sign-in that
  // never began, turning a clean interruption into an error on the way out.
  const interrupts = controllableInterrupts();
  const outcome = await interruptedMidWait({
    interrupts,
    fire: () => {
      interrupts.fire('SIGINT');
      interrupts.fire('SIGINT');
      interrupts.fire('SIGINT');
    },
  });

  assert.deepEqual(outcome.exitCodes, [130], 'the process should be ended exactly once');
  assert.equal(
    outcome.err.filter((line) => line.includes('could not be returned to service')).length,
    0,
    'a repeated Ctrl-C must not produce a refusal on the way out',
  );
});

test('when the release FAILS the exit code says so rather than reporting a clean interruption', async () => {
  const interrupts = controllableInterrupts();
  const outcome = await interruptedMidWait({
    interrupts,
    failEndSignIn: true,
    fire: () => {
      interrupts.fire('SIGINT');
    },
  });

  assert.deepEqual(
    outcome.exitCodes,
    [EXIT_INTERRUPT_INCOMPLETE],
    'a failed cleanup must not exit with the ordinary interrupted code',
  );
  assert.ok(
    outcome.err.some((line) => line.includes('could not be returned to service')),
    'the failure has to be said out loud',
  );
  assert.ok(
    outcome.err.some((line) => line.includes('will reclaim it')),
    'and the person has to be told what happens next',
  );
});

test('a completed login removes its handler, leaving no listener behind', async () => {
  await withBroker(async ({ broker, store, environment }) => {
    const interrupts = controllableInterrupts();
    const collected = streamsCollecting();

    const code = await runLoginCommand({
      broker,
      store,
      environment,
      streams: collected.streams,
      json: false,
      interrupts,
      window: {
        open: () => Promise.resolve({ pid: 7, startedIt: true }),
        waitForClose: () => Promise.resolve(),
      },
    });

    assert.equal(code, 0);
    assert.equal(interrupts.installed(), 1, 'exactly one handler should have been installed');
    assert.equal(interrupts.removed(), 1, 'and it should have been removed on the way out');
  });
});

test('the REAL handler registers for the signals it claims to, and unregisters cleanly', () => {
  // The tests above drive a seam. This one asserts the shipped implementation
  // actually attaches to the process for each signal it names — otherwise the
  // seam could be correct while nothing was listening in production, which is
  // the "registered but never fires" failure in a different disguise.
  const before = INTERRUPT_SIGNALS.map((signal) => process.listenerCount(signal));

  const dispose = realInterruptHandling().install(() => {
    /* never fired by this test; sending a real signal would end the runner */
  });

  const during = INTERRUPT_SIGNALS.map((signal) => process.listenerCount(signal));
  INTERRUPT_SIGNALS.forEach((signal, at) => {
    assert.equal(
      during[at],
      (before[at] ?? 0) + 1,
      `nothing was listening for ${signal} after install`,
    );
  });

  dispose();

  const after = INTERRUPT_SIGNALS.map((signal) => process.listenerCount(signal));
  INTERRUPT_SIGNALS.forEach((signal, at) => {
    assert.equal(after[at], before[at], `the ${signal} listener outlived the command`);
  });
});
