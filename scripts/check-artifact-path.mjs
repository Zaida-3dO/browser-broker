#!/usr/bin/env node
/**
 * `artifact.no_request_path` — the build rule that keeps the bytes surface
 * from ever accepting a filesystem path from a caller (`SCHEMA.md` §7.3,
 * §1.9; `MILESTONES.md` #49).
 *
 * §7.3, in full: "**No path that serves bytes accepts a filesystem path from a
 * caller.** It resolves a recorded path under the artifact root or it serves
 * nothing, so traversal has no input to arrive through."
 *
 * Like the arbitration rules next door, this asserts an **absence** — there is
 * no call site to inspect, because correct behaviour is that the call never
 * exists — so it is a source scan and it runs in the pipeline on every pull
 * request.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS CHECK CAN PROVE, AND WHAT IT CANNOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Read this before trusting a green run and before extending the rule. The
 * precedent it follows is `scripts/check-external-refs.mjs`, whose header says
 * outright that a green run means the recurring phrasings are absent rather
 * than that the prose is clean. The same honesty is owed here.
 *
 * | Claim | Status |
 * |---|---|
 * | The bytes surface declares no request field that is a path | **Checked.** Scan A |
 * | Every variant of its request type names an identifier | **Checked.** Scan B |
 * | It joins a stored path to the root only through the single resolver | **Checked.** Scan C |
 * | The resolver refuses an absolute path and one escaping the root | **Checked.** Scan D |
 * | The bytes surface takes no argument typed as a path at all | **Checked.** Scan E |
 * | *No other module could serve bytes from a caller's path* | **NOT checked.** These scans cover the named files. A second surface in a new file is outside them by construction — which is the same limit `check-arbitration.mjs` records, and the same answer: the violation is loud rather than impossible |
 * | *The resolver is correct* | **NOT checked here.** That it refuses the shapes it is given is a test (`tests/diff/artifact-path.test.ts`); this scan checks that it is reached at all |
 * | *A caller cannot influence the stored path indirectly* | **NOT checked, and it is the real residual risk.** A capture's file name is derived from the page address (§1.7a), so a caller that controls an address influences a stored path. §1.7a's four derivation rules are what contain that, and they are prose plus tests rather than anything this scan can see |
 *
 * **The honest summary: this makes the violation loud rather than
 * impossible.** Somebody who wants to serve a caller's path can; the value is
 * that they cannot do it quietly, because every route requires either a new
 * file these scans do not name or an edit that fails one of them in the diff.
 */

import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * The files this rule reads.
 *
 * Named individually rather than globbed, for the reason `check-arbitration.mjs`
 * gives: a glob silently starts covering the next file somebody adds, and
 * adding a module to this surface should be a deliberate decision about which
 * rules apply to it, taken in the diff.
 */
export const ARTIFACTS_SOURCE = 'src/service/artifacts.ts';
export const RESOLVER_SOURCE = 'src/diff/artifact-path.ts';

/**
 * Field names that would mean a caller supplies a location.
 *
 * **Matched as an identifier being declared, not as a word.** The word "path"
 * appears throughout this surface legitimately — a stored path is returned, a
 * resolver is named for one — and a scan that matched the word would train
 * everybody to reword prose to appease it, which is how a check becomes a thing
 * people work around.
 *
 * So the shape is a **field on the request type**: `path:`, `filePath:` and
 * friends, in a type declaration. A request that carried one would be a caller
 * supplying a location, whatever it was called.
 */
export const FORBIDDEN_REQUEST_FIELDS = [
  'path',
  'filePath',
  'filepath',
  'file',
  'fileName',
  'filename',
  'location',
  'absolutePath',
  'directory',
  'dir',
  'root',
];

/**
 * The request type whose variants are checked.
 *
 * Read out of the source by name. If it is renamed, scan B reports that it
 * cannot find it rather than silently passing — a rule pointed at something
 * that has moved reports no violations, which reads exactly like a clean tree.
 */
export const REQUEST_TYPE = 'ArtifactRequest';

/** The single function permitted to join a stored path to the artifact root. */
export const RESOLVER_NAME = 'resolveArtifact';

