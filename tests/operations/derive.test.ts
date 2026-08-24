import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveClaimState, isLive, secondsBetween } from '../../src/operations/derive.ts';

/**
 * The expiry derivation, tested against the rule it exists to enforce.
 *
 * `SCHEMA.md` §2.4: **stored state is provisional, derived state is the
 * truth.** A row saying `active` whose expiry has elapsed is not an active
 * lease, and the difference is invisible in the row.
 *
 * **What single change would break each of these** — the question `CLAUDE.md`
 * asks of every test, answered per block rather than left implied:
 *
 * - Removing the `hasElapsed` branch from `deriveClaimState`, so it returns
 *   the stored state, fails "a lapsed active lease derives as expired" and
 *   "a lapsed queued lease derives as expired".
 * - Changing `<=` to `<` in `hasElapsed` fails "the boundary is inclusive".
 * - Inverting the comparison fails every case at once.
 * - Making the final-state guard fall through fails "a final state is final".
 */
describe('the expiry derivation', () => {
  const now = '2026-03-01T12:00:00.000Z';
  const past = '2026-03-01T11:59:59.999Z';
  const future = '2026-03-01T12:00:00.001Z';

  it('reports a live active lease as active', () => {
    assert.equal(deriveClaimState({ state: 'active', expires_at: future }, now), 'active');
  });

  it('reports a lapsed active lease as expired, not as active', () => {
    // The whole rule, in one assertion. The row says `active`; the truth is
    // `expired`, and a reader that printed the column would print `active`.
    assert.equal(deriveClaimState({ state: 'active', expires_at: past }, now), 'expired');
  });

  it('reports a lapsed queued lease as expired, not as queued', () => {
    // §1.5: "a queued lease expires by the same sweep as a live one", and
    // that expiry is load-bearing rather than tidiness — a caller that died
    // while waiting holds the front of the queue and blocks everyone behind
    // it, which is invisible in a capacity count.
    assert.equal(deriveClaimState({ state: 'queued', expires_at: past }, now), 'expired');
  });

  it('treats the boundary as inclusive, matching the sweep', () => {
    // A lease whose expiry is exactly now has elapsed. The sweep selects rows
    // at or past their expiry, and a reader disagreeing by one instant would
    // show `active` for a lease the very next call expires.
    assert.equal(deriveClaimState({ state: 'active', expires_at: now }, now), 'expired');
  });

  it('leaves a final state alone however long ago it ended', () => {
    // §2.1: final is final. No passage of time turns a released lease into
    // an expired one, and a derivation that rewrote it would misreport how a
    // lease actually ended.
    assert.equal(deriveClaimState({ state: 'released', expires_at: past }, now), 'released');
    assert.equal(deriveClaimState({ state: 'revoked', expires_at: past }, now), 'revoked');
    assert.equal(deriveClaimState({ state: 'expired', expires_at: past }, now), 'expired');
  });

  it('does not invent a sixth state', () => {
    // The derivation reuses the word the sweep will write. A reader inventing
    // `lapsed` would produce a document whose vocabulary appears nowhere else
    // in the system.
    const derived = deriveClaimState({ state: 'active', expires_at: past }, now);
    assert.ok(['queued', 'active', 'released', 'expired', 'revoked'].includes(derived));
  });
});

describe('liveness', () => {
  const now = '2026-03-01T12:00:00.000Z';

  it('counts a live active lease and a live queue place', () => {
    assert.equal(isLive({ state: 'active', expires_at: '2026-03-01T12:05:00.000Z' }, now), true);
    assert.equal(isLive({ state: 'queued', expires_at: '2026-03-01T12:05:00.000Z' }, now), true);
  });

  it('does not count a lapsed lease, however its row reads', () => {
    // This is the assertion the budget count depends on: counting rows whose
    // stored state is live reports an installation as fuller than it is.
    assert.equal(isLive({ state: 'active', expires_at: '2026-03-01T11:00:00.000Z' }, now), false);
    assert.equal(isLive({ state: 'queued', expires_at: '2026-03-01T11:00:00.000Z' }, now), false);
  });

  it('does not count a lease that already ended', () => {
    assert.equal(isLive({ state: 'released', expires_at: '2026-03-01T12:05:00.000Z' }, now), false);
  });
});

describe('the interval between two of the store’s timestamps', () => {
  it('counts forward', () => {
    assert.equal(secondsBetween('2026-03-01T12:00:00.000Z', '2026-03-01T12:01:30.000Z'), 90);
  });

  it('returns a negative number for an expiry that has already passed', () => {
    // Not clamped. §2.4 is about exactly this window, and a zero here would
    // hide it.
    assert.equal(secondsBetween('2026-03-01T12:00:00.000Z', '2026-03-01T11:59:00.000Z'), -60);
  });

  it('answers zero rather than throwing on something it cannot parse', () => {
    assert.equal(secondsBetween('not a timestamp', '2026-03-01T12:00:00.000Z'), 0);
  });
});
