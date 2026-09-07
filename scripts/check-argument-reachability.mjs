#!/usr/bin/env node
/**
 * The reachability check: **a declared argument is read by something.**
 *
 * ── The gap this exists to close, stated as the thing that happened ─────
 *
 * `wait_ms` was declared on the tool surface, given a paragraph of
 * documentation, accepted without complaint, and **discarded**. One grep
 * found it: a single hit, and that hit was the declaration.
 *
 * The cost was not a missing feature, and this is the part worth being
 * precise about. A **missing** argument fails visibly — the caller gets a
 * refusal naming what it does not understand, and goes and reads something.
 * An **inert** one succeeds, so the caller draws a conclusion from it. A
 * session varied `--wait-ms` between two captures, saw the two frames
 * differ, concluded the page needed longer to settle, and filed a
 * high-severity finding against an application that did not have the fault.
 * The finding had to be withdrawn. If the argument did nothing, that
 * experiment varied nothing but wall-clock time, and the honest reading of
 * those two captures is that nobody knows what differed.
 *
 * **An argument that quietly does nothing does not merely fail to help: it
 * manufactures evidence, and the evidence is not marked as manufactured.**
 *
 * The class has produced more than one member. `BROKER_PRIVATE_BROWSER_ENGINE`
 * was declared, validated against three accepted words, and read by nothing —
 * the same defect wearing configuration's clothes rather than an argument's.
 * So this check ranges over both registries, for the reason given under
 * "Why configuration is checked by the same rule" below.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT "READ BY SOMETHING" MEANS HERE, WHICH IS THE WHOLE JUDGEMENT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The weak version of this check is worthless and worth naming so nobody
 * writes it later: *the identifier appears somewhere in the sources*. A name
 * appearing in the schema and again in a destructuring in the same file is
 * trivially satisfied and proves nothing — `wait_ms` would have passed it the
 * day it was inert, because its own declaration is an appearance. Any rule of
 * that shape passes vacuously.
 *
 * The strong version is: **the argument reaches the thing that acts on it.**
 * Stated for this codebase, which has the seam to make it decidable:
 *
 *   A name declared on the tool surface must be read at the bridge, in the
 *   branch belonging to its own operation.
 *
 * `src/service/bridge.ts` is the single translation point between a route's
 * vocabulary and the service's. Its own header says so: {@link Broker} is ten
 * typed methods, {@link BrokerService} is one method over an opaque record,
 * and bridging them "is therefore translation work with a home of its own".
 * Every wire-spelled name becomes a typed field there and nowhere else, always
 * through the same `argument(args, …)` reader. That is what makes the strong
 * question answerable statically rather than merely gestured at: there is one
 * place to look, and an argument that is not read there cannot be read at all,
 * because the record it arrived in does not travel any further.
 *
 * Three properties make this more than a second grep:
 *
 * 1. **The two files are on opposite sides of the seam.** A declaration lives
 *    in `src/tool/tools.ts`; the read that satisfies it must live in
 *    `src/service/bridge.ts`. A name cannot satisfy the rule by appearing
 *    twice in its own file, which is the trivial-satisfaction case.
 * 2. **Reads are attributed to the operation whose branch they sit in.** The
 *    dispatch is one `switch` over the operation name, so a read can be
 *    located to a branch. `browser_capture`'s `reason` is not satisfied by
 *    some other operation happening to read a `reason` — it must be read
 *    under `case 'capture'`.
 * 3. **Helper calls are followed.** A branch that calls `keyFrom(args)` or
 *    `actionFrom(args)` hands the whole record to a function that reads names
 *    out of it, so the names that helper reads count as read by that branch.
 *    Resolved transitively, because `actionFrom` calls `viewportFrom`.
 *
 * ── Why there is no waiver list for "consumed at the surface" ────────────
 *
 * The obvious objection is that some arguments legitimately never travel, and
 * `lease_key` is everyone's example: it authorises the call and is spent
 * doing it. The tempting answer is a list of exceptions, and it is the wrong
 * answer — a waiver list is where the next defect hides, because a name on it
 * is a name nothing checks ever again, and nothing distinguishes "deliberately
 * surface-consumed" from "somebody added it to the list to get green".
 *
 * **So there is no list, and none is needed, because the category dissolves.**
 * `lease_key` is read at the bridge like everything else — by `keyFrom`,
 * which is `argument(args, 'lease_key', 'leaseKey', 'key', 'lease')` — and the
 * helper-following rule above sees it. It satisfies the rule on the merits.
 * The same is true of every argument that looked like it might need an
 * exception: `session_id`, `purpose`, `rating`, `category`, `note`. An
 * argument "consumed at the surface" and an argument "forwarded to the
 * driver" are both **read**, and reading is the property this check is about;
 * where the value goes afterwards is the operation's business. Being spent
 * immediately is not the same as being ignored, and the check has no reason
 * to care about the difference.
 *
 * That is the principled account this rule owes, and it is stronger than a
 * waiver list precisely because it exempts nothing.
 *
 * ── Why configuration is checked by the same rule ───────────────────────
 *
 * A declared environment variable is the same claim in a different registry:
 * something a caller can set, that the service promises to act on. The
 * private-engine variable was validated — a wrong value was refused, naming
 * the three accepted words — and then never read, which is the inert-argument
 * failure with a sharper edge, since validation is itself evidence that the
 * setting works.
 *
 * The seam is different, so the rule is stated against the right seam rather
 * than forced into the argument one. `environment.ts` turns each declared key
 * into a field on the environment record; a field nothing outside that file
 * reads is a variable read by nothing. Two registries, one rule — *declared
 * means read* — and one check, because two checks drift.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PROVES, AND WHAT IT CANNOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * | Claim | Status |
 * |---|---|
 * | Every argument on the tool surface is read at the bridge, in its own operation's branch | **Checked**, over the whole declaration table |
 * | Every declared environment variable is read outside the file that declares it | **Checked**, over the whole declaration table |
 * | A newly declared argument is covered without anybody adding a case | **Yes** — the check ranges over the declaration, not over a list kept beside it |
 * | The value read is *forwarded correctly* to the driver | **NOT checked.** A branch that reads an argument and drops it on the floor passes this |
 * | The value read is the *right* one | **NOT checked.** Reading `selector` and passing it as `compareTo` passes this |
 *
 * **The last two rows are the honest limit, and they are why this is a floor
 * rather than a ceiling.** This proves an argument is not *inert*; it does not
 * prove it is *correct*. The instrument for correctness already exists and is
 * strictly stronger per argument — the conformance harness carries `detail` on
 * driver calls precisely so "a route that forwards an argument" and "one that
 * drops it" stop being indistinguishable, and `tests/service/argument-assembly.test.ts`
 * drives real argument vectors through the real service and reads what the
 * driver was told.
 *
 * ── Why this is static, when that runtime instrument exists ──────────────
 *
 * Because the two answer different questions, and the class needs the one
 * this answers: **exhaustiveness**.
 *
 * The runtime assertion is stronger about any argument it covers, and it is
 * table-driven over cases a person writes. The defect class here is precisely
 * *"nobody thought about this argument"* — so a runtime case for `wait_ms`
 * would have had to be written by the same person who forgot to read
 * `wait_ms`. `check-argument-refusals.mjs` states this limit about itself in
 * its own header: it "cannot discover an argument nobody thought of, which is
 * exactly how the original defect survived". A check whose coverage depends on
 * somebody remembering is not a check against forgetting.
 *
 * This one ranges over the **declaration table**, so its coverage is a
 * function of what is declared rather than of what somebody remembered to
 * test. Every argument is covered the moment it is declared, including the one
 * added in the same commit as the omission. Runtime is the better assertion;
 * static is the better census, and the class needs a census. The two compose:
 * a conformance case proving `reason` reaches its destination would be a
 * genuine strengthening, and would not make this redundant.
 *
 * ── The seeded violation ────────────────────────────────────────────────
 *
 * `--self-test` re-runs the argument scan against a copy of the tool surface
 * with the historical defect put back: `wait_ms` declared and consumed
 * nowhere. A check that cannot be made to fail proves nothing, and this
 * repository has shipped checks that could not observe the thing they checked
 * for. The self-test runs in the suite so the proof travels with the check
 * rather than living in a commit message.
 *
 * Usage:
 *   node scripts/check-argument-reachability.mjs
 *   node scripts/check-argument-reachability.mjs --self-test
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repository root, derived from this file rather than from the caller's directory. */
export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where the tool surface declares its arguments. */
export const TOOLS_SOURCE = path.join(repositoryRoot, 'src', 'tool', 'tools.ts');

