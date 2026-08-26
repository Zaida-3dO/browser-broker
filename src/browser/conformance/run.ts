import type { BrowserId } from '../driver.ts';
import type { SeamProperty } from './case.ts';
import type { SeamSubject } from './subjects.ts';

/**
 * The driver-seam conformance run: every property, against every
 * implementation that can run here.
 *
 * ── Why this returns findings instead of throwing ───────────────────────
 *
 * The same reason the adapter runner next door does, and it is not a style
 * preference. `MILESTONES.md` requires **negative controls, each asserted to
 * fail**, "because an assertion nobody has watched fail is an assertion
 * nobody has tested". A runner that threw on the first problem could only be
 * tested by catching an exception and hoping it was the right one; a runner
 * that returns every finding lets a control assert **which** property fired.
 *
 * The suite fails on any finding. The controls assert a specific finding is
 * present. One runner, one behaviour.
 *
 * ── The skip is a finding's peer, not a silent pass ─────────────────────
 *
 * A subject that cannot run here is reported in {@link SeamReport.skipped}
 * with its reason, and the suite prints it. **A skip is never a finding** —
 * a machine with no browser installed is not a defect — but it is never
 * invisible either, because the entire failure this suite exists to prevent
 * is a green result that proves less than it appears to.
 */

/** Which assertion produced a finding. Named so a control can assert on it. */
export type SeamFindingKind =
  /** A property reported that it does not hold on this implementation. */
  | 'property-violated'
  /** A property threw rather than reporting, which is a failure of its own kind. */
  | 'property-threw'
  /** A property carries no argument for why the service reasons about it. */
  | 'property-unjustified'
  /** Two properties share a name, so a finding could not be attributed. */
  | 'property-name-duplicated'
  /** The property table is empty, so every per-property assertion is vacuous. */
  | 'property-table-empty'
  /** No subject could run, so a green report would prove nothing at all. */
  | 'no-subject-ran';

export interface SeamFinding {
  readonly kind: SeamFindingKind;
  readonly subject?: string;
  readonly property?: string;
  readonly rule?: string;
  readonly detail: string;
}

/** A subject that did not run, and why. */
export interface SeamSkip {
  readonly subject: string;
  readonly reason: string;
}

export interface SeamReport {
  readonly findings: readonly SeamFinding[];
  /**
   * How many property-and-implementation pairs actually ran.
   *
   * Zero is the vacuous case and is itself a finding. Reported as a number
   * rather than inferred from an empty findings list, because those two look
   * identical from the outside and mean opposite things.
   */
  readonly pairsRun: number;
  readonly skipped: readonly SeamSkip[];
  /** Every subject that actually ran, named. */
  readonly subjectsRun: readonly string[];
}

export interface SeamRunOptions {
  readonly subjects: readonly SeamSubject[];
  readonly properties: readonly SeamProperty[];
  /**
   * Which browser to open. Defaults to the private one.
   *
   * **The private browser, deliberately, and only for the real subject's
   * sake:** it is the headless one (§1.2), so a suite that runs on every
   * developer's machine does not open windows. The keeper-tab measurement
   * that motivates half these properties is a *headed* fact, and this suite
   * does not test it — `tests/browser/keeper-tab.test.ts` does, headed, and
   * says at length why it must stay that way. What this suite checks is the
   * seam's **contract**, which is the same in both modes.
   */
  readonly browser?: BrowserId;
}

/** Roughly a sentence. A justification shorter than this is not an argument. */
const JUSTIFICATION_MINIMUM_WORDS = 12;

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') {
    return 0;
  }
  return trimmed.split(/\s+/u).length;
}

/**
 * Run every property against every available implementation.
 *
 * Each property gets **its own session**, freshly opened and disposed. That is
 * deliberate and it costs a browser page per property on the real subject:
 * these properties open tabs and establish keepers, so a shared session would
 * let one property's leftovers decide another's answer, and the order they
 * happened to run in would become part of the specification.
 */
export async function runSeamConformance(options: SeamRunOptions): Promise<SeamReport> {
  const findings: SeamFinding[] = [];
  const skipped: SeamSkip[] = [];
  const subjectsRun: string[] = [];
  const browser: BrowserId = options.browser ?? 'private';
  let pairsRun = 0;

  // An assertion evaluated over an empty set passes forever and silently, so
  // the set is checked directly rather than only iterated.
  if (options.properties.length === 0) {
    findings.push({
      kind: 'property-table-empty',
      detail: 'the property table is empty, so every per-property assertion would pass vacuously',
    });
  }

  const seen = new Set<string>();
  for (const property of options.properties) {
    if (seen.has(property.name)) {
      findings.push({
        kind: 'property-name-duplicated',
        property: property.name,
        detail: `two properties are named "${property.name}", so a finding cannot be attributed to one of them`,
      });
    }
    seen.add(property.name);

    // The bar `cases.ts` sets is that every property is argued. An argument
    // nobody wrote down is one nobody can check, and the mechanical entries
    // this suite is meant to exclude are exactly the ones with nothing to say.
    if (wordCount(property.why) < JUSTIFICATION_MINIMUM_WORDS) {
      findings.push({
        kind: 'property-unjustified',
        property: property.name,
        rule: property.rule,
        detail: `"${property.name}" gives no argument for why the service reasons about it`,
      });
    }
  }

  for (const subject of options.subjects) {
    const reason = subject.unavailable();
    if (reason !== undefined) {
      skipped.push({ subject: subject.name, reason });
      continue;
    }
    subjectsRun.push(subject.name);

    for (const property of options.properties) {
      const opened = await subject.open(browser);
      try {
        const complaint = await property.check({ session: opened.session });
        pairsRun += 1;
        if (complaint !== undefined) {
          findings.push({
            kind: 'property-violated',
            subject: subject.name,
            property: property.name,
            rule: property.rule,
            detail: complaint,
          });
        }
      } catch (error) {
        pairsRun += 1;
        findings.push({
          kind: 'property-threw',
          subject: subject.name,
          property: property.name,
          rule: property.rule,
          detail: `the property threw rather than reporting: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        await opened.dispose();
      }
    }
  }

  // Every subject skipping is not the same as every subject passing, and a
  // report that did not say so would be the exact defect this suite exists
  // to close — a green result standing in for an unrun one.
  if (subjectsRun.length === 0) {
    findings.push({
      kind: 'no-subject-ran',
      detail: `no implementation of the seam could be exercised here, so this run proves nothing: ${
        skipped.map((entry) => `${entry.subject} (${entry.reason})`).join('; ') || 'none offered'
      }`,
    });
  }

  return { findings, pairsRun, skipped, subjectsRun };
}
