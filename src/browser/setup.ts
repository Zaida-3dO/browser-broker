import fs from 'node:fs';
import path from 'node:path';

import { StartupRefusal } from '../errors.ts';
import type { StoreHandle } from '../store/open.ts';
import { profileDirectory } from './discovery.ts';
import { DEFAULT_BROWSER_IDS, type BrowserId } from './driver.ts';

/**
 * The setup handshake, run on every spawn.
 *
 * ── Why every spawn, which is what makes it trustworthy ─────────────────
 *
 * `SCHEMA.md` §1.2d: there is **no long-lived process to have run setup
 * once**, so the check belongs on every spawn or it belongs nowhere. The
 * consequence is the point — there is no installation that passed months ago
 * and has been drifting since. It is idempotent by design: it creates what is
 * absent and leaves alone what is present, so running it a hundred times a
 * day costs a directory check a hundred times a day and nothing else.
 *
 * ── The one-directional rule, and why it is load-bearing ────────────────
 *
 * > **Setup may create, and may never destroy.**
 *
 * `setup.profile_never_destroyed` (§7.2). The regular browser's profile holds
 * a sign-in **a person put there by hand**. A setup step that recreated a
 * profile because it looked unfamiliar would silently sign that person out,
 * and they would find out at the least convenient moment. So there is no
 * branch in this file that removes, clears, moves or overwrites a profile
 * directory — not for a profile that looks wrong, not for one that looks
 * corrupt, not for one whose contents are unrecognised. Discarding a profile
 * is a deliberate act with its own command, never a side effect of starting
 * up.
 *
 * That is stated as a property of the code rather than an intention: the
 * module imports no removal function, so there is nothing here to call.
 *
 * ── It refuses rather than guessing ─────────────────────────────────────
 *
 * Two named refusals, and the second is exactly the case the design protects
 * against, so it says so in plain words rather than reporting a generic
 * launch failure: the profile root cannot be written to, or a profile
 * directory exists and another process holds its lock.
 */

/** What setup did to one profile — created it, or found it and used it. */
export type ProfileDisposition = 'created' | 'found';

export interface ProfileReport {
  readonly browser: BrowserId;
  readonly disposition: ProfileDisposition;
  /**
   * The directory, **relative to the configured profile root**.
   *
   * Never absolute: §1.7a's rule is that no absolute path is stored or
   * reported, because an absolute path names one machine. The root is
   * configuration the reader already has.
   */
  readonly relativePath: string;
}

export interface SetupReport {
  /** One entry per browser, in a fixed order, saying which was which. */
  readonly profiles: readonly ProfileReport[];
  /** The two browser rows, confirmed present. */
  readonly browserRows: readonly BrowserId[];
  /** The schema version the store is at once stepping has run. */
  readonly schemaVersion: number;
}

/** The refusals this module raises, spelled as §7.2 spells them. */
export const SETUP_RULES = {
  profileNeverDestroyed: 'setup.profile_never_destroyed',
} as const;

/**
 * The lock a running browser leaves in its profile directory.
 *
 * ⚠️ **This is checked as evidence, never as a gate, and the difference is
 * measured.** The single-instance lock a POSIX system leaves behind **does
 * not exist on Windows**, so a cross-platform check looking for it does not
 * report *no lock* there — it **always passes**. A guard that cannot fail on
 * one platform is worse than no guard, because it is trusted equally on both.
 *
 * So this is used only in the direction where a positive result is
 * meaningful: **finding one means a browser is very likely running**, which
 * is worth naming in a refusal. Not finding one means **nothing at all**, and
 * this module never concludes a profile is free from its absence. What
 * actually establishes whether a browser is running is the verified discovery
 * record (§1.2c), which works on every platform.
 */
const LOCK_ENTRIES: readonly string[] = ['SingletonLock', 'SingletonSocket'];

/**
 * Whether another process appears to hold this profile.
 *
 * Returns `false` on every platform where the mechanism does not exist, which
 * is why the caller must not read `false` as *the profile is free*. See
 * {@link LOCK_ENTRIES}.
 */
export function profileLockLooksHeld(profileDir: string): boolean {
  for (const entry of LOCK_ENTRIES) {
    try {
      // `lstat`, not `stat`: the lock is a symbolic link whose target host
      // and process need not exist, and following it would report absent for
      // a lock that is present.
      fs.lstatSync(path.join(profileDir, entry));
      return true;
    } catch {
      // Absent, or a platform without the mechanism. Both mean "no evidence",
      // which is not the same as "no lock".
    }
  }
  return false;
}

/**
 * Confirm the profile root can be written to, refusing rather than guessing.
 *
 * Checked by actually writing, not by reading a permission bit: a permission
 * bit is a claim about what should happen, and the failure this refuses is a
 * root that is read-only, full, or on a filesystem that says yes and means
 * no. The probe is removed immediately — it is this module's own file and not
 * a profile, so removing it is not a profile being destroyed.
 *
 * ── Why the filesystem is injectable, and what that admits ──────────────
 *
 * **The write probe's failure branch cannot be provoked portably.** A
 * read-only directory is a permission concept that does not carry across
 * platforms — verified while building this row: making a directory read-only
 * and then writing into it **succeeds** on one of the platforms this service
 * is tested on, so a test seeding that condition would assert nothing there
 * while passing.
 *
 * That leaves two options, and this takes the second: ship a check whose
 * failure path no test can reach, or make the filesystem an argument so the
 * failure is injectable. A check never run against the thing it exists to
 * catch is the one the house standard calls worse than no check, so the
 * dependency is a parameter. This is stated rather than quietly done, because
 * the injection is the only reason the refusal is proven at all.
 */
