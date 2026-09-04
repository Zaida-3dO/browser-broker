import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FakeBrowserDriver } from '../../browser/fake.ts';
import { countActiveClaims } from '../../service/capacity.ts';
import { createRuntime } from '../../service/runtime.ts';
import type { RuleRegistry } from '../service-seam.ts';
import type { ConformanceSubject } from './run.ts';

/**
 * The **real service**, as the conformance suite's subject.
 *
 * ── Why the suite's subject has to be this and not a stand-in ───────────
 *
 * §8 asks whether **the rules are the same through every door**. A subject
 * that implements the case table's rules itself cannot answer that: the rules
 * being compared are the stand-in's, so a green matrix says only that each
 * route carries an outcome faithfully — a much narrower claim, and one that
 * holds just as well against a service enforcing something else entirely.
 *
 * `createRuntime` builds the service both shipped binaries build: the real
 * store, the real schema, the real artifact store, the real broker, the real
 * bridge. With it behind the seam, every assertion in `run.ts` is an
 * assertion about enforcement, and no case or driver has to be shaped
 * differently to get there — which is what the seam is for.
 *
 * ── The one thing that is faked, and the argument for faking it ─────────
 *
 * **The browser driver.** Continuous integration runs headless with no
 * browser binary, and the two routes are spawned there on every change; a
 * subject that needed a real browser would make the parity suite unrunnable
 * in the one place it most needs to run.
 *
 * **A real service over a fake driver is still the real service**, and that
 * is not a concession — it is the right shape for this particular assertion.
 * §8's four assertions are about *rules*: the same acceptance or the same
 * refusal code and rule name on every route, a refusal that touches no
 * browser and moves no claim count, every operation covered both ways, every
 * rule produced by a real refusal. Not one of them is a claim about what a
 * page does. Every rule those assertions are about is enforced inside the
 * arbitration transaction, before any browser is reached — §2.4b guarantees
 * exactly that — so the driver is downstream of everything under test.
 *
 * What the fake buys, beyond running at all, is the **second half of
 * assertion 2**: `SCHEMA.md` §8 requires that a refusal never touched the
 * browser, and "never touched" is only checkable against something that
 * records being touched. A real browser would have to be interrogated about
 * what it did; the fake keeps an ordered log, which is a stronger reading of
 * the same property.
 *
 * **What it therefore does not prove, stated plainly:** that a page navigates,
 * that a capture contains pixels, or that any verb does its physical work.
 * Those belong to the browser suites, which are local-only for the same
 * reason this is not. A green run here is evidence about rules and routes, and
 * reading it as evidence about browsers would be over-reading it.
 *
 * ── Isolated per case, because the runner asks for that ─────────────────
 *
 * `ConformanceRunOptions.makeService` is called **per case-and-route pair**,
 * so each subject below gets its own temporary directory and its own store. A
 * shared store would let one case's claim be visible to the next, and the
 * claim-count assertion would then be reading somebody else's leftovers.
 * `dispose` removes the tree.
 */

/** Every rule the real service produces in this suite's run. */
export const SERVICE_RULE_REGISTRY: RuleRegistry = {
  names: [
    'key.present',
    'key.valid',
    'claim.browser_known',
    'claim.purpose_bounded',
    'tab.owned',
    'navigate.scheme_allowed',
    'act.action_known',
    'evaluate.expression_bounded',
    'capture.exclusive_mode',
    'feedback.rating_in_scale',
    // The sign-in request's own bound. It is the only one of the three
    // §5.5.2 rules a conformance case reaches, and that is deliberate rather
    // than an omission: this registry is *"every rule the real service
    // produces in this suite's run"*, and the suite asserts equality in both
    // directions — so a name listed here that no case produces fails just as
    // loudly as one produced and not listed. `signin.requester_holds_tab` and
    // `signin.finish_owned` are exercised by the service tests, where a
    // second lease and a queued lease can be arranged; a conformance case
    // names one operation and one input and cannot set either up.
    'signin.what_bounded',
  ],
};

/**
 * Build one isolated real service, with a fake browser behind it.
 *
 * The environment is passed as a record rather than set on the process:
 * `readEnvironment` takes one, and a subject that mutated `process.env` would
 * be read by every other test sharing the process.
 */
/** How many times a subject's directory is removed before the failure is reported. */
const REMOVE_ATTEMPTS = 10;

/** How long to wait between removal attempts, in milliseconds. */
const REMOVE_RETRY_DELAY_MS = 30;

/**
 * Remove a subject's temporary directory, waiting out a handle the OS is still
 * releasing — and **saying so** if the directory genuinely will not go.
 *
 * `dispose` is called from a `finally` in the conformance runner, so anything
 * thrown here becomes the result of the case that just ran. On Windows a
 * still-live handle makes `rmSync` fail with `EPERM` (`force` suppresses only
 * `ENOENT`), and `node --test` attributes such a throw to the **file** rather
 * than to any test — producing a bare file-level failure with every subtest
 * passing. That is a fixture fault wearing the costume of a test fault, and it
 * is worth naming because this suite has already spent a red Windows run on it.
 *
 * The retry is written out rather than delegated to `rmSync`'s own
 * `maxRetries`/`retryDelay`: measured here, those options make no difference to
 * this failure at all (`{ maxRetries: 20 }` gives up as fast as
 * `{ maxRetries: 0 }`), so relying on them would look like a fix while changing
 * nothing.
 *
 * A directory that survives every attempt still throws. The alternative —
 * swallowing it — is how ~1,450 stores accumulated unnoticed in the first place.
 */
function removeSubjectDirectory(directory: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < REMOVE_ATTEMPTS - 1) {
        // Blocking on purpose: the caller is synchronous, and the wait exists
        // to let the OS finish a release this thread cannot observe otherwise.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, REMOVE_RETRY_DELAY_MS);
      }
    }
  }
  throw new Error(
    `could not remove the conformance subject's store at ${directory}. ` +
      'A handle was most likely still open when the subject was disposed.',
    { cause: lastError },
  );
}

export async function makeServiceSubject(): Promise<ConformanceSubject> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-conformance-'));
  const driver = new FakeBrowserDriver();

  const runtime = await createRuntime({
    adapter: 'cli',
    driver,
    env: {
      BROKER_DB: path.join(directory, 'broker.db'),
      BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
      BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
    },
  });

  return {
    service: runtime.service,
    // The fake's own log, which is what makes "a refusal touched no browser"
    // checkable rather than asserted — and the entries are passed whole, so a
    // case can also ask what the browser was told, not merely that it was
    // spoken to. Dropping the arguments here would make a route that forwards
    // an argument and one that discards it indistinguishable to every case in
    // the table.
    driverCalls: () => driver.calls,
    // **The same predicate the capacity check uses**, per `driver.ts`'s
    // requirement for this reading — not a count of rows in `claims`, which
    // would include the ended ones and move for reasons a refusal did not
    // cause.
    liveClaimCount: () => countActiveClaims(runtime.store.db),
    dispose: () => {
      runtime.close();
      removeSubjectDirectory(directory);
    },
  };
}
