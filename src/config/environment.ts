import os from 'node:os';
import path from 'node:path';

import { StartupRefusal } from '../errors.ts';

/**
 * One snapshot of the process environment, read on the way in.
 *
 * `SCHEMA.md` §6.3: "One snapshot of the environment per process, read at
 * the start and used throughout, so every rule inside one operation sees one
 * configuration." There is no cache to go stale and no re-check to schedule,
 * because a process lives for one session.
 *
 * Row #9 turns this into the full registry with the walk test that asserts
 * `.env.example` lists every declared variable. Row #3 declares the three
 * variables that must be known before the store can be opened, which are the
 * three this row's own code reads.
 */

/** A variable's declared type. §6.1: "Values are plain strings and enums." */
type Kind = 'path';

interface Declaration {
  readonly key: string;
  readonly kind: Kind;
  /**
   * Computed, never written down. `SCHEMA.md` §1.0: "Nothing about that path
   * is written down here, because writing one down would name one machine."
   * The hygiene gate enforces the same thing from the other side — a literal
   * application-data path in this file fails `machine-path` or `profile-path`.
   */
  readonly fallback: (home: string, platform: NodeJS.Platform) => string;
}

/**
 * The per-user application-data location the platform defines, assembled from
 * the home directory and ordinary segment strings.
 */
function applicationDataDirectory(home: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Local');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support');
  }
  return path.join(home, '.local', 'share');
}

/** A directory of the service's own under that location. */
function ownDirectory(home: string, platform: NodeJS.Platform): string {
  return path.join(applicationDataDirectory(home, platform), 'browser-broker');
}

const DECLARATIONS = [
  {
    key: 'BROKER_DB',
    kind: 'path',
    fallback: (home, platform) => path.join(ownDirectory(home, platform), 'broker.db'),
  },
  {
    key: 'BROKER_ARTIFACTS_ROOT',
    kind: 'path',
    fallback: (home, platform) => path.join(ownDirectory(home, platform), 'artefacts'),
  },
  {
    key: 'BROKER_PROFILE_ROOT',
    kind: 'path',
    fallback: (home, platform) => path.join(ownDirectory(home, platform), 'profiles'),
  },
] as const satisfies readonly Declaration[];

/** Every variable this build declares. Row #9's walk test reads this. */
export const DECLARED_VARIABLES: readonly string[] = DECLARATIONS.map((d) => d.key);

export interface Environment {
  readonly databasePath: string;
  /**
   * `BROKER_DB` as it was configured, before this platform's path rules were
   * applied to it. The network-location refusal needs it: resolving a path
   * applies the host platform's own idea of what a root is, and that is
   * exactly the information a share-shaped value loses on a platform that
   * does not recognise the spelling.
   */
  readonly configuredDatabasePath: string;
  readonly artifactsRoot: string;
  readonly profileRoot: string;
}

export interface ReadEnvironmentOptions {
  /** The raw environment. Injected so a test does not mutate the real one. */
  readonly env?: NodeJS.ProcessEnv;
  readonly homedir?: () => string;
  readonly platform?: NodeJS.Platform;
}

/**
 * Read a value as its declared type, applying §6.3's table.
 *
 * Unset uses the default; set and valid is used; **set and unreadable
 * refuses, naming the variable**. Falling back to the default silently would
 * run a configuration nobody chose with nothing to notice it by.
 */
function readPath(declaration: Declaration, raw: string | undefined, fallback: string): string {
  if (raw === undefined) {
    return fallback;
  }
  // A path that is empty or blank is set-and-unreadable rather than unset:
  // somebody wrote the variable and meant something by it, and no path is
  // the one thing it cannot mean.
  if (raw.trim() === '') {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set but empty. Expected a filesystem path; unset it to use the default.`,
    );
  }
  // A null byte cannot appear in a path and every filesystem call would
  // throw on it far from here, naming neither the variable nor the value.
  if (raw.includes('\0')) {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set to a value that is not a filesystem path. Expected a path, found a string containing a null byte.`,
    );
  }
  return path.resolve(raw);
}

/**
 * Take the snapshot. Called once, at the start of a spawn.
 *
 * Unrecognised variables are ignored, per §6.3: a process cannot tell an
 * unrecognised variable of its own from any other variable in an environment
 * it shares with everything on the machine.
 */
export function readEnvironment(options: ReadEnvironmentOptions = {}): Environment {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir;
  const home = homedir();

  const resolved = new Map<string, string>();
  for (const declaration of DECLARATIONS) {
    resolved.set(
      declaration.key,
      readPath(declaration, env[declaration.key], declaration.fallback(home, platform)),
    );
  }

  // Every declared key is resolved above, so these cannot be absent. The
  // non-null assertions would be the wrong tool; a throw names the bug.
  const get = (key: string): string => {
    const value = resolved.get(key);
    if (value === undefined) {
      throw new Error(`${key} was declared but not resolved`);
    }
    return value;
  };

  return {
    databasePath: get('BROKER_DB'),
    configuredDatabasePath: env['BROKER_DB'] ?? get('BROKER_DB'),
    artifactsRoot: get('BROKER_ARTIFACTS_ROOT'),
    profileRoot: get('BROKER_PROFILE_ROOT'),
  };
}
