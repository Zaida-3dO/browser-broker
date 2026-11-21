import { attachOverBridge } from '../../../src/browser/attached.ts';
import { connect } from '../../../src/attach/session.ts';
import type { SeamProperty } from '../../../src/browser/conformance/case.ts';
import type { SeamSubject } from '../../../src/browser/conformance/subjects.ts';
import { FakeExtension } from '../../attach/fake-extension.ts';

/**
 * The attached session, as a conformance subject: the real session class,
 * driven over the real relay, against the fake extension
 * (`tests/attach/fake-extension.ts`) standing in for the person's browser.
 *
 * The third implementation the seam suite was missing. Fake and real agree
 * about everything the two kinds can share; the attached kind **differs on
 * purpose** — no keeper, no writes, handles naming the extension's tab — and
 * those differences are the interesting ones: a property that fires on
 * attached where it does not fire on the other two is the service deciding
 * differently against a person's browser than against its own.
 *
 * The bridge, the relay and the fake extension are opened fresh per property,
 * exactly as the fake driver and the real browser are: one property's tabs
 * must not decide another's answer, and here a shared bridge would also mean
 * one extension serving two sessions, which the relay contract forbids (one
 * CDP client at a time).
 */

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/**
 * The keeper properties, named. The attached kind refuses `ensureKeeperTab`
 * at the seam **as the feature** — a blank tab in a person's window is a
 * write the claim never asked for — and a property whose first step is that
 * refusal can only come out green by an attached session implementing a
 * keeper, which is exactly the fixture-side fiction this suite was built to
 * stop. The refusal itself is pinned concretely in
 * `tests/browser/attached.test.ts` ("there is no keeper tab, and asking for
 * one opens nothing"), which asserts the error **and** the absence of the
 * `chrome.tabs.create` call.
 */
const NO_KEEPER_BY_CONSTRUCTION = new Set([
  'the keeper tab is absent from listTabs',
  'the keeper tab survives being named to closeTab',
  'establishing the keeper twice yields one keeper, not two',
  'a keeper handle names the browser it belongs to',
]);

/**
 * The cookie-shape property. The fake extension answers the jar query with
 * an empty reply Playwright's client cannot read, so the property cannot
 * reach the shape it checks over this fixture — and the attached
 * implementation's shape is **field-by-field construction**, with the value
 * field not in the source of the mapping at all. Its runtime half needs a
 * jar that answers, which is the gated browser job's ground, not a lie to
 * tell the suite here.
 */
const COOKIE_JAR_UNANSWERABLE = 'a cookie summary carries no value, on any implementation';

/**
 * The download property. The fetch is fixed **page code**, and the fake
 * extension creates an isolated world with no execution context, so the
 * expression starts and never finishes — the same fixture-side limit the
 * focus read hits, and the reason `attached.test.ts` proves the download's
 * gate and the *absence of the crossing* rather than a fetched file. The
 * arithmetic this property asks about is only observable through a page that
 * can run the fetch, which is the gated browser job's ground, not a story to
 * tell the suite here.
 */
const PAGE_CODE_UNANSWERABLE = 'a download counts the bytes, not the encoding they travel in';

export const attachedSubject: SeamSubject = {
  name: 'attached',
  // The relay binds a loopback port and the fake extension is code, not
  // installed software: unlike the real subject, this one is never
  // unavailable for a machine reason.
  unavailable: () => undefined,
  notApplicable: (property: SeamProperty): string | undefined => {
    if (NO_KEEPER_BY_CONSTRUCTION.has(property.name)) {
      return (
        'an attached browser has no keeper tab, by construction: the kind refuses ensureKeeperTab at the seam, ' +
        'because adding a blank tab to a person’s window is a write to his browsing that no claim asked for. ' +
        'The refusal, and the absence of the tab-opening call behind it, are pinned in tests/browser/attached.test.ts.'
      );
    }
    if (property.name === COOKIE_JAR_UNANSWERABLE) {
      return (
        'the fake extension answers no cookie jar — the client fails on the empty reply before any summary exists — ' +
        'so the shape cannot be reached over this fixture. The attached mapping builds each summary field by field, ' +
        'and its runtime half belongs to the gated browser job.'
      );
    }
    if (property.name === PAGE_CODE_UNANSWERABLE) {
      return (
        'the fetch is fixed page code, and the fake extension creates an isolated world with no execution ' +
        'context — the expression starts and never finishes — so the byte count is never observable over this ' +
        'fixture. What this fixture can prove, the gate refusing and no evaluate crossing, is pinned in ' +
        'tests/browser/attached.test.ts; the fetched half belongs to the gated browser job.'
      );
    }
    return undefined;
  },
  open: async (browser) => {
    const bridge = await connect({
      clientName: 'seam conformance',
      extensionId: EXTENSION_ID,
    });
    const extension = await FakeExtension.connect(bridge.extensionEndpoint, {
      origin: `chrome-extension://${EXTENSION_ID}`,
    });
    await extension.initialize();
    const session = await attachOverBridge(bridge, {
      browser,
      clientName: 'seam conformance',
      extensionId: EXTENSION_ID,
    });
    return {
      session,
      dispose: async () => {
        // detach closes the bridge's listener and the Playwright connection;
        // it closes **no tab**, which is the attached kind's own rule and one
        // `attached.test.ts` pins — so dispose has nothing to clean up after
        // a property that opened tabs and left them.
        await session.detach();
      },
    };
  },
};
