import type { Database } from 'better-sqlite3';

import { SIGNABLE_BROWSER } from '../service/operations/sign-in.ts';
import type { Environment } from '../config/environment.ts';
import { readTabBudget } from '../operations/status.ts';
import { classifySignIn, type ProcessLiveness } from '../service/signin-recovery.ts';
import { strandedTabsByBrowser } from '../service/tabs.ts';
import type { NetworkPathChecks } from '../store/network-path.ts';
import { readStoreVersion } from '../store/schema/step.ts';
import { inspectProfileSession, type CookieStoreReader } from './session.ts';
import {
  checkAbandonedSignIn,
  checkAutomation,
  checkCaptureSurface,
  checkDiscoveryRecord,
  checkKeeperTab,
  checkRootWritable,
  checkSchemaVersion,
  checkStrandedTabs,
  checkSignInSession,
  checkStoreLocation,
  checkStorePresent,
  checkTabBudget,
  exitCodeFor,
  type AutomationProbe,
  type DiscoveryProbeResult,
  type GroupedCheck,
} from './checks.ts';

/**
 * Running every precondition and reporting each on its own line.
 *
 * `SCHEMA.md` §5.5 lists the preconditions; `checks.ts` implements them one
 * at a time and this assembles the run. The split is not tidiness: **every
 * check is a pure function of what it was told**, so each one is testable
 * without a store, a browser or a filesystem, and this file is the only place
 * that has to go and find those things.
 *
 * §4.4's property is what the shape has to preserve: **every precondition
 * reported separately**, never collapsed. So the report is a list, the exit
 * code is derived from the list rather than being the report, and there is no
 * "healthy: true" anywhere in it. A single verdict is exactly what this
 * command declines to produce.
 */

/**
 * What the caller supplies that this module cannot find on its own.
 *
 * Everything here is a **probe result**, not a probe: the browser-facing
 * checks need a live connection, and this module deliberately does not open
 * one. That is what keeps "it reports and changes nothing" true — a module
 * that could attach to a browser is a module one edit away from restarting
 * it.
 *
 * Absent probes report `unknown`, which is the honest answer while the rows
 * that supply them are unbuilt.
 */
export interface DoctorProbes {
  readonly automation?: AutomationProbe;
  /** Per browser, what its discovery record turned out to be. */
  readonly discovery?: Partial<Record<string, DiscoveryProbeResult>>;
  /** Per browser, whether its keeper tab is there. */
  readonly keeperTabs?: Partial<Record<string, boolean>>;
  /** The configured capture surface, once there is one to read. */
  readonly captureSurface?: string;
  /** The tab budget this process's environment declares, once one is read. */
  readonly configuredTabBudget?: number;
  readonly networkChecks?: NetworkPathChecks;
  /**
   * How the cookie store is read, for the sign-in check.
   *
   * Injected like every other probe here, so the branches that report an
   * unreadable store are reachable by a test. Absent means the real reader.
   */
  readonly cookieReader?: CookieStoreReader;
  /**
   * How a sign-in owner's liveness is asked, injected so the abandoned-sign-in
   * check is reachable from a test without killing a real process.
   */
  readonly processIsRunning?: ProcessLiveness;
}

export interface DoctorReport {
  readonly checks: readonly GroupedCheck[];
  readonly exitCode: number;
  /** Where the store is, echoed once so the report says what it examined. */
  readonly storeLocation: string;
}

/**
 * Whether a browser is live, from its discovery probe, in three values.
 *
 * Exported so the truth table is testable on its own: it is the expression
 * whose collapse to `boolean` hid the defect this module was fixed for, and a
 * two-valued version of it reads *no browser is running* on installations
 * nobody asked about.
 *
 * - **No probe** — unasked. Nothing looked.
 * - **No record** — `false`, and this is the one genuine negative a row can
 *   support: a browser that has never been launched is not running.
 * - **A record, endpoint unverified** — unasked. §1.2c: the record outlives
 *   the browser it names, so its mere presence is not evidence of a live one,
 *   and its presence is all a store read can establish.
 * - **A record, endpoint reached** — whatever the endpoint said.
 */
export function browserIsRunning(probe: DiscoveryProbeResult | undefined): boolean | undefined {
  if (probe === undefined) {
    return undefined;
  }
  if (!probe.recorded) {
    return false;
  }
  return probe.answered;
}

/**
 * Run the preconditions.
 *
 * `db` is optional because a store that does not exist yet is a legitimate
 * state to ask about — arguably the state where the answer is most useful,
 * since it is the one somebody has just installed into. Every store-derived
 * check reports `unknown` rather than failing when there is nothing to read.
 *
 * **Nothing here writes to the store.** The only write anywhere in this
 * command is the write probe on each root, which removes what it wrote and is
 * named in `checks.ts`'s header.
 */
