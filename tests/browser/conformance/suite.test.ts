import assert from 'node:assert/strict';
import test from 'node:test';

import { SEAM_PROPERTIES } from '../../../src/browser/conformance/cases.ts';
import { runSeamConformance } from '../../../src/browser/conformance/run.ts';
import { fakeSubject } from '../../../src/browser/conformance/subjects.ts';
import { realSubject } from './real-subject.ts';

/**
 * The driver-seam conformance suite: every property, against both
 * implementations.
 *
 * ── What this proves, stated before anything else ───────────────────────
 *
 * **On a machine with a browser** — every property in `cases.ts` holds of the
 * fake *and* of the real driver, asked in the same words through the same
 * interface.
 *
 * **In continuous integration** — every property holds of the fake, and the
 * real subject is **skipped with its reason printed**. Hosted runners have no
 * browser and no display. So a green pipeline here is evidence about the fake
 * and is *not* evidence about the real driver.
 *
 * That limit is not a defect of this suite; it is the environment the defect
 * that motivated the suite hid in, and pretending otherwise would reproduce
 * it. What the suite does instead is refuse to be silent about it: the runner
 * reports which subjects ran, the test below **asserts a subject actually
 * ran**, and the skip reason is printed on every run.
 *
 * ── Why this is not simply more tests in `fake.test.ts` ─────────────────
 *
 * `fake.test.ts` asserts things about the fake, and `real-driver.test.ts`
 * asserts things about the real driver. Both were fully green while the two
 * disagreed about the keeper tab, because **neither of them is a claim about
 * agreement** — a property asserted of one implementation in one file and not
 * of the other in the other file is exactly how the divergence survived.
 *
 * A property here is written once and is *structurally unable* to be asked of
 * only one implementation: the runner takes the cross product, and the
 * property's only parameter is a `BrowserSession`, so there is no lever a
 * property could reach for that exists on one side and not the other.
 */

const SUBJECTS = [fakeSubject, realSubject];

test('every seam property holds on every implementation available here', async () => {
  const report = await runSeamConformance({ subjects: SUBJECTS, properties: SEAM_PROPERTIES });

  // Printed rather than swallowed. The whole failure this suite exists to
  // prevent is a green result that proves less than it appears to, and a
  // subject that did not run is precisely that.
  for (const skip of report.skipped) {
    console.log(`  seam conformance: subject "${skip.subject}" did not run — ${skip.reason}`);
  }
  console.log(
    `  seam conformance: ${String(report.pairsRun)} property-and-implementation pairs ran across [${report.subjectsRun.join(', ')}]`,
  );

  assert.deepEqual(
    report.findings,
    [],
    `the driver seam conformance suite reported findings:\n${report.findings
      .map(
        (finding) =>
          `  [${finding.kind}] ${finding.subject ?? '-'} / ${finding.property ?? '-'}: ${finding.detail}`,
      )
      .join('\n')}`,
  );
});

test('the matrix is not empty — a green run over nothing is the failure this suite is about', async () => {
  const report = await runSeamConformance({ subjects: SUBJECTS, properties: SEAM_PROPERTIES });

  // Computed independently and compared, rather than read back from the report
  // that would also be empty. The adapter suite next door makes the same move
  // for the same reason.
  const expected = report.subjectsRun.length * SEAM_PROPERTIES.length;

  assert.ok(SEAM_PROPERTIES.length > 0, 'there are no properties at all');
  assert.ok(report.subjectsRun.length > 0, 'no implementation ran, so the run proves nothing');
  assert.equal(
    report.pairsRun,
    expected,
    'not every property ran on every available implementation',
  );
});

/**
 * The fake is never allowed to be the only subject that ran **on a machine
 * that could have run both**.
 *
 * ── Why this is its own test, and its exact limit ───────────────────────
 *
 * A suite that only ever exercises the fake would be a fresh instance of the
 * very defect this row exists to close: a fixture agreeing with itself. This
 * asserts that when a browser *is* available, the real subject genuinely ran
 * — so a change that quietly broke the real subject's construction, or
 * excluded it from the list, fails here rather than passing as a skip.
 *
 * **On a runner with no browser this test is itself skipped**, and it says so.
 * It cannot be otherwise: there is no browser to run. That is the honest
 * boundary — this test converts "the real subject silently stopped running"
 * into a failure everywhere it is possible to detect it, and nowhere else.
 */
test('on a machine with a browser, the real driver is genuinely one of the subjects', async (t) => {
  const reason = realSubject.unavailable();
  if (reason !== undefined) {
    t.skip(reason);
    return;
  }

  const report = await runSeamConformance({ subjects: SUBJECTS, properties: SEAM_PROPERTIES });

  assert.ok(
    report.subjectsRun.includes('real'),
    `a browser is available here, but the real driver was not among the subjects that ran: [${report.subjectsRun.join(', ')}]`,
  );
  // Both, not either. The suite's whole claim is agreement between two
  // implementations, and one of them running is not agreement.
  assert.ok(
    report.subjectsRun.includes('fake'),
    `the fake was not among the subjects that ran: [${report.subjectsRun.join(', ')}]`,
  );
});

test('every property names a rule and argues for itself', () => {
  // The bar `cases.ts` sets. Checked here as well as in the runner because the
  // runner's version only fires for properties that are actually run, and a
  // property added to the table while every subject is skipped would otherwise
  // reach the tree unargued.
  for (const property of SEAM_PROPERTIES) {
    assert.ok(property.rule.length > 0, `"${property.name}" names no rule`);
    assert.ok(
      property.why.trim().split(/\s+/u).length >= 12,
      `"${property.name}" gives no argument for why the service reasons about it`,
    );
  }
});

test('property names are unique, so a failure can be attributed', () => {
  const names = SEAM_PROPERTIES.map((property) => property.name);
  assert.equal(new Set(names).size, names.length, 'two properties share a name');
});