/** The single translation point between a route's vocabulary and the service's. */
export const BRIDGE_SOURCE = path.join(repositoryRoot, 'src', 'service', 'bridge.ts');

/** Where configuration declares its variables. */
export const ENVIRONMENT_SOURCE = path.join(repositoryRoot, 'src', 'config', 'environment.ts');

/**
 * Files that may satisfy an environment variable's read.
 *
 * The whole of `src` **except** the file that declares them: a variable read
 * only by its own declaration is the defect. Expressed as an exclusion rather
 * than a list of permitted readers, so a new consumer needs no entry here.
 */
export const ENVIRONMENT_DECLARING_FILE = ENVIRONMENT_SOURCE;

/**
 * Strip comments and string literals from TypeScript source.
 *
 * Necessary rather than fastidious: this file's own prose names `wait_ms`
 * repeatedly, and `bridge.ts` discusses arguments in comments beside the code
 * that reads them. A scan that counted a mention in a comment as a read would
 * be satisfiable by writing a sentence about an argument — which is close to
 * exactly the failure being checked for, since `wait_ms` was documented
 * generously and read never.
 *
 * Deliberately a lexer over the four token classes that can contain text and
 * not a parser: the question asked of the result is only "which identifiers
 * appear in executable positions", and a lexer answers it without this check
 * carrying a dependency the gates that run it do not install.
 */
