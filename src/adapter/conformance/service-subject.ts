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
  ],
};

/**
 * Build one isolated real service, with a fake browser behind it.
 *
 * The environment is passed as a record rather than set on the process:
 * `readEnvironment` takes one, and a subject that mutated `process.env` would
 * be read by every other test sharing the process.
 */
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
    // checkable rather than asserted.
    driverCalls: () => driver.calls,
    // **The same predicate the capacity check uses**, per `driver.ts`'s
    // requirement for this reading — not a count of rows in `claims`, which
    // would include the ended ones and move for reasons a refusal did not
    // cause.
    liveClaimCount: () => countActiveClaims(runtime.store.db),
    dispose: () => {
      runtime.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