export function runDoctor(
  environment: Environment,
  db: Database | undefined,
  probes: DoctorProbes = {},
): DoctorReport {
  const version = db === undefined ? null : readStoreVersion(db);
  const storedBudget = db === undefined ? null : readTabBudget(db);

  const checks: GroupedCheck[] = [
    checkStoreLocation(environment, probes.networkChecks),
    checkStorePresent(environment),
    checkSchemaVersion(version),
    checkAutomation(probes.automation ?? { present: undefined }),
    checkRootWritable(
      'roots.artifacts_writable',
      'The artifact root is writable',
      environment.artifactsRoot,
    ),
    checkRootWritable(
      'roots.profiles_writable',
      'The profile root is writable',
      environment.profileRoot,
    ),
  ];

  // **Every configured browser, not the default pair.** `DEFAULT_BROWSER_IDS`
  // is "the default set, never the permitted set" (see its own comment); an
  // installation that names a third browser has three to report on, and a
  // doctor that walked the constant would silently answer about two of them.
  // A health report that is quietly partial is worse than one that is absent,
  // because nothing in its output says which browsers it did not look at.
  //
  // Order is regular-then-private, each in configured order, which is the
  // order `environment.ts` records and the order a person reading `.env`
  // wrote them in.
  const configuredBrowsers: readonly string[] = [
    ...environment.regularBrowsers,
    ...environment.privateBrowsers,
  ];

  // **No fabricated default.** This used to substitute `{recorded: false}`
  // for a probe nobody supplied, which reports *a record was looked for and
  // was not there* on behalf of a caller that never looked. The row read the
  // same either way, so the substitution was invisible here — and not
  // invisible at the sign-in check below, which drew a verdict from it.
  for (const browser of configuredBrowsers) {
    checks.push(checkDiscoveryRecord(browser, probes.discovery?.[browser]));
  }

  checks.push(checkCaptureSurface(probes.captureSurface));

  for (const browser of configuredBrowsers) {
    checks.push(checkKeeperTab(browser, probes.keeperTabs?.[browser]));
  }

  // The sign-in check, for the one browser that has a profile to sign into.
  // Not run for the private browser: its profile is ephemeral, so the
  // question does not apply and an entry saying `unknown` about a browser
  // that can never be signed in would read as a gap rather than as a
  // non-question.
  //
  // **Whether a browser is running changes what a zero count means**, so the
  // discovery probe's answer is passed through rather than re-derived. See
  // `session.ts`: a live browser has not necessarily flushed its cookies.
  // **Three-valued, because `boolean` cannot say that nobody asked.** The
  // previous expression was `recorded === true && answered === true`, which
  // yields `false` for an absent probe — indistinguishable from a probe that
  // reached the endpoint and found nothing. That is how this shipped: no
  // production caller passed `discovery` at all, so `browserRunning` was
  // permanently `false`, the live-browser guard in `session.ts` was
  // unreachable outside tests, and every zero count was read as the negative.
  //
  // `undefined` now means unasked, and only a measured `false` licenses the
  // negative verdict. There are two ways to be unasked and both must reach it:
  // no probe at all, and a probe that read the record without reaching the
  // endpoint — which is what the doctor's own store-reading probe supplies,
  // since the command opens no connections. A browser with no record is the
  // one genuine `false` available from a row: nothing has been launched, so
  // nothing is running.
  const signInBrowser = SIGNABLE_BROWSER;
  const browserRunning = browserIsRunning(probes.discovery?.[signInBrowser]);
  checks.push(
    checkSignInSession(
      signInBrowser,
      inspectProfileSession(environment.profileRoot, signInBrowser, {
        ...(probes.cookieReader === undefined ? {} : { reader: probes.cookieReader }),
        browserRunning,
      }),
    ),
  );

  // **Whether a sign-in has been abandoned**, which is the one thing on this
  // report that can be actively refusing every caller right now. Read from the
  // store rather than probed, because the two facts it needs — the state and
  // the owning process — are both rows.
  //
  // A store that is absent, or one written by a build older than the owner
  // column, yields no row to classify; both come back as *not signing in*,
  // which is the honest answer when there is nothing recorded to say
  // otherwise.
  checks.push(
    checkAbandonedSignIn(
      signInBrowser,
      classifySignIn(
        db === undefined ? undefined : readSignInOwner(db, signInBrowser),
        probes.processIsRunning,
      ),
    ),
  );

  checks.push(checkTabBudget(storedBudget, probes.configuredTabBudget ?? null));

  // Counted here rather than in the check, which takes a number so it stays
  // testable without a store. A store that is absent yields no count and the
  // check is not run at all: "no store" is already reported by its own row,
  // and a second row saying zero stranded tabs would read as reassurance
  // drawn from nothing.
  if (db !== undefined) {
    checks.push(
      checkStrandedTabs(
        strandedTabsByBrowser(db, environment.leaseSeconds),
        environment.leaseSeconds,
      ),
    );
  }

  return {
    checks,
    exitCode: exitCodeFor(checks),
    storeLocation: environment.databasePath,
  };
}

/**
 * Read each browser's discovery record out of the store, so the caller has
 * something to probe.
 *
 * **This reads the record and does not check it.** §1.2c: the record is a
 * claim, not a proof — it survives the browser it names. Turning these into
 * probe results means reaching the endpoint, which needs a driver, which is
 * the row that will supply {@link DoctorProbes.discovery}.
 */
