import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DECLARED_VARIABLES, readEnvironment } from '../../src/config/environment.ts';
import { StartupRefusal } from '../../src/errors.ts';

/**
 * `BROKER_UPLOAD_ROOT`: the one variable with no default, and the startup
 * refusals that keep it away from everything this service owns.
 *
 * ── Why these use real directories ──────────────────────────────────────
 *
 * The overlap check resolves both sides through `resolveRealPath` before
 * comparing, because two lexically different paths can be one directory
 * through a link — which is the same trap the upload guard itself is built
 * around, applied to configuration. Resolving asks the filesystem, so a
 * fixture of invented paths would be comparing something other than what runs
 * in production. These make real directories and throw them away.
 *
 * ── What each test is written against ───────────────────────────────────
 *
 * **Both directions**, separately, for each of the three reserved locations.
 * The mutation this catches is the obvious one: an implementation that asks
 * only "is the upload root inside the profile root" passes three of these six
 * and fails the other three. One test covering "they overlap" would not
 * distinguish them.
 */

/** A directory tree to point the variables at, removed afterwards. */
function withDirectories(run: (base: string) => void): void {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'broker-config-')));
  try {
    run(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** The three variables pointed at separate directories, plus whatever is added. */
function environmentAt(base: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    BROKER_DB: path.join(base, 'store', 'broker.db'),
    BROKER_ARTIFACTS_ROOT: path.join(base, 'artefacts'),
    BROKER_PROFILE_ROOT: path.join(base, 'profiles'),
    ...extra,
  };
}

const home = (): string => path.join(path.sep, 'home', 'someone');

function read(env: Record<string, string>): ReturnType<typeof readEnvironment> {
  return readEnvironment({ env, homedir: home, platform: process.platform });
}

/** Assert a refusal that names both variables, so an operator can act on it. */
function refusesNaming(env: Record<string, string>, otherVariable: string): void {
  assert.throws(
    () => read(env),
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal, 'expected a StartupRefusal');
      assert.match(error.message, /BROKER_UPLOAD_ROOT/u);
      assert.match(error.message, new RegExp(otherVariable));
      return true;
    },
  );
}

/* ─────────────────── unset means off, not a default ─────────────────── */

test('the upload root is declared, so .env.example and the reachability check see it', () => {
  assert.ok(DECLARED_VARIABLES.includes('BROKER_UPLOAD_ROOT'));
});

test('unset leaves the upload root undefined rather than defaulting to anywhere', () => {
  // **The mutation this catches is a fallback being added.** Every other path
  // variable has one; this one must not, because a default would hand inbound
  // filesystem reach to every installation on upgrade. A fallback of any kind
  // makes this a string and fails here.
  const environment = readEnvironment({ env: {}, homedir: home, platform: 'linux' });
  assert.equal(environment.uploadRoot, undefined);
});

test('a set upload root is resolved and carried', () => {
  withDirectories((base) => {
    const uploads = path.join(base, 'uploadable');
    fs.mkdirSync(uploads, { recursive: true });
    const environment = read(environmentAt(base, { BROKER_UPLOAD_ROOT: uploads }));
    assert.equal(environment.uploadRoot, path.resolve(uploads));
  });
});

test('set but empty refuses, and says unsetting switches the capability off', () => {
  withDirectories((base) => {
    assert.throws(
      () => read(environmentAt(base, { BROKER_UPLOAD_ROOT: '   ' })),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal);
        assert.match(error.message, /BROKER_UPLOAD_ROOT/u);
        // Not the ordinary path message: unsetting this one does not select a
        // default, it turns the verb off, and the sentence has to say so.
        assert.match(error.message, /off/iu);
        return true;
      },
    );
  });
});

test('a value containing a null byte refuses, naming the variable', () => {
  withDirectories((base) => {
    assert.throws(
      () => read(environmentAt(base, { BROKER_UPLOAD_ROOT: `${base}\0evil` })),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal);
        assert.match(error.message, /BROKER_UPLOAD_ROOT/u);
        return true;
      },
    );
  });
});

/* ────────── overlap, three locations, both directions each ────────── */

test('an upload root CONTAINING the profile root refuses', () => {
  withDirectories((base) => {
    fs.mkdirSync(path.join(base, 'profiles'), { recursive: true });
    // The plausible-typo case: naming the parent everything lives under.
    refusesNaming(environmentAt(base, { BROKER_UPLOAD_ROOT: base }), 'BROKER_PROFILE_ROOT');
  });
});

test('an upload root INSIDE the profile root refuses', () => {
  withDirectories((base) => {
    const inside = path.join(base, 'profiles', 'shared');
    fs.mkdirSync(inside, { recursive: true });
    refusesNaming(environmentAt(base, { BROKER_UPLOAD_ROOT: inside }), 'BROKER_PROFILE_ROOT');
  });
});

