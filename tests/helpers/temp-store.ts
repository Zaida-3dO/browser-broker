import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Environment } from '../../src/config/environment.ts';
import { prepareStore, type StoreHandle } from '../../src/store/open.ts';

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
}

export function makeTempStore(options: TempStoreOptions = {}): TempStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-test-'));
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
    },
    remove: () => {
      fs.rmSync(directory, { recursive: true, force: true });
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
