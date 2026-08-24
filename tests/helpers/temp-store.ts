import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Environment } from '../../src/config/environment.ts';

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
      artifactsRoot: path.join(directory, 'artefacts'),
      profileRoot: path.join(directory, 'profiles'),
    },
    remove: () => {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
