import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// `UNREACHABLE` is deliberately NOT imported here: these tests assert the
// literal word as rendered, because a test that guards a constant using that
// same constant cannot fail when the constant is emptied.
import type { TabAddress } from '../../src/operations/addresses.ts';
import { readOperationsStatus } from '../../src/operations/status.ts';
import { humaniseSeconds, renderDocument } from '../../src/report/document.ts';
import { seedClaim, seedEvent, seedFeedback, seedTab } from '../helpers/seed.ts';
import { makeTempStore, withSteppedStore } from '../helpers/temp-store.ts';
import { openStoreForDiagnosis } from '../../src/store/open.ts';
import { stepSchema } from '../../src/store/schema/step.ts';

/**
 * The operations document (`MILESTONES.md` #35, `SCHEMA.md` §4).
 *
 * Three properties are load-bearing and each has its own block below, with
 * the change that breaks it named:
 *
 * - **It renders derived state, never stored state.** Breaks if the status
 *   read filters on `claims.state`, or if the derivation's comparison is
 *   removed — "a lapsed lease is not rendered as live" fails.
 * - **It says it is a photograph.** Breaks if the banner is removed, if the
 *   moment moves to only a footer, or if anything that redraws is added —
 *   the refresh block fails.
 * - **An unanswered address is an explicit word.** Breaks if `renderAddress`
 *   returns a blank, or if the cell is omitted.
 */

const now = '2026-03-01T12:00:00.000Z';
const soon = '2026-03-01T12:05:00.000Z';
const gone = '2026-03-01T11:50:00.000Z';

function empty(): Parameters<typeof renderDocument>[0] {
  return {
    status: {
      at: now,
      browsers: [],
      budget: { limit: 15, used: 0, active: 0, queued: 0, keeperTabsExpected: 2 },
      sessions: [],
      queue: [],
      leakedTabs: [],
      recentEvents: [],
      refusalsByGuard: [],
      feedback: [],
    },
    addresses: new Map<string, TabAddress>(),
  };
}