export function stripCommentsAndStrings(source) {
  let out = '';
  let index = 0;
  const length = source.length;

  while (index < length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === '/' && next === '/') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      index += 1;
      // Preserved as an empty pair of quotes so that a call's argument
      // positions stay countable: `argument(args, 'a', 'b')` must not
      // collapse into something that reads as a different call shape.
      out += quote + quote;
      while (index < length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

/**
 * Every argument the tool surface declares, as `{ tool, operation, name }`.
 *
 * Read out of the source text rather than by importing the module, for the
 * same reason `check-external-refs.mjs` and `check-doc-links.mjs` read text: the
 * gates that run these do so **with nothing installed**, so a tree with no
 * dependencies can still be checked. Importing `tools.ts` would pull the
 * operation table and the driver's guidance string behind it.
 *
 * `LEASE_KEY` is a shared constant spliced into most tools' argument lists
 * rather than written out per tool, so it is resolved to the name it declares
 * and attributed to every tool that includes it. A tool listing it is
 * declaring it just as surely as one writing it inline.
 */
export function declaredToolArguments(source = readFileSync(TOOLS_SOURCE, 'utf8')) {
  // **Read from the original text, not the stripped one**, unlike the bridge
  // scan below. A declaration *is* a string literal — `name: 'wait_ms'` — so
  // stripping would erase the very thing being collected. The asymmetry is
  // deliberate and is the right way round: over-collecting declarations is
  // safe (a name that is not really declared is looked for and found, or
  // reported), while over-collecting *reads* is not, because a name mentioned
  // in a comment would satisfy the rule without anything acting on it.
  const declarations = [];

  // The shared argument constants: `const LEASE_KEY = { name: 'lease_key', … }`.
  // Matched against the original text because the name is a string literal.
  const sharedNames = new Map();
  const sharedPattern = /const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]*)?=\s*\{[^}]*?name:\s*'([^']+)'/gs;
  for (const match of source.matchAll(sharedPattern)) {
    sharedNames.set(match[1], match[2]);
  }

  // Each tool: `{ name: 'browser_x', operation: 'x', … arguments: [ … ] }`.
  // Located by the `operation:` field, then the argument list that follows it
  // is read to its closing bracket.
  const toolPattern =
    /name:\s*'(browser_[a-z_]+)',\s*(?:\/\/[^\n]*\n\s*)*operation:\s*'([a-z_]+)'/g;
  const tools = [...source.matchAll(toolPattern)].map((match) => ({
    tool: match[1],
    operation: match[2],
    at: match.index,
  }));

  for (const [position, tool] of tools.entries()) {
    const nextTool = tools[position + 1];
    const region = source.slice(tool.at, nextTool === undefined ? source.length : nextTool.at);

    const argumentsAt = region.indexOf('arguments:');
    if (argumentsAt === -1) continue;
    const listRegion = region.slice(argumentsAt);

    // Names written inline in this tool's argument list.
    for (const match of listRegion.matchAll(/name:\s*'([a-z_]+)'/g)) {
      declarations.push({ tool: tool.tool, operation: tool.operation, name: match[1] });
    }
    // Shared constants spliced in by identifier.
    for (const [identifier, name] of sharedNames) {
      if (new RegExp(`\\b${identifier}\\b`).test(listRegion)) {
        declarations.push({ tool: tool.tool, operation: tool.operation, name });
      }
    }
  }

  return declarations;
}

