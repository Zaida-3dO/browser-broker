#!/usr/bin/env node
/**
 * `tests.injection_waived` — an injected test has to say why it is admissible.
 *
 * ── What an "injected test" is, and why it is worth a check ─────────────
 *
 * Most tests here drive the real thing. A few hand the entry point a
 * substitute service (`service: { perform: … }`) instead of letting it reach
 * the one the binary would use. That is sometimes the only way to reach a
 * state — and sometimes it is a way to assert something the spawn-driven
 * gates already own, more weakly, in a copy that drifts.
 *
 * The repository already ruled on which is which. The rule was that an
 * injection is admissible only when it:
 *
 *   1. reaches a state unreachable through every shipped binary;
 *   2. names the specific faithful mutation it kills that no spawn-driven
 *      gate can;
 *   3. duplicates no assertion a spawn-driven gate already owns;
 *   4. is deleted and relocated into the spawn-driven gate as soon as the
 *      state becomes reachable.
 *
 * ── Why this script exists at all ───────────────────────────────────────
 *
 * That rule lived in a comment at the top of one test file, and **prose does
 * not bind the next author**. It went stale exactly as predicted: the header
 * asserted "this build attaches no session source anywhere, so no binary can
 * produce `pageDriven: true`" long after `src/bin/broker.ts` began passing
 * `session: runtime.session`. The justification for an injection had expired
 * and nothing noticed, because nothing was looking.
 *
 * So the parts of the rule a machine can hold are held here.
 *
 * ── What this checks, stated honestly, including what it cannot ─────────
 *
 * **Checked.** Every `service:` injection under `tests/` carries a waiver
 * that gives a real reason, and that reason is not a placeholder. An
 * unwaived injection fails; a waiver that says nothing fails in its own
 * right, the same way an empty `external-ref-ok` does.
 *
 * **NOT checked, and deliberately.** Whether the reason is *true*. No script
 * can decide that a state is genuinely unreachable through every binary, or
 * that no spawn-driven gate owns the assertion — points 1, 2 and 3 are
 * judgement, and a check that pretended to decide them would be the same
 * hollow reassurance this guards against. What the gate does is make the claim
 * **explicit, attributable and visible in the diff**, so a reviewer is asked
 * the question at the moment the injection is added rather than years later.
 * That is the same bargain `check-external-refs.mjs` strikes: costing an
 * explanation was always the design, and it can only be evaded *visibly*.
 *
 * This is a text scan, not a type-aware one. It reads the shape
 * `service:` followed by an object or an identifier in a test file; it does
 * not resolve types and cannot see an injection assembled at a distance and
 * spread in. That limit is stated rather than papered over.
 */

import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * The injection shape.
 *
 * `run(argv, { service: … })` and the helper signatures that pass one
 * through. Matching the property rather than the type keeps this readable
 * without a compiler, at the cost noted in the header.
 */
const INJECTION = /(^|[\s{,(])service\s*:/;

/**
 * A declaration of the seam is not a use of it.
 *
 * A helper that *accepts* a service in its parameter list, an interface that
 * declares the field as optional, or a `const service: BrokerService = …`
 * that merely names one, is plumbing rather than an injected test — the
 * injection is the moment a value is handed to the entry point, which is the
 * call site. Without this the check would demand a waiver on every function
 * signature and local binding that mentions the word, which teaches authors
 * to waive reflexively, and a reflexive waiver is worth nothing.
 *
 * Each of these three shapes is pinned by a fixture in the self-test, so
 * narrowing the check cannot silently stop it seeing a real injection.
 */
const DECLARATION =
  /service\s*\?\s*:|(?:const|let|var|readonly)\s+service\s*:|service\s*:\s*BrokerService\s*[;,)}]/;

/**
 * Blank out string and template literals before looking for an injection.
 *
 * `service:` appears inside assertion messages and other prose — there is one
 * in the tree reading "must reach the service: a surface that declares an
 * argument and drops it". That is English, not an injection, and demanding a
 * waiver for it would be the check crying wolf on its very first run. Quoted
 * runs are replaced with padding of the same length so that reported column
 * numbers still point at the right character.
 *
 * Escapes are honoured so an escaped quote does not end the run early. This
 * is a lexical approximation, not a parser; it is enough for the shape being
 * matched and its limits are stated in the header.
 */
export function withoutStringLiterals(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '' + String.fromCharCode(92)) {
        out += '  '.slice(0, Math.min(2, line.length - i));
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out += ch;
        continue;
      }
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/** The waiver marker, and its reason. Mirrors `check-external-refs.mjs`. */
const WAIVER = /injected-test-ok(-next-line)?:(.*)$/i;

