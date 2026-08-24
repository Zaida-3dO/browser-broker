import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ARTIFACTS_SOURCE,
  FORBIDDEN_REQUEST_FIELDS,
  REQUEST_TYPE,
  RESOLVER_NAME,
  RESOLVER_SOURCE,
  checkRequestType,
  checkResolverIsTheOnlyRoute,
  checkResolverRefuses,
  requestTypeBody,
  unionVariants,
} from '../scripts/check-artifact-path.mjs';

/**
 * The self-test for `artifact.no_request_path` (`SCHEMA.md` §7.3,
 * `MILESTONES.md` #49).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN RUN OF THIS FILE MEANS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `CLAUDE.md`: "any script used as a gate must ship a test proving it **fails
 * on a seeded violation**, not merely that it passes on clean input", and that
 * test "must also state plainly what a green result does, and does not, mean".
 *
 * **What it means:** each of the five scans has been run against a source that
 * violates it, and each refused. Every seed is a **mutation of the shipped
 * source** — `readFileSync` of the real file with one thing changed — rather
 * than a local imitation of it, so a scan that stopped working fails here.
 * That distinction is not theoretical: this repository has already shipped a
 * hollow test that exercised a reimplementation, so the real code was never run
 * at all.
 *
 * **What it does not mean:** that the rule is unbypassable. The script's header
 * sets out the limits in full and they are real — the scans cover two named
 * files, and a second bytes surface in a third file matches no shape either
 * rule looks for. A green run here says the scans catch **the shapes they were
 * taught**, and widening intent does not widen a regular expression.
 */

const artifacts = readFileSync(ARTIFACTS_SOURCE, 'utf8');
const resolver = readFileSync(RESOLVER_SOURCE, 'utf8');

function clean() {
  return { [ARTIFACTS_SOURCE]: artifacts, [RESOLVER_SOURCE]: resolver };
}

/** The real tree with one file replaced by a mutation of itself. */
function seeded(path, mutate) {
  const sources = clean();
  const before = sources[path];
  const after = mutate(before);
  assert.notEqual(
    after,
    before,
    `the seed for ${path} changed nothing — the mutation missed, so the assertion below would pass vacuously`,
  );
  return { ...sources, [path]: after };
}

function rules(sources) {
  return [
    ...checkRequestType(sources),
    ...checkResolverIsTheOnlyRoute(sources),
    ...checkResolverRefuses(sources),
  ];
}

function scansThatFired(failures) {
  return [...new Set(failures.map((failure) => failure.scan))].sort();
}

// ── The control ─────────────────────────────────────────────────────────
//
// Every assertion below is "this seed fires". Without this one, a scan that
// fired on absolutely everything would pass all of them.

test('the tree as it stands violates nothing', () => {
  assert.deepEqual(rules(clean()), []);
});

// ── Scan A: a request field that is a location ──────────────────────────

test('scan A fires when the request type grows a path field', () => {
  // The violation in its most plausible costume: somebody adds a way to ask
  // for an arbitrary file "just for the overlay". This is exactly what §7.3
  // forbids and it type-checks perfectly.
  const sources = seeded(ARTIFACTS_SOURCE, (source) =>
    source.replace(
      "| { readonly kind: 'overlay'; readonly comparisonId: string }",
      "| { readonly kind: 'overlay'; readonly comparisonId: string; readonly path: string }",
    ),
  );

  const fired = rules(sources);
  assert.ok(
    fired.some((failure) => failure.scan === 'A'),
    'scan A must fire on a path field',
  );
  // The message names the field, so somebody reading a failing build knows
  // which line to look at rather than which file.
  assert.match(fired.find((f) => f.scan === 'A')?.detail ?? '', /path/);
});

test('scan A fires on every field name it declares forbidden', () => {
  // Walks the list rather than spot-checking one entry. **Deleting an entry
  // from the list must fail this**, which a test that only seeded `path` would
  // not notice — a repository incident where a test iterated a list rather than
  // naming its entries is the reason this is written as a loop over the
  // exported constant with an assertion per entry.
  for (const field of FORBIDDEN_REQUEST_FIELDS) {
    const sources = seeded(ARTIFACTS_SOURCE, (source) =>
      source.replace(
        "| { readonly kind: 'capture'; readonly captureId: string }",
        `| { readonly kind: 'capture'; readonly captureId: string; readonly ${field}: string }`,
      ),
    );
    assert.ok(
      checkRequestType(sources).some((failure) => failure.scan === 'A'),
      `scan A did not fire on a request field named ${field}, which the script declares forbidden`,
    );
  }
});

test('scan A reports the type as unreadable rather than clean when it is renamed', () => {
  // A rule pointed at something that has moved reports no violations, which
  // reads exactly like a clean tree. This asserts the script refuses instead.
  const sources = seeded(ARTIFACTS_SOURCE, (source) =>
    source.replace(`export type ${REQUEST_TYPE} =`, 'export type SomethingElse ='),
  );

  const fired = checkRequestType(sources);
  assert.ok(fired.length > 0, 'a renamed request type must be reported, not passed');
  assert.match(fired[0]?.detail ?? '', /reads exactly like a clean tree/);
});

// ── Scan B: a variant that names no row ─────────────────────────────────

test('scan B fires when a variant addresses something without naming a row', () => {
  const sources = seeded(ARTIFACTS_SOURCE, (source) =>
    source.replace(
      "| { readonly kind: 'overlay'; readonly comparisonId: string }",
      "| { readonly kind: 'overlay'; readonly which: string }",
    ),
  );

  assert.ok(
    rules(sources).some((failure) => failure.scan === 'B'),
    'scan B must fire on a variant with no identifier',
  );
});

