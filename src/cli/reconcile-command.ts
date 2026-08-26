import type { Database } from 'better-sqlite3';

import { BROWSER_IDS, type BrowserId, type BrowserSession } from '../browser/driver.ts';
import { append } from '../service/events.ts';
import {
  applyReconciliation,
  decideReconciliation,
  readRecordedTabs,
  type ReconciliationReport,
} from '../service/reconcile.ts';
import { COMMAND_EXIT, parseFlags, type CommandStreams } from './operations-commands.ts';

/**
 * `broker reconcile <browser>` — the administrative operation that asks a
 * live browser what it actually has open (`MILESTONES.md` #21a, `SCHEMA.md`
 * §2.6 step 2, §4.3).
 *
 * ── This is the asking, and it is deliberately visible ──────────────────
 *
 * `service/reconcile.ts` holds the deciding and the writing, and neither can
 * reach a browser. This file is the third part of the shape `tabs.ts`
 * prescribes — *"the asking must sit visibly between them"* — and the whole
 * point of it being a separate file is that {@link runReconcileCommand} reads
 * as five steps in an order a reader can check:
 *
 * ```
 * 1. read the rows        (database)
 * 2. ask the browser      (driver)   ← the asking
 * 3. decide               (pure)
 * 4. write the settlement (database)
 * 5. close the pages      (driver)
 * ```
 *
 * **No transaction is open across any of it**, which is the §2.4b property
 * this whole arrangement exists to make obvious rather than incidental: steps
 * 2 and 5 are round trips to a browser and a browser can hang, so no writer
 * lock is held while either runs. Step 4 is a write, and it is the only one,
 * and it is over in microseconds.
 *
 * ── Why this is a command and not an agent operation ────────────────────
 *
 * §3.13 governs it in one line: *"the agent surface exposes no browser-scoped
 * destructive operation, ever"* — not gated, not flagged, absent. And
 * `browser_scoped.never` (§7.3) makes that a build rule rather than a
 * convention.
 *
 * Reconciliation is exactly such an operation. It closes pages **it has
 * proved no live lease owns**, but the proof is over the whole browser: it
 * reads every live lease on that browser and asks the browser for every page
 * it has. A caller invoking it is acting on shared state that every other
 * caller depends on, and a bug in the proof closes somebody else's tab. §2.7
 * settles the direction: *"Reaping or restarting a browser exists, and it is
 * an administrative operation on a separate surface, never on the agent's."*
 * Reconciliation is the same kind of thing, so it goes to the same place.
 *
 * **§4.3 already exists as that home**, and already names three of these —
 * reap, restart, and clear a leaked tab — as *"commands (§5.4), so a person
 * runs them and the ledger records that a person did"*. This is the fourth,
 * and it needed no new surface to be invented for it.
 *
 * ── Why a command and not an after-commit step ──────────────────────────
 *
 * The tempting alternative is to hang reconciliation off the end of every
 * arbitration call, next to the sweep's own closes. It was rejected, and the
 * reason is cost rather than safety: every arbitration call would grow a
 * `listTabs` round trip to a browser, on a path where §2.4b is careful to
 * make browser work the *exception*. The sweep is cheap because it is a
 * query; this is not, and paying for it on `status` — a call a queued caller
 * is told to make repeatedly (§2.5) — would be paying it hundreds of times to
 * find nothing.
 *
 * It is also the wrong trigger. What makes a page leak is a crash or a person
 * closing a tab by hand, neither of which correlates with somebody arbitrating
 * — so a person noticing, or a scheduled run, is a better signal than the
 * next unrelated caller.
 *
 * ── Why `broker doctor` does not do it ──────────────────────────────────
 *
 * `doctor` *"reports and changes nothing"* (§5.5), and that is a property
 * worth more than the convenience of folding one command into another: a
 * readiness check that closed pages as a side effect would be a readiness
 * check nobody could run safely on a busy machine.
 */

/** What the command needs. A store handle, a browser, and somewhere to write. */
export interface ReconcileCommandOptions {
  readonly db: Database;
  /**
   * Resolve the session for one browser.
   *
   * The runtime's own provider, handed through rather than rebuilt — see
   * `Runtime.session`. Absent when the dispatcher had no runtime to take it
   * from, which is a refusal rather than a guess: a reconciliation that could
   * not ask the browser anything would report every page as gone.
   */
  readonly session?: (browser: BrowserId) => Promise<BrowserSession>;
  readonly streams: CommandStreams;
  readonly json: boolean;
}

/** Timestamps are spelled one way in this store. */
function now(): string {
  return new Date().toISOString();
}

function isBrowserId(value: string): value is BrowserId {
  return (BROWSER_IDS as readonly string[]).includes(value);
}

/**
 * Run one reconciliation against one browser.
 *
 * **One browser per invocation, named explicitly.** There is no `--all`, and
 * the absence is deliberate in the direction §3.13 keeps pointing: the more
 * of the installation one command touches, the worse a mistake in it is. A
 * person who wants both runs it twice and reads two reports.
 */