/**
 * The names each helper in the bridge reads out of an argument record.
 *
 * A helper is any function taking the whole `args` record; the names it reads
 * are every literal it passes to `argument(…)`, plus the names read by any
 * other helper it calls. Resolved to a fixed point, because `actionFrom` calls
 * `viewportFrom` which calls `argument` — one pass would miss the second hop
 * and report a false failure, which is the expensive direction for a gate.
 */
export function helperReads(bridgeCode) {
  const helpers = new Map();

  // `function nameFrom(args: …) { … }` — located by name, bounded by the next
  // top-level `function` keyword, which is how this file is laid out.
  const boundaries = [...bridgeCode.matchAll(/\nfunction\s+([A-Za-z0-9_]+)\s*\(/g)];
  for (const [position, match] of boundaries.entries()) {
    const name = match[1];
    const start = match.index;
    const next = boundaries[position + 1];
    const body = bridgeCode.slice(start, next === undefined ? bridgeCode.length : next.index);
    helpers.set(name, {
      names: new Set(argumentNamesIn(body)),
      calls: new Set([...body.matchAll(/\b([A-Za-z0-9_]+)\s*\(\s*args\b/g)].map((call) => call[1])),
    });
  }

  // Fixed point: a helper reads what it reads, plus what its callees read.
  let changed = true;
  while (changed) {
    changed = false;
    for (const helper of helpers.values()) {
      for (const callee of helper.calls) {
        const target = helpers.get(callee);
        if (target === undefined) continue;
        for (const name of target.names) {
          if (!helper.names.has(name)) {
            helper.names.add(name);
            changed = true;
          }
        }
      }
    }
  }

  return helpers;
}

/**
 * The literal names passed to `argument(args, …)` in a region of code.
 *
 * String literals have already been emptied by the stripper, so the names are
 * recovered from the original text of the same region. A spread —
 * `argument(args, ...preference.spellings)` — yields no literal name and is
 * simply not a read of any name this check knows about, which is correct: it
 * reads names from a table, and no argument on the tool surface is declared
 * that way.
 */
function argumentNamesIn(region) {
  const names = [];
  for (const match of region.matchAll(/\bargument\(\s*args\s*,([^)]*)\)/g)) {
    for (const literal of match[1].matchAll(/'([^']+)'/g)) {
      names.push(literal[1]);
    }
  }
  return names;
}

/**
 * Which argument names the bridge reads, per operation.
 *
 * The dispatch is one `switch` over the operation name, so each `case` is a
 * region and every name read inside it — directly, or by a helper it hands the
 * record to — is read *for that operation*. Attribution is what stops a name
 * being satisfied by an unrelated operation that happens to read the same word.
 */