test('the type body is read whole, so a multi-line variant is not cut in half', () => {
  // The parser bug this pins is one the check actually had: reading to the
  // first semicolon stops inside any variant declaring more than one field,
  // because the field separator inside a braced variant is also a semicolon.
  // The result was a false positive on the real, correct type.
  const body = requestTypeBody(artifacts);
  assert.notEqual(body, null);

  const variants = unionVariants(body ?? '');
  // Three variants, and the shipped type has exactly three. Naming the count
  // and the kinds rather than iterating: deleting a variant must fail this.
  assert.equal(variants.length, 3);
  assert.ok(variants.some((variant) => variant.includes("'capture'")));
  assert.ok(variants.some((variant) => variant.includes("'overlay'")));
  assert.ok(variants.some((variant) => variant.includes("'region'")));
  // The region variant is the multi-line one, and it must arrive whole —
  // including the field that sits after the inner semicolon.
  const region = variants.find((variant) => variant.includes("'region'")) ?? '';
  assert.match(region, /comparisonId/);
  assert.match(region, /side/);
});

// ── Scan C: a second route to the disk ──────────────────────────────────

test('scan C fires when a filesystem call is passed something the resolver did not return', () => {
  // The bypass in the shape it would actually arrive in: reading the stored
  // path directly, skipping the resolver. It is one word shorter than the
  // correct code and it works on every path that does not escape.
  const sources = seeded(ARTIFACTS_SOURCE, (source) =>
    source.replace('await fs.readFile(absolute)', 'await fs.readFile(stored)'),
  );

  const fired = rules(sources);
  assert.ok(
    fired.some((failure) => failure.scan === 'C'),
    'scan C must fire on an unresolved read',
  );
});

test('scan C fires when the resolver is not called at all', () => {
  const sources = seeded(ARTIFACTS_SOURCE, (source) =>
    source.replace(`const absolute = ${RESOLVER_NAME}(`, 'const absolute = String('),
  );

  const fired = rules(sources);
  assert.ok(fired.some((failure) => failure.scan === 'C'));
  assert.match(
    fired.find((failure) => failure.scan === 'C')?.detail ?? '',
    /never calls resolveArtifact/,
  );
});

// ── Scan E: a path-shaped argument on the surface ───────────────────────

test('scan E fires when the surface exports a function taking a path', () => {
  // The helper somebody adds because it is convenient, which reintroduces the
  // input §7.3 exists to delete.
  const sources = seeded(
    ARTIFACTS_SOURCE,
    (source) =>
      `${source}\nexport async function readAnything(path: string): Promise<Uint8Array> {\n  return new Uint8Array();\n}\n`,
  );

  assert.ok(
    rules(sources).some((failure) => failure.scan === 'E'),
    'scan E must fire on a path-shaped exported argument',
  );
});

// ── Scan D: the resolver stops refusing ─────────────────────────────────

test('scan D fires when the resolver stops rejecting absolute paths', () => {
  const sources = seeded(RESOLVER_SOURCE, (source) =>
    source.replace('path.isAbsolute(stored)', 'false'),
  );

  const fired = rules(sources);
  assert.ok(fired.some((failure) => failure.scan === 'D'));
});

test('scan D fires when the containment assertion is removed', () => {
  // The single most dangerous mutation in this file: dropping the check that
  // the *resolved* path is still under the root. A check on the stored string
  // before resolution passes `a/../../b`, which is innocent-looking until it
  // is resolved.
  const sources = seeded(RESOLVER_SOURCE, (source) =>
    source.replace('const relative = path.relative(root, resolved);', 'const relative = stored;'),
  );

  const fired = rules(sources);
  assert.ok(
    fired.some((failure) => failure.scan === 'D'),
    'scan D must fire when containment is not asserted on the resolved path',
  );
});

test('scan D reports the resolver as unreadable rather than clean when it is renamed', () => {
  const sources = seeded(RESOLVER_SOURCE, (source) =>
    source.replace(`export function ${RESOLVER_NAME}(`, 'export function somethingElse('),
  );

  const fired = checkResolverRefuses(sources);
  assert.ok(fired.length > 0);
  assert.match(fired[0]?.detail ?? '', /exports no resolveArtifact/);
});

// ── The scans are distinct ──────────────────────────────────────────────

test('each seed fires its own scan and not merely something', () => {
  // Without this, a script whose every scan fired on every mutation would pass
  // each assertion above. Naming which scan fired is what makes the individual
  // assertions mean what they say.
  const pathField = seeded(ARTIFACTS_SOURCE, (source) =>
    source.replace(
      "| { readonly kind: 'overlay'; readonly comparisonId: string }",
      "| { readonly kind: 'overlay'; readonly comparisonId: string; readonly path: string }",
    ),
  );
  assert.deepEqual(scansThatFired(rules(pathField)), ['A']);

  const unresolvedRead = seeded(ARTIFACTS_SOURCE, (source) =>
    source.replace('await fs.readFile(absolute)', 'await fs.readFile(stored)'),
  );
  assert.deepEqual(scansThatFired(rules(unresolvedRead)), ['C']);

  const noContainment = seeded(RESOLVER_SOURCE, (source) =>
    source.replace('const relative = path.relative(root, resolved);', 'const relative = stored;'),
  );
  assert.deepEqual(scansThatFired(rules(noContainment)), ['D']);
});
