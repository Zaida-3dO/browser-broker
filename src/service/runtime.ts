import type { BrokerService } from '../adapter/service-seam.ts';
import type { EventAdapter } from './events.ts';
import { readEnvironment, type Environment } from '../config/environment.ts';
import { openStore, type StoreHandle } from '../store/open.ts';
import { stepSchema } from '../store/schema/step.ts';
import { serviceFor } from './bridge.ts';
import { createBroker } from './broker.ts';

/**
 * What a shipped executable does to get a service: open the store, step it,
 * build the broker, present it through the bridge.
 *
 * ── Why this is a file and not four lines in each binary ────────────────
 *
 * There are two executables — the command line and the tool shim — and they
 * must reach *the same* service, built the same way. Written out twice, the
 * two would be one edit away from a rule that holds on one surface and not
 * the other, which is the failure `SCHEMA.md` §8 exists to make checkable.
 * Written once, "the same rules through every door" is true by construction
 * for the part a binary controls: which service it built.
 *
 * The only thing the two pass differently is {@link EventAdapter}, and that
 * is the one thing that *should* differ — §1.6 keeps one row per decision
 * and records which door it came in through.
 *
 * ── The lifetime this hands back, and why closing is the caller's job ───
 *
 * A store handle is an open file, and this returns one that is open. The
 * caller closes it, because the caller is the one that knows when its work is
 * finished — the command line closes after one command, and the tool shim
 * closes when its input stream ends, which may be many operations later.
 */
export interface Runtime {
  readonly service: BrokerService;
  readonly store: StoreHandle;
  readonly environment: Environment;
  /** Release the store. Safe to call more than once. */
  readonly close: () => void;
}

export interface RuntimeOptions {
  /** Which door, for the ledger (§1.6). */
  readonly adapter: EventAdapter;
  /** The process environment to read configuration from. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build the service a shipped binary serves.
 *
 * ── No browser is attached, and that is a decision, not an omission ─────
 *
 * `BrokerOptions.closeTab` is optional and this does not supply one; the page
 * operations take an optional session source and this supplies none. Both
 * absences are configurations the service already documents rather than
 * states it has never seen: omitting `closeTab` "leaks tabs rather than
 * leases", which the header of `broker.ts` calls "the documented consequence
 * rather than a gap", and `afterCommitWork` returns no work at all when no
 * session was brought.
 *
 * **What that means a caller gets:** every arbitration rule, for real. A
 * claim takes real capacity against the configured budget, queues when the
 * budget is full, and returns a real key. A keyed call renews a real lease. A
 * page verb resolves the lease, checks the tab is that lease's, extends the
 * expiry and writes its row to the ledger. A release gives the capacity back
 * and promotes whoever was waiting. What it does not do is move a page,
 * because there is no page.
 *
 * **Why not attach the real driver here.** Two reasons, both checkable rather
 * than cautious:
 *
 *  1. ~~`real.ts` throws `NotYetImplemented` for `act` and `read`.~~ **No
 *     longer true: rows #22 and #23 have landed, and every member of the seam
 *     is implemented on the real driver.** What remains is that `act` and
 *     `read` write their artefacts into a directory the session is
 *     constructed with, and nothing here yet hands them the per-lease
 *     directory `artifacts/store.ts` owns — so wiring the real driver in means
 *     deciding that, not just passing it. Reason 2 is unchanged and is on its
 *     own sufficient.
 *  2. Attaching means deciding attach-against-launch, and `decideAdoption`'s
 *     `wait` branch is written down as an open question: "what the loser
 *     waits for, and for how long, is row #55's open question... this
 *     decision reports the state and stops; it does not invent a bound".
 *     A binary that invented one would be answering a question the design has
 *     deliberately left open.
 *
 * **And why not the fake.** Because the binary would then report navigations
 * that never happened. `DECISIONS.md` §5 is about exactly this direction of
 * error, and the fake exists to make *nothing happened* assertable in a test,
 * not to stand in for a browser in front of a person.
 *
 * So: the arbitration core is connected and honest about having no browser,
 * and the seam for one is a parameter this function does not yet fill. When
 * rows #22, #23 and #55 land, a session source is what gets added here, and
 * nothing else in either binary changes.
 */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const environment = readEnvironment({ env: options.env });
  const store = openStore(environment);

  try {
    // `SCHEMA.md` §1.2d: every spawn steps the schema. A binary that skipped
    // it would run against whatever version it found.
    await stepSchema(store.db);
  } catch (error) {
    store.close();
    throw error;
  }

  const broker = createBroker({ store, environment, adapter: options.adapter });

  let closed = false;
  return {
    service: serviceFor({ broker, db: store.db }),
    store,
    environment,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      store.close();
    },
  };
}