export function bridgeReadsByOperation(source = readFileSync(BRIDGE_SOURCE, 'utf8')) {
  const helpers = helperReads(source);
  const byOperation = new Map();

  const cases = [...source.matchAll(/\n\s*case '([a-z_]+)':?\s*\{?/g)];
  for (const [position, match] of cases.entries()) {
    const operation = match[1];
    const next = cases[position + 1];
    const body = source.slice(match.index, next === undefined ? source.length : next.index);

    const names = byOperation.get(operation) ?? new Set();
    for (const name of argumentNamesIn(body)) names.add(name);
    // Helpers handed the whole record read names on this branch's behalf.
    for (const call of body.matchAll(/\b([A-Za-z0-9_]+)\s*\(\s*(?:db\s*,\s*)?args\b/g)) {
      const helper = helpers.get(call[1]);
      if (helper === undefined) continue;
      for (const name of helper.names) names.add(name);
    }
    byOperation.set(operation, names);
  }

  return byOperation;
}

/**
 * Declared things this check knowingly passes, each with the reason.
 *
 * ── Why a waiver exists at all, having argued against a waiver list ──────
 *
 * The rule for *arguments* needs no exceptions and has none: the
 * surface-consumed category dissolves, so every declared argument is expected
 * to be read and none is excused. This list is for the configuration half, it
 * has one entry, and the distinction it turns on is worth stating because it
 * is what stops the list growing.
 *
 * **A waiver records that the defect is real and unfixed here — never that it
 * is acceptable.** It is the `external-ref-ok` convention: the reason is
 * written in the diff, so a reviewer sees the claim being made rather than an
 * absence they would have to notice. An entry whose reason does not name why
 * the fix is out of reach, and what would close it, does not belong.
 *
 * **A waiver is not available for a tool argument.** The argument half takes
 * no exceptions, deliberately: the historical defect was an argument, and a
 * check that could be quieted on the exact class it exists for would be worth
 * nothing. Adding a waiver facility to that half is the change to refuse.
 */
export const WAIVERS = [
  {
    what: 'BROKER_PRIVATE_BROWSER_ENGINE',
    // The defect is genuine — this is the second member of the class the check
    // was written for, and it is not being disputed. What blocks it is that
    // honouring it is an architectural change rather than a missed line:
    // `engine` is an option on the *driver*, resolved once in
    // `RealDriverOptions`, and one driver instance serves every browser in a
    // process. Nothing at the launch site distinguishes the two kinds —
    // `ColdStartRequest` carries `mode`, which is headed/headless and not
    // regular/private — so honouring a per-kind engine means threading the
    // kind through the driver seam and giving up one-driver-per-process.
    //
    // It is waived rather than deleted because `.env.example`, `README.md` and
    // `DECISIONS.md` §13i all publish it, and `DECISIONS.md` states the
    // promise it does not keep in as many words: "may differ". Quietly
    // dropping a documented setting is a user-facing change that belongs in
    // its own row with its own reasoning, not folded into a build rule.
    //
    // Closing it means either implementing the per-kind engine or removing the
    // variable and every published mention of it. Tracked as subtask
    // 58f88352, which was closed won't-do — so this entry is the record that
    // the declaration outlived that decision.
    why: 'declared and validated, but a per-kind engine cannot be honoured while one driver serves every browser in the process; the fix is architectural or a documented removal, and subtask 58f88352 closed won’t-do',
  },
];

/**
 * Every environment variable the build declares, from the declaration table.
 */
export function declaredVariables(source = readFileSync(ENVIRONMENT_SOURCE, 'utf8')) {
  return [...source.matchAll(/key:\s*'(BROKER_[A-Z0-9_]+)'/g)].map((match) => match[1]);
}

/**
 * The field each declared variable becomes on the environment record.
 *
 * `BROKER_TAB_BUDGET` is assembled as `tabBudget: getNumber('BROKER_TAB_BUDGET')`,
 * so the field is read off the assignment rather than derived by transforming
 * the key — a derivation would guess, and the two disagree in at least one
 * place already (`BROKER_DB` becomes both `databasePath` and
 * `configuredDatabasePath`).
 */
export function environmentFieldsFor(variable, source) {
  const fields = [];
  const pattern = new RegExp(`([A-Za-z0-9_]+):\\s*[A-Za-z0-9_.]*\\(?\\s*'${variable}'`, 'g');
  for (const match of source.matchAll(pattern)) {
    // `key: 'BROKER_X'` is the declaration itself, not an assembled field, and
    // it must be discarded rather than counted. Counting it was a real defect
    // in an earlier draft of this file: `key` occurs in nearly every source in
    // the tree, so every variable resolved a "reader" and the whole
    // configuration half reported green vacuously — including the inert
    // variable it was written to catch. A check that passes for a reason
    // unrelated to the property it asserts is worse than an absent one, and
    // this is the exact shape of that failure, so it is named here.
    if (match[1] === 'key') continue;
    fields.push(match[1]);
  }
  // `configuredDatabasePath: env['BROKER_DB']` — read from the record directly
  // rather than through a getter.
  const direct = new RegExp(`([A-Za-z0-9_]+):\\s*env\\[\\s*'${variable}'\\s*\\]`, 'g');
  for (const match of source.matchAll(direct)) {
    fields.push(match[1]);
  }
  // `const regularBrowsers = getList('BROKER_REGULAR_BROWSERS')`, put on the
  // record later by shorthand. The binding is the field, and missing this form
  // is not a harmless gap: it made the check report the two browser-name lists
  // as unread when both are read all over the tree. **A gate that cries wolf
  // gets switched off**, and a false failure on a real argument costs more
  // than the defect it was hunting, so the assembling forms are followed
  // rather than assumed to be one shape.
  const bound = new RegExp(
    `const\\s+([A-Za-z0-9_]+)\\s*=\\s*[A-Za-z0-9_.]*\\(\\s*'${variable}'`,
    'g',
  );
  for (const match of source.matchAll(bound)) {
    fields.push(match[1]);
  }
  return [...new Set(fields)];
}

/**
 * Whether any file in the tree, other than the declaring one, reads a field.
 *
 * The declaring file is excluded because a variable read only where it is
 * declared is exactly the defect: `privateBrowserEngine` appeared twice in the
 * whole of `src`, and both appearances were its own type field and its own
 * assignment.
 */
function fieldIsReadOutsideDeclaration(field, sources) {
  const pattern = new RegExp(`\\b${field}\\b`);
  for (const [file, text] of sources) {
    if (file === ENVIRONMENT_DECLARING_FILE) continue;
    if (pattern.test(stripCommentsAndStrings(text))) return true;
  }
  return false;
}

/** Every `.ts` file under `src`, as `[absolutePath, text]`. */
export function sourceFiles(root = path.join(repositoryRoot, 'src')) {
  const collected = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) collected.push([full, readFileSync(full, 'utf8')]);
    }
  };
  walk(root);
  return collected;
}

