/**
 * One real claim, through the real arbitration path, in its own process.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS THE APPLICATION'S OWN PATH, NOT A MODEL OF IT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The child opens the store the way a spawn opens it (`prepareStore`, which
 * steps the schema and checks the budget agreement), builds the service the
 * way an adapter builds it (`createBroker`), and calls one operation. Nothing
 * about the transaction, the sweep or the capacity comparison is reimplemented
 * here — if any of them changed, this worker would exercise the change.
 *
 * That matters because the alternative is the shape that fails silently: a
 * worker issuing its own hand-written SQL would keep passing after somebody
 * added a read-only fast path to the real code, which is the precise defect
 * the standing invariant exists to prevent.
 *
 * ── Why the environment carries the configuration ───────────────────────
 *
 * §6.3 puts one snapshot of the environment per process, read on the way in.
 * A child process is exactly that, so the test hands it variables rather than
 * arguments and the child reads them the way every real caller does.
 */

import { waitForBarrier, succeeded, failed } from './worker-support.mjs';

const [, , startAtMs, index, browser] = process.argv;

// Imported after the argument read but before the barrier: module loading is
// startup cost, and doing it after the barrier would mean each child spends
// its overlap window loading rather than contending.
const { readEnvironment } = await import('../../src/config/environment.ts');
const { prepareStore } = await import('../../src/store/open.ts');
const { createBroker } = await import('../../src/service/broker.ts');

const environment = readEnvironment({ env: process.env });
const store = await prepareStore(environment);

const broker = createBroker({
  store,
  environment,
  adapter: 'cli',
  // No driver: a contention test has no browser, and omitting the closer
  // leaks tabs rather than leases, which is the documented consequence
  // (§2.4b) rather than a gap. Nothing here asserts on tabs being closed.
});

waitForBarrier(startAtMs);

try {
  const result = await broker.claim({
    // Each child is its own caller. A shared session identifier would make
    // every claim look like one caller taking capacity from itself, which is
    // the case the own-obstacle nudge is about rather than the case this
    // measures.
    sessionId: `session-${String(index)}`,
    browser,
    purpose: 'contending for capacity from a separate process',
  });

  succeeded({
    index: Number(index),
    outcome: result.outcome,
    claimId: result.claimId,
    // Present only on a queue placement. Reported so the ordering assertions
    // can compare what each caller was told against what the store recorded.
    position: result.outcome === 'queued' ? result.position : null,
  });
} catch (error) {
  failed(error, { index: Number(index) });
} finally {
  store.close();
}