export function readDiscoveryRecords(
  db: Database,
): Record<string, { endpoint: string | null; browserUuid: string | null }> {
  const rows = db.prepare('SELECT id, endpoint, browser_uuid FROM browsers').all() as {
    id: string;
    endpoint: string | null;
    browser_uuid: string | null;
  }[];
  const records: Record<string, { endpoint: string | null; browserUuid: string | null }> = {};
  for (const row of rows) {
    records[row.id] = { endpoint: row.endpoint, browserUuid: row.browser_uuid };
  }
  return records;
}

/**
 * The discovery probes a caller can supply without reaching a browser.
 *
 * ── Why a half-answer is worth wiring, and is not a hollow one ──────────
 *
 * {@link DiscoveryProbeResult} has two halves. `recorded` is a row and this
 * reads it. `answered` needs a driver to reach the endpoint, which the doctor
 * deliberately does not do — *it reports and changes nothing*, and a check
 * that attached to a browser is one edit away from restarting it. So
 * `answered` is left `undefined` here and the discovery row reports what it
 * always has for an unverified record.
 *
 * **What this buys is the honesty of the negative.** With no probe at all,
 * `browserRunning` was a fabricated `false` and the sign-in check read every
 * zero cookie count as *nobody is signed in*. With this, a browser that has a
 * discovery record yields a genuine measurement on the one axis that can be
 * measured from a row, and an installation with no record at all is reported
 * as unasked rather than as answered-no.
 *
 * **This does change what rows say once real data arrives.** Discovery rows
 * that read `unknown` on every shipped build will now read `unknown` for an
 * unlaunched browser and `failed` for a record whose endpoint is unverified —
 * the latter being the state the check was written to report. No exit code
 * regresses on an installation that has never launched a browser, because
 * `checkDiscoveryRecord` returns `unknown` and not `failed` for an absent
 * record.
 */
export function discoveryProbesFromStore(
  db: Database | undefined,
): Partial<Record<string, DiscoveryProbeResult>> | undefined {
  if (db === undefined) {
    return undefined;
  }

  let records: Record<string, { endpoint: string | null; browserUuid: string | null }>;
  try {
    records = readDiscoveryRecords(db);
  } catch {
    // A store too old to hold the columns answers nothing, and `undefined`
    // is the honest report of that — not an empty map, which would say every
    // browser was looked at and none had a record.
    return undefined;
  }

  const probes: Partial<Record<string, DiscoveryProbeResult>> = {};
  for (const [browser, record] of Object.entries(records)) {
    probes[browser] = {
      recorded: record.endpoint !== null,
      ...(record.browserUuid === null ? {} : { expectedUuid: record.browserUuid }),
    };
  }
  return probes;
}

/**
 * Read the sign-in state and its owning process for one browser.
 *
 * **Tolerant of a store that predates the owner column**, because `doctor` is
 * the command most likely to be pointed at an old installation — that is
 * largely what it is for. A store without the column answers as though nothing
 * is signing in, which is the honest reading: there is no record to conclude
 * anything from.
 */
export function readSignInOwner(
  db: Database,
  browser: string,
): { readonly state: string; readonly signin_owner_pid: number | null } | undefined {
  try {
    return db.prepare('SELECT state, signin_owner_pid FROM browsers WHERE id = ?').get(browser) as
      { state: string; signin_owner_pid: number | null } | undefined;
  } catch {
    return undefined;
  }
}

const SYMBOL: Record<string, string> = { ok: 'ok  ', failed: 'FAIL', unknown: '--  ' };

/**
 * The report as lines for a terminal.
 *
 * One line per precondition with its own status, then the failures repeated
 * with what to do about them. **No summary verdict** — §4.4 is explicit that
 * collapsing preconditions into one word is the thing this declines to do,
 * and a "3 of 12 healthy" line at the bottom is that word with arithmetic.
 * What the bottom carries instead is the exit code, which is the machine's
 * answer and names which group failed.
 */
export function formatReport(report: DoctorReport): readonly string[] {
  const lines: string[] = [`store: ${report.storeLocation}`, ''];

  for (const check of report.checks) {
    lines.push(`[${SYMBOL[check.status] ?? '?   '}] ${check.title}`);
    lines.push(`         ${check.detail}`);
  }

  const failures = report.checks.filter((check) => check.status === 'failed');
  if (failures.length > 0) {
    lines.push('', 'What to do:');
    for (const failure of failures) {
      lines.push(`  ${failure.id}: ${failure.remedy ?? 'No remedy recorded for this check.'}`);
    }
  }

  const unknown = report.checks.filter((check) => check.status === 'unknown');
  if (unknown.length > 0) {
    lines.push(
      '',
      // Said rather than left to be inferred: an unknown is not a failure and
      // does not affect the exit code, and a reader who assumed otherwise
      // would treat a fresh install as broken.
      `${String(unknown.length)} precondition(s) could not be evaluated. That is not a failure — a check with nothing to examine has not found a fault — and none of them affects the exit code.`,
    );
  }

  lines.push('', `exit code: ${String(report.exitCode)}`);
  return lines;
}