/**
 * Run the argument half of the check.
 *
 * Separated from the configuration half because the self-test seeds only this
 * one: the historical defect is an argument, and a self-test that reproduced
 * something else would be proving a different mechanism fires.
 */
export function checkArguments({ toolsSource, bridgeSource } = {}) {
  const declarations = declaredToolArguments(toolsSource ?? readFileSync(TOOLS_SOURCE, 'utf8'));
  const reads = bridgeReadsByOperation(bridgeSource ?? readFileSync(BRIDGE_SOURCE, 'utf8'));

  const failures = [];
  let checked = 0;

  for (const declaration of declarations) {
    checked += 1;
    const readNames = reads.get(declaration.operation);
    if (readNames === undefined) {
      failures.push(
        `${declaration.tool}: the bridge has no branch for operation "${declaration.operation}", ` +
          `so nothing there can read any of its arguments.`,
      );
      continue;
    }
    if (!readNames.has(declaration.name)) {
      failures.push(
        `${declaration.tool} declares "${declaration.name}" and the bridge never reads it under ` +
          `case '${declaration.operation}'. A caller can pass it, will not be refused, and ` +
          `nothing will act on it — which is the inert-argument defect: it does not fail, it ` +
          `manufactures evidence. Read it in src/service/bridge.ts, or stop declaring it.`,
      );
    }
  }

  return { failures, checked, declarations };
}

