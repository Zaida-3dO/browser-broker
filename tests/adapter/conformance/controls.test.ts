import assert from 'node:assert/strict';
import test from 'node:test';

import { ADAPTER_IDS, type Adapter } from '../../../src/adapter/contract.ts';
import type { ConformanceCase } from '../../../src/adapter/conformance/case.ts';
import type {
  ConformanceDriver,
  ConformanceDrivers,
} from '../../../src/adapter/conformance/driver.ts';
import { CONFORMANCE_CASES } from '../../../src/adapter/conformance/cases.ts';
import { OPERATION_NAMES } from '../../../src/adapter/operations.ts';
import {
  DOUBLE_RULE_REGISTRY,
  makeServiceDouble,
} from '../../../src/adapter/conformance/service-double.ts';
import {
  runConformance,
  type Finding,
  type FindingKind,
} from '../../../src/adapter/conformance/run.ts';
import { cliConformanceDriver } from '../../../src/cli/conformance-driver.ts';

/**
 * The negative controls: **each asserted to fail.**
 *
 * `MILESTONES.md` names every one of these by hand and says why they are not
 * optional: "an assertion nobody has watched fail is an assertion nobody has
 * tested". A suite that has only ever been green over correct input has never
 * demonstrated that it can tell correct from incorrect — which is the only
 * thing it exists to do.
 *
 * Each test below breaks exactly one thing and asserts the runner names
 * exactly that finding. Asserting the *kind* rather than merely "some finding
 * appeared" is deliberate: a runner with one over-eager assertion would
 * satisfy a weaker test on every control while actually detecting nothing.
 */

function kinds(findings: readonly Finding[]): FindingKind[] {
  return findings.map((finding) => finding.kind);
}

/**
 * A driver map in which **every** mounted route is the driver under test.
 *
 * Both keys rather than one, and the reason matters: the map's type requires
 * every mounted route, so a control that supplied a single key would not
 * compile — and the obvious fix, filling the other key with a real driver,
 * would make each control run the honest route alongside the broken one and
 * report findings from both. Pointing every key at the driver under test
 * keeps a control measuring exactly one behaviour, which is what lets it
 * assert the *kind* of finding rather than merely that one appeared.
 *
 * The consequence is that a control's findings arrive once per mounted route.
 * The assertions below are written as "this kind is present" rather than as
 * counts, so they hold whatever the route count is — a control asserting a
 * count would have to be rewritten every time a route lands, which is how a
 * suite decays.
 */
function driversWith(driver: ConformanceDriver): ConformanceDrivers {
  return { 'tool-stdio': driver, cli: driver };
}

/** A driver over an adapter the caller has bent out of shape. */
function driverOver(adapter: Adapter): ConformanceDriver {
  return { ...cliConformanceDriver, adapter };
}

const baseline = {
  cases: CONFORMANCE_CASES,
  rules: DOUBLE_RULE_REGISTRY,
  makeService: makeServiceDouble,
};

test('the suite is GREEN over the real routes — the control every control below is measured against', async () => {
  const report = await runConformance({ ...baseline, drivers: driversWith(cliConformanceDriver) });

  assert.deepEqual(report.findings, [], 'the honest configuration produced findings');
  // A green run over an empty matrix is the failure mode `MILESTONES.md`
  // names, so the count of pairs actually run is asserted rather than assumed.
  assert.ok(report.pairsRun > 0, 'no case-and-route pair ran at all');
  // Every case, on every mounted route. Derived from `ADAPTER_IDS` rather
  // than written as a number, so landing a route raises the bar instead of
  // breaking this line — a hardcoded count is a test that has to be edited
  // every time the thing it measures grows, and an edited test is one nobody
  // reads.
  assert.equal(
    report.pairsRun,
    CONFORMANCE_CASES.length * ADAPTER_IDS.length,
    'not every case ran on every mounted route',
  );
});

test('CONTROL — a route reaching past the service layer is caught, because its outcome differs', async () => {
  // A fixture route that answers from its own logic rather than the service's:
  // it accepts everything, so the refusing cases come back accepted.
  const rogue: ConformanceDriver = {
    adapter: cliConformanceDriver.adapter,
    run: () =>
      Promise.resolve({
        outcome: { outcome: 'accepted' as const, value: {} },
        driverCalls: [],
        liveClaimCount: 0,
      }),
  };

  const report = await runConformance({ ...baseline, drivers: driversWith(rogue) });

  assert.ok(
    kinds(report.findings).includes('outcome-mismatch'),
    'a route bypassing the service was not caught',
  );
});

