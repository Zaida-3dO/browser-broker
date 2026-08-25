import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findViolations } from '../scripts/check-capture-isolation.mjs';

/**
 * The self-test for `capture.no_diff_dependency` (`SCHEMA.md` §7.3).
 *
 * `CLAUDE.md`: *"Any script used as a gate … must ship a test proving it
 * **fails on a seeded violation**, not merely that it passes on clean input. A
 * gate only ever proven to pass has never been run against the thing it exists
 * to catch, and a check that cannot fail is a no-op with a green tick beside
 * it."*
 *
 * ══ WHAT A GREEN RUN OF THE GATE MEANS, PINNED HERE ══════════════════════
 *
 * Stated in the test as well as in the script, because the script's header is
 * prose and prose drifts. A green run means:
 *
 *   **No module reachable by a static import from the capture entry points
 *   lives under a diff-owned path, and no module in that closure uses a
 *   dynamic loader that could hide one.**
 *
 * It does **not** mean the capture code is independent of diffing in any
 * broader sense. Specifically, and each is asserted below as a known limit
 * rather than left for somebody to discover:
 *
 *   - it is not a data-flow analysis;
 *   - it cannot see a diff module at a path {@link DIFF_OWNED} does not list;
 *   - it says nothing about a file read by a constructed path string.
 *
 * The last three tests seed exactly those cases and assert the gate **passes**
 * — which looks perverse and is the point. A limit that is only written down
 * gets forgotten; a limit with a test beside it is a limit somebody has to
 * deliberately change.
 */

/** A tree with a capture pipeline and whatever else a case needs. */
function withTree(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-isolation-'));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const absolute = path.join(root, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, contents);
    }
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the real repository passes', () => {
  const findings = findViolations(path.resolve(import.meta.dirname, '..'));
  assert.deepEqual(
    findings,
    [],
    `the shipped capture code violates its own rule: ${findings.map((f) => `${f.file}: ${f.message}`).join('; ')}`,
  );
});

test('SEEDED VIOLATION: a capture module importing a diff module FAILS the gate', () => {
  withTree(
    {
      'src/capture/pipeline.ts': `import { compare } from '../diff/compare.ts';\nexport const x = compare;\n`,
      'src/diff/compare.ts': `export const compare = 1;\n`,
    },
    (root) => {
      const findings = findViolations(root);
      assert.equal(findings.length, 1, 'the gate did not fire on a direct import');
      assert.match(findings[0].message, /belongs to the diff feature/);
      assert.match(findings[0].message, /src\/diff\/compare\.ts/);
    },
  );
});

test('SEEDED VIOLATION: the gate follows the chain — an INDIRECT import fails too', () => {
  withTree(
    {
      // The interesting case, and the one a per-file grep of the capture
      // directory would miss entirely: the capture module is clean, and the
      // module it depends on is not.
      'src/capture/pipeline.ts': `import { help } from './helper.ts';\nexport const x = help;\n`,
      'src/capture/helper.ts': `import { compare } from '../comparison/regions.ts';\nexport const help = compare;\n`,
      'src/comparison/regions.ts': `export const compare = 1;\n`,
    },
    (root) => {
      const findings = findViolations(root);
      assert.equal(findings.length, 1, 'the gate did not follow the import chain');
      assert.match(findings[0].message, /src\/comparison\/regions\.ts/);
      // The path it took is reported, because "which of my imports pulled this
      // in" is the question a failure has to answer to be actionable.
      assert.match(findings[0].message, /pipeline\.ts -> .*helper\.ts/);
    },
  );
});

test('SEEDED VIOLATION: an aliased re-export does not evade the gate', () => {
  withTree(
    {
      // Nothing here contains the word "diff" or "compare" at the capture
      // module's own call site, which is exactly what a token search would
      // miss. The gate works from where the file LIVES.
      'src/capture/pipeline.ts': `import { thing } from './shim.ts';\nexport const x = thing;\n`,
      'src/capture/shim.ts': `export { anything as thing } from '../diff/internals.ts';\n`,
      'src/diff/internals.ts': `export const anything = 1;\n`,
    },
    (root) => {
      const findings = findViolations(root);
      assert.equal(findings.length, 1, 'an aliased re-export slipped past the gate');
      assert.match(findings[0].message, /src\/diff\/internals\.ts/);
    },
  );
});

test('SEEDED VIOLATION: a dynamic import inside the closure fails, because it defeats the walk', () => {
  withTree(
    {
      'src/capture/pipeline.ts': `const m = await import('../diff/compare.ts');\nexport const x = m;\n`,
      'src/diff/compare.ts': `export const compare = 1;\n`,
    },
    (root) => {
      const findings = findViolations(root);
      assert.ok(findings.length >= 1, 'a dynamic import was not caught');
      assert.ok(
        findings.some((finding) => /dynamic import/.test(finding.message)),
        `the dynamic loader was not named: ${findings.map((f) => f.message).join('; ')}`,
      );
    },
  );
});

test('SEEDED VIOLATION: require() inside the closure fails for the same reason', () => {
  withTree(
    {
      'src/capture/pipeline.ts': `const m = require('../diff/compare.ts');\nexport const x = m;\n`,
    },
    (root) => {
      const findings = findViolations(root);
      assert.ok(
        findings.some((finding) => /require\(\)/.test(finding.message)),
        'require() inside the capture closure was allowed',
      );
    },
  );
});

