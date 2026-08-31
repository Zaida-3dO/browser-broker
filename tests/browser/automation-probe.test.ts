import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import {
  REAL_DEPENDENCIES,
  resolveAutomationProbe,
  resolvePlaywrightCoreVersion,
} from '../../src/browser/automation-probe.ts';

/**
 * The doctor's automation probe, resolved for real.
 *
 * Runs on any machine, with no browser required: every case but the last
 * drives an injected `resolveExecutablePath` / `pathExists` pair rather than
 * the real `playwright-core` resolution, which is what lets "the binary is
 * genuinely absent" be exercised deterministically without depending on
 * whether the machine running this test has a browser installed.
 */
describe('resolveAutomationProbe', () => {
  it('reports present when the resolved path exists', () => {
    const probe = resolveAutomationProbe({
      resolveExecutablePath: () => '/fake/chrome',
      pathExists: (candidate) => candidate === '/fake/chrome',
      libraryVersion: '1.62.1',
    });

    assert.equal(probe.present, true);
    assert.equal(probe.version, '1.62.1');
  });

  it('reports absent — not unknown — when the resolved path does not exist', () => {
    // This is the case exit code 11 depends on. If this ever reports
    // `present: undefined` (or is dropped so the default `unknown` shows
    // through), the doctor would read a genuinely missing browser as "nobody
    // asked" rather than as a failure, and exit 11 would go back to being
    // unreachable exactly as it was before this row.
    const probe = resolveAutomationProbe({
      resolveExecutablePath: () => 'unresolved-browser-binary',
      pathExists: () => false,
    });

    assert.equal(probe.present, false);
    assert.match(probe.detail ?? '', /unresolved-browser-binary/);
  });

  it('reports absent, with the error message, if resolving the path itself throws', () => {
    // A caller asking "is the automation tool present" is the last place
    // that question should go unanswered because of an unexpected library
    // error — it should not propagate and turn `broker doctor` itself into
    // the failure.
    const probe = resolveAutomationProbe({
      resolveExecutablePath: () => {
        throw new Error('driver bundle is corrupt');
      },
      pathExists: () => true,
    });

    assert.equal(probe.present, false);
    assert.match(probe.detail ?? '', /driver bundle is corrupt/);
  });

  it('uses the real playwright-core resolution when no dependencies are supplied', () => {
    // Exercises the actual default path end to end, asserting only that it
    // answers rather than what the answer is — a checkout with a browser
    // binary fetched reports `true`, one without reports `false`, and both
    // are legitimate states for a real environment to be in. The point of
    // this specific test is that the default wiring reaches the real
    // library at all, not what any one machine happens to have installed.
    const probe = resolveAutomationProbe();

    assert.equal(typeof probe.present, 'boolean');
  });

  it('resolves playwright-core’s installed version from its own package.json', () => {
    // What `REAL_DEPENDENCIES.libraryVersion` is set from. Asserted directly
    // against `resolvePlaywrightCoreVersion()` rather than through
    // `resolveAutomationProbe()`'s `present: true` branch, because that
    // branch also requires `pathExists` to hold — which needs a browser
    // binary actually fetched, and would make this test pass or fail
    // depending on whether the machine running it has one. Resolving the
    // *library's own* version has no such dependency, so it must hold on
    // every machine, browser or not — including this repo's CI, which has
    // none fetched.
    const packageJson: { version: string } = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '../../node_modules/playwright-core/package.json'),
        'utf8',
      ),
    ) as { version: string };

    assert.equal(resolvePlaywrightCoreVersion(), packageJson.version);
  });

  it('wires libraryVersion into REAL_DEPENDENCIES, so the default resolution path can echo it', () => {
    // `resolvePlaywrightCoreVersion()` working in isolation (the test above)
    // does not, on its own, prove the real dependency object the default
    // resolution uses actually sets `libraryVersion` from it — those two
    // could regress independently of each other, which is exactly the
    // original defect this row exists for: the field was documented as
    // "echoed on success" while `REAL_DEPENDENCIES` never set it at all.
    // Asserted directly against the exported constant rather than through
    // `resolveAutomationProbe()`'s `present: true` branch, for the same
    // browser-independence reason as the test above.
    assert.equal(REAL_DEPENDENCIES.libraryVersion, resolvePlaywrightCoreVersion());
  });

  it('echoes libraryVersion on the present branch when a dependency injects it', () => {
    // Proves `resolveAutomationProbe` actually plumbs
    // `dependencies.libraryVersion` into the reported `version` on the
    // `present: true` path itself, using an injected path pair so this
    // holds regardless of whether this machine has a real browser binary
    // fetched.
    const probe = resolveAutomationProbe({
      resolveExecutablePath: () => '/fake/chrome',
      pathExists: (candidate) => candidate === '/fake/chrome',
      libraryVersion: resolvePlaywrightCoreVersion(),
    });

    assert.equal(probe.present, true);
    assert.equal(probe.version, resolvePlaywrightCoreVersion());
  });
});
