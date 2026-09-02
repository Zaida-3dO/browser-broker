import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeServiceSubject } from '../../src/adapter/conformance/service-subject.ts';
import { parseArguments } from '../../src/cli/adapter.ts';
import { createRuntime } from '../../src/service/runtime.ts';
import { FakeBrowserDriver } from '../../src/browser/fake.ts';
import type { BrokerService } from '../../src/adapter/service-seam.ts';

/**
 * **Arguments a caller can actually type reach the service that needs them.**
 *
 * ── The shape of the bug this file exists for ───────────────────────────
 *
 * Three operations were refused for arguments the caller had supplied
 * correctly, because nothing on the way in could carry them:
 *
 * - `act resize` wants `viewport: { width, height }` — an object of two
 *   integers. `parseArguments` produces flat strings and only flat strings,
 *   so **no argument a command-line caller could type would ever parse**. A
 *   field session tried `--value 390x844`, `390,844`, `"390 844"`, the JSON
 *   object and `--width 390 --height 844`, and got the identical refusal to
 *   all five.
 * - `act emulate` wants `preferences: { … }` and had the same problem, behind
 *   a refusal that is otherwise a model of its kind — it names its three
 *   options the way `claim.browser_known` names the browsers, so a caller
 *   read good advice and could not act on it.
 * - `claim` coerced an omitted `--browser` to `''`, which
 *   `claim.browser_known` then correctly refused as a browser named `""` —
 *   turning a documented default into a refusal on a new caller's first call.
 *
 * With the tool surface returning empty results at the same time, the command
 * line was the only working client, so "unreachable from the command line"
 * meant unreachable. Mobile-breakpoint and dark-theme review were impossible.
 *
 * ── Why these go through the real service and the real parser ───────────
 *
 * A test that called the assembly helpers directly would assert that a
 * private function builds an object, which is not the claim. **The claim is
 * that a caller who types this gets that**, so every case below starts at
 * `parseArguments` — the actual command-line parser, on the actual argument
 * vector a person types — and ends at the real service's own outcome. That is
 * the whole path the field session walked, and nothing in between is stubbed.
 *
 * The browser driver is faked, as everywhere else in this suite: every rule
 * under test is enforced inside the arbitration transaction, before a browser
 * is reached. No browser is launched, so none can leak.
 */

/** A lease on a fresh service, and the argv-driven `act` its key unlocks. */
async function withLease(
  body: (
    act: (argv: readonly string[]) => Promise<Awaited<ReturnType<BrokerService['perform']>>>,
  ) => Promise<void>,
): Promise<void> {
  const subject = await makeServiceSubject();
  try {
    const claimed = await subject.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: parseArguments([
        '--session-id',
        'argument-assembly',
        '--purpose',
        'Proving the arguments a caller types reach the operation that needs them.',
      ]),
    });
    assert.equal(claimed.outcome, 'accepted', 'the lease this test needs was not granted');
    const key = String((claimed as { value: Record<string, unknown> }).value['key']);

    await body((argv) =>
      subject.service.perform({
        operation: 'act',
        adapter: 'cli',
        arguments: parseArguments([...argv, '--lease-key', key]),
      }),
    );
  } finally {
    await subject.dispose?.();
  }
}

test('CLAIM WITH NO --browser USES THE DOCUMENTED DEFAULT, rather than asking for a browser named ""', async () => {
  // The tool description promises: "Omit this and you get the first
  // signed-in browser, which is what most work wants." It is the first thing
  // a new caller does.
  //
  // The single change that breaks this test: coercing the absent argument
  // back to `''` in the claim branch of the bridge.
  const subject = await makeServiceSubject();
  try {
    const claimed = await subject.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: parseArguments([
        '--session-id',
        'no-browser-named',
        '--purpose',
        'Claiming without naming a browser, which the description says is the ordinary case.',
      ]),
    });

    assert.equal(
      claimed.outcome,
      'accepted',
      `omitting --browser was refused: ${JSON.stringify(claimed)}`,
    );

    // And it resolved to a real browser rather than to nothing — an
    // acceptance that granted a lease against `undefined` would satisfy the
    // assertion above while leaving the caller just as stuck.
    const granted = (claimed as { value: Record<string, unknown> }).value;
    assert.equal(typeof granted['browserId'], 'string');
    assert.ok(String(granted['browserId']).length > 0, 'the grant named no browser');
  } finally {
    await subject.dispose?.();
  }
});

test('a browser that genuinely does not exist is still refused, and named', async () => {
  // The negative control for the test above. Without it, "omitting the
  // browser works" would also pass against a bridge that stopped checking the
  // browser at all.
  const subject = await makeServiceSubject();
  try {
    const claimed = await subject.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: parseArguments([
        '--session-id',
        'unknown-browser',
        '--browser',
        'chartreuse',
        '--purpose',
        'Naming a browser this service does not have, which must still be refused.',
      ]),
    });

    assert.equal(claimed.outcome, 'refused');
    assert.equal((claimed as { rule: string }).rule, 'claim.browser_known');
  } finally {
    await subject.dispose?.();
  }
});

