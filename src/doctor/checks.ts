import fs from 'node:fs';
import path from 'node:path';

import type { BrowserId } from '../browser/driver.ts';
import type { Environment } from '../config/environment.ts';
import { BrokerError } from '../errors.ts';
import { SIGN_IN_OWNER_UNKNOWN_REMEDY, type SignInOwnerState } from '../service/signin-recovery.ts';
import { refuseNetworkLocation, type NetworkPathChecks } from '../store/network-path.ts';
import { EXPECTED_VERSION } from '../store/schema/steps.ts';
import type { SessionProbe } from './session.ts';

/**
 * `broker doctor` — every precondition, reported separately (`MILESTONES.md`
 * #71, `SCHEMA.md` §5.5).
 *
 * ── What it is for, which is not what it looks like ─────────────────────
 *
 * §4.4: a health endpoint "reporting 'can this service grant a lease' was a
 * sound idea for a long-lived process and is the wrong shape here". A health
 * check asks, repeatedly, whether a thing is still up — a question about a
 * process that is supposed to be up. **Nothing here is supposed to be up.** A
 * service that is not running has not failed; it has exited, which is what it
 * does.
 *
 * So a readiness check reaches for this instead, and gets **strictly more**
 * than a verdict would give it: a single word collapses every precondition
 * into one answer, and the answer does not say which one failed. This names
 * the one that failed, and exits with a code that distinguishes it.
 *
 * ── The rule that governs every check in this file ──────────────────────
 *
 * > **It reports and changes nothing.**
 *
 * That is what makes "what state is this installation in" a question you can
 * ask without running the thing that would change the answer. Concretely, and
 * it is worth being exact because each of these is a thing a well-meaning
 * addition would do:
 *
 * - **It does not step the schema.** It reports the version it found against
 *   the version this build expects. A doctor that migrated would make the
 *   store's version depend on having been asked about it.
 * - **It does not create the roots.** It reports whether they are writable.
 *   Creating them is the setup handshake's job (§1.2d) and every spawn runs
 *   it — so a root this reports as absent will exist the next time anything
 *   actually runs, and the report would have been a lie about the moment it
 *   described.
 * - **It does not launch, adopt, restart or reap a browser.** It checks the
 *   discovery record for liveness and identity, which is a read (§1.2c).
 * - **It does not write a ledger row.** Every other route records what it
 *   did; this did nothing.
 * - **It does not sweep**, so it does not expire anybody's lease.
 *
 * The one thing it does that touches the world outside the store is a write
 * probe on each root — the only way to answer "writable" that is not a guess
 * — and it removes what it wrote. That is named here rather than left for a
 * reader to discover.
 */

/** How one precondition came out. */
export type CheckStatus =
  | 'ok'
  | 'failed'
  /**
   * The precondition could not be evaluated, and that is distinct from
   * failing it.
   *
   * A check whose subject does not exist yet in this build — a browser that
   * has never been launched, a budget row nothing has written — has not
   * failed. Reporting it as a failure would make a fresh install look broken,
   * and the person acting on that report would go looking for a fault that is
   * not there. It contributes to no failure code.
   */
  | 'unknown';

/** One precondition, reported on its own — never folded into a verdict. */
export interface CheckResult {
  /** A stable identifier, so a script can match on something that is not English. */
  readonly id: string;
  /** What was checked, for a person. */
  readonly title: string;
  readonly status: CheckStatus;
  /** What was found. Always populated, including on success. */
  readonly detail: string;
  /**
   * What to do about it, on a failure.
   *
   * Owed rather than optional on a failure: a check that says something is
   * wrong and not what to do about it has moved the work rather than done it.
   */
  readonly remedy?: string;
}

