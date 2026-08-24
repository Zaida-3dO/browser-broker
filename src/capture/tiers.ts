/**
 * The three resolution rungs, the default, and the estimate of what a picture
 * costs to look at.
 *
 * ── The default is the lever, and this file is where it lives ───────────
 *
 * `DECISIONS.md` §13d reverses the research recommendation, which was a hard
 * service-enforced ceiling with a refusal past a per-lease budget. What ships
 * is a **low default, an explicit opt-in to go higher, and a warning that
 * never becomes a wall** — and the reason is that *most callers never pass an
 * optional parameter*, so a low default does nearly all the work of a ceiling
 * **without blocking anyone**. `MILESTONES.md` #31 puts it plainly: this row
 * carries the lever, not #33.
 *
 * The property underneath, stated as a property because a property survives
 * somebody raising the default and a coincidence does not: **text legibility
 * breaks at a higher resolution than layout critique does.** So a low default
 * naturally pushes a caller that needs to *read* something toward the snapshot
 * or the evaluation, which return text and cost almost nothing. The policy does
 * not have to argue anyone into the cheaper tool.
 *
 * ── These numbers are PROVISIONAL, and this is the file a study changes ──
 *
 * `SCHEMA.md` §6.2 and §9.3, and `MILESTONES.md` #34: the rungs are *reasoned
 * to, not measured*, and a resolution-ladder study exists to settle them with
 * evidence. They are named constants in one module for exactly that reason —
 * **nothing hard-codes a rung anywhere a study cannot change it**, and a
 * capture records which rung it was taken at (`captures.tier`) rather than
 * having its rung inferred from its dimensions, so a rung moving invalidates
 * nothing already stored (§6.2).
 *
 * ── The token estimate is fixed by the version, deliberately ────────────
 *
 * `SCHEMA.md` §6.4: the formula that estimates an image's token cost is fixed
 * by the version and **is not configurable**. *"An estimate is only comparable
 * across time if it was computed the same way, and letting an operator change
 * the formula would silently make old and new numbers incomparable — which
 * would break the one study they exist for."* So there is no environment
 * variable here and no parameter: {@link estimateTokens} takes dimensions and
 * nothing else.
 */

/** Which resolution rung a capture was taken at (`captures.tier`, §1.7). */
export type CaptureTier = 'default' | 'detail' | 'max';

/**
 * The tiers a caller may ask for by name.
 *
 * **`default` is deliberately absent** (`SCHEMA.md` §3.11): *"There is
 * deliberately no way to ask for the default explicitly — a caller writing it
 * out is a caller who thought about resolution and should have said which."*
 * Keeping it out of this type is what makes that a compile error on any
 * surface rather than a rule in prose.
 */
export type RequestableTier = 'detail' | 'max';

/**
 * What a caller gets for asking for nothing.
 *
 * The single most consequential value in this milestone — `MILESTONES.md`
 * #31: *"getting 'cheapest tier when nothing is asked for' right matters more
 * than any threshold downstream of it."*
 */
export const DEFAULT_TIER: CaptureTier = 'default';

/**
 * The tier that costs a written reason.
 *
 * Named rather than spelled `'max'` at each site that checks it, so that the
 * rule *"the top tier requires a reason"* has one definition and the message
 * telling a caller so cannot drift from the check that enforces it.
 */
export const TIER_REQUIRING_REASON: CaptureTier = 'max';

/**
 * The long edge each rung shrinks to, in pixels (`SCHEMA.md` §6.2,
 * `DECISIONS.md` §13d). **Provisional — #34 settles these with evidence.**
 *
 * | Tier | Long edge | How a caller gets it |
 * |---|---|---|
 * | `default` | 1024 | passes nothing |
 * | `detail` | 1568 | asks for it — the ceiling of the cheap vision tier |
 * | `max` | 2576 | asks for it **and gives a written reason**, which is recorded |
 */
export const TIER_LONGEST_EDGE: Readonly<Record<CaptureTier, number>> = {
  default: 1024,
  detail: 1568,
  max: 2576,
};

/**
 * The bounds on a written reason (`SCHEMA.md` §3.11: 8–200 characters).
 *
 * **The minimum is not a deterrent and must not be tuned as one.** §3.11 is
 * explicit: *a caller asked to justify itself will always produce a
 * justification*, so the friction is not the mechanism, and making the field
 * longer or the wording sterner pursues an effect it was never going to have.
 * **The value is the record** — every escalation leaves a reviewable row with
 * a reason attached. The minimum exists only to make the empty answer
 * slightly harder to give than a real one.
 */
export const REASON_MINIMUM_LENGTH = 8;
export const REASON_MAXIMUM_LENGTH = 200;

/**
 * How many captures a lease may take before every subsequent one carries a
 * warning (`SCHEMA.md` §6.2: **12**).
 *
 * *"Roughly a five-view sweep at two breakpoints plus slack."* **Never a
 * refusal** — see `accounting.ts`, which is where that promise is kept and
 * where the reason it can never become a wall is written down.
 */
export const CAPTURES_BEFORE_WARNING = 12;

/**
 * The divisor in the token estimate. **Fixed by the version** (§6.4).
 *
 * `SCHEMA.md` §1.7 declines to store the result: *"It is width times height
 * divided by a fixed constant — a calculation over two columns on the same
 * row … computed when asked for rather than frozen into a column that could
 * disagree with the dimensions beside it."*
 *
 * The constant is consistent with the measured figures `DECISIONS.md` records
 * — roughly 1,600 tokens at the 1568-pixel rung and roughly 4,800 at the
 * 2576-pixel one — and it is an **estimate**, which is the word used
 * everywhere on purpose. `captures.bytes` is what it is sanity-checked
 * against (§1.7): a file whose size is wildly out of step with its dimensions
 * is the signal that a picture was not what the numbers said.
 */
const TOKENS_PER_PIXEL_DIVISOR = 750;

/**
 * What looking at a picture of these dimensions is estimated to cost.
 *
 * Takes dimensions and nothing else — no tier, no configuration, no options
 * object with a divisor in it. That signature is the enforcement of §6.4:
 * there is no position in which an operator's value could arrive.
 */
export function estimateTokens(width: number, height: number): number {
  return Math.ceil((width * height) / TOKENS_PER_PIXEL_DIVISOR);
}
