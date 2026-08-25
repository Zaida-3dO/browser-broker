import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step eight: a sign-in records **which process is holding it**.
 *
 * ── The failure this exists to make recoverable ─────────────────────────
 *
 * `broker login` moves the browser to `signing-in` and gives it back in a
 * `finally`. **A `finally` does not run when the process is signalled**, so a
 * person who pressed Ctrl-C — the ordinary way anybody stops a command that is
 * waiting — left the browser in `signing-in` with nothing able to move it out.
 * Every caller was then refused `browser.serving` forever, and a second
 * `broker login` was refused too, because §5.5.1 permits only one sign-in at a
 * time. The state was reachable by one keystroke and escapable only by editing
 * the database by hand.
 *
 * A signal handler is added alongside this step and covers the interruption
 * case. **It cannot cover the rest**, and that is the whole reason this column
 * exists: `SIGKILL` cannot be handled at all, a power cut runs nothing, and a
 * process that dies in the kernel runs nothing either. Any mechanism that
 * relies on the dying process doing something is a mechanism with a hole in
 * exactly the cases nobody can rehearse.
 *
 * ── Why a new column rather than reusing `browsers.pid` ─────────────────
 *
 * **`browsers.pid` is the browser's process, not the sign-in's**, and the two
 * are different processes with different lifetimes: the browser is adopted and
 * deliberately outlives the command (`login-command.ts` detaches precisely so
 * the person's window survives). Reading it as the owner would ask "is the
 * browser still up" while meaning "is the person's command still running", and
 * those answers diverge in both directions.
 *
 * Worse, step seven made `signing-in` the one state permitted a **null** pid,
 * because a first sign-in on a fresh installation claims a browser that has
 * never been started. That is the commonest sign-in there is, and it is
 * precisely the one where `browsers.pid` carries nothing to test.
 *
 * ── Why not the lease sweep ─────────────────────────────────────────────
 *
 * The sweep expires **claims** whose `expires_at` has passed. A sign-in is not
 * a claim: it takes no lease and no tab budget (§5.5.1), it is a state on the
 * `browsers` row, and it has no expiry — deliberately, because a person
 * signing in may take as long as they take and a sweep that timed them out
 * would end a sign-in that was going fine. So there is no lapse for the sweep
 * to notice, and extending it to notice one would mean inventing a deadline
 * the design does not have.
 *
 * The question is settled by **evidence** instead: the owner is either running
 * or it is not, which is a fact rather than a timer.
 *
 * ── Nullable, and what each value means ─────────────────────────────────
 *
 * - **Null while the browser is not signing in.** There is no owner, so
 *   recording one would be a claim about a process that is not doing anything.
 * - **Set for the duration of a sign-in**, to the process identifier of the
 *   command that began it.
 *
 * It is deliberately **not** constrained to be non-null on `signing-in`. A
 * store written by an older build carries `signing-in` rows with no owner, and
 * a constraint would make this step fail on exactly the installations that hit
 * the bug. Those rows read as "owner unknown", which the recovery path reports
 * as such rather than reclaiming on a guess.
 *
 * **A new step rather than an edit to step seven**, per the rule in
 * `steps.ts`: a step that has run somewhere is history.
 */
const ADD_COLUMN = `ALTER TABLE browsers ADD COLUMN signin_owner_pid INTEGER`;

/** Every statement this step runs, in order. */
export const STEP_EIGHT_SQL: readonly string[] = [ADD_COLUMN];

export const stepEight: Step = {
  version: 8,
  summary: 'A sign-in records the process holding it, so an abandoned one is recoverable (§5.5.1).',
  apply: (db: Database) => {
    for (const statement of STEP_EIGHT_SQL) {
      db.exec(statement);
    }
  },
};
