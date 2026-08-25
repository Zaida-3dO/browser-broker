import { createRequire } from 'node:module';

import { createBroker, type Broker } from '../../src/service/broker.ts';
import type { Environment } from '../../src/config/environment.ts';
import type { OrphanedTab } from '../../src/service/arbitration.ts';
import { prepareStore, type StoreHandle } from '../../src/store/open.ts';
import { makeTempStore, type TempStoreOptions } from './temp-store.ts';

/**
 * A service bound to a temporary store, with the tabs it asked to close
 * recorded rather than closed.
 *
 * **The closed list is the physical side-effect these tests assert on.**
 * `CLAUDE.md`: a rejection test asserts the response *and* that the driver was
 * never asked to do the thing, because a guard that returns "denied" after the
 * tab has already opened is worse than no guard.
 */
export interface BrokerFixture {
  readonly broker: Broker;
  readonly store: StoreHandle;
  /**
   * The environment this store was built with.
   *
   * Exposed because the commands that establish profiles need the same
   * snapshot the service was bound to (§6.3: one per process). A test that
   * built its own would be a second snapshot, and the profile root it named
   * would not be the one the service is using.
   */
  readonly environment: Environment;
  /** Every tab the service asked to close, in the order it asked. */
  readonly closed: OrphanedTab[];
  /** A second, read-only connection — see {@link readCommitted}. */
  readonly readCommitted: <T>(sql: string, parameters?: Record<string, unknown>) => T[];
}

export async function withBroker(
  fn: (fixture: BrokerFixture) => Promise<void> | void,
  options: TempStoreOptions = {},
): Promise<void> {
  const temp = makeTempStore(options);
  try {
    const store = await prepareStore(temp.environment);
    const closed: OrphanedTab[] = [];

    // A second connection, read-only, opened on the same file.
    //
    // **This is the house rule the mutation sweep caught a test breaking**: a
    // read through the store's own handle sees the transaction's own
    // uncommitted writes, so an assertion about what *committed* made through
    // it can pass while the violation is present. Anything asserting a
    // durable fact reads here instead.
    const Database = createRequire(import.meta.url)(
      'better-sqlite3',
    ) as typeof import('better-sqlite3');
    const reader = new Database(temp.environment.databasePath, { readonly: true });

    try {
      await fn({
        store,
        environment: temp.environment,
        closed,
        broker: createBroker({
          store,
          environment: temp.environment,
          adapter: 'cli',
          closeTab: (tab) => {
            closed.push(tab);
          },
        }),
        readCommitted: <T>(sql: string, parameters: Record<string, unknown> = {}): T[] =>
          reader.prepare(sql).all(parameters) as T[],
      });
    } finally {
      reader.close();
      store.close();
    }
  } finally {
    temp.remove();
  }
}

/** A claim with the mandatory fields filled in, so a test states only what it varies. */
export function claimInput(
  overrides: Partial<Parameters<Broker['claim']>[0]> = {},
): Parameters<Broker['claim']>[0] {
  return {
    sessionId: 'session-a',
    browser: 'regular',
    purpose: 'exercising the arbitration core',
    ...overrides,
  };
}
