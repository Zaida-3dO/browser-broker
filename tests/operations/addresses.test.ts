import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  readAddresses,
  renderAddress,
  UNREACHABLE,
  type AddressRequest,
  type AddressSource,
} from '../../src/operations/addresses.ts';
import type { TabHandle } from '../../src/browser/driver.ts';

/**
 * The live address read (`MILESTONES.md` #70, `SCHEMA.md` §4.2a).
 *
 * The two rules under test, and neither is optional:
 *
 * 1. Every read carries a timeout, **per tab**, so one wedged page costs one
 *    entry rather than the whole run.
 * 2. A browser that does not answer renders as an explicit word — never
 *    blank, never omitted, never a placeholder address.
 *
 * **The timer is injected**, so a hang is a test that finishes rather than a
 * test that waits two seconds. A test that used the real clock would either
 * be slow or would prove the timeout with a value so small it proved nothing.
 */

function handle(driverTabId: string): TabHandle {
  return { browser: 'regular', driverTabId };
}

function request(tabId: string): AddressRequest {
  return { tabId, browser: 'regular', handle: handle(`driver-${tabId}`) };
}

/**
 * A timer that fires as soon as it is set, on the next turn of the loop.
 *
 * **It records every duration it was handed**, which is what the per-tab
 * assertions read: the durations array is the evidence that the bound was
 * applied once per tab rather than once per run.
 *
 * Firing immediately rather than on the test's command is deliberate. The
 * reads are sequential, so a timer for the second tab does not exist until
 * the first has settled — a test that fired a batch and then pumped
 * microtasks would have to guess how many turns each step takes, and would
 * hang the moment the guess was wrong. Firing on registration means the
 * sequence drives itself and the test only awaits the result.
 *
 * It fires on a **macrotask** rather than a microtask, and the distinction is
 * load-bearing rather than incidental: an already-resolved read still has
 * microtasks to run before it settles, so a microtask timer would beat it and
 * every read would report `unreachable` — a timer that always wins is not a
 * timeout, it is a broken source, and it would make the "one wedged tab" test
 * pass for the wrong reason. A macrotask lets a read that has an answer give
 * it, and fires only for one that does not.
 *
 * The delay is zero, so nothing here waits on wall-clock time.
 */
function controllableTimer(): {
  readonly setTimer: (fn: () => void, ms: number) => { readonly cancel: () => void };
  readonly durations: number[];
} {
  const durations: number[] = [];
  return {
    setTimer: (fn, ms) => {
      durations.push(ms);
      const handle = setTimeout(fn, 0);
      return {
        cancel: () => {
          clearTimeout(handle);
        },
      };
    },
    durations,
  };
}

