import type { Database } from 'better-sqlite3';

import { BROWSER_IDS } from '../browser/driver.ts';
import { SIGNABLE_BROWSER } from '../service/operations/sign-in.ts';
import type { Environment } from '../config/environment.ts';
import { readTabBudget } from '../operations/status.ts';
import { classifySignIn, type ProcessLiveness } from '../service/signin-recovery.ts';
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

  for (const browser of BROWSER_IDS) {
    checks.push(checkDiscoveryRecord(browser, probes.discovery?.[browser] ?? { recorded: false }));
  }

  checks.push(checkCaptureSurface(probes.captureSurface));

  for (const browser of BROWSER_IDS) {
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
  const signInBrowser = SIGNABLE_BROWSER;
  const discoveryProbe = probes.discovery?.[signInBrowser];
  const browserRunning = discoveryProbe?.recorded === true && discoveryProbe.answered === true;
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
