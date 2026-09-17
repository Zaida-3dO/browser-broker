import type { Database } from 'better-sqlite3';

import { DEFAULT_BROWSER_IDS, type BrowserId, type BrowserSession } from '../browser/driver.ts';
import { append } from '../service/events.ts';
import {
  applyReconciliation,
  decideReconciliation,
  readRecordedTabs,
  settleStrandedTabs,
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
  /**
   * The browsers this installation is configured with (`DECISIONS.md` §13i).
   *
   * Defaulted for a caller with no environment snapshot to hand; every
   * shipped caller passes the configured lists, because a command that
   * validated a name against the default set would refuse a browser the
   * person had configured and named.
   */
  readonly browsers?: readonly BrowserId[];
}

/** Timestamps are spelled one way in this store. */
function now(): string {
  return new Date().toISOString();
}

function isBrowserId(value: string, browsers: readonly BrowserId[]): value is BrowserId {
  return browsers.includes(value);
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
  const flags = parseFlags(rest, ['browser', 'session-id']);
  const named = rest.find((word) => !word.startsWith('--'));
  const browser = typeof flags.browser === 'string' ? flags.browser : named;
  // Optional, and the report degrades honestly without it: a caller that does
  // not say who it is gets the ordinary message rather than a claim about
  // ownership nobody established.
  const callerSession = typeof flags['session-id'] === 'string' ? flags['session-id'] : undefined;
  const browsers = options.browsers ?? DEFAULT_BROWSER_IDS;

  if (browser === undefined) {
    options.streams.err(
      `broker reconcile needs to be told which browser: ${browsers.join(' or ')}. It asks that browser what it has open, closes pages no live lease owns, and settles rows whose pages are gone.`,
    );
    return COMMAND_EXIT.malformed;
  }

  if (!isBrowserId(browser, browsers)) {
    options.streams.err(
      `There is no browser named ${JSON.stringify(browser)}. This service manages ${browsers.join(' and ')}.`,
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

  // Rows left `closing` by a lease that has already ended, whose page this
  // browser does not have. The vanished-tab path cannot see them — it reads
  // only tabs of *active* leases — so without this they are unreachable by
  // anything, forever, while still holding their slot in the partial unique
  // index. The browser has just said what it has open; that is the answer
  // those rows were waiting for.
  const strandedSettled = settleStrandedTabs(
    options.db,
    browser,
    pages.map((page) => page.driverTabId),
    at,
  );

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
      // **Counted by what the driver says it did, not by the call returning.**
      // `closeTab` answers `closed`, `not_found` or `refused`; only the first
      // is a page this run ended. Counting a `not_found` as closed would make
      // this report the same false comfort the tab rows used to — "N closed"
      // on a run that closed nothing — and reconciliation's whole purpose is
      // to be the instrument that sees leaked pages.
      //
      // `not_found` is genuinely unremarkable here: the list of pages was read
      // before this loop, so a page can legitimately have gone away in between
      // by a person clicking the cross. It is still not a close this run
      // performed, so it belongs in neither counter — the run saw it and did
      // nothing to it. `refused` is the keeper, which `listTabs` excludes and
      // so should never reach this loop at all; if it ever does, it is counted
      // as a failure so it shows up rather than inflating a success.
      const outcome = await session.closeTab({ browser, driverTabId: page.driverTabId });
      if (outcome === 'closed') {
        closed += 1;
      } else if (outcome === 'refused') {
        closeFailures += 1;
      }
    } catch {
      // Swallowed, and counted. The count is what makes this visible without
      // naming the page — a driver name is never printed (§1.4).
      closeFailures += 1;
    }
  }

  const report: ReconciliationReport = {
    pagesSeen: pages.length,
    strandedSettled,
    settled: plan.vanishedTabs.map((tab) => tab.tabId),
    closed,
    closeFailures,
    skippedOpening: plan.skippedOpening.length,
    skippedOpeningOwnedByCaller:
      callerSession === undefined
        ? 0
        : plan.skippedOpening.filter((tab) => tab.sessionId === callerSession).length,
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
 * Did this run decline to do the thing it was called to do?
 *
 * **Two facts together, and neither alone is enough.** Tabs still being
 * opened block the sweep (`decideReconciliation` leaves them alone, because
 * closing a page a mid-open lease is about to be handed would be worse than
 * declining) — but a run that closed pages *and* skipped one did work, and
 * calling that "nothing was closed" would be false. A run that closed
 * nothing because there was nothing to close is not declining either; it is
 * simply a clean run, and telling that caller to try again would send it
 * back for an answer it already has.
 *
 * So the conclusion is drawn only where both hold: something was in the way,
 * and nothing was swept past it.
 */
function nothingClosedPendingRetry(report: ReconciliationReport): boolean {
  return report.skippedOpening > 0 && report.closed === 0;
}

/**
 * The report a person reads.
 *
 * **Every line is a count or an opaque identifier**, which is §1.4's rule
 * made true by there being nothing else available to print: the report type
 * carries no driver name, so this function could not print one if it tried.
 *
 * ── Why the outcome is the first line and not the last ──────────────────
 *
 * A caller reads the first line and acts on it. When this run declined —
 * {@link nothingClosedPendingRetry} — the sentence that predicts that
 * caller's next failure is the one that has to arrive first, because a
 * headline of `reconciled: <browser>` above four counters reads as
 * completion, and a reader who takes it at face value stops there and runs
 * straight back into the state they invoked this to clear. The counters are
 * still printed, unchanged and in the same order; what moves is the
 * conclusion, which stops being something the reader has to derive from the
 * bottom of a list.
 *
 * **The headline stops claiming completion on such a run** for the same
 * reason. `reconciled:` is a claim about what happened, and on a run that
 * closed nothing and needs invoking again it is not a true one — this is the
 * defect class this repository keeps finding in itself, a call that succeeds
 * while delivering less than it announced. The word is kept for the runs
 * that earned it.
 */
export function formatReconciliation(
  browser: BrowserId,
  report: ReconciliationReport,
): readonly string[] {
  const declined = nothingClosedPendingRetry(report);

  const lines = [
    declined ? `did not reconcile: ${browser}` : `reconciled: ${browser}`,
    ...(declined ? [conclusionLine(report)] : []),
    `pages open, not counting the keeper: ${String(report.pagesSeen)}`,
    `pages closed because no live lease owned them: ${String(report.closed)}`,
    `leases ended because their page was gone: ${String(report.settled.length)}`,
  ];

  for (const tabId of report.settled) {
    lines.push(`  tab ${tabId}`);
  }

  // Only when it happened. A line that is present and zero on every healthy
  // run is noise, and this one describes a state that should be rare.
  if (report.strandedSettled > 0) {
    lines.push(
      `records settled that were waiting on a close nobody was coming to answer: ${String(report.strandedSettled)}`,
    );
  }

  if (report.closeFailures > 0) {
    // §2.4b: a leaked page, not a leaked lease. Said in those terms so the
    // reader knows what it costs — memory, and not budget.
    lines.push(
      `${String(report.closeFailures)} page(s) would not close. That is a leaked page and not a leaked lease: the budget is unaffected, and \`broker doctor\` reports them.`,
    );
  }

  // Said on the run it happened on, because the alternative is a person
  // reading "0 closed" and concluding there was nothing to close.
  //
  // **Printed here only when it was not already printed at the top.** The
  // conclusion belongs above the counters on a run that declined, and below
  // them on a run that closed pages anyway — where it is a caveat on real
  // work rather than the outcome. Either way it is written once, by one
  // function, so the two positions cannot drift into two wordings.
  if (report.skippedOpening > 0 && !declined) {
    lines.push(conclusionLine(report));
  }

  return lines;
}

/**
 * The sentence that tells a caller what to do next.
 *
 * **The caution itself does not change when the caller owns the blocking
 * row.** Closing a page belonging to an in-flight claim would be worse than
 * declining, and that is true whoever the claim belongs to. What changes is
 * that the caller is told the remedy is in its own hands: an operator can
 * otherwise run this repeatedly against a row that is its own lease, held
 * open for as long as the command keeps being run, with nothing in the
 * message able to say so.
 *
 * ── Why the unowned branch no longer says "run again once they've settled" ──
 *
 * Because they may never settle, and the message was the only thing claiming
 * otherwise. "Settled" describes something in progress that finishes on its
 * own, and an `opening` row has no such mechanism behind it: `reserveTab`
 * inserts the row inside the arbitration transaction and opens the page after
 * the commit (§2.4b), so a process that dies in between leaves a row that
 * `tabs.ts` says outright "can sit in `opening` forever… the honest outcome
 * rather than a gap".
 *
 * The refusal itself is correct and is deliberately left alone: §1.4's
 * `CHECK ((state = 'opening') = (driver_tab_id IS NULL))` means an `opening`
 * row holds no driver name, so no page can be *proven* unowned while one
 * exists, and `reconcile.ts` argues at length that declining beats guessing.
 * What was wrong was the advice on top of it. An operator told to wait will
 * wait — and re-run, and wait — against a condition that will outlive the
 * browser, with the counters reading zero every time and nothing anywhere
 * suggesting the wait is the wrong move.
 *
 * So the line now says what is actually true: the run is blocked until those
 * rows stop being `opening`, which happens when their tabs finish opening
 * **or** when the leases holding them are released or expire. That points at
 * the lease rather than at the clock. It deliberately stops there and names no
 * command — this command has no way to tell a row one millisecond from being
 * named from one abandoned two days ago, and inventing a confident instruction
 * it cannot support is precisely how the previous wording went wrong. (An
 * earlier draft of this fix pointed at `broker tabs`, which does not exist.
 * Replacing one piece of misleading advice with another would have been worse
 * than the defect, because this one would have failed in the operator's hand.)
 */
function conclusionLine(report: ReconciliationReport): string {
  const owned = report.skippedOpeningOwnedByCaller;

  return (
    `${String(report.skippedOpening)} tab(s) are still being opened, so nothing was closed on this run — a page seen now may belong to one of them.` +
    (owned > 0
      ? ` ${String(owned)} of them ${owned === 1 ? 'belongs' : 'belong'} to your own lease — release ${owned === 1 ? 'it' : 'them'}, or run this from another session.`
      : ' This will keep declining until those tabs leave the opening state, and that may not happen on its own: a lease whose tab never finished opening stays that way until the lease is released or expires.')
  );
}