/** Run the configuration half: a declared variable is read outside its declaration. */
export function checkConfiguration() {
  const source = readFileSync(ENVIRONMENT_SOURCE, 'utf8');
  const variables = declaredVariables(source);
  const sources = sourceFiles();

  const failures = [];
  const waived = [];
  let checked = 0;

  // A waiver naming something absent from the declaration table is a stale
  // excuse, and stale excuses are how a waiver list becomes the place defects
  // hide. Failing on it costs one line to delete and keeps the list honest.
  for (const waiver of WAIVERS) {
    if (!variables.includes(waiver.what)) {
      failures.push(
        `${waiver.what} is waived by this check and is absent from the declaration table. Delete ` +
          `the waiver: an ` +
          `excuse for something that does not exist can only ever hide the next thing that takes ` +
          `its name.`,
      );
    }
  }

  for (const variable of variables) {
    checked += 1;
    const fields = environmentFieldsFor(variable, source);
    if (fields.length === 0) {
      failures.push(
        `${variable} is declared and never assembled into the environment record, so nothing ` +
          `can read it.`,
      );
      continue;
    }
    const read = fields.some((field) => fieldIsReadOutsideDeclaration(field, sources));
    const waiver = WAIVERS.find((entry) => entry.what === variable);

    if (read && waiver !== undefined) {
      // The waiver has been overtaken by a fix. Reported as a failure rather
      // than ignored, for the same reason a stale one is: a waiver nobody has
      // to remove is a permanent hole, and this is the moment it can be
      // removed with certainty rather than by somebody guessing later.
      failures.push(
        `${variable} is waived by this check and is now read after all. Delete the waiver — the ` +
          `thing it excused has been fixed, and leaving it behind would let the defect return ` +
          `unnoticed under the same name.`,
      );
      continue;
    }

    if (!read) {
      if (waiver !== undefined) {
        waived.push(`${variable}: ${waiver.why}`);
        continue;
      }
      failures.push(
        `${variable} is declared — and validated, which is worse, because a caller who sets it ` +
          `wrongly is refused and reasonably concludes it works — but ${fields
            .map((field) => `"${field}"`)
            .join(' / ')} is read nowhere outside src/config/environment.ts. Read it where it ` +
          `should take effect, or stop declaring it.`,
      );
    }
  }

  return { failures, waived, checked, variables };
}

/**
 * The seeded violation: the tool surface with `wait_ms` inert again.
 *
 * The declaration is left exactly as it ships and the *bridge* is edited
 * instead — the read is removed — because that is the direction the historical
 * defect ran: the argument was declared and documented first, and nothing was
 * ever written to consume it. Seeding it this way also proves the check is
 * reading the bridge rather than merely pairing two lists in `tools.ts`.
 */
export function seededDefect() {
  const bridge = readFileSync(BRIDGE_SOURCE, 'utf8');
  const seeded = bridge.replace(
    /waitMs:\s*asInteger\(argument\(args,\s*'wait_ms',\s*'waitMs'\)\),?/,
    '',
  );
  if (seeded === bridge) {
    throw new Error(
      "the self-test could not find the bridge's read of `wait_ms` to remove — the seed no " +
        'longer reproduces the historical defect, so it proves nothing. Fix the seed.',
    );
  }
  return { toolsSource: readFileSync(TOOLS_SOURCE, 'utf8'), bridgeSource: seeded };
}

/** Both halves, against the tree as it is. */
export function runReachabilityCheck() {
  const args = checkArguments();
  const configuration = checkConfiguration();
  return {
    failures: [...args.failures, ...configuration.failures],
    waived: configuration.waived,
    checkedArguments: args.checked,
    checkedVariables: configuration.checked,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  if (process.argv.includes('--self-test')) {
    const seeded = checkArguments(seededDefect());
    const caught = seeded.failures.some((failure) => failure.includes('wait_ms'));
    if (caught) {
      console.log('Self-test passed: the check goes red on the historical inert `wait_ms`.');
      for (const failure of seeded.failures) console.log(`  would fail: ${failure}`);
    } else {
      console.error(
        'Self-test FAILED: `wait_ms` was made inert and the check stayed green, so it cannot ' +
          'observe the defect it exists for.',
      );
      process.exitCode = 1;
    }
  } else {
    const result = runReachabilityCheck();
    // Printed on every run, including a passing one: a waiver that is only
    // visible in the source is one nobody is reminded of.
    for (const waiver of result.waived) {
      console.log(`  waived ${waiver}`);
    }
    if (result.failures.length > 0) {
      console.error('The argument-reachability check failed:\n');
      for (const failure of result.failures) console.error(`  FAIL ${failure}`);
      console.error(
        '\nA declared argument or variable that nothing reads does not fail visibly — it ' +
          'succeeds, and the caller draws a conclusion from it.',
      );
      process.exitCode = 1;
    } else {
      console.log(
        `Argument-reachability check passed: ${String(result.checkedArguments)} declared tool ` +
          `arguments are read at the bridge under their own operation, and ` +
          `${String(result.checkedVariables)} declared variables are read outside their declaration.`,
      );
    }
  }
}