/**
 * Exit codes, one per failing precondition group (`SCHEMA.md` §5.5: "Exits
 * with a distinct code on any failure").
 *
 * **Distinct rather than sequential**, and the grouping is the substance: a
 * caller using this as a readiness check branches on *what* is wrong, and the
 * useful distinctions are the ones that call for different responses — a
 * store on a network filesystem needs configuration changed, a browser that
 * does not answer needs a browser started, and a budget disagreement needs
 * an environment reconciled.
 *
 * Zero is every precondition either passing or being unevaluable. **An
 * `unknown` does not fail the command**, for the reason given on
 * {@link CheckStatus}: a fresh install with no browser launched is not a
 * broken install, and a readiness check that refused one would be unusable
 * on the machine it is most needed on.
 *
 * When several groups fail, the **lowest** code is reported, so the exit code
 * is stable rather than depending on check order — and the full report on the
 * output stream is where the rest of them are. A single number cannot carry
 * more than one failure and pretending otherwise is how a code becomes
 * meaningless.
 */
export const DOCTOR_EXIT = {
  ok: 0,
  /** The store: where it is, what it is on, what version it is at. */
  store: 10,
  /** The automation tool is absent or unusable. */
  automation: 11,
  /** An artifact or profile root is not writable. */
  roots: 12,
  /** A browser's discovery record does not check out. */
  browsers: 13,
  /** The capture-surface check. */
  capture: 14,
  /** A keeper tab is missing. */
  keeper: 15,
  /** The stored tab budget disagrees with this process's environment. */
  budget: 16,
  /**
   * The sign-in state of the persistent profile.
   *
   * It has a group so the report can carry it, and it is **the one group no
   * check ever fails into**: a profile without a session is the ordinary
   * state of a fresh install rather than a fault. The code exists so the
   * grouping is total rather than because anything returns it.
   */
  session: 17,
} as const;

/** Which exit code a failing check contributes. */
export type CheckGroup = keyof typeof DOCTOR_EXIT;

export interface GroupedCheck extends CheckResult {
  readonly group: CheckGroup;
}

/**
 * The exit code for a set of results.
 *
 * Lowest failing group wins, per the note on {@link DOCTOR_EXIT}. Ordering by
 * the code's numeric value rather than by the order checks happened to run in
 * is what makes it reproducible.
 */
export function exitCodeFor(results: readonly GroupedCheck[]): number {
  const failed = results
    .filter((result) => result.status === 'failed')
    .map((result) => DOCTOR_EXIT[result.group]);
  return failed.length === 0 ? DOCTOR_EXIT.ok : Math.min(...failed);
}

/**
 * Where the store is, and that it is not somewhere it may not be (§1.0).
 *
 * **It calls the same refusal the store open calls**, rather than
 * reimplementing the test. That is the whole reason this check is worth
 * anything: a doctor with its own opinion about what a network path is would
 * eventually disagree with the thing that actually refuses to start, and the
 * disagreement would be discovered by somebody whose doctor said the
 * installation was fine and whose service would not run.
 *
 * The refusal throws rather than returning, so it is caught and turned into a
 * report line — reporting rather than refusing is this command's whole
 * contract.
 */
export function checkStoreLocation(
  environment: Environment,
  checks?: NetworkPathChecks,
): GroupedCheck {
  const id = 'store.not_on_network_filesystem';
  const title = 'The store is not on a network filesystem';

  try {
    if (environment.configuredDatabasePath !== undefined) {
      refuseNetworkLocation(environment.configuredDatabasePath, checks);
    }
    refuseNetworkLocation(environment.databasePath, checks);
  } catch (error) {
    if (error instanceof BrokerError) {
      return {
        group: 'store',
        id,
        title,
        status: 'failed',
        // The refusal's own message, which names the variable and what to set
        // it to — and which deliberately does not echo the path back. The
        // path is a real location on a real machine and this report is a
        // thing people paste into messages.
        detail: error.message,
        remedy:
          'Point BROKER_DB at a local filesystem. Several processes arbitrate against this store at once, and the write-ahead log requires every one of them to be on the same host.',
      };
    }
    throw error;
  }

  return {
    group: 'store',
    id,
    title,
    status: 'ok',
    detail: 'The configured store location is local.',
  };
}