describe('reading tab addresses live', () => {
  it('reports the address a browser gives', async () => {
    const source: AddressSource = {
      addressOf: () => Promise.resolve({ url: 'https://example.com/a', title: 'A page' }),
    };

    const addresses = await readAddresses(source, [request('tab-1')], { timeoutMs: 50 });

    const address = addresses.get('tab-1');
    assert.ok(address);
    assert.equal(address.kind, 'address');
    assert.equal(renderAddress(address), 'https://example.com/a');
  });

  it('renders a browser that never answers as the explicit word', async () => {
    // The rule, in one assertion. Breaks if the timeout is removed (the test
    // hangs), and breaks if the unanswered branch returns anything other than
    // `unreachable`.
    const timer = controllableTimer();
    const source: AddressSource = {
      // Never settles. This is exactly §2.4b's wedged browser: it accepts the
      // request and never answers.
      addressOf: () => new Promise(() => {}),
    };

    const addresses = await readAddresses(source, [request('tab-1')], {
      timeoutMs: 2000,
      setTimer: timer.setTimer,
    });

    const address = addresses.get('tab-1');
    assert.ok(address);
    assert.equal(address.kind, 'unreachable');
    assert.equal(renderAddress(address), UNREACHABLE);
    // Not blank, not omitted, not a placeholder address.
    assert.notEqual(renderAddress(address), '');
    assert.ok(!renderAddress(address).includes('://'));
  });

  it('carries the timeout on every read, not on the run', async () => {
    // "The timeout is per tab, so one wedged page costs one entry rather than
    // the whole run." Breaks if a single timer is set around the loop.
    const timer = controllableTimer();
    const source: AddressSource = { addressOf: () => new Promise(() => {}) };

    const addresses = await readAddresses(
      source,
      [request('tab-1'), request('tab-2'), request('tab-3')],
      { timeoutMs: 1500, setTimer: timer.setTimer },
    );

    assert.equal(timer.durations.length, 3);
    assert.deepEqual(timer.durations, [1500, 1500, 1500]);
    assert.equal(addresses.size, 3);
  });

  it('lets one wedged tab cost one entry rather than the whole run', async () => {
    // The reason the timeout is per tab. A run that inherited the hang would
    // never resolve; a run with one timer would lose the answers either side.
    const timer = controllableTimer();
    let call = 0;
    const source: AddressSource = {
      addressOf: () => {
        call += 1;
        if (call === 2) {
          return new Promise(() => {});
        }
        return Promise.resolve({ url: `https://example.com/${String(call)}`, title: 't' });
      },
    };

    const addresses = await readAddresses(
      source,
      [request('tab-1'), request('tab-2'), request('tab-3')],
      { timeoutMs: 1000, setTimer: timer.setTimer },
    );

    // Named per tab, not counted: a version that dropped tab-3 and duplicated
    // tab-1 would keep a size-three assertion green.
    assert.equal(addresses.get('tab-1')?.kind, 'address');
    assert.equal(addresses.get('tab-2')?.kind, 'unreachable');
    assert.equal(addresses.get('tab-3')?.kind, 'address');
    assert.equal(renderAddress(addresses.get('tab-3')), 'https://example.com/3');
  });

  it('renders a read that failed as unreachable rather than propagating', async () => {
    // A rejection and a hang are the same fact to a reader: the question was
    // asked and no address came back. Breaks if the rejection escapes, which
    // would produce no document at all.
    const source: AddressSource = {
      addressOf: () => Promise.reject(new Error('the browser closed the connection')),
    };

    const addresses = await readAddresses(source, [request('tab-1')], { timeoutMs: 50 });

    const address = addresses.get('tab-1');
    assert.ok(address);
    assert.equal(address.kind, 'unreachable');
    assert.equal(renderAddress(address), UNREACHABLE);
  });

  it('never throws, whatever the browsers do', async () => {
    // §4.2a: a generator producing nothing at all is worse than an incomplete
    // document.
    const source: AddressSource = {
      addressOf: () => {
        throw new Error('thrown synchronously, before any promise exists');
      },
    };

    await assert.doesNotReject(async () => {
      const addresses = await readAddresses(source, [request('tab-1')], { timeoutMs: 50 });
      assert.equal(addresses.get('tab-1')?.kind, 'unreachable');
    });
  });
});

describe('rendering an address', () => {
  it('renders a tab with no entry at all as the explicit word', () => {
    // The "omitted" case §4.2a forbids. An address that was never obtained is
    // not an address, and a blank cell would be the thing the rule rules out.
    assert.equal(renderAddress(undefined), UNREACHABLE);
  });

  it('distinguishes a lease with no tab from a browser that did not answer', () => {
    // "A missing address and an unanswered one are different facts, and the
    // second is the one that indicates something wrong." Collapsing the two
    // would bury the signal under the ordinary case.
    assert.notEqual(renderAddress({ kind: 'none' }), UNREACHABLE);
    assert.equal(renderAddress({ kind: 'none' }), 'no tab');
  });

  it('uses one word for every unreachable outcome', () => {
    assert.equal(
      renderAddress({ kind: 'unreachable', reason: 'no answer within 2000ms' }),
      UNREACHABLE,
    );
    assert.equal(renderAddress({ kind: 'unreachable', reason: 'the read failed' }), UNREACHABLE);
  });
});
