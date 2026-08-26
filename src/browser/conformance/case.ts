import type { BrowserSession } from '../driver.ts';

/**
 * A driver-seam conformance property: authored **once per property, never per
 * implementation**.
 *
 * ── Why this file exists, which is not "the fake had a bug" ──────────────
 *
 * The bug is fixed. `real.ts` excluded the keeper tab from
 * {@link BrowserSession.listTabs} and `fake.ts` included it, and the fake was
 * corrected. What is not fixed by that correction is the reason the divergence
 * survived: **the agreement between the two implementations was asserted
 * nowhere**, so the next divergence hides exactly the way that one did.
 *
 * The way it hid is worth stating precisely, because it is the shape this
 * file is built against. `listTabs` had no consumer in `src/` for as long as
 * the divergence existed, so it was harmless. Reconciliation became that
 * consumer — and reconciliation **closes pages that no live lease owns**,
 * while the keeper is owned by no lease *by construction*. So a fake that
 * listed the keeper produces a fixture in which the correct behaviour and the
 * destructive behaviour **agree**: the suite would have been *evidence for*
 * closing the keeper. Closing the keeper kills the shared signed-in browser,
 * because a headed browser dies within about half a second of its last tab
 * closing (`SCHEMA.md` §3.15) — and **nothing headed runs in continuous
 * integration to contradict it.**
 *
 * ── The hard question this file answers: which properties belong here ────
 *
 * **"The two implementations behave identically" is false, and useless as a
 * specification.** The fake exists precisely in order to differ: it must not
 * launch Chromium, it has no timing, its navigation always arrives, and its
 * snapshot is a path no file exists at. A suite asserting sameness would
 * either be wrong or would have to be weakened until it asserted nothing.
 *
 * The sharper statement, and the one every entry in `cases.ts` is held to:
 *
 * > **A property belongs here when the service reasons about it** — when some
 * > path in `src/` derives a decision from it, so that two implementations
 * > disagreeing means the service decides differently against one than
 * > against the other, and the fixture is the thing that says which.
 *
 * The keeper exclusion qualifies because **capacity is derived from it**:
 * `decideReconciliation` treats an unlisted page as unowned and closes it.
 * *"The fake's tab identifiers are `fake-tab-1`"* does not qualify — nothing
 * derives anything from the spelling, and pinning it would be a mechanical
 * assertion that only makes the fake harder to change.
 *
 * **A short list of genuinely load-bearing properties beats a long list of
 * mechanical ones**, and the reason is not brevity for its own sake: every
 * mechanical entry here is a line that will one day fail for a reason nobody
 * cares about, and a suite that cries wolf is a suite whose next real failure
 * is waived.
 *
 * ── Why a property is a function of a session rather than a case table ───
 *
 * The adapter suite next door (`src/adapter/conformance/`) is the model for
 * this file's structure, and it authors cases as **data** — an operation, an
 * input and an expected outcome — because every route there answers the same
 * request shape and the runner can take the cross product mechanically.
 *
 * That does not transfer. The properties here are about **sequences and
 * relationships**: establish a keeper, then open a tab, then ask what is
 * listed and assert the first is absent from the answer. There is no single
 * request shape to tabulate, so a property is a small program over a session
 * — and the runner's job is to run each one against every implementation and
 * report which disagreed, rather than to interpret a table.
 */

/**
 * What a property may do to reach its answer, and the one thing it may not.
 *
 * A property receives a live {@link BrowserSession} and nothing else. It may
 * not reach for the fake's call log, its tab counters, or any other lever
 * that exists on one implementation and not the other — **there is no
 * parameter through which it could**, which is the point.
 *
 * ── Why that restriction is the whole design ────────────────────────────
 *
 * A property that read `FakeBrowserDriver.openTabCount` would be unable to
 * run against the real driver at all, so it would silently become a
 * fake-only assertion — which is the defect this suite exists to close,
 * reintroduced inside the thing meant to close it. Restricting a property to
 * the **seam's own vocabulary** is what makes "the same property, asked of
 * both" a true description rather than an aspiration.
 *
 * The cost is real and worth naming: some things about an implementation are
 * simply not observable through the seam, and those cannot be conformance
 * properties here. `openTabCount` is the example — the seam offers no page
 * count, only {@link BrowserSession.listTabs}, which deliberately omits the
 * keeper. So *"the keeper is open"* is not directly askable; *"the keeper is
 * not in the list"* and *"the keeper survives a close"* are, and they are
 * what `cases.ts` asks.
 */
export interface PropertyContext {
  readonly session: BrowserSession;
}

/**
 * One property both implementations must satisfy.
 *
 * ── `check` reports rather than throws, and that is deliberate ───────────
 *
 * It returns the reason it failed, or `undefined` for a pass. A property that
 * threw could only be tested by catching an exception and hoping it was the
 * right one; a property that returns its complaint lets the runner attribute
 * the failure to a named property on a named implementation, and lets a
 * negative control assert **which** property fired rather than that
 * something, somewhere, went wrong.
 *
 * The runner still catches throws — an unexpected exception is a failure of
 * the property too — but it is reported as its own finding kind, so a
 * property that crashes cannot be mistaken for a property that refused.
 */
export interface SeamProperty {
  /** Unique, and read by a person when it fails. */
  readonly name: string;
  /**
   * The rule this pins, from `SCHEMA.md` §7.1–§7.3 where one exists.
   *
   * Recorded because §3.14 requires a citation to name a rule that exists,
   * and because it is what makes *"which documented guarantee did this
   * defend"* answerable from the failure output rather than from a reader's
   * memory.
   */
  readonly rule: string;
  /**
   * **Why the service reasons about this**, in one sentence a reader can
   * disagree with.
   *
   * Mandatory, and the runner refuses a blank one. The bar this file sets is
   * that every property is *argued*, and an argument nobody wrote down is an
   * argument nobody can check — a property with an empty justification is
   * exactly the mechanical entry the header says not to add.
   */
  readonly why: string;
  /** The reason it failed, or `undefined` when it holds. */
  readonly check: (context: PropertyContext) => Promise<string | undefined>;
}
