import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ArtifactStore } from '../../src/artifacts/store.ts';
import { FakeBrowserDriver, type FakeCaptureOptions } from '../../src/browser/fake.ts';
import type { BrowserSession, TabHandle } from '../../src/browser/driver.ts';
import { BrokerError } from '../../src/errors.ts';
import { decodePng, solidPng } from '../../src/capture/image.ts';
import {
  takeCapture,
  type CaptureRequestOptions,
  type CaptureResult,
} from '../../src/capture/pipeline.ts';
import { CAPTURES_BEFORE_WARNING, TIER_LONGEST_EDGE } from '../../src/capture/tiers.ts';

/**
 * The capture pipeline (`MILESTONES.md` #31, #32, #33; `SCHEMA.md` §3.11).
 *
 * **Every rejection test here asserts the physical side-effect**, per
 * `CLAUDE.md`: a refusal that returned after the shutter fired is worse than
 * no refusal, so each one asserts the fake driver's call log is empty for the
 * operation that must not have happened — not merely that an error was thrown.
 */

interface Rig {
  readonly driver: FakeBrowserDriver;
  readonly session: BrowserSession;
  readonly tab: TabHandle;
  readonly artifacts: ArtifactStore;
  readonly root: string;
  readonly capture: (
    options?: CaptureRequestOptions,
    capturesTakenBefore?: number,
  ) => Promise<CaptureResult>;
}

