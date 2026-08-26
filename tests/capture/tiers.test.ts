import assert from 'node:assert/strict';
import test from 'node:test';

import { captureWarning } from '../../src/capture/accounting.ts';
import {
  CAPTURES_BEFORE_WARNING,
  DEFAULT_TIER,
  REASON_MAXIMUM_LENGTH,
  REASON_MINIMUM_LENGTH,
  TIER_LONGEST_EDGE,
  TIER_REQUIRING_REASON,
  estimateTokens,
} from '../../src/capture/tiers.ts';

/**
 * The numbers, and the promise the accounting keeps (`SCHEMA.md` §6.2, §6.4,
 * §7.3; `DECISIONS.md` §13d).
 */

test('the DEFAULT is the cheapest rung — the lever this milestone turns on', () => {
  // `MILESTONES.md` #31: "getting 'cheapest tier when nothing is asked for'
  // right matters more than any threshold downstream of it."
  assert.equal(DEFAULT_TIER, 'default');
  assert.equal(
    TIER_LONGEST_EDGE[DEFAULT_TIER],
    Math.min(...Object.values(TIER_LONGEST_EDGE)),
    'the default tier is not the cheapest rung',
  );
});

test('the three rungs are the numbers §6.2 publishes, which the study MEASURED and kept', () => {
  // Named individually rather than compared as a set: a test that only checked
  // "three distinct numbers" would stay green if two were swapped, and the
  // ordering is what the escalation ladder means.
  //
  // These were provisional and are not any more. #34's study swept a ladder
  // from 512 to 3200 against drawn fixtures of known geometry and against
  // rendered prose, and each rung delivers what its name claims: `max` returns
  // everything, `detail` recovers ordinary body copy, `default` keeps layout
  // and headings while damaging small body copy. The evidence table is in
  // `tiers.ts`; the measurements are in `ladder.test.ts` and
  // `ladder-rendered.test.ts`. **A change to any of these three numbers now
  // needs a measurement, not an argument.**
  assert.equal(TIER_LONGEST_EDGE.default, 1024);
  assert.equal(TIER_LONGEST_EDGE.detail, 1568);
  assert.equal(TIER_LONGEST_EDGE.max, 2576);
});

test('the top tier is the one that costs a reason', () => {
  assert.equal(TIER_REQUIRING_REASON, 'max');
  assert.equal(
    TIER_LONGEST_EDGE[TIER_REQUIRING_REASON],
    Math.max(...Object.values(TIER_LONGEST_EDGE)),
    'the tier requiring a reason is not the most expensive one',
  );
});

test('the reason bounds are §3.11 s 8 to 200 characters', () => {
  assert.equal(REASON_MINIMUM_LENGTH, 8);
  assert.equal(REASON_MAXIMUM_LENGTH, 200);
});

test('the token estimate is width times height over the fixed constant', () => {
  // §6.4: fixed by the version, not configurable. The signature takes
  // dimensions and nothing else, so there is no position an operator's value
  // could arrive in — this asserts the arithmetic that signature implements.
  assert.equal(estimateTokens(1024, 768), Math.ceil((1024 * 768) / 750));
  assert.equal(estimateTokens(1500, 1000), 2000);
});

test('the estimate rises with area and falls when a picture is shrunk', () => {
  assert.ok(estimateTokens(2576, 1449) > estimateTokens(1568, 882));
  assert.ok(estimateTokens(1568, 882) > estimateTokens(1024, 576));
});

test('the estimate is consistent with the measured tier costs it is calibrated against', () => {
  // `DECISIONS.md` records roughly 1,600 tokens at the 1568px rung and roughly
  // 4,800 at 2576px, on a 16:9 picture. Asserted as a loose band, because the
  // point is that the constant is in the right region rather than that any
  // published figure is exact.
  const at1568 = estimateTokens(1568, Math.round(1568 * (9 / 16)));
  const at2576 = estimateTokens(2576, Math.round(2576 * (9 / 16)));
  assert.ok(at1568 > 1000 && at1568 < 2400, `1568px estimated at ${String(at1568)}`);
  assert.ok(at2576 > 3500 && at2576 < 6500, `2576px estimated at ${String(at2576)}`);
});