export async function runReconcileCommand(
  rest: readonly string[],
  options: ReconcileCommandOptions,
): Promise<number> {
  const flags = parseFlags(rest);
  const named = rest.find((word) => !word.startsWith('--'));
  const browser = typeof flags.browser === 'string' ? flags.browser : named;

  if (browser === undefined) {
    options.streams.err(
      `broker reconcile needs to be told which browser: ${BROWSER_IDS.join(' or ')}. It asks that browser what it has open, closes pages no live lease owns, and settles rows whose pages are gone.`,
    );
    return COMMAND_EXIT.malformed;
  }

  if (!isBrowserId(browser)) {
    options.streams.err(
      `There is no browser named ${JSON.stringify(browser)}. This service manages ${BROWSER_IDS.join(' and ')}.`,
    );
    return COMMAND_EXIT.malformed;
  }

  if (options.session === undefined) {
    // Refused rather than reported as a clean run. A reconciliation with no
    // browser to ask would find every recorded page absent and settle every
    // live lease on that browser — the most destructive possible outcome,
    // arrived at by asking nothing.
    options.streams.err(
      'refused (browser.unreachable): reconciliation has to ask a live browser what it has open, and no browser connection was available to this command.',
    );
    return COMMAND_EXIT.refused;
  }

  // ── 1. What the store holds ───────────────────────────────────────────
  const recorded = readRecordedTabs(options.db, browser);

  // ── 2. What the browser says. The asking, in the open, outside every
  //       transaction (§2.4b). The keeper tab is not in this list, because
  //       `listTabs` excludes it (§3.15) — which is what stops the next line
  //       deciding the browser's own life-support page is unowned.
  const session = await options.session(browser);
  const pages = await session.listTabs();

  // ── 3. Deciding. Pure: two lists in, a plan out, no handle held.
  const plan = decideReconciliation(pages, recorded);

  // ── 4. Writing. A database handle and no session.
  const at = now();
  applyReconciliation(options.db, plan.vanishedTabs, at);

  for (const tab of plan.vanishedTabs) {
    // §1.6: one row per decision, and this is a decision — a lease was ended
    // by something that was neither the caller nor the clock. `cli` rather
    // than `internal` because a person ran this (§4.3).
    append(options.db, {
      kind: 'claim_revoked',
      outcome: 'allow',
      adapter: 'cli',
      claimId: tab.claimId,
      tabId: tab.tabId,
      browserId: browser,
      // No driver name in the detail. §1.4 keeps it out of anything a caller
      // reads, and the ledger is read back by `broker events`.
      detail: { reason: 'tab_not_open_in_browser', reconciledAt: at },
    });
  }

  // ── 5. Closing. Browser work, last, and best effort (§2.4b): a page that
  //       will not close is a leaked page, and the run still succeeded at
  //       everything else it did.
  let closed = 0;
  let closeFailures = 0;
  for (const page of plan.unownedPages) {
    try {
      await session.closeTab({ browser, driverTabId: page.driverTabId });
      closed += 1;
    } catch {
      // Swallowed, and counted. The count is what makes this visible without
      // naming the page — a driver name is never printed (§1.4).
      closeFailures += 1;
    }
  }

  const report: ReconciliationReport = {
    pagesSeen: pages.length,
    settled: plan.vanishedTabs.map((tab) => tab.tabId),
    closed,
    closeFailures,
    skippedOpening: plan.skippedOpening.length,
  };

  if (options.json) {
    options.streams.out(
      JSON.stringify({
        browser,
        pages_seen: report.pagesSeen,
        settled: report.settled,
        closed: report.closed,
        close_failures: report.closeFailures,
        skipped_opening: report.skippedOpening,
      }),
    );
    return COMMAND_EXIT.accepted;
  }

  for (const line of formatReconciliation(browser, report)) {
    options.streams.out(line);
  }

  return COMMAND_EXIT.accepted;
}

/**
 * The report a person reads.
 *
 * **Every line is a count or an opaque identifier**, which is §1.4's rule
 * made true by there being nothing else available to print: the report type
 * carries no driver name, so this function could not print one if it tried.
 */
export function formatReconciliation(
  browser: BrowserId,
  report: ReconciliationReport,
): readonly string[] {
  const lines = [
    `reconciled: ${browser}`,
    `pages open, not counting the keeper: ${String(report.pagesSeen)}`,
    `pages closed because no live lease owned them: ${String(report.closed)}`,
    `leases ended because their page was gone: ${String(report.settled.length)}`,
  ];

  for (const tabId of report.settled) {
    lines.push(`  tab ${tabId}`);
  }

  if (report.closeFailures > 0) {
    // §2.4b: a leaked page, not a leaked lease. Said in those terms so the
    // reader knows what it costs — memory, and not budget.
    lines.push(
      `${String(report.closeFailures)} page(s) would not close. That is a leaked page and not a leaked lease: the budget is unaffected, and \`broker doctor\` reports them.`,
    );
  }

  if (report.skippedOpening > 0) {
    // Said on the run it happened on, because the alternative is a person
    // reading "0 closed" and concluding there was nothing to close.
    lines.push(
      `${String(report.skippedOpening)} tab(s) are still being opened, so nothing was closed on this run — a page seen now may belong to one of them. Run again once they have settled.`,
    );
  }

  return lines;
}
