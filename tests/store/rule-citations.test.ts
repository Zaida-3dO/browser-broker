import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Every rule name cited anywhere in the source appears in the design's rule
 * list.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A GATE AND NOT A ONE-OFF TIDY-UP
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §7.1 is titled *"Every rule, and what it refuses"*, and §3.14 requires a
 * refusal to **cite a rule from section 7**. Those two together mean a rule
 * name used in the source but absent from section 7 is a **dangling citation**:
 * the refusal points at an entry that is not there, and a caller following the
 * pointer finds nothing.
 *
 * Fifteen names sat in exactly that state — the behaviour specified in prose,
 * only the naming missing — because nothing was looking for them. Listing them
 * closes those fifteen; this test closes the class, by making any further
 * drift a failing build rather than something a reader has to notice.
 *
 * ── How this differs from the check that already exists ─────────────────
 *
 * `tests/service/refusals.test.ts` reconciles the **refusal taxonomy** against
 * the design, which is the same idea applied to one table. It can only see
 * rules that have a taxonomy entry, and most of the fifteen did not: they are
 * raised directly at their call sites. This scans the source instead, so a rule
 * invented at a call site and never added to any table is still caught.
 *
 * The two are complements, and this one deliberately imports nothing from the
 * service layer — it reads files, so a rule cited in a module this test never
 * loads is still found.
 */

/** Where the rules are declared, and where they are cited. */
const DESIGN = path.join('docs', 'plans', 'SCHEMA.md');
const SOURCE_ROOT = 'src';

/**
 * The shape of a rule name: a lowercase area, a dot, a lowercase name.
 *
 * Matched only where a refusal is actually being constructed or declared,
 * rather than anywhere a dotted string appears. A looser pattern would sweep up
 * every property path and file extension in the tree and then need an
 * ever-growing list of exclusions, which is the shape of a check that gets
 * disabled.
 */
const CITATIONS: readonly RegExp[] = [
  // `throw new PageRefusal('act.viewport_bounded', ...)`, across a line break,
  // which is how most of them are formatted once the message is long.
  /(?:StartupRefusal|CallRefusal|PageRefusal|BuildRefusal)\(\s*'([a-z_]+\.[a-z_]+)'/g,
  // `rule: 'feedback.note_bounded'` — the taxonomy and the conformance cases.
  /\brule:\s*'([a-z_]+\.[a-z_]+)'/g,
];

/**
 * Rules deliberately outside section 7, each with the reason it is outside.
 *
 * **Declared here rather than waived**, and the list is expected to stay tiny.
 * A rule lands here only when it is not a per-call rule at all — not merely
 * when somebody has not written its row yet.
 */
const NOT_IN_SECTION_SEVEN: Readonly<Record<string, string>> = {
  // Raised by the arbitration runner for an operation named on a surface this
  // build does not register. §7.1 is about whether an operation is allowed;
  // this is about whether it exists, which is a version mismatch between a
  // caller and this service. `refusals.ts` states this in its own comment and
  // `tests/service/refusals.test.ts` declares the same exception.
  'arbitration.registered': 'the operation does not exist, rather than being disallowed',
};

/** Every `.ts` and `.mjs` file under the source root. */
function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith('.ts') || entry.name.endsWith('.mjs') ? [full] : [];
  });
}

test('every rule name cited in the source is listed in the design', () => {
  const design = fs.readFileSync(DESIGN, 'utf8');

  // Section 7 onwards, so a rule name that merely appears in passing prose
  // earlier in the document does not satisfy the citation. The rule list is
  // what §3.14 points a refusal at.
  const sectionSeven = design.slice(design.indexOf('### 7.1 Checked on every call'));
  assert.ok(
    sectionSeven.length > 0,
    'Section 7.1 was not found in the design; this test cannot check anything against a document whose rule list has moved or been renamed.',
  );

  const cited = new Map<string, string>();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of CITATIONS) {
      for (const match of text.matchAll(pattern)) {
        const rule = match[1];
        if (rule !== undefined && !cited.has(rule)) {
          cited.set(rule, file);
        }
      }
    }
  }

  // A guard on the scanner itself. If a refactor changed how refusals are
  // constructed, the patterns above would quietly match nothing and this test
  // would pass while checking zero rules — the classic shape of a check that
  // cannot fail. The number only has to be a floor well below the real count.
  assert.ok(
    cited.size >= 20,
    `Only ${String(cited.size)} rule citations were found in the source, which is far fewer than this project has. The patterns in this test have most likely stopped matching how refusals are written, so it is checking nothing. Fix the patterns rather than lowering this number.`,
  );

  const dangling: string[] = [];
  for (const [rule, file] of cited) {
    if (rule in NOT_IN_SECTION_SEVEN) {
      continue;
    }
    if (!sectionSeven.includes(`\`${rule}\``)) {
      dangling.push(`${rule} (cited in ${file})`);
    }
  }

  assert.deepEqual(
    dangling,
    [],
    `These rule names are cited in the source but appear nowhere in the design's section 7:\n  ${dangling.join('\n  ')}\n\n` +
      `Section 7.1 is titled "Every rule, and what it refuses", and section 3.14 requires a refusal to cite a rule from ` +
      `section 7 — so a name missing from it is a dangling citation, and a caller following the pointer finds nothing. ` +
      `Add a row describing what the rule requires and what it refuses with. If the rule genuinely is not a per-call ` +
      `rule, add it to this test's declared exceptions with the reason, rather than deleting the assertion.`,
  );
});

test('the declared exceptions are all still cited somewhere in the source', () => {
  // An exception for a rule nobody raises any more is a stale waiver, and a
  // stale waiver is how an exception list grows into a way of ignoring the
  // check. This is what makes the list above shrink on its own.
  const files = sourceFiles(SOURCE_ROOT);
  const everything = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

  for (const rule of Object.keys(NOT_IN_SECTION_SEVEN)) {
    assert.ok(
      everything.includes(`'${rule}'`),
      `${rule} is listed as deliberately outside section 7, but no citation for it exists anywhere in the source. Remove the exception rather than leaving it to excuse a rule nothing raises.`,
    );
  }
});
