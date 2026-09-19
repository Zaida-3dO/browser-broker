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
 * The class is not confined to tool arguments. A declared environment
 * variable, validated against a set of accepted words and then read by
 * nothing, is the same defect wearing configuration's clothes rather than an
 * argument's. So this check ranges over both registries, for the reason given
 * under "Why configuration is checked by the same rule" below.
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
 * through the same `argument(args, …)` reader. That is what makes the question
 * answerable statically rather than merely gestured at: there is one place to
 * look, and an argument that is not read there cannot be read **anywhere
 * downstream**, because the record it arrived in does not travel any further.
 *
 * ── What that does and does not license, stated precisely ───────────────
 *
 * Being read at the bridge is **necessary and not sufficient**, and the
 * difference is not pedantry — it is the whole of what this check can be
 * relied upon for. An earlier version of this paragraph said *"an argument
 * that is not read there cannot be read at all"*, which reads as though the
 * converse held too, and **it does not**.
 *
 * `tier` is the counter-example, and it is this repository's own:
 *
 *   `tier` WAS read at the bridge — `src/service/bridge.ts`, under
 *   `case 'capture'`, `const tier = argument(args, 'tier')` — was validated,
 *   was packed into a request object, and was then **dropped at the single
 *   `takeCapture` call site**, which spread only `fullPage` and `selector`.
 *   Every capture was taken at the default rung regardless of what was asked
 *   for, `tier: "max"` charged the caller a written 8–200 character
 *   justification for it, and **this check passed throughout.**
 *
 * It compiled silently because TypeScript's excess-property check does not
 * apply to conditionally-spread properties, so the bridge could assemble a
 * field the seam below it had no home for and nothing said a word.
 *
 * So the honest statement of the seam argument is the contrapositive only:
 * **not read at the bridge ⇒ dead. Read at the bridge ⇒ nothing yet.** The
 * value has to survive every layer below, and this check watches none of them.
 * The table under "WHAT THIS PROVES, AND WHAT IT CANNOT" has always said so in
 * its last two rows; this prose used to contradict it, and the prose is what
 * people read. A check that overstates its reach is worse than one that admits
 * its limit, because a reader who believes the overstatement stops looking —
 * which is, precisely and literally, what happened to `tier`.
 *
 * What covers the rest of the journey is named under "Why this is static" at
 * the foot of this header: a runtime assertion that the argument **changes the
 * observable result**. That instrument now exists for capture — see
 * `ArgumentEffect` in `src/adapter/conformance/case.ts`, declared on a case as
 * `expect.effects`.
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
 * | The value read is *forwarded correctly* to its consumer | **NOT checked here.** A branch that reads an argument and drops it on the floor passes this — `tier` did, for the whole life of capture. Covered for capture's `tier` by the `expect.effects` case in `src/adapter/conformance/cases.ts`, and by nothing for any other argument |
 * | The value read is the *right* one | **NOT checked.** Reading `selector` and passing it as `compareTo` passes this |
 *
 * **The last two rows are the honest limit, and they are why this is a floor
 * rather than a ceiling.** This proves an argument is not *inert* **at the
 * bridge**; it does not prove it survives the layers below, and it does not
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
 * a conformance case proving `reason` reaches its destination is a genuine
 * strengthening, and does not make this redundant.
 *
 * **That case now exists, for `tier`.** The `expect.effects` declaration in
 * `src/adapter/conformance/cases.ts` asserts that `tier` changes the
 * observable result — across every adapter the conformance matrix covers,
 * because the effect is declared once per operation and crossed with each
 * route.
 *
 * **`reason` is a different matter, and saying so is the point of this
 * header.** It cannot be asserted the same way, because it is not observable
 * from any route: it is written to the `captures` row and read back by no
 * operation a case can reach. A conformance case can only require that
 * passing it does not prevent the escalation it accompanies. Closing it
 * properly needs a read path to a capture's own record, which does not exist.
 * That is a smaller and more honest claim than "proving `reason` reaches its
 * destination", and it is the one that is true.
 *
 * None of this generalises by itself: an argument with no effect declared for
 * it is still covered only by the census below. The two together are the
 * floor and the ceiling, and neither is the other.
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
 * ══════════════════════════════════════════════════════════════════════════
 * THE OTHER DIRECTION: **A NEEDED FIELD IS DECLARED BY SOMETHING**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Everything above runs one way — *declared ⇒ read*. It is blind, structurally
 * and not by oversight, to the opposite failure: **a field the service requires
 * that no surface ever declares.** The two are not variants of one rule. The
 * first asks whether a promise is kept; the second asks whether a capability
 * was ever offered. A check ranging over the declaration table cannot see a
 * verb missing from it, for the same reason a census of a street does not
 * report the house that was never built.
 *
 * ── The thing that happened ─────────────────────────────────────────────
 *
 * `emulate`, `fill_form`, `drag`, and `dialog` carrying `promptText` were
 * implemented, given request types, validated, and **already parsed by the
 * bridge** — and were uncallable over the tool surface for their whole
 * existence. `browser_act` declared `action`, `target` and `value`, all
 * strings, and not one of them can carry an object, an array, or a second
 * element reference. `additionalProperties: false` turned that silence into a
 * refusal.
 *
 * The cost was measured rather than theorised: two reviewers in different
 * repositories, without conferring, guessed the same three shapes for
 * `emulate`, were refused identically, and **both downgraded their own
 * reduced-motion findings in writing** because they concluded the feature did
 * not work. Fixed by `5738548`, whose diff leaves `src/service/bridge.ts`
 * untouched — the seam was built and reachable the entire time; nothing
 * declared it.
 *
 * Note what the half above would have said about that tree: **green, and
 * correctly so.** Every declared argument was read. The defect was not a
 * broken promise, it was an absent one.
 *
 * ── Why the obvious statement of the rule is a trap ─────────────────────
 *
 * The rule wants to be: *every required field of `ActionRequest` is reachable
 * from something `browser_act` declares.* Written that way it is **worthless
 * the moment it is true**, and the reason is the fix itself.
 *
 * `actionFrom` (`src/service/bridge.ts`) opens with a whole-request
 * passthrough — `argument(args, 'request')`, returned entire before any other
 * name is consulted. So `request` reaches *every field of every verb*,
 * including fields that do not exist and verbs nobody has written. Under a
 * naive reading the check passes for all time, on any tree, having tested
 * nothing — **which is the same failure class as the bug it exists to catch**,
 * and this file already carries two other instances of it (the `key:` field
 * that gave every variable a reader; the family marker that would have matched
 * its own table). A gate that cannot distinguish a healthy tree from a broken
 * one is not a weak gate, it is a decorative one.
 *
 * ── What is checked instead ─────────────────────────────────────────────
 *
 * **The passthrough is excluded from the reach, full stop.** Every required
 * field of every `ActionRequest` member must be reachable from a declared
 * argument *other than* the passthrough — directly, under an alias spelling, or
 * through a parser that assembles it. That is the brief's rule, and it is the
 * rule because any softer phrasing cannot fail.
 *
 * Excluding it means the three fields that genuinely have no flat spelling —
 * `preferences`, `fields`, `targetRef` — do not reach, and they are correct.
 * So they are **enumerated**, in `viaPassthrough` on the union's entry, each
 * with the reason it has no flat argument. Everything not enumerated fails.
 *
 * ── Why that enumeration is not the waiver this file forbids ────────────
 *
 * {@link WAIVERS} says a waiver on the argument half would be worth nothing,
 * and that is right. This runs the other way, and the direction is the whole
 * distinction. **A waiver silences a failure; this list creates them.** Without
 * it there is no failing state at all — the passthrough carries every field, so
 * "reachable from anything declared" is satisfied on every tree ever written.
 * Excluding the passthrough makes *everything* structured fail; naming the
 * three that are legitimate is what leaves **everything else failing**. A field
 * added to the union tomorrow with no flat route and no entry goes red, and
 * that is the defect class.
 *
 * Deleting a waiver makes a check stricter. Deleting an entry from this list
 * makes the check **fail**. It can only ever shrink what passes.
 *
 * The enumeration is then itself guarded from both ends: an entry whose field
 * has since grown a flat route is reported as stale, and the whole list is
 * conditional on the object-typed argument actually being declared — delete
 * that declaration and all three lose their only route at once, which is
 * precisely the pre-`5738548` tree.
 *
 * ── The draft that was wrong, recorded so it is not rebuilt ─────────────
 *
 * This check was first written in two tiers, where tier one *counted* the
 * passthrough as reaching everything (on the argument that it really does) and
 * tier two only fired when no object-typed argument was declared at all. It
 * passed on the tree, went red on the historical seed, and **was vacuous**:
 * a new verb carrying a field nothing declares produced zero failures, because
 * tier one was satisfied by the passthrough and tier two only watches for the
 * passthrough's total absence. The seeded defect passed it for the wrong
 * reason — the seed deletes the declaration, so tier one failed on an unrelated
 * branch and the vacuity never showed.
 *
 * It was caught by mutating the check and finding the tests survived. The
 * lesson is the one this file already teaches about `key:` and about the family
 * marker, met a third time: **a check can be green, have a passing seeded
 * defect, and still be unable to observe the class it exists for.** Do not
 * reintroduce a tier that lets the passthrough count toward reachability.
 *
 * ── Scope, stated as a limit rather than implied ────────────────────────
 *
 * **Required fields of `ActionRequest` only** — not every name the bridge
 * reads. That scope is a deliberate narrowing and it is the difference between
 * a usable gate and noise. The unscoped version — *every name read at the
 * bridge that no tool declares* — reports **17 names on `browser_act`, of which
 * 4 are the defect**: a 4:1 false-positive rate, from two legitimate sources.
 *
 * 1. **Alias spellings.** `key`, `lease` and `leaseKey` are internal spellings
 *    of declared `lease_key`; `ref`/`target`, `target_ref`/`targetRef` and
 *    `prompt_text`/`promptText` are alias pairs. These are not undeclared, they
 *    are declared under their other name. The remedy was already in this file:
 *    `argument(args, 'a', 'b')` **is** the alias declaration, so the spellings
 *    are grouped **by call site** rather than flattened into one set.
 * 2. **Alternate-shape parsers legitimately read undeclared names.**
 *    `viewportFrom` reads `viewport`, `width`, `height` *and* `value`, and only
 *    `value` is declared — by design, because the flat surface accepts
 *    `1280x720`. These are accepted alternatives, not gaps, and are followed as
 *    assemblers: a helper named `<field>From` that reads `<field>` itself
 *    builds that field out of every name it reads.
 *
 * On the narrowed scope the false-positive count on the current tree is
 * **zero**, and the seeded historical declaration still goes red on all four
 * fields. **There is deliberately no waiver facility on this half** — see
 * {@link WAIVERS}: a check quietable on the exact class it exists for is worth
 * nothing. Wanting a waiver here means the scope is wrong; narrow the scope.
 *
 * ── What this half cannot see ───────────────────────────────────────────
 *
 * | Claim | Status |
 * |---|---|
 * | Every required `ActionRequest` field is reachable from a declared argument | **Checked**, over the union rather than a list beside it |
 * | A field that depends on the passthrough alone is named, and the passthrough is required to exist | **Checked** |
 * | *Optional* fields are reachable | **NOT checked.** `press`'s `ref?` may be undeclared and nothing here objects — an optional field absent is a weaker claim than a required one absent |
 * | *Nested* fields, inside a member's field type, are reachable | **NOT checked**, and this is the one gap worth naming by name. The episode was four verbs; this half catches **three**. `dialog`'s `promptText` is the fourth, and it is out of scope twice over: it is `readonly promptText?: string`, so optional, and it lives on `DialogResponse` rather than on the union member, so a scan of `ActionRequest`'s own fields does not reach it. Descending into field types would mean checking every nested optional, which is where the false positives live — the scope was chosen for the three it catches soundly over the four it would catch noisily |
 * | Other structured unions — a future `ReadRequest` — are covered | **NOT checked.** This ranges over `ActionRequest` only, and a second union needs a second entry |
 * | The declared argument's *type* can carry the field | **NOT checked.** A `string` declared where an object is needed satisfies this, which is precisely how the four verbs broke; tier two catches the passthrough's removal, not its retyping |
 * | The derivation is AST-accurate | **No.** Regex and text, like the rest of this file — see `helperReads`, whose `async` hole let a helper's reads vanish and made the check pass "on an accident of ordering" |
 *
 * The last row is the one to hold onto: this half inherits every limit of the
 * machinery it reuses, on purpose, because a parallel derivation that drifted
 * from the one above would be worse than a shared one that is honestly
 * approximate.
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
/**
 * Remove comments, and **keep what is inside strings**.
 *
 * The configuration half wants string contents gone, so that a variable named
 * in a message is not mistaken for a variable being read. The argument half
 * wants the opposite: it locates an operation's branch by matching
 * `case 'navigate':`, so emptying that quoted name would delete the very
 * landmark it navigates by — and every operation would then report that the
 * bridge has no branch for it. Two readers, two needs, one shared skipper for
 * the part they agree on.
 */