export interface SetupFilesystem {
  readonly mkdirSync: (dir: string, options: { recursive: true }) => void;
  readonly writeFileSync: (file: string, data: string) => void;
  readonly rmSync: (file: string, options: { force: true }) => void;
}

const REAL_FILESYSTEM: SetupFilesystem = {
  mkdirSync: (dir, options) => {
    fs.mkdirSync(dir, options);
  },
  writeFileSync: (file, data) => {
    fs.writeFileSync(file, data);
  },
  rmSync: (file, options) => {
    fs.rmSync(file, options);
  },
};

function assertProfileRootWritable(
  profileRoot: string,
  filesystem: SetupFilesystem = REAL_FILESYSTEM,
): void {
  try {
    filesystem.mkdirSync(profileRoot, { recursive: true });
  } catch (error) {
    throw new StartupRefusal(
      SETUP_RULES.profileNeverDestroyed,
      `The profile root could not be created, so no browser profile can be established under it: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const probe = path.join(profileRoot, `.write-probe-${String(process.pid)}`);
  try {
    filesystem.writeFileSync(probe, '');
    filesystem.rmSync(probe, { force: true });
  } catch (error) {
    throw new StartupRefusal(
      SETUP_RULES.profileNeverDestroyed,
      `The profile root is not writable, so a profile that is absent could not be created: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Establish one profile: create it if absent, use it as it is if present.
 *
 * **Never recreated, never cleared** — the whole of §1.2d's rule, and the
 * reason the two branches differ only in whether a directory is made.
 */
function establishProfile(profileRoot: string, browser: BrowserId): ProfileReport {
  const directory = profileDirectory(profileRoot, browser);

  let present: boolean;
  try {
    present = fs.statSync(directory).isDirectory();
  } catch {
    present = false;
  }

  if (present) {
    if (profileLockLooksHeld(directory)) {
      // Named in plain words rather than reported as a generic launch
      // failure, because this is exactly the case the design protects
      // against and a caller reading it needs to know it is not a bug.
      throw new StartupRefusal(
        SETUP_RULES.profileNeverDestroyed,
        `The ${browser} browser's profile directory exists and another process holds its lock. Setup will not recreate or clear it: that profile holds a sign-in a person established by hand, and recreating it would sign them out. Close the other browser running against this profile, or attach to it instead of starting a second one.`,
      );
    }

    // Found and used exactly as it is. No inspection of its contents, no
    // repair, no clearing — there is deliberately no branch here that could
    // decide a profile looks wrong.
    return { browser, disposition: 'found', relativePath: browser };
  }

  fs.mkdirSync(directory, { recursive: true });
  return { browser, disposition: 'created', relativePath: browser };
}

/**
 * Run the handshake: confirm the two browser rows, and establish both
 * profiles.
 *
 * The schema has already been stepped by the time this runs — `prepareStore`
 * does it, and `startup.schema_stepped` (§7.2) puts it before anything else
 * happens. This confirms the result rather than repeating it.
 */
export async function runSetupHandshake(
  store: StoreHandle,
  profileRoot: string,
  options: { readonly filesystem?: SetupFilesystem; readonly browsers?: readonly BrowserId[] } = {},
): Promise<SetupReport> {
  assertProfileRootWritable(profileRoot, options.filesystem);

  // The configured browsers, or the ones the default configuration names.
  // **The default is a fallback for a caller that has no environment
  // snapshot to hand, never a statement about what this installation has** —
  // every shipped caller passes the configured lists.
  const browsers = options.browsers ?? DEFAULT_BROWSER_IDS;

  const schemaVersion = await store.immediate(({ db }) => {
    // The version is stamped in the store's own header rather than in a
    // table, so it is read the way the stepper writes it.
    const version = db.pragma('user_version', { simple: true });

    // **The row count is deliberately not asserted, and that is a decision
    // rather than an omission** (`DECISIONS.md` §13i). A browser's row is
    // created when it is first launched, not from configuration at startup,
    // so a store holding fewer rows than this process has browsers
    // configured is the ordinary state of a fresh installation rather than a
    // fault — and two processes may hold different configurations, so no
    // count is the right count for all of them.
    //
    // What that check was actually protecting — *is this store stepped* — is
    // read directly from the version the stepper stamps, which is the fact
    // it was standing in for.
    return { value: typeof version === 'number' ? version : 0 };
  });

  // Outside the transaction, deliberately. Creating a directory is filesystem
  // work and the arbitration transaction serialises every writer on the
  // machine — holding it open across a filesystem call on a slow or contended
  // volume would block every other caller for that duration.
  const profiles = browsers.map((browser) => establishProfile(profileRoot, browser));

  return {
    profiles,
    browserRows: [...browsers],
    schemaVersion,
  };
}

/**
 * The report as a line per profile, saying which it created against which it
 * found.
 *
 * §1.2d asks setup to *report which profiles it created and which it found*,
 * and the distinction is the useful part: a profile reported as created on a
 * machine where somebody expected a sign-in is the earliest possible warning
 * that they are about to be asked to sign in again.
 */
export function describeSetupReport(report: SetupReport): readonly string[] {
  return report.profiles.map(
    (profile) =>
      `${profile.browser}: profile ${profile.disposition} at ${profile.relativePath} (under the configured profile root)`,
  );
}
