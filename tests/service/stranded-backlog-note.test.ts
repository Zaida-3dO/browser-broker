import assert from 'node:assert/strict';
import test from 'node:test';

import type { Database } from 'better-sqlite3';

import { claimInput, withBroker } from '../helpers/broker.ts';
import { seedClaim } from '../helpers/leases.ts';

/**
 * The note on a granted claim, when the browser it was granted on is carrying
 * a backlog of tabs stranded mid-close (§2.4b, the tab lifecycle).
 *
 * ── The incident these tests are written from ───────────────────────────
 *
 * Six callers were killed mid-lease over several hours, each holding a tab
 * and none releasing. Twenty-nine tab rows were left waiting on a close
 * nobody was coming to answer. **Five consecutive claims were then granted**
 * on that browser, and every subsequent page call failed with the browser
 * reporting itself closed. `broker doctor` had the whole story and named it
 * in one call — but a caller has no reason to run `doctor` while its claims
 * are succeeding, so five round trips were spent misdiagnosing it as a login
 * problem.
 *
 * The information existed and was not where the caller was looking. These
 * tests assert it is now on the response the caller is already reading.
 */

/**
 * A tab row stranded at `closing`, older than any lease may go without
 * contact.
 *
 * Written directly rather than through an operation on purpose: the state
 * this describes is produced by a caller *dying*, which no operation
 * performs. The schema's own constraints still apply — the composite foreign
 * key means the browser here cannot disagree with its lease's.
 */
function seedStrandedTab(db: Database, browserId: 'regular' | 'private', ageSeconds: number): void {
  const lease = seedClaim(db, { browserId, state: 'expired' });
  const at = new Date(Date.now() - ageSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO tabs (id, claim_id, browser_id, driver_tab_id, state, opened_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'closing', ?, ?, ?)`,
  ).run(
    `tab-${Math.random().toString(36).slice(2)}`,
    lease.claimId,
    browserId,
    `driver-${Math.random().toString(36).slice(2)}`,
    at,
    at,
    at,
  );
}

test('A GRANTED CLAIM CARRIES THE BACKLOG NOTE — the five grants that could not be used', async () => {
  await withBroker(async ({ broker, store, environment }) => {
    // Older than the lease lifetime, which is the boundary `doctor` already
    // uses to separate "a close is in flight" from "a close is never
    // happening". A row inside that window is a healthy release.
    const stale = environment.leaseSeconds + 60;
    for (let index = 0; index < 3; index += 1) {
      seedStrandedTab(store.db, 'regular', stale);
    }

    const result = await broker.claim(claimInput({ browser: 'regular' }));

    // The grant is real. This is a note on a grant and not a refusal: the
    // lease is active and the tab row exists, so refusing would tell a caller
    // to retry a decision that is already committed.
    assert.equal(result.outcome, 'granted');
    assert.ok(result.key.length > 0, 'the lease was genuinely granted');

    assert.ok(result.strandedBacklog !== undefined, 'the backlog was not reported on the grant');
    assert.equal(result.strandedBacklog.stranded, 3);
    // The count, so a caller can tell 3 from 29.
    assert.match(result.strandedBacklog.note, /3 tab/u);
    // The browser, named, so the remedy can be run as typed.
    assert.match(result.strandedBacklog.note, /regular/u);
    // The remedy. A note naming a problem without naming what to do about it
    // has moved the work rather than done it.
    assert.match(result.strandedBacklog.note, /broker reconcile regular/u);
  });
});

test('a claim on a healthy browser carries no note at all', async () => {
  // The negative control, and the assertion that stops the note being
  // unconditional. Absent rather than zero-valued, so the field's presence is
  // itself the signal — the convention `notDrivenReason` follows.
  await withBroker(async ({ broker }) => {
    const result = await broker.claim(claimInput({ browser: 'regular' }));

    assert.equal(result.outcome, 'granted');
    assert.equal(
      result.strandedBacklog,
      undefined,
      'a healthy browser must not carry a backlog note',
    );
  });
});

test('a close still inside its round trip is not counted as stranded', async () => {
  // The threshold, asserted from the side that would make it noise. A tab
  // moved to `closing` a moment ago is a healthy release in flight; counting
  // it would make every ordinary release look like a fault, and a note that
  // fires on healthy state is one callers learn to ignore.
  await withBroker(async ({ broker, store, environment }) => {
    seedStrandedTab(store.db, 'regular', Math.max(1, Math.floor(environment.leaseSeconds / 2)));

    const result = await broker.claim(claimInput({ browser: 'regular' }));

    assert.equal(result.outcome, 'granted');
    assert.equal(
      result.strandedBacklog,
      undefined,
      'a close inside the lease window is in flight, not stranded',
    );
  });
});

test('the note counts only the browser being claimed, not the whole store', async () => {
  // The fixture makes right and wrong differ in *what* is counted rather than
  // in whether anything is counted: a backlog on each browser, of different
  // sizes. A note reporting the store-wide total would say 5 here, and a
  // caller acting on it would reconcile a browser that did not need it.
  await withBroker(async ({ broker, store, environment }) => {
    const stale = environment.leaseSeconds + 60;
    seedStrandedTab(store.db, 'regular', stale);
    seedStrandedTab(store.db, 'regular', stale);
    seedStrandedTab(store.db, 'private', stale);
    seedStrandedTab(store.db, 'private', stale);
    seedStrandedTab(store.db, 'private', stale);

    const result = await broker.claim(claimInput({ browser: 'regular' }));

    assert.equal(result.outcome, 'granted');
    assert.ok(result.strandedBacklog !== undefined, 'the backlog was not reported');
    assert.equal(result.strandedBacklog.stranded, 2, 'only the claimed browser backlog is counted');
    assert.match(result.strandedBacklog.note, /2 tab/u);
    assert.doesNotMatch(result.strandedBacklog.note, /private/u);
  });
});

test('the note that fired is recorded in the ledger, not only told to the caller', async () => {
  // Each occurrence resolves itself invisibly once the caller acts on it,
  // which is exactly why it is recorded: without a row there is no way to
  // learn that granting into a browser with a backlog has become common, and
  // *common* is the signal that something upstream is killing callers
  // mid-lease. The nudge sets this precedent — the advice is advice, the row
  // is the evidence.
  await withBroker(async ({ broker, store, environment, readCommitted }) => {
    seedStrandedTab(store.db, 'regular', environment.leaseSeconds + 60);

    const result = await broker.claim(claimInput({ browser: 'regular' }));
    assert.equal(result.outcome, 'granted');

    // Read on the second, read-only connection: what committed, not what the
    // writing handle can see.
    const rows = readCommitted<{ detail: string }>(
      "SELECT detail FROM events WHERE kind = 'claim_granted'",
    );
    const notes = rows.filter((row) => row.detail.includes('stranded_backlog'));
    assert.equal(notes.length, 1, 'the note that fired left exactly one row');
    assert.match(notes[0]?.detail ?? '', /"stranded":1/u);
  });
});
