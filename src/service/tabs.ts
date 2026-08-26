import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type { BrowserId } from '../browser/driver.ts';

/**
 * Tab lifecycle: the identifier mapping, and the two writes that bring a tab
 * into being (row #21).
 *
 * ── The one rule this file exists to keep ───────────────────────────────
 *
 * **The driver's name for a tab is never returned to a caller on any
 * surface.** `SCHEMA.md` §1.4 puts the consequence plainly: exposing it
 * "hands callers a second, non-opaque way to name a tab, which is the
 * addressing bug arriving through a different door". Callers hold
 * `tabs.id` — a value carrying no information about any other tab, so there
 * is no index arithmetic to get wrong and the whole class of
 * landed-on-the-wrong-tab bugs is deleted rather than guarded.
 *
 * So this module is the **only** place the two namespaces meet, and the
 * direction is one-way by construction: {@link recordTabOpened} takes the
 * driver's name *in* and nothing here hands one back. **Nothing this module
 * returns carries a driver name** — `reserveTab` answers with the opaque
 * identifier and `recordTabOpened` answers with nothing. That is the
 * structural half.
 *
 * The conventional half, said rather than implied: nothing stops a future
 * module selecting `driver_tab_id` out of the store itself and putting it in
 * a response. The column is right there and SQL is not type-checked. What
 * makes that visible is that it would have to be written — a fresh query,
 * naming the column, in a file that is not this one — rather than falling out
 * of reusing a shape that already carries it.
 *
 * ── This module does not reconcile against a browser, and that is a fact ─
 * ── about the design rather than an omission to be quietly filled in ─────
 *
 * There is a strong pull toward putting reconciliation here, because this is
 * where tab rows live. Resist it, and know what is already true before
 * adding anything:
 *
 * **Reclaiming capacity from callers that died is the reason a lease is safe
 * to grant at all**, and that mechanism is `arbitration.ts`, not this file.
 * Its `sweep()` runs as step 1 of **every** arbitration call, expires every
 * lapsed claim across the whole store, and collects the tabs they held.
 * `updateSweptTabs` is exported from there so that release and sweep cannot
 * spell one rule twice — a hazard with a real precedent in this store, where
 * two writers each moved a tab to `closing` and disagreed, violating the
 * schema's own check on the ordinary path. The after-commit close is
 * scheduled by `runArbitration`, outside the transaction, which is what keeps
 * §2.4b (`arbitration.no_browser_io`) true.
 *
 * **If you came here to change how a dead lease's tabs are cleaned up, that
 * is the file, not this one.** A second spelling of that rule placed here
 * would be reached by nothing, and the tests around it would stay green while
 * the running behaviour diverged.
 *
 * ── The half of row #21 this build does not implement ───────────────────
 *
 * `MILESTONES.md` #21 asks for reconciliation against a **live** browser:
 * asking what it actually has open, closing a page no live lease owns, and
 * closing a row a live lease believes it owns that is not there. **No path in
 * `src/` calls `listTabs`**, so the service never asks that question. That
 * gap is recorded on #21 itself and carries its own row.
 *
 * A design for it belongs in a shape that keeps §2.4b obvious rather than
 * incidental: the deciding must be a pure function over what the browser said
 * and what the store holds, the writing must take a database handle and no
 * session, and the asking must sit visibly between them. A single function
 * holding a driver and a database handle at once is the shape that ends up
 * called from inside a transaction, because it is the only thing that looks
 * like it does the whole job.
 */

/** How long a database timestamp is spelled everywhere in this store. */
function now(): string {
  return new Date().toISOString();
}

/**
 * Reserve the row for a tab that is about to be opened, and return its opaque
 * identifier.
 *
 * **The row is written before the browser is asked**, in state `opening` with
 * no driver name — which is what §1.4's `CHECK ((state = 'opening') =
 * (driver_tab_id IS NULL))` is describing. The order is not an
 * implementation detail:
 *
 * - The identifier a caller will be given has to exist before anything can
 *   fail, or a tab that opened and then lost its answer is a page in a
 *   browser with no row naming it — a leak nothing can find, because the
 *   administrative operation that clears leaked tabs (§4.3) selects on rows.
 * - It is the half of the work that belongs in the arbitration transaction.
 *   Opening the tab is browser work and belongs after the commit (§2.4b), so
 *   the split has to fall exactly here.
 *
 * The consequence is a row that can sit in `opening` forever if the open
 * never completes, and that is the honest outcome rather than a gap: a lease
 * whose tab never opened is visible as a lease whose tab never opened.
 */
export function reserveTab(db: Database, claimId: string, browserId: BrowserId): string {
  const tabId = randomUUID();
  db.prepare(
    `INSERT INTO tabs (id, claim_id, browser_id, driver_tab_id, state)
     VALUES (?, ?, ?, NULL, 'opening')`,
  ).run(tabId, claimId, browserId);
  return tabId;
}

/**
 * Record that a reserved tab actually opened, under the driver's name for it.
 *
 * **This is the moment the mapping comes into being**, and it is the only
 * write that sets `driver_tab_id`. `opened_at` is stamped with when the tab
 * opened rather than when anybody noticed, for the same reason §2.4a gives
 * about expiry: the two are different facts and only one of them is about the
 * tab.
 */
export function recordTabOpened(db: Database, tabId: string, driverTabId: string): void {
  const changed = db
    .prepare(
      `UPDATE tabs
          SET driver_tab_id = ?, state = 'open', opened_at = ?, updated_at = ?
        WHERE id = ? AND state = 'opening'`,
    )
    .run(driverTabId, now(), now(), tabId).changes;

  if (changed !== 1) {
    // Not a refusal a caller ever sees: reaching here means this module was
    // asked to open a tab twice, or to open one that was already finished
    // with. Throwing is right because the alternative is a second driver name
    // silently overwriting the first, leaving a real page with no row —
    // exactly the leak `reserveTab` is ordered the way it is to prevent.
    throw new Error(
      `Tab ${tabId} was not awaiting an open, so the driver name could not be recorded against it.`,
    );
  }
}