/**
 * Filesystem calls that take a path directly.
 *
 * The bytes surface makes exactly one of these, and its argument must be the
 * resolver's return value. Anything else reaching a filesystem call is a second
 * route to the disk.
 */
export const FILESYSTEM_CALLS = ['readFile', 'readFileSync', 'createReadStream', 'open', 'stat'];

/** Strip line and block comments, so prose about a keyword is not a match. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Which line an offset falls on, for a message somebody can act on. */
function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * The body of the request type declaration, or `null` if it is not there.
 *
 * Deliberately shallow, and it **fails loudly rather than guessing**: a type
 * assembled some other way is reported as unreadable, because reporting "no
 * forbidden fields" for a type this cannot read would turn scan A into an
 * assertion over nothing.
 */
export function requestTypeBody(source) {
  const start = new RegExp(`export type ${REQUEST_TYPE}\\s*=`).exec(source);
  if (start === null) {
    return null;
  }

  // Read to the semicolon that ends the declaration, **counting braces on the
  // way**. A non-greedy match to the first semicolon stops inside the first
  // variant that declares more than one field, because the field separator
  // inside a braced variant is also a semicolon. The body then looks like a
  // variant with no identifier, and scan B fires on a type that is fine — a
  // false positive whose obvious fix is to loosen the scan.
  let depth = 0;
  for (let at = start.index + start[0].length; at < source.length; at += 1) {
    const character = source[at];
    if (character === '{' || character === '(' || character === '[') depth += 1;
    else if (character === '}' || character === ')' || character === ']') depth -= 1;
    else if (character === ';' && depth === 0) {
      return source.slice(start.index + start[0].length, at);
    }
  }

  // Ran off the end without closing. Unreadable rather than assumed clean, per
  // this function's own rule.
  return null;
}

/**
 * Split a union type's body into its variants, at the top level only.
 *
 * **Brace depth rather than a line split**, and the difference is not
 * cosmetic: a variant written across several lines — which is how any variant
 * with more than two fields ends up formatted — is cut in half by a split on
 * the union bar at the start of a line. The half containing the identifier then
 * looks like a variant that has none, and scan B reports a violation that is
 * really a formatting difference.
 *
 * That is the more dangerous direction of the two, because the obvious fix for
 * a false positive is to loosen the scan. Counting braces keeps the scan strict
 * and makes it read the type as written.
 */