export function stripComments(source) {
  return scanSource(source, { keepStringContents: true });
}

export function stripCommentsAndStrings(source) {
  return scanSource(source, { keepStringContents: false });
}

/**
 * Walk the source once, dropping comments, and either keeping or emptying what
 * is inside a string literal.
 *
 * One walker rather than two so that the part both halves agree on — where a
 * comment starts and ends, and that a backslash escapes the next character —
 * is written once and cannot drift between them.
 */
function scanSource(source, { keepStringContents }) {
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
      // The opening quote is written either way. When contents are dropped it
      // is closed immediately, so that a call's argument positions stay
      // countable: `argument(args, 'a', 'b')` must not collapse into
      // something that reads as a different call shape.
      out += keepStringContents ? quote : quote + quote;
      while (index < length) {
        if (source[index] === '\\') {
          if (keepStringContents) out += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          if (keepStringContents) out += quote;
          index += 1;
          break;
        }
        if (keepStringContents) out += source[index];
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
  //
  // **`async` is matched too, and its absence was a real hole rather than a
  // tidy-up.** A helper declared `async function` was invisible here, so the
  // names it read counted for nothing — and the one helper in that position,
  // `submitFeedback`, was reached only because its operation happened to be
  // the *last* `case` in the switch, which made that branch's region run to
  // the end of the file and swallow the helper's body wholesale. The check
  // passed on an accident of ordering: adding any case after it moved the
  // region boundary and five arguments that had always been read were
  // reported inert. A gate whose result depends on the order of unrelated
  // branches is one that will fail on somebody's unrelated edit, which is the
  // expensive direction for a gate.
  const boundaries = [...bridgeCode.matchAll(/\n(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)];
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
export function bridgeReadsByOperation(rawSource = readFileSync(BRIDGE_SOURCE, 'utf8')) {
  // Commented-out code is not a read. This matters more than the other routes
  // an argument can go inert by: commenting a line out is how a read dies
  // during a refactor that is never finished, and it leaves the declaration,
  // the documentation and the surrounding branch all intact. Scanning the raw
  // text would count the corpse, and a check that counts a commented-out read
  // certifies the exact defect it exists to catch.
  const source = stripComments(rawSource);
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
 * Where the service declares the structured request the action verbs take.
 */
export const DRIVER_SOURCE = path.join(repositoryRoot, 'src', 'browser', 'driver.ts');

/**
 * The union whose required fields the reverse half ranges over, and the tool
 * that serves it.
 *
 * A table of one, written as a table anyway. A second structured union — a
 * `ReadRequest`, say — is an entry here rather than a second copy of the
 * machinery below, and the header's limits table says plainly that until such
 * an entry exists the union is not covered. Naming the union in a table also
 * makes its absence loud: {@link actionRequestMembers} fails rather than
 * returning nothing if the type is renamed, so this cannot quietly start
 * checking an empty set.
 */
export const STRUCTURED_UNIONS = [
  {
    type: 'ActionRequest',
    tool: 'browser_act',
    operation: 'act',
    /** The field that says which member is meant; never a field to look for. */
    discriminant: 'action',
    /**
     * Required fields that arrive **inside the structured passthrough** and
     * have no flat spelling — by design, not by omission.
     *
     * ── Why this is an enumeration and emphatically not a waiver ─────────
     *
     * {@link WAIVERS} argues at length that a waiver on the argument half
     * would be worthless, because "a check that could be quieted on the exact
     * class it exists for would be worth nothing". That argument is right and
     * this list does not contradict it, because the two run in **opposite
     * directions**.
     *
     * A waiver *silences a failure*: the defect is real, and the entry stops
     * the gate reporting it. This list *creates* failures. Without it the
     * check has no way to fail at all — the passthrough reaches every field
     * by construction, so a rule phrased "reachable from anything declared"
     * passes forever. Excluding the passthrough makes every structured field
     * fail, including the three that are correct. Enumerating those three is
     * what leaves **everything else failing**: a field added to the union
     * tomorrow with no flat route and no entry here goes red, which is the
     * defect class, and it is the only shape in which this gate can fire.
     *
     * The test of the difference: deleting a waiver makes a check stricter;
     * deleting an entry from this list makes the check *fail*, and adding one
     * requires writing down a reason in a diff a reviewer reads. This list can
     * only ever shrink the set of things that pass.
     *
     * Each entry records why the field has no flat spelling. `SCHEMA.md` §3.1
     * is the standing reason — "surface area is a standing tax and the list is
     * short on purpose" — and `5738548` is the commit that chose one
     * passthrough argument over the six flat ones these would otherwise need.
     */
    viaPassthrough: [
      {
        field: 'preferences',
        why: 'an object of media preferences; #62 chose the passthrough over three flat arguments',
      },
      {
        field: 'fields',
        why: 'an array of {ref, value} pairs, which no flat string argument can carry (#64)',
      },
      {
        field: 'targetRef',
        why: "drag's second element reference; a flat `target_ref` was refused as surface tax (#64)",
      },
    ],
    /**
     * Fields a caller is **not permitted to express at all**, each with the
     * argument it is derived from instead.
     *
     * ── Why this is not a second spelling of `viaPassthrough` ───────────
     *
     * That list is for fields that arrive whole from a caller through one
     * object-typed argument. These are the opposite: **no caller can send
     * them, by design, and the surface must not declare anything that would
     * let one try.** `upload`'s `files` carries the bytes of a file, read by
     * the service inside its own containment guard from a name the caller
     * gave. A caller that could put a value in that field could put arbitrary
     * bytes into a page while bypassing the guard entirely, and a caller that
     * could put a *path* there would be handing the automation library a
     * string this service never checked.
     *
     * So the field's unreachability is the security property, not an
     * oversight — and the assertion below is written in the strict direction
     * to match. An entry here **fails** if the field ever becomes reachable
     * from a declared argument, which is the inverse of `viaPassthrough`'s
     * staleness rule and the only shape in which this list can be a gate:
     * declaring an argument that reaches `files` is precisely the change that
     * must not pass silently.
     *
     * `derivedFrom` names the argument a caller *does* send, so this cannot be
     * used to hide a field that has no route to the surface at all: the named
     * argument has to be declared, or the entry fails.
     */
    neverFromCaller: [
      {
        field: 'files',
        derivedFrom: 'paths',
        why:
          "upload's bytes, read by the service from the caller's names under the configured " +
          'upload root. A caller that could set this field would bypass the containment guard ' +
          'that makes the verb safe to expose, so the surface must never declare a route to it.',
      },
    ],
  },
];

/**
 * The members of a discriminated union, as `{ verbs, required, optional }`.
 *
 * Read from the text, like everything else here, and bounded the way the source
 * is laid out: members are `| { … }` blocks between the `export type X =` and
 * the next top-level `export`. Optionality is taken from the `?` the source
 * already writes, which is why the union has to be read rather than a list of
 * fields kept beside it — a list would have to be updated by the same person
 * who forgot to declare the argument, and the header explains at length why a
 * check whose coverage depends on somebody remembering is not a check against
 * forgetting.
 *
 * Comments are stripped first. The union's own prose names fields in prose
 * (`"the field is optional for the same reason press's is"`), and counting a
 * mention as a declaration is the vacuity this file exists to refuse.
 */
export function actionRequestMembers(
  union = STRUCTURED_UNIONS[0],
  source = readFileSync(DRIVER_SOURCE, 'utf8'),
) {
  const code = stripComments(source);
  const start = code.indexOf(`export type ${union.type} =`);
  if (start === -1) {
    throw new Error(
      `the reverse reachability check could not find "export type ${union.type}" in ` +
        `src/browser/driver.ts. Either the union was renamed — update STRUCTURED_UNIONS with it — ` +
        `or it was removed. A union this check cannot locate is a union it checks vacuously, ` +
        'so this throws rather than returning an empty set.',
    );
  }
  // Bounded by the next top-level `export`, which is how the file is laid out.
  const after = code.indexOf('\nexport ', start + `export type ${union.type} =`.length);
  const body = code.slice(start, after === -1 ? code.length : after);

  const members = [];
  for (const match of body.matchAll(/\|\s*\{([\s\S]*?)\n\s*\}/g)) {
    const member = match[1];
    const discriminant = new RegExp(`readonly\\s+${union.discriminant}:\\s*([^;]+);`).exec(member);
    if (discriminant === null) continue;
    const verbs = [...discriminant[1].matchAll(/'([a-z_]+)'/g)].map((verb) => verb[1]);

    const required = [];
    const optional = [];
    for (const field of member.matchAll(/readonly\s+([A-Za-z0-9_]+)(\??):/g)) {
      if (field[1] === union.discriminant) continue;
      (field[2] === '?' ? optional : required).push(field[1]);
    }
    members.push({ verbs, required, optional });
  }

  if (members.length === 0) {
    throw new Error(
      `the reverse reachability check found "export type ${union.type}" and parsed no members ` +
        'out of it, so it would check nothing while reporting green.',
    );
  }
  return members;
}

/**
 * The alias spellings the bridge treats as one argument, grouped **by call
 * site**.
 *
 * This is the single decision that takes the false-positive rate on
 * `browser_act` from 17 names to zero, and it needed no new parser: a call
 * `argument(args, 'ref', 'target')` **is** the statement that those two names
 * are one argument under two spellings. Flattening every literal into one set
 * loses exactly that structure and then reports `ref` as undeclared while
 * `target` sits declared beside it.
 *
 * Returned as a list of groups rather than a name-to-name map because the
 * relation is not a function: `lease_key` has three internal spellings, and one
 * of them (`key`) is read at a second call site with a different membership.
 */
export function aliasGroups(bridgeSource = readFileSync(BRIDGE_SOURCE, 'utf8')) {
  const code = stripComments(bridgeSource);
  const groups = [];
  for (const call of code.matchAll(/\bargument\(\s*args\s*,([^)]*)\)/g)) {
    const names = [...call[1].matchAll(/'([^']+)'/g)].map((literal) => literal[1]);
    if (names.length > 0) groups.push(names);
  }
  return groups;
}

/**
 * Helpers that **assemble** a field out of whatever the caller could express.
 *
 * `viewportFrom` reads `viewport`, `width`, `height` and `value`, and only
 * `value` is declared on the surface — deliberately, because the flat surface
 * accepts `390x844`. Those undeclared names are accepted alternatives, not
 * gaps, so a field is reachable when any name its assembler reads is reachable.
 *
 * ── Why "reads its own name" is the test, and not merely a tidy convention ──
 *
 * The naming convention alone is not enough, and getting this wrong is a third
 * route to vacuity that this check hit in draft. `refusalFrom` also ends in
 * `From` and reads the *whole* argument record — transitively, all 48 names in
 * the bridge. Admitting it as an assembler makes every field reachable from any
 * declared argument whatsoever, and the check passes on everything again.
 *
 * So an assembler must read a name **equal to the field it is named for**:
 * `viewportFrom` opens `const given = argument(args, 'viewport')`, and that
 * self-read is what distinguishes a function that *builds* `viewport` from one
 * that merely passes the record along. `refusalFrom` reads no `refusal` and is
 * excluded. Direct reads only, never the transitive closure {@link helperReads}
 * computes, for the same reason.
 *
 * ── `actionFrom` is admitted, and that is not a hole ────────────────────
 *
 * It reads `argument(args, 'action')`, so it passes the self-read test. Worth
 * stating because it looks like the exact thing the paragraph above forbids,
 * and a draft of the test below asserted it should be excluded — wrongly.
 *
 * **Reachability composes inward.** An assembler entry means "any of these read
 * names reaches this built field", so admitting `actionFrom` lets `ref`,
 * `value` and `target` reach `action`. It does not let `action` reach them; the
 * relation is not symmetric, and it is the outward direction that would be
 * dangerous. Starting from a surface declaring only `action`, the closure is
 * `{action}` and nothing more — pinned by a test, because the day that stops
 * being true is the day this function needs the stricter rule.
 */
export function assemblers(bridgeSource = readFileSync(BRIDGE_SOURCE, 'utf8')) {
  const code = stripComments(bridgeSource);
  const boundaries = [...code.matchAll(/\n(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)];
  const found = new Map();

  for (const [position, match] of boundaries.entries()) {
    const name = match[1];
    const named = /^([A-Za-z0-9_]+)From$/.exec(name);
    if (named === null) continue;
    const field = named[1];

    const next = boundaries[position + 1];
    const body = code.slice(match.index, next === undefined ? code.length : next.index);
    const reads = new Set(
      [...body.matchAll(/\bargument\(\s*args\s*,([^)]*)\)/g)].flatMap((call) =>
        [...call[1].matchAll(/'([^']+)'/g)].map((literal) => literal[1]),
      ),
    );
    // The self-read test. Without it, `actionFrom` and `refusalFrom` qualify
    // and every field becomes reachable from everything.
    if (!reads.has(field)) continue;

    found.set(field, {
      reads,
      // Other assemblers this one delegates to, so `responseFrom` calling
      // `acceptFrom` carries `accept`'s alternatives into `response`.
      delegates: new Set(
        [...body.matchAll(/\b([A-Za-z0-9_]+)From\s*\(\s*args\b/g)]
          .map((call) => call[1])
          .filter((callee) => callee !== field),
      ),
    });
  }
  return found;
}

/**
 * The argument a tool declares that the bridge hands on **whole** — the
 * passthrough.
 *
 * Derived structurally rather than by name, and the structure is unambiguous:
 * it is the sole argument on the whole tool surface declared `type: 'object'`,
 * every other being a scalar or an `array`. Deriving it means a passthrough
 * added to a second tool is found without editing this check, and — the part
 * that matters — that the name `request` is not wired into the gate that exists
 * to notice the passthrough disappearing. A check hunting for a hardcoded name
 * reports "not found" identically whether the argument was deleted or renamed,
 * and only one of those is a defect.
 *
 * Returns the declared names, so the caller can say which fields lean on it.
 */
export function passthroughArguments(tool, toolsSource = readFileSync(TOOLS_SOURCE, 'utf8')) {
  const toolPattern =
    /name:\s*'(browser_[a-z_]+)',\s*(?:\/\/[^\n]*\n\s*)*operation:\s*'([a-z_]+)'/g;
  const tools = [...toolsSource.matchAll(toolPattern)].map((match) => ({
    tool: match[1],
    at: match.index,
  }));

  const names = [];
  for (const [position, entry] of tools.entries()) {
    if (entry.tool !== tool) continue;
    const next = tools[position + 1];
    const region = toolsSource.slice(entry.at, next === undefined ? toolsSource.length : next.at);
    // Each argument is `{ name: 'x', type: 'y', … }`; the object-typed one is
    // the passthrough. Matched as a pair so a `type: 'object'` belonging to a
    // different argument cannot be attributed to the wrong name.
    for (const argument of region.matchAll(/name:\s*'([a-z_]+)',\s*type:\s*'object'/g)) {
      names.push(argument[1]);
    }
  }
  return names;
}

/**
 * Every field reachable from a set of declared names, closing over alias groups
 * and assemblers until nothing new appears.
 *
 * A fixed point for the same reason {@link helperReads} needs one: reachability
 * composes. `value` is declared, `viewportFrom` builds `viewport` from `value`,
 * and a member requiring `viewport` is satisfied two hops out. One pass would
 * miss the second hop and report a false failure on a working verb.
 */
export function reachableFields(declaredNames, { groups, built }) {
  const reach = new Set(declaredNames);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (!group.some((name) => reach.has(name))) continue;
      for (const name of group) {
        if (!reach.has(name)) {
          reach.add(name);
          changed = true;
        }
      }
    }
    for (const [field, assembler] of built) {
      if (reach.has(field)) continue;
      const viaRead = [...assembler.reads].some((name) => reach.has(name));
      const viaDelegate = [...assembler.delegates].some((callee) => reach.has(callee));
      if (viaRead || viaDelegate) {
        reach.add(field);
        changed = true;
      }
    }
  }
  return reach;
}

/**
 * The reverse half: **a required field of a structured request is reachable
 * from something the tool declares, and the passthrough it leans on exists.**
 *
 * Read the header section "THE OTHER DIRECTION" before changing the shape of
 * this. In particular the two tiers are not redundant with each other: tier one
 * alone passes on every tree ever written, and tier two alone fails on the
 * tree as it correctly stands. The self-test seeds both mistakes.
 */
export function checkRequiredFieldsAreDeclarable({ toolsSource, bridgeSource, driverSource } = {}) {
  const tools = toolsSource ?? readFileSync(TOOLS_SOURCE, 'utf8');
  const bridge = bridgeSource ?? readFileSync(BRIDGE_SOURCE, 'utf8');
  const driver = driverSource ?? readFileSync(DRIVER_SOURCE, 'utf8');

  const declarations = declaredToolArguments(tools);
  const groups = aliasGroups(bridge);
  const built = assemblers(bridge);

  const failures = [];
  const viaPassthroughOnly = [];
  let checked = 0;

  for (const union of STRUCTURED_UNIONS) {
    const members = actionRequestMembers(union, driver);
    const declared = declarations
      .filter((entry) => entry.tool === union.tool)
      .map((entry) => entry.name);
    const passthrough = passthroughArguments(union.tool, tools);

    // Tier one's reach, and the same reach with the passthrough taken away.
    // The difference between the two is the set of fields that depend on the
    // passthrough alone, which is what tier two is about.
    //
    // **The passthrough reaches every field of the union, by construction and
    // not by inference.** `actionFrom` opens by returning `argument(args,
    // 'request')` whole and unexamined, so whatever the caller puts inside it
    // arrives at the guard intact — there is no name-by-name derivation to
    // follow, and modelling it as an ordinary declared name would find nothing,
    // because the passthrough's whole nature is that it carries names it never
    // mentions. This is exactly the property that makes tier one vacuous on its
    // own, and it is written here explicitly rather than left implicit so that
    // the vacuity is visible at the place it is created.
    // **The reach excludes the passthrough, and that is the whole rule.** The
    // passthrough is not modelled as reaching anything, even though at runtime
    // it reaches everything, because modelling it honestly is precisely what
    // makes the check vacuous: `actionFrom` returns `argument(args, 'request')`
    // whole and unexamined, so a reach that counted it would contain every
    // field of every verb — including verbs nobody has written yet — and the
    // gate could never go red on any tree.
    const reach = reachableFields(
      declared.filter((name) => !passthrough.includes(name)),
      { groups, built },
    );
    const declaresPassthrough = declared.some((name) => passthrough.includes(name));

    for (const member of members) {
      for (const field of member.required) {
        checked += 1;
        const verbs = member.verbs.map((verb) => `"${verb}"`).join(' / ');
        if (reach.has(field)) continue;

        // Not reachable from any flat argument. Two very different situations
        // wear that description, and separating them is what makes this a gate
        // rather than noise.
        // A field the surface must never offer a route to. Handled before
        // the passthrough case because the two are opposites: one says a
        // caller sends this inside another argument, this one says no caller
        // sends it at all.
        if ((union.neverFromCaller ?? []).some((entry) => entry.field === field)) {
          continue;
        }

        const known = union.viaPassthrough.find((entry) => entry.field === field);

        if (known === undefined) {
          // **A field with no flat route that nobody has acknowledged.** This
          // is the defect class: a verb added to the union whose input the
          // surface cannot express. It fires whether or not the passthrough is
          // declared, which is the property the earlier draft of this check
          // lacked and the reason it was rewritten — see the header.
          failures.push(
            `${union.type} requires "${field}" for ${verbs}, and ${union.tool} declares no ` +
              `argument it can arrive in: not directly, not under an alias spelling, and not ` +
              `through a parser that assembles it. The verb is implemented and uncallable — a ` +
              `caller cannot express the field, and additionalProperties:false turns the attempt ` +
              `into a refusal, which is how emulate, fill_form and drag shipped unusable. ` +
              `Either declare an argument that carries it in src/tool/tools.ts, or — if it is ` +
              `meant to arrive inside the structured passthrough like those three — add it to ` +
              `viaPassthrough for ${union.type} with the reason, which is a claim a reviewer ` +
              `sees rather than an absence they would have to notice.`,
          );
          continue;
        }

        // **A field acknowledged as arriving inside the passthrough.** Three of
        // these exist and they are legitimate: `SCHEMA.md` §3.1 refuses an
        // argument per field ("surface area is a standing tax and the list is
        // short on purpose"), so the structured verbs are *designed* to arrive
        // whole. What the acknowledgement buys is the assertion below — the
        // passthrough they depend on has to actually be declared.
        viaPassthroughOnly.push({ field, verbs, tool: union.tool, why: known.why });
      }
    }

    // The acknowledgement is conditional on the passthrough existing. Delete
    // the object-typed declaration and every acknowledged field loses its only
    // route at once — which IS the pre-5738548 tree, and is the state in which
    // four implemented verbs were uncallable.
    if (viaPassthroughOnly.length > 0 && !declaresPassthrough) {
      failures.push(
        `${union.tool} declares no object-typed argument, and ` +
          `${String(viaPassthroughOnly.length)} required ${union.type} field(s) are recorded as ` +
          `arriving inside one: ${viaPassthroughOnly.map((e) => `"${e.field}"`).join(', ')}. A ` +
          `flat string argument cannot carry an object, an array, or a second element reference, ` +
          `so those verbs are implemented and uncallable. This is exactly the defect 5738548 ` +
          `fixed by declaring the passthrough; do not fix it by deleting the verbs.`,
      );
    }

    // A recorded field that has since grown a flat route is an acknowledgement
    // that has outlived the thing it described. Reported for the same reason a
    // stale waiver is, one section down: an entry nobody has to remove is a
    // permanent hole, and this is the moment it can be removed with certainty
    // rather than by somebody guessing later.
    for (const entry of union.viaPassthrough) {
      if (!reach.has(entry.field)) continue;
      failures.push(
        `"${entry.field}" is recorded as reaching ${union.tool} only inside the passthrough, and ` +
          `it now has a flat route as well. Delete the entry: a record that misdescribes the tree ` +
          `stops being read, and this one is load-bearing for the fields that still need it.`,
      );
    }

    // **The strict direction, and the reason this list is a gate.** A field
    // recorded as never arriving from a caller must stay unreachable: an
    // argument that reaches it is a route around the guard the field exists
    // behind. And the argument it IS derived from has to be declared, so this
    // list cannot be used to excuse a field with no route to the surface at
    // all — which is the defect the whole check is for.
    for (const entry of union.neverFromCaller ?? []) {
      if (reach.has(entry.field)) {
        failures.push(
          `"${entry.field}" is recorded as reachable from no caller argument on ${union.tool}, ` +
            `and something reaches it. ${entry.why} Remove the argument that reaches it, or ` +
            `— if the field is genuinely meant to be caller-supplied — say so here and in ` +
            `SCHEMA.md, because it is a security boundary rather than a matter of surface tax.`,
        );
      }
      if (!declared.includes(entry.derivedFrom)) {
        failures.push(
          `"${entry.field}" is recorded as derived from the "${entry.derivedFrom}" argument on ` +
            `${union.tool}, and ${union.tool} declares no such argument. The verb is implemented ` +
            `and uncallable: a caller has no way to say which files to send.`,
        );
      }
    }
  }

  return { failures, checked, viaPassthroughOnly };
}

/**
 * Declared things this check knowingly passes, each with the reason.
 *
 * ── Why the facility exists at all, having argued against a waiver list ──
 *
 * The rule for *arguments* needs no exceptions and has none: the
 * surface-consumed category dissolves, so every declared argument is expected
 * to be read and none is excused. The facility is for the configuration half,
 * and the distinction it turns on is worth stating because it is what stops
 * the list growing.
 *
 * **A waiver records that the defect is real and unfixed here — never that it
 * is acceptable.** It is the `external-ref-ok` convention: the reason is
 * written in the diff, so a reviewer sees the claim being made rather than an
 * absence they would have to notice. An entry whose reason does not name why
 * the fix is out of reach, and what would close it, does not belong.
 *
 * **The list is empty, and an empty list is the state to defend.** A declared
 * variable that nothing reads has two honest endings — it becomes read, or it
 * stops being declared — and a waiver is only ever the temporary third. The
 * check refuses a waiver naming a variable absent from the declaration table
 * (see {@link checkConfiguration}), so an entry cannot outlive the thing it
 * excuses and sit here as a hole under a name somebody later reuses.
 *
 * **A waiver is not available for a tool argument.** The argument half takes
 * no exceptions, deliberately: the historical defect was an argument, and a
 * check that could be quieted on the exact class it exists for would be worth
 * nothing. Adding a waiver facility to that half is the change to refuse.
 */
export const WAIVERS = [];

/**
 * Every environment variable the build declares, from the declaration table.
 */
export function declaredVariables(source = readFileSync(ENVIRONMENT_SOURCE, 'utf8')) {
  return [...source.matchAll(/key:\s*'(BROKER_[A-Z0-9_]+)'/g)].map((match) => match[1]);
}

/**
 * Configuration declared as a **family of computed keys** rather than as a
 * literal in the declaration table.
 *
 * ── Why this half of the check had to be written ─────────────────────────
 *
 * {@link declaredVariables} finds a variable by matching the literal
 * `key: 'BROKER_…'`. `BROKER_BROWSER_<NAME>_PATH` has no such literal and
 * cannot have one: its keys are a function of the configured browser names,
 * which are themselves read from the environment. So the entire per-browser
 * binary surface would have entered the build **invisible to the one check
 * that exists to stop inert configuration** — not passing it, but never
 * examined by it, which is the worse of the two because the report would say
 * green without the property having been tested.
 *
 * That is the `wait_ms` shape exactly: declared, validated, and read by
 * nothing. A check that silently skips the newest configuration surface is a
 * check that has stopped doing its job at the moment it was most needed.
 *
 * Each entry names the prefix that identifies the family, and the field the
 * family is assembled into on the environment record — which is the thing
 * that has to be read somewhere outside the declaring file for the surface to
 * do anything at all.
 */
export const DECLARED_FAMILIES = [
  {
    what: 'BROKER_BROWSER_<NAME>_PATH',
    // The literals the declaring file must contain for the family to exist at
    // all. Checked, so that renaming the family in code without updating this
    // fails the build rather than quietly emptying it.
    markers: ["BROWSER_PATH_PREFIX = 'BROKER_BROWSER_'", "BROWSER_PATH_SUFFIX = '_PATH'"],
    field: 'browserPaths',
  },
];

/**
 * The field a family is actually assembled into, read off the declaring
 * source rather than taken from the table.
 *
 * A family is built by walking the configured browsers and filling a map, so
 * the assembling form is `const <field> = new Map<string, string>()` followed
 * by the record putting it on by shorthand. Reading the name from the source
 * is what lets the check notice a rename that touched the declaration and not
 * its reader — see the note at the call site for why matching the table's
 * literal instead would pass vacuously.
 */
export function assembledFieldFor(family, source) {
  const declared = new RegExp(
    `const\\s+([A-Za-z0-9_]+)\\s*=\\s*new Map<string, string>\\(\\)`,
  ).exec(source);
  if (declared === null) return undefined;
  // Only trusted when the record carries it too: a local that never reaches
  // the environment record is not a field at all.
  return source.includes(`\n    ${declared[1]},`) ? declared[1] : undefined;
}

/**
 * Check the computed-key families the literal scan cannot see.
 *
 * **Takes no waivers.** The literal half has a waiver facility because a
 * variable can outlive the code that read it during a migration; a family is
 * added in one commit with its reader, so an unread one has no history to be
 * mid-way through.
 */
export function checkConfigurationFamilies(source = readFileSync(ENVIRONMENT_SOURCE, 'utf8')) {
  const sources = sourceFiles();
  const failures = [];
  let checked = 0;

  for (const family of DECLARED_FAMILIES) {
    checked += 1;
    const missing = family.markers.filter((marker) => !source.includes(marker));
    if (missing.length > 0) {
      failures.push(
        `${family.what} is checked as a computed-key family and ${missing
          .map((marker) => `"${marker}"`)
          .join(' / ')} is absent from src/config/environment.ts. Either the family was renamed ` +
          `— update this check with it — or it was removed, in which case remove it here too. A ` +
          `family whose markers have drifted is checked vacuously.`,
      );
      continue;
    }
    if (assembledFieldFor(family, source) === undefined) {
      failures.push(
        `${family.what} is declared and never assembled into the environment record as ` +
          `"${family.field}", so nothing can read it.`,
      );
      continue;
    }
    // Read against the field the DECLARING SOURCE actually assembles, not
    // against the literal in the table above. The two are the same in a
    // healthy tree; they differ exactly when the field has been renamed in
    // one place and not the other, which is the inert state being hunted.
    // Matching the table's literal instead would find the reader spelling a
    // name the declaration does not use, and report green — the check would
    // pass *because* the tree is broken, which is the vacuous shape this file
    // names as worse than an absent check.
    const assembled = assembledFieldFor(family, source) ?? family.field;
    if (!fieldIsReadOutsideDeclaration(assembled, sources)) {
      failures.push(
        `${family.what} is declared — and validated, which is worse, because a caller who sets ` +
          `it wrongly is refused and reasonably concludes it works — but "${family.field}" is ` +
          `read nowhere outside src/config/environment.ts. Read it where it should take effect, ` +
          `or stop declaring it.`,
      );
    }
  }

  return { failures, checked };
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
 * declared is exactly the defect: a setting whose every appearance in `src` is
 * its own type field and its own assignment reaches nothing that acts on it.
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

/**
 * Run the configuration half: a declared variable is read outside its
 * declaration.
 *
 * `waivers` is injectable so the self-test can exercise the stale-excuse
 * branch below against a fabricated entry. The list this ships with is empty,
 * so a test asserting that branch has nothing real to point at — and seeding
 * it here is how that guard stays proven rather than merely present.
 */
export function checkConfiguration({ waivers = WAIVERS } = {}) {
  const source = readFileSync(ENVIRONMENT_SOURCE, 'utf8');
  const variables = declaredVariables(source);
  const sources = sourceFiles();

  const failures = [];
  const waived = [];
  let checked = 0;

  // A waiver naming something absent from the declaration table is a stale
  // excuse, and stale excuses are how a waiver list becomes the place defects
  // hide. Failing on it costs one line to delete and keeps the list honest.
  for (const waiver of waivers) {
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

/**
 * The seeded violation for the reverse half: `browser_act`'s declaration as it
 * stood **before `5738548`**, with the passthrough removed.
 *
 * Faithful to what `5738548` did rather than invented. That commit added exactly
 * one argument and touched no other file, so deleting the object-typed declaration
 * reproduces the tree on which four implemented verbs were uncallable — and
 * reproduces it at the place the defect actually lived, the declaration,
 * rather than by damaging the bridge that was innocent throughout.
 */
export function seededUndeclaredPassthrough() {
  const tools = readFileSync(TOOLS_SOURCE, 'utf8');
  // The whole `{ name: 'request', type: 'object', … }` entry, from its opening
  // brace to the closing one before the list ends. Matched by the object-typed
  // pair rather than the name, so the seed follows a rename of the argument.
  const seeded = tools.replace(
    /\{\s*name:\s*'[a-z_]+',\s*type:\s*'object',[\s\S]*?\n {6}\},\n/,
    '',
  );
  if (seeded === tools) {
    throw new Error(
      'the self-test could not find an object-typed argument declaration to remove, so the ' +
        'seed reproduces nothing and proves nothing. Fix the seed.',
    );
  }
  return { toolsSource: seeded };
}

/**
 * The seed that proves the **exclusion clause** is load-bearing, which is a
 * different claim from the seed above and the more important of the two.
 *
 * ── Why the other seed is not enough, stated because it fooled this check ──
 *
 * {@link seededUndeclaredPassthrough} deletes the declaration, so on that tree
 * the passthrough is not a declared argument at all. A check that wrongly
 * counted the passthrough toward reachability would **still go red on it** —
 * for the unrelated reason that there is nothing left to count. The seed
 * therefore cannot distinguish a working exclusion clause from an absent one,
 * and an earlier draft of this file passed it while being unable to observe the
 * defect class at all.
 *
 * This seed fixes that by leaving the passthrough exactly where it is and
 * growing the **union** instead: a new verb whose required field no declared
 * argument can carry. That is the live defect class — a verb added to the
 * service ahead of the surface, which is what happened to `emulate`,
 * `fill_form` and `drag` — and it is red only if the passthrough is genuinely
 * excluded from the reach. Let the passthrough count and this seed goes green,
 * which is the whole demonstration.
 */
export function seededUnreachableVerb(driverSource = readFileSync(DRIVER_SOURCE, 'utf8')) {
  const union = STRUCTURED_UNIONS[0];
  // Spliced in ahead of an existing member so the union's layout is untouched.
  const anchor = "      readonly action: 'drag';";
  if (!driverSource.includes(anchor)) {
    throw new Error(
      'the self-test could not find the `drag` member to splice a seeded verb beside, so the ' +
        'seed reproduces no verb the surface cannot express, so it proves nothing. Fix the seed.',
    );
  }
  const seeded = driverSource.replace(
    anchor,
    "      readonly action: 'seeded_unreachable';\n" +
      '      readonly fieldNoArgumentCanCarry: string;\n' +
      '    }\n' +
      '  | {\n' +
      anchor,
  );
  return { driverSource: seeded, union, field: 'fieldNoArgumentCanCarry' };
}

/** Both halves, against the tree as it is. */
export function runReachabilityCheck() {
  const args = checkArguments();
  const required = checkRequiredFieldsAreDeclarable();
  const configuration = checkConfiguration();
  const families = checkConfigurationFamilies();
  return {
    failures: [
      ...args.failures,
      ...required.failures,
      ...configuration.failures,
      ...families.failures,
    ],
    waived: configuration.waived,
    checkedArguments: args.checked,
    checkedFields: required.checked,
    viaPassthroughOnly: required.viaPassthroughOnly,
    checkedVariables: configuration.checked + families.checked,
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

    // ── The same proof, for the reverse half ───────────────────────────────
    //
    // Two seeds, because this half has two ways to be worthless and only one
    // of them is "it never fires".
    const undeclared = checkRequiredFieldsAreDeclarable(seededUndeclaredPassthrough());
    const reverseCaught = undeclared.failures.some((failure) => failure.includes('preferences'));
    if (reverseCaught) {
      console.log(
        'Self-test passed: the check goes red when the passthrough is undeclared and the ' +
          'structured verbs have no route to the surface.',
      );
      for (const failure of undeclared.failures) console.log(`  would fail: ${failure}`);
    } else {
      console.error(
        'Self-test FAILED: `browser_act` was returned to its pre-5738548 declaration and the ' +
          'check stayed green, so it cannot observe four implemented verbs being uncallable.',
      );
      process.exitCode = 1;
    }

    // The vacuity proof, and the one that matters most: a verb the surface
    // cannot express, added while the passthrough stays declared. Red only if
    // the passthrough is genuinely excluded from the reach.
    const unreachable = seededUnreachableVerb();
    const grown = checkRequiredFieldsAreDeclarable({ driverSource: unreachable.driverSource });
    if (grown.failures.some((failure) => failure.includes(unreachable.field))) {
      console.log(
        'Self-test passed: a verb whose required field no declared argument can carry goes red ' +
          'even though the passthrough is declared — so the "other than the passthrough" clause ' +
          'is doing the work, not decorating it.',
      );
    } else {
      console.error(
        'Self-test FAILED: a required field that NOTHING on the tool surface can express was ' +
          'added and the check stayed green. That is the vacuous state this clause exists to ' +
          'prevent: the passthrough is being counted toward reachability, so the gate can never ' +
          'fire on a verb the surface cannot express — which is the defect class itself.',
      );
      process.exitCode = 1;
    }

    // ── The same proof, for the computed-key half ──────────────────────────
    //
    // The family check is the newer half and the one most likely to be
    // vacuous, because it asserts on a field name rather than on a key the
    // scan found. So it is seeded the same way: rename the field in the
    // declaring source and nowhere else, which is exactly what an
    // assembled-but-unread family looks like, and require the check to notice.
    const renamed = readFileSync(ENVIRONMENT_SOURCE, 'utf8').replaceAll(
      'browserPaths',
      'browserPathsNothingReads',
    );
    if (renamed === readFileSync(ENVIRONMENT_SOURCE, 'utf8')) {
      console.error(
        'Self-test FAILED: the family seed found no `browserPaths` to rename, so it reproduces ' +
          'nothing. Fix the seed.',
      );
      process.exitCode = 1;
    } else {
      const seededFamilies = checkConfigurationFamilies(renamed);
      const familyCaught = seededFamilies.failures.some((failure) =>
        failure.includes('BROKER_BROWSER_<NAME>_PATH'),
      );
      if (familyCaught) {
        console.log(
          'Self-test passed: the check goes red when the per-browser path family is assembled ' +
            'under a name nothing reads.',
        );
        for (const failure of seededFamilies.failures) console.log(`  would fail: ${failure}`);
      } else {
        console.error(
          'Self-test FAILED: the per-browser path family was made inert and the check stayed ' +
            'green, so the computed-key half observes nothing.',
        );
        process.exitCode = 1;
      }
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
          `arguments are read at the bridge under their own operation, ` +
          `${String(result.checkedFields)} required structured-request fields can be expressed ` +
          `from the tool surface, and ${String(result.checkedVariables)} declared variables are ` +
          `read outside their declaration.`,
      );
      // Printed on a passing run for the same reason a waiver is: a field that
      // can only arrive through the passthrough is fine *while the passthrough
      // is declared*, and that dependency should be visible to whoever is
      // reading a diff that touches the declaration.
      for (const entry of result.viaPassthroughOnly) {
        console.log(
          `  via the passthrough only: "${entry.field}" for ${entry.verbs} on ${entry.tool}`,
        );
      }
    }
  }
}
