import assert from 'node:assert/strict';
import test from 'node:test';

import { withBroker } from '../helpers/broker.ts';

/**
 * Claims against the attached kind (`SCHEMA.md` §3.2, `DECISIONS.md` §13n).
 *
 * ── The shape every test here shares ────────────────────────────────────
 *
 * A refusal asserts **what the store did not get**, not merely the message:
 * no claim row, no queue row, no tab row, and — for the cap — the counts it
 * refused against unmoved. `CLAUDE.md` is explicit that a guard which answers
 * "denied" after writing is worse than no guard, and at the claim layer the
 * rows *are* the physical side-effect: capacity is the claim row (§2.3), so
 * an over-cap claim that left a row behind would be capacity taken by a
 * refusal.
 *
 * ── The one that outranks the rest ──────────────────────────────────────
 *
 * An unnamed claim must never land on the attached browser. Every other
 * wrong default in this table costs a caller the wrong page; this one puts
 * work inside a person's own window, in front of them, in their identity —
 * the outcome §13n exists to make unreachable. So it is asserted first, and
 * asserted through the committed row rather than the response.
 */

/** A seed entry that validates — refused here for the browser, not the entry. */
const SEED = [{ origin: 'https://example.com', area: 'local', key: 'auth', value: 'a-value' }];

function rows<T>(
  readCommitted: <T2>(sql: string, parameters?: Record<string, unknown>) => T2[],
  sql: string,
): T[] {
  return readCommitted<T>(sql);
}

function messageOf(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => {
      assert.fail('expected a refusal');
    },
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

// ── Resolution: explicit only ────────────────────────────────────────────

test('the word `attached` resolves to the configured attached browser, and its row carries the kind', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      const result = await broker.claim({
        sessionId: 'session-a',
        browser: 'attached',
        purpose: 'naming the kind explicitly',
      });
      assert.equal(result.outcome, 'granted');
      const claimRows = readCommitted<{ browser_id: string }>(
        'SELECT browser_id FROM claims WHERE id = @id',
        { id: result.claimId },
      );
      assert.deepEqual(
        claimRows.map((row) => row.browser_id),
        ['desktop'],
      );
      const browserRows = readCommitted<{ kind: string }>(
        'SELECT kind FROM browsers WHERE id = @id',
        { id: 'desktop' },
      );
      // The kind comes from the list the name was found in — an attached
      // row written as `regular` would later buy itself a profile and a
      // launch nothing configured.
      assert.deepEqual(
        browserRows.map((row) => row.kind),
        ['attached'],
      );
    },
    { attachedBrowsers: ['desktop'], attachedExtensionId: 'abcdefghijklmnopabcdefghijklmnop' },
  );
});

test('the configured name of an attached browser claims it exactly', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      const result = await broker.claim({
        sessionId: 'session-a',
        browser: 'desktop',
        purpose: 'naming one browser exactly',
      });
      assert.equal(result.outcome, 'granted');
      const claimRows = readCommitted<{ browser_id: string }>(
        'SELECT browser_id FROM claims WHERE id = @id',
        { id: result.claimId },
      );
      assert.deepEqual(
        claimRows.map((row) => row.browser_id),
        ['desktop'],
      );
    },
    { attachedBrowsers: ['desktop'], attachedExtensionId: 'abcdefghijklmnopabcdefghijklmnop' },
  );
});

test('an UNSTATED claim never lands on the attached browser', async () => {
  // The named test of §13n's boundary. The attached name sits in the same
  // store, is configured, and is grantable — and the default must walk past
  // it to the first signed-in browser every time.
  await withBroker(
    async ({ broker, readCommitted }) => {
      const unnamed = await broker.claim({
        sessionId: 'session-a',
        purpose: 'stating no browser at all',
      });
      assert.equal(unnamed.outcome, 'granted');
      const rows1 = readCommitted<{ browser_id: string }>(
        'SELECT browser_id FROM claims WHERE id = @id',
        { id: unnamed.claimId },
      );
      assert.deepEqual(
        rows1.map((row) => row.browser_id),
        ['checkout'],
      );

      const byKind = await broker.claim({
        sessionId: 'session-b',
        browser: 'regular',
        purpose: 'the signed-in kind word with attached configured',
      });
      const rows2 = readCommitted<{ browser_id: string }>(
        'SELECT browser_id FROM claims WHERE id = @id',
        { id: byKind.claimId },
      );
      assert.deepEqual(
        rows2.map((row) => row.browser_id),
        ['checkout'],
      );
    },
    {
      regularBrowsers: ['checkout'],
      privateBrowsers: ['scratch'],
      attachedBrowsers: ['desktop'],
      attachedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    },
  );
});

test('the word `attached` on an installation with nothing attached is refused, and writes nothing', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const message = await messageOf(() =>
      broker.claim({
        sessionId: 'session-a',
        browser: 'attached',
        purpose: 'asking for a kind this installation does not have',
      }),
    );
    assert.match(message, /attached/);
    assert.match(message, /regular/);
    assert.deepEqual(rows<{ id: string }>(readCommitted, 'SELECT id FROM claims'), []);
  });
});

// ── Storage seed: refused on the person's own browser ───────────────────

