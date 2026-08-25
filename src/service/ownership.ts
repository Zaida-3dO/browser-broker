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
 * ── The name says which of the two tab resolvers this is ────────────────
 *
 * `tabs.ts` has a sibling, {@link findOpenOwnedTab}, and the two are **not**
 * interchangeable: this one throws a {@link CallRefusal} and writes a ledger
 * row, and it resolves a tab in **any** state; that one returns `undefined`
 * and requires the tab to be `open`.
 *
 * Both were called `resolveOwnedTab`. Under lazy opening the difference is not
 * cosmetic — a caller reaching for the wrong one would get `undefined` on every
 * first call, because the tab is not open yet, and no tab could ever be driven.
 * The names now say which is which rather than leaving the next reader to
 * compare signatures.
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
