#!/usr/bin/env node
/**
 * `capture.no_diff_dependency` (`SCHEMA.md` §7.3): **no capture path reads
 * anything belonging to the diff feature.**
 *
 * Diffing is deliberately the last thing built (`MILESTONES.md` M8), and a
 * capture that consulted it would make the earlier work depend on the later.
 * `SCHEMA.md` §3.11 records that this coupling once existed and was cut: a
 * capture used to consult a canonical picture for the view it named and take
 * the picture at **that picture's geometry**, so every capture carried a
 * reason to fail that had nothing to do with capturing.
 *
 * **That is an absence, and an absence has no call site to check at run time.**
 * Hence a build rule.
 *
 * ══ WHAT THIS CHECK ACTUALLY PROVES, AND WHAT IT DOES NOT ═══════════════
 *
 * Read this section before trusting a green run, and before extending the
 * check. It is written at length because a build rule that later rows trust is
 * worse than no rule if what it proves is narrower than what it appears to
 * prove.
 *
 * ── What it proves ──
 *
 * **1. Static module reachability.** It builds the transitive closure of
 * `import` and `export … from` specifiers starting at the capture entry
 * points, resolving each to a file on disk, and fails if any module in that
 * closure is a diff-feature module. This is a real graph walk, not a text
 * search: a capture module that imports a module that imports the diff module
 * is caught at any depth, and renaming the diff module does not evade it
 * because the check works from **where the file lives**, not from what any
 * line of text says.
 *
 * **2. That the closure cannot escape analysis.** A dynamic `import()`, a
 * `require`, or a `createRequire` inside a capture-reachable module would let a
 * module be loaded by a name this walk cannot follow — so any of those inside
 * the closure is itself a failure. That is the honest way to handle the limit:
 * rather than claim to analyse what it cannot, the check **refuses the
 * constructs that would make its own analysis incomplete**, so the closure it
 * walked is the whole closure.
 *
 * ── What it does NOT prove, stated plainly ──
 *
 * - **It is not a data-flow analysis.** If a diff-feature *value* were passed
 *   into a capture function as an argument by some third module, no import
 *   from the capture side would exist and this check would pass. What keeps
 *   that from mattering is that {@link CAPTURE_ENTRY_POINTS}'s signatures take
 *   a tab, an artifact store and plain options — but that is a property of
 *   those signatures, not something checked here.
 * - **It cannot see a module that does not exist yet.** {@link DIFF_OWNED} is
 *   the list of paths the diff feature owns, and a diff module added somewhere
 *   not on that list is invisible to this check. **This is the maintenance cost
 *   and it is real**: the M8 row that creates the diff modules must add their
 *   location here, and this file says so in {@link DIFF_OWNED}'s own comment so
 *   whoever opens it is told.
 * - **It says nothing about run-time behaviour.** A capture path that read a
 *   diff artefact off the filesystem by constructing a path string would import
 *   nothing and pass. The check is about module dependency, which is what the
 *   sequencing property is actually about.
 * - **It does not check the reverse direction, and must not.** The diff feature
 *   is *expected* to import capture — that is the correct direction, and M8
 *   depends on it.
 *
 * So: this proves the capture code cannot **reach** diff code by any static
 * module path, and refuses the dynamic constructs that would hide one. That is
 * a strong claim and a bounded one.
 *
 * ══ WHY IT IS NOT A TEXT SEARCH ═════════════════════════════════════════
 *
 * The obvious implementation greps the capture sources for a token like
 * `diff` or `compar`. It was rejected, and the reason generalises:
 *
 * - **It would fire on this repository's own prose.** Every capture module has
 *   a header explaining that it must not depend on diffing. A check that fails
 *   on the documentation of the rule teaches everyone to weaken the check.
 * - **A legitimate bypass does not contain the token.** `import { x } from
 *   '../comparison/regions.ts'` contains neither `diff` nor anything a naive
 *   pattern lists, and an aliased re-export contains nothing at all. A search
 *   proves the absence of a spelling; the rule is about the absence of a
 *   dependency, and those are different claims.
 *
 * ══ SEEDING A VIOLATION ═════════════════════════════════════════════════
 *
 * `tests/check-capture-isolation.test.mjs` seeds each violation into a
 * temporary tree and asserts this script fails on it, per `CLAUDE.md`'s rule
 * that every gating script ships a self-test proving it fails on a seeded
 * violation. A gate only ever proven to pass has never been run against the
 * thing it exists to catch.
 *
 * Usage:
 *   node scripts/check-capture-isolation.mjs [root]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Where the capture pipeline starts.
 *
 * The walk begins here and follows every static import. Adding a capture
 * module that nothing in this list reaches, directly or transitively, makes it
 * invisible to the check — so a new top-level capture entry point belongs
 * here. In practice every capture module is reachable from the pipeline.
 */
const CAPTURE_ENTRY_POINTS = ['src/capture/pipeline.ts'];

