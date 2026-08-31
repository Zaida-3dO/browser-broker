import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Environment } from '../../src/config/environment.ts';
import { prepareStore, type StoreHandle } from '../../src/store/open.ts';
import { removeDirectory } from './remove-directory.ts';

/**
 * A store in a temporary directory, and the means to tear it down.
 *
 * The path is computed from the platform's own temporary directory rather
 * than written down, for the same reason the application-data default is
 * computed: a literal path names one machine, and the hygiene gate refuses
 * one in a tracked file.
 */
export interface TempStore {
  readonly directory: string;
  readonly environment: Environment;
  readonly remove: () => void;
}

/**
 * What a test may vary about the environment its store runs under.
 *
 * Only the numbers, because the paths are what the temporary directory is
 * for. A test that wants a budget of one says so here rather than setting a
 * process-wide variable, which would be read by every other test in the same
 * process.
 */
export interface TempStoreOptions {
  readonly tabBudget?: number;
  readonly leaseSeconds?: number;
  readonly queueSeconds?: number;
  readonly launchReadinessTimeoutSeconds?: number;
  /**
   * The configured browsers (`DECISIONS.md` §13i), overridable per test so
   * one test's browser list cannot leak into another's process — the same
   * reasoning the budget override above is given.
   */
  readonly regularBrowsers?: readonly string[];
  readonly privateBrowsers?: readonly string[];
}

/**
 * Every temporary store this process made and has not yet removed.
 *
 * **The dominant leak was never a failed delete — it was a delete that never
 * ran.** A store whose owning process is killed part-way through a run (a
 * Ctrl-C, a CI timeout, a runner torn down) leaves a fully-stepped database
 * behind because the `finally` holding its `remove()` never executes. Those
 * directories are indistinguishable from a successful run's, which is why
 * they accumulated unnoticed.
 *
 * An exit sweep closes the ordinary case: `process.on('exit')` runs on a
 * normal end and on an uncaught throw. It deliberately cannot help with
 * `SIGKILL`, which by definition runs nothing — no amount of handler will
 * catch that, and pretending otherwise would be the kind of half-measure that
 * reads as a guarantee.
 */
const pendingDirectories = new Set<string>();

let sweepInstalled = false;

function installSweep(): void {
  if (sweepInstalled) return;
  sweepInstalled = true;
  process.on('exit', () => {
    for (const directory of pendingDirectories) {
      // Best-effort, and silent by design: this runs *after* the run's result
      // is decided, so throwing here could only turn a decided outcome into a
      // confusing one. The loud path is `remove()`, which a test still owns.
      try {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch {
        // Nothing useful to do at exit; the directory survives and will be
        // found by the sweep the next run performs.
      }
    }
    pendingDirectories.clear();
  });
}

export function makeTempStore(options: TempStoreOptions = {}): TempStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-test-'));
  installSweep();
  pendingDirectories.add(directory);
  return {
    directory,
    environment: {
      databasePath: path.join(directory, 'broker.db'),
      configuredDatabasePath: path.join(directory, 'broker.db'),
      artifactsRoot: path.join(directory, 'artefacts'),
      profileRoot: path.join(directory, 'profiles'),
      // The declared defaults (§6.2). A test that needs a different budget
      // overrides this field rather than reaching for the environment, so
      // one test's ceiling cannot leak into another's process.
      tabBudget: options.tabBudget ?? 15,
      leaseSeconds: options.leaseSeconds ?? 600,
      queueSeconds: options.queueSeconds ?? 600,
      launchReadinessTimeoutSeconds: options.launchReadinessTimeoutSeconds ?? 30,
      regularBrowsers: options.regularBrowsers ?? ['regular'],
      privateBrowsers: options.privateBrowsers ?? ['private'],
      regularBrowserEngine: 'msedge',
      privateBrowserEngine: 'msedge',
    },
    remove: () => {
      // Removed from the sweep first, so a directory this call genuinely
      // removes is not visited again at exit — and so a directory whose
      // removal *throws* has still had its one owner, this call, report it.
      pendingDirectories.delete(directory);
      removeDirectory(directory);
    },
  };
}

/**
 * A store opened, stepped and torn down around one piece of work.
 *
 * Every test that needs the schema needs the same six lines of setup, and six
 * lines repeated is six lines somebody eventually gets subtly wrong.
 */
export async function withSteppedStore(
  fn: (store: StoreHandle, temp: TempStore) => Promise<void> | void,
  options: TempStoreOptions = {},
): Promise<void> {
  const temp = makeTempStore(options);
  try {
    const store = await prepareStore(temp.environment);
    try {
      await fn(store, temp);
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
}
