import assert from 'node:assert/strict';
import test from 'node:test';

import { AttachedError } from '../../src/attach/errors.ts';
import type { BrowserSession } from '../../src/browser/driver.ts';
import { CallRefusal } from '../../src/service/refusals.ts';
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

test('a queued attached place already holds its cap slot, so the cap holds through promotion', async () => {
  // The breach this pins out: a cap that counts only `active` rows while
  // **promotion weighs the shared budget alone**. At cap 1 / budget 2 the
  // sequence goes: two regular leases fill the pool; an attached claim
  // passes the cap (nothing attached is live) and queues; a second attached
  // claim passes the cap too — still nothing *active* — and queues; release
  // the regulars and **both promote**, leaving two active tabs against a
  // browser that allows one. Refusal and count never moved along the way;
  // such a cap exists on the request and not on the outcome. With waiting
  // places counted, the second attached claim is refused at the request,
  // and the one queued place is the only attached row that ever reaches
  // `active`.
  await withBroker(
    async ({ broker, readCommitted }) => {
      const first = await broker.claim({
        sessionId: 'session-a',
        browser: 'regular',
        purpose: 'first lease filling the shared pool',
      });
      const second = await broker.claim({
        sessionId: 'session-b',
        browser: 'regular',
        purpose: 'second lease filling the shared pool',
      });
      assert.equal(first.outcome, 'granted');
      assert.equal(second.outcome, 'granted');

      const waiting = await broker.claim({
        sessionId: 'session-c',
        browser: 'desktop',
        purpose: 'the attached claim the full pool queues',
      });
      assert.equal(
        waiting.outcome,
        'queued',
        'the budget queues it: the cap is not what stops this one',
      );

      // The second attached arrival must be refused **against the queued
      // place**: one waiting attached lease is already the whole cap.
      const message = await messageOf(() =>
        broker.claim({
          sessionId: 'session-d',
          browser: 'desktop',
          purpose: 'the attached claim the queued place already blocks',
        }),
      );
      assert.match(message, /holding 1 of the 1 tabs/);
      assert.match(message, /refused rather than queued/);

      // The physical half: the refusal left no row of any kind behind. One
      // attached claim exists, and it is the place that was already waiting.
      const attached = rows<{ state: string; session_id: string }>(
        readCommitted,
        "SELECT state, session_id FROM claims WHERE browser_id = 'desktop' ORDER BY arrival",
      );
      assert.equal(attached.length, 1, 'the refused claim wrote no row, queued included');
      assert.equal(attached[0]?.state, 'queued');
      assert.equal(attached[0]?.session_id, 'session-c');

      // Release the regulars — the release's own promotion then moves the
      // queue head active. Exactly one attached row crosses, because exactly
      // one exists.
      await broker.release({ key: first.key });
      await broker.release({ key: second.key });

      assert.deepEqual(
        rows<{ state: string }>(
          readCommitted,
          "SELECT state FROM claims WHERE browser_id = 'desktop' ORDER BY arrival",
        ).map((row) => row.state),
        ['active'],
        'the queued place promoted, and nothing else did',
      );
      assert.equal(
        rows<{ n: number }>(
          readCommitted,
          "SELECT count(*) AS n FROM claims WHERE browser_id = 'desktop' AND state = 'active'",
        ).at(-1)?.n,
        1,
        'the attached active count never moved past the cap',
      );
    },
    {
      tabBudget: 2,
      attachedBrowsers: ['desktop'],
      attachedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
      attachedTabs: 1,
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

// ── Not connected: refused at the claim, before any row ──────────────────

/**
 * A session the **claim** must never drive. The gate asks whether the
 * browser can be reached, not for its work; every verb throwing is the
 * assertion itself, not a placeholder.
 */
function neverDriven(): BrowserSession {
  const refusal = (): never => {
    throw new Error('the claim gate drove the browser');
  };
  return {
    describe: refusal,
    openTab: refusal,
    listTabs: refusal,
    ensureKeeperTab: refusal,
    isConnected: refusal,
    detach: refusal,
    closeTab: refusal,
    navigate: refusal,
    seedStorage: refusal,
    act: refusal,
    read: refusal,
    cookies: refusal,
    evaluate: refusal,
    settlePage: refusal,
    capture: refusal,
    download: refusal,
  } satisfies BrowserSession;
}

const ATTACHED = {
  attachedBrowsers: ['desktop'],
  attachedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
};

function refusedAs(code: string, rule: string, retryable: boolean) {
  return (error: unknown) =>
    error instanceof CallRefusal &&
    error.code === code &&
    error.rule === rule &&
    error.retryable === retryable;
}

/** Every `claim_requested` deny row, with the guard that wrote it. */
function claimDenials(
  readCommitted: <T>(sql: string, parameters?: Record<string, unknown>) => T[],
): { guard: string; session_id: string | null; browser_id: string | null }[] {
  return readCommitted(
    'SELECT guard, session_id, browser_id FROM events WHERE kind = @kind AND outcome = @outcome ORDER BY id',
    { kind: 'claim_requested', outcome: 'deny' },
  );
}

test('an attached browser whose extension never connects is refused at the claim, and takes no budget, no cap slot, no row', async () => {
  // §7.1 `attached.not_connected`, and MILESTONES row #74's promise in
  // its physical form: the open runs **before** arbitration, so the
  // refusal cannot have consumed what it refused for. Two claims, twice
  // over: a first refusal that queued or wrote anything would make the
  // second one `attached.tab_cap` rather than `attached.not_connected`,
  // and the guard list pins the difference.
  let asked = 0;
  await withBroker(
    async ({ broker, readCommitted }) => {
      for (const sessionId of ['session-a', 'session-b']) {
        await assert.rejects(
          broker.claim({
            sessionId,
            browser: 'attached',
            purpose: 'a lease on a browser that cannot be reached',
          }),
          refusedAs('attached_not_connected', 'attached.not_connected', true),
        );
      }
      assert.equal(asked, 2, 'the claim did not reach the provider before deciding');

      // The physical half: capacity is the claim row, and nothing grew.
      assert.deepEqual(readCommitted<{ n: number }>('SELECT count(*) AS n FROM claims'), [
        { n: 0 },
      ]);
      assert.deepEqual(readCommitted<{ n: number }>('SELECT count(*) AS n FROM tabs'), [{ n: 0 }]);

      // The ledger agrees with the wire: both refusals are on the books,
      // under the rule that refused, and `attached.tab_cap` never fired —
      // the refusals did not queue themselves into the cap.
      // `browser_id` is null on these rows by construction: the column's
      // foreign key points at a `browsers` row that this gate deliberately
      // refuses **before it exists** — the browser is in `detail`.
      assert.deepEqual(claimDenials(readCommitted), [
        { guard: 'attached.not_connected', session_id: 'session-a', browser_id: null },
        { guard: 'attached.not_connected', session_id: 'session-b', browser_id: null },
      ]);
      assert.deepEqual(
        readCommitted<{ detail: string }>(
          "SELECT detail FROM events WHERE kind = 'claim_requested' AND outcome = 'deny' ORDER BY id",
        ).map((row) => (JSON.parse(row.detail) as { browser: string }).browser),
        ['desktop', 'desktop'],
      );
    },
    {
      ...ATTACHED,
      attachedTabs: 1,
      session: (browser) => {
        asked += 1;
        throw new AttachedError(
          'attached.not_connected',
          `the extension for "${browser}" never reached the relay`,
        );
      },
    },
  );
});

test('an attached browser with no configured binary is refused at the claim with its own rule, not the connect timeout', async () => {
  // The two ways the open can fail are different refusals a caller acts
  // on differently: one says "the extension has not arrived, try again",
  // the other says "nothing can show it the address, fix the
  // configuration". Collapsing them teaches retries that change nothing.
  await withBroker(
    async ({ broker, readCommitted }) => {
      await assert.rejects(
        broker.claim({
          sessionId: 'session-a',
          browser: 'desktop',
          purpose: 'a browser with no binary to open its connect page',
        }),
        refusedAs('attached_no_binary', 'attached.no_binary', false),
      );

      assert.deepEqual(claimDenials(readCommitted), [
        { guard: 'attached.no_binary', session_id: 'session-a', browser_id: null },
      ]);
      assert.deepEqual(readCommitted<{ n: number }>('SELECT count(*) AS n FROM claims'), [
        { n: 0 },
      ]);
    },
    {
      ...ATTACHED,
      session: (browser) => {
        throw new AttachedError(
          'attached.no_binary',
          `no binary is configured for "${browser}" to open its connect page`,
        );
      },
    },
  );
});

test('a reachable attached browser is asked exactly once by the claim, and grants normally', async () => {
  // The gate's other half: it checks, it does not interfere. The provider
  // is reached **once** — the claim's own handler never touches it — and
  // the grant lands with its row as it did before the gate existed.
  let asked = 0;
  await withBroker(
    async ({ broker, readCommitted }) => {
      const result = await broker.claim({
        sessionId: 'session-a',
        browser: 'attached',
        purpose: 'a lease on a browser that is connected',
      });
      assert.equal(result.outcome, 'granted');
      assert.equal(asked, 1, 'the claim reached the provider more than once');
      assert.deepEqual(
        readCommitted<{ browser_id: string }>('SELECT browser_id FROM claims WHERE id = @id', {
          id: result.claimId,
        }),
        [{ browser_id: 'desktop' }],
      );
      assert.deepEqual(claimDenials(readCommitted), []);
    },
    {
      ...ATTACHED,
      session: (browser) => {
        asked += 1;
        assert.equal(browser, 'desktop');
        return neverDriven();
      },
    },
  );
});

test('the probe runs ahead of the seed refusal and changes nothing about it: reached once, then the same denial with no rows', async () => {
  // Pins the accepted residual (§13n, `ensureAttachedConnection`): every
  // attached claim reaches the provider before arbitration, so a claim
  // that will be refused for its seed still opens the connect page first.
  // Moving the probe behind that refusal would mean re-deciding the seed
  // rule in a second place where it could drift — so the ordering is
  // documented, and what must hold under it is the refusal itself: the
  // provider is reached exactly once, and the denial stays as physical as
  // it was with no session wired at all.
  let asked = 0;
  await withBroker(
    async ({ broker, readCommitted }) => {
      await assert.rejects(
        broker.claim({
          sessionId: 'session-a',
          browser: 'desktop',
          purpose: 'a seed the claim layer will refuse, over a live connection',
          storageSeed: SEED,
        }),
        (error: unknown) => error instanceof CallRefusal && error.code === 'attached_no_seed',
      );
      assert.equal(asked, 1, 'the claim gate reached the provider more than once');
      assert.deepEqual(rows<{ id: string }>(readCommitted, 'SELECT id FROM claims'), []);
      assert.deepEqual(rows<{ id: string }>(readCommitted, 'SELECT id FROM tabs'), []);
    },
    {
      ...ATTACHED,
      session: () => {
        asked += 1;
        return neverDriven();
      },
    },
  );
});

test('the probe runs ahead of the cap refusal too: the second claim is refused on the cap with its counts unmoved', async () => {
  // The other accepted ordering case: the first claim is granted (the probe
  // found the browser connected), and the probe for the second — the one
  // arbitration will refuse on the per-browser cap — still runs first. The
  // physical half is the cap test's, re-asserted with a session wired: the
  // probe consumed no row, no slot, and the refusal names the cap.
  let asked = 0;
  await withBroker(
    async ({ broker, readCommitted }) => {
      const first = await broker.claim({
        sessionId: 'session-a',
        browser: 'desktop',
        purpose: 'the one tab the cap allows',
      });
      assert.equal(first.outcome, 'granted');
      await assert.rejects(
        broker.claim({
          sessionId: 'session-b',
          browser: 'desktop',
          purpose: 'over the cap, over a live connection',
        }),
        (error: unknown) => error instanceof CallRefusal && error.code === 'attached_full',
      );
      assert.equal(asked, 2, 'the claim gate reached the provider once per claim');
      assert.equal(
        rows<{ n: number }>(
          readCommitted,
          "SELECT count(*) AS n FROM claims WHERE state = 'active'",
        ).at(-1)?.n,
        1,
        'the refused claim took a slot the cap said it could not have',
      );
    },
    {
      ...ATTACHED,
      attachedTabs: 1,
      session: () => {
        asked += 1;
        return neverDriven();
      },
    },
  );
});
