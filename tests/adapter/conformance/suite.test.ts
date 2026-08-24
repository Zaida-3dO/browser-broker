import assert from 'node:assert/strict';
import test from 'node:test';

import { ADAPTER_IDS } from '../../../src/adapter/contract.ts';
import {
  CONFORMANCE_CASES,
  OPERATIONS_WITH_CASES,
} from '../../../src/adapter/conformance/cases.ts';
import { CONFORMANCE_DRIVERS } from '../../../src/adapter/conformance/drivers.ts';
import {
  DOUBLE_RULE_REGISTRY,
  makeServiceDouble,
} from '../../../src/adapter/conformance/service-double.ts';
import { runConformance } from '../../../src/adapter/conformance/run.ts';
import { OPERATION_NAMES } from '../../../src/adapter/operations.ts';

/**
 * The conformance suite itself, run over every mounted route.
 *
 * This is the assertion M5 is measured by. The negative controls next door
 * prove it can fail; this proves it passes over the mounted routes, and the
 * two are only meaningful together.
 *
 * **What it proves, exactly.** One route is mounted, so this is not yet
 * a comparison between routes — that is row #30, once the tool surface (#27)
 * lands and joins the registry. What it proves is that the machinery is
 * real and green: the cross product runs, every operation is covered both
 * ways, every rule the service can produce was actually produced by a
 * refusal, and no refusal on this route touched the browser or moved the
 * claim count. The day #27 is registered, the compiler demands its driver and
 * these same assertions become the cross-route comparison with no case
 * rewritten.
 */

test('the conformance suite passes over every mounted route', async () => {
  const report = await runConformance({
    drivers: CONFORMANCE_DRIVERS,
    cases: CONFORMANCE_CASES,
    rules: DOUBLE_RULE_REGISTRY,
    makeService: makeServiceDouble,
  });

  assert.deepEqual(report.findings, [], 'the conformance suite reported findings');
});

test('the matrix is not empty — every case ran on every route offering its operation', async () => {
  // A green run over an empty matrix is the failure `MILESTONES.md` names, so
  // the number of pairs is computed independently and compared, rather than
  // being read back from the report that would also be empty.
  const expected = ADAPTER_IDS.reduce((total, id) => {
    const offered = new Set(CONFORMANCE_DRIVERS[id].adapter.operations);
    return total + CONFORMANCE_CASES.filter((entry) => offered.has(entry.operation)).length;
  }, 0);

  const report = await runConformance({
    drivers: CONFORMANCE_DRIVERS,
    cases: CONFORMANCE_CASES,
    rules: DOUBLE_RULE_REGISTRY,
    makeService: makeServiceDouble,
  });

  assert.ok(expected > 0, 'the expected matrix size is zero');
  assert.equal(report.pairsRun, expected);
});

test('every operation has a case, named rather than counted', () => {
  // `MILESTONES.md` records a hollow test that "iterated a list rather than
  // naming its entries, so deleting an entry stayed green". Comparing the two
  // sorted lists by value fails on a deletion, a rename and an addition alike.
  assert.deepEqual([...OPERATIONS_WITH_CASES].sort(), [...OPERATION_NAMES].sort());
});

test('every rule the service can refuse with was produced by a real refusal', async () => {
  const report = await runConformance({
    drivers: CONFORMANCE_DRIVERS,
    cases: CONFORMANCE_CASES,
    rules: DOUBLE_RULE_REGISTRY,
    makeService: makeServiceDouble,
  });

  // Observed, not declared: `rulesObserved` is assembled from what came back
  // out of the service, so this assertion is about enforcement rather than
  // about the case table's good intentions.
  assert.deepEqual([...report.rulesObserved].sort(), [...DOUBLE_RULE_REGISTRY.names].sort());
});

test('every mounted route has a conformance driver — the map is complete at run time too', () => {
  // The compiler already requires this. Asserting it again at run time costs
  // nothing and catches the one case the compiler cannot: a map widened to
  // `Partial` or given an index signature by a later change.
  for (const id of ADAPTER_IDS) {
    const driver: unknown = CONFORMANCE_DRIVERS[id];
    assert.ok(driver, `no conformance driver for the "${id}" route`);
    assert.equal(
      CONFORMANCE_DRIVERS[id].adapter.id,
      id,
      'a driver is registered under another route’s key',
    );
  }
});
