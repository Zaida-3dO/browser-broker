import assert from 'node:assert/strict';
import test from 'node:test';

import { StartupRefusal } from '../../src/errors.ts';
import {
  hasNetworkShareRoot,
  refuseNetworkLocation,
  type NetworkPathChecks,
} from '../../src/store/network-path.ts';
import { localDrivePath, shareForwardSlashPath, sharePath } from '../helpers/paths.ts';

/**
 * `store.not_on_network_filesystem` — and the point of these tests is the
 * refusals, not the allowances.
 *
 * The refusal cannot be proved on a machine with nothing mapped unless the
 * checks take their inputs as functions, and a continuous-integration runner
 * has nothing mapped by definition. So the mapped-drive case is driven
 * through an injected resolver reporting what a real mapping reports. That is
 * the case the second check exists for, and the case a string-inspection
 * implementation silently fails.
 */

/** A resolver that reports the given mapping, and otherwise resolves to itself. */
function resolverReporting(mapping: Record<string, string>): NetworkPathChecks {
  return {
    resolveRealPath: (target) => mapping[target] ?? target,
    hasNetworkShareRoot,
  };
}

test('a path written as a share is refused', () => {
  const target = sharePath('host', 'share', 'broker.db');
  assert.throws(
    () => {
      refuseNetworkLocation(target, resolverReporting({}));
    },
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.equal(error.rule, 'store.not_on_network_filesystem');
      return true;
    },
  );
});

test('a share written with forward slashes is refused too', () => {
  // The two spellings normalise differently, so matching one catches half the
  // cases. This test fails if the root check stops testing both.
  const target = shareForwardSlashPath('host', 'share', 'broker.db');
  assert.throws(() => {
    refuseNetworkLocation(target, resolverReporting({}));
  }, StartupRefusal);
});

test('a local-looking path on a network volume is refused — the mapped-drive case', () => {
  // Lexically identical to a local path. Nothing in the string says
  // otherwise, which is the entire reason a second check exists.
  const target = localDrivePath('Z', 'broker.db');
  const resolved = sharePath('host', 'share');

  // The first check must NOT be what refuses this, or the test proves
  // nothing about the second.
  assert.equal(hasNetworkShareRoot(target), false);

  assert.throws(
    () => {
      refuseNetworkLocation(target, resolverReporting({ [target]: resolved }));
    },
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.equal(error.rule, 'store.not_on_network_filesystem');
      assert.match(error.message, /resolves to a network share/);
      return true;
    },
  );
});

test('a local path is allowed', () => {
  const target = localDrivePath('C', 'broker.db');
  assert.doesNotThrow(() => {
    refuseNetworkLocation(target, resolverReporting({ [target]: target }));
  });
});

test('a root-relative path is not mistaken for a share', () => {
  // Two separators is a share; one is a path on the current drive. A root
  // check that tested for "starts with a separator" would refuse this.
  assert.equal(hasNetworkShareRoot(localDrivePath('C', 'stores', 'broker.db')), false);
  assert.equal(hasNetworkShareRoot('broker.db'), false);
});

test('the share root check reads the root, not the rest of the path', () => {
  // A local path whose *segments* happen to contain a doubled separator must
  // not be read as a share.
  assert.equal(hasNetworkShareRoot(sharePath('host', 'share')), true);
  assert.equal(hasNetworkShareRoot(localDrivePath('D', 'work', 'broker.db')), false);
});

test('a share-shaped value is refused whatever this platform makes of the string', () => {
  // The same configuration must not refuse on one platform and quietly create
  // a strangely-named local file on another. A platform whose separator is
  // the forward slash does not read the two-backslash spelling as a root at
  // all, so resolving it prefixes the working directory and the share root is
  // lost — which is why the value is checked as configured, before any
  // platform's path rules touch it.
  const configured = sharePath('host', 'share', 'broker.db');
  const flattenedByThisPlatform = `/working/directory/${configured}`;

  // Standing in for what a forward-slash platform's resolver does to it.
  assert.equal(hasNetworkShareRoot(flattenedByThisPlatform), false);

  // The refusal still fires, because the configured form is checked too.
  assert.throws(() => {
    refuseNetworkLocation(configured, resolverReporting({}));
  }, StartupRefusal);
});
