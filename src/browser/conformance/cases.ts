import { ARTIFACT_COLLECTION, READ_ARTIFACTS } from '../driver.ts';
import type { SeamProperty } from './case.ts';

/**
 * The properties both driver implementations must satisfy, each argued.
 *
 * ── The selection rule, restated because it is the deliverable ───────────
 *
 * `case.ts` states it: a property belongs here when **the service reasons
 * about it** — when a path in `src/` derives a decision from it, so two
 * implementations disagreeing means the service decides differently against
 * one than against the other. Everything below names that path.
 *
 * What that rule **excludes** is as much the point as what it admits, so the
 * rejected candidates are recorded at the bottom of this file rather than
 * silently omitted. A reader who wonders "why is navigation not pinned here"
 * deserves the answer without having to reconstruct it.
 *
 * ── The keeper tab dominates this list, and that is not an accident ──────
 *
 * Four of the six properties are about the keeper. The reason is structural
 * rather than a failure of imagination: the keeper is **the one object on
 * this seam that the service must reason about without being able to address
 * it**. Every other page is reached through a handle a caller holds, so a
 * disagreement about it surfaces as an operation that fails. The keeper is
 * reached through no handle at all — its whole specification is a set of
 * *absences* (`SCHEMA.md` §3.15: never leased, never addressable, never
 * counted), and an absence is precisely what a fixture can agree with while
 * being wrong.
 *
 * That is why the original defect was a keeper defect, and why the properties
 * that keep it from recurring are keeper properties.
 */

/** A discovery record shaped like one read off disk and then verified. */
const RECORD = { endpoint: 'http://127.0.0.1:0', browserUuid: 'conformance' } as const;

export { RECORD as CONFORMANCE_RECORD };

export const SEAM_PROPERTIES: readonly SeamProperty[] = [
  {
    name: 'the keeper tab is absent from listTabs',
    rule: 'keeper.never_leased',
    why: 'Reconciliation closes every listed page no live lease owns, and the keeper is owned by no lease by construction — so an implementation that lists it makes the destructive behaviour and the correct behaviour agree, and closing the keeper kills the shared signed-in browser (SCHEMA.md §3.15).',
    check: async ({ session }) => {
      const keeper = await session.ensureKeeperTab();
      const listed = await session.listTabs();

      // Named, not counted. A count would pass against an implementation that
      // listed the keeper and omitted some *other* page — which is a second
      // bug wearing this one's clothes, and reconciliation would then close a
      // page a live lease owns.
      if (listed.some((tab) => tab.driverTabId === keeper.driverTabId)) {
        return `listTabs returned the keeper tab (${keeper.driverTabId}), so reconciliation would treat it as an unowned page and close it`;
      }
      return undefined;
    },
  },

  {
    name: 'a leased tab IS in listTabs, so the exclusion is not simply an empty answer',
    rule: 'keeper.never_leased',
    why: 'The property above is satisfied by an implementation whose listTabs always answers nothing — an assertion over an empty set passes forever and silently. Reconciliation reads this list to decide what exists, so an always-empty answer would make every recorded tab look vanished and close every live lease.',
    check: async ({ session }) => {
      await session.ensureKeeperTab();
      const leased = await session.openTab();
      const listed = await session.listTabs();

      if (!listed.some((tab) => tab.driverTabId === leased.driverTabId)) {
        return `listTabs did not return a tab this session had just opened (${leased.driverTabId}), so the list is not a live reading of what the browser has open`;
      }
      return undefined;
    },
  },

  {
    name: 'the keeper tab survives being named to closeTab',
    rule: 'keeper.never_leased',
    why: 'SCHEMA.md §3.15 and §7.3: the keeper is never addressable, and a caller cannot close what it cannot name. The handle ensureKeeperTab returns exists so the service can assert the tab is present, not so anything can drive it — an implementation on which that handle closes the keeper turns a lever the service holds for a safety check into the exact destructive act it is checking against.',
    check: async ({ session }) => {
      const keeper = await session.ensureKeeperTab();

      // Closing is best effort by design (§2.4b), so this must not reject —
      // and it must not do anything either. Both halves matter: a rejection
      // would be a driver reporting a failure the service is specified to
      // ignore, and a close would be the keeper gone.
      await session.closeTab(keeper);

      // ── What is asserted, and why it is identity rather than presence ────
      //
      // The keeper is **the one page on this seam with no observable except
      // its own identity**: it is excluded from `listTabs` by the first
      // property in this file, so "is it still open" cannot be asked through
      // the seam at all. What *can* be asked is whether the tab the session
      // now calls its keeper is the same one it called its keeper before —
      // and because `ensureKeeperTab` is idempotent (the property below),
      // a **changed** identifier means the original was destroyed and
      // replaced. On a headed browser there would have been no second chance
      // to replace it; the browser would already be gone.
      //
      // An earlier draft of this property asked whether the re-established
      // keeper appeared in `listTabs`, and it was wrong in a way worth
      // recording: an implementation that destroys the keeper and hands back
      // a fresh handle keeps it out of the list too, so the check passed
      // against the very mutation it was written for. It was caught by the
      // control asserting its own mutation had applied.
      const after = await session.ensureKeeperTab();
      if (after.driverTabId !== keeper.driverTabId) {
        return `closing the keeper destroyed it: the session called it ${keeper.driverTabId} before the close and ${after.driverTabId} after, so a caller holding that handle can end the shared browser`;
      }
      return undefined;
    },
  },

  {
    name: 'establishing the keeper twice yields one keeper, not two',
    rule: 'keeper.present',
    why: 'It is a spawn-time precondition checked on every spawn (SCHEMA.md §7.2), and this service is spawned per caller — so a non-idempotent implementation accumulates one uncounted page per spawn. Those pages are excluded from listTabs by the property above, which means reconciliation cannot see them either: the leak is invisible to the one mechanism built to find leaks.',
    check: async ({ session }) => {
      const first = await session.ensureKeeperTab();
      const second = await session.ensureKeeperTab();

      if (first.driverTabId !== second.driverTabId) {
        return `two calls to ensureKeeperTab reported different tabs (${first.driverTabId} then ${second.driverTabId}), so each spawn establishes another keeper`;
      }
      return undefined;
    },
  },

  {
    name: 'a tab handle names the browser it belongs to',
    rule: 'claim.browser_known',
    why: 'Capacity is one total across both browsers (DECISIONS.md §6) and the store indexes a physical tab by (browser_id, driver_tab_id) — so a handle carrying the wrong browser is a row written against the wrong browser, and reconciliation then compares one browser’s pages against the other’s records.',
    check: async ({ session }) => {
      const described = session.describe();
      const leased = await session.openTab();
      const keeper = await session.ensureKeeperTab();

      for (const [label, handle] of [
        ['openTab', leased],
        ['ensureKeeperTab', keeper],
      ] as const) {
        if (handle.browser !== described.browser) {
          return `${label} returned a handle naming the ${handle.browser} browser from a session describing itself as ${described.browser}`;
        }
      }

      for (const tab of await session.listTabs()) {
        if (tab.browser !== described.browser) {
          return `listTabs returned a handle naming the ${tab.browser} browser from a session describing itself as ${described.browser}`;
        }
      }
      return undefined;
    },
  },

  {
    name: 'a cookie summary carries no value, on any implementation',
    rule: 'read.cookies_no_values',
    why: 'SCHEMA.md §7.1 makes this a shape rather than a refusal: the value field is absent, not masked. The service writes this structure straight to a file (real.ts read()), with no redaction step in between — so an implementation that added a value field would put cookie values on disk with no line of code anywhere saying so.',
    check: async ({ session }) => {
      const tab = await session.openTab();
      const summaries = await session.cookies(tab);

      // Asserted over the keys actually present rather than by reading a
      // named field: `CookieSummary` has no `value`, so a test reading
      // `summary.value` would not compile and could never fail. The runtime
      // question — did this implementation put one there anyway — is only
      // answerable by looking at what the object has.
      for (const summary of summaries) {
        const forbidden = Object.keys(summary).filter((key) =>
          ['value', 'values', 'cookievalue'].includes(key.toLowerCase().replace(/[_-]/gu, '')),
        );
        if (forbidden.length > 0) {
          return `a cookie summary carried ${forbidden.join(', ')}, and the service writes this structure to disk verbatim`;
        }
      }
      return undefined;
    },
  },
];

