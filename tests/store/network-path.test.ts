import assert from 'node:assert/strict';
import test from 'node:test';

import type { Environment } from '../../src/config/environment.ts';
import { StartupRefusal } from '../../src/errors.ts';
import { resolveStoreLocation } from '../../src/store/location.ts';
import {
  hasNetworkShareRoot,
  refuseNetworkLocation,
  type NetworkPathChecks,
} from '../../src/store/network-path.ts';
import { NETWORK_FILESYSTEM_TYPES } from '../../src/store/network-volume.ts';
import {
  checksReporting,
  localDrivePath,
  mountPath,
  shareForwardSlashPath,
  sharePath,
} from '../helpers/paths.ts';

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

test('a path written as a share is refused', () => {
  const target = sharePath('host', 'share', 'broker.db');
  assert.throws(
    () => {
      refuseNetworkLocation(target, checksReporting({}));
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
    refuseNetworkLocation(target, checksReporting({}));
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
      refuseNetworkLocation(target, checksReporting({ mappings: { [target]: resolved } }));
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
    refuseNetworkLocation(target, checksReporting({ mappings: { [target]: target } }));
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
    refuseNetworkLocation(configured, checksReporting({}));
  }, StartupRefusal);
});

/**
 * ── The third check: a mount on a platform with no share spelling ────────
 *
 * These are the tests that would not exist if the guard had been written on
 * one platform and left there. **A cross-platform path guard developed on one
 * platform is untested on the other by construction**: the two spellings of
 * the problem are caught by different checks, and each check is inert on the
 * platform the other one covers. So every case below drives its input through
 * the injected seam and asserts a refusal that has nothing to do with what the
 * machine running the test happens to be.
 */

test('a mount on a network filesystem is refused — the case with no share spelling', () => {
  // An ordinary absolute path. Nothing in the string says share, there is no
  // mapping to resolve, and on this spelling there never will be — which is
  // the entire reason a third check exists.
  const target = mountPath('storage', 'broker.db');

  // Neither of the first two checks may be what refuses this, or the test
  // proves nothing about the third.
  assert.equal(hasNetworkShareRoot(target), false);
  assert.doesNotThrow(() => {
    refuseNetworkLocation(target, checksReporting({}));
  });

  assert.throws(
    () => {
      refuseNetworkLocation(target, checksReporting({ volumeTypes: { [target]: 0x6969 } }));
    },
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.equal(error.rule, 'store.not_on_network_filesystem');
      assert.match(error.message, /network filesystem/);
      return true;
    },
  );
});

test('the protocols in ordinary use are each named in the list and each refused', () => {
  // **Named rather than iterated.** A test that loops the list proves every
  // entry present is refused and says nothing about an entry going missing —
  // deleting one would leave it green. These are the codes the check exists
  // for, so they are written down here and asserted individually.
  const target = mountPath('storage', 'broker.db');
  const mustRefuse = [
    0x517b, // SMB
    0xfe534d42, // SMB2
    0xff534d42, // CIFS
    0x6969, // NFS
    0x5346414f, // AFS
    0x564c, // NCP
    0x65735546, // FUSE
  ];

  for (const type of mustRefuse) {
    assert.ok(
      NETWORK_FILESYSTEM_TYPES.has(type),
      `type 0x${type.toString(16)} is missing from the list`,
    );
    assert.throws(
      () => {
        refuseNetworkLocation(target, checksReporting({ volumeTypes: { [target]: type } }));
      },
      StartupRefusal,
      `type 0x${type.toString(16)} was not refused`,
    );
  }
});

test('every entry in the list refuses, so none of them is inert', () => {
  // The other half of the assertion above: an entry added to the list but
  // unreachable by the check would be a line of documentation pretending to
  // be a guard.
  const target = mountPath('storage', 'broker.db');
  for (const type of NETWORK_FILESYSTEM_TYPES.keys()) {
    assert.throws(
      () => {
        refuseNetworkLocation(target, checksReporting({ volumeTypes: { [target]: type } }));
      },
      StartupRefusal,
      `type 0x${type.toString(16)} was not refused`,
    );
  }
});

test('the refusal names which filesystem it found', () => {
  // A refusal that cannot say what it saw sends the reader to check every
  // mount by hand.
  const target = mountPath('storage', 'broker.db');
  assert.throws(
    () => {
      refuseNetworkLocation(target, checksReporting({ volumeTypes: { [target]: 0xff534d42 } }));
    },
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.match(error.message, /CIFS/);
      return true;
    },
  );
});

test('a local filesystem type is allowed', () => {
  // The type code of an ordinary local filesystem, which must pass. A check
  // that refused everything would satisfy every test above and be useless.
  const target = mountPath('storage', 'broker.db');
  assert.doesNotThrow(() => {
    refuseNetworkLocation(target, checksReporting({ volumeTypes: { [target]: 0xef53 } }));
  });
});

