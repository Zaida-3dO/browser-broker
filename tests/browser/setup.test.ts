import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { profileDirectory } from '../../src/browser/discovery.ts';
import {
  describeSetupReport,
  profileLockLooksHeld,
  runSetupHandshake,
  SETUP_RULES,
  type SetupFilesystem,
} from '../../src/browser/setup.ts';
import { StartupRefusal } from '../../src/errors.ts';
import { withSteppedStore } from '../helpers/temp-store.ts';

/**
 * The setup handshake, and the rule that makes it safe to run on every spawn:
 * **setup may create, and may never destroy.**
 *
 * The load-bearing test here is the one that seeds a profile with a file in
 * it and asserts the file is still there afterwards. A handshake that
 * recreated a profile because it looked unfamiliar would silently sign out a
 * person who established that sign-in by hand, and they would find out at the
 * least convenient moment.
 */

function temporaryRoot(): { root: string; remove: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-setup-'));
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a first run creates both profiles and reports them as created', async () => {
  const temp = temporaryRoot();
  try {
    await withSteppedStore(async (store) => {
      const report = await runSetupHandshake(store, path.join(temp.root, 'profiles'));

      assert.deepEqual(
        report.profiles.map((p) => p.browser),
        ['regular', 'private'],
      );
      for (const profile of report.profiles) {
        assert.equal(profile.disposition, 'created');
        assert.ok(
          fs.existsSync(profileDirectory(path.join(temp.root, 'profiles'), profile.browser)),
        );
      }
    });
  } finally {
    temp.remove();
  }
});

test('the two browser rows are confirmed, and the schema version is reported', async () => {
  const temp = temporaryRoot();
  try {
    await withSteppedStore(async (store) => {
      const report = await runSetupHandshake(store, path.join(temp.root, 'profiles'));
      assert.deepEqual([...report.browserRows], ['regular', 'private']);
      assert.ok(report.schemaVersion >= 1);
    });
  } finally {
    temp.remove();
  }
});

// THE test of this row. The profile holds a sign-in a person put there by
// hand, and a setup step that recreated it would destroy that silently.
//
// The mutation this catches: any branch that removes, clears or recreates an
// existing profile — a `rmSync` before the `mkdirSync`, or dropping the
// present check so the directory is always made afresh.
test('an existing profile is used as it is — its contents survive setup exactly', async () => {
  const temp = temporaryRoot();
  try {
    const profileRoot = path.join(temp.root, 'profiles');
    const regular = profileDirectory(profileRoot, 'regular');
    fs.mkdirSync(regular, { recursive: true });

    // Stands in for the sign-in a person established by hand.
    const established = path.join(regular, 'established-by-hand');
    fs.writeFileSync(established, 'a session that must survive');

    await withSteppedStore(async (store) => {
      const report = await runSetupHandshake(store, profileRoot);

      const found = report.profiles.find((p) => p.browser === 'regular');
      assert.equal(found?.disposition, 'found');
      assert.ok(fs.existsSync(established), 'the profile contents must not be destroyed');
      assert.equal(fs.readFileSync(established, 'utf8'), 'a session that must survive');
    });
  } finally {
    temp.remove();
  }
});

// Idempotent by design: it runs on every spawn, so running it repeatedly must
// cost a directory check and nothing else.
//
// The mutation this catches: reporting `created` unconditionally, which would
// make the report useless for the thing it exists to tell somebody — that a
// profile they expected to hold a sign-in was made fresh.
test('running the handshake repeatedly reports found after the first, not created', async () => {
  const temp = temporaryRoot();
  try {
    const profileRoot = path.join(temp.root, 'profiles');
    await withSteppedStore(async (store) => {
      const first = await runSetupHandshake(store, profileRoot);
      const second = await runSetupHandshake(store, profileRoot);
      const third = await runSetupHandshake(store, profileRoot);

      assert.ok(first.profiles.every((p) => p.disposition === 'created'));
      assert.ok(second.profiles.every((p) => p.disposition === 'found'));
      assert.ok(third.profiles.every((p) => p.disposition === 'found'));
    });
  } finally {
    temp.remove();
  }
});

test('the report says which it created against which it found, per browser', async () => {
  const temp = temporaryRoot();
  try {
    const profileRoot = path.join(temp.root, 'profiles');
    // One present, one absent, so the report has to distinguish them.
    fs.mkdirSync(profileDirectory(profileRoot, 'regular'), { recursive: true });

    await withSteppedStore(async (store) => {
      const report = await runSetupHandshake(store, profileRoot);
      assert.equal(report.profiles.find((p) => p.browser === 'regular')?.disposition, 'found');
      assert.equal(report.profiles.find((p) => p.browser === 'private')?.disposition, 'created');

      const lines = describeSetupReport(report);
      assert.equal(lines.length, 2);
      assert.ok(lines.some((line) => line.includes('found')));
      assert.ok(lines.some((line) => line.includes('created')));
    });
  } finally {
    temp.remove();
  }
});

// §1.7a: no absolute path is stored or reported, because an absolute path
// names one machine — and this is a public repository whose own hygiene gate
// refuses one in a tracked file.
//
// The mutation this catches: reporting the full directory instead of the
// relative one.
test('reported profile paths are relative to the configured root, never absolute', async () => {
  const temp = temporaryRoot();
  try {
    const profileRoot = path.join(temp.root, 'profiles');
    await withSteppedStore(async (store) => {
      const report = await runSetupHandshake(store, profileRoot);
      for (const profile of report.profiles) {
        assert.equal(path.isAbsolute(profile.relativePath), false);
        assert.equal(profile.relativePath, profile.browser);
      }
      for (const line of describeSetupReport(report)) {
        assert.ok(!line.includes(temp.root), 'a report line must not carry a machine path');
      }
    });
  } finally {
    temp.remove();
  }
});

