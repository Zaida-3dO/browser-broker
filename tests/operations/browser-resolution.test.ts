import assert from 'node:assert/strict';
import test from 'node:test';

import { withBroker } from '../helpers/broker.ts';

/**
 * Lease resolution in its three forms (`SCHEMA.md` §3.2, `DECISIONS.md` §13i).
 *
 * | Caller states | Gets |
 * |---|---|
 * | nothing | the first entry of `BROKER_REGULAR_BROWSERS` |
 * | `regular` / `private` | the first entry of that kind |
 * | a configured name | that browser exactly |
 *
 * ── Why these assert the STORED browser rather than the response ────────
 *
 * A claim's granted response could report the browser it resolved to and
 * still have written a different one into `claims.browser_id`, and the row is
 * what every later operation reads — the tab is opened against it, the sweep
 * counts it, and reconciliation asks that browser what it has open. So each
 * test below reads the committed row through the fixture's second, read-only
 * connection, which is the house rule for asserting a durable fact: a read
 * through the store's own handle would see the transaction's own uncommitted
 * writes.
 *
 * ── The one that matters most is the default ────────────────────────────
 *
 * `browser` becoming optional is a reversal of a recorded decision, and the
 * argument for it (§13i) turns on *which* wrong guess a default buys. A build
 * that accepted an absent `browser` and resolved it to the clean-room browser
 * would satisfy "optional" completely and be the exact failure the reversal
 * was reasoned against — a login redirect, a wrong page that looks like a
 * right page. So the default's *destination* is asserted, not merely that
 * omitting the argument is permitted.
 */

/** The browser a claim was actually recorded against. */
function storedBrowser(
  readCommitted: <T>(sql: string, parameters?: Record<string, unknown>) => T[],
  claimId: string,
): string {
  const rows = readCommitted<{ browser_id: string }>(
    'SELECT browser_id FROM claims WHERE id = @id',
    { id: claimId },
  );
  assert.equal(rows.length, 1, 'the claim was committed');
  return rows[0]?.browser_id ?? '';
}

// ── Form one: nothing stated ────────────────────────────────────────────

test('a claim that names no browser is granted, rather than refused for a missing argument', async () => {
  await withBroker(async ({ broker, readCommitted }) => {
    const result = await broker.claim({
      sessionId: 'session-a',
      purpose: 'stating no browser at all',
    });
    assert.equal(result.outcome, 'granted');
    assert.ok(storedBrowser(readCommitted, result.claimId).length > 0);
  });
});

test('an unstated browser resolves to the FIRST SIGNED-IN browser, not the clean-room one', async () => {
  // The reversal's substance. Named browsers make this assertable in a way
  // the default configuration cannot: with the signed-in list led by a name
  // that is neither `regular` nor `private`, a build that defaulted to the
  // wrong kind, or to a hardcoded literal, fails here rather than passing by
  // coincidence.
  await withBroker(
    async ({ broker, readCommitted }) => {
      const result = await broker.claim({
        sessionId: 'session-a',
        purpose: 'stating no browser at all',
      });
      assert.equal(result.outcome, 'granted');
      assert.equal(storedBrowser(readCommitted, result.claimId), 'checkout');
    },
    { regularBrowsers: ['checkout', 'admin'], privateBrowsers: ['scratch'] },
  );
});

// ── Form two: a kind ────────────────────────────────────────────────────

test('the word `regular` resolves to the first signed-in browser, whatever it is called', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      const result = await broker.claim({
        sessionId: 'session-a',
        browser: 'regular',
        purpose: 'asking for a kind rather than a name',
      });
      assert.equal(result.outcome, 'granted');
      assert.equal(storedBrowser(readCommitted, result.claimId), 'checkout');
    },
    { regularBrowsers: ['checkout', 'admin'], privateBrowsers: ['scratch'] },
  );
});