/** That the store file exists and can be read and written. */
export function checkStorePresent(environment: Environment): GroupedCheck {
  const location = environment.databasePath;
  if (!fs.existsSync(location)) {
    return {
      group: 'store',
      id: 'store.present',
      title: 'The store exists',
      status: 'unknown',
      // Not a failure: the store is created on first spawn, so its absence
      // means nothing has run yet rather than that something is broken.
      detail: 'No store file at the configured location. It is created on the first spawn.',
    };
  }
  try {
    fs.accessSync(location, fs.constants.R_OK | fs.constants.W_OK);
    return {
      group: 'store',
      id: 'store.present',
      title: 'The store exists',
      status: 'ok',
      detail: 'The store file is present and both readable and writable.',
    };
  } catch {
    return {
      group: 'store',
      id: 'store.present',
      title: 'The store exists',
      status: 'failed',
      detail: 'The store file is present but cannot be both read and written.',
      remedy: 'Check the file’s ownership and permissions for the account running this command.',
    };
  }
}

/**
 * That the store is at the version this build expects.
 *
 * Reports and does not step. A build ahead of its store is the ordinary
 * upgrade case and is fixed by the next spawn; a **store ahead of the build**
 * is the dangerous direction, because the running code does not know what the
 * newer schema means, so the two are distinguished in the message.
 */
export function checkSchemaVersion(found: number | null): GroupedCheck {
  if (found === null) {
    return {
      group: 'store',
      id: 'store.version',
      title: 'The store is at the version this build expects',
      status: 'unknown',
      detail: `No store to read a version from. This build expects version ${String(EXPECTED_VERSION)}.`,
    };
  }
  if (found === EXPECTED_VERSION) {
    return {
      group: 'store',
      id: 'store.version',
      title: 'The store is at the version this build expects',
      status: 'ok',
      detail: `Version ${String(found)}.`,
    };
  }
  const ahead = found > EXPECTED_VERSION;
  return {
    group: 'store',
    id: 'store.version',
    title: 'The store is at the version this build expects',
    status: 'failed',
    detail: ahead
      ? `The store is at version ${String(found)} and this build expects ${String(EXPECTED_VERSION)}. The store was written by a newer build.`
      : `The store is at version ${String(found)} and this build expects ${String(EXPECTED_VERSION)}.`,
    remedy: ahead
      ? 'Run the newer build against this store, or point BROKER_DB at a store this build understands. This build cannot safely read a schema it does not know.'
      : 'Any spawn steps the schema. Run the service once; this command reports and does not step.',
  };
}

/**
 * That no tab has been waiting on a close nobody is coming to answer.
 *
 * ── The report that said nothing ────────────────────────────────────────
 *
 * `closing` means the tool was asked and has not answered. That is a
 * transient state measured in a round trip, so a row sitting in it for hours
 * is not slow — it is waiting for an answer that will never arrive, because
 * the process that would have written it exited long ago.
 *
 * This check exists because a store was found holding 22 such rows while
 * `broker doctor` reported **exit code 0**. Eight real pages were open on
 * the operator's browser, owned by no lease, and the only reason anybody
 * noticed was that a person looked at his own browser and thought there were
 * too many tabs. A report that is clean while that is true is not reporting.
 *
 * ── Why the threshold is a lease's own lifetime ─────────────────────────
 *
 * The number has to separate "a close is in flight" from "a close is never
 * happening", and the honest boundary is the one the system already uses to
 * decide a caller is gone: if a lease may be declared lapsed after this long
 * without contact, a round trip outstanding for longer is not pending.
 * Taking the threshold from configuration rather than writing one down keeps
 * the two from drifting apart.
 */
export function checkStrandedTabs(stranded: number, thresholdSeconds: number): GroupedCheck {
  if (stranded === 0) {
    return {
      group: 'store',
      id: 'store.stranded_tabs',
      title: 'No tab is waiting on a close that will not come',
      status: 'ok',
      detail: 'Every tab has either been closed or is still within a close round trip.',
    };
  }
  return {
    group: 'store',
    id: 'store.stranded_tabs',
    title: 'No tab is waiting on a close that will not come',
    status: 'failed',
    detail:
      `${String(stranded)} tab(s) have been waiting on a close for longer than ` +
      `${String(thresholdSeconds)} seconds, which is how long a lease may go without contact ` +
      'before it is declared lapsed. A close outstanding for longer is not in flight.',
    remedy:
      'Run `broker reconcile` against each browser. It asks what the browser actually has open, ' +
      'closes pages no live lease owns, and settles the records whose page is gone.',
  };
}

