import assert from 'node:assert/strict';
import test from 'node:test';

import { ADAPTER_IDS } from '../../../src/adapter/contract.ts';
import {
  CONFORMANCE_CASES,
  OPERATIONS_WITH_CASES,
} from '../../../src/adapter/conformance/cases.ts';
import { CONFORMANCE_DRIVERS } from '../../../src/adapter/conformance/drivers.ts';
import {
  SERVICE_RULE_REGISTRY,
  makeServiceSubject,
} from '../../../src/adapter/conformance/service-subject.ts';
import { runConformance } from '../../../src/adapter/conformance/run.ts';
import { OPERATION_NAMES } from '../../../src/adapter/operations.ts';

/**
 * The conformance suite itself, run over every mounted route, **against the
 * real service** (row #30).
 *
 * This is the assertion M5 is measured by. The negative controls next door
 * prove it can fail; this proves it passes over the mounted routes, and the
 * two are only meaningful together.
 *
 * ── What it proves now, and what changed to make that true ──────────────
 *
 * The subject is `makeServiceSubject` — the service `createRuntime` builds
 * for both shipped binaries, with only the browser driver faked. So every
 * refusal below is one the service itself produced, and the four §8
 * assertions are about **enforcement**: the same acceptance or the same code
 * and rule name on both routes, a refusal that touched no browser and moved
 * no claim count, every operation covered both ways, and every registered
 * rule produced by a refusal that actually happened.
 *
 * A subject that implemented the case table's rules itself could only ever
 * prove that a route carries an outcome faithfully — a narrower claim, and
 * one that holds equally against a service enforcing something else. Reaching
 * the real service costs no change to a case's shape and none to a driver,
 * which is what the seam is for.
 *
 * **And the difference is not cosmetic.** Asking the real service these
 * questions is what settles three of them: `capture.exclusive_mode` is a
 * rule `SCHEMA.md` §7.1 specifies, so the service has to implement it and a
 * case has to see it refuse; the rule about an unknown action is spelled
 * `act.action_known`; and a feedback category has to be one of the five the
 * service actually has. A subject answering from the case table would agree
 * with the table on all three and prove none of them.
 */

test('the conformance suite passes over every mounted route', async () => {
  const report = await runConformance({
    drivers: CONFORMANCE_DRIVERS,
    cases: CONFORMANCE_CASES,
    rules: SERVICE_RULE_REGISTRY,
    makeService: makeServiceSubject,
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
    rules: SERVICE_RULE_REGISTRY,
    makeService: makeServiceSubject,
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
    rules: SERVICE_RULE_REGISTRY,
    makeService: makeServiceSubject,
  });

  // Observed, not declared: `rulesObserved` is assembled from what came back
  // out of the service, so this assertion is about enforcement rather than
  // about the case table's good intentions.
  assert.deepEqual([...report.rulesObserved].sort(), [...SERVICE_RULE_REGISTRY.names].sort());
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

/**
 * The subject's two physical readings are **live**, not stubs.
 *
 * ── Why this test exists, found by mutating rather than by review ───────
 *
 * §8 assertion 2 says a refusal touched no browser and moved no claim count.
 * Both halves are evaluated against readings the subject supplies — and an
 * assertion evaluated over a reading that is always empty passes forever and
 * silently, which is the failure `MILESTONES.md` names by name.
 *
 * A subject whose `driverCalls` answers `[]` and whose `liveClaimCount`
 * answers `0` keeps the whole suite green, and keeps the negative controls
 * green too: the controls inject their own readings through `driverOver`, so
 * they measure the runner's arithmetic rather than the subject's instruments.
 * Nothing else in the tree watches them.
 *
 * So this asserts the instruments themselves respond, by driving the subject
 * directly and watching each reading **move**. It is deliberately not a test
 * of any rule — it is a test that the two numbers the rules are checked with
 * are real.
 */
test('the subject reports a real browser log and a real claim count', async () => {
  const subject = await makeServiceSubject();
  try {
    assert.equal(subject.liveClaimCount(), 0, 'a fresh subject already had claims');
    assert.deepEqual([...subject.driverCalls()], [], 'a fresh subject already touched a browser');

    const granted = await subject.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: {
        session_id: 'instrument-check',
        browser: 'regular',
        purpose: 'checking the subject reports live readings',
      },
    });
    assert.equal(granted.outcome, 'accepted');
    if (granted.outcome !== 'accepted') throw new Error('unreachable');

    // The claim count moved, so it is counting something.
    assert.equal(
      subject.liveClaimCount(),
      1,
      'the claim count did not move for a granted claim, so it is not a live reading',
    );

    await subject.service.perform({
      operation: 'navigate',
      adapter: 'cli',
      arguments: { lease_key: granted.value['key'], url: 'https://example.com/' },
    });

    // The browser log moved, so it is recording something. Asserted by naming
    // the calls rather than by counting them: a count would pass against a log
    // that recorded the wrong operation.
    const names = subject.driverCalls().map((call) => call.name);
    assert.ok(
      names.includes('openTab') && names.includes('navigate'),
      `the browser log did not record the work, got ${names.join(', ') || '(nothing)'}`,
    );
  } finally {
    await subject.dispose?.();
  }
});
