import assert from 'node:assert/strict';
import test from 'node:test';

import type { SeamProperty } from '../../../src/browser/conformance/case.ts';
import { SEAM_PROPERTIES } from '../../../src/browser/conformance/cases.ts';
import {
  runSeamConformance,
  type SeamFinding,
  type SeamFindingKind,
} from '../../../src/browser/conformance/run.ts';
import { fakeSubject, type SeamSubject } from '../../../src/browser/conformance/subjects.ts';
import type { BrowserSession, TabHandle } from '../../../src/browser/driver.ts';

/**
 * The negative controls: **each asserted to fail.**
 *
 * `MILESTONES.md` names this requirement and says why it is not optional: "an
 * assertion nobody has watched fail is an assertion nobody has tested". A
 * suite that has only ever been green over correct input has never
 * demonstrated it can tell correct from incorrect, which is the only thing it
 * exists to do.
 *
 * ── The first control is the one that matters ───────────────────────────
 *
 * `re-introducing the keeper divergence` below puts back **the exact defect
 * that motivated this row** — a `listTabs` that includes the keeper tab — and
 * asserts the suite catches it. If that control did not fail, everything else
 * here would be decoration: a suite that does not catch the bug it was written
 * for has no claim on catching the next one.
 *
 * ── Every control asserts the mutation APPLIED ──────────────────────────
 *
 * Each control below checks that its own mutation actually took effect before
 * asserting the suite noticed it. That is not belt and braces: a mutation that
 * silently fails to apply produces a **green run that reads as a survived
 * mutation**, and two crews on this repository have already been fooled by
 * exactly that. So a control that cannot demonstrate its own mutation throws
 * rather than reporting a false survivor.
 */

function kinds(findings: readonly SeamFinding[]): SeamFindingKind[] {
  return findings.map((finding) => finding.kind);
}

/**
 * A subject wrapping the fake, with one member of the session replaced.
 *
 * The fake rather than the real driver, deliberately: a control has to run
 * **everywhere**, including on a hosted runner with no browser. A control that
 * skipped in continuous integration would leave the suite's ability to fail
 * unproven in precisely the environment where the suite is the only thing
 * watching.
 */
function fakeSubjectWith(
  bend: (session: BrowserSession) => BrowserSession,
  name = 'bent-fake',
): SeamSubject {
  return {
    name,
    unavailable: () => undefined,
    open: async (browser) => {
      const opened = await fakeSubject.open(browser);
      return { session: bend(opened.session), dispose: opened.dispose };
    },
  };
}

/** Run every real property against one bent subject. */
async function runAgainst(subject: SeamSubject) {
  return runSeamConformance({ subjects: [subject], properties: SEAM_PROPERTIES });
}

test('the suite is GREEN over the honest fake — the control every control below is measured against', async () => {
  const report = await runSeamConformance({
    subjects: [fakeSubject],
    properties: SEAM_PROPERTIES,
  });

  assert.deepEqual(report.findings, [], 'the honest fake produced findings');
  assert.equal(report.pairsRun, SEAM_PROPERTIES.length, 'not every property ran');
});

/**
 * ⚠️ **THE CONTROL THIS ROW EXISTS FOR.** ⚠️
 *
 * Re-introduces the original defect: a `listTabs` that includes the keeper
 * tab. This is the state `fake.ts` was in before row #21a corrected it, and
 * the state in which the fixture agreed with closing the keeper.
 */
