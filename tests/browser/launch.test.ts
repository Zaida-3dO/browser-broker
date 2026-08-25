import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDefaultArgsIntact,
  assertExplicitProfileDirectory,
  CAPTURE_SURFACE_ARGUMENTS,
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
