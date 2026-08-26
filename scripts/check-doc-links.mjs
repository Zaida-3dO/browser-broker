#!/usr/bin/env node
/**
 * Fails when a `{@link ...}` in `src/` names something that does not exist
 * anywhere in `src/`.
 *
 * This exists because of a specific, repeated failure in this repository, and
 * the repetition is the argument for a gate rather than a habit. Four times a
 * function has documented itself as an entry point while nothing called it —
 * and the fourth was a module header whose opening sentence pointed at a
 * `reconcileBrowser` that existed at no commit. That header described a
 * design, named its parts, and every part it named was reached only by its own
 * unit tests. The prose was the most confident thing in the file and it was
 * the only thing that was wrong.
 *
 * A dangling link is the cheapest detectable member of that family. It does
 * not catch the family — see the limits below — but it is decidable from the
 * source, it has no false positives on this tree, and it fires on exactly the
 * sentence that misled a reader.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Read this before trusting a green run, and read it before extending it.
 *
 * **What a green run means:** every `{@link X}` in `src/` resolves to a name
 * this tree declares, imports, or defines as a member. Nothing more.
 *
 * **What it does not mean — and this is the larger half of the class:**
 *
 * 1. **It does not check that a documented caller actually calls.** A
 *    docstring saying "admission uses this" is prose, and prose naming a real
 *    but wrong function resolves perfectly. `hashesMatch` documented itself
 *    with a sentence asserting it was used while nothing referenced it; that
 *    sentence names no symbol at all and no link check could see it.
 * 2. **It does not check reachability, and deliberately does not try.**
 *    "Exported from `src/service/` but reached only from tests" is the rule
 *    one would actually want, and it is **not soundly decidable by scanning
 *    this source**. Calls arrive through the arbitration registry by string
 *    name, through the conformance driver's dynamic dispatch, and through the
 *    tool protocol's name-keyed tables. A grep-shaped reachability rule would
 *    report registry-dispatched handlers as dead — false positives, which
 *    train people to waive — while a genuinely dead export re-exported
 *    through a barrel would read as live. **A check that greps for a name
 *    while the call arrives by another route is worse than no check**,
 *    because later rows would trust it. So it is not attempted here, and this
 *    paragraph is the reason rather than an omission.
 * 3. **It resolves names, not identities.** Two different `close` methods on
 *    two interfaces are one name to this scan, so a link to the wrong one of
 *    them resolves. Making that precise needs a type checker, not a scanner.
 *
 * ── How a name is resolved, and why each source counts ──────────────────
 *
 * A link target is the text up to the first `.`, `#`, `(` or space, so
 * `{@link Foo.bar}` and `{@link foo()}` resolve on `Foo` and `foo`. It counts
 * as existing if the tree contains any of:
 *
 * - a top-level declaration — `function`, `class`, `interface`, `type`,
 *   `const`, `let`, `enum`;
 * - a member of an interface or object type, such as a readonly property
 *   holding a function or a method written in shorthand. Several of this
 *   tree's links point at driver interface members, and they are correct
 *   links;
 * - an imported binding, including a type-only import. A link naming a type
 *   from a dependency is a correct link;
 * - a language keyword that can appear in a link, which is only `import`, for
 *   a note about dynamic import.
 *
 * Each of those four was added because this tree contains a legitimate link
 * that needs it, not in anticipation. The exemption list is pinned by the
 * self-test so it cannot be widened quietly to make a failure go away —
 * widening it is how a gate becomes decoration.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The tree this scans. Links in tests and scripts are not gated. */
export const SCANNED_DIR = 'src';

/**
 * Names a link may use that no declaration in this tree provides.
 *
 * **`import` is a keyword, not a symbol**, and it is here because a docstring
 * legitimately writes a link to `import()` when discussing dynamic import.
 * Nothing else belongs here: a name that is missing because it was deleted is
 * the exact thing this check exists to report, and adding it here to get a
 * green run would be waiving the finding rather than fixing it.
 */
export const LINK_KEYWORDS = Object.freeze(['import']);