test('CONTROL — re-introducing the keeper divergence in listTabs is caught', async () => {
  const bent = fakeSubjectWith((session) => {
    let keeper: TabHandle | undefined;
    return {
      ...session,
      ensureKeeperTab: async () => {
        keeper = await session.ensureKeeperTab();
        return keeper;
      },
      // The divergence, exactly: the keeper is put back into the list.
      listTabs: async () => {
        const listed = await session.listTabs();
        return keeper === undefined ? listed : [...listed, keeper];
      },
    };
  }, 'fake-that-lists-the-keeper');

  // ── The mutation is asserted to have APPLIED, before anything is claimed
  //    about the suite noticing it. ──
  //
  // A mutation that silently did nothing yields a green run that looks
  // identical to a survived mutation. So the bent session is driven directly
  // here and the keeper is confirmed present in its list; if it is not, this
  // throws rather than reporting a false result.
  const probe = await bent.open('private');
  try {
    const keeper = await probe.session.ensureKeeperTab();
    const listed = await probe.session.listTabs();
    assert.ok(
      listed.some((tab) => tab.driverTabId === keeper.driverTabId),
      'THE MUTATION DID NOT APPLY: the bent listTabs did not include the keeper, so this control proves nothing',
    );
  } finally {
    await probe.dispose();
  }

  const report = await runAgainst(bent);

  const finding = report.findings.find(
    (entry) =>
      entry.kind === 'property-violated' &&
      entry.property === 'the keeper tab is absent from listTabs',
  );
  assert.ok(finding, 'the keeper divergence was not caught');
  assert.equal(finding.rule, 'keeper.never_leased');
  assert.match(finding.detail, /reconciliation would treat it as an unowned page/u);
});

test('CONTROL — a listTabs that answers nothing at all is caught', async () => {
  // The vacuous companion to the control above, and a genuinely different
  // bug: an implementation whose list is always empty satisfies "the keeper is
  // not in the list" perfectly. Reconciliation would then find no page for any
  // recorded tab and mark every live lease's tab vanished.
  const bent = fakeSubjectWith(
    (session) => ({ ...session, listTabs: () => Promise.resolve([]) }),
    'fake-that-lists-nothing',
  );

  const probe = await bent.open('private');
  try {
    await probe.session.openTab();
    assert.deepEqual(
      await probe.session.listTabs(),
      [],
      'THE MUTATION DID NOT APPLY: the bent listTabs still returned tabs',
    );
  } finally {
    await probe.dispose();
  }

  const report = await runAgainst(bent);

  const finding = report.findings.find(
    (entry) =>
      entry.property ===
      'a leased tab IS in listTabs, so the exclusion is not simply an empty answer',
  );
  assert.ok(finding, 'an always-empty listTabs was not caught');
  assert.equal(finding.kind, 'property-violated');
});

test('CONTROL — a closeTab that can close the keeper is caught', async () => {
  // `keeper.never_leased` (§7.3): a caller cannot close what it cannot name.
  // The mutation makes the keeper's handle resolvable to a close.
  const bent = fakeSubjectWith((session) => {
    // The keeper this bent session presents, and how many have been
    // destroyed. The counter is what makes the replacement observably a
    // *different* tab: the underlying fake is idempotent, so re-establishing
    // after a close hands back the same identifier, and a mutation that
    // reported that would be indistinguishable from no mutation at all.
    let keeper: TabHandle | undefined;
    let destroyed = 0;
    return {
      ...session,
      ensureKeeperTab: async () => {
        if (keeper !== undefined) return keeper;
        const established = await session.ensureKeeperTab();
        keeper = {
          ...established,
          driverTabId: `${established.driverTabId}-replacement-${String(destroyed)}`,
        };
        return keeper;
      },
      closeTab: async (tab: TabHandle) => {
        if (keeper !== undefined && tab.driverTabId === keeper.driverTabId) {
          // The destructive act: the keeper is gone, and the next call to
          // establish it opens a different one — which is what a real headed
          // browser would not survive long enough to do.
          destroyed += 1;
          keeper = undefined;
          return;
        }
        await session.closeTab(tab);
      },
    };
  }, 'fake-whose-keeper-can-be-closed');

  const probe = await bent.open('private');
  try {
    const first = await probe.session.ensureKeeperTab();
    await probe.session.closeTab(first);
    const second = await probe.session.ensureKeeperTab();
    assert.notEqual(
      first.driverTabId,
      second.driverTabId,
      'THE MUTATION DID NOT APPLY: the keeper survived the close, so this control proves nothing',
    );
  } finally {
    await probe.dispose();
  }

  const report = await runAgainst(bent);

  const finding = report.findings.find(
    (entry) => entry.property === 'the keeper tab survives being named to closeTab',
  );
  assert.ok(finding, 'a closeTab that closes the keeper was not caught');
  assert.equal(finding.rule, 'keeper.never_leased');
});