test('a storage seed on an attached claim is refused, and no row of any kind is written', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      const message = await messageOf(() =>
        broker.claim({
          sessionId: 'session-a',
          browser: 'desktop',
          purpose: 'trying to seed a credential into the operator browser',
          storageSeed: SEED,
        }),
      );
      assert.match(message, /seed/i);

      // The physical half: the refusal sits before the first insert, so the
      // claim, its tab, and any queue place are all absent.
      assert.deepEqual(rows<{ id: string }>(readCommitted, 'SELECT id FROM claims'), []);
      assert.deepEqual(rows<{ id: string }>(readCommitted, 'SELECT id FROM tabs'), []);
    },
    { attachedBrowsers: ['desktop'], attachedExtensionId: 'abcdefghijklmnopabcdefghijklmnop' },
  );
});

test('the same seed on a non-attached claim is still accepted, so the refusal is about the browser', async () => {
  // The control. Without it, the test above could be satisfied by a build
  // that refused every seed.
  await withBroker(async ({ broker }) => {
    const result = await broker.claim({
      sessionId: 'session-a',
      browser: 'regular',
      purpose: 'the same seed on a browser the service owns',
      storageSeed: SEED,
    });
    assert.equal(result.outcome, 'granted');
    assert.equal(result.storageSeed.length, 1);
  });
});

// ── The per-browser cap: refused, not queued, and nothing moved ─────────

test('an over-cap claim against an attached browser is refused rather than queued, and nothing moves', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      const first = await broker.claim({
        sessionId: 'session-a',
        browser: 'desktop',
        purpose: 'the tab this cap allows',
      });
      assert.equal(first.outcome, 'granted');

      const message = await messageOf(() =>
        broker.claim({
          sessionId: 'session-b',
          browser: 'desktop',
          purpose: 'the claim the cap refuses',
        }),
      );
      assert.match(message, /refused rather than queued/);

      // **The refusal asserted as a physical fact**: capacity at this layer
      // is the claim row, so "the tab count did not move" means the claim
      // count did not move — one row, still active, no tab opened for the
      // refused caller, and no queue place either, because the refusal that
      // queues against a per-browser cap would be promoted on shared
      // capacity and breach the cap it names.
      const claims = rows<{ state: string; session_id: string }>(
        readCommitted,
        'SELECT state, session_id FROM claims ORDER BY arrival',
      );
      assert.equal(claims.length, 1);
      assert.equal(claims[0]?.state, 'active');
      assert.equal(claims[0]?.session_id, 'session-a');
      assert.equal(
        rows<{ n: number }>(readCommitted, 'SELECT count(*) AS n FROM tabs').at(-1)?.n,
        1,
        'the refused claim opened no tab',
      );
    },
    {
      attachedBrowsers: ['desktop'],
      attachedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
      attachedTabs: 1,
    },
  );
});

test('the cap boundary: exactly at it is granted, one past is refused', async () => {
  // The passing-side boundary of the same number — without it, an
  // off-by-one cap would look identical to the decided one.
  await withBroker(
    async ({ broker, readCommitted }) => {
      for (const sessionId of ['session-a', 'session-b']) {
        const result = await broker.claim({
          sessionId,
          browser: 'desktop',
          purpose: `filling the cap to its limit (${sessionId})`,
        });
        assert.equal(result.outcome, 'granted', `${sessionId} is under the cap`);
      }
      const message = await messageOf(() =>
        broker.claim({
          sessionId: 'session-c',
          browser: 'desktop',
          purpose: 'one past the cap',
        }),
      );
      assert.match(message, /2 of the 2 tabs/);
      assert.equal(
        rows<{ n: number }>(
          readCommitted,
          "SELECT count(*) AS n FROM claims WHERE state = 'active'",
        ).at(-1)?.n,
        2,
      );
    },
    {
      attachedBrowsers: ['desktop'],
      attachedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
      attachedTabs: 2,
    },
  );
});

test('tabs held against an attached browser still count against the shared budget', async () => {
  // The cap is in FRONT of the budget, not a substitute for it (§13n): an
  // attached page costs the same budget unit as any other page, and a
  // different browser still has to queue when the pool is full.
  await withBroker(
    async ({ broker }) => {
      const onAttached = await broker.claim({
        sessionId: 'session-a',
        browser: 'desktop',
        purpose: 'the one tab the budget allows',
      });
      assert.equal(onAttached.outcome, 'granted');

      const onRegular = await broker.claim({
        sessionId: 'session-b',
        browser: 'regular',
        purpose: 'a second browser with a full pool',
      });
      assert.equal(onRegular.outcome, 'queued');
      assert.equal(onRegular.position, 1);
    },
    {
      tabBudget: 1,
      attachedBrowsers: ['desktop'],
      attachedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
      // Comfortably above the budget: whatever refuses here, it is the
      // budget and not the cap.
      attachedTabs: 5,
    },
  );
});

test('the cap does not touch a different browser sharing the store', async () => {
  // The cap is per attached browser, not a global tightening: `regular` with
  // a pool that has room is granted while `desktop` is at its cap.
  await withBroker(
    async ({ broker }) => {
      const attached = await broker.claim({
        sessionId: 'session-a',
        browser: 'desktop',
        purpose: 'filling the attached browser',
      });
      assert.equal(attached.outcome, 'granted');

      const signedIn = await broker.claim({
        sessionId: 'session-b',
        browser: 'regular',
        purpose: 'a browser whose cap this is not',
      });
      assert.equal(signedIn.outcome, 'granted');
    },
    {
      attachedBrowsers: ['desktop'],
      attachedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
      attachedTabs: 1,
    },
  );
});
