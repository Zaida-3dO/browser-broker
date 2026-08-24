import type { StoreHandle } from '../store/open.ts';
import type { BrowserId } from './driver.ts';

/**
 * The launch race, arbitrated by the same transaction that arbitrates claims.
 *
 * ── Why it is the same mechanism and not a second one ───────────────────
 *
 * `SCHEMA.md` §1.2a: two callers arriving at an empty machine at the same
 * instant are **the same problem** as two callers claiming the last tab, and
 * it gets the same answer rather than a new mechanism — **one row, one
 * winner.** The loser does not launch a second browser; it waits and then
 * attaches to the winner's. A second launch would be two browsers against one
 * profile directory contending on its lock, which is the failure the explicit
 * profile directory exists to prevent — and which was measured to fail
 * *silently*, the second process handing its address to the first and exiting
 * zero.
 *
 * ── The rule this file exists to keep ───────────────────────────────────
 *
 * **No browser work happens inside the arbitration transaction** (§2.4b,
 * `arbitration.no_browser_io`). One unresponsive browser inside it blocks
 * every arbitration call on the machine. So this file decides *what to do*
 * inside the transaction and returns that decision; the caller performs it
 * outside. Nothing here is handed a driver, and that is structural rather
 * than a convention — there is no parameter through which a browser could
 * reach this module.
 *
 * The transaction is opened `IMMEDIATE`, via the store handle's only
 * transaction affordance, so it declares its intent to write at the moment it
 * opens. That is what makes the store serialise the writers itself rather
 * than discovering a conflict at the end (§1.0a).
 */

/** What a caller was told to do about a browser that is not running. */
export type AdoptionDecision =
  /** This caller won the race and must perform the cold start. */
  | { readonly action: 'launch'; readonly browser: BrowserId }
  /**
   * A browser is already running. Attach to it — the ordinary case.
   *
   * The endpoint is carried through from the store, and it is **still a claim
   * rather than a proof** (§1.2c): the caller verifies it before connecting,
   * which is the driver's job and happens outside this transaction.
   */
  | {
      readonly action: 'attach';
      readonly browser: BrowserId;
      readonly endpoint: string;
      readonly browserUuid: string;
    }
  /**
   * Another caller won the race and is starting the browser now.
   *
   * **What the loser waits for, and for how long, is row #55's open
   * question** (§1.2b) and is deliberately not answered here. Winning the
   * race and having an endpoint that accepts connections are different
   * moments, and a fixed pause is a number that is too long on every fast
   * machine and too short on the one slow machine where it matters. This
   * decision reports the state and stops; it does not invent a bound.
   */
  | { readonly action: 'wait'; readonly browser: BrowserId };

/**
 * Decide, under arbitration, what this caller should do about a browser.
 *
 * `runningRecord` is what the caller observed **before** calling — the
 * verified discovery record if a browser is genuinely reachable, or
 * `undefined` if not. It is a parameter rather than something read here for
 * one reason: reading it means talking to a browser, and this runs inside the
 * transaction.
 *
 * That ordering has a consequence worth stating rather than leaving to be
 * discovered: the observation is made outside the lock, so it can be stale by
 * the time the transaction opens. The `starting` state is what covers the gap
 * — a caller whose observation said *nothing is running* still loses the race
 * if another caller has already recorded that it is launching, and the store
 * is what settles that rather than the observation.
 */