async function withRig(
  fn: (rig: Rig) => Promise<void>,
  captureOptions?: FakeCaptureOptions,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-capture-'));
  try {
    const driver = new FakeBrowserDriver({ capture: captureOptions });
    const session = await driver.coldStart({
      browser: 'regular',
      profileDirectory: path.join(root, 'profile'),
      mode: 'headed',
    });
    const tab = await session.openTab();
    const artifacts = new ArtifactStore(root);
    // Cleared so the setup above is not mistaken for the pipeline's own calls.
    driver.clearCalls();

    await fn({
      driver,
      session,
      tab,
      artifacts,
      root,
      capture: (options = {}, capturesTakenBefore = 0) =>
        takeCapture(
          {
            tabs: session,
            artifacts,
            // Pinned so a file name is an assertable string rather than
            // whatever the clock said.
            now: () => new Date('2026-01-02T03:04:05.000Z'),
            newId: () => 'cafe1234',
          },
          'claim1',
          tab,
          options,
          capturesTakenBefore,
        ),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── The default tier: the lever (#31) ──────────────────────────────────────

test('passing NOTHING gets the cheapest tier', async () => {
  await withRig(
    async (rig) => {
      const result = await rig.capture();
      // The single most consequential assertion in this milestone. Dies if
      // `DEFAULT_TIER` is changed to `detail`, or if the `?? DEFAULT_TIER`
      // fallback is dropped for a different rung.
      assert.equal(result.tier, 'default');
      assert.equal(
        Math.max(result.width, result.height),
        TIER_LONGEST_EDGE.default,
        'the picture was not shrunk to the default rung',
      );
    },
    { width: 3000, height: 2000 },
  );
});

test('the tier decides the long edge, and each rung is distinct', async () => {
  // Run against a source larger than every rung so each shrink is real.
  const source = { width: 4000, height: 3000 };
  const longest: Record<string, number> = {};
  for (const [name, options] of [
    ['default', {}],
    ['detail', { tier: 'detail' as const }],
    ['max', { tier: 'max' as const, reason: 'checking the small print on a dense table' }],
  ] as const) {
    await withRig(async (rig) => {
      const result = await rig.capture(options);
      longest[name] = Math.max(result.width, result.height);
    }, source);
  }

  // Dies if any rung's number changes, and — more usefully — dies if two rungs
  // are made equal, which is how a "simplification" would quietly delete the
  // escalation ladder while leaving the parameter in place.
  assert.equal(longest['default'], TIER_LONGEST_EDGE.default);
  assert.equal(longest['detail'], TIER_LONGEST_EDGE.detail);
  assert.equal(longest['max'], TIER_LONGEST_EDGE.max);
  assert.ok(
    (longest['default'] ?? 0) < (longest['detail'] ?? 0) &&
      (longest['detail'] ?? 0) < (longest['max'] ?? 0),
    'the rungs are not strictly increasing',
  );
});

test('the aspect ratio survives the shrink', async () => {
  await withRig(
    async (rig) => {
      const result = await rig.capture();
      // 2000x1000 to a 1024 long edge.
      assert.equal(result.width, 1024);
      assert.equal(result.height, 512);
    },
    { width: 2000, height: 1000 },
  );
});

test('a picture already inside the rung is NOT upscaled, and width equals source width', async () => {
  await withRig(
    async (rig) => {
      const result = await rig.capture();
      assert.equal(result.width, 800);
      assert.equal(result.height, 600);
      // §1.7: equal dimensions is how "was this downscaled" is answered without
      // a flag that could disagree with the numbers beside it.
      assert.equal(result.width, result.sourceWidth);
      assert.equal(result.height, result.sourceHeight);
    },
    { width: 800, height: 600 },
  );
});

test('what is written to disk really is at the reported dimensions', async () => {
  await withRig(
    async (rig) => {
      const result = await rig.capture();
      // Decoding the file is what makes the reported numbers a claim about the
      // image rather than about a variable. A pipeline that reported the shrunk
      // size and wrote the original bytes passes every other test here.
      const written = decodePng(fs.readFileSync(rig.artifacts.resolve(result.path)));
      assert.equal(written.width, result.width);
      assert.equal(written.height, result.height);
      assert.equal(written.width, 1024);
    },
    { width: 2048, height: 1024 },
  );
});

// ── What comes back: a path, never the image (#31) ─────────────────────────

test('the result is a path and its dimensions — never the image', async () => {
  await withRig(async (rig) => {
    const result = await rig.capture();
    assert.equal(typeof result.path, 'string');
    assert.ok(result.bytes > 0);

    // The cost argument in one assertion: no field on the response carries
    // pixels. Walked over the values rather than asserted per key, so a field
    // ADDED later that carries bytes fails this without anyone remembering to
    // extend the list.
    for (const [key, value] of Object.entries(result)) {
      assert.ok(
        !(value instanceof Uint8Array) && !Buffer.isBuffer(value),
        `${key} carries image bytes into the response`,
      );
    }
  });
});

test('the returned path is relative, and resolves under the artifact root', async () => {
  await withRig(async (rig) => {
    const result = await rig.capture();
    assert.ok(!path.isAbsolute(result.path), `an absolute path was returned: ${result.path}`);
    assert.ok(!result.path.includes(rig.root), 'the root leaked into the returned path');
    assert.ok(fs.existsSync(rig.artifacts.resolve(result.path)));
  });
});

test('the file lands under the lease, in images/', async () => {
  await withRig(async (rig) => {
    const result = await rig.capture();
    assert.match(result.path, /^claims\/claim1\/images\//);
  });
});

test('the file name derives its slug from the page address, with the query stripped', async () => {
  await withRig(
    async (rig) => {
      const result = await rig.capture({ label: 'collapsed nav' });
      const name = path.basename(result.path);
      // The end-to-end form of the rule: this dies if the pipeline hands the raw
      // address to the namer, or if the strip is dropped in `names.ts`. It is
      // the assertion the brief names as mutation-critical.
      assert.ok(!name.includes('sessiontoken'), `a token reached the file name: ${name}`);
      assert.ok(!name.includes('searchterm'), `a search term reached the file name: ${name}`);
      assert.equal(name, 'example-com-checkout-collapsed-nav-390-20260102030405-cafe1234.png');
    },
    {
      url: 'https://example.com/checkout?q=searchterm&s=sessiontoken',
      viewportWidth: 390,
      width: 390,
      height: 800,
    },
  );
});

// ── Settling before every shutter (#31, §3.11) ─────────────────────────────

test('the page is settled BEFORE every shutter, in that order', async () => {
  await withRig(async (rig) => {
    await rig.capture();

    const names = rig.driver.calls.map((call) => call.name);
    const settled = names.indexOf('settlePage');
    const shot = names.indexOf('capture');
    assert.notEqual(settled, -1, 'the page was never settled');
    assert.notEqual(shot, -1, 'no picture was taken');
    // Dies if the settle call is removed, AND dies if it is moved after the
    // shutter — the second is the mutation an ordering-blind test misses, and
    // it is the one that matters: a mask or a settle applied after the shutter
    // was, for one moment, not applied.
    assert.ok(
      settled < shot,
      `settlePage ran at ${String(settled)}, after capture at ${String(shot)}`,
    );
  });
});

test('settling happens on EVERY capture, not once per session', async () => {
  await withRig(async (rig) => {
    await rig.capture();
    await rig.capture();
    await rig.capture();
    // Dies if settling is hoisted to a per-session or memoised call, which is
    // the plausible "optimisation": the same page produces different pixels
    // run to run without it.
    assert.equal(rig.driver.callsOf('settlePage').length, 3);
    assert.equal(rig.driver.callsOf('capture').length, 3);
  });
});

// ── The mask (#31) ─────────────────────────────────────────────────────────

test('a mask is passed to the driver, so it is applied BEFORE the pixels exist', async () => {
  await withRig(async (rig) => {
    const mask = [{ x: 10, y: 20, width: 30, height: 40 }];
    await rig.capture({ mask });

    const call = rig.driver.callsOf('capture')[0];
    assert.ok(call);
    // The rectangles themselves, not merely that something was passed: "a mask
    // reached the driver" and "THIS mask reached the driver" are different
    // claims, and only the second dies when the mask is dropped on the way
    // through.
    assert.deepEqual(call.detail?.['mask'], mask);
  });
});

// ── Full page and selector (#31) ───────────────────────────────────────────

test('full page is OFF unless asked for, and the kind records which happened', async () => {
  await withRig(async (rig) => {
    const plain = await rig.capture();
    assert.equal(rig.driver.callsOf('capture')[0]?.detail?.['fullPage'], false);
    assert.equal(plain.telemetry.kind, 'viewport');

    rig.driver.clearCalls();
    const whole = await rig.capture({ fullPage: true });
    assert.equal(rig.driver.callsOf('capture')[0]?.detail?.['fullPage'], true);
    assert.equal(whole.telemetry.kind, 'full_page');
  });
});

test('a selector makes it an element capture, and reaches the driver', async () => {
  await withRig(async (rig) => {
    const result = await rig.capture({ selector: 'main > .summary' });
    assert.equal(result.telemetry.kind, 'element');
    assert.equal(result.telemetry.selector, 'main > .summary');
    assert.equal(rig.driver.callsOf('capture')[0]?.detail?.['selector'], 'main > .summary');
  });
});

// ── The three argument refusals, and NOTHING ELSE (#31, §3.11) ─────────────

test('the top tier without a reason is refused — and NO PICTURE IS TAKEN', async () => {
  await withRig(async (rig) => {
    await assert.rejects(
      () => rig.capture({ tier: 'max' }),
      (error: unknown) => error instanceof BrokerError && error.rule === 'capture.reason_required',
    );
    // The side-effect half. A refusal issued after the shutter would report a
    // refusal that did not happen, and everything downstream would believe it.
    assert.equal(rig.driver.callsOf('capture').length, 0, 'the shutter fired anyway');
    assert.equal(rig.driver.callsOf('settlePage').length, 0, 'the page was settled anyway');
    assert.equal(rig.driver.calls.length, 0, 'the driver was touched at all');
  });
});

test('a reason shorter than the minimum is refused', async () => {
  await withRig(async (rig) => {
    await assert.rejects(
      () => rig.capture({ tier: 'max', reason: 'need' }),
      (error: unknown) => error instanceof BrokerError && error.rule === 'capture.reason_required',
    );
    assert.equal(rig.driver.calls.length, 0);
  });
});

test('a reason longer than the maximum is refused', async () => {
  await withRig(async (rig) => {
    await assert.rejects(
      () => rig.capture({ tier: 'max', reason: 'x'.repeat(201) }),
      (error: unknown) => error instanceof BrokerError && error.rule === 'capture.reason_required',
    );
    assert.equal(rig.driver.calls.length, 0);
  });
});

test('a whitespace-only reason does not satisfy the requirement', async () => {
  await withRig(async (rig) => {
    // Dies if the trim is dropped: eight spaces would otherwise pass a bare
    // length check, and the field's whole value is the record it leaves.
    await assert.rejects(
      () => rig.capture({ tier: 'max', reason: '         ' }),
      (error: unknown) => error instanceof BrokerError && error.rule === 'capture.reason_required',
    );
    assert.equal(rig.driver.calls.length, 0);
  });
});

test('a selector combined with a full page is refused, and nothing is taken', async () => {
  await withRig(async (rig) => {
    await assert.rejects(
      () => rig.capture({ fullPage: true, selector: '.thing' }),
      (error: unknown) =>
        error instanceof BrokerError && error.rule === 'capture.arguments_consistent',
    );
    assert.equal(rig.driver.calls.length, 0, 'the driver was touched despite the refusal');
  });
});

test('the reason is free text — any prose of a workable length is accepted', async () => {
  await withRig(async (rig) => {
    // #31 is explicit that this must not quietly become an enum. Three
    // unrelated sentences, none of which is a category anybody enumerated:
    // dies the moment the field is checked against a fixed set.
    for (const reason of [
      'the antialiasing on the chart labels is what I need to judge',
      'comparing letter spacing between two candidate typefaces',
      'the client says the logo looks wrong and I cannot see it at all',
    ]) {
      const result = await rig.capture({ tier: 'max', reason });
      assert.equal(result.telemetry.reason, reason);
    }
  });
});

// ── NOTHING IS EVER REFUSED FOR COST (#33, §7.3) ───────────────────────────

test('a capture far past the threshold is still SERVED, with a file on disk', async () => {
  await withRig(async (rig) => {
    const result = await rig.capture({}, 500);
    // The promise `capture.never_refused_for_cost` exists to keep. A refusal
    // here would be the single change that makes the whole policy conditional.
    assert.ok(fs.existsSync(rig.artifacts.resolve(result.path)), 'no file was written');
    assert.ok(result.bytes > 0);
    assert.equal(rig.driver.callsOf('capture').length, 1);
  });
});

test('the warning fires past the threshold, on EVERY capture and not just the first', async () => {
  await withRig(async (rig) => {
    // At the threshold exactly: nothing yet.
    const at = await rig.capture({}, CAPTURES_BEFORE_WARNING - 1);
    assert.equal(at.warning, undefined, 'the warning fired at the threshold rather than past it');
    assert.equal(at.telemetry.warned, false);

    // Past it: three consecutive captures all carry one. Dies if the warning
    // is made once-per-lease, which is the plausible "less noisy" change and
    // is exactly what §3.11 forbids — a warning that appears once has scrolled
    // away by the time it matters.
    for (const before of [
      CAPTURES_BEFORE_WARNING,
      CAPTURES_BEFORE_WARNING + 1,
      CAPTURES_BEFORE_WARNING + 5,
    ]) {
      const past = await rig.capture({}, before);
      assert.ok(past.warning, `no warning at ${String(before)} captures already taken`);
      assert.equal(past.telemetry.warned, true);
    }
  });
});

test('the warning NAMES the cheaper alternative — the message is the mechanism', async () => {
  await withRig(async (rig) => {
    const result = await rig.capture({}, CAPTURES_BEFORE_WARNING + 1);
    const warning = result.warning ?? '';
    // #33: a bare "you have taken a lot of captures" teaches a caller to ask
    // for a bigger budget. Dies if the message is shortened to a count, which
    // a test asserting only `warning !== undefined` would sail straight past.
    assert.match(warning, /snapshot/i, 'the warning does not name the snapshot');
    assert.match(warning, /evaluat/i, 'the warning does not name the evaluation');
    assert.match(
      warning,
      /never refused|always will be/i,
      'the warning does not say it is not a refusal',
    );
  });
});

// ── Telling the caller how to escalate (#31, §3.11) ────────────────────────

test('a default-tier capture is told HOW to escalate: the fields, and that max needs a reason', async () => {
  await withRig(async (rig) => {
    const result = await rig.capture();
    const guidance = result.escalation ?? '';
    // §3.11 asks for three specific things, so three specific assertions.
    // "Higher tiers exist" would pass a vaguer test and help nobody.
    assert.match(guidance, /\btier\b/, 'the guidance does not name the field to pass');
    assert.match(guidance, /detail/, 'the guidance does not name the detail tier');
    assert.match(guidance, /max/, 'the guidance does not name the max tier');
    assert.match(guidance, /reason/, 'the guidance does not mention the required reason');
  });
});

test('the escalation guidance quotes the rungs it was built from', async () => {
  await withRig(async (rig) => {
    const guidance = (await rig.capture()).escalation ?? '';
    // Composed from the constants rather than written out, so the guidance
    // always quotes the rungs the pipeline shrinks to. Dies if anyone
    // hard-codes the numbers into the sentence instead.
    assert.ok(guidance.includes(String(TIER_LONGEST_EDGE.detail)));
    assert.ok(guidance.includes(String(TIER_LONGEST_EDGE.max)));
  });
});

test('an escalated capture is NOT given the guidance — it is for the caller who has not chosen', async () => {
  await withRig(async (rig) => {
    const detail = await rig.capture({ tier: 'detail' });
    assert.equal(detail.escalation, undefined);
    const max = await rig.capture({ tier: 'max', reason: 'reading dense tabular figures' });
    assert.equal(max.escalation, undefined);
  });
});

// ── Telemetry (#32) ────────────────────────────────────────────────────────

test('telemetry carries every column §1.7 needs, with the source dimensions kept', async () => {
  await withRig(
    async (rig) => {
      const result = await rig.capture({ tier: 'detail', label: 'wide' });
      const telemetry = result.telemetry;

      assert.equal(telemetry.sourceWidth, 3000);
      assert.equal(telemetry.sourceHeight, 1500);
      assert.equal(telemetry.width, TIER_LONGEST_EDGE.detail);
      assert.equal(telemetry.tier, 'detail');
      assert.equal(telemetry.viewportWidth, 1440);
      assert.equal(telemetry.url, 'https://example.com/pricing');
      assert.ok(telemetry.bytes > 0);
      assert.ok(!path.isAbsolute(telemetry.path));
      // "Downscaled from" is the pair of source columns rather than a flag, so
      // there is nothing that can disagree with the numbers beside it.
      assert.notEqual(telemetry.width, telemetry.sourceWidth);
    },
    { width: 3000, height: 1500, viewportWidth: 1440, url: 'https://example.com/pricing' },
  );
});

test('the recorded url keeps its query — only the FILE NAME strips it', async () => {
  await withRig(
    async (rig) => {
      const result = await rig.capture();
      // §1.7 records the address on the row; §1.7a strips it from the name,
      // because a name travels further than a column does. Conflating the two
      // rules in either direction is a real mistake and this pins both halves.
      assert.ok(result.telemetry.url.includes('?'), 'the recorded address lost its query');
      assert.ok(!path.basename(result.path).includes('sessiontoken'));
    },
    { url: 'https://example.com/a?s=sessiontoken' },
  );
});

test('a reason is recorded ONLY on the tier that requires one', async () => {
  await withRig(async (rig) => {
    // A reason passed with a lower tier is not recorded: it would put noise
    // into the one column the resolution study reads.
    const detail = await rig.capture({ tier: 'detail', reason: 'this was not required' });
    assert.equal(detail.telemetry.reason, undefined);
    const max = await rig.capture({ tier: 'max', reason: 'judging kerning on the headline' });
    assert.equal(max.telemetry.reason, 'judging kerning on the headline');
  });
});

test('the estimated token cost is computed from the WRITTEN dimensions, not the source', async () => {
  await withRig(
    async (rig) => {
      const result = await rig.capture();
      // The whole point of downscaling is that the estimate falls. Dies if the
      // estimate is computed from `sourceWidth`/`sourceHeight`, which is the
      // plausible mistake and would report a saving that did not happen.
      assert.equal(result.estimatedTokens, Math.ceil((result.width * result.height) / 750));
      const fromSource = Math.ceil((result.sourceWidth * result.sourceHeight) / 750);
      assert.ok(
        result.estimatedTokens < fromSource,
        'the estimate did not fall when the picture was shrunk',
      );
    },
    { width: 3000, height: 2000 },
  );
});

test('the capture count reported is the one including this capture', async () => {
  await withRig(async (rig) => {
    assert.equal((await rig.capture({}, 0)).capturesThisLease, 1);
    assert.equal((await rig.capture({}, 7)).capturesThisLease, 8);
  });
});

// ── The driver failing (#31) ───────────────────────────────────────────────

test('a shutter that fails writes no file', async () => {
  await withRig(async (rig) => {
    rig.driver.failNext('capture');
    await assert.rejects(() => rig.capture());
    const images = path.join(rig.root, 'claims', 'claim1', 'images');
    assert.ok(
      !fs.existsSync(images) || fs.readdirSync(images).length === 0,
      'a file was written for a capture that never happened',
    );
  });
});

test('a settle that fails stops the shutter', async () => {
  await withRig(async (rig) => {
    rig.driver.failNext('settlePage');
    await assert.rejects(() => rig.capture());
    // Dies if the settle's rejection is swallowed — a capture that proceeded
    // on an unsettled page is precisely the pixels-differ-run-to-run failure
    // §3.11 calls the highest-value line in the feature.
    assert.equal(rig.driver.callsOf('capture').length, 0, 'the shutter fired on an unsettled page');
  });
});

// ── Two captures do not collide ────────────────────────────────────────────

test('two captures of the same page in the same second get different files', async () => {
  await withRig(async (rig) => {
    let counter = 0;
    const take = () =>
      takeCapture(
        {
          tabs: rig.session,
          artifacts: rig.artifacts,
          now: () => new Date('2026-01-02T03:04:05.000Z'),
          newId: () => `id${String(++counter)}`,
        },
        'claim1',
        rig.tab,
        {},
        0,
      );
    const one = await take();
    const two = await take();
    // The identifier is the fifth part of the name precisely so that
    // uniqueness needs no coordination.
    assert.notEqual(one.path, two.path);
    assert.ok(fs.existsSync(rig.artifacts.resolve(one.path)));
    assert.ok(fs.existsSync(rig.artifacts.resolve(two.path)));
  });
});

test('the written file is a real, decodable image', async () => {
  await withRig(
    async (rig) => {
      const result = await rig.capture();
      const bytes = fs.readFileSync(rig.artifacts.resolve(result.path));
      const decoded = decodePng(bytes);
      assert.equal(decoded.pixels.length, decoded.width * decoded.height * 4);
      // And it is the picture the driver handed over, not a blank one: the fake
      // was given a distinctly coloured image.
      assert.equal(decoded.pixels[0], 12);
    },
    { width: 100, height: 100, image: solidPng(100, 100, [12, 34, 56, 255]) },
  );
});