/**
 * The directories and files the **diff feature** owns (`MILESTONES.md` M8).
 *
 * ⚠️ **The M8 rows that create these modules must keep this list current.**
 * The check can only refuse a dependency on a path it knows is diff-owned, so
 * a diff module living somewhere unlisted is a module this check will happily
 * let capture import. Listed as path prefixes relative to the repository root,
 * matched on directory boundaries.
 *
 * Listed ahead of the code existing, deliberately: the rule has to be in force
 * **before** the tempting code exists, or it arrives after the first violation
 * rather than before it.
 */
const DIFF_OWNED = ['src/diff/', 'src/comparison/'];

/**
 * Constructs that would load a module by a name this walk cannot follow.
 *
 * Refused inside the capture closure rather than analysed, because analysing
 * them is undecidable in general and pretending otherwise is exactly how a
 * check ends up proving less than it claims. See the header.
 *
 * Each is matched as a call shape rather than as a bare word, so the words
 * appearing in a comment or a string do not fire it — `require` in prose is
 * common, `require(` in a capture module is not.
 */
const DYNAMIC_LOADERS = [
  { name: 'a dynamic import()', pattern: /(^|[^.\w])import\s*\(/ },
  { name: 'require()', pattern: /(^|[^.\w])require\s*\(/ },
  { name: 'createRequire', pattern: /createRequire\s*\(/ },
];

/**
 * Every static module specifier in a source file.
 *
 * Covers `import … from 'x'`, bare `import 'x'`, and `export … from 'x'`.
 * Deliberately does **not** try to cover dynamic forms — those are refused
 * outright above, which is the stronger treatment.
 */
function staticSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** Resolve a relative specifier to a file, or null when it is a package. */
function resolveSpecifier(fromFile, specifier, root) {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [resolved, `${resolved}.ts`, `${resolved}.mjs`, `${resolved}.js`];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(root, candidate).split(path.sep).join('/');
    }
  }
  // A specifier that resolves to nothing is not this check's business to
  // report — the type checker and the test run both fail on it far more
  // clearly than a hygiene gate would.
  return null;
}

/** Is this path owned by the diff feature? */
function isDiffOwned(relativePath) {
  return DIFF_OWNED.some(
    (owned) => relativePath === owned.replace(/\/$/, '') || relativePath.startsWith(owned),
  );
}

/**
 * Walk the closure and collect every violation.
 *
 * Returns a list rather than throwing on the first, so one run reports
 * everything that is wrong instead of one thing at a time.
 */
export function findViolations(root) {
  const findings = [];
  const seen = new Set();
  const queue = [];

  for (const entry of CAPTURE_ENTRY_POINTS) {
    if (fs.existsSync(path.resolve(root, entry))) queue.push({ file: entry, via: [] });
  }
  if (queue.length === 0) {
    findings.push({
      file: CAPTURE_ENTRY_POINTS.join(', '),
      message:
        'No capture entry point exists at any declared path. The check would pass over an empty set, which is the failure mode this repository names outright — a rule that asserts nothing passes forever and silently.',
    });
    return findings;
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current.file)) continue;
    seen.add(current.file);

    const absolute = path.resolve(root, current.file);
    if (!fs.existsSync(absolute)) continue;
    const source = fs.readFileSync(absolute, 'utf8');

    // A dynamic loader inside the closure defeats this walk, so it is a
    // failure in its own right rather than something to work around.
    for (const loader of DYNAMIC_LOADERS) {
      if (loader.pattern.test(source)) {
        findings.push({
          file: current.file,
          message: `uses ${loader.name}, which loads a module by a name this check cannot follow. A capture path must be statically analysable, or "no capture path reads diff data" cannot be proved at all. Reached from the capture entry point via: ${[...current.via, current.file].join(' -> ')}`,
        });
      }
    }

    for (const specifier of staticSpecifiers(source)) {
      const target = resolveSpecifier(absolute, specifier, path.resolve(root));
      if (target === null) continue;
      if (isDiffOwned(target)) {
        findings.push({
          file: current.file,
          message: `imports ${target}, which belongs to the diff feature. Capture must not depend on diffing (SCHEMA.md 3.11, 7.3). Reached from the capture entry point via: ${[...current.via, current.file].join(' -> ')}`,
        });
        continue;
      }
      queue.push({ file: target, via: [...current.via, current.file] });
    }
  }

  return findings;
}

function main() {
  const root = process.argv[2] ?? process.cwd();
  const findings = findViolations(root);
  if (findings.length > 0) {
    console.error('capture.no_diff_dependency: FAILED\n');
    for (const finding of findings) {
      console.error(`  ${finding.file}: ${finding.message}`);
    }
    console.error(
      '\nA green run of this check means no capture-reachable module statically imports a diff-owned path, and that the closure contains no dynamic loader that could hide one. It is not a data-flow analysis and it cannot see a diff module at a path it was never told about — see this script header.',
    );
    process.exit(1);
  }
  console.log(
    `capture.no_diff_dependency: ok — the capture closure imports nothing under ${DIFF_OWNED.join(', ')} and contains no dynamic loader.`,
  );
}

// Run only when invoked directly, so the self-test can import `findViolations`
// without the process exiting underneath it. Compared as URLs rather than as
// paths: `import.meta.url` is a file URL and turning one back into a path is
// where the platform-specific spellings live.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
