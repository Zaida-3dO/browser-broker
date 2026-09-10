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
 * ── These numbers have been MEASURED, and they survived it ──────────────
 *
 * `MILESTONES.md` #34's resolution-ladder study has been run — the harness is
 * `ladder.ts`, the instruments are `legibility.ts`, and the measurements are
 * `tests/capture/ladder.test.ts` (everywhere) and
 * `tests/capture/ladder-rendered.test.ts` (where a browser exists).
 * **The measurement kept all three rungs below**, and the evidence for each is
 * published beside it. A change to any of them needs a measurement rather than
 * an argument.
 *
 * **The property the default rests on held.** *Text legibility breaks at a
 * higher resolution than layout critique does* is now measured rather than
 * asserted, and the mechanism is nameable: a downscale destroys a feature when
 * the feature's period falls below roughly two and a half **destination**
 * pixels, so what a rung costs a picture depends on the size of the feature
 * rather than on the rung. A block-scale feature — the scale a layout
 * judgement is made at — survives every rung on this ladder, including well
 * below the cheapest one. Fine text detail does not.
 *
 * Stem retention on rendered prose, at a viewport wide enough that all three
 * rungs genuinely shrink:
 *
 * | Font | `default` | `detail` | `max` |
 * |---|---|---|---|
 * | 11px | 35% | 41% | 100% |
 * | 12px | 24% | 50% | 100% |
 * | 14px | 7% | 83% | 100% |
 * | 16px | 63% | 93% | 100% |
 * | 20px | 87% | 100% | 100% |
 * | 32px | 98% | 100% | 100% |
 *
 * Each rung does the job its name claims: **`max` returns everything**, which
 * is why it is the one that costs a written reason; **`detail` recovers
 * ordinary body copy**; and **`default` keeps headings and layout intact while
 * damaging small body copy** — which is not a defect but the lever working,
 * since a caller that needs to *read* something is pushed toward the snapshot
 * or the evaluation, which return text and cost almost nothing.
 *
 * ── ⚠️ What the study did NOT settle ────────────────────────────────────
 *
 * **The absolute legibility floor is still open**, and it is worth being exact
 * about why. The instruments measure what the *pipeline* destroys — stroke
 * contrast, and whether the gaps between strokes survive — which **bounds**
 * what any reader could recover but does not predict what one will. What an
 * agent looking at a picture can actually read is a property of that model,
 * not of these pixels, and no test here can establish it. So the rungs are
 * settled as *"these deliver the structure they claim to"*, not as *"this is
 * the smallest picture a reader can use"*. §9.3 keeps that second question
 * open.
 *
 * They remain named constants in one module: **nothing hard-codes a rung
 * anywhere a later study cannot change it**, and a capture records which rung
 * it was taken at (`captures.tier`) rather than having its rung inferred from
 * its dimensions, so a rung moving invalidates nothing already stored (§6.2).
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
 * `DECISIONS.md` §13d). **Measured by #34 and kept** — see the evidence table
 * in this file's header.
 *
 * | Tier | Long edge | How a caller gets it | What the study measured it delivering |
 * |---|---|---|---|
 * | `default` | 1024 | passes nothing | layout and headings intact; small body copy damaged |
 * | `detail` | 1568 | asks for it — the ceiling of the cheap vision tier | ordinary body copy recovered |
 * | `max` | 2576 | asks for it **and gives a written reason**, which is recorded | everything, at every font size tested |
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