test('ACT RESIZE IS REACHABLE FROM THE COMMAND LINE — every form the field session tried', async () => {
  // Each of these was refused identically before, and each *is* a width and a
  // height in pixels. The list is the reporter's own, verbatim, minus the JSON
  // object — which a shell cannot produce as anything but a string and which
  // the tool surface can already send as a real object.
  //
  // The single change that breaks this test: returning `argument(args,
  // 'viewport')` alone from `viewportFrom`, which is what it did before.
  await withLease(async (act) => {
    for (const argv of [
      ['--action', 'resize', '--width', '390', '--height', '844'],
      ['--action', 'resize', '--value', '390x844'],
      ['--action', 'resize', '--value', '390,844'],
      ['--action', 'resize', '--value', '390 844'],
    ]) {
      const outcome = await act(argv);
      assert.equal(
        outcome.outcome,
        'accepted',
        `${argv.join(' ')} was refused: ${JSON.stringify(outcome)}`,
      );
    }
  });
});

test('a resize that names no usable size is still refused — AND THE MESSAGE NOW SAYS HOW TO WRITE ONE', async () => {
  // The negative control, and the message assertion the original report asked
  // for. A refusal that is right and leaves the caller guessing is this
  // project's most expensive defect class: the session that hit it tried five
  // spellings and stopped, and the mobile breakpoint went unreviewed.
  await withLease(async (act) => {
    const outcome = await act(['--action', 'resize', '--value', 'nonsense']);

    assert.equal(outcome.outcome, 'refused');
    assert.equal((outcome as { rule: string }).rule, 'act.viewport_bounded');

    // The syntax, not only the semantics. Naming the accepted form is what
    // ends the guessing in one call.
    const message = (outcome as { message: string }).message;
    assert.match(message, /--width/u, 'the refusal still does not say how to write a viewport');
    assert.match(message, /390x844/u, 'the refusal gives no concrete example');
  });
});

test('ACT EMULATE IS REACHABLE FROM THE COMMAND LINE, by the name its own refusal advertises', async () => {
  // The refusal names `colourScheme`, so `--colour-scheme` is what a caller
  // reading it types. That it was then refused identically is the part that
  // made a good message useless.
  //
  // The single change that breaks this test: returning `argument(args,
  // 'preferences')` alone from `preferencesFrom`.
  await withLease(async (act) => {
    for (const argv of [
      ['--action', 'emulate', '--colour-scheme', 'dark'],
      ['--action', 'emulate', '--reduced-motion', 'reduce'],
      ['--action', 'emulate', '--forced-colours', 'active'],
      // Both spellings of "colour", because a caller who types the one this
      // service does not use should get a dark theme rather than a refusal
      // that reads as though they named nothing.
      ['--action', 'emulate', '--color-scheme', 'dark'],
      // Several at once, since each preference is set independently.
      ['--action', 'emulate', '--colour-scheme', 'dark', '--reduced-motion', 'reduce'],
    ]) {
      const outcome = await act(argv);
      assert.equal(
        outcome.outcome,
        'accepted',
        `${argv.join(' ')} was refused: ${JSON.stringify(outcome)}`,
      );
    }
  });
});

test('an emulate value outside the table is refused BY NAME — the bridge coerces, it does not validate', async () => {
  // This is the assertion that keeps the fix honest. The bridge assembles the
  // object and decides nothing about it: which values are legal stays the
  // operation's decision, on the ledger. A bridge that validated here would
  // produce a refusal from the wrong place and a rule name the caller cannot
  // look up.
  await withLease(async (act) => {
    const outcome = await act(['--action', 'emulate', '--colour-scheme', 'chartreuse']);

    assert.equal(outcome.outcome, 'refused');
    assert.equal((outcome as { rule: string }).rule, 'act.emulate_preference_named');
    // And it names what would have worked.
    assert.match((outcome as { message: string }).message, /light, dark, no-preference/u);
  });
});

test('an emulate naming no preference at all is refused, and the message now carries an example', async () => {
  await withLease(async (act) => {
    const outcome = await act(['--action', 'emulate']);

    assert.equal(outcome.outcome, 'refused');
    assert.equal((outcome as { rule: string }).rule, 'act.emulate_preference_named');
    assert.match((outcome as { message: string }).message, /colourScheme/u);
    assert.match(
      (outcome as { message: string }).message,
      /--colour-scheme/u,
      'the refusal names its options but still not how to write one',
    );
  });
});

/**
 * A subject whose driver log is readable **with its arguments**, which the
 * shared conformance subject deliberately narrows away.
 *
 * `ConformanceSubject` exposes calls as `{ name }` because every case it
 * serves asks *"was the browser touched"* and nothing finer. The wait is the
 * opposite question: the call is made either way and only its arguments
 * differ, so the name alone cannot tell a wait that was carried from one that
 * was dropped. Rather than widen a shared interface for one file, this builds
 * the same two pieces — the real service over the fake driver — and keeps the
 * whole log.
 */
