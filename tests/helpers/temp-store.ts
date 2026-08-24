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

export function makeTempStore(): TempStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-test-'));
  return {
    directory,
    environment: {
      databasePath: path.join(directory, 'broker.db'),
      configuredDatabasePath: path.join(directory, 'broker.db'),
      artifactsRoot: path.join(directory, 'artefacts'),
      profileRoot: path.join(directory, 'profiles'),
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
  fn: (store: StoreHandle) => Promise<void> | void,
): Promise<void> {
  const temp = makeTempStore();
  try {
    const store = await prepareStore(temp.environment);
    try {
      await fn(store);
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
}
