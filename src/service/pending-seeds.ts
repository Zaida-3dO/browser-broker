import type { StorageSeedEntry } from './storage-seed.ts';

/**
 * Seed entries waiting for the tab they belong to to be opened (§3.2, #65).
 *
 * ── The problem this solves, and why it needed a file ───────────────────
 *
 * `storage_seed` promises one thing: **the values are in the origin's storage
 * before the tab's first navigation.** Two rules the rest of the service is
 * built on make that awkward to arrange, and neither may be bent:
 *
 * 1. **Never browser I/O inside the arbitration transaction** (§2.4b). The
 *    claim that carries the seed is decided in a transaction, so the seed
 *    cannot be written there — and `decideClaim` correctly does not try.
 * 2. **The tab is a row, not a page, until somebody addresses it.** A grant
 *    writes a tab in `opening` with no driver name, and `pageFor` opens the
 *    real page later, after the *next* call's commit. So at the moment the
 *    seed is validated there is no page to write it into.
 *
 * Between those two is a gap with no home: the entries are known at claim
 * time and needed at first-open time. This is that home.
 *
 * ── Why the values are held in memory and never in the store ────────────
 *
 * **A seeded value is a credential** — that is what §3.2 says the argument is
 * *for*, a token fetched from an API. The ledger deliberately records origins
 * and keys and never values, and `StorageSeedRecord` has no field one could
 * live in, so that redaction is structural rather than promised. Writing the
 * values into a table to survive until first open would undo exactly that:
 * the credential would be at rest, in a file, for as long as the row lived,
 * and the careful shape of the ledger row would be beside the point.
 *
 * So the custody is the process's and it is short. The service is daemonless
 * — spawned by its caller, serving that session, exiting with it (§1.0) — so
 * "the life of the process" is the life of the caller's session, and nothing
 * outlives it.
 *
 * ── What that costs, stated rather than implied ─────────────────────────
 *
 * **A lease granted in one process and first addressed from another is not
 * seeded**, and cannot be: the second process never saw the values and the
 * store deliberately does not have them. That case is real — two spawns can
 * share one store — and it is the honest consequence of not persisting
 * credentials rather than an oversight.
 *
 * It is also the case §2.5 already points away from: the seed is an argument
 * on the claim, applied to the tab that claim grants, and a caller that
 * claims and then drives its tab is one caller doing both. What makes the
 * failure safe rather than silent is that the ledger records what was
 * **actually written**, not what was asked for — so a lease whose seed never
 * reached a browser has no `applied` row, and the question §3.2 wants
 * answerable ("which leases started life holding a credential") is answered
 * by what happened rather than by what was requested.
 *
 * ── Drained on read, deliberately ───────────────────────────────────────
 *
 * {@link PendingSeeds.take} removes what it returns. A seed applies **once**,
 * to the first page that tab ever has (§3.2), so a second read must find
 * nothing: a tab replaced later is a different tab with a different row, and
 * re-seeding it would apply an argument the caller made once to a page it
 * never made it about. Draining also means the values stop being held the
 * moment they have been used, which is the shortest custody available.
 */
export interface PendingSeeds {
  /**
   * Hold the entries a granted claim asked for.
   *
   * A no-op for an empty list, so the ordinary claim — which seeds nothing —
   * leaves nothing behind to drain.
   */
  readonly put: (claimId: string, entries: readonly StorageSeedEntry[]) => void;
  /**
   * Take whatever is waiting for a claim, removing it.
   *
   * Returns an empty list when there is nothing, so callers have one shape to
   * handle rather than a `undefined` to branch on.
   */
  readonly take: (claimId: string) => readonly StorageSeedEntry[];
}

/** A store of pending seeds, scoped to one process. */
export function createPendingSeeds(): PendingSeeds {
  const waiting = new Map<string, readonly StorageSeedEntry[]>();

  return {
    put: (claimId, entries) => {
      if (entries.length === 0) {
        return;
      }
      waiting.set(claimId, entries);
    },
    take: (claimId) => {
      const entries = waiting.get(claimId);
      if (entries === undefined) {
        return [];
      }
      waiting.delete(claimId);
      return entries;
    },
  };
}
