/**
 * A spawn that does nothing but start, so the startup checks are what is
 * measured.
 *
 * `budget.agrees_with_store` (§7.2) runs on every spawn, after the schema is
 * stepped and before any operation exists to arbitrate. This worker therefore
 * calls `prepareStore` and reports whether it was allowed to run — which is
 * the whole of what the check decides.
 *
 * **Several of these start at once on purpose.** The agreement is read and
 * written inside one immediate transaction, so two processes opening an empty
 * store within the same instant do not both write: the loser reads the
 * winner's row and compares against it. That is the behaviour the contention
 * arrangement is here to exercise rather than a race it is here to survive.
 */

import { waitForBarrier, succeeded, failed } from './worker-support.mjs';

const [, , startAtMs, index] = process.argv;

const { readEnvironment } = await import('../../src/config/environment.ts');
const { prepareStore } = await import('../../src/store/open.ts');

const environment = readEnvironment({ env: process.env });

waitForBarrier(startAtMs);

let store;
try {
  store = await prepareStore(environment);
  succeeded({ index: Number(index), tabBudget: environment.tabBudget });
} catch (error) {
  // The refusal carries the rule that refused, as data rather than baked
  // into the message, so the assertion can branch on the rule instead of
  // matching on English.
  failed(error, {
    index: Number(index),
    tabBudget: environment.tabBudget,
    rule: error?.rule ?? null,
  });
} finally {
  store?.close();
}