export async function decideAdoption(
  store: StoreHandle,
  browser: BrowserId,
  runningRecord: { readonly endpoint: string; readonly browserUuid: string } | undefined,
): Promise<AdoptionDecision> {
  return store.immediate<AdoptionDecision>(({ db }) => {
    const row = db
      .prepare<
        [BrowserId],
        { state: string; endpoint: string | null; browser_uuid: string | null }
      >('SELECT state, endpoint, browser_uuid FROM browsers WHERE id = ?')
      .get(browser);

    if (row === undefined) {
      // The two rows are created by the first schema step and there is no
      // delete operation on any surface, so this is a store that was not
      // stepped rather than a browser that went missing.
      throw new Error(
        `The store has no row for the ${browser} browser. The two rows are created by the first schema step, so this store has not been stepped.`,
      );
    }

    // The caller verified a live browser. Record what it found and attach.
    // This also repairs a row that says `stopped` while a browser is in fact
    // running — which is the ordinary state after a process died between
    // launching a browser and recording it.
    if (runningRecord !== undefined) {
      // `pid` is coalesced rather than overwritten, and the constraint is why
      // it cannot simply be left alone: the row's check requires an
      // identifier for every state that is not stopped, and this path moves a
      // row to `running` that may be stopped, holding a null one.
      //
      // **Never overwritten**, because the identifier already there is the
      // browser's and this process does not know it — the browser was adopted,
      // not started here, so there is no handle to read one from. Writing this
      // process's identifier over the browser's would corrupt the one fact
      // §1.2 calls the isolation fact: the service acts on the process
      // recorded here and on nothing else. Falling back to this process's
      // identifier only when there is none at all keeps the row legal while
      // never claiming to know something it does not; the browser's own
      // identifier is restored by whichever caller launches it next.
      db.prepare(
        `UPDATE browsers
            SET state = 'running',
                pid = COALESCE(pid, ?),
                endpoint = ?,
                browser_uuid = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?`,
      ).run(process.pid, runningRecord.endpoint, runningRecord.browserUuid, browser);

      return {
        value: {
          action: 'attach',
          browser,
          endpoint: runningRecord.endpoint,
          browserUuid: runningRecord.browserUuid,
        } as const,
      };
    }

    // Nothing is running, and somebody else has already said they are
    // starting it. One row, one winner — this caller is the loser and waits.
    if (row.state === 'starting') {
      return { value: { action: 'wait', browser } as const };
    }

    // Nothing is running and nobody has claimed the launch. Claim it here,
    // inside the transaction, so a second caller arriving now sees
    // `starting` and waits instead of launching a second browser.
    //
    // ── Why `pid` is this process and not the browser's ─────────────────
    //
    // The row's check constraint ties a null identifier to the stopped state
    // and requires one for every other state, so `starting` cannot be
    // recorded with a null identifier — and it must be recorded *before* a
    // browser process exists, because claiming the race is the whole point of
    // doing it inside the transaction. The browser's identifier is not a fact
    // yet and writing a placeholder would be a lie the reclamation path
    // branches on.
    //
    // So what is written is the identifier of **the process that is
    // launching**, which is a true statement about the row for the duration
    // it holds: during `starting`, the thing to look at if this browser never
    // comes up is the caller that took the race. {@link recordLaunched}
    // writes the browser's own identifier over it at the moment that becomes
    // a fact, and {@link recordLaunchFailed} clears it back to null along
    // with the state.
    db.prepare(
      `UPDATE browsers
          SET state = 'starting',
              pid = ?,
              endpoint = NULL,
              browser_uuid = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?`,
    ).run(process.pid, browser);

    return { value: { action: 'launch', browser } as const };
  });
}

/**
 * Record a browser this caller successfully started.
 *
 * Separate from {@link decideAdoption} and called **after** the launch,
 * because the launch is browser work and browser work does not happen inside
 * the arbitration transaction. The two calls are two transactions by design,
 * and the window between them is exactly what the `starting` state exists to
 * describe. This writes the browser's own identifier over the placeholder the
 * race left, at the moment it becomes a fact.
 */
export async function recordLaunched(
  store: StoreHandle,
  browser: BrowserId,
  launched: { readonly pid: number; readonly endpoint: string; readonly browserUuid: string },
): Promise<void> {
  await store.immediate(({ db }) => {
    db.prepare(
      `UPDATE browsers
          SET state = 'running',
              pid = ?,
              endpoint = ?,
              browser_uuid = ?,
              launched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?`,
    ).run(launched.pid, launched.endpoint, launched.browserUuid, browser);
    return { value: undefined };
  });
}

/**
 * Record that a launch this caller won did not produce a browser.
 *
 * Without this, a caller that wins the race and then fails leaves the row at
 * `starting` forever, and **every later caller waits for a launch that is
 * never coming**. Releasing the race is therefore part of failing it, not
 * cleanup that can be skipped.
 */
export async function recordLaunchFailed(store: StoreHandle, browser: BrowserId): Promise<void> {
  await store.immediate(({ db }) => {
    db.prepare(
      `UPDATE browsers
          SET state = 'stopped',
              pid = NULL,
              endpoint = NULL,
              browser_uuid = NULL,
              launched_at = NULL,
              restart_count = restart_count + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?`,
    ).run(browser);
    return { value: undefined };
  });
}