describe('the document is a photograph and says so', () => {
  it('carries the moment it was taken in the body, not only in a footer', () => {
    // §4.1: "in the document, prominently — not in the file name, which can be
    // renamed, and not only in a footer".
    const html = renderDocument(empty());

    const body = html.slice(html.indexOf('<body>'), html.indexOf('<footer>'));
    assert.ok(body.includes(now), 'the moment is absent from the body above the footer');
    assert.ok(body.includes('Snapshot taken at'));
  });

  it('says outright that it does not refresh', () => {
    const html = renderDocument(empty());
    assert.match(html, /Nothing on this page refreshes/i);
    assert.match(html, /photograph, not a window/i);
  });

  it('contains nothing that redraws itself', () => {
    // §4.1: "No polling, no countdown, no 'live' indicator, nothing that
    // redraws itself." Each of these is a specific mechanism that would make
    // the page act like a console.
    const html = renderDocument(empty());

    assert.ok(!/http-equiv=["']?refresh/i.test(html), 'a meta refresh would reload the page');
    assert.ok(!/setInterval/.test(html), 'setInterval would redraw the page');
    assert.ok(!/location\.reload/.test(html), 'a reload would make it a window');
    assert.ok(!/EventSource|WebSocket/.test(html), 'a live connection would make it a window');
    assert.ok(!/\bfetch\s*\(/.test(html), 'a fetch would poll something');
  });

  it('loads nothing from anywhere — it is one self-contained file', () => {
    // §4: "no separate stylesheet, no separate script, no fonts to fetch,
    // nothing loaded from anywhere". A file that reached out would render
    // wrongly on the machine it was sent to, which is the case §4 is for.
    const html = renderDocument(empty());

    assert.ok(!/<link\b/i.test(html), 'a link element loads something external');
    assert.ok(!/<script[^>]+\bsrc=/i.test(html), 'a script with a src loads something external');
    assert.ok(!/@import/i.test(html), 'an @import loads a stylesheet');
    assert.ok(!/<img\b/i.test(html), 'an image would be a second file');
    // Its own styling and behaviour are inline, which is the other half of
    // the claim: absent externals plus present internals.
    assert.ok(/<style>/.test(html));
    assert.ok(/<script>/.test(html));
  });

  it('is read-only: no controls, no forms, nothing to click', () => {
    // §4.5: revoking is deliberately absent. "A button in a photograph would
    // act on state that has moved on since the shutter."
    const html = renderDocument(empty());

    assert.ok(!/<form\b/i.test(html), 'a form is a control');
    assert.ok(!/<button\b/i.test(html), 'a button is a control');
    assert.ok(!/<input\b/i.test(html), 'an input is a control');
    assert.ok(!/\bonclick=/i.test(html), 'a click handler is a control');
    assert.ok(!/revoke/i.test(html), 'revoking is a command, never a control in this document');
  });

  it('has no settings section and no health verdict', () => {
    // §4.2: both absences are rulings. A settings section would duplicate the
    // environment registry; a health verdict is `broker doctor`'s job in a
    // better shape (§4.4).
    const html = renderDocument(empty());

    assert.ok(!/BROKER_[A-Z_]+/.test(html), 'listing variables would duplicate the registry');
    assert.ok(!/\bhealthy\b/i.test(html), 'a health verdict collapses preconditions into one word');
  });
});

describe('the document renders derived state, never stored state', () => {
  it('does not render a lapsed lease as live', async () => {
    // The hardest requirement in the row, asserted end to end: a store row
    // saying `active`, an expiry that has already elapsed, and a document that
    // must not show it. Breaks the moment the read stops deriving.
    await withSteppedStore(async (store) => {
      seedClaim(store.db, {
        state: 'active',
        expiresAt: gone,
        sessionId: 'session-lapsed',
        purpose: 'a lease nobody has swept yet',
      });

      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({ status, addresses: new Map() });

      assert.ok(
        !html.includes('session-lapsed'),
        'a lapsed lease appears in the document as though it were live',
      );
      assert.ok(!html.includes('a lease nobody has swept yet'));
      assert.match(html, /Nothing holds a tab/);
      await Promise.resolve();
    });
  });

  it('renders a live lease with its session, purpose and expiry', async () => {
    await withSteppedStore(async (store) => {
      seedClaim(store.db, {
        state: 'active',
        expiresAt: soon,
        sessionId: 'session-live',
        purpose: 'reviewing a checkout flow',
      });

      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({ status, addresses: new Map() });

      assert.ok(html.includes('session-live'));
      assert.ok(html.includes('reviewing a checkout flow'));
      await Promise.resolve();
    });
  });

  it('says the derivation was applied, so a reader knows which answer is right', async () => {
    await withSteppedStore(async (store) => {
      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({ status, addresses: new Map() });
      assert.match(html, /expiry derivation/i);
      await Promise.resolve();
    });
  });
});

describe('addresses in the document', () => {
  it('renders a browser that did not answer as the explicit word', async () => {
    // §4.2a: "not blank, not omitted, not a placeholder address".
    await withSteppedStore(async (store) => {
      const claimId = seedClaim(store.db, { state: 'active', expiresAt: soon });
      const tabId = seedTab(store.db, { claimId });

      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({
        status,
        addresses: new Map<string, TabAddress>([
          [tabId, { kind: 'unreachable', reason: 'no answer within 2000ms' }],
        ]),
      });

      // **Asserted against the rendered cell, not against the whole file.**
      // The document also *explains* what the word means in prose, so a
      // bare `includes('unreachable')` is satisfied by that paragraph even
      // when no cell carries the word — which is how an earlier version of
      // this test survived the mutation that empties the constant. Matching
      // the cell's own markup pins the word where the guarantee actually
      // lives: in the place an address would otherwise sit.
      const cell = '<span class="unreachable"';
      assert.ok(html.includes(cell), 'no cell rendered the explicit word');
      assert.match(
        html,
        /<span class="unreachable"[^>]*>unreachable<\/span>/,
        'the cell is present but does not carry the explicit word',
      );
      await Promise.resolve();
    });
  });

  it('renders a tab with no entry at all as the explicit word too', async () => {
    // The omitted case. A generator that could not reach any browser leaves
    // the map empty, and a blank cell would be exactly the failure the rule
    // names.
    await withSteppedStore(async (store) => {
      const claimId = seedClaim(store.db, { state: 'active', expiresAt: soon });
      seedTab(store.db, { claimId });

      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({ status, addresses: new Map() });

      // The omitted case, pinned against the rendered cell for the same
      // reason as above: the explanatory prose is not the guarantee.
      assert.match(html, /<span class="unreachable"[^>]*>unreachable<\/span>/);
      await Promise.resolve();
    });
  });

  it('renders an address that was read', async () => {
    await withSteppedStore(async (store) => {
      const claimId = seedClaim(store.db, { state: 'active', expiresAt: soon });
      const tabId = seedTab(store.db, { claimId });

      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({
        status,
        addresses: new Map<string, TabAddress>([
          [tabId, { kind: 'address', url: 'https://example.com/checkout', title: 'Checkout' }],
        ]),
      });

      assert.ok(html.includes('https://example.com/checkout'));
      // The word still appears in the paragraph explaining what it means, so
      // the assertion is against the *cell* rather than against the file: a
      // whole-document search would be asserting that the explanation is
      // absent, which is a different and wrong claim.
      const cell = `<td class="mono">https://example.com/checkout</td>`;
      assert.ok(html.includes(cell), 'the address was not rendered into its own cell');
      assert.ok(!html.includes(`<span class="unreachable"`));
      await Promise.resolve();
    });
  });

  it('explains that unreachable means asked-and-unanswered', () => {
    const html = renderDocument(empty());
    assert.match(html, /asked and did not answer/i);
  });
});

describe('escaping', () => {
  it('does not let a purpose end an element', async () => {
    // Every one of these values comes from outside this service, and the
    // document is shared (§4). A page address carrying markup is markup that
    // runs in the reader's browser.
    await withSteppedStore(async (store) => {
      seedClaim(store.db, {
        state: 'active',
        expiresAt: soon,
        sessionId: 'session-a',
        purpose: '</td></tr></table><script>alert(1)</script>',
      });

      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({ status, addresses: new Map() });

      assert.ok(!html.includes('<script>alert(1)</script>'));
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
      await Promise.resolve();
    });
  });

  it('does not let a live-read address inject markup', async () => {
    await withSteppedStore(async (store) => {
      const claimId = seedClaim(store.db, { state: 'active', expiresAt: soon });
      const tabId = seedTab(store.db, { claimId });

      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({
        status,
        addresses: new Map<string, TabAddress>([
          [
            tabId,
            {
              kind: 'address',
              url: 'https://example.com/"><script>alert(1)</script>',
              title: 't',
            },
          ],
        ]),
      });

      assert.ok(!html.includes('<script>alert(1)</script>'));
      await Promise.resolve();
    });
  });

  it('does not let a feedback note inject markup', async () => {
    await withSteppedStore(async (store) => {
      seedFeedback(store.db, {
        rating: 1,
        category: 'surprised-me',
        note: 'a note containing <img onerror=alert(1)> and more text besides',
      });

      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({ status, addresses: new Map() });

      assert.ok(!/<img\b/i.test(html));
      await Promise.resolve();
    });
  });
});

describe('the sections §4.2 requires', () => {
  it('reports both browsers with state and restart count', async () => {
    await withSteppedStore(async (store) => {
      store.db
        .prepare(
          `UPDATE browsers SET state = 'running', pid = 7, restart_count = 3 WHERE id = 'regular'`,
        )
        .run();

      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({ status, addresses: new Map() });

      // Named rather than counted: a renderer that emitted one browser twice
      // would keep a count assertion green.
      assert.ok(html.includes('regular'));
      assert.ok(html.includes('private'));
      assert.match(html, /Restarts/);
      await Promise.resolve();
    });
  });

  it('reports the queue with positions and the front caller’s wait', async () => {
    await withSteppedStore(async (store) => {
      seedClaim(store.db, {
        state: 'queued',
        expiresAt: soon,
        createdAt: '2026-03-01T11:55:00.000Z',
        sessionId: 'session-waiting',
      });

      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({ status, addresses: new Map() });

      assert.match(html, /Depth <strong>1<\/strong>/);
      assert.ok(html.includes('session-waiting'));
      assert.ok(html.includes('5m 0s'));
      await Promise.resolve();
    });
  });

  it('reports leaked tabs and says the capacity already came back', async () => {
    await withSteppedStore(async (store) => {
      const claimId = seedClaim(store.db, { state: 'released', expiresAt: gone });
      const leaked = seedTab(store.db, { claimId, state: 'closing', closeFailed: true });

      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({ status, addresses: new Map() });

      assert.ok(html.includes(leaked));
      assert.match(html, /costs memory and not budget/i);
      await Promise.resolve();
    });
  });

  it('reports the most recent ledger entries with the cursor to read on from', async () => {
    await withSteppedStore(async (store) => {
      const id = seedEvent(store.db, { kind: 'claim_granted' });

      const status = readOperationsStatus(store.db, { now });
      const html = renderDocument({ status, addresses: new Map() });

      assert.ok(html.includes('claim_granted'));
      assert.ok(html.includes(`broker events --since ${String(id)}`));
      await Promise.resolve();
    });
  });

  it('reports what callers said, and says an empty section is the goal', () => {
    // §4.2: "this section disappearing entirely is the signal that tool has
    // done its job" (§3.16). An empty section is not a defect.
    const html = renderDocument(empty());
    assert.match(html, /What callers reported/);
    assert.match(html, /done its job/i);
  });

  it('accounts for the keeper tabs so the numbers reconcile', () => {
    // §3.15: a person looking at a browser window sees one more tab than the
    // budget accounts for, "and a count that cannot be reconciled reads as a
    // leak. This is what makes it reconcilable."
    const html = renderDocument(empty());
    assert.match(html, /Keeper tabs/);
    assert.match(html, /never counted against the/i);
  });

  it('says the budget is not recorded rather than inventing a number', async () => {
    // ── Reaching the unrecorded state honestly ────────────────────────────
    //
    // A spawn records the budget as it opens, so `withSteppedStore` — which is
    // the spawn path — cannot produce a store with an empty `tab_budget`. The
    // state this is about is a store that has been stepped and **not yet
    // opened by any process**, so it is built that way: the raw diagnostic
    // open, the stepper, and nothing else.
    //
    // Seeding it by deleting the row afterwards would be the same fixture
    // wearing a disguise; this is a state the product genuinely passes through
    // between `stepSchema` and `agreeOnTabBudget`.
    const temp = makeTempStore();
    try {
      const store = openStoreForDiagnosis(temp.environment);
      try {
        await stepSchema(store.db);
        const status = readOperationsStatus(store.db, { now });
        const html = renderDocument({ status, addresses: new Map() });
        assert.match(html, /not recorded/);
      } finally {
        store.close();
      }
    } finally {
      temp.remove();
    }
  });

  it('shows the recorded budget once a spawn has opened the store', async () => {
    // The other half, and the one that fails if the budget read is pointed at
    // a table nothing writes: such a read returns null, which this document
    // renders as "not recorded" — a believable sentence, which is exactly why
    // the assertion above cannot be the only one. This asserts the number.
    await withSteppedStore(
      async (store) => {
        const status = readOperationsStatus(store.db, { now });
        const html = renderDocument({ status, addresses: new Map() });
        assert.match(html, /Tab budget<\/span><span class="value">23</);
        assert.doesNotMatch(html, /not recorded/);
        await Promise.resolve();
      },
      { tabBudget: 23 },
    );
  });

  it('says a discovery record is a claim rather than a proof', () => {
    // §1.2c and §4.2: an unchecked report would call a record naming a dead
    // endpoint fine, and this document cannot check one.
    const html = renderDocument(empty());
    assert.match(html, /claim, not a proof/i);
    assert.match(html, /broker doctor/);
  });
});

describe('durations for a person', () => {
  it('reads seconds, minutes and hours', () => {
    assert.equal(humaniseSeconds(45), '45s');
    assert.equal(humaniseSeconds(90), '1m 30s');
    assert.equal(humaniseSeconds(3700), '1h 1m');
  });

  it('says when something has already elapsed rather than showing a negative', () => {
    assert.equal(humaniseSeconds(-90), '1m 30s ago');
  });
});