test('CONTROL — a registered rule with no case is caught', async () => {
  const report = await runConformance({
    ...baseline,
    drivers: driversWith(cliConformanceDriver),
    rules: { names: [...DOUBLE_RULE_REGISTRY.names, 'a.rule_no_case_produces'] },
  });

  const finding = report.findings.find((entry) => entry.kind === 'rule-without-a-case');
  assert.ok(finding, 'a rule with no case was not caught');
  assert.match(finding.detail, /a\.rule_no_case_produces/u);
});

test('CONTROL — a rule is only satisfied by a refusal the service PRODUCED, not by a case that names it', async () => {
  // The sharp version of the assertion above, and the one that keeps the
  // suite honest: a case may *declare* any rule it likes. If declaring were
  // enough, the coverage assertion would measure the case table rather than
  // the service, and would stay green over a service that stopped enforcing.
  const declaredButNeverProduced: ConformanceCase = {
    name: 'a case naming a rule the service never returns',
    operation: 'claim',
    input: { session_id: 'session-a', browser: 'regular', purpose: 'conformance: declared only' },
    expect: { outcome: 'refused', code: 'never_produced', rule: 'a.rule_only_declared' },
  };

  const report = await runConformance({
    ...baseline,
    drivers: driversWith(cliConformanceDriver),
    cases: [...CONFORMANCE_CASES, declaredButNeverProduced],
    rules: { names: [...DOUBLE_RULE_REGISTRY.names, 'a.rule_only_declared'] },
  });

  assert.ok(
    report.findings.some(
      (entry) =>
        entry.kind === 'rule-without-a-case' && entry.detail.includes('a.rule_only_declared'),
    ),
    'declaring a rule in a case was enough to satisfy the coverage assertion',
  );
  assert.equal(
    report.rulesObserved.includes('a.rule_only_declared'),
    false,
    'a rule the service never produced was counted as observed',
  );
});

test('CONTROL — a driver returning a different code for the same input is caught', async () => {
  const wrongCode: ConformanceDriver = {
    adapter: cliConformanceDriver.adapter,
    run: async (service, testCase, observe) => {
      const observation = await cliConformanceDriver.run(service, testCase, observe);
      if (observation.outcome.outcome !== 'refused') {
        return observation;
      }
      return {
        ...observation,
        outcome: { ...observation.outcome, code: 'a_different_code' },
      };
    },
  };

  const report = await runConformance({ ...baseline, drivers: driversWith(wrongCode) });

  assert.ok(
    kinds(report.findings).includes('outcome-mismatch'),
    'a differing refusal code was not caught',
  );
});

test('CONTROL — an operation with only an accepting case is caught', async () => {
  const report = await runConformance({
    ...baseline,
    drivers: driversWith(cliConformanceDriver),
    cases: CONFORMANCE_CASES.filter(
      (testCase) => !(testCase.operation === 'navigate' && testCase.expect.outcome === 'refused'),
    ),
  });

  const finding = report.findings.find((entry) => entry.kind === 'operation-without-both-cases');
  assert.ok(finding, 'an operation with no refusing case was not caught');
  assert.equal(finding.operation, 'navigate');
  assert.match(finding.detail, /no case that is refused/u);
});

test('CONTROL — a refusing case whose call log is not empty is caught', async () => {
  // §8.2, first half: a guard that opens a tab and closes it on the way to
  // refusing leaves the count unchanged and the log full.
  const touchesTheBrowser: ConformanceDriver = {
    adapter: cliConformanceDriver.adapter,
    run: async (service, testCase, observe) => {
      const observation = await cliConformanceDriver.run(service, testCase, observe);
      if (observation.outcome.outcome !== 'refused') {
        return observation;
      }
      return { ...observation, driverCalls: [...observation.driverCalls, { name: 'openTab' }] };
    },
  };

  const report = await runConformance({ ...baseline, drivers: driversWith(touchesTheBrowser) });

  assert.ok(
    kinds(report.findings).includes('refusal-touched-the-browser'),
    'a refusal that opened a tab was not caught',
  );
});

test('CONTROL — a refusing case that leaves the claim count moved is caught', async () => {
  // §8.2, second half, and it is a different bug: a guard that decrements a
  // counter without telling the browser leaves the log empty and the count
  // wrong. Both assertions are needed; neither catches the other's failure.
  const movesTheCount: ConformanceDriver = {
    adapter: cliConformanceDriver.adapter,
    run: async (service, testCase, observe) => {
      const observation = await cliConformanceDriver.run(service, testCase, observe);
      if (observation.outcome.outcome !== 'refused') {
        return observation;
      }
      return { ...observation, liveClaimCount: observation.liveClaimCount + 1 };
    },
  };

  const report = await runConformance({ ...baseline, drivers: driversWith(movesTheCount) });

  assert.ok(
    kinds(report.findings).includes('refusal-moved-the-claim-count'),
    'a refusal that moved the claim count was not caught',
  );
});

