import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CONFORMANCE_CASES } from '../../../src/adapter/conformance/cases.ts';
import { FakeBrowserDriver } from '../../../src/browser/fake.ts';
import { createRuntime } from '../../../src/service/runtime.ts';
import { removeDirectory } from '../../helpers/remove-directory.ts';

/**
 * The seed that mints a lease for the keyed cases must produce a **live**
 * lease, not merely a call the transport accepted.
 *
 * ── The two outcomes, and why only one of them is a lease ───────────────
 *
 * A claim answers twice. The transport says whether the call was accepted
 * rather than refused; the service says whether the claim was `granted` a tab
 * or `queued` behind a full budget. Those are different facts, and a full
 * budget produces `accepted` at the transport with `queued` underneath.
 *
 * A queued claim holds a **genuine key with no tab behind it**. So a seed
 * that checks only the transport hands every keyed case a key that the
 * operations will refuse for having no tab — while the seed reports success,
 * and the refusal names a rule that reads like a real finding about the
 * operation under test. `cases.ts` already argues the neighbouring version of
 * this: a key the service never issued would send the whole matrix green on
 * `key.valid`. This is that defect one layer in, and harder to see, because
 * the key is real.
 *
 * This file pins the guard by **making the budget full**, which is the only
 * way to reach a queued seed without reaching into the seed itself.
 */
test('the keyed-case seed refuses a lease that was queued rather than granted', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-seed-liveness-'));
  const driver = new FakeBrowserDriver();
  const runtime = await createRuntime({
    adapter: 'cli',
    driver,
    env: {
      BROKER_DB: path.join(directory, 'broker.db'),
      BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
      BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
      // One tab in the whole service, so the second claim can only queue.
      BROKER_TAB_BUDGET: '1',
    },
  });

  try {
    // Take the only tab there is, so the seed's own claim must queue.
    const first = await runtime.service.perform({
      operation: 'claim',
      adapter: 'conformance',
      arguments: {
        session_id: 'seed-liveness-holder',
        browser: 'regular',
        purpose: 'seed liveness: occupy the only tab',
      },
    });
    assert.equal(first.outcome, 'accepted', 'the first claim should be accepted');
    assert.equal(
      first.outcome === 'accepted' ? first.value['outcome'] : undefined,
      'granted',
      'the first claim should hold the only tab',
    );

    const seeded = CONFORMANCE_CASES.find((entry) => entry.seed !== undefined);
    assert.ok(seeded?.seed, 'expected at least one case to carry a seed');

    // The seed's claim reaches a full budget, so the service queues it. The
    // transport still answers `accepted`, which is exactly the coincidence
    // this guard exists to separate.
    await assert.rejects(
      async () => {
        await seeded.seed!.apply(runtime.service);
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(
          message,
          /not live/,
          `the seed should refuse a queued lease, and say so; it said: ${message}`,
        );
        assert.match(
          message,
          /queued/,
          `the refusal should name the outcome it actually got; it said: ${message}`,
        );
        return true;
      },
    );
  } finally {
    runtime.close();
    removeDirectory(directory);
  }
});