/**
 * That the automation tool is present, and what version it is.
 *
 * `present` follows the same `boolean | undefined` convention as
 * {@link checkKeeperTab}'s `present` argument: **`undefined` and `false` are
 * different answers, not two spellings of the same one.**
 *
 * - `undefined` — nobody asked. No probe was supplied, so there is nothing
 *   to report and this stays `unknown` (`[--]`). This is the state a caller
 *   is in before it wires a probe, and it must not read as a failure.
 * - `false` — asked, and the answer is no. Something actually looked for the
 *   automation tool and did not find it. That is a real, actionable failure
 *   and reports `failed`, which is what makes doctor exit code 11 reachable.
 * - `true` — asked, found. Reports `ok`.
 */
export interface AutomationProbe {
  /** Whether an automation tool is available to this process. */
  readonly present: boolean | undefined;
  readonly version?: string;
  readonly detail?: string;
}

export function checkAutomation(probe: AutomationProbe): GroupedCheck {
  if (probe.present === undefined) {
    return {
      group: 'automation',
      id: 'automation.present',
      title: 'The automation tool is present',
      status: 'unknown',
      detail:
        probe.detail ??
        'No automation probe was supplied, so there is nothing to report a version for.',
    };
  }
  if (!probe.present) {
    return {
      group: 'automation',
      id: 'automation.present',
      title: 'The automation tool is present',
      status: 'failed',
      detail: probe.detail ?? 'No automation tool could be found for this process to use.',
      remedy:
        'Install a browser binary for the automation driver this build depends on — see the README’s install section.',
    };
  }
  return {
    group: 'automation',
    id: 'automation.present',
    title: 'The automation tool is present',
    status: 'ok',
    detail: `Present${probe.version === undefined ? '' : `, version ${probe.version}`}.`,
  };
}

/**
 * That a root is writable, proved by writing.
 *
 * `fs.access` with the write bit answers a different question on more than
 * one platform — it consults permission bits that a filesystem, a container
 * mount or an access-control list can override, so it reports writable for
 * directories that refuse the write. The only answer that is not a guess is
 * the write itself.
 *
 * **What it wrote is removed.** This is the one place the doctor touches
 * anything outside the store, and it is named in this module's header for
 * that reason. It does **not** create the directory: creating it is the setup
 * handshake's job, and a doctor that created what it was asked to check would
 * report on a state it had just produced.
 */
export function checkRootWritable(id: string, title: string, root: string): GroupedCheck {
  if (!fs.existsSync(root)) {
    return {
      group: 'roots',
      id,
      title,
      status: 'unknown',
      detail: 'The directory does not exist. Every spawn creates it; this command does not.',
    };
  }

  const probe = path.join(root, `.broker-doctor-${String(process.pid)}-${String(Date.now())}`);
  try {
    fs.writeFileSync(probe, '');
    return { group: 'roots', id, title, status: 'ok', detail: 'The directory accepted a write.' };
  } catch {
    return {
      group: 'roots',
      id,
      title,
      status: 'failed',
      detail: 'The directory exists but refused a write.',
      remedy:
        'Check the directory’s ownership and permissions for the account running this command.',
    };
  } finally {
    // Best effort: a probe left behind is untidy and harmless, and throwing
    // out of a cleanup would turn a passing check into a crash.
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      /* the probe outlives us; the check itself already answered */
    }
  }
}

/**
 * A browser's discovery record, **checked for liveness and identity rather
 * than merely present** (§1.2c, §5.5).
 *
 * This is the check §4.2 says the document cannot make and this command can.
 * Both conditions are required and the reason each is required was verified:
 *
 * 1. **Liveness** — the record survives the browser. It was still there,
 *    still readable and still naming a port, while the endpoint behind it was
 *    dead. A file is not a process.
 * 2. **Identity** — ports are reused. A port named in a stale record can
 *    belong to an entirely unrelated program by the time somebody reads it,
 *    and a check comparing only the number will connect to it and report
 *    success. So the browser's own identifier is compared too.
 *
 * A record failing **either** check is stale, and the browser is treated as
 * not running.
 */
