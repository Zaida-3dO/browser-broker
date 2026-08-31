import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DECLARED_VARIABLES, readEnvironment } from '../../src/config/environment.ts';
import { StartupRefusal } from '../../src/errors.ts';
import { localDrivePath } from '../helpers/paths.ts';

const home = (): string => path.join(path.sep, 'home', 'someone');

test('an unset variable uses its default — a fresh install runs with nothing set', () => {
  const environment = readEnvironment({ env: {}, homedir: home, platform: 'linux' });
  assert.ok(environment.databasePath.length > 0);
  assert.ok(environment.artifactsRoot.length > 0);
  assert.ok(environment.profileRoot.length > 0);
  // Under the per-user application-data location the platform defines, in a
  // directory of the service's own.
  assert.ok(environment.databasePath.startsWith(home()));
  assert.ok(environment.databasePath.includes('browser-broker'));
});

test('the default is the platform’s own answer, and differs per platform', () => {
  const linux = readEnvironment({ env: {}, homedir: home, platform: 'linux' });
  const windows = readEnvironment({ env: {}, homedir: home, platform: 'win32' });
  const mac = readEnvironment({ env: {}, homedir: home, platform: 'darwin' });
  assert.notEqual(linux.databasePath, windows.databasePath);
  assert.notEqual(linux.databasePath, mac.databasePath);
  assert.notEqual(windows.databasePath, mac.databasePath);
});

test('a variable that is set and valid is used', () => {
  const chosen = path.join(path.sep, 'srv', 'broker', 'store.db');
  const environment = readEnvironment({
    env: { BROKER_DB: chosen },
    homedir: home,
    platform: 'linux',
  });
  assert.equal(environment.databasePath, path.resolve(chosen));
});

test('a variable set to an empty value refuses to start, naming the variable', () => {
  // Not the default silently: a caller that set a value and got the default
  // is running a configuration it did not choose with no way to notice.
  assert.throws(
    () => readEnvironment({ env: { BROKER_DB: '   ' }, homedir: home, platform: 'linux' }),
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.equal(error.rule, 'config.value_readable');
      assert.match(error.message, /BROKER_DB/);
      return true;
    },
  );
});

test('a variable set to something unreadable as a path refuses, naming the variable', () => {
  assert.throws(
    () =>
      readEnvironment({
        env: { BROKER_PROFILE_ROOT: `profiles${String.fromCharCode(0)}x` },
        homedir: home,
        platform: 'linux',
      }),
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.equal(error.rule, 'config.value_readable');
      assert.match(error.message, /BROKER_PROFILE_ROOT/);
      return true;
    },
  );
});

test('every declared variable refuses independently', () => {
  for (const key of DECLARED_VARIABLES) {
    assert.throws(
      () => readEnvironment({ env: { [key]: '' }, homedir: home, platform: 'linux' }),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal, `${key} did not refuse an empty value`);
        assert.match(error.message, new RegExp(key));
        return true;
      },
    );
  }
});

test('an unrecognised variable is ignored', () => {
  // A process cannot tell an unrecognised variable of its own from any other
  // variable in an environment it shares with everything on the machine.
  const environment = readEnvironment({
    env: { BROKER_NOT_A_REAL_SETTING: 'whatever' },
    homedir: home,
    platform: 'linux',
  });
  assert.ok(environment.databasePath.includes('browser-broker'));
});

test('no default names a machine — the path is computed from the home directory', () => {
  const environment = readEnvironment({
    env: {},
    homedir: () => localDrivePath('C', 'Users', 'someone'),
    platform: 'win32',
  });
  assert.ok(environment.databasePath.includes('someone'));
});

test('every variable this build declares is the set below, and no other', () => {
  // Pinned rather than counted. A variable added without a line in
  // `.env.example` is an undocumented setting, and it stays undocumented
  // until somebody goes looking for a behaviour they cannot explain — so the
  // walk test below is what enforces that, and this is what makes adding one
  // a deliberate edit here rather than a silent widening.
  assert.deepEqual([...DECLARED_VARIABLES].sort(), [
    'BROKER_ARTIFACTS_ROOT',
    'BROKER_DB',
    'BROKER_LAUNCH_READINESS_TIMEOUT_SECONDS',
    'BROKER_LEASE_SECONDS',
    'BROKER_PROFILE_ROOT',
    'BROKER_QUEUE_SECONDS',
    'BROKER_TAB_BUDGET',
  ]);
});

// ── The three numbers (#12, #52) ────────────────────────────────────────
//
// The rejections are the specification here. Every value below is one
// somebody wrote deliberately, and the alternative to refusing is running a
// configuration nobody chose with nothing to notice it by (§6.3).

test('the three numbers default to the values section 6.2 declares', () => {
  const environment = readEnvironment({ env: {}, homedir: home, platform: 'linux' });
  assert.equal(environment.tabBudget, 15);
  assert.equal(environment.leaseSeconds, 600);
  assert.equal(environment.queueSeconds, 600);
});

