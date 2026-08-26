import type { Database } from 'better-sqlite3';

import type { AppendEvent, EventAdapter, EventKind } from './events.ts';
import { CallRefusal } from './refusals.ts';
import type { ResolvedLease } from './leases.ts';

/**
 * `tab.owned` and `tab.open` (§7.1, `MILESTONES.md` #18) — every tab-addressed
 * operation refuses a tab not owned by the key.
 *
 * ── One code for two rules, and the sharing is the point ────────────────
 *
 * §7.1 says it outright: an unowned tab gets **"the same refusal as an
 * unknown tab, so probing cannot discover another lease's tabs"**. Two rules,
 * two ledger rows, one code — **a caller able to tell them apart is a caller
 * able to enumerate tabs it does not own.** So the ledger records which rule
 * fired, because that question is asked by whoever is reading the record, and
 * the caller is told the same sentence either way.
 *
 * ── Why this is a lookup and not a comparison the caller can influence ──
 *
 * §1.4: `claim_id` is **the ownership fact**, set once, never null, never
 * changed. There is no state in which a tab has two owners, so the check is a
 * single equality against a column the caller cannot write — not a rule
 * maintaining an invariant, but a read of one the schema already keeps.
 *
 * **The tab identifier is not the security boundary** and is not treated as
 * one: it is opaque so that holding one tells you nothing about any other,
 * and ownership is checked against the lease key on every call regardless.
 */

/**
 * Resolve a tab the caller named, **refusing** anything the lease does not own.
 *
 * **Both refusals produce the same sentence and the same code**, and the
 * sentence deliberately says nothing about whether the tab exists. A message
 * distinguishing *"no such tab"* from *"not yours"* is an oracle: a caller
 * could walk identifiers and learn which ones are real.
 *
 * ── This is the only tab resolver, and the name carries a warning ───────
 *
 * It resolves a tab in **any** state, throws a {@link CallRefusal} and writes
 * a ledger row. The name says `OrRefuse` because that is the whole contract.
 *
 * A sibling that resolved only tabs in state `open` and answered `undefined`
 * instead of throwing is a tempting thing to add, and it is a trap worth
 * naming here so it is not rediscovered by experiment. **Under lazy opening a
 * resolver requiring `open` returns nothing on every first call**, because
 * the tab has not been opened yet — so a caller reaching for it to authorise
 * an operation finds that no tab can ever be driven at all. If a call site
 * seems to want that behaviour, the call site is the thing to look hard at.
 */
export function resolveOwnedTabOrRefuse(
  db: Database,
  lease: ResolvedLease,
  tabId: string,
  options: {
    readonly adapter: EventAdapter;
    readonly kind: EventKind;
    /** Where a denial goes — see `resolveLease` for why this is not `append`. */
    readonly recordRefusal: (event: AppendEvent) => void;
  },
): { readonly tabId: string; readonly browserId: string; readonly driverTabId: string | null } {
  const row = db
    .prepare(
      `SELECT id AS tabId, claim_id AS claimId, browser_id AS browserId,
              driver_tab_id AS driverTabId, state
         FROM tabs
         WHERE id = @tabId`,
    )
    .get({ tabId }) as
    | {
        tabId: string;
        claimId: string;
        browserId: string;
        driverTabId: string | null;
        state: string;
      }
    | undefined;

  // Unknown and unowned take the same branch on purpose: the guard recorded
  // differs, the answer does not.
  if (row === undefined || row.claimId !== lease.claimId) {
    options.recordRefusal({
      kind: options.kind,
      outcome: 'deny',
      guard: 'tab.owned',
      adapter: options.adapter,
      claimId: lease.claimId,
      sessionId: lease.sessionId,
      browserId: lease.browserId,
      detail: { requested: tabId, known: row !== undefined },
    });
    throw new CallRefusal('tab_not_found', notFoundSentence(tabId));
  }

  if (row.state !== 'opening' && row.state !== 'open') {
    options.recordRefusal({
      kind: options.kind,
      outcome: 'deny',
      guard: 'tab.open',
      adapter: options.adapter,
      claimId: lease.claimId,
      tabId: row.tabId,
      sessionId: lease.sessionId,
      browserId: row.browserId,
      detail: { requested: tabId, state: row.state },
    });
    throw new CallRefusal('tab_not_found', notFoundSentence(tabId));
  }

  return { tabId: row.tabId, browserId: row.browserId, driverTabId: row.driverTabId };
}

/**
 * The one sentence both refusals use.
 *
 * Written once so the two cannot drift apart. If they ever differ by a word,
 * the difference is the oracle this rule exists to close.
 */
function notFoundSentence(tabId: string): string {
  return `This lease has no open tab ${JSON.stringify(tabId)}. A tab belongs to exactly one lease and is only addressable by the key that holds it.`;
}