export interface DiscoveryProbeResult {
  /** Whether a record was recorded at all. */
  readonly recorded: boolean;
  /** Whether the endpoint answered. */
  readonly answered?: boolean;
  /** The identifier the live browser gave for itself, if it answered. */
  readonly reportedUuid?: string;
  /** The identifier the record claims. */
  readonly expectedUuid?: string;
}

export function checkDiscoveryRecord(
  browser: BrowserId,
  probe: DiscoveryProbeResult,
): GroupedCheck {
  const id = `browser.${browser}.discovery`;
  const title = `The ${browser} browser’s discovery record checks out`;

  if (!probe.recorded) {
    return {
      group: 'browsers',
      id,
      title,
      status: 'unknown',
      // Not a failure: no record means no browser has been launched, which is
      // the state of every fresh install.
      detail: 'No discovery record. This browser has not been launched.',
    };
  }

  if (probe.answered !== true) {
    return {
      group: 'browsers',
      id,
      title,
      status: 'failed',
      detail: 'A discovery record is present but the endpoint it names did not answer.',
      remedy:
        'The record survives the browser it describes, so a stale one is expected after a browser exits. The next caller will take the launch race and start one.',
    };
  }

  if (probe.expectedUuid === undefined || probe.reportedUuid === undefined) {
    return {
      group: 'browsers',
      id,
      title,
      status: 'failed',
      // Answering is not enough, and this is the case that would silently
      // pass a port-only check.
      detail:
        'The endpoint answered but the browser’s own identifier could not be compared, so what answered cannot be shown to be the expected browser.',
      remedy:
        'Treat this browser as not running. Attaching to something that cannot be identified is worse than failing to attach, because it succeeds.',
    };
  }

  if (probe.expectedUuid !== probe.reportedUuid) {
    return {
      group: 'browsers',
      id,
      title,
      status: 'failed',
      detail:
        'The endpoint answered, but as a different browser than the record names — the port has been reused.',
      remedy:
        'Treat this browser as not running. The next caller will take the launch race and start one against the recorded profile.',
    };
  }

  return {
    group: 'browsers',
    id,
    title,
    status: 'ok',
    detail: 'The endpoint answered and identified itself as the browser the record names.',
  };
}

/**
 * The capture-surface check.
 *
 * The setting exists and the check that enforces it belongs to the capture
 * pipeline's row. Reported here from the first version so the report has the
 * entry §5.5 lists, and reported as `unknown` rather than invented, because a
 * check that always passes is worse than one that says it has nothing to
 * check.
 */
export function checkCaptureSurface(configured: string | undefined): GroupedCheck {
  if (configured === undefined) {
    return {
      group: 'capture',
      id: 'capture.surface',
      title: 'The capture surface is configured',
      status: 'unknown',
      detail:
        'This build does not read a capture-surface setting yet, so there is nothing to check it against.',
    };
  }
  return {
    group: 'capture',
    id: 'capture.surface',
    title: 'The capture surface is configured',
    status: 'ok',
    detail: `Configured as ${configured}.`,
  };
}

/**
 * The keeper tab (§3.15).
 *
 * **One blank page per browser that is never leased, never addressable and
 * never counted against the budget** — and it is a correctness mechanism, not
 * tidiness: a headed browser dies within about half a second of its last tab
 * closing, so without it the ordinary release path destroys the shared
 * authenticated session.
 *
 * §3.15 puts this check on `broker doctor` explicitly, "which checks it is
 * present before either browser is allowed to serve". Answering needs a live
 * browser to ask, so a browser that is not running reports `unknown` rather
 * than failing.
 */