test('the launch-readiness timeout defaults to 30 seconds, settled by row #55', () => {
  const environment = readEnvironment({ env: {}, homedir: home, platform: 'linux' });
  assert.equal(environment.launchReadinessTimeoutSeconds, 30);
});

test('the launch-readiness timeout can be set, like the other declared numbers', () => {
  const environment = readEnvironment({
    env: { BROKER_LAUNCH_READINESS_TIMEOUT_SECONDS: '5' },
    homedir: home,
    platform: 'linux',
  });
  assert.equal(environment.launchReadinessTimeoutSeconds, 5);
});

test('the two lifetimes are equal by default, and that equality is the decision', () => {
  // §2.5: both arguments for making them differ pointed the other way.
  // Polling is renewing, so a queued caller holds exactly the instrument an
  // active holder does; and under strict ordering a queue place held longer
  // blocks everyone behind it. The single-character change that breaks this
  // is moving either default.
  const environment = readEnvironment({ env: {}, homedir: home, platform: 'linux' });
  assert.equal(environment.leaseSeconds, environment.queueSeconds);
  assert.equal(environment.leaseSeconds, 10 * 60);
});

test('a number that is set and valid is used', () => {
  const environment = readEnvironment({
    env: { BROKER_TAB_BUDGET: '30', BROKER_LEASE_SECONDS: '120', BROKER_QUEUE_SECONDS: '90' },
    homedir: home,
    platform: 'linux',
  });
  assert.equal(environment.tabBudget, 30);
  assert.equal(environment.leaseSeconds, 120);
  assert.equal(environment.queueSeconds, 90);
});

test('the two lifetimes can be set apart, so the equality is a default and not a weld', () => {
  const environment = readEnvironment({
    env: { BROKER_LEASE_SECONDS: '600', BROKER_QUEUE_SECONDS: '30' },
    homedir: home,
    platform: 'linux',
  });
  assert.notEqual(environment.leaseSeconds, environment.queueSeconds);
  assert.equal(environment.queueSeconds, 30);
});

test('surrounding whitespace on a number is read rather than refused', () => {
  const environment = readEnvironment({
    env: { BROKER_TAB_BUDGET: '  8  ' },
    homedir: home,
    platform: 'linux',
  });
  assert.equal(environment.tabBudget, 8);
});

for (const bad of ['nine', '1.5', '-4', '+7', '10s', '1e3', '0x10', '15 tabs', '  ']) {
  test(`a tab budget of ${JSON.stringify(bad)} refuses to start, naming the variable`, () => {
    // Reading '10s' as ten would be a guess, and reading '1e3' as a thousand
    // would let a typo of a thousand pass as a small number somewhere else.
    assert.throws(
      () => readEnvironment({ env: { BROKER_TAB_BUDGET: bad }, homedir: home, platform: 'linux' }),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal);
        assert.equal(error.rule, 'config.value_readable');
        assert.match(error.message, /BROKER_TAB_BUDGET/);
        return true;
      },
    );
  });
}

test('zero refuses, because it is a configuration in which nobody can be served', () => {
  // A budget of zero admits nobody; a lifetime of zero expires every lease
  // before its first call. Refusing at the loudest moment beats every call
  // refusing for a reason nothing names.
  for (const key of ['BROKER_TAB_BUDGET', 'BROKER_LEASE_SECONDS', 'BROKER_QUEUE_SECONDS']) {
    assert.throws(
      () => readEnvironment({ env: { [key]: '0' }, homedir: home, platform: 'linux' }),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal, `${key} accepted zero`);
        assert.match(error.message, new RegExp(key));
        assert.match(error.message, /zero/);
        return true;
      },
    );
  }
});

test('a number past the exact-arithmetic boundary refuses', () => {
  // Past it a comparison against a budget stops being one.
  const beyond = String(Number.MAX_SAFE_INTEGER) + '0';
  assert.throws(
    () => readEnvironment({ env: { BROKER_TAB_BUDGET: beyond }, homedir: home, platform: 'linux' }),
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.match(error.message, /BROKER_TAB_BUDGET/);
      return true;
    },
  );
});

test('a refused number never falls back to the default', () => {
  // The failure this guards is the quiet one: a caller that set a value, got
  // the default, and has no way to notice.
  assert.throws(() =>
    readEnvironment({ env: { BROKER_TAB_BUDGET: 'lots' }, homedir: home, platform: 'linux' }),
  );
});

test('.env.example lists every declared variable with its default', () => {
  // §1.10: that file is the registry. A variable that exists in code and not
  // in it is an undocumented setting. Read from the repository root, which is
  // two directories up from this file.
  const registry = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', '.env.example'),
    'utf8',
  );
  for (const key of DECLARED_VARIABLES) {
    assert.match(
      registry,
      new RegExp(String.raw`^#\s*` + key + '=', 'm'),
      `${key} is declared in code and has no commented example line in .env.example`,
    );
    assert.match(
      registry,
      new RegExp(String.raw`^#\s*Default:`, 'm'),
      `${key} has no stated default in .env.example`,
    );
  }
});