test('the word `private` resolves to the first clean-room browser, whatever it is called', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      const result = await broker.claim({
        sessionId: 'session-a',
        browser: 'private',
        purpose: 'asking for a kind rather than a name',
      });
      assert.equal(result.outcome, 'granted');
      assert.equal(storedBrowser(readCommitted, result.claimId), 'scratch');
    },
    { regularBrowsers: ['checkout', 'admin'], privateBrowsers: ['scratch', 'spare'] },
  );
});

// ── Form three: a name ──────────────────────────────────────────────────

test('a configured name resolves to THAT browser, not to the first of its kind', async () => {
  // The distinction the second entry exists to make: `admin` is a signed-in
  // browser that is not the first one, so a build that read every name as its
  // kind would answer `checkout` here.
  await withBroker(
    async ({ broker, readCommitted }) => {
      const result = await broker.claim({
        sessionId: 'session-a',
        browser: 'admin',
        purpose: 'naming one browser exactly',
      });
      assert.equal(result.outcome, 'granted');
      assert.equal(storedBrowser(readCommitted, result.claimId), 'admin');
    },
    { regularBrowsers: ['checkout', 'admin'], privateBrowsers: ['scratch'] },
  );
});

test('a second clean-room browser is reachable by name', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      const result = await broker.claim({
        sessionId: 'session-a',
        browser: 'spare',
        purpose: 'naming one browser exactly',
      });
      assert.equal(result.outcome, 'granted');
      assert.equal(storedBrowser(readCommitted, result.claimId), 'spare');
    },
    { regularBrowsers: ['checkout'], privateBrowsers: ['scratch', 'spare'] },
  );
});

test('two callers naming two different browsers get two different browsers', async () => {
  // **What the whole reversal was bought for**: two identities at once. Tabs
  // within one browser share a cookie jar, so this is the only shape in which
  // that is available, and it is worth asserting as a property rather than
  // inferring it from the two tests above.
  await withBroker(
    async ({ broker, readCommitted }) => {
      const first = await broker.claim({
        sessionId: 'session-a',
        browser: 'checkout',
        purpose: 'one identity',
      });
      const second = await broker.claim({
        sessionId: 'session-b',
        browser: 'admin',
        purpose: 'another identity at the same time',
      });
      assert.equal(first.outcome, 'granted');
      assert.equal(second.outcome, 'granted');
      assert.notEqual(
        storedBrowser(readCommitted, first.claimId),
        storedBrowser(readCommitted, second.claimId),
      );
    },
    { regularBrowsers: ['checkout', 'admin'], privateBrowsers: ['scratch'] },
  );
});

// ── Refusal ─────────────────────────────────────────────────────────────