async function withNavigateSubject(
  body: (
    navigate: (argv: readonly string[]) => Promise<Awaited<ReturnType<BrokerService['perform']>>>,
    driverCalls: () => readonly {
      readonly name: string;
      readonly detail?: Readonly<Record<string, unknown>>;
    }[],
  ) => Promise<void>,
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-wait-'));
  const driver = new FakeBrowserDriver();
  const runtime = await createRuntime({
    adapter: 'cli',
    driver,
    env: {
      BROKER_DB: path.join(directory, 'broker.db'),
      BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
      BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
    },
  });

  try {
    const claimed = await runtime.service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: parseArguments([
        '--session-id',
        'navigate-wait',
        '--purpose',
        'Proving a typed --wait-ms reaches the browser rather than being dropped in transit.',
      ]),
    });
    assert.equal(claimed.outcome, 'accepted', 'the lease this test needs was not granted');
    const key = String((claimed as { value: Record<string, unknown> }).value['key']);

    await body(
      (argv) =>
        runtime.service.perform({
          operation: 'navigate',
          adapter: 'cli',
          arguments: parseArguments([...argv, '--lease-key', key]),
        }),
      () => driver.calls,
    );
  } finally {
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** The navigations in a driver log, which is the only place the wait shows. */
function navigations(
  calls: readonly { readonly name: string; readonly detail?: Readonly<Record<string, unknown>> }[],
): readonly Readonly<Record<string, unknown>>[] {
  return calls.filter((call) => call.name === 'navigate').map((call) => call.detail ?? {});
}

test('NAVIGATE --wait-ms IS REACHABLE FROM THE COMMAND LINE, and reaches the browser', async () => {
  // The argument is declared on the tool surface, so a caller reading the
  // description supplies it and has no way to see whether anything received
  // it: the response is byte-for-byte what a navigate with no wait returns.
  //
  // That is worse than an argument that does nothing, because it manufactures
  // evidence — two calls differing only in this value look like a controlled
  // experiment in how long the page was given, and if the value is discarded
  // they differ in nothing but the wall-clock gap between them.
  //
  // A command line delivers `5000` as the string "5000", so this also pins the
  // coercion: without it the value arrives as text and is refused by the
  // integer guard, however correctly the caller typed it.
  //
  // The single change that breaks this test: dropping `waitMs` from the
  // navigate branch of the bridge, or from the driver call in the operation.
  await withNavigateSubject(async (navigate, driverCalls) => {
    const outcome = await navigate(['--url', 'https://example.com/slow', '--wait-ms', '5000']);

    assert.equal(outcome.outcome, 'accepted', `--wait-ms was refused: ${JSON.stringify(outcome)}`);
    assert.deepEqual(
      navigations(driverCalls()).map((detail) => detail['waitMs']),
      [5000],
      'the typed wait never reached the browser, so the argument is advertised and inert',
    );
  });
});

test('a navigate with no --wait-ms asks the browser for no wait at all', async () => {
  // The negative control for the test above. Without it, "the wait arrives"
  // would also pass against a build that sent some fixed number every time —
  // which would be this service inventing a default the browser library owns.
  await withNavigateSubject(async (navigate, driverCalls) => {
    const outcome = await navigate(['--url', 'https://example.com/page']);

    assert.equal(outcome.outcome, 'accepted');
    assert.deepEqual(
      navigations(driverCalls()).map((detail) => detail['waitMs']),
      [undefined],
    );
  });
});

test('a --wait-ms that is not a usable number is refused BY NAME — the bridge coerces, it does not validate', async () => {
  // The same split every other argument here keeps: unparseable text becomes
  // `NaN` on the way through and is refused *by the operation*, on the ledger,
  // with the rule that owns the bound — not silently dropped by the bridge,
  // and not refused by some other rule that would send the caller looking in
  // the wrong place.
  await withNavigateSubject(async (navigate, driverCalls) => {
    const outcome = await navigate(['--url', 'https://example.com/page', '--wait-ms', 'soon']);

    assert.equal(outcome.outcome, 'refused', `"soon" was accepted: ${JSON.stringify(outcome)}`);
    assert.equal((outcome as { rule: string }).rule, 'navigate.wait_bounded');
    // The accepted range is in the sentence, because a refusal that leaves the
    // caller guessing is the failure this whole file was written for.
    assert.match(String((outcome as { message?: string }).message ?? ''), /1 to \d+/u);
    assert.deepEqual(navigations(driverCalls()), [], 'the page was driven despite the refusal');
  });
});

test('the verbs that always worked still work — the assembly did not capture arguments it should not', async () => {
  // `scroll` takes an optional reference and no value; `press` takes a value
  // that is a key name. Neither is object-shaped, so neither was ever broken —
  // and a change that started routing `--value` into a viewport would break
  // them. This is the regression that would otherwise be silent.
  await withLease(async (act) => {
    const scrolled = await act(['--action', 'scroll']);
    assert.equal(scrolled.outcome, 'accepted', JSON.stringify(scrolled));

    const pressed = await act(['--action', 'press', '--value', 'Enter']);
    assert.equal(pressed.outcome, 'accepted', JSON.stringify(pressed));
  });
});
