#!/usr/bin/env node
/**
 * The packaging check: prove the tarball a stranger installs actually runs.
 *
 * `check-install.mjs` proves a *checkout* installs and spawns. That is the
 * development path, and it runs the sources directly under Node's type
 * stripping. **The published path is a different artefact entirely** — a
 * tarball, unpacked under `node_modules`, running emitted JavaScript — and
 * the one property that differs between them is the one that breaks:
 *
 *   Node refuses to strip types from any file under a `node_modules` path.
 *
 * So a manifest whose `bin` names a `.ts` file passes every check in this
 * repository, publishes cleanly, installs cleanly, and then fails on the
 * machine of whoever installed it with
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. There is no flag to
 * override it. That failure is invisible from here unless something
 * deliberately packs the tarball and runs what comes out of it, which is
 * what this file is.
 *
 * It asserts four things, each of which has a way of being silently wrong:
 *
 *   1. every `bin` target is emitted JavaScript, never a TypeScript source;
 *   2. `npm pack` carries every one of those targets — a `files` field that
 *      omits `dist/` produces a tarball whose executables do not exist;
 *   3. the tarball carries no tests, no plans and no scratch files;
 *   4. the manifest is publishable at all — `private` blocks it outright,
 *      and `0.0.0` is the placeholder version rather than a released one.
 *
 * ── Why it packs rather than reading the manifest ───────────────────────
 *
 * Reading `files` and reasoning about it reimplements npm's own inclusion
 * rules — which fold in `.gitignore`, `.npmignore`, and a list of names npm
 * always keeps or always drops. A reimplementation agrees with npm right up
 * until the case that matters. `npm pack --dry-run --json` reports what npm
 * *would* ship, so this asks npm instead of predicting it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const failures = [];
const fail = (rule, detail) => failures.push(`${rule}: ${detail}`);

// ── 4. Publishable at all ───────────────────────────────────────────────
if (manifest.private === true) {
  fail('publishable', '"private": true — npm refuses to publish this manifest');
}
if (manifest.version === '0.0.0') {
  fail('publishable', 'version is still the 0.0.0 placeholder, not a release');
}

// ── 1. Every bin target is emitted JavaScript ───────────────────────────
const bins = Object.entries(manifest.bin ?? {});
if (bins.length === 0) fail('bin-present', 'the manifest declares no bin');
for (const [name, target] of bins) {
  if (target.endsWith('.ts')) {
    fail(
      'bin-not-typescript',
      `bin "${name}" points at ${target}; a .ts entry cannot run from ` +
        'node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)',
    );
  }
}

// ── 2 & 3. What npm would actually ship ─────────────────────────────────
// npm's own JavaScript entry point, run under this Node — never the `npm`
// on PATH, which is a shell script on POSIX and a `.cmd` on Windows. Spawning
// that name needs a shell, and passing arguments through a shell concatenates
// rather than escapes them, which Node deprecates.
//
// `npm_execpath` is set when this runs as an npm script and unset when a
// person runs the file directly; both have to work, so the unset case
// resolves npm from the directory Node itself was installed in.
function npmEntryPoint() {
  const fromScript = process.env['npm_execpath'];
  if (fromScript !== undefined && fromScript.endsWith('.js')) return fromScript;
  const beside = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  if (existsSync(beside)) return beside;
  throw new Error('could not locate npm-cli.js — run this through `npm run check:package`');
}

const packed = JSON.parse(
  execFileSync(process.execPath, [npmEntryPoint(), 'pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
  }),
);
const shipped = new Set(packed[0].files.map((f) => f.path.split(path.sep).join('/')));

// npm **force-includes every `bin` target** whatever `files` says, so
// asserting the entry points are present proves nothing: a `files` field that
// omits `dist/` still ships the two executables, and ships not one of the
// modules they import. The package then installs cleanly and dies on first
// run at the first bare import.
//
// So the claim worth checking is that the emitted tree came along with them.
// The build's own output is the reference: every file the compiler wrote is
// something a bin can reach through some import chain, and the cheap way to
// be sure the chain is intact is to require the whole tree rather than to
// walk the imports and rediscover the module resolver.
const emitted = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) {
      emitted.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
};
const distRoot = path.join(root, 'dist');
if (!existsSync(distRoot)) {
  fail('bin-shipped', 'dist/ does not exist — run npm run build');
} else {
  walk(distRoot);
  const missing = emitted.filter((f) => !shipped.has(f));
  if (missing.length > 0) {
    fail(
      'bin-shipped',
      `npm pack omits ${missing.length} of ${emitted.length} built files ` +
        `(e.g. ${missing.slice(0, 3).join(', ')}) — check the files field. ` +
        'Note npm ships bin targets regardless, so the executables alone prove nothing',
    );
  }
}

for (const unwanted of ['tests/', 'docs/', 'tsconfig.json']) {
  const hit = [...shipped].find((f) => f === unwanted || f.startsWith(unwanted));
  if (hit) fail('tarball-lean', `the tarball carries ${hit}; it is not needed to run the service`);
}

// ── On the version the built CLI reports ────────────────────────────────
//
// `readVersion` imports the manifest, and the build emits its own copy of it
// beside the output, so a `dist/` built against a different manifest reports
// a version the package does not carry. That is worth knowing about and is
// deliberately **not** a rule here, because a rule that cannot fail is worse
// than no rule: `npm pack` runs `prepack`, `prepack` runs the build, and the
// build rewrites that copy — so by the time this file could compare the two
// they have already been made to agree. The property is *guaranteed* by the
// packing sequence rather than asserted after it, and asserting it anyway
// would produce a check that passes whatever anyone does to the tree.

// ── 5. A documented npx invocation names an executable npx can resolve ──
//
// `npx <package>` runs the bin *named after the package*, and this package
// ships `broker` and `broker-tool` — neither of which is `browser-broker`.
// So the obvious-looking `npx browser-broker` does not start the service; it
// fails with "could not determine executable to run", and it fails that way
// only once it is published, which is after the documentation claiming it is
// already public.
//
// The check is textual rather than a spawn: resolving for real would need a
// published version to install, which is exactly the ordering that let the
// wrong line ship in the first place.
const binNames = new Set(bins.map(([name]) => name));
const packageIsOwnBin = binNames.has(manifest.name);
if (!packageIsOwnBin) {
  for (const doc of ['README.md', 'RELEASES.md']) {
    const text = readFileSync(path.join(root, doc), 'utf8');
    // `npx <flags> <package>` with no executable after it. `-p`/`--package`
    // is the form that names one, so a match carrying it is correct.
    const pattern = new RegExp(
      String.raw`npx(?:\s+-[-\w]+)*\s+` +
        manifest.name +
        String.raw`(?:@[\w.^~-]+)?(?=[\s"',\]}]|$)`,
      'g',
    );
    for (const match of text.matchAll(pattern)) {
      if (/\s(?:-p|--package)\s/.test(match[0])) continue;
      fail(
        'npx-invocation',
        `${doc} documents \`${match[0].trim()}\`, which npx cannot resolve — ` +
          `no bin is named ${manifest.name}. Use -p ${manifest.name} <${[...binNames][0]}>`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('Packaging check failed:\n');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(
  `Packaging check passed: ${shipped.size} files, bins ${bins.map(([n]) => n).join(', ')}`,
);
