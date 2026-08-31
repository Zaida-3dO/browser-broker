/**
 * The one place the temporary-profile prefix is spelled.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 *
 * Three separate browser-leak incidents turned out to be the same mistake
 * wearing a different name. Each time, something created scratch directories
 * under a prefix of its own invention; each time, the sweeper and the audits
 * looked for **one** prefix — the test fixture's `broker-browser-` — and each
 * time they truthfully reported zero while the machine filled up with
 * browsers.
 *
 * The third was found by hand, on a developer's own desktop, as tens of
 * orphaned browser windows and hundreds of processes accumulated over a single
 * morning under `broker-operations-check-` — a prefix belonging to a build
 * gate that runs on every pass, including in continuous integration. Two leak
 * fixes had already landed and been reported as closing the problem. They had
 * closed it, for the prefix they searched.
 *
 * A survey of the repository at that point found **thirty-five** distinct
 * `broker-*` prefixes. The lesson: *a check that cannot see a thing is
 * indistinguishable from the thing not being there.*
 *
 * ── Why a stem, and not a registry of the thirty-five ───────────────────
 *
 * The obvious fix is a list of every known prefix. That fix is what already
 * failed: a list is only ever as current as the last incident, and the
 * thirty-sixth caller — who will not read this file — invents a name that is
 * on nobody's list and is therefore swept by nothing.
 *
 * So what is shared here is the **stem** rather than the leaves. Every scratch
 * root in this repository begins `broker-`, the sweeper matches that family,
 * and {@link temporaryPrefix} is the way to extend it. A caller that uses this
 * helper cannot land outside the family, because the family is the part it
 * does not get to choose. A caller that ignores this helper and writes the
 * literal still lands inside the family as long as it begins `broker-`, which
 * every existing one does — the stem is a much weaker thing to have to
 * remember than a registration step, and weak-but-unforgettable is the right
 * trade for a rule whose failure mode is silent.
 *
 * This is deliberately not enforcement. A lint rule banning `mkdtempSync` with
 * a literal would be the stronger version and is worth having if a fourth
 * incident happens; it was not written now because the thirty-five existing
 * call sites are overwhelmingly in tests that never launch a real browser, and
 * rewriting all of them to satisfy a rule is a large diff whose risk exceeds
 * the leak it would prevent.
 */

/**
 * The stem every temporary directory this repository creates begins with.
 *
 * The sweeper matches on exactly this, so a directory that does not begin with
 * it is swept by nothing.
 */
export const TEMP_PREFIX_STEM = 'broker-';

/**
 * Build a temporary-directory prefix inside the swept family.
 *
 * Pass what the directory is *for* — `'operations-check'`, `'browser'` — and
 * receive the full prefix to hand to `mkdtempSync`. The trailing separator is
 * included because `mkdtempSync` appends its random characters directly, and a
 * prefix without it produces `broker-operations-checkA1b2c3`, which reads as a
 * different prefix to anything trying to group by name.
 *
 * @param {string} purpose What the directory holds. Lower-case words separated
 *   by single hyphens; it becomes part of a filesystem path.
 * @returns {string} The prefix, e.g. `broker-operations-check-`.
 */
export function temporaryPrefix(purpose) {
  if (typeof purpose !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(purpose)) {
    // Refused rather than sanitised. A silently-corrected prefix is how a
    // directory ends up under a name nobody expects, which is the failure this
    // whole file exists to prevent -- so an unusable argument is a loud error
    // at the call site instead.
    throw new TypeError(
      `A temporary-directory purpose must be lower-case hyphen-separated words; received ${JSON.stringify(purpose)}.`,
    );
  }
  return `${TEMP_PREFIX_STEM}${purpose}-`;
}