/** Every `.ts` file under a directory, relative to the repository root. */
export function sourceFilesIn(dir) {
  const found = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const next = join(absolute, entry.name);
      if (entry.isDirectory()) {
        walk(next);
      } else if (entry.name.endsWith('.ts')) {
        found.push(relative(ROOT, next).split('\\').join('/'));
      }
    }
  };
  walk(join(ROOT, dir));
  return found;
}

/**
 * Every name this source declares, in any of the four senses above.
 *
 * Deliberately generous within those senses: this set decides what *exists*,
 * and a name missed here becomes a false positive on a correct link, which is
 * the failure mode that gets a check waived rather than fixed.
 */
export function declaredNamesIn(source) {
  const names = new Set();
  const add = (pattern) => {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) names.add(match[1]);
    }
  };

  // Top-level declarations, exported or not.
  add(/\b(?:function|class|interface|enum)\s+([A-Za-z_$][\w$]*)/g);
  add(/\btype\s+([A-Za-z_$][\w$]*)\s*[=<]/g);
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);

  // Members of interfaces and object types: a readonly property holding a
  // function, a plain property, and method shorthand.
  add(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/gm);
  add(/^\s*(?:public\s+|private\s+|static\s+|async\s+|#)*([A-Za-z_$][\w$]*)\s*\(/gm);

  // Imported bindings, value and type alike, including aliases and defaults.
  for (const match of source.matchAll(/import\s+(?:type\s+)?([^;]*?)\s+from\s+/g)) {
    const clause = match[1];
    for (const part of clause.replace(/[{}]/g, ' ').split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }

  return names;
}

/**
 * Every `{@link ...}` in the source, with the line it sits on.
 *
 * The target is the text up to the first separator, so a link to a member or
 * a call form resolves on the name that owns it. **Line numbers are counted
 * on the unmodified source**, because a rule that reports the wrong line
 * sends its reader to innocent code.
 */
export function linkTargetsIn(source) {
  const found = [];
  for (const match of source.matchAll(/\{@link\s+([^}]+)\}/g)) {
    const raw = match[1].trim();
    const target = raw.split(/[.#(\s|]/)[0];
    if (!target || !/^[A-Za-z_$][\w$]*$/.test(target)) continue;
    found.push({
      target,
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return found;
}

/**
 * The links that resolve to nothing anywhere in the scanned tree.
 *
 * Resolution is **tree-wide rather than per-file**, because this repository's
 * headers routinely link a sibling module's export to explain where a rule
 * lives, and those are the links most worth keeping correct.
 */
export function danglingLinks(sources) {
  const known = new Set(LINK_KEYWORDS);
  for (const source of Object.values(sources)) {
    for (const name of declaredNamesIn(source)) known.add(name);
  }

  const failures = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const { target, line } of linkTargetsIn(source)) {
      if (!known.has(target)) failures.push({ file, line, target });
    }
  }
  return failures;
}

function main() {
  const files = sourceFilesIn(SCANNED_DIR);
  const sources = {};
  for (const file of files) {
    sources[file] = readFileSync(join(ROOT, file), 'utf8');
  }

  const failures = danglingLinks(sources);
  const linkCount = Object.values(sources).reduce(
    (total, source) => total + linkTargetsIn(source).length,
    0,
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `${failure.file}:${failure.line}  {@link ${failure.target}}\n` +
          `    names something no file under ${SCANNED_DIR}/ declares, imports or defines as a member.\n` +
          '    A link is a claim that a reader can go and look at the thing. Point it at what actually\n' +
          '    implements the behaviour, or delete the sentence — do not add the name to LINK_KEYWORDS.\n',
      );
    }
    console.error(
      `${failures.length} documentation link${failures.length === 1 ? '' : 's'} naming something that does not exist.`,
    );
    return 1;
  }

  console.log(
    `Every one of the ${String(linkCount)} {@link} targets across ${String(files.length)} files under ${SCANNED_DIR}/ resolves.\n` +
      'This means no docstring sends a reader to a name that is not there. It does NOT mean the prose is\n' +
      'accurate: a docstring naming a real but wrong function resolves, and one claiming a caller in words\n' +
      "rather than a link is invisible here. See this script's header for why reachability is not attempted.",
  );
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