test('SEEDED VIOLATION: no capture entry point at all FAILS rather than passing vacuously', () => {
  withTree({ 'src/diff/compare.ts': 'export const compare = 1;\n' }, (root) => {
    const findings = findViolations(root);
    // A check that asserts over an empty set passes forever and silently —
    // named outright in `MILESTONES.md` as the failure to avoid. If the
    // pipeline is renamed and nobody updates the entry-point list, this is
    // what says so.
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /No capture entry point/);
  });
});

test('SEEDED VIOLATION: a diff-owned module named as a FILE is caught, not only a directory', () => {
  // M8 added three diff-owned modules that live beside the service layer
  // rather than under a directory of their own, so DIFF_OWNED carries file
  // entries as well as directory prefixes. **The two forms match by different
  // code paths** — a prefix test and an exact-equality test — so a directory
  // seed passes while the file form is broken, and the several seeds above are
  // all of the directory form.
  //
  // This is the one that fails if the file form stops being matched, which
  // would silently un-protect `src/service/comparison.ts` and its two
  // neighbours while every other assertion in this file stayed green.
  withTree(
    {
      'src/capture/pipeline.ts': `import { run } from '../service/comparison.ts';
export const x = run;
`,
      'src/service/comparison.ts': `export const run = 1;
`,
    },
    (root) => {
      const findings = findViolations(root);
      assert.equal(findings.length, 1);
      assert.match(findings[0].message, /src\/service\/comparison\.ts/);
      assert.match(findings[0].message, /belongs to the diff feature/);
    },
  );
});

test('a capture module may still import the service layer generally', () => {
  // The counterweight, and the reason the three modules are named individually
  // rather than as a `src/service/` prefix: the capture pipeline legitimately
  // sits beside the service layer, and a prefix entry would have made every
  // such import a violation — turning a real rule into one everybody works
  // around.
  withTree(
    {
      'src/capture/pipeline.ts': `import { tabs } from '../service/tabs.ts';
export const x = tabs;
`,
      'src/service/tabs.ts': `export const tabs = 1;
`,
      'src/service/comparison.ts': `export const run = 1;
`,
    },
    (root) => {
      assert.deepEqual(findViolations(root), []);
    },
  );
});

test('a clean tree passes, so the gate is not merely always-red', () => {
  withTree(
    {
      'src/capture/pipeline.ts': `import { store } from '../artifacts/store.ts';\nexport const x = store;\n`,
      'src/artifacts/store.ts': `export const store = 1;\n`,
      // The diff feature exists and is simply not reached.
      'src/diff/compare.ts': `export const compare = 1;\n`,
    },
    (root) => {
      assert.deepEqual(findViolations(root), []);
    },
  );
});

test('the REVERSE direction is allowed: a diff module may import capture', () => {
  withTree(
    {
      'src/capture/pipeline.ts': `export const take = 1;\n`,
      // M8 depends on this direction working. A gate that refused it would
      // block the milestone it exists to sequence.
      'src/diff/compare.ts': `import { take } from '../capture/pipeline.ts';\nexport const compare = take;\n`,
    },
    (root) => {
      assert.deepEqual(findViolations(root), []);
    },
  );
});

test('prose mentioning diffing does not fire the gate', () => {
  withTree(
    {
      // Every capture module in this repository has a header explaining that
      // it must not depend on diffing. A check that failed on the
      // documentation of its own rule teaches everyone to weaken the check.
      'src/capture/pipeline.ts':
        `// This module consults nothing belonging to the diff feature, and must\n` +
        `// never import from src/diff/ or src/comparison/. See SCHEMA.md 3.11.\n` +
        `// The word require appears here in prose and must not fire the gate.\n` +
        `export const take = 1;\n`,
    },
    (root) => {
      assert.deepEqual(findViolations(root), []);
    },
  );
});

// ── The declared limits, each with a test so it cannot be quietly forgotten ──

test('KNOWN LIMIT: a diff module at an unlisted path is invisible to the gate', () => {
  withTree(
    {
      'src/capture/pipeline.ts': `import { compare } from '../imagediff/compare.ts';\nexport const x = compare;\n`,
      // `src/imagediff/` is not in DIFF_OWNED, so this PASSES. That is the
      // maintenance cost stated in the script header: the M8 row creating the
      // diff modules must add their location to DIFF_OWNED.
      'src/imagediff/compare.ts': `export const compare = 1;\n`,
    },
    (root) => {
      assert.deepEqual(
        findViolations(root),
        [],
        'the gate now catches unlisted paths — if that is deliberate, update the script header and this test',
      );
    },
  );
});

test('KNOWN LIMIT: it is not a data-flow analysis', () => {
  withTree(
    {
      // A diff value reaching capture as an argument involves no import from
      // the capture side, so no static edge exists and the gate passes.
      'src/capture/pipeline.ts': `export function take(anything) {\n  return anything;\n}\n`,
      'src/diff/compare.ts': `import { take } from '../capture/pipeline.ts';\nexport const x = take(1);\n`,
    },
    (root) => {
      assert.deepEqual(findViolations(root), []);
    },
  );
});

test('KNOWN LIMIT: a file read by a constructed path is not module dependency', () => {
  withTree(
    {
      // The rule is about module dependency, which is what the sequencing
      // property is about. Reading bytes off disk by name is a different
      // claim and this gate does not make it.
      'src/capture/pipeline.ts': `import fs from 'node:fs';\nexport const x = () => fs.readFileSync('some/diff/output.json');\n`,
    },
    (root) => {
      assert.deepEqual(findViolations(root), []);
    },
  );
});
