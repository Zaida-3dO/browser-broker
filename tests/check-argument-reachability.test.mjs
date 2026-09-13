/**
 * The self-test for the argument-reachability check.
 *
 * **What a green run here means, and what it does not.** Green means the check
 * can fail: pointed at the historical defect — `wait_ms` declared on the tool
 * surface and read nowhere — it reports it. Green does **not** mean the tree
 * is free of inert arguments; that claim is made by running the
 * check itself, which `npm run check` does.
 *
 * The distinction is the reason this file exists, and it is sharper here than
 * for most gates. This check's whole subject is *a declaration that nothing
 * consumes*, and a check nobody has ever seen fail is itself a declaration
 * that nothing consumes: "it passes" is equally consistent with "it cannot
 * fail". A reachability check that has only run against a clean tree has
 * exactly the property it exists to forbid.
 *
 * That is not hypothetical for this particular check — two drafts of it were
 * broken in ways only a seeded failure could reveal, and both are pinned by
 * tests below:
 *
 * 1. The configuration half read the declaration table's own `key:` field as
 *    though it were an assembled record field. `key` occurs in nearly every
 *    source in the tree, so **every variable found a reader and the whole half
 *    reported green vacuously** — including the inert variable it was written
 *    to catch.
 * 2. It then reported the two browser-name lists as unread, because they are
 *    assembled through a local binding rather than an inline field. Both are
 *    read throughout the service. **A gate that cries wolf gets switched off**,
 *    so a false failure on a real setting costs more than the defect it hunts.
 *
 * The first is why `passes vacuously` is tested for directly rather than
 * inferred from the check being green.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  BRIDGE_SOURCE,
  TOOLS_SOURCE,
  WAIVERS,
  bridgeReadsByOperation,
  checkArguments,
  checkConfiguration,
  declaredToolArguments,
  environmentFieldsFor,
  runReachabilityCheck,
  seededDefect,
  stripCommentsAndStrings,
  ENVIRONMENT_SOURCE,
} from '../scripts/check-argument-reachability.mjs';

describe('the reachability check detects the defect it exists to detect', () => {
  it('goes red on the historical inert `wait_ms`', () => {
    // Seeded against a **copy** of the sources rather than by damaging the
    // working tree: a test that edited the application to prove a gate fires
    // would have to put it back, and a failure midway through would leave the
    // repository broken.
    const result = checkArguments(seededDefect());
    assert.ok(
      result.failures.some((failure) => failure.includes('wait_ms')),
      'the seeded inert `wait_ms` was not reported',
    );
  });

  it('names the tool and the operation, so the failure says where to look', () => {
    const result = checkArguments(seededDefect());
    const failure = result.failures.find((entry) => entry.includes('wait_ms'));
    assert.match(failure, /browser_navigate/u);
    assert.match(failure, /case 'navigate'/u);
  });

  it('refuses to run a seed that fails to reproduce the defect', () => {
    // The seed removes a specific line from the bridge. If that line is
    // reworded, the removal silently stops happening and the self-test starts
    // proving nothing while still reporting success — the exact failure this
    // whole file exists to prevent, one level up. So the seed throws instead.
    const bridge = readFileSync(BRIDGE_SOURCE, 'utf8');
    assert.match(
      bridge,
      /waitMs:\s*asInteger\(argument\(args,\s*'wait_ms',\s*'waitMs'\)\)/u,
      'the seed cannot find the read it removes — update `seededDefect`, do not delete this test',
    );
  });
});

describe('the check is green on the current tree', () => {
  it('reports no failures', () => {
    const result = runReachabilityCheck();
    assert.deepEqual(
      result.failures,
      [],
      `the tree has a declared argument or variable nothing reads:\n${result.failures.join('\n')}`,
    );
  });

  it('actually checked something, rather than finding nothing to check', () => {
    // A parser that silently matched no declarations would report zero
    // failures and look identical to a clean tree. The counts are asserted
    // against a floor rather than an exact number so that adding a tool does
    // not fail this test for the wrong reason.
    const result = runReachabilityCheck();
    assert.ok(
      result.checkedArguments >= 30,
      `only ${String(result.checkedArguments)} arguments were parsed, so the surface is not being read`,
    );
    assert.ok(
      result.checkedVariables >= 9,
      `only ${String(result.checkedVariables)} variables were parsed`,
    );
  });
});

describe('the rule is satisfied by reaching the operation, not by appearing somewhere', () => {
  it('attributes a read to the operation whose branch it sits in', () => {
    // The weak version of this check — "the identifier appears in the sources"
    // — is satisfied by a declaration alone. This asserts the strong version
    // is what runs: a name read under one operation does not satisfy another.
    const reads = bridgeReadsByOperation();
    assert.ok(reads.get('capture').has('compare_to'));
    assert.ok(
      !reads.get('navigate').has('compare_to'),
      '`compare_to` must not count as read for `navigate`, or attribution is not happening',
    );
  });

  it('follows a helper that is handed the whole argument record', () => {
    // `lease_key` is read by `keyFrom`, never inline in a branch. This is the
    // mechanism that lets the rule need no waiver for surface-consumed
    // arguments: they are read like everything else, one call deeper.
    const reads = bridgeReadsByOperation();
    assert.ok(
      reads.get('status').has('lease_key'),
      '`lease_key` is read by `keyFrom`; if this fails, helper following has broken and every keyed tool will fail spuriously',
    );
  });

  it('follows a helper that another helper calls', () => {
    // `actionFrom` calls `viewportFrom`, which is where `width` is read. One
    // pass would miss the second hop and fail a real argument.
    const reads = bridgeReadsByOperation();
    assert.ok(
      reads.get('act').has('width'),
      'transitive helper resolution is not reaching depth 2',
    );
  });

  it('does not count a name that appears only in a comment', () => {
    // `bridge.ts` discusses arguments in prose beside the code that reads
    // them, and this file names `wait_ms` repeatedly. A scan counting a
    // mention would be satisfiable by writing a sentence about an argument —
    // which is close to the defect itself, since `wait_ms` was documented
    // generously and read never.
    const stripped = stripCommentsAndStrings('const a = 1; // wait_ms\n/* reason */');
    assert.ok(!stripped.includes('wait_ms'));
    assert.ok(!stripped.includes('reason'));
  });

  it('does not count a read that has been commented out', () => {
    // The property above, asserted where it has to hold rather than on the
    // helper alone. A stripper that works while the reader it is meant to
    // protect scans raw text is the hollow shape this whole check exists to
    // catch, one level up — and commenting a line out is how a read dies in
    // a refactor nobody finished, leaving the declaration, the prose and the
    // branch around it all intact.
    const source = `
      switch (operation) {
        case 'navigate': {
          return broker.navigate({
            url: argument(args, 'url'),
            // waitMs: asInteger(argument(args, 'wait_ms', 'waitMs')),
          });
        }
      }
    `;
    const reads = bridgeReadsByOperation(source);
    assert.ok(reads.get('navigate').has('url'), 'the live read was not seen');
    assert.ok(
      !reads.get('navigate').has('wait_ms'),
      'a commented-out read counted as a read, so the check would certify the defect it exists to catch',
    );
  });

  it('still finds an operation whose branch is labelled with a quoted name', () => {
    // The negative control for the two tests above. Emptying string contents
    // would satisfy them both and delete the landmark this scan navigates by,
    // reporting that the bridge has no branch for any operation at all —
    // crying wolf on every argument rather than passing on one.
    const reads = bridgeReadsByOperation();
    assert.ok(reads.has('navigate'), "the branch labelled case 'navigate' was not found");
    assert.ok(reads.get('navigate').size > 0, 'the navigate branch reported no reads');
  });

  it('reads every tool argument the surface declares, including shared ones', () => {
    const declarations = declaredToolArguments();
    const capture = declarations.filter((entry) => entry.tool === 'browser_capture');
    const names = capture.map((entry) => entry.name);
    // `lease_key` arrives via the shared `LEASE_KEY` constant rather than
    // being written inline, so a parser reading only inline names would miss
    // it on eleven of the twelve tools.
    assert.ok(names.includes('lease_key'), 'the shared lease-key constant is not being resolved');
    assert.ok(names.includes('reason'));
    assert.ok(names.includes('tier'));
  });
});

