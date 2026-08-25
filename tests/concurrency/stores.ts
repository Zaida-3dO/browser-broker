import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type { Environment } from '../../src/config/environment.ts';
import { prepareStore } from '../../src/store/open.ts';

/**
 * The stores these tests contend over, and their teardown.
 *
 * Two shapes, because the suite proves two different kinds of thing:
 *
 * - {@link withCounterStore} is a bare counter with no application schema at
 *   all. The transaction-mode control needs a table whose only property is
 *   that incrementing it is a read-then-write, so that the pair measures the
 *   transaction mode and nothing else.
 * - {@link withArbitrationStore} is a real stepped store, opened exactly the
 *   way a spawn opens one, for the tests that drive real operations.
 *
 * Paths are computed from the platform's temporary directory rather than
 * written down: a literal path names one machine, and the hygiene gate
 * refuses one in a tracked file.
 */

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

/** A temporary directory, removed however the body ends. */
async function withTempDirectory(fn: (directory: string) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-contention-'));
  try {
    await fn(directory);
  } finally {
    // `force` because a child process on one platform may still be releasing
    // its handle as the test ends, and a teardown that throws would fail a
    // test whose property held.
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * A store holding one counter and nothing else.
 *
 * **Deliberately not the application schema.** The transaction-mode pair is a
 * statement about the store's concurrency behaviour under a widened
 * read-then-write window, and running it against real tables would mix in
 * every constraint and index those tables carry. One row, one integer, and
 * the only interesting thing about it is that raising it requires reading it
 * first.
 *
 * Opened in the same journal mode the application uses, because that mode is
 * the basis of the concurrency model and a control that ran under a different
 * one would be measuring a different system.
 */
export async function withCounterStore(fn: (databasePath: string) => Promise<void>): Promise<void> {
  await withTempDirectory(async (directory) => {
    const databasePath = path.join(directory, 'counter.db');
    const db = new Database(databasePath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE counter (
        only_row INTEGER PRIMARY KEY CHECK (only_row = 1),
        n        INTEGER NOT NULL
      ) STRICT
    `);
    db.prepare('INSERT INTO counter (only_row, n) VALUES (1, 0)').run();
    db.close();

    await fn(databasePath);
  });
}

/** The environment a contention child is given, as variables it will read. */
export interface ArbitrationStoreFixture {
  readonly databasePath: string;
  readonly environment: Environment;
  /** The variables a child process needs to open this same store. */
  readonly childEnv: Readonly<Record<string, string>>;
  /**
   * Read what actually committed, on a connection that took no part in the
   * contention.
   *
   * **This is the house rule, and it is not optional.** A read through a
   * handle that participated sees that connection's own uncommitted writes
   * and can pass while the violation is present. Anything asserting a durable
   * fact goes through here.
   */
  readonly readCommitted: <T>(sql: string, parameters?: Record<string, unknown>) => T[];
}

/**
 * A real store, stepped to the version this build expects, with a budget the
 * test chooses.
 *
 * The store is prepared **in this process** and then closed, so the children
 * are the only things holding it open while they contend. A test process
 * keeping a connection open would be an extra reader in a measurement about
 * how many writers there are.
 */
export async function withArbitrationStore(
  // Synchronous bodies are allowed as well as asynchronous ones: the
  // deterministic ordering test spawns nothing and has nothing to await, and
  // forcing it to be asynchronous would mean writing an `async` the linter
  // then correctly objects to.
  fn: (fixture: ArbitrationStoreFixture) => Promise<void> | void,
  options: {
    readonly tabBudget?: number;
    readonly leaseSeconds?: number;
    readonly queueSeconds?: number;
  } = {},
): Promise<void> {
  await withTempDirectory(async (directory) => {
    const databasePath = path.join(directory, 'broker.db');
    const environment: Environment = {
      databasePath,
      configuredDatabasePath: databasePath,
      artifactsRoot: path.join(directory, 'artefacts'),
      profileRoot: path.join(directory, 'profiles'),
      tabBudget: options.tabBudget ?? 15,
      leaseSeconds: options.leaseSeconds ?? 600,
      queueSeconds: options.queueSeconds ?? 600,
    };

    // Stepped once, here, so the children race over operations rather than
    // over schema creation. A spawn steps on every start and finding the
    // store already at the right version is the ordinary case.
    const store = await prepareStore(environment);
    store.close();

    const reader = new Database(databasePath, { readonly: true });
    try {
      await fn({
        databasePath,
        environment,
        childEnv: {
          BROKER_DB: databasePath,
          BROKER_ARTIFACTS_ROOT: environment.artifactsRoot,
          BROKER_PROFILE_ROOT: environment.profileRoot,
          BROKER_TAB_BUDGET: String(environment.tabBudget),
          BROKER_LEASE_SECONDS: String(environment.leaseSeconds),
          BROKER_QUEUE_SECONDS: String(environment.queueSeconds),
        },
        readCommitted: <T>(sql: string, parameters: Record<string, unknown> = {}): T[] =>
          reader.prepare(sql).all(parameters) as T[],
      });
    } finally {
      reader.close();
    }
  });
}