export function unionVariants(body) {
  const variants = [];
  let depth = 0;
  let current = '';

  for (const character of body) {
    if (character === '{' || character === '(' || character === '[') depth += 1;
    if (character === '}' || character === ')' || character === ']') depth -= 1;

    if (character === '|' && depth === 0) {
      variants.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  variants.push(current);

  return variants.map((piece) => piece.trim()).filter((piece) => piece !== '');
}

/**
 * Scan A and B — the request type names identifiers and nothing else.
 *
 * - **A.** No variant declares a field whose name means a location.
 * - **B.** Every variant declares at least one field whose name ends in `Id`,
 *   which is what "the only strings it can be asked for are identifiers of
 *   rows" looks like in a type. A variant with no identifier at all is either
 *   addressing something by a means this rule has not considered, or is
 *   addressing nothing.
 */
export function checkRequestType(sources) {
  const failures = [];
  const source = stripComments(sources[ARTIFACTS_SOURCE]);
  const body = requestTypeBody(source);

  if (body === null) {
    failures.push({
      rule: 'artifact.no_request_path',
      scan: 'A',
      line: 0,
      detail:
        `${ARTIFACTS_SOURCE} declares no ${REQUEST_TYPE} this check can read. ` +
        'A rule pointed at a type that has moved reports nothing, which reads exactly like a clean tree.',
    });
    return failures;
  }

  for (const field of FORBIDDEN_REQUEST_FIELDS) {
    const declaration = new RegExp(`\\b(readonly\\s+)?${field}\\s*[?]?\\s*:`).exec(body);
    if (declaration !== null) {
      failures.push({
        rule: 'artifact.no_request_path',
        scan: 'A',
        line: lineAt(source, source.indexOf(body) + declaration.index),
        detail:
          `${REQUEST_TYPE} declares a field named ${field}, which is a caller supplying a location. ` +
          'Section 1.9: the only strings this surface can be asked for are identifiers of rows, and the path is looked up rather than supplied.',
      });
    }
  }

  // Scan B. Each variant must name an identifier.
  const variants = unionVariants(body);

  if (variants.length === 0) {
    failures.push({
      rule: 'artifact.no_request_path',
      scan: 'B',
      line: 0,
      detail: `${REQUEST_TYPE} has no variants this check can read.`,
    });
  }

  for (const variant of variants) {
    if (!/\b\w*[Ii]d\s*[?]?\s*:/.test(variant)) {
      failures.push({
        rule: 'artifact.no_request_path',
        scan: 'B',
        line: lineAt(source, source.indexOf(variant)),
        detail:
          `A variant of ${REQUEST_TYPE} names no identifier: ${variant.slice(0, 80)}. ` +
          'Every request addresses a row, so every variant carries the identifier of one.',
      });
    }
  }

  return failures;
}

/**
 * Scan C and E — the bytes surface reaches the disk once, through the
 * resolver.
 *
 * - **C.** Every filesystem call in the surface is passed the resolver's
 *   result, held in a local. Checked as "the resolver is called, and every
 *   filesystem call's argument is the variable it was assigned to".
 * - **E.** No exported function on this surface takes an argument annotated as
 *   a path. The type system is the strongest thing available here, and a
 *   parameter typed `string` and named for a location is the shape a
 *   well-meaning helper arrives in.
 */
export function checkResolverIsTheOnlyRoute(sources) {
  const failures = [];
  const source = stripComments(sources[ARTIFACTS_SOURCE]);

  // The resolver is called, and its result is bound to a name.
  const binding = new RegExp(`const\\s+(\\w+)\\s*=\\s*${RESOLVER_NAME}\\s*\\(`).exec(source);
  if (binding === null) {
    failures.push({
      rule: 'artifact.no_request_path',
      scan: 'C',
      line: 0,
      detail:
        `${ARTIFACTS_SOURCE} never calls ${RESOLVER_NAME}. ` +
        'Either it resolves a path another way, or it serves bytes from a path it did not resolve — the same finding either way.',
    });
    return failures;
  }
  const resolved = binding[1];

  for (const call of FILESYSTEM_CALLS) {
    const pattern = new RegExp(`\\b${call}\\s*\\(\\s*([^,)\\s]+)`, 'g');
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== resolved) {
        failures.push({
          rule: 'artifact.no_request_path',
          scan: 'C',
          line: lineAt(source, match.index),
          detail:
            `${ARTIFACTS_SOURCE} calls ${call} with ${match[1]}, which is not the value ${RESOLVER_NAME} returned. ` +
            'Every read goes through the resolver, or the resolver is not the only route to the disk.',
        });
      }
    }
  }

  // Scan E. A parameter named for a location on an exported function.
  for (const field of FORBIDDEN_REQUEST_FIELDS) {
    const parameter = new RegExp(
      `export (?:async )?function \\w+\\s*\\([^)]*\\b${field}\\s*:\\s*string`,
    ).exec(source);
    if (parameter !== null) {
      failures.push({
        rule: 'artifact.no_request_path',
        scan: 'E',
        line: lineAt(source, parameter.index),
        detail:
          `${ARTIFACTS_SOURCE} exports a function taking ${field}: string. ` +
          'A path-shaped argument on this surface is exactly the input section 7.3 says must not exist.',
      });
    }
  }

  return failures;
}

/**
 * Scan D — the resolver refuses what it must refuse.
 *
 * Checked in the resolver's own source rather than by importing it, for the
 * reason `check-arbitration.mjs` gives: this runs over a tree that may not
 * type-check, and it must be able to report why rather than fail to load.
 *
 * **What this scan is and is not.** It confirms the two refusals are *present*
 * — an absolute-path rejection and a containment check on the resolved value.
 * Whether they are *correct* is `tests/diff/artifact-path.test.ts`, which runs
 * the real function against real traversal shapes. Neither substitutes for the
 * other and this is the weaker of the two.
 */