/**
 * Properties that were considered and **deliberately left out**, with the
 * reason each was rejected.
 *
 * ── Why the rejections are written down ─────────────────────────────────
 *
 * A list of what a suite covers invites the question of what it does not, and
 * a reader who cannot find the answer assumes an omission is an oversight.
 * Worse, the next person to extend this file re-derives the same candidates
 * and adds the mechanical ones, because nothing recorded that they were
 * weighed. This is the argument, kept next to the thing it is about.
 *
 * | Candidate | Why it is not here |
 * |---|---|
 * | **Navigation returns the post-redirect address** | The fake's navigation always arrives and never redirects. Pinning it would assert the fake's canned answer, not an agreement — real redirect behaviour needs a real server and belongs to the row that owns navigation. |
 * | **`act` returns a fresh snapshot** | Both do, but the fake's path names no file on disk. The property the service reasons about is *that a snapshot came back*, which is type-level and already structural; *what is in it* is not comparable between the two by construction. |
 * | **`settlePage` precedes `capture`** | This is an ordering the **pipeline** performs, not a property of either implementation — the seam deliberately splits the two calls so the ordering is the caller's. It is asserted against the fake's call log where sequences are observable, which is the right place for it. |
 * | **Tab identifier spelling** | Nothing derives a decision from the format. Real uses the browser's own target id; the fake counts. Pinning it would only make the fake harder to change. |
 * | **`detach` leaves tabs open** | Genuinely load-bearing (§1.2a is the measurement the shared-session design rests on) — but not checkable through the seam: after `detach` the real session's connection is closed, so there is no way to ask it what is open without attaching afresh, which needs a driver rather than a session. It stays a fake-log assertion in `fake.test.ts` and a measured claim in `real.ts`. |
 * | **`openTab` establishes the keeper first** | **A real divergence, found by measuring: `real.ts` awaits `ensureKeeperTab()` as the first line of `openTab`; the fake does not.** It is left out because it is not observable through the seam — `listTabs` excludes the keeper by the first property above, so no sequence of seam calls distinguishes an implementation that established one from an implementation that did not. It is reported in the pull request rather than pinned here, because a property this file cannot check must not appear to be one it does. |
 */
export const REJECTED_PROPERTY_COUNT = 6;

/**
 * Every artefact whose collection model the service depends on.
 *
 * Exported for the suite's own completeness assertion rather than used here:
 * `ARTIFACT_COLLECTION` decides whether asking for an artefact costs
 * anything, and a member added to `ReadArtifact` without an entry there would
 * make that question unanswerable for the new one.
 */
export const ARTIFACTS_WITH_A_COLLECTION_MODEL: readonly string[] = READ_ARTIFACTS.filter(
  (artifact) => ARTIFACT_COLLECTION[artifact] !== undefined,
);
