/**
 * Reclaiming a sign-in whose owner is gone (`SCHEMA.md` §5.5.1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS EVEN THOUGH A SIGNAL HANDLER ALSO EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `broker login` installs a handler that gives the browser back on `SIGINT`
 * and `SIGTERM`, which covers Ctrl-C — the way a person actually stops a
 * command that is sitting there waiting. **That handler is not sufficient and
 * this module is not a belt on top of it.**
 *
 * A handler is code the dying process runs, so it covers exactly the deaths
 * that let a process run code. It does not cover `SIGKILL`, which cannot be
 * handled by design. It does not cover a power cut, a battery running out, or
 * a machine being reset. It does not cover the process being killed by an
 * out-of-memory reaper, and it does not cover a crash in the runtime itself.
 * In every one of those the browser stays `signing-in` and — before this
 * module — **stayed that way forever**, refusing every caller and refusing the
 * second `broker login` that would have ended it, so the only exit was editing
 * the database by hand.
 *
 * So the guarantee is split deliberately, and each half is honest about its
 * reach:
 *
 * - **The handler** returns the browser promptly on an interruption, which is
 *   the common case and the one where a person is watching.
 * - **This module** makes the state recoverable when nothing ran at all. It
 *   asks a question about the world rather than trusting that some earlier
 *   process did its job.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY LIVENESS IS ASKED OF THE OWNER, AND WHAT THE ANSWER IS WORTH
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A sign-in has no expiry (§5.5.1) — a person takes as long as they take, and
 * a timeout would end a sign-in that was going fine. So there is no lapse for
 * the lease sweep to notice, and the sweep is not extended to invent one.
 * The question is settled by evidence instead: **the process that began the
 * sign-in is either running or it is not.**
 *
 * ── The one inference this module draws, and the one it refuses to ──────
 *
 * The same discipline `login-command.ts` states for browsers applies here, and
 * it points the other way round, so it is worth being exact.
 *
 * - **A process that does not exist is not signing anybody in.** That is a
 *   sound negative: `ESRCH` from a zero-signal means no process holds that
 *   identifier now, and a command that is not running cannot be waiting for a
 *   person. This is the only conclusion used to reclaim.
 * - **A process that exists is not evidence the sign-in is live**, because
 *   process identifiers are reused. This module therefore never reports a
 *   live owner as proof of anything — it simply declines to reclaim, which is
 *   the safe direction: the cost of declining is that a person runs one more
 *   command, and the cost of reclaiming wrongly is a browser taken out from
 *   under somebody mid-sign-in.
 *
 * **Identifier reuse is why the live answer is worth so much less than the
 * dead one.** A reused identifier can only make this module *more* cautious,
 * never less: it can turn a dead owner into an apparently-live one and cost a
 * reclamation, and it cannot turn a live owner into a dead one.
 *
 * ── An unknown owner is not a dead owner ────────────────────────────────
 *
 * A store written before the owner column existed carries `signing-in` rows
 * with no owner recorded. Those are reported as **unknown**, never reclaimed:
 * reclaiming on the strength of a missing record would mean ending a sign-in
 * because an old build did not write down who started it, which is a guess
 * dressed as a fact. A person is told what was found and what to do.
 */

/**
 * Whether a process identifier belongs to something running now.
 *
 * A seam rather than a direct call, so both answers are reachable from a test
 * without spawning and killing real processes — and, more importantly, so the
 * *reclaim* path can be driven against a dead owner deterministically. A test
 * that had to race a real process would be a test that passes when the timing
 * happens to work.
 */
export type ProcessLiveness = (pid: number) => boolean;

/**
 * The real answer: signal zero.
 *
 * Signal zero performs the error checking a real signal would and **sends
 * nothing**, which is the standard way to ask whether an identifier is live
 * without disturbing what holds it.
 *
 * `EPERM` is treated as **alive**, and that is the load-bearing case rather
 * than a detail: it means a process with that identifier exists and belongs to
 * somebody this user may not signal. Reading a permission error as "gone"
 * would reclaim a browser out from under a sign-in that is running perfectly
 * well under another account — the exact failure this module must not cause,
 * and the one the caution above is spent on.
 */
export function livenessFromSignalError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ESRCH') {
    return false;
  }
  // `EPERM` — and anything else this cannot interpret — is read as alive.
  // **The unsafe direction is concluding "gone"**, so an unrecognised error
  // never reaches it: a permission error means a process with that identifier
  // exists and belongs to somebody this user may not signal, and reading that
  // as gone would reclaim a browser out from under a sign-in running perfectly
  // well under another account.
  //
  // Split out of {@link processIsRunning} so this decision is reachable from a
  // test. It is the branch a real process cannot be made to produce on demand
  // — you cannot conjure an `EPERM` from a process you own — and it is the one
  // whose failure is silent and severe.
  return true;
}

export const processIsRunning: ProcessLiveness = (pid: number): boolean => {
  // A non-positive identifier is not a process. Guarded rather than passed
  // through, because zero and the negatives address process *groups* on a
  // POSIX system: `kill(0, 0)` asks about the caller's own group and would
  // answer "alive" about whatever is asking, turning a nonsense value into a
  // confident wrong answer.
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return livenessFromSignalError(error);
  }
};

/** What a `signing-in` browser's owner turned out to be. */
export type SignInOwnerState =
  /** Not signing in at all. Nothing to recover. */
  | { readonly kind: 'not-signing-in' }
  /** Signing in, and the process that began it is still running. */
  | { readonly kind: 'owner-running'; readonly pid: number }
  /** Signing in, and the process that began it is gone. Reclaimable. */
  | { readonly kind: 'owner-gone'; readonly pid: number }
  /** Signing in, and no owner was recorded — an older build, or an older row. */
  | { readonly kind: 'owner-unknown' };

/** The row this module reads. Just the two columns it decides on. */
export interface SignInBrowserRow {
  readonly state: string;
  readonly signin_owner_pid: number | null;
}

/**
 * Classify a browser row against the world.
 *
 * Pure given its liveness function, so every branch is reachable from a test
 * — including the two that matter most, a dead owner and an unrecorded one,
 * neither of which can be produced on demand by killing something real.
 */
export function classifySignIn(
  row: SignInBrowserRow | undefined,
  isRunning: ProcessLiveness = processIsRunning,
): SignInOwnerState {
  if (row === undefined || row.state !== 'signing-in') {
    return { kind: 'not-signing-in' };
  }

  const pid = row.signin_owner_pid;
  if (pid === null) {
    return { kind: 'owner-unknown' };
  }

  return isRunning(pid) ? { kind: 'owner-running', pid } : { kind: 'owner-gone', pid };
}

/**
 * What a person is told about a sign-in that cannot be recovered
 * automatically, and what to do about it.
 *
 * Written here rather than at each surface so `doctor` and the refusal a
 * second `login` produces say the same thing. Two spellings of one remedy is
 * how they come to disagree, and the disagreement is discovered by somebody
 * who is already stuck.
 */
export const SIGN_IN_OWNER_UNKNOWN_REMEDY =
  'This store does not record which process began that sign-in, so it cannot be confirmed abandoned. ' +
  'If nobody is signing in, run `broker login` — it reclaims a sign-in whose process is gone, and ' +
  'a sign-in recorded without an owner is left alone rather than ended on a guess.';
