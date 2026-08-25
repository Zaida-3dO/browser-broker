import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertDefaultArgsIntact,
  assertExplicitProfileDirectory,
  CAPTURE_SURFACE_ARGUMENTS,
  coldStartDetached,
  launchArguments,
  LAUNCH_RULES,
  READINESS_TIMEOUT_MS,
} from '../../src/browser/launch.ts';
import { StartupRefusal } from '../../src/errors.ts';

/**
 * The build rules this row ships are claims about a command line, so they are
 * checked where the command line is assembled.
 *
 * None of this needs a browser: an argument list is a value, and asserting on
 * the value is a stronger check than watching a process start, because a
 * process that starts proves the arguments were *acceptable* rather than that
 * they were *right*.
 */

const REQUEST = {
  profileDirectory: 'a-profile-directory',
  mode: 'headed',
  executablePath: 'a-browser-binary',
} as const;

// The mutation this catches: making the profile directory optional, or
// defaulting it. A default profile location is shared with anything else that
// takes the default, and with browsers adopted rather than owned the
// directory is the only thing that says which browser this is.
test('an empty profile directory is refused — present is not the same as usable', () => {
  assert.throws(() => {
    assertExplicitProfileDirectory('');
  }, StartupRefusal);
  assert.throws(() => {
    assertExplicitProfileDirectory('   ');
  }, StartupRefusal);
});

test('the profile-directory refusal names the rule it enforces', () => {
  try {
    assertExplicitProfileDirectory('');
    assert.fail('an empty profile directory must be refused');
  } catch (error) {
    assert.ok(error instanceof StartupRefusal);
    assert.equal(error.rule, LAUNCH_RULES.explicitProfileDir);
  }
});

// The mutation this catches: dropping the profile directory from the
// assembled arguments, which is the one argument whose absence makes the
// browser take a default profile and become unattachable later.
test('the assembled command line states the profile directory explicitly', () => {
  const args = launchArguments(REQUEST);
  assert.ok(args.includes(`--user-data-dir=${REQUEST.profileDirectory}`));
});

// The mutation this catches: pinning a port. A fixed port is a guess about
// what else is running on the host, and the inward-isolation rule says this
// service must start on a machine where unrelated things are already
// listening. Zero is what asks the operating system for a free one.
test('the debugging port is unspecified, so the operating system assigns a free one', () => {
  assert.ok(launchArguments(REQUEST).includes('--remote-debugging-port=0'));
});

// The mutation this catches: applying the capture-surface settings only in
// one mode. The failure they guard is a background tab that stopped
// rendering, and the browser it matters most for is the headed one — so a
// version that only set them when headless would satisfy a test that checked
// the headless case and protect nothing where it counts.
test('the capture-surface settings are on BOTH modes, not only the headless one', () => {
  for (const mode of ['headed', 'headless'] as const) {
    const args = launchArguments({ ...REQUEST, mode });
    for (const setting of CAPTURE_SURFACE_ARGUMENTS) {
      assert.ok(args.includes(setting), `${setting} must be present when ${mode}`);
    }
  }
});

test('a headless launch says so, and a headed one does not', () => {
  assert.ok(launchArguments({ ...REQUEST, mode: 'headless' }).includes('--headless=new'));
  assert.ok(!launchArguments({ ...REQUEST, mode: 'headed' }).includes('--headless=new'));
});

// The mutation this catches: accepting a caller-supplied switch that turns a
// default off. Those defaults include what keeps background tabs running at
// full speed and what makes capturing them work, and removing them is how a
// service becomes mysteriously slow and mysteriously wrong at once.
test('an extra argument that removes a default is refused', () => {
  assert.throws(() => {
    assertDefaultArgsIntact(['--disable-gpu']);
  }, StartupRefusal);
  assert.throws(() => {
    assertDefaultArgsIntact(['--no-sandbox']);
  }, StartupRefusal);
});