export function checkResolverRefuses(sources) {
  const failures = [];
  const source = stripComments(sources[RESOLVER_SOURCE]);

  if (!new RegExp(`export function ${RESOLVER_NAME}\\s*\\(`).test(source)) {
    failures.push({
      rule: 'artifact.no_request_path',
      scan: 'D',
      line: 0,
      detail: `${RESOLVER_SOURCE} exports no ${RESOLVER_NAME} to check.`,
    });
    return failures;
  }

  // **Named on the stored value specifically**, not merely present in the
  // file. The resolver legitimately calls `isAbsolute` twice — once on the
  // input and once on the relative result — so a scan for the bare call is
  // satisfied by either, and deleting the input check would leave the scan
  // green. The parameter name is read from the signature rather than assumed,
  // so a rename is a rename and not a silent hole.
  const signature = new RegExp(`export function ${RESOLVER_NAME}\\s*\\(([^)]*)\\)`).exec(source);
  const parameters = (signature?.[1] ?? '').split(',').map((each) => each.trim());
  const storedParameter = parameters[parameters.length - 1]?.split(':')[0]?.trim();

  if (storedParameter === undefined || storedParameter === '') {
    failures.push({
      rule: 'artifact.no_request_path',
      scan: 'D',
      line: 0,
      detail: `${RESOLVER_SOURCE}: the signature of ${RESOLVER_NAME} could not be read, so the refusals below cannot be attributed to the stored path.`,
    });
  } else if (!new RegExp(`isAbsolute\\s*\\(\\s*${storedParameter}\\s*\\)`).test(source)) {
    failures.push({
      rule: 'artifact.no_request_path',
      scan: 'D',
      line: 0,
      detail:
        `${RESOLVER_SOURCE} does not test whether ${storedParameter}, the stored path, is absolute. ` +
        'Section 1.7a: every path stored is relative to the artifact root, never absolute.',
    });
  }

  // The containment assertion: the resolved value is compared back against the
  // root. `path.relative` is the shape that does it; a check on the string
  // before resolution is the one that does not, because `a/../../b` is
  // innocent-looking until it is resolved.
  if (!/relative\s*\(/.test(source) || !/startsWith\s*\(\s*['"]\.\.['"]\s*\)/.test(source)) {
    failures.push({
      rule: 'artifact.no_request_path',
      scan: 'D',
      line: 0,
      detail:
        `${RESOLVER_SOURCE} does not assert that the resolved path stays under the artifact root. ` +
        'A check on the stored string before resolution passes a path that only escapes once it is resolved.',
    });
  }

  return failures;
}

function read(pathToRead) {
  return readFileSync(pathToRead, 'utf8');
}

function requireFile(pathToCheck) {
  try {
    if (statSync(pathToCheck).isFile()) return true;
  } catch {
    /* falls through */
  }
  return false;
}

function missingSources() {
  return [ARTIFACTS_SOURCE, RESOLVER_SOURCE].filter((each) => !requireFile(each));
}

function treeDescription() {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'this tree';
}

export function main() {
  const absent = missingSources();
  if (absent.length > 0) {
    console.error(
      `artifact.no_request_path cannot run: ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not present.\n` +
        'A rule pointed at a file that has moved reports nothing, which reads exactly like a clean tree.',
    );
    return 1;
  }

  const sources = {
    [ARTIFACTS_SOURCE]: read(ARTIFACTS_SOURCE),
    [RESOLVER_SOURCE]: read(RESOLVER_SOURCE),
  };

  const failures = [
    ...checkRequestType(sources),
    ...checkResolverIsTheOnlyRoute(sources),
    ...checkResolverRefuses(sources),
  ];

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `${failure.rule} [scan ${failure.scan}]${failure.line > 0 ? ` ${ARTIFACTS_SOURCE}:${failure.line}` : ''}\n    ${failure.detail}\n`,
      );
    }
    console.error(
      `${failures.length} violation${failures.length === 1 ? '' : 's'} of artifact.no_request_path.\n\n` +
        'This rule asserts an absence, so there is no call site to inspect. The header of\n' +
        'scripts/check-artifact-path.mjs records exactly what it can and cannot prove — read it before\n' +
        'deciding a violation is a false positive.',
    );
    return 1;
  }

  console.log(
    `artifact.no_request_path holds on ${treeDescription()}: the bytes surface names rows, not paths, and reaches the disk only through ${RESOLVER_NAME}.\n` +
      "This means no path-shaped input exists on the scanned surface, not that a bypass is impossible — see this script's header.",
  );
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