/** A waiver has to actually say something. Roughly four words. */
const MIN_REASON_LENGTH = 12;

/** …and three of them have to carry information. See `FILLER_WORDS`. */
const MIN_REASON_WORDS = 3;

/**
 * A waiver covers the FILE it appears in, and that is a deliberate choice.
 *
 * The obvious alternative — one waiver per injecting line — was written
 * first and measured against the tree. It demanded **19 waivers across 5
 * files** for what are really about five injection decisions, because a
 * suite that injects once passes that service down through a dozen call
 * sites. Nineteen copies of the same paragraph is not nineteen
 * justifications; it is one justification and eighteen invitations to
 * copy-paste it without reading. A check that trains people to waive
 * reflexively has made waiving meaningless, which is the failure this whole
 * script exists to prevent.
 *
 * File granularity matches how the justifications are actually written here:
 * a docblock at the top of the suite explaining why *this suite* injects, of
 * which there are two good examples already in the tree. So the marker goes
 * in that docblock, once, and is read by anyone opening the file.
 *
 * The cost is stated plainly: a file already carrying a waiver can gain a
 * second, unrelated injection without being asked to justify it. That is
 * real, and it is the price of the marker meaning something where it does
 * appear. A reviewer still sees the new injection in the diff.
 */

/**
 * Words a reason can be made entirely of while explaining nothing.
 *
 * Taken from `check-external-refs.mjs`, whose reasoning applies unchanged:
 * `this is fine`, `TODO TODO TODO` and `lorem ipsum dolor` are each three
 * words and twelve-plus characters, and each says exactly as much as an
 * empty waiver. Ordinary English, publishing nothing, and gameable only by
 * writing a sentence that reads like a reason into the diff — which was
 * always the point.
 */
const FILLER_WORDS = new Set([
  // Grammar.
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'but',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'in',
  'into',
  'is',
  'it',
  'its',
  'my',
  'of',
  'on',
  'or',
  'our',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'this',
  'those',
  'to',
  'was',
  'were',
  'will',
  'with',
  'we',
  'you',
  'your',
  'not',
  'no',
  'here',
  // Assertions that a thing is acceptable, which is the claim under review.
  'fine',
  'good',
  'great',
  'harmless',
  'irrelevant',
  'just',
  'nice',
  'obviously',
  'okay',
  'really',
  'safe',
  'sure',
  'true',
  'valid',
  'whatever',
  'needed',
  'necessary',
  'required',
  'todo',
  'fixme',
  'xxx',
  // The vocabulary of the thing being waived, which restates rather than explains.
  'test',
  'tests',
  'service',
  'inject',
  'injects',
  'injected',
  'injection',
  'waiver',
  'waived',
  'waive',
  'ok',
]);

/**
 * Strip the comment furniture from a captured reason.
 *
 * `// injected-test-ok: because X` and ` * injected-test-ok: because X`
 * both read as "because X".
 */
export function cleanReason(raw) {
  return raw
    .replace(/-->\s*$/, '')
    .replace(/\*\/\s*$/, '')
    .replace(/["'`]\s*[,;)]*\s*$/, '')
    .trim();
}

/**
 * A length check alone lets `xxxxxxxxxxxx` through, and a word count alone
 * lets `this is fine` through. So require three **distinct, non-filler**
 * words — distinctness is what rejects `capture capture capture`, one real
 * word padded out to three.
 */
export function isRealReason(reason) {
  if (reason.length < MIN_REASON_LENGTH) return false;
  const substantive = new Set(
    reason
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length >= 2 && !FILLER_WORDS.has(word)),
  );
  return substantive.size >= MIN_REASON_WORDS;
}

/**
 * Find every violation in one file's text.
 *
 * Returns `{ line, column, kind, text }` where `kind` is
 * `"unwaived-injection"` for an injection nothing justifies, and
 * `"empty-waiver"` for a waiver that silences the check without saying why.
 *
 * **A waiver inside a fenced code block is documentation, not a waiver** —
 * the same carve-out `check-external-refs.mjs` makes, and for the same
 * reason: a file teaching the syntax would otherwise excuse anything pasted
 * into that block later.
 */
export function findViolations(text) {
  const lines = text.split(/\r?\n/);

  /** Whether the file carries a waiver at all, and the bad ones. */
  let fileIsWaived = false;
  const violations = [];
  const injections = [];

  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const lineNumber = index + 1;
    const found = line.match(WAIVER);
    if (found) {
      const reason = cleanReason(found[2] ?? '');
      if (isRealReason(reason)) {
        fileIsWaived = true;
      } else {
        violations.push({
          line: lineNumber,
          column: (found.index ?? 0) + 1,
          kind: 'empty-waiver',
          text: line,
        });
      }
      // The marker mentions the word; it is never itself an injection.
      return;
    }

    const code = withoutStringLiterals(line);
    if (!INJECTION.test(code)) return;
    if (DECLARATION.test(code)) return;

    injections.push({
      line: lineNumber,
      column: code.search(INJECTION) + 1,
      kind: 'unwaived-injection',
      text: line,
    });
  });

  // Only the FIRST injection in an unwaived file is reported. One file needs
  // one waiver, so one file should produce one instruction to write it —
  // listing a dozen sites that a single marker would silence reads as a dozen
  // problems and buries what to actually do.
  if (!fileIsWaived && injections.length > 0) {
    violations.push({
      ...injections[0],
      others: injections.length - 1,
    });
  }

  return violations.sort((a, b) => a.line - b.line);
}