test('the default-args refusal names its own rule', () => {
  try {
    assertDefaultArgsIntact(['--disable-gpu']);
    assert.fail('a subtractive argument must be refused');
  } catch (error) {
    assert.ok(error instanceof StartupRefusal);
    assert.equal(error.rule, LAUNCH_RULES.defaultArgsIntact);
  }
});

// The exemption is narrow and this pins it. The service's own capture-surface
// switches are disable-shaped by necessity, so they are exempted by exact
// membership — and this asserts the exemption is exactly that set rather than
// a widened shape that would let any disable-shaped switch through.
test('the service own capture-surface switches pass, and a lookalike does not', () => {
  assert.doesNotThrow(() => {
    assertDefaultArgsIntact([...CAPTURE_SURFACE_ARGUMENTS]);
  });
  // Same prefix as an exempted switch, and not the exempted switch.
  assert.throws(() => {
    assertDefaultArgsIntact(['--disable-backgrounding-occluded-windows-and-more']);
  }, StartupRefusal);
});

test('an additive extra argument is allowed through to the command line', () => {
  const args = launchArguments({ ...REQUEST, extraArguments: ['--window-size=800,600'] });
  assert.ok(args.includes('--window-size=800,600'));
});

// The mutation this catches: removing the bound on how long a cold start
// waits for its own endpoint. The measured silent-collision case — exit zero,
// no endpoint, ever — hangs forever without one rather than reporting.
test('a cold start has a bound on waiting for its own endpoint', () => {
  assert.ok(READINESS_TIMEOUT_MS > 0);
});

test('the assembled command line ends on a blank page for the keeper tab to be established against', () => {
  assert.equal(launchArguments(REQUEST).at(-1), 'about:blank');
});

test('a browser that is not installed refuses, rather than ending the process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-missing-browser-'));

  try {
    // ── Why this test exists, stated as the mechanism ──────────────────────
    //
    // Spawning a path that does not exist **reports the failure
    // asynchronously**, by emitting `error` on the child — and on at least one
    // platform it assigns a process identifier first, so a check for a missing
    // identifier does not see it. An unhandled `error` event is not a rejected
    // promise: it **ends the process**, escaping every `catch` between the
    // launch and its caller.
    //
    // That shape matters here more than almost anywhere. A machine with no
    // browser installed is an ordinary state, and after-commit work is best
    // effort precisely so that state can be reported as `pageDriven: false`.
    // Taking the process down instead means a page verb on such a machine
    // kills the service rather than answering it.
    //
    // **The assertion is therefore two things at once**: that it refuses, and
    // that the test process is still alive afterwards to make the assertion.
    // A test that only checked the rejection would pass identically against a
    // build that crashed a *different* process.
    await assert.rejects(
      async () =>
        await coldStartDetached(
          {
            profileDirectory: path.join(root, 'regular'),
            mode: 'headless',
            executablePath: path.join(root, 'a-browser-that-is-not-installed'),
          },
          // Short, because nothing here waits for a browser: the refusal comes
          // from the spawn failing rather than from the readiness timeout.
          { readinessTimeoutMs: 3_000, pollIntervalMs: 50 },
        ),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal, 'it refuses by name');
        // **Either wording, deliberately.** A failed spawn reports itself
        // differently by platform — one assigns no process identifier and is
        // caught synchronously, another assigns one and emits `error` a moment
        // later — and both paths refuse. Pinning one wording would make this
        // test pass on the machine it was written on and fail on the other,
        // while the behaviour it cares about is identical on both: a refusal
        // that says nothing is running.
        assert.match(
          error.message,
          /Nothing was (launched|started)/u,
          'it says nothing is running, rather than reporting a browser that might be there',
        );
        assert.equal(error.rule, LAUNCH_RULES.detached, 'and names the launch rule');
        return true;
      },
    );

    // Reached only if the process survived, which is half the claim.
    assert.ok(true, 'the process is still running after the failed launch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
