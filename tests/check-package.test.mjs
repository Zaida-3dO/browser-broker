import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The self-test for the packaging gate.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN OF THIS FILE MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `CLAUDE.md`: "any script used as a gate must ship a test proving it **fails
 * on a seeded violation**, not merely that it passes on clean input", and that
 * test "must also state plainly what a green result does, and does not, mean".
 *
 * **What it means:** every rule the gate enforces has been run against a tree
 * that violates it, and refused. Each seed is a **copy of the shipped tree
 * with one thing changed**, and the script under test is the shipped
 * `scripts/check-package.mjs` — not a local reimplementation of its rules.
 * That distinction is the repository's own hard-won one: a hollow test that
 * exercised an imitation would pass forever while the real gate rotted.
 *
 * **What it does not mean:** that an unpublishable package cannot be
 * published. The gate reads what `npm pack` reports and the manifest's own
 * fields; it cannot know whether the emitted JavaScript is *correct*, only
 * that it is JavaScript and that it is included. A green run says the four
 * rules catch the shapes they were taught.
 *
 * ── Why each seed copies the whole tree ─────────────────────────────────
 *
 * The gate runs `npm pack`, which runs `prepack`, which runs the build. It
 * is therefore a test of a real packing of a real tree, and there is no
 * cheaper honest way to seed it: mutating this repository in place would
 * leave a broken manifest behind if the process died mid-test.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Copy the tree, apply one mutation, run the shipped gate, return what
 * happened.
 *
 * `node_modules` is copied rather than reinstalled: the gate needs the
 * compiler and npm's own entry point, and an install per seed would make this
 * file cost minutes instead of seconds.
 */
function seeded(mutate) {
  const root = mkdtempSync(path.join(repo, '.check-package-seed-'));
  try {
    for (const entry of [
      'src',
      'scripts',
      'tests',
      'package.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'README.md',
      'RELEASES.md',
      'LICENSE',
      '.env.example',
      '.gitignore',
    ]) {
      cpSync(path.join(repo, entry), path.join(root, entry), { recursive: true });
    }
    cpSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), { recursive: true });

    const manifestPath = path.join(root, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    mutate(manifest, root);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}
`,
    );

    try {
      const out = execFileSync(
        process.execPath,
        [path.join(root, 'scripts', 'check-package.mjs')],
        { cwd: root, encoding: 'utf8' },
      );
      return { failed: false, output: out };
    } catch (error) {
      const shaped = error;
      return { failed: true, output: `${shaped.stdout ?? ''}${shaped.stderr ?? ''}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the gate PASSES on the tree as it stands — the control', () => {
  // Without this, every assertion below would also hold for a gate that
  // refused everything.
  const result = seeded(() => {});
  assert.equal(result.failed, false, `the unmutated tree was refused: ${result.output}`);
  assert.match(result.output, /Packaging check passed/u);
});

test('a bin naming a TYPESCRIPT SOURCE is refused', () => {
  // The defect the gate exists for: Node refuses to strip types under
  // node_modules, so this manifest installs cleanly and then cannot run.
  const result = seeded((manifest) => {
    manifest.bin.broker = 'src/bin/broker.ts';
  });
  assert.equal(result.failed, true, 'a .ts bin was accepted');
  assert.match(result.output, /bin-not-typescript/u);
});

test('a files field that OMITS THE BUILT TREE is refused', () => {
  // npm ships bin targets whatever files says, so the executables are present
  // and none of the modules they import are. The package installs and dies on
  // first run, which is why asserting the bins exist would not have caught it.
  const result = seeded((manifest) => {
    manifest.files = ['README.md', 'LICENSE'];
  });
  assert.equal(result.failed, true, 'a tarball without the built tree was accepted');
  assert.match(result.output, /bin-shipped/u);
});

test('a manifest that npm would REFUSE TO PUBLISH is refused here first', () => {
  const result = seeded((manifest) => {
    manifest.private = true;
    manifest.version = '0.0.0';
  });
  assert.equal(result.failed, true, 'an unpublishable manifest was accepted');
  assert.match(result.output, /publishable/u);
});

test('a tarball carrying the TESTS is refused', () => {
  const result = seeded((manifest) => {
    manifest.files = [...manifest.files, 'tests/'];
  });
  assert.equal(result.failed, true, 'a tarball carrying the test suite was accepted');
  assert.match(result.output, /tarball-lean/u);
});

test('a documented npx line naming NO EXECUTABLE is refused', () => {
  // The line that shipped: `npx browser-broker` cannot resolve, because no
  // bin is named for the package. It could only fail after publishing, which
  // is why a documentation check earns its place beside the packing ones.
  const result = seeded((_manifest, root) => {
    const readme = path.join(root, 'README.md');
    writeFileSync(
      readme,
      `${readFileSync(readme, 'utf8')}

    npx -y browser-broker
`,
    );
  });
  assert.equal(result.failed, true, 'an unresolvable npx line was accepted');
  assert.match(result.output, /npx-invocation/u);
});
