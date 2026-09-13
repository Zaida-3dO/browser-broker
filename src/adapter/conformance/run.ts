import { isDeepStrictEqual } from 'node:util';

import { ADAPTER_IDS, type AdapterId } from '../contract.ts';
import { isWriteOperation, OPERATION_NAMES, type OperationName } from '../operations.ts';
import type { BrokerService, OperationOutcome, RuleRegistry } from '../service-seam.ts';
import type { ConformanceCase, ObservedDriverCall } from './case.ts';
import type { ConformanceDrivers } from './driver.ts';

/**
 * Structural comparison for effect assertions.
 *
 * `isDeepStrictEqual` rather than `===`, because an effect may name a
 * structured field, and rather than `assert.deepStrictEqual`, because this
 * runner reports findings instead of throwing (see the header).
 */
const deepEqual = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);

/**
 * The conformance run: every assertion `SCHEMA.md` §8 lists, over the cross
 * product of the case table and the mounted routes.
 *
 * ── Why this returns findings instead of throwing ───────────────────────
 *
 * `MILESTONES.md` requires **negative controls, each asserted to fail**,
 * "because an assertion nobody has watched fail is an assertion nobody has
 * tested". A runner that threw on the first problem could only be tested by
 * catching an exception and hoping it was the right one; a runner that
 * returns every finding lets a control assert *which* assertion fired, which
 * is the difference between proving a control works and proving that
 * something merely went wrong.
 *
 * The test that runs the real suite fails on any finding. The controls assert
 * a specific finding is present. Same runner, one behaviour.
 */

/** Which assertion produced a finding. Named so a control can assert on it. */
export type FindingKind =
  /** §8.1 — the same acceptance, or the same refusal code and rule name. */
  | 'outcome-mismatch'
  /** §8.2 — a refusal that opened something. */
  | 'refusal-touched-the-browser'
  /** §8.2 — a refusal that moved the claim count. */
  | 'refusal-moved-the-claim-count'
  /** §8.3 — an operation with no accepting case, or no refusing case. */
  | 'operation-without-both-cases'
  /** §8.4 — a rule in the registry that no refusal in this run produced. */
  | 'rule-without-a-case'
  /** §8.5 — a route offering an operation the registry does not know. */
  | 'unknown-operation-offered'
  /** §8.5 — an operation neither offered nor waived. */
  | 'operation-neither-offered-nor-waived'
  /** A waiver that says nothing, or one a write route is not allowed. */
  | 'waiver-not-permitted'
  /** The rule registry is empty, so every rule assertion passes vacuously. */
  | 'rule-registry-empty'
  /** The case table has no cases, so the matrix is empty. */
  | 'case-table-empty'
  /**
   * An accepted value omitted a field the case named — the response-conformance
   * failure. §3.11 promised `sourceWidth`, `sourceHeight` and `tier` and the
   * shipped response carried none of them, because nothing compared a response
   * against its own specification.
   */
  | 'accepted-value-missing-a-field'
  /**
   * A declared argument did not change what came back — the inert-argument
   * failure, one layer below where the static reachability check can see. The
   * argument was read; the result is the same as if it had not been.
   */
  | 'argument-had-no-effect'
  /**
   * The without-argument baseline could not be taken, so the effect assertion
   * would have been vacuous. Raised rather than skipped: a silently-skipped
   * effect is indistinguishable from a passing one.
   */
  | 'argument-effect-baseline-failed';

export interface Finding {
  readonly kind: FindingKind;
  readonly adapter?: AdapterId;
  readonly operation?: OperationName;
  readonly caseName?: string;
  readonly detail: string;
}

/** One isolated service under test, with the two physical readings. */
export interface ConformanceSubject {
  readonly service: BrokerService;
  readonly driverCalls: () => readonly ObservedDriverCall[];
  readonly liveClaimCount: () => number;
  readonly dispose?: () => Promise<void> | void;
}

export interface ConformanceRunOptions {
  readonly drivers: ConformanceDrivers;
  readonly cases: readonly ConformanceCase[];
  readonly rules: RuleRegistry;
  /** A fresh service and its observations, built per case-and-route pair. */
  readonly makeService: () => Promise<ConformanceSubject> | ConformanceSubject;
}