export function checkKeeperTab(browser: BrowserId, present: boolean | undefined): GroupedCheck {
  const id = `browser.${browser}.keeper_tab`;
  const title = `The ${browser} browser has its keeper tab`;
  if (present === undefined) {
    return {
      group: 'keeper',
      id,
      title,
      status: 'unknown',
      detail: 'This browser is not reachable, so there is nothing to ask about a keeper tab.',
    };
  }
  return present
    ? { group: 'keeper', id, title, status: 'ok', detail: 'The keeper tab is present.' }
    : {
        group: 'keeper',
        id,
        title,
        status: 'failed',
        detail: 'No keeper tab. The last lease to be released would close the final tab.',
        remedy:
          'A spawn establishes the keeper tab. This command reports and does not create one — run the service against this browser.',
      };
}

/**
 * **Whether the stored tab budget agrees with this process's environment**
 * (§5.5, §1.10).
 *
 * This is the precondition §1.10 argues for at length, and it is worth
 * restating because it is the one whose failure is invisible without it:
 * several processes arbitrate against the budget at once, so in one process's
 * environment it can be fifteen and in another's thirty. **Each admits
 * callers against its own belief, each is internally consistent, and the
 * ceiling silently stops being a ceiling.** Nothing reports it. The count is
 * correct in every process and the machine is over budget anyway.
 *
 * So a disagreement is a **failure**, not a warning — and neither number is
 * adopted. A process running against a bound it was not configured for is a
 * configuration error somebody needs to see, and overwriting the stored value
 * would let whichever process started most recently move a bound the others
 * are mid-arbitration against.
 */
export function checkTabBudget(stored: number | null, configured: number | null): GroupedCheck {
  const id = 'config.tab_budget_agrees';
  const title = 'The stored tab budget agrees with this process’s environment';

  if (stored === null) {
    return {
      group: 'budget',
      id,
      title,
      status: 'unknown',
      detail:
        'No budget has been recorded in this store. The first process to open it records the value it believes.',
    };
  }
  if (configured === null) {
    return {
      group: 'budget',
      id,
      title,
      status: 'unknown',
      detail: `The store records ${String(stored)}, and this build does not read a tab-budget variable yet.`,
    };
  }
  if (stored !== configured) {
    return {
      group: 'budget',
      id,
      title,
      status: 'failed',
      detail: `The store records ${String(stored)} and this process’s environment says ${String(configured)}.`,
      remedy:
        'Reconcile the environment with the stored value. Two processes arbitrating against different bounds means the ceiling is not a ceiling, and neither value is adopted automatically.',
    };
  }
  return {
    group: 'budget',
    id,
    title,
    status: 'ok',
    detail: `Both say ${String(stored)}.`,
  };
}

/**
 * **Whether the signed-in browser's profile looks signed in** (§5.5.1).
 *
 * ── Why this check exists, and why it never fails ───────────────────────
 *
 * Signing in is the one step a person performs by hand, and until this check
 * existed there was **no way to confirm it worked** short of opening a
 * browser and looking — which is the one thing this command may not do.
 *
 * **It reports and never fails**, which is a deliberate choice rather than an
 * omission. A profile with no session in it is not a broken installation: it
 * is every installation, up until the moment somebody signs in. Failing here
 * would make `broker doctor` exit non-zero on a correct fresh install, and a
 * readiness check that cannot go green on a working machine is one people
 * learn to ignore. What it does instead is **say which of the two states it
 * found**, which is the question being asked.
 *
 * ── Why a zero count is not reported as "not signed in" ─────────────────
 *
 * `session.ts` carries the measurements; the part that matters here is that
 * the evidence is **positive-only**. Stored cookies mean a session was
 * written down. No stored cookies mean no evidence was found — which is also
 * what a site keeping its session in local storage looks like, and what a
 * profile whose browser has not flushed yet looks like. So those come back as
 * `unknown` **with the reason**, never as a confident negative.
 */