describe('the configuration half cannot pass vacuously', () => {
  it('does not treat the declaration table’s own `key:` field as a reader', () => {
    // The bug this pins: `key: 'BROKER_X'` was read as an assembled field
    // named `key`, which appears in nearly every source, so every variable
    // resolved a reader and the half reported green — including the inert one
    // it exists to catch.
    const source = readFileSync(ENVIRONMENT_SOURCE, 'utf8');
    const fields = environmentFieldsFor('BROKER_TAB_BUDGET', source);
    assert.ok(!fields.includes('key'), '`key` is the declaration, not a field the record carries');
    assert.deepEqual(fields, ['tabBudget']);
  });

  it('resolves a variable assembled through a local binding', () => {
    // `const regularBrowsers = getList('BROKER_REGULAR_BROWSERS')`, put on the
    // record later by shorthand. Missing this form made the check cry wolf on
    // two settings that are read throughout the service.
    const source = readFileSync(ENVIRONMENT_SOURCE, 'utf8');
    assert.deepEqual(environmentFieldsFor('BROKER_REGULAR_BROWSERS', source), ['regularBrowsers']);
  });

  it('resolves the field of a variable declared as an enum, not only a number or a list', () => {
    // The configuration half is only as good as its field resolution, and the
    // three assembling forms are resolved by three different patterns. A
    // variable read through the `getSeconds`-style getter is the inline form,
    // and losing it would make the half cry wolf on a setting the service
    // reads everywhere — the failure mode that gets a gate switched off.
    const source = readFileSync(ENVIRONMENT_SOURCE, 'utf8');
    assert.deepEqual(environmentFieldsFor('BROKER_LEASE_SECONDS', source), ['leaseSeconds']);
  });

  it('would report a variable whose field nothing outside the declaration reads', () => {
    // ── The positive control, and why it is synthesised ──────────────────
    //
    // This half has to be shown capable of failing, or "green" and "cannot
    // fail" are indistinguishable — the exact property this whole file exists
    // to deny.
    //
    // The unread variable is fabricated rather than borrowed from the
    // declaration table. A control that points at a real declared-but-unread
    // variable is hostage to the configuration around it: it holds only while
    // that variable stays both declared and unread, and it stops controlling
    // the moment somebody reads it or stops declaring it — silently, while
    // still reporting success. `environmentFieldsFor` reads a source it is
    // handed, so a table carrying a declaration nothing assembles is a
    // complete input, and the assertion is about the mechanism rather than
    // about any particular setting. It cannot rot.
    const declaredButNeverAssembled = `
      const DECLARATIONS = [
        { key: 'BROKER_INVENTED_SETTING', kind: 'enum', fallback: 'a', allowed: ['a', 'b'] },
      ];
      return {
        leaseSeconds: getNumber('BROKER_LEASE_SECONDS'),
      };
    `;
    assert.deepEqual(
      environmentFieldsFor('BROKER_INVENTED_SETTING', declaredButNeverAssembled),
      [],
      'a variable the record never assembles must resolve no field, which is what the check reports on',
    );
  });

  it('keeps the waiver list empty, so no declared variable is excused', () => {
    // The waiver facility exists and takes no entries. An empty list is the
    // state worth pinning: a waiver is the temporary third ending for an
    // unread variable, next to the two honest ones (become read, or stop
    // being declared), and a list that quietly grows is where the next inert
    // setting hides. Adding an entry should be a deliberate act that fails
    // this test and makes somebody argue for it in review.
    assert.deepEqual(WAIVERS, [], 'a new waiver needs its reasoning argued, not defaulted into');
    const configuration = checkConfiguration();
    assert.deepEqual(configuration.waived, [], 'every declared variable answers the rule itself');
  });

  it('refuses a waiver that names a variable the build does not declare', () => {
    // The stale-excuse guard, which is what makes an empty list safe to trust:
    // an entry outliving its variable would sit here as a hole under a name
    // somebody later reuses. Asserted through the real entry point with a
    // fabricated waiver, so it exercises the branch rather than restating it.
    const stale = [{ what: 'BROKER_NOT_DECLARED_ANYWHERE', why: 'fabricated for this test' }];
    const configuration = checkConfiguration({ waivers: stale });
    assert.ok(
      configuration.failures.some((failure) => failure.includes('BROKER_NOT_DECLARED_ANYWHERE')),
      'a waiver naming an undeclared variable must fail the check, not be ignored',
    );
  });
});

describe('the tool surface and the bridge agree about capture', () => {
  it('reads `tier` and `reason` under the capture branch', () => {
    // The defect this check found on the tree it was written against: the tier
    // ladder was implemented, validated, stored and reported on, while no
    // surface could populate it. Pinned here so it cannot silently regress —
    // deleting either read in `bridge.ts` fails this test and the check.
    const reads = bridgeReadsByOperation();
    assert.ok(reads.get('capture').has('tier'));
    assert.ok(reads.get('capture').has('reason'));
  });

  it('declares `tier` alongside `reason`, so the justification has something to justify', () => {
    const tools = readFileSync(TOOLS_SOURCE, 'utf8');
    const declarations = declaredToolArguments(tools);
    const capture = declarations
      .filter((entry) => entry.tool === 'browser_capture')
      .map((entry) => entry.name);
    assert.ok(
      capture.includes('tier') && capture.includes('reason'),
      '`reason` without `tier` offers a justification for an escalation nothing can request',
    );
  });
});