test('escalating a rung costs materially more, which is why the default is the lever', () => {
  // What #34 measured on the cost side, stated as the property rather than as
  // three figures: the estimate is quadratic in the long edge, so a rung is not
  // a small increment and a caller landing on the cheapest one by default is
  // most of the saving.
  //
  // Asserted as ratios between the shipped rungs, so it survives a later study
  // moving them — it would only fail if the rungs stopped being materially
  // separated, which is the thing that would make the ladder pointless.
  const ratio = (of: number) => estimateTokens(of, Math.round(of * (9 / 16)));
  const atDefault = ratio(TIER_LONGEST_EDGE.default);
  const atDetail = ratio(TIER_LONGEST_EDGE.detail);
  const atMax = ratio(TIER_LONGEST_EDGE.max);

  assert.ok(
    atDetail > atDefault * 2,
    `the detail rung (${String(atDetail)}) is not materially dearer than the default (${String(atDefault)})`,
  );
  assert.ok(
    atMax > atDetail * 2,
    `the max rung (${String(atMax)}) is not materially dearer than the detail rung (${String(atDetail)})`,
  );
  // The whole ladder: the top rung costs several times the bottom one, which is
  // the number that makes "most callers never pass a parameter" the lever.
  assert.ok(atMax > atDefault * 5, `the ladder spans only ${(atMax / atDefault).toFixed(1)}x`);
});

// ── The accounting: a warning, never a refusal (#33) ───────────────────────

test('nothing is said at or below the threshold', () => {
  assert.equal(captureWarning(0), undefined);
  // The twelfth capture (eleven taken before) is still inside the threshold.
  assert.equal(captureWarning(CAPTURES_BEFORE_WARNING - 1), undefined);
});

test('the threshold is 12, and the warning starts on the one after it', () => {
  assert.equal(CAPTURES_BEFORE_WARNING, 12);
  // Dies if the comparison is moved by one in either direction, which is the
  // classic off-by-one and would otherwise be invisible.
  assert.equal(captureWarning(11), undefined, 'the warning fired on the twelfth capture');
  assert.ok(captureWarning(12), 'the warning did not fire on the thirteenth capture');
});

test('the warning fires on EVERY capture past the threshold', () => {
  for (const before of [12, 13, 20, 100, 1000]) {
    assert.ok(captureWarning(before), `no warning after ${String(before)} captures`);
  }
});

test('the warning names the cheaper alternative and says it is not a refusal', () => {
  const warning = captureWarning(50) ?? '';
  assert.match(warning, /snapshot/i);
  assert.match(warning, /evaluat/i);
  assert.match(warning, /never refused|always will be/i);
  // The re-ingestion argument is what makes the advice make sense, so it is
  // part of the message rather than something a caller has to already know.
  assert.match(warning, /every later turn|re-read/i);
});

test('the warning reports the count it fired at', () => {
  assert.match(captureWarning(19) ?? '', /\b20\b/);
});

test('there is NO shape here that could become a refusal', () => {
  // `capture.never_refused_for_cost` (§7.3) asserts an absence, and this is
  // that absence checked from the type side: the only thing this module can
  // return is a string or undefined. Nothing downstream has a boolean to
  // branch on, and there is no threshold argument an operator could raise
  // into a wall — the function takes one count and reads one module constant.
  for (const before of [0, 11, 12, 5000]) {
    const result = captureWarning(before);
    assert.ok(
      result === undefined || typeof result === 'string',
      `the accounting returned something other than advice: ${String(result)}`,
    );
  }
  assert.equal(captureWarning.length, 1, 'the accounting grew a second parameter');
});