// The refusal §1.2d asks for by name: another process holds a profile's lock.
// Named in plain words rather than reported as a generic launch failure,
// because this is exactly the case the design protects against.
//
// The mutation this catches: treating a held lock as a reason to recreate the
// profile, or as nothing at all.
test('a profile whose lock is held is refused, and setup does not recreate it', async () => {
  const temp = temporaryRoot();
  try {
    const profileRoot = path.join(temp.root, 'profiles');
    const regular = profileDirectory(profileRoot, 'regular');
    fs.mkdirSync(regular, { recursive: true });
    const established = path.join(regular, 'established-by-hand');
    fs.writeFileSync(established, 'a session that must survive');

    // The lock a running browser leaves. Written as a plain file rather than
    // a link so the test behaves the same on a platform that does not permit
    // an unprivileged symbolic link.
    fs.writeFileSync(path.join(regular, 'SingletonLock'), '');

    await withSteppedStore(async (store) => {
      await assert.rejects(
        runSetupHandshake(store, profileRoot),
        (error: unknown) =>
          error instanceof StartupRefusal && error.rule === SETUP_RULES.profileNeverDestroyed,
      );
      // The refusal must not have taken the profile with it.
      assert.ok(fs.existsSync(established));
    });
  } finally {
    temp.remove();
  }
});

test('the lock refusal explains itself rather than reporting a generic failure', async () => {
  const temp = temporaryRoot();
  try {
    const profileRoot = path.join(temp.root, 'profiles');
    const regular = profileDirectory(profileRoot, 'regular');
    fs.mkdirSync(regular, { recursive: true });
    fs.writeFileSync(path.join(regular, 'SingletonLock'), '');

    await withSteppedStore(async (store) => {
      try {
        await runSetupHandshake(store, profileRoot);
        assert.fail('a held profile lock must be refused');
      } catch (error) {
        assert.ok(error instanceof StartupRefusal);
        assert.match(error.message, /lock/i);
        // The reason recreating is not the answer has to be in the message,
        // because the next person to read it is deciding whether to delete
        // the profile by hand.
        assert.match(error.message, /sign|recreate/i);
      }
    });
  } finally {
    temp.remove();
  }
});

// The lock check is evidence, never a gate, and this pins the honest limit:
// finding one means a browser is very likely running; NOT finding one means
// nothing at all, because the mechanism does not exist on every platform.
test('an absent lock reports no evidence, which is not the same as a free profile', () => {
  const temp = temporaryRoot();
  try {
    assert.equal(profileLockLooksHeld(temp.root), false);
    // And a present one is seen, which is the only direction this check is
    // trusted in. The mechanism does not exist on every platform, so a
    // negative result means nothing and the discovery record is what actually
    // establishes whether a browser is running.
    fs.writeFileSync(path.join(temp.root, 'SingletonLock'), '');
    assert.equal(profileLockLooksHeld(temp.root), true);
  } finally {
    temp.remove();
  }
});

test('a profile root that cannot be written to is refused rather than guessed at', async () => {
  const temp = temporaryRoot();
  try {
    // A file where the root should be: creating a directory under it cannot
    // succeed on any platform, which is what makes this portable.
    const blocked = path.join(temp.root, 'blocked');
    fs.writeFileSync(blocked, 'not a directory');

    await withSteppedStore(async (store) => {
      await assert.rejects(
        runSetupHandshake(store, path.join(blocked, 'profiles')),
        (error: unknown) =>
          error instanceof StartupRefusal && error.rule === SETUP_RULES.profileNeverDestroyed,
      );
    });
  } finally {
    temp.remove();
  }
});

// The mutation this catches: removing the write probe. A root whose
// directory can be created but not written into passes the creation check and
// then fails later, at the point a browser is trying to start — which reports
// a launch failure for what is actually a permissions problem one level up.
//
// The filesystem is injected because this branch cannot be provoked portably:
// making a directory read-only and writing into it anyway SUCCEEDS on one of
// the platforms this suite runs on, so a test seeding that condition would
// pass while asserting nothing. See the note on `SetupFilesystem`.
test('a profile root that accepts a directory but refuses a write is refused', async () => {
  const temp = temporaryRoot();
  try {
    const refusesWrites: SetupFilesystem = {
      mkdirSync: () => {
        // The root is creatable, which is precisely why the write probe is
        // the only thing that can catch this case.
      },
      writeFileSync: () => {
        throw new Error('permission denied');
      },
      rmSync: () => undefined,
    };

    await withSteppedStore(async (store) => {
      await assert.rejects(
        runSetupHandshake(store, path.join(temp.root, 'profiles'), {
          filesystem: refusesWrites,
        }),
        (error: unknown) =>
          error instanceof StartupRefusal &&
          error.rule === SETUP_RULES.profileNeverDestroyed &&
          /not writable/i.test(error.message),
      );
    });
  } finally {
    temp.remove();
  }
});

test('setup leaves no probe file behind in the profile root', async () => {
  const temp = temporaryRoot();
  try {
    const profileRoot = path.join(temp.root, 'profiles');
    await withSteppedStore(async (store) => {
      await runSetupHandshake(store, profileRoot);
      const entries = fs.readdirSync(profileRoot).sort();
      assert.deepEqual(entries, ['private', 'regular']);
    });
  } finally {
    temp.remove();
  }
});
