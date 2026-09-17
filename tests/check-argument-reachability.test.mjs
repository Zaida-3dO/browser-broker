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
  actionRequestMembers,
  aliasGroups,
  assemblers,
  bridgeReadsByOperation,
  checkArguments,
  checkConfiguration,
  checkRequiredFieldsAreDeclarable,
  declaredToolArguments,
  environmentFieldsFor,
  passthroughArguments,
  reachableFields,
  runReachabilityCheck,
  seededDefect,
  seededUndeclaredPassthrough,
  seededUnreachableVerb,
  stripCommentsAndStrings,
  STRUCTURED_UNIONS,
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

/**
 * The reverse half — **a needed field is declared by something**.
 *
 * The same argument as the header of this file, applied to the newer half and
 * sharper for it. This half's subject is *a capability nobody offered*, and the
 * ways it can be worthless are not the ways the first half can: it can fail to
 * fire, like any gate, but it can also **pass vacuously by construction**,
 * because the argument it reasons about is a passthrough that carries every
 * field by definition. A green run proves nothing about either hazard, so both
 * are seeded below.
 */
describe('the reverse check: a required field of ActionRequest can reach the surface', () => {
  it('passes on the tree as it stands, with no false positives', () => {
    // The scope claim, asserted rather than asserted-about. The unscoped
    // version of this check reports 17 names on `browser_act`, of which 4 are
    // the defect; the scoped one reports none. If a future change makes this
    // fail, the question to ask first is whether the scope drifted — not
    // whether to add a waiver, which this half deliberately does not have.
    const result = checkRequiredFieldsAreDeclarable();
    assert.deepEqual(
      result.failures,
      [],
      'every required ActionRequest field can be expressed from the tool surface on this tree',
    );
    assert.ok(result.checked > 0, 'a check that examined no fields would report green vacuously');
  });

  it('goes red when the passthrough is undeclared, which is the pre-5738548 tree', () => {
    // Seeded against a **copy**, like the `wait_ms` seed above, and seeded at
    // the declaration rather than the bridge because that is where the defect
    // actually lived: 5738548 added one argument and left `bridge.ts` untouched.
    const seeded = checkRequiredFieldsAreDeclarable(seededUndeclaredPassthrough());
    for (const field of ['preferences', 'fields', 'targetRef']) {
      assert.ok(
        seeded.failures.some((failure) => failure.includes(field)),
        `removing the passthrough must make "${field}" unreachable — it has no flat spelling, ` +
          'which is exactly why the four verbs were uncallable',
      );
    }
  });

  it('goes red on a verb the surface cannot express, with the passthrough still declared', () => {
    // **The load-bearing proof, and the one the seed above cannot make.**
    //
    // Worth stating plainly because an earlier draft of this check passed the
    // seed above while being unable to observe the defect class at all. That
    // seed deletes the declaration, so a check that wrongly counted the
    // passthrough toward reachability still went red on it — for the unrelated
    // reason that there was nothing left to count. It cannot tell a working
    // exclusion clause from an absent one.
    //
    // This one leaves the passthrough exactly where it is and grows the
    // **union**: a verb whose required field no declared argument can carry,
    // which is precisely what happened to emulate, fill_form and drag. It is
    // red only if the passthrough is genuinely excluded. Let the passthrough
    // count and this goes green — so this is the test that fails when somebody
    // "simplifies" the clause away.
    const seeded = seededUnreachableVerb();
    const result = checkRequiredFieldsAreDeclarable({ driverSource: seeded.driverSource });
    assert.ok(
      result.failures.some((failure) => failure.includes(seeded.field)),
      'a required field nothing on the surface can express must fail even while the passthrough ' +
        'is declared — otherwise the passthrough is being counted toward reachability and the ' +
        'gate can never fire on the defect class it exists for',
    );
  });

  it('fails a passthrough-only field that is not recorded, which is what makes the list bite', () => {
    // The enumeration is what leaves everything else failing, so the thing to
    // pin is that an *unrecorded* field fails. Asserted by emptying the list
    // rather than by adding a verb, so it exercises the recorded/unrecorded
    // branch directly: the three real fields become unacknowledged and must
    // each be reported.
    const union = STRUCTURED_UNIONS[0];
    const recorded = union.viaPassthrough;
    try {
      union.viaPassthrough = [];
      const result = checkRequiredFieldsAreDeclarable();
      for (const field of ['preferences', 'fields', 'targetRef']) {
        assert.ok(
          result.failures.some((failure) => failure.includes(field)),
          `with nothing recorded, "${field}" has no flat route and must be reported — if it is ` +
            'not, the passthrough is reaching it and the exclusion has stopped working',
        );
      }
    } finally {
      union.viaPassthrough = recorded;
    }
  });

  it('reports a recorded field that has since grown a flat route as stale', () => {
    // The other end of the guard. An entry that no longer describes the tree
    // stops being read, and this list is load-bearing for the fields that do
    // still need it — so a stale one is a failure rather than a shrug, exactly
    // like the stale-waiver guard in the configuration half.
    const union = STRUCTURED_UNIONS[0];
    const recorded = union.viaPassthrough;
    try {
      // `value` is declared flat, so recording it as passthrough-only is a lie
      // the check must notice.
      union.viaPassthrough = [...recorded, { field: 'value', why: 'fabricated for this test' }];
      const result = checkRequiredFieldsAreDeclarable();
      assert.ok(
        result.failures.some(
          (failure) => failure.includes('"value"') && failure.includes('flat route'),
        ),
        'a recorded field that is reachable flat must be reported as stale',
      );
    } finally {
      union.viaPassthrough = recorded;
    }
  });

  it('derives the passthrough structurally rather than by the name `request`', () => {
    // A check hunting a hardcoded name cannot tell a deleted argument from a
    // renamed one, and only one of those is a defect. Asserted by renaming it
    // in a copy and requiring the derivation to follow.
    const tools = readFileSync(TOOLS_SOURCE, 'utf8');
    assert.deepEqual(passthroughArguments('browser_act', tools), ['request']);

    const renamed = tools.replaceAll("name: 'request'", "name: 'whole_request'");
    assert.deepEqual(
      passthroughArguments('browser_act', renamed),
      ['whole_request'],
      'the passthrough is the object-typed argument, whatever it is called',
    );
    assert.deepEqual(
      checkRequiredFieldsAreDeclarable({ toolsSource: renamed }).failures,
      [],
      'renaming the passthrough is not a defect and must not be reported as one',
    );
  });

  it('reads optionality from the union rather than from a list kept beside it', () => {
    const members = actionRequestMembers();
    const press = members.find((member) => member.verbs.includes('press'));
    // `press` is the member that pins this: it has `ref?` and `value`, so a
    // parser blind to `?` would put `ref` in `required` and demand a
    // declaration for a field the service does not require.
    assert.deepEqual(press.required, ['value']);
    assert.deepEqual(press.optional, ['ref']);

    const drag = members.find((member) => member.verbs.includes('drag'));
    assert.deepEqual(drag.required, ['ref', 'targetRef']);
  });

  it('refuses to check an empty set when the union is renamed', () => {
    // The failure mode this guards is the worst one available to a static
    // check: finding nothing, checking nothing, and reporting green. It throws
    // rather than returning `[]` for exactly that reason.
    assert.throws(
      () => actionRequestMembers(undefined, 'export type SomethingElse = { readonly a: 1 };'),
      /could not find "export type ActionRequest"/,
    );

    // The second way to check nothing: the type is found and no member parses
    // out of it, which is what a change to the union's layout would produce.
    // Pinned separately because it is a different branch and a mutation that
    // removes it survives the assertion above.
    assert.throws(
      () =>
        actionRequestMembers(undefined, 'export type ActionRequest = never;\nexport const x = 1;'),
      /parsed no members/,
    );
  });

  it('treats alias spellings as one argument by grouping them at the call site', () => {
    // The single decision that takes the false-positive count from 17 to zero.
    // `argument(args, 'ref', 'target')` IS the statement that the two names are
    // one argument, so `ref` is reachable from a surface that declares only
    // `target`. Flattening the literals loses precisely this.
    const groups = aliasGroups();
    assert.ok(
      groups.some((group) => group.includes('ref') && group.includes('target')),
      'ref/target must be recognised as one argument under two spellings',
    );

    const reach = reachableFields(['target'], { groups, built: assemblers() });
    assert.ok(reach.has('ref'), '`ref` is declared — as `target`, which is the same argument');
  });

  it('follows alternate-shape parsers, so a flat `value` reaches `viewport`', () => {
    // `viewportFrom` reads `viewport`, `width`, `height` and `value`, and only
    // `value` is declared — by design, because the flat surface accepts
    // `390x844`. Undeclared alternatives are not gaps, and a check that called
    // them gaps would cry wolf on a working verb.
    const reach = reachableFields(['value'], { groups: aliasGroups(), built: assemblers() });
    assert.ok(reach.has('viewport'), 'resize is reachable through the `390x844` spelling');
  });

  it('admits only helpers that build their own field, not every `…From`', () => {
    // **The third vacuity route, and the subtlest.** `actionFrom` and
    // `refusalFrom` also end in `From` and both read the whole argument record —
    // `refusalFrom` transitively reads every name in the bridge. Admitting them
    // makes every field reachable from any declared argument whatsoever, and
    // the check passes on everything again. The self-read test is what excludes
    // them, and this pins it.
    const built = assemblers();
    assert.ok(built.has('viewport'), '`viewportFrom` reads `viewport` and assembles it');
    assert.ok(built.has('response'), '`responseFrom` reads `response` and assembles it');
    assert.ok(
      !built.has('refusal'),
      '`refusalFrom` reads the whole record — all 48 names in the bridge, transitively — and ' +
        'assembles no field of its own. Admitting it would make every field reachable from any ' +
        'declared argument whatsoever, which is the vacuity the self-read test exists to prevent',
    );

    // **`actionFrom` IS admitted, and that is correct — noted because it looks
    // wrong.** It reads `argument(args, 'action')`, so it passes the self-read
    // test, and an earlier draft of this test asserted it should be excluded.
    // The assertion was wrong, not the code. Reachability flows *inward*: an
    // assembler entry says "these read names reach this built field", so
    // `actionFrom` lets `ref`, `value` and the rest reach `action`. It never
    // lets `action` reach *them*, which is the direction that would be
    // dangerous. The guard that matters is the one below.
    assert.deepEqual(
      [...reachableFields(['action'], { groups: aliasGroups(), built })],
      ['action'],
      'admitting the dispatcher must not let one declared name reach the whole union — ' +
        'reachability composes inward, toward the assembled field, and never back out',
    );
  });

  it('names the fields that depend on the passthrough alone, on a passing run', () => {
    // Reported rather than failed, and visible on green, for the same reason a
    // waiver is printed on every run: the dependency should be in front of
    // whoever is reading a diff that touches the declaration.
    const result = checkRequiredFieldsAreDeclarable();
    const named = result.viaPassthroughOnly.map((entry) => entry.field).sort();
    assert.deepEqual(named, ['fields', 'preferences', 'targetRef']);
  });

  it('is wired into the whole-tree run rather than living beside it', () => {
    // A check nothing calls is the inert-argument defect wearing a gate's
    // clothes. `npm run check:argument-reachability` runs `runReachabilityCheck`,
    // so the reverse half has to be reachable from there or it never runs in CI.
    const result = runReachabilityCheck();
    assert.ok(
      typeof result.checkedFields === 'number' && result.checkedFields > 0,
      'the reverse half must contribute to the run the CI job actually invokes',
    );
    assert.deepEqual(result.failures, []);
  });
});