export interface ConformanceReport {
  readonly findings: readonly Finding[];
  /** How many case-and-route pairs actually ran. Zero is itself a finding. */
  readonly pairsRun: number;
  /** Every rule name a refusal in this run actually produced. */
  readonly rulesObserved: readonly string[];
}

/** Roughly four words, the same bar the hygiene gate holds a waiver to. */
const WAIVER_MINIMUM_WORDS = 4;

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') {
    return 0;
  }
  return trimmed.split(/\s+/u).length;
}

/**
 * Run the suite.
 *
 * Every route in {@link ADAPTER_IDS} is visited — the list comes from the
 * registry the application mounts through, so a mounted route cannot be
 * skipped by this file not mentioning it.
 */
export async function runConformance(options: ConformanceRunOptions): Promise<ConformanceReport> {
  const findings: Finding[] = [];
  const rulesObserved = new Set<string>();
  let pairsRun = 0;

  // An assertion evaluated over an empty set passes forever and silently
  // (`MILESTONES.md`), so both sets are checked directly rather than only
  // being iterated.
  if (options.rules.names.length === 0) {
    findings.push({
      kind: 'rule-registry-empty',
      detail: 'the rule registry is empty, so every per-rule assertion would pass vacuously',
    });
  }
  if (options.cases.length === 0) {
    findings.push({
      kind: 'case-table-empty',
      detail: 'the case table is empty, so the conformance matrix would be empty',
    });
  }

  const knownOperations = new Set<string>(OPERATION_NAMES);

  for (const adapterId of ADAPTER_IDS) {
    const driver = options.drivers[adapterId];
    const { adapter } = driver;

    const offered = new Set<OperationName>();
    for (const operation of adapter.operations) {
      if (!knownOperations.has(operation)) {
        findings.push({
          kind: 'unknown-operation-offered',
          adapter: adapterId,
          detail: `offers "${String(operation)}", which is not an operation this service has`,
        });
        continue;
      }
      offered.add(operation);
    }

    const waived = new Set<OperationName>();
    for (const waiver of adapter.waivers) {
      // A waiver has to say something. An empty one silences the assertion
      // without leaving anything in the diff for a reviewer to disagree with.
      if (wordCount(waiver.reason) < WAIVER_MINIMUM_WORDS) {
        findings.push({
          kind: 'waiver-not-permitted',
          adapter: adapterId,
          operation: waiver.operation,
          detail: 'the waiver does not give a reason',
        });
        continue;
      }
      // `MILESTONES.md`: no operation any registered rule can refuse may be
      // waived by a route that exposes any write operation. A route is
      // read-only by declaration, or fully covered, with nothing in between —
      // otherwise a driver that declines to expose anything passes the first
      // assertion vacuously.
      if (!adapter.readOnly && isWriteOperation(waiver.operation)) {
        findings.push({
          kind: 'waiver-not-permitted',
          adapter: adapterId,
          operation: waiver.operation,
          detail:
            'a route exposing a write operation may not waive one; declare the route read-only, or cover it',
        });
        continue;
      }
      waived.add(waiver.operation);
    }

    for (const operation of OPERATION_NAMES) {
      if (!offered.has(operation) && !waived.has(operation)) {
        findings.push({
          kind: 'operation-neither-offered-nor-waived',
          adapter: adapterId,
          operation,
          detail: 'neither offered nor carrying a written waiver',
        });
      }
    }

    for (const testCase of options.cases) {
      if (!offered.has(testCase.operation)) {
        continue;
      }

      const subject = await options.makeService();
      try {
        // What the seed established, merged over the case's own input. See
        // `CaseSeed.apply` for why some of it can only be known here.
        const substitutions = (await testCase.seed?.apply(subject.service)) ?? {};
        const seeded: ConformanceCase = {
          ...testCase,
          input: { ...testCase.input, ...substitutions },
        };

        // **Read after the seed, not before it.** A seed that mints a lease
        // moves the claim count, and a baseline taken before it would make
        // every keyed case look as though the operation itself had moved the
        // count — turning assertion 2 into a test of the fixture.
        const claimsBefore = subject.liveClaimCount();
        const callsBefore = subject.driverCalls().length;

        const observation = await driver.run(subject.service, seeded, {
          driverCalls: subject.driverCalls,
          liveClaimCount: subject.liveClaimCount,
        });
        pairsRun += 1;

        const { outcome } = observation;
        if (outcome.outcome === 'refused') {
          rulesObserved.add(outcome.rule);
        }

        if (testCase.expect.outcome !== outcome.outcome) {
          findings.push({
            kind: 'outcome-mismatch',
            adapter: adapterId,
            operation: testCase.operation,
            caseName: testCase.name,
            // **The refusal's own code and rule are carried**, not just the
            // fact that the outcomes differed. `MILESTONES.md` #72 is the
            // reason: an intermittent failure here read only "expected
            // accepted, got refused", which names no rule and so gives a
            // reader nothing to attribute it to — two separate
            // investigations reproduced it and still could not say which
            // guard had fired. The rule name was the whole diagnosis, and it
            // was being discarded one line before it could be reported.
            detail:
              outcome.outcome === 'refused'
                ? `expected ${testCase.expect.outcome}, got ${outcome.outcome} (${outcome.code} / ${outcome.rule})`
                : `expected ${testCase.expect.outcome}, got ${outcome.outcome}`,
          });
        } else if (testCase.expect.outcome === 'refused' && outcome.outcome === 'refused') {
          // The code and the rule are compared; the sentence never is
          // (`SCHEMA.md` §3.14) — asserting text is brittle and a weaker
          // claim than asserting the code.
          if (outcome.code !== testCase.expect.code || outcome.rule !== testCase.expect.rule) {
            findings.push({
              kind: 'outcome-mismatch',
              adapter: adapterId,
              operation: testCase.operation,
              caseName: testCase.name,
              detail: `expected ${testCase.expect.code} / ${testCase.expect.rule}, got ${outcome.code} / ${outcome.rule}`,
            });
          }
        }

        // ── Response conformance and argument effect ──────────────────────
        //
        // Both are assertions about the **accepted value**, which is why they
        // sit together and why they are checked here rather than in a unit
        // test: the value has crossed the route boundary by this point, so a
        // field the service produced and the adapter dropped fails here and
        // passes everywhere else.
        if (outcome.outcome === 'accepted' && testCase.expect.outcome === 'accepted') {
          for (const field of testCase.expect.valueFields ?? []) {
            if (outcome.value[field] === undefined) {
              findings.push({
                kind: 'accepted-value-missing-a-field',
                adapter: adapterId,
                operation: testCase.operation,
                caseName: testCase.name,
                detail: `the accepted value has no "${field}" (it carries ${Object.keys(outcome.value).join(', ') || 'nothing'})`,
              });
            }
          }

          for (const effect of testCase.expect.effects ?? []) {
            // The same operation, driven again with the effect's arguments
            // removed. A fresh subject, because the first run consumed a lease
            // and moved the capture count — reusing it would measure the
            // second call's accounting rather than the argument.
            const baselineInput = Object.fromEntries(
              Object.entries(seeded.input).filter(([key]) => !effect.arguments.includes(key)),
            );
            const baselineSubject = await options.makeService();
            let baseline: OperationOutcome | undefined;
            try {
              const baselineSubstitutions =
                (await testCase.seed?.apply(baselineSubject.service)) ?? {};
              const baselineCase: ConformanceCase = {
                ...testCase,
                name: `${testCase.name} (without ${effect.arguments.join(', ')})`,
                input: { ...baselineInput, ...baselineSubstitutions },
              };
              baseline = (
                await driver.run(baselineSubject.service, baselineCase, {
                  driverCalls: baselineSubject.driverCalls,
                  liveClaimCount: baselineSubject.liveClaimCount,
                })
              ).outcome;
            } finally {
              await baselineSubject.dispose?.();
            }

            if (baseline.outcome !== 'accepted') {
              // Never silently skipped. An effect whose baseline refused would
              // otherwise report the same green as one that held.
              findings.push({
                kind: 'argument-effect-baseline-failed',
                adapter: adapterId,
                operation: testCase.operation,
                caseName: testCase.name,
                detail: `dropping ${effect.arguments.join(', ')} was refused (${baseline.code} / ${baseline.rule}), so the effect of those arguments could not be measured`,
              });
              continue;
            }

            for (const expectation of effect.expect) {
              const actual = outcome.value[expectation.field];
              const without = baseline.value[expectation.field];

              if (!deepEqual(actual, expectation.value)) {
                findings.push({
                  kind: 'argument-had-no-effect',
                  adapter: adapterId,
                  operation: testCase.operation,
                  caseName: testCase.name,
                  detail: `with ${effect.arguments.join(', ')}, "${expectation.field}" should be ${JSON.stringify(expectation.value)} but was ${JSON.stringify(actual)}`,
                });
                continue;
              }

              if (!deepEqual(without, expectation.withoutArgument)) {
                findings.push({
                  kind: 'argument-had-no-effect',
                  adapter: adapterId,
                  operation: testCase.operation,
                  caseName: testCase.name,
                  detail: `without ${effect.arguments.join(', ')}, "${expectation.field}" should be ${JSON.stringify(expectation.withoutArgument)} but was ${JSON.stringify(without)}`,
                });
                continue;
              }

              // The guard against a constant. Both readings can be individually
              // right and the argument still inert — if the two agree, passing
              // the argument changed nothing, whatever the field happens to
              // hold. This is the assertion the whole shape exists for.
              if (deepEqual(actual, without)) {
                findings.push({
                  kind: 'argument-had-no-effect',
                  adapter: adapterId,
                  operation: testCase.operation,
                  caseName: testCase.name,
                  detail: `"${expectation.field}" is ${JSON.stringify(actual)} whether or not ${effect.arguments.join(', ')} is passed, so the argument is inert`,
                });
              }
            }
          }
        }

        if (outcome.outcome === 'refused') {
          // Both readings, because they catch different bugs (§8.2): a guard
          // that opens a tab and closes it on the way to refusing leaves the
          // count unchanged and the log full; a guard that decrements a
          // counter without telling the browser leaves the log empty and the
          // count wrong.
          const callsDuring = observation.driverCalls.slice(callsBefore);
          if (callsDuring.length > 0) {
            findings.push({
              kind: 'refusal-touched-the-browser',
              adapter: adapterId,
              operation: testCase.operation,
              caseName: testCase.name,
              detail: `a refusal asked the browser to ${callsDuring.map((call) => call.name).join(', ')}`,
            });
          }
          if (observation.liveClaimCount !== claimsBefore) {
            findings.push({
              kind: 'refusal-moved-the-claim-count',
              adapter: adapterId,
              operation: testCase.operation,
              caseName: testCase.name,
              detail: `a refusal moved the live claim count from ${String(claimsBefore)} to ${String(observation.liveClaimCount)}`,
            });
          }
        }
      } finally {
        await subject.dispose?.();
      }
    }
  }

  // §8.3 — every operation some route offers has both a case that succeeds
  // and a case that is refused. Computed over the operations actually
  // offered, so an operation no route has reached yet is not a failing
  // assertion about work nobody has done.
  const offeredAnywhere = new Set<OperationName>();
  for (const adapterId of ADAPTER_IDS) {
    for (const operation of options.drivers[adapterId].adapter.operations) {
      offeredAnywhere.add(operation);
    }
  }
  for (const operation of OPERATION_NAMES) {
    if (!offeredAnywhere.has(operation)) {
      continue;
    }
    const forOperation = options.cases.filter((testCase) => testCase.operation === operation);
    const accepts = forOperation.some((testCase) => testCase.expect.outcome === 'accepted');
    const refuses = forOperation.some((testCase) => testCase.expect.outcome === 'refused');
    if (!accepts || !refuses) {
      findings.push({
        kind: 'operation-without-both-cases',
        operation,
        detail: accepts ? 'has no case that is refused' : 'has no case that succeeds',
      });
    }
  }

  // §8.4 — every rule appears in at least one refusal **the service actually
  // produced**, computed from what came back rather than from what a case
  // declared. A case naming a rule the service never returned does not
  // satisfy this, which is what keeps the suite honest a year from now.
  for (const rule of options.rules.names) {
    if (!rulesObserved.has(rule)) {
      findings.push({
        kind: 'rule-without-a-case',
        detail: `rule "${rule}" was never produced by a refusal in this run`,
      });
    }
  }

  return { findings, pairsRun, rulesObserved: [...rulesObserved].sort() };
}