test('a name no configured browser has is refused, and the refusal lists the configured names', async () => {
  await withBroker(
    async ({ broker }) => {
      let message = '';
      try {
        await broker.claim({
          sessionId: 'session-a',
          browser: 'regular',
          purpose: 'naming a browser this installation does not have',
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // `regular` is a KIND word, so it resolves rather than refusing even
      // when no browser is called that — asserted here so the refusal test
      // below cannot be read as covering this case too.
      assert.equal(message, '', 'a kind word resolves even when no browser bears that name');
    },
    { regularBrowsers: ['checkout'], privateBrowsers: ['scratch'] },
  );

  await withBroker(
    async ({ broker }) => {
      let message = '';
      try {
        await broker.claim({
          sessionId: 'session-a',
          browser: 'nonesuch',
          purpose: 'naming a browser this installation does not have',
        });
        assert.fail('an unknown browser must be refused');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.match(message, /nonesuch/);
      // It names what this installation actually has, rather than the two
      // names the default configuration would have had.
      assert.match(message, /checkout/);
      assert.match(message, /scratch/);
    },
    { regularBrowsers: ['checkout'], privateBrowsers: ['scratch'] },
  );
});

test('a claim refused for an unknown browser writes no claim row', async () => {
  // `DECISIONS.md` §5: a guard that reports a refusal after the row exists is
  // worse than no guard. The refusal is ahead of the first insert, so this
  // asserts the absence rather than the message.
  await withBroker(async ({ broker, readCommitted }) => {
    try {
      await broker.claim({
        sessionId: 'session-a',
        browser: 'nonesuch',
        purpose: 'naming a browser this installation does not have',
      });
      assert.fail('an unknown browser must be refused');
    } catch {
      // The refusal itself is asserted above.
    }
    const rows = readCommitted<{ id: string }>('SELECT id FROM claims');
    assert.deepEqual(rows, []);
  });
});

// ── Row creation (§1.2, §13i: on first launch, not from configuration) ──

test('a configured browser gets its row when it is first claimed, with its kind', async () => {
  await withBroker(
    async ({ broker, readCommitted }) => {
      // Before any claim, the store holds only the rows the first schema step
      // seeded — **not** one per configured browser. That is the ruling:
      // configuration alone creates nothing.
      const before = readCommitted<{ id: string }>('SELECT id FROM browsers ORDER BY id');
      assert.deepEqual(
        before.map((row) => row.id),
        ['private', 'regular'],
      );

      await broker.claim({
        sessionId: 'session-a',
        browser: 'admin',
        purpose: 'first claim on a configured browser',
      });

      const after = readCommitted<{ id: string; kind: string }>(
        'SELECT id, kind FROM browsers WHERE id = @id',
        { id: 'admin' },
      );
      assert.deepEqual(after, [{ id: 'admin', kind: 'regular' }]);
    },
    { regularBrowsers: ['checkout', 'admin'], privateBrowsers: ['scratch'] },
  );
});

test('the kind on a created row comes from the list the name was found in', async () => {
  // The name carries no kind once names are configured, so a build that
  // guessed — or defaulted the column — would write `regular` for a
  // clean-room browser, and the sign-in guard reads exactly this column.
  await withBroker(
    async ({ broker, readCommitted }) => {
      await broker.claim({
        sessionId: 'session-a',
        browser: 'scratch',
        purpose: 'first claim on a clean-room browser',
      });
      const rows = readCommitted<{ kind: string }>('SELECT kind FROM browsers WHERE id = @id', {
        id: 'scratch',
      });
      assert.deepEqual(rows, [{ kind: 'private' }]);
    },
    { regularBrowsers: ['checkout'], privateBrowsers: ['scratch'] },
  );
});

test('claiming the same new browser twice leaves one row, not two', async () => {
  // §1.2a's *"one row, one winner"*, exercised through the path that creates
  // the row. Sequential here rather than concurrent: the transaction
  // serialises writers, so what is asserted is that the second attempt is a
  // no-op rather than an error or a duplicate.
  await withBroker(
    async ({ broker, readCommitted }) => {
      await broker.claim({ sessionId: 'session-a', browser: 'admin', purpose: 'first claim' });
      await broker.claim({ sessionId: 'session-b', browser: 'admin', purpose: 'second claim' });
      const rows = readCommitted<{ id: string }>('SELECT id FROM browsers WHERE id = @id', {
        id: 'admin',
      });
      assert.equal(rows.length, 1);
    },
    { regularBrowsers: ['checkout', 'admin'], privateBrowsers: ['scratch'] },
  );
});

test('a refused browser name creates no browser row', async () => {
  // The refusal is ahead of the insert, so a name nobody configured leaves
  // nothing behind — the row-creating path cannot be reached by naming a
  // browser this installation does not have.
  await withBroker(
    async ({ broker, readCommitted }) => {
      try {
        await broker.claim({
          sessionId: 'session-a',
          browser: 'nonesuch',
          purpose: 'naming a browser this installation does not have',
        });
        assert.fail('an unknown browser must be refused');
      } catch {
        // Asserted elsewhere; this test is about what was written.
      }
      const rows = readCommitted<{ id: string }>('SELECT id FROM browsers WHERE id = @id', {
        id: 'nonesuch',
      });
      assert.deepEqual(rows, []);
    },
    { regularBrowsers: ['checkout'], privateBrowsers: ['scratch'] },
  );
});
