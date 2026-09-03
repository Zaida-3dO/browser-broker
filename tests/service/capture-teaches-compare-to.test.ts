import assert from 'node:assert/strict';
import test from 'node:test';

import type { BrowserSession, TabHandle } from '../../src/browser/driver.ts';
import { type RasterImage, encodePng } from '../../src/diff/image.ts';
import { claimInput, withBroker, type BrokerFixture } from '../helpers/broker.ts';
import { WHITE, filled } from '../helpers/images.ts';

/**
 * The hint `browser_capture` teaches on its own response (`compareHint`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE EXISTS TO CATCH, STATED AS THE MEASUREMENT THAT MOTIVATES IT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * An audit of 18 hours of transcripts found `compare_to` used once, ever,
 * against 80 `Read` calls that opened a screenshot back into context instead
 * — roughly 90,000 tokens per `Read`, against roughly 350 tokens for a
 * `compare_to` diff. `compare_to` was reachable the whole time: every earlier
 * capture already returns the `captureId` it would need. Nothing pointed a
 * caller at it, at the moment it had the id in hand.
 *
 * So the fix is not new capability — `compare_to` already existed and is
 * tested end-to-end in `capture-comparison.test.ts` — it is that the response
 * a caller is already holding now says what to do with the id it is already
 * holding. This file is what proves that sentence actually rides along,
 * naming the id it names, on every capture that wrote a picture.
 */

const CAPTURE_WIDTH = 400;
const CAPTURE_HEIGHT = 100;

/** A browser that serves one image, for a fixture that only needs one capture. */
function singleImageSession(image: RasterImage): BrowserSession {
  return {
    openTab: async () => await Promise.resolve({ driverTabId: 'driver-tab-hint-1', handle: {} }),
    closeTab: async () => await Promise.resolve(),
    navigate: async () => await Promise.resolve({ url: 'https://example.com/', title: 'A page' }),
    act: async () => await Promise.resolve({ ok: true }),
    read: async (_tab: TabHandle, artifacts: readonly string[]) =>
      await Promise.resolve(
        artifacts.map((artifact) => ({ artifact, path: 'a/path', bytes: 1, truncated: false })),
      ),
    cookies: async () => await Promise.resolve([]),
    seedStorage: async () => await Promise.resolve(),
    evaluate: async () => await Promise.resolve({ value: null, bytes: 4 }),
    settlePage: async () => await Promise.resolve(),
    capture: async () =>
      await Promise.resolve({
        image: encodePng(image),
        width: image.width,
        height: image.height,
        viewportWidth: image.width,
        url: 'https://example.com/',
      }),
  } as unknown as BrowserSession;
}

async function grantedLease(fixture: BrokerFixture): Promise<{ key: string; tabId: string }> {
  const granted = await fixture.broker.claim(claimInput());
  assert.equal(granted.outcome, 'granted', 'the fixture needs a granted lease');
  if (granted.outcome !== 'granted') throw new Error('unreachable');
  return { key: granted.key, tabId: granted.tabId };
}

test('a capture that wrote a picture teaches compare_to, naming its own captureId', async () => {
  const image = filled(CAPTURE_WIDTH, CAPTURE_HEIGHT, WHITE);

  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const session = singleImageSession(image);

    const result = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => session,
      artifacts: fixture.artifacts,
    });

    assert.ok(result.capture !== undefined, 'the capture must have been written');

    // The assertion that fails if the hint is deleted: the field must exist,
    // must mention the argument by its real spelling, and must name the exact
    // id a caller would need to pass — not a placeholder, not a different
    // capture's id.
    assert.equal(typeof result.capture.compareHint, 'string');
    assert.match(
      result.capture.compareHint,
      /compare_to/,
      'the hint must name the argument by its real spelling, not paraphrase it',
    );
    assert.ok(
      result.capture.compareHint.includes(result.capture.captureId),
      'the hint must carry this exact capture’s own id, not a placeholder',
    );
  });
});

test('the hint still appears on a capture that itself used compare_to', async () => {
  // The second capture in a pair is *also* a future compare_to target for
  // whatever comes after it — so the hint is not something only a first
  // capture gets. Proved directly rather than assumed: it would be an easy
  // mistake to gate the hint on "no compareTo was supplied".
  const image = filled(CAPTURE_WIDTH, CAPTURE_HEIGHT, WHITE);

  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);
    const session = singleImageSession(image);

    const first = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => session,
      artifacts: fixture.artifacts,
    });
    assert.ok(first.capture !== undefined);

    const second = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      session: () => session,
      artifacts: fixture.artifacts,
      compareTo: first.capture.captureId,
    });

    assert.ok(second.capture !== undefined, 'the second capture must also have been written');
    assert.match(second.capture.compareHint, /compare_to/);
    assert.ok(
      second.capture.compareHint.includes(second.capture.captureId),
      'the second capture’s hint must name its own id, not the id it was compared against',
    );
  });
});

test('no picture, no hint: a capture with nowhere to write leaves the field absent, not empty', async () => {
  // Mirrors the existing rule on `capture` itself (`CaptureResult.capture` is
  // absent, not a path to a file that is not there, when nothing was
  // written). The hint lives inside that same optional object, so it must
  // disappear with it rather than surviving as a dangling string.
  await withBroker(async (fixture) => {
    const lease = await grantedLease(fixture);

    const result = await fixture.broker.capture({
      key: lease.key,
      tabId: lease.tabId,
      // No `session` and no `artifacts`: nothing was driven, so nothing was
      // written, and there is no id for a hint to name.
    });

    assert.equal(result.capture, undefined, 'no artifact store means no picture and no hint');
  });
});