test('a path whose volume cannot be read is allowed rather than refused', () => {
  // A path that does not exist yet is every path on a first spawn. Refusing
  // on an unreadable answer would refuse the ordinary case.
  const target = mountPath('storage', 'broker.db');
  assert.doesNotThrow(() => {
    refuseNetworkLocation(target, checksReporting({}));
  });
});

/**
 * ── Blank space, which walks a share past every check ────────────────────
 */

test('a leading space does not walk a share past the checks', () => {
  // Every check reads the front of the string: the root test sees a space
  // where it expects a separator, and resolution treats the whole thing as a
  // relative name. One invisible character would defeat all three.
  const target = ` ${sharePath('host', 'share', 'broker.db')}`;
  assert.equal(hasNetworkShareRoot(target), false);
  assert.throws(() => {
    refuseNetworkLocation(target, checksReporting({}));
  }, StartupRefusal);
});

test('trailing blank space does not hide a share either', () => {
  const target = `${sharePath('host', 'share', 'broker.db')}\t`;
  assert.throws(() => {
    refuseNetworkLocation(target, checksReporting({}));
  }, StartupRefusal);
});

test('blank space does not hide a mapped drive from the resolver', () => {
  // The mapping is keyed on the trimmed value, so an untrimmed lookup misses
  // it and the mapped-drive case walks through.
  const target = localDrivePath('Z', 'broker.db');
  const resolved = sharePath('host', 'share');
  assert.throws(() => {
    refuseNetworkLocation(` ${target} `, checksReporting({ mappings: { [target]: resolved } }));
  }, StartupRefusal);
});

test('blank space does not hide a network volume from the third check', () => {
  const target = mountPath('storage', 'broker.db');
  assert.throws(() => {
    refuseNetworkLocation(` ${target}`, checksReporting({ volumeTypes: { [target]: 0x6969 } }));
  }, StartupRefusal);
});

/**
 * ── Each check on its own, so no two can cover for each other ────────────
 *
 * The tests above drive a resolver that returns what it was given when no
 * mapping matches, which is what a real local path does. That is realistic and
 * it has one consequence worth closing: **check two then re-tests the same
 * string check one did**, so deleting check one leaves the suite green. The
 * three tests here supply a resolver and a volume reader that answer for a
 * plainly local path, which makes exactly one check capable of refusing.
 */

/** Checks where only the named check can possibly fire. */
function onlyCheckOne(): NetworkPathChecks {
  const local = localDrivePath('C', 'local');
  return {
    // Answers local for everything, so check two cannot refuse anything.
    resolveRealPath: () => local,
    hasNetworkShareRoot,
    readVolumeStatistics: () => undefined,
  };
}

test('check one refuses on its own, with the other two answering local', () => {
  // Deleting the share-root check must fail a test. Without this, check two
  // re-testing the same string covers for its absence.
  const target = sharePath('host', 'share', 'broker.db');
  assert.throws(
    () => {
      refuseNetworkLocation(target, onlyCheckOne());
    },
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.match(error.message, /is on a network share/);
      return true;
    },
  );
});

test('the configured value is checked, not only the resolved one', () => {
  // A platform whose separator is the forward slash flattens a share-shaped
  // value into an ordinary relative name, so the resolved form is local and
  // only the configured form still says share. Skipping the configured check
  // makes this configuration refuse on one platform and quietly create a
  // strangely-named local file on another.
  const configured = sharePath('host', 'share', 'broker.db');
  const flattened = `/working/directory/${configured}`;
  const environment: Environment = {
    // What this platform made of it: no share root left to read.
    databasePath: flattened,
    configuredDatabasePath: configured,
    artifactsRoot: flattened,
    profileRoot: flattened,
    tabBudget: 15,
    leaseSeconds: 600,
    queueSeconds: 600,
    launchReadinessTimeoutSeconds: 30,
    regularBrowsers: ['regular'],
    privateBrowsers: ['private'],
    regularBrowserEngine: 'msedge',
    privateBrowserEngine: 'msedge',
  };

  // The resolved value alone cannot refuse: nothing about it says share.
  assert.equal(hasNetworkShareRoot(flattened), false);

  assert.throws(() => {
    resolveStoreLocation(environment, checksReporting({}));
  }, StartupRefusal);
});

test('a location that was never configured is still checked on its own account', () => {
  // The computed default is a path this build produced, and it is checked
  // rather than trusted. A guard that only ever ran on a configured value
  // would not run at all on the ordinary fresh install.
  const target = mountPath('storage', 'broker.db');
  const environment: Environment = {
    databasePath: target,
    configuredDatabasePath: undefined,
    artifactsRoot: target,
    profileRoot: target,
    tabBudget: 15,
    leaseSeconds: 600,
    queueSeconds: 600,
    launchReadinessTimeoutSeconds: 30,
    regularBrowsers: ['regular'],
    privateBrowsers: ['private'],
    regularBrowserEngine: 'msedge',
    privateBrowserEngine: 'msedge',
  };
  assert.throws(() => {
    resolveStoreLocation(environment, checksReporting({ volumeTypes: { [target]: 0x6969 } }));
  }, StartupRefusal);
});