/**
 * This gate's own self-test is not scanned, and neither is this script.
 *
 * The self-test's whole job is to carry fixtures of the shapes the gate
 * catches — unwaived injections and placeholder waivers — so scanning it
 * reports every fixture as a violation. Exempting it is the same bargain
 * `check-external-refs.mjs` strikes with its own `SELF_EXEMPT`, and it is
 * exported so a test can pin the list: one name added here silences a file
 * completely, which is worth being deliberate about.
 */
export const SELF_EXEMPT = [
  'scripts/check-injected-tests.mjs',
  'tests/check-injected-tests.test.mjs',
];

/** Test sources only. The rule is about tests; product code is not in scope. */
export function isScannable(path) {
  const normalised = path.replace(/\\/g, '/');
  if (SELF_EXEMPT.includes(normalised)) return false;
  return /^tests\/.*\.(ts|mts|mjs|js)$/.test(normalised);
}

function trackedFiles() {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed: ${result.stderr || result.error?.message || 'unknown error'}`,
    );
  }
  return [...new Set(result.stdout.split('\0').filter(Boolean))];
}

const WHY = {
  'unwaived-injection':
    'an injected service reaches past the binary a person installs. Say why the state is unreachable through every shipped binary, and which faithful mutation this kills that no spawn-driven gate can, with `// injected-test-ok: <reason>`',
  'empty-waiver':
    'a waiver has to say why the injection is admissible. Three distinct, non-filler words at minimum',
};

function describe(violation, path) {
  return [
    `${path}:${violation.line}:${violation.column}  [${violation.kind}]`,
    `    ${violation.text.trim()}`,
    `    ↳ ${WHY[violation.kind]}`,
  ].join('\n');
}

export function main(argv) {
  const explicit = argv.slice(2);
  const listed = explicit.length > 0 ? explicit : trackedFiles();
  const paths = listed.filter(isScannable);

  const failures = [];
  let scanned = 0;
  let waived = 0;

  for (const path of paths) {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue; // deleted between listing and reading; nothing to check
    }
    if (!stats.isFile()) continue;

    scanned += 1;
    const contents = readFileSync(path, 'utf8');
    for (const violation of findViolations(contents)) {
      failures.push(describe(violation, path));
    }
    for (const line of contents.split(/\r?\n/)) {
      if (WAIVER.test(line)) waived += 1;
    }
  }

  // Say what was *not* read as well as what was, so coverage cannot fall
  // silently — the failure mode of every check that only reports success.
  const coverage = `Scanned ${scanned} test file${scanned === 1 ? '' : 's'} of ${listed.length} tracked`;
  const waiverNote =
    waived > 0 ? ` ${waived} injection waiver${waived === 1 ? '' : 's'} active.` : '';

  if (failures.length === 0) {
    console.log(
      `tests.injection_waived: ok — ${coverage}: every injected test says why.${waiverNote}`,
    );
    return 0;
  }

  console.error(`tests.injection_waived: FAILED\n`);
  console.error(failures.join('\n\n'));
  console.error(
    `\n${failures.length} injected test${failures.length === 1 ? '' : 's'} without a reason that holds.\n\n` +
      "An injection is admissible only when it reaches a state unreachable through every shipped binary, names the faithful mutation it kills, duplicates no assertion a spawn-driven gate owns, and is DELETED once the state becomes reachable. This check holds the last of those to a written reason; the rest is the reviewer's call.\n",
  );
  return 1;
}

// Run only when invoked directly, so the self-test can import `findViolations`
// without the process exiting underneath it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