test('an upload root CONTAINING the artefact root refuses', () => {
  withDirectories((base) => {
    fs.mkdirSync(path.join(base, 'artefacts'), { recursive: true });
    const env = environmentAt(base, { BROKER_UPLOAD_ROOT: base });
    // Point the profile root elsewhere so this test is about the artefact
    // root rather than tripping the previous refusal first.
    const elsewhere = path.join(base, '..', path.basename(base) + '-profiles');
    fs.mkdirSync(elsewhere, { recursive: true });
    try {
      refusesNaming({ ...env, BROKER_PROFILE_ROOT: elsewhere }, 'BROKER_ARTIFACTS_ROOT');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

test('an upload root INSIDE the artefact root refuses', () => {
  withDirectories((base) => {
    const inside = path.join(base, 'artefacts', 'incoming');
    fs.mkdirSync(inside, { recursive: true });
    refusesNaming(environmentAt(base, { BROKER_UPLOAD_ROOT: inside }), 'BROKER_ARTIFACTS_ROOT');
  });
});

test("an upload root CONTAINING the store's directory refuses", () => {
  withDirectories((base) => {
    const store = path.join(base, 'store');
    fs.mkdirSync(store, { recursive: true });
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'broker-other-')));
    try {
      refusesNaming(
        {
          BROKER_DB: path.join(store, 'broker.db'),
          BROKER_ARTIFACTS_ROOT: path.join(outside, 'artefacts'),
          BROKER_PROFILE_ROOT: path.join(outside, 'profiles'),
          BROKER_UPLOAD_ROOT: base,
        },
        'BROKER_DB',
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("an upload root INSIDE the store's directory refuses", () => {
  withDirectories((base) => {
    const inside = path.join(base, 'store', 'uploads');
    fs.mkdirSync(inside, { recursive: true });
    refusesNaming(environmentAt(base, { BROKER_UPLOAD_ROOT: inside }), 'BROKER_DB');
  });
});

test('an upload root that is the same directory as a reserved one refuses', () => {
  withDirectories((base) => {
    const profiles = path.join(base, 'profiles');
    fs.mkdirSync(profiles, { recursive: true });
    // Identity is the degenerate case of containment in both directions, and
    // `path.relative` answers the empty string for it — which a check written
    // as `startsWith('..')` alone would read as "contained, fine".
    refusesNaming(environmentAt(base, { BROKER_UPLOAD_ROOT: profiles }), 'BROKER_PROFILE_ROOT');
  });
});

test('a sibling that merely shares a name prefix is NOT refused', () => {
  withDirectories((base) => {
    // The mutation this catches: comparing with `startsWith` on the strings.
    // `…/profiles-incoming` begins with `…/profiles` and is not inside it, so
    // a prefix comparison refuses a configuration that is perfectly fine.
    const uploads = path.join(base, 'profiles-incoming');
    fs.mkdirSync(uploads, { recursive: true });
    fs.mkdirSync(path.join(base, 'profiles'), { recursive: true });
    const environment = read(environmentAt(base, { BROKER_UPLOAD_ROOT: uploads }));
    assert.equal(environment.uploadRoot, path.resolve(uploads));
  });
});

test('an upload root reaching a reserved directory through a link refuses', (t) => {
  withDirectories((base) => {
    const profiles = path.join(base, 'profiles');
    fs.mkdirSync(profiles, { recursive: true });
    const link = path.join(base, 'looks-innocent');
    try {
      fs.symlinkSync(profiles, link, 'dir');
    } catch {
      // Stated rather than passing quietly: this is the test that proves the
      // comparison is on resolved paths rather than on the strings.
      t.skip('this platform does not permit creating a link without elevation');
      return;
    }
    refusesNaming(environmentAt(base, { BROKER_UPLOAD_ROOT: link }), 'BROKER_PROFILE_ROOT');
  });
});

test('three separate directories start cleanly', () => {
  withDirectories((base) => {
    const uploads = path.join(base, 'uploadable');
    fs.mkdirSync(uploads, { recursive: true });
    fs.mkdirSync(path.join(base, 'profiles'), { recursive: true });
    fs.mkdirSync(path.join(base, 'artefacts'), { recursive: true });
    fs.mkdirSync(path.join(base, 'store'), { recursive: true });
    // Over-refusal is a real failure: a check that refused everything would
    // pass every test above and make the verb unusable.
    const environment = read(environmentAt(base, { BROKER_UPLOAD_ROOT: uploads }));
    assert.equal(environment.uploadRoot, path.resolve(uploads));
  });
});
