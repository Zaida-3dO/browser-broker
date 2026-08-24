import fs from 'node:fs';
import path from 'node:path';

import { isAdapterId } from '../contract.ts';

/**
 * Find every adapter this tree contains, and report the ones nothing mounts.
 *
 * ── This is the run-time half of "an unregistered adapter fails the suite" ─
 *
 * The typed driver map catches a route added to the registry with no driver.
 * It cannot catch the other direction: a module that implements an adapter
 * and was **never added to the registry at all**. No type can see a file
 * nobody imported, so that half is a walk of the source tree.
 *
 * An adapter module is one that exports an {@link Adapter} — which is
 * recognised here by the declaration that names it, `Adapter =` with the type
 * annotation, rather than by executing anything. **Reading rather than
 * importing is deliberate:** importing every candidate to see what it exports
 * would execute code found on disk, and a walk that runs what it finds is a
 * worse thing to have than the gap it closes.
 *
 * ── What this can and cannot see, so nobody over-trusts it ──────────────
 *
 * It sees a file under {@link ADAPTER_SOURCE_ROOTS} whose **code** declares an
 * `Adapter`. It does **not** see: an adapter written outside those roots, one
 * assembled at run time from something that is not a literal declaration, or
 * one whose type annotation is spelled differently. The roots are asserted by
 * this module's own test, so moving or narrowing them is a visible change to
 * a test rather than a silent loss of coverage — which is the property that
 * makes a walk-based check worth having at all.
 *
 * Comments are blanked before matching, because they are prose about
 * adapters rather than adapters. That is a fix for a real false positive
 * rather than a precaution: this file's own header quotes the shape it
 * matches, and the walk reported that quotation as an unregistered adapter
 * until {@link withoutComments} was added.
 *
 * That is the same shape, and the same honesty, as the hygiene gate's own
 * header: a green run means no *unregistered adapter of the recognised shape*
 * exists, not that no adapter anywhere is unregistered.
 */

/** Where an adapter may live. Asserted by this module's test. */
export const ADAPTER_SOURCE_ROOTS: readonly string[] = ['src'];

/**
 * How an adapter declares itself.
 *
 * Matches a declaration annotated with the contract's own type — for example
 * `export const cliAdapter: Adapter = {`. The annotation is what is matched
 * rather than the file's name or its directory, because a naming convention
 * is a thing somebody can be unaware of and a type annotation is a thing the
 * compiler already made them write.
 */
const ADAPTER_DECLARATION = /(?:const|let|var)\s+(\w+)\s*:\s*Adapter\b/gu;

/**
 * The identifier an adapter module claims, read from its `id` field.
 *
 * Matched on the literal because that is what the registry's keys are
 * compared against. A computed id would not match, and that is a limitation
 * this file states rather than papers over.
 */
const ADAPTER_ID_FIELD = /\bid\s*:\s*['"]([\w-]+)['"]/u;

export interface DiscoveredAdapter {
  /** Path relative to the tree root, in forward slashes, for a message. */
  readonly file: string;
  /** The declared variable's name. */
  readonly declaration: string;
  /** The `id` the module claims, when it is a literal. */
  readonly id: string | undefined;
}

/** Walk a directory for TypeScript sources, skipping what cannot hold one. */
function* sourceFiles(directory: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      yield* sourceFiles(full);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

/**
 * Blank out comments, so a declaration *described* in prose is not mistaken
 * for one.
 *
 * This is not a nicety — it was a real false positive. `discovery.ts`'s own
 * header documents the shape it matches by quoting it, and the walk duly
 * reported its own documentation as an unregistered adapter. Blanking rather
 * than deleting keeps every offset intact, so the id lookup that follows a
 * match still reads the right region of the file.
 *
 * **It is a lexer's job done with a regular expression, and it is approximate
 * in one direction that is worth naming**: a `//` or a comment opener inside a
 * string literal is treated as the start of a comment. The consequence is a
 * declaration *after* such a string on the same line being missed, which
 * would be a false negative. It is accepted because the alternative is
 * parsing TypeScript to run a check, and because the tests below pin both the
 * positive and the negative behaviour rather than only the happy one.
 */
function withoutComments(text: string): string {
  const blanked = (match: string): string => match.replaceAll(/[^\n]/gu, ' ');
  return text.replaceAll(/\/\*[\s\S]*?\*\//gu, blanked).replaceAll(/\/\/[^\n]*/gu, blanked);
}

/** Every adapter declared anywhere under the roots. */
export function discoverAdapters(treeRoot: string): readonly DiscoveredAdapter[] {
  const found: DiscoveredAdapter[] = [];

  for (const root of ADAPTER_SOURCE_ROOTS) {
    for (const file of sourceFiles(path.join(treeRoot, root))) {
      const text = withoutComments(fs.readFileSync(file, 'utf8'));
      // The contract itself declares the type; it is not an adapter.
      const relative = path.relative(treeRoot, file).split(path.sep).join('/');
      if (relative === 'src/adapter/contract.ts') {
        continue;
      }

      ADAPTER_DECLARATION.lastIndex = 0;
      let match = ADAPTER_DECLARATION.exec(text);
      while (match !== null) {
        const declaration = match[1] ?? '<anonymous>';
        // Read the id from the object that follows the declaration.
        const after = text.slice(match.index);
        const idMatch = ADAPTER_ID_FIELD.exec(after);
        found.push({ file: relative, declaration, id: idMatch?.[1] });
        match = ADAPTER_DECLARATION.exec(text);
      }
    }
  }

  return found;
}

/** An adapter that exists in the tree and is mounted by nothing. */
export interface UnregisteredAdapter extends DiscoveredAdapter {
  readonly why: string;
}

/**
 * Every adapter the tree contains that the registry does not mount.
 *
 * **A non-empty result fails the suite.** That is the assertion row #25 is
 * defined by, and it is proved by a test that actually adds an unregistered
 * adapter and watches this return it — not by a comment claiming it would.
 */
export function unregisteredAdapters(treeRoot: string): readonly UnregisteredAdapter[] {
  const unregistered: UnregisteredAdapter[] = [];

  for (const adapter of discoverAdapters(treeRoot)) {
    if (adapter.id === undefined) {
      unregistered.push({
        ...adapter,
        why: 'its id is not a literal, so nothing can check it against the registry',
      });
      continue;
    }
    if (!isAdapterId(adapter.id)) {
      unregistered.push({
        ...adapter,
        why: `"${adapter.id}" is not in the registry the application mounts through`,
      });
    }
  }

  return unregistered;
}
