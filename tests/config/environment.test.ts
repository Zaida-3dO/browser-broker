import assert from 'node:assert/strict';
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

test('the three variables the store needs before it opens are declared', () => {
  assert.deepEqual([...DECLARED_VARIABLES].sort(), [
    'BROKER_ARTIFACTS_ROOT',
    'BROKER_DB',
    'BROKER_PROFILE_ROOT',
  ]);
});
