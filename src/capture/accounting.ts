import { CAPTURES_BEFORE_WARNING } from './tiers.ts';

/**
 * Capture accounting per claim: **a loud warning, never a refusal**
 * (`MILESTONES.md` #33, `SCHEMA.md` §3.11, §6.2, §7.3).
 *
 * ── The two properties, and why each is written the way it is ───────────
 *
 * **1. It never refuses.** There is no code path in this file that can
 * produce a refusal, and that is structural rather than careful: the only
 * thing exported is a function returning a **string or nothing**. There is no
 * boolean anything downstream could branch on to deny, no threshold parameter
 * an operator could raise into a wall, and no error type. `SCHEMA.md` §6.2
 * deletes the setting outright — *"No 'refuse captures after N'. Nothing is
 * ever refused on capture grounds, and a value that could turn a warning into
 * a wall would make that promise conditional."* And §7.3's
 * `capture.never_refused_for_cost` is the build rule asserting that absence.
 *
 * The reasoning, from `DECISIONS.md` §13d, is worth carrying rather than
 * citing: **an agent stopped mid-run on a legitimate job concludes the service
 * is an obstacle and starts looking for a way around it.** A service that is
 * occasionally expensive survives that; a service that is occasionally
 * *unusable* does not.
 *
 * **2. The message names the cheaper alternative, and that is the mechanism
 * rather than decoration.** `MILESTONES.md` #33: a bare *"you have taken a lot
 * of captures"* teaches a caller to ask for a bigger budget. A warning that
 * **names the snapshot or the evaluation answering the same question** teaches
 * the thing the policy exists to teach. So the text below is the row, and a
 * change that shortened it into a bare count would pass every test that only
 * checked a warning was present — which is why the test for this names the
 * alternative it must mention.
 *
 * **3. It fires on every capture past the threshold, not only the first**
 * (§3.11), *"because a warning that appears once has scrolled away by the time
 * it matters."*
 */

/**
 * The warning for a capture that is past the threshold, or nothing.
 *
 * @param capturesTakenBefore how many captures this lease had already taken
 *   when this one was requested. Counted before rather than after, so the
 *   caller of this function does not have to know whether the current capture
 *   is included — an ambiguity that would put the boundary one either side of
 *   where §6.2 puts it depending on who read it.
 *
 * @returns the warning text, or `undefined` when there is nothing to say.
 *   **Never a refusal, and there is no shape here that could become one.**
 */
export function captureWarning(capturesTakenBefore: number): string | undefined {
  const thisCapture = capturesTakenBefore + 1;
  if (thisCapture <= CAPTURES_BEFORE_WARNING) return undefined;
  return (
    `This lease has now taken ${String(thisCapture)} captures, past the point where a picture is ` +
    `usually the expensive way to get an answer. This capture was served and always will be — ` +
    `nothing here is ever refused on cost grounds. But if you are reading a value or checking ` +
    `that an element is present, a snapshot or an evaluation returns it as text for a fraction ` +
    `of what an image costs, because an image is re-read on every later turn of the ` +
    `conversation and text is not.`
  );
}