/**
 * What a caller is owed when the picture it is holding is not the picture the
 * page showed.
 *
 * ── Why this exists, stated as the thing that happened ──────────────────
 *
 * A `full_page` capture of an ordinary long article came back **165 x 1024**
 * from a 1030 x 6404 page — a faithful, complete, undistorted render at about
 * sixteen per cent, in which no text is legible. The response said
 * `outcome: accepted`, gave a real path and a real byte count, and the file
 * opened. **Nothing in it said the image had been reduced at all**, because
 * the two numbers that would have said so — what the browser produced, before
 * shrinking — were computed by the pipeline, written to `captures`, and then
 * dropped by the service layer that builds the caller's reply.
 *
 * That is the failure this repository keeps finding in other clothes: a call
 * that succeeds and quietly hands back less than it appears to. It is
 * particularly costly here because a full-page capture is the standard
 * evidence a reviewer attaches, and *"an unreadable control"* is one of the
 * defects this project's own history lists as invisible to a large passing
 * suite. **A control that is unreadable at full size and a control that is
 * unreadable at sixteen per cent look identical.** A reviewer who glances at
 * a plausible thumbnail and writes "layout looks correct" has attached
 * evidence that cannot support the claim, and nothing warned them.
 *
 * ── Why a sentence and not only a number ────────────────────────────────
 *
 * The scale alone is a number a caller has to know to look for. The sentence
 * is what reaches a caller that never read a specification — the same reason
 * `escalationGuidance` is prose rather than a pair of integers. It names the
 * reduction, the dimensions on both sides, and — when there is a rung left to
 * climb — what to pass to get more, so the caller can decide whether the
 * image supports the claim it was about to make.
 *
 * **This is deliberately a disclosure and not a refusal.** The long-edge cap
 * is how `capture` honours *"never refused for cost"*, and raising it into
 * the caller's field of view does not remove it. Capping the *width* at the
 * rung instead — so that a tall page came back at its own width — was
 * measured on the observed pages and reaches roughly 8,700 to 21,800
 * estimated tokens against the present 90 to 230. A silent forty-fold cost
 * increase would be a worse defect than the one this reports.
 */
export interface CaptureReduction {
  /** What the browser produced, before any shrinking. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /**
   * Written over source, on the dimension the cap actually bit.
   *
   * Rounded to three places because it is a description, not an input to
   * anything: a caller reads it to judge whether text survived.
   */
  readonly scale: number;
  /** The reduction in words, for a caller that reads one field and no schema. */
  readonly note: string;
}

/**
 * Describe the shrink, or return nothing when there was not one.
 *
 * **Absent rather than `scale: 1` when nothing was reduced**, and the
 * difference is the one this whole helper is for: a field that is always
 * present is a field a caller stops reading. Its presence is the signal.
 */
export function describeReduction(
  source: { readonly width: number; readonly height: number },
  written: { readonly width: number; readonly height: number },
  tier: CaptureTier,
): CaptureReduction | undefined {
  if (written.width >= source.width && written.height >= source.height) {
    return undefined;
  }

  // Taken on the long edge, which is the edge the cap is applied to — so this
  // is the factor that was actually used rather than one recovered from
  // whichever dimension happens to round more kindly.
  const scale =
    Math.max(source.width, source.height) === 0
      ? 1
      : Math.max(written.width, written.height) / Math.max(source.width, source.height);
  const percent = Math.round(scale * 100);

  // Named only when there is one, so the sentence never tells a caller already
  // on the top rung to escalate to it.
  const higher = HIGHER_TIERS[tier];
  const remedy =
    higher === undefined
      ? `This is the highest rung, so a larger image of the whole page is not available; capture a selector, or read the page as text instead.`
      : `For more detail pass tier="${higher}"${higher === TIER_REQUIRING_REASON ? ' together with reason' : ''}.`;

  // The width is called out separately because it is the number that decides
  // legibility on a tall page, and it is the one a caller reading "scale" on
  // its own would not think to compare against the viewport.
  return {
    sourceWidth: source.width,
    sourceHeight: source.height,
    scale: Math.round(scale * 1000) / 1000,
    note:
      `This image was REDUCED to about ${String(percent)}% of the page: ` +
      `${String(source.width)}x${String(source.height)} was written as ` +
      `${String(written.width)}x${String(written.height)}. ` +
      `A capture is shrunk so its LONGEST edge fits ${String(TIER_LONGEST_EDGE[tier])}px, so on a page ` +
      `taller than it is wide the height sets the factor and the width shrinks with it — ` +
      `${String(written.width)}px of width here. Text may not be legible. ` +
      remedy,
  };
}

/**
 * The next rung up from each, and `undefined` at the top.
 *
 * A table rather than an ordering computed from {@link TIER_LONGEST_EDGE},
 * because "which rung does a caller ask for next" is a fact about the
 * surface's vocabulary — `default` is not requestable by name — and not about
 * which number is larger.
 */
const HIGHER_TIERS: Readonly<Record<CaptureTier, RequestableTier | undefined>> = {
  default: 'detail',
  detail: 'max',
  max: undefined,
};