test('CONTROL — a route exposing an operation the registry does not know is caught', async () => {
  const inventsAnOperation = driverOver({
    ...cliConformanceDriver.adapter,
    // Deliberately not an `OperationName`. A route that invented one would
    // otherwise contribute an empty row to the matrix and pass vacuously.
    operations: [...cliConformanceDriver.adapter.operations, 'teleport' as never],
  });

  const report = await runConformance({ ...baseline, drivers: driversWith(inventsAnOperation) });

  const finding = report.findings.find((entry) => entry.kind === 'unknown-operation-offered');
  assert.ok(finding, 'an invented operation was not caught');
  assert.match(finding.detail, /teleport/u);
});

test('CONTROL — an empty rule registry is caught directly, not merely passed over', async () => {
  // `MILESTONES.md` asks for this as its own control: "a direct assertion that
  // the rule registry is not empty, because an assertion evaluated over an
  // empty set passes forever and silently". Without it, a service that lost
  // its whole taxonomy would produce a perfectly green parity run.
  const report = await runConformance({
    ...baseline,
    drivers: driversWith(cliConformanceDriver),
    rules: { names: [] },
  });

  assert.ok(
    kinds(report.findings).includes('rule-registry-empty'),
    'an empty rule registry was not caught',
  );
});

test('CONTROL — an empty case table is caught directly', async () => {
  const report = await runConformance({
    ...baseline,
    drivers: driversWith(cliConformanceDriver),
    cases: [],
  });

  assert.ok(
    kinds(report.findings).includes('case-table-empty'),
    'an empty case table was not caught',
  );
  assert.equal(report.pairsRun, 0);
});

test('CONTROL — a route declining to expose anything does not pass vacuously', async () => {
  // The waiver rule's whole reason for existing, per `MILESTONES.md`:
  // "otherwise a driver that declines to expose anything passes the first
  // assertion vacuously". A route that offers nothing and waives nothing is
  // caught operation by operation.
  const offersNothing = driverOver({
    ...cliConformanceDriver.adapter,
    operations: [],
    waivers: [],
  });

  const report = await runConformance({ ...baseline, drivers: driversWith(offersNothing) });

  const missing = report.findings.filter(
    (entry) => entry.kind === 'operation-neither-offered-nor-waived',
  );
  // **Named, not counted.** `MILESTONES.md` records a hollow test that
  // "iterated a list rather than naming its entries, so deleting an entry
  // stayed green" — and a count has exactly that shape: drop an operation
  // from the list and drop the number, and this stays green while covering
  // one operation less. Comparing the sorted set of operation names against
  // `OPERATION_NAMES` fails on a deletion.
  for (const adapterId of ADAPTER_IDS) {
    assert.deepEqual(
      missing
        .filter((entry) => entry.adapter === adapterId)
        .map((entry) => entry.operation)
        .sort((a, b) => String(a).localeCompare(String(b))),
      [...OPERATION_NAMES].sort((a, b) => a.localeCompare(b)),
      `a route offering nothing was not caught for every operation on ${adapterId}`,
    );
  }
});

test('CONTROL — a WRITE route may not buy its way out with waivers', async () => {
  // The bound `MILESTONES.md` puts on waivers: "no operation any registered
  // rule can refuse may be waived by a route that exposes any write
  // operation. A route is read-only by declaration, or fully covered, with
  // nothing in between."
  const waivesAWrite = driverOver({
    ...cliConformanceDriver.adapter,
    operations: cliConformanceDriver.adapter.operations.filter(
      (operation) => operation !== 'navigate',
    ),
    waivers: [
      {
        operation: 'navigate',
        reason: 'this route would simply rather not implement navigation at all',
      },
    ],
  });

  const report = await runConformance({ ...baseline, drivers: driversWith(waivesAWrite) });

  const finding = report.findings.find((entry) => entry.kind === 'waiver-not-permitted');
  assert.ok(finding, 'a write route waived a write operation and was not caught');
  assert.equal(finding.operation, 'navigate');
  assert.match(finding.detail, /may not waive/u);
});

test('CONTROL — a waiver that says nothing is refused', async () => {
  const emptyWaiver = driverOver({
    ...cliConformanceDriver.adapter,
    readOnly: true,
    operations: cliConformanceDriver.adapter.operations.filter(
      (operation) => operation !== 'navigate',
    ),
    waivers: [{ operation: 'navigate', reason: 'no' }],
  });

  const report = await runConformance({ ...baseline, drivers: driversWith(emptyWaiver) });

  assert.ok(
    report.findings.some(
      (entry) =>
        entry.kind === 'waiver-not-permitted' && /does not give a reason/u.test(entry.detail),
    ),
    'a waiver with no reason was accepted',
  );
});