/**
 * **Whether a sign-in has been abandoned** (§5.5.1).
 *
 * ── Why this is the one sign-in check that can fail ─────────────────────
 *
 * Its neighbour {@link checkSignInSession} never fails, because a profile with
 * no session in it is every installation up until somebody signs in. This one
 * is the opposite kind of fact: a browser stuck in `signing-in` with **no
 * process holding it** is not a state any working installation is in. It
 * refuses every caller, and before it was recoverable it did so permanently.
 * So it is a genuine failure and is reported as one.
 *
 * ── The three answers, and why only one of them is a failure ────────────
 *
 * - **Owner gone** — failed. Nobody is signing in and every caller is being
 *   turned away. The remedy is the recovery path, named explicitly, because a
 *   check that reports a fault without saying what to do has moved the work
 *   rather than done it.
 * - **Owner running** — `ok`. Somebody is signing in right now, which is the
 *   command working exactly as designed. Reported rather than silent, so a
 *   person who cannot understand why callers are being refused can see the
 *   reason on this report instead of guessing.
 * - **Owner unknown** — `unknown`, never failed. A row written before the
 *   owner column existed records nobody, and calling that a fault would fail
 *   the report on an installation that may be perfectly healthy. The detail
 *   says what was found and what to do about it.
 */
export function checkAbandonedSignIn(browser: BrowserId, owner: SignInOwnerState): GroupedCheck {
  const id = `browser.${browser}.signin_owner`;
  const title = `No sign-in has been abandoned on the ${browser} browser`;

  if (owner.kind === 'not-signing-in') {
    return {
      group: 'session',
      id,
      title,
      status: 'ok',
      detail: 'The browser is not being signed into, so there is nothing to have been abandoned.',
    };
  }

  if (owner.kind === 'owner-running') {
    return {
      group: 'session',
      id,
      title,
      status: 'ok',
      detail:
        `A sign-in is in progress and the process holding it (${String(owner.pid)}) is running. ` +
        'Callers are being refused while it lasts; that is a pause rather than a fault.',
    };
  }

  if (owner.kind === 'owner-unknown') {
    return {
      group: 'session',
      id,
      title,
      status: 'unknown',
      detail:
        'The browser is recorded as being signed into, but this store does not say which process began it — ' +
        'so whether anybody is still signing in cannot be determined from here.',
      remedy: SIGN_IN_OWNER_UNKNOWN_REMEDY,
    };
  }

  return {
    group: 'session',
    id,
    title,
    status: 'failed',
    detail:
      `The browser is stuck being signed into: the process that began it (${String(owner.pid)}) has gone. ` +
      'Every caller asking for this browser is being refused, and nothing will clear it on its own.',
    remedy:
      'Run `broker login` — it reclaims a sign-in whose process is gone and then hands you the window. ' +
      'If you do not want to sign in, running it and closing the browser window it opens returns the browser to service.',
  };
}

export function checkSignInSession(browser: BrowserId, probe: SessionProbe): GroupedCheck {
  const id = `browser.${browser}.session`;
  const title = `The ${browser} browser’s profile carries a sign-in`;

  if (probe.evidence === 'session-present') {
    return {
      group: 'session',
      id,
      title,
      status: 'ok',
      detail: `The profile holds ${String(probe.cookieCount ?? 0)} stored cookie(s), so a session was established and written down.`,
    };
  }

  if (probe.evidence === 'no-profile') {
    return {
      group: 'session',
      id,
      title,
      status: 'unknown',
      detail:
        probe.reason ??
        'There is no profile directory yet, so there is nothing to look for a session in.',
    };
  }

  if (probe.evidence === 'undetermined') {
    return {
      group: 'session',
      id,
      title,
      status: 'unknown',
      detail: probe.reason ?? 'The profile could not be inspected, so nothing is concluded.',
    };
  }

  // `no-session-found`. Reported as unknown rather than failed, and the
  // detail says exactly how strong the evidence is — the absence of a stored
  // cookie is not proof that nobody is signed in.
  return {
    group: 'session',
    id,
    title,
    status: 'unknown',
    detail:
      probe.reason ??
      'No stored cookies were found in the profile, which is what a profile nobody has signed into looks like.',
    remedy: `Run \`broker login\` to sign in to the ${browser} browser by hand. It is the one step a person performs, and it happens once.`,
  };
}