test('CONTROL — a non-idempotent ensureKeeperTab is caught', async () => {
  // `keeper.present` (§7.2) is checked on every spawn, and this service is
  // spawned per caller — so this mutation accumulates one uncounted page per
  // spawn, invisible to reconciliation because listTabs excludes them all.
  const bent = fakeSubjectWith(
    (session) => ({
      ...session,
      ensureKeeperTab: () => session.openTab(),
    }),
    'fake-that-opens-a-keeper-every-time',
  );

  const probe = await bent.open('private');
  try {
    const first = await probe.session.ensureKeeperTab();
    const second = await probe.session.ensureKeeperTab();
    assert.notEqual(
      first.driverTabId,
      second.driverTabId,
      'THE MUTATION DID NOT APPLY: ensureKeeperTab was still idempotent',
    );
  } finally {
    await probe.dispose();
  }

  const report = await runAgainst(bent);

  const finding = report.findings.find(
    (entry) => entry.property === 'establishing the keeper twice yields one keeper, not two',
  );
  assert.ok(finding, 'a non-idempotent ensureKeeperTab was not caught');
  assert.equal(finding.rule, 'keeper.present');
});

test('CONTROL — a handle naming the wrong browser is caught', async () => {
  const bent = fakeSubjectWith(
    (session) => ({
      ...session,
      // Capacity is one total across both browsers, and the store indexes a
      // physical tab by (browser_id, driver_tab_id) — so this writes rows
      // against the wrong browser.
      openTab: async () => ({ ...(await session.openTab()), browser: 'regular' as const }),
    }),
    'fake-that-mislabels-the-browser',
  );

  const probe = await bent.open('private');
  try {
    const tab = await probe.session.openTab();
    assert.equal(
      tab.browser,
      'regular',
      'THE MUTATION DID NOT APPLY: the handle still named the session’s own browser',
    );
    assert.equal(probe.session.describe().browser, 'private');
  } finally {
    await probe.dispose();
  }

  const report = await runAgainst(bent);

  const finding = report.findings.find(
    (entry) => entry.property === 'a tab handle names the browser it belongs to',
  );
  assert.ok(finding, 'a handle naming the wrong browser was not caught');
});

test('CONTROL — a cookie summary that carries a value is caught', async () => {
  // `read.cookies_no_values` (§7.1) is a shape, not a refusal. The service
  // writes this structure to a file verbatim, so a value field here is cookie
  // values on disk with no line of code saying so.
  const bent = fakeSubjectWith(
    (session) => ({
      ...session,
      cookies: async (tab: TabHandle) =>
        (await session.cookies(tab)).map((summary) => ({
          ...summary,
          value: 'a-secret-that-should-never-be-here',
        })),
    }),
    'fake-whose-cookies-carry-values',
  );

  const probe = await bent.open('private');
  try {
    const tab = await probe.session.openTab();
    const summaries = await probe.session.cookies(tab);
    assert.ok(summaries.length > 0, 'THE MUTATION DID NOT APPLY: there were no cookies to bend');
    assert.ok(
      summaries.every((summary) => Object.keys(summary).includes('value')),
      'THE MUTATION DID NOT APPLY: no value field was added',
    );
  } finally {
    await probe.dispose();
  }

  const report = await runAgainst(bent);

  const finding = report.findings.find(
    (entry) => entry.property === 'a cookie summary carries no value, on any implementation',
  );
  assert.ok(finding, 'a cookie summary carrying a value was not caught');
  assert.equal(finding.rule, 'read.cookies_no_values');
});

test('CONTROL — a property that throws is reported as its own kind, not as a violation', async () => {
  // A property that crashes and a property that refuses are different facts,
  // and collapsing them would let a broken property masquerade as a caught
  // defect — or, worse, let a crash in the harness read as the suite working.
  const throws: SeamProperty = {
    name: 'a property that throws',
    rule: 'keeper.never_leased',
    why: 'a control that exists only to make the runner distinguish a crash from a refusal, which are different facts',
    check: () => {
      throw new Error('this property is broken');
    },
  };

  const report = await runSeamConformance({
    subjects: [fakeSubject],
    properties: [throws],
  });

  assert.ok(
    kinds(report.findings).includes('property-threw'),
    'a throwing property was not caught',
  );
  assert.equal(
    kinds(report.findings).includes('property-violated'),
    false,
    'a throwing property was reported as a violation, which hides the difference',
  );
});

test('CONTROL — an unargued property is refused', async () => {
  // The bar `cases.ts` sets: every property is argued. This is what stops the
  // mechanical entries the header warns about from arriving unnoticed.
  const unargued: SeamProperty = {
    name: 'a property with nothing to say for itself',
    rule: 'keeper.never_leased',
    why: 'because',
    check: () => Promise.resolve(undefined),
  };

  const report = await runSeamConformance({ subjects: [fakeSubject], properties: [unargued] });

  const finding = report.findings.find((entry) => entry.kind === 'property-unjustified');
  assert.ok(finding, 'a property with no argument was accepted');
  assert.equal(finding.property, 'a property with nothing to say for itself');
});

test('CONTROL — an empty property table is caught directly, not merely passed over', async () => {
  // An assertion evaluated over an empty set passes forever and silently,
  // which `MILESTONES.md` names by name. Without this, deleting every property
  // would produce a perfectly green run.
  const report = await runSeamConformance({ subjects: [fakeSubject], properties: [] });

  assert.ok(
    kinds(report.findings).includes('property-table-empty'),
    'an empty table was not caught',
  );
  assert.equal(report.pairsRun, 0);
});

test('CONTROL — a run in which every subject skipped is caught rather than passing green', async () => {
  // **The control for this suite's own headline limit.** The real subject
  // skips wherever there is no browser, and a run in which *everything*
  // skipped is a run that proved nothing — which must not be spelled the same
  // way as a run in which everything passed.
  const neverAvailable: SeamSubject = {
    name: 'a subject that cannot run here',
    unavailable: () => 'SKIPPED: this control subject never runs, by construction',
    open: () => {
      throw new Error('this subject must never be opened');
    },
  };

  const report = await runSeamConformance({
    subjects: [neverAvailable],
    properties: SEAM_PROPERTIES,
  });

  assert.ok(
    kinds(report.findings).includes('no-subject-ran'),
    'a run with no subject at all was reported as green',
  );
  assert.equal(report.pairsRun, 0);
  assert.deepEqual(
    report.skipped.map((entry) => entry.subject),
    ['a subject that cannot run here'],
    'the skip was not reported with the subject that skipped',
  );
});

test('CONTROL — two properties sharing a name are caught, so a finding is always attributable', async () => {
  const duplicated: SeamProperty = {
    name: 'the same name twice',
    rule: 'keeper.never_leased',
    why: 'a control proving the runner refuses an ambiguous name rather than attributing a finding to the wrong property',
    check: () => Promise.resolve(undefined),
  };

  const report = await runSeamConformance({
    subjects: [fakeSubject],
    properties: [duplicated, { ...duplicated }],
  });

  assert.ok(
    kinds(report.findings).includes('property-name-duplicated'),
    'two properties with one name were accepted',
  );
});
