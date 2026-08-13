/**
 * The self-test for the external-refs gate.
 *
 * **What a green run here means, and what it does not.** Green means the
 * gate fires on every shape it was taught, leaves the listed clean sentences
 * alone, honours waivers, and exits non-zero from a real process on a seeded
 * violation. It does **not** mean the gate catches everything a public
 * repository should keep out: a check written against a fixed set of known
 * shapes can only ever certify the absence of *those* shapes. A private
 * proper noun in ordinary prose, or a sentence that only makes sense to
 * someone who has seen a system this repository does not contain, passes
 * every assertion below. The script's header lists those edges; this suite
 * exists so the shapes it *does* know are provably live rather than
 * decorative.
 *
 * Written for the Node test runner deliberately: this gate has to run with
 * no install and no build step, so a docs-only tree can still be checked.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  ALLOWED_HOSTS,
  PATTERNS,
  SELF_EXEMPT,
  SKIPPED_FILES,
  findViolations,
  isScannable,
  summariseWaivers,
} from "../scripts/check-external-refs.mjs";

const scan = (text) => findViolations(text);
const ids = (text) => scan(text).map((v) => v.patternId);

const scriptPath = path.resolve(import.meta.dirname, "../scripts/check-external-refs.mjs");

/**
 * Run the checker as CI runs it — a real process, over real files — and hand
 * back the exit code plus both streams. The unit tests below cover matching;
 * this covers the thing that actually gates a build.
 */
function runCli(files, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...files], {
      cwd,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? -1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

const tempDirs = [];
function seedFile(name, contents) {
  const dir = mkdtempSync(path.join(tmpdir(), "external-refs-"));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, name), contents, "utf8");
  return { dir, file: name };
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("check-external-refs — what it catches", () => {
  // Each entry is the shape of a sentence that has to fail: something a
  // reader of this repository cannot verify because it lives outside it.
  // Written as grammar, never as the real names — see the script's header.
  const violating = [
    ["temporal-today", "Today the arbitration lives somewhere else."],
    ["temporal-today", "A port of today's slot table, backed by the database."],
    ["temporal-now", "The rules currently live in a client-side script."],
    ["temporal-now", "At present each client decides for itself."],
    ["temporal-past", "Previously this was enforced by a wrapper."],
    ["temporal-past", "Historically the gate ran on the client."],
    ["temporal-changed", "The lease used to be a slot."],
    ["temporal-changed", "That constraint no longer applies."],
    ["temporal-changed", "Until now the rules lived in client-side scripts."],
    ["temporal-changed", "Carried over from the earlier implementation."],
    ["temporal-changed", "We are moving off a one-process-per-client model."],
    ["supersession", "Replaces a set of per-client servers plus a guard script."],
    ["supersession", "This is the replacement for claiming a slot."],
    ["supersession", "The predecessor system had a process per caller."],
    ["supersession", "A shim so the legacy pool keeps working."],
    ["ported", "Version one is a port of the arbitration that already exists."],
    ["ported", "Ported from the guards that run on each machine."],
    ["the-old-thing", "Everything the old system blocked is now a refusal."],
    ["the-old-thing", "The original tool kept one process per caller."],
    ["the-old-thing", "Nothing here depends on the prior state of anything."],
    ["the-old-thing", "An old system had a browser for each of them."],
    ["the-old-thing", "Old scripts on each machine cannot be kept in step."],
    ["the-existing-thing", "Model it on the existing MCP server."],
    ["the-existing-thing", "It reads from an existing setup on that machine."],
    ["the-current-thing", "The current script does this already."],
    ["the-new-thing", "In the new service the rules are enforced."],
    ["cutover", "M8 is deployment, and the cutover."],
    ["someones-own-setup", "Something the user's setup cannot do at all."],
    ["someones-own-setup", "Which part of your world this concerns."],
    ["foreign-script-file", "The guard fires from a-guard.ps1 on every call."],
    // The browsing-surface class.
    ["machine-path", "The profile lives at C:\\Users\\someone\\browser-data."],
    ["machine-path", "Captures are written to /home/someone/captures."],
    ["machine-path", "Point it at ~/artefacts before starting."],
    ["machine-path", "The share is mounted from \\\\filer\\media."],
    ["profile-path", "Chromium defaults to %LOCALAPPDATA%\\browser-profile."],
    ["profile-path", "Copy the User Data/Default folder to keep the session."],
    ["private-address", "The database answers on 192.168.10.4."],
    ["private-address", "The service is reachable at 10.1.2.3 from the LAN."],
    ["private-address", "Point the client at broker.internal for now."],
    ["unlisted-host", "Open https://some-shop.test/checkout and click Pay."],
    ["unlisted-host", "The baseline was captured from http://intranet.acme-corp.test/."],
  ];

  for (const [patternId, text] of violating) {
    it(`fails on a ${patternId} shape: ${text}`, () => {
      assert.ok(
        ids(text).includes(patternId),
        `expected ${patternId} in [${ids(text).join(", ")}] for: ${text}`,
      );
    });
  }

  it("reports the line, the column and the text that matched", () => {
    const [violation] = scan("clean first line\nand then the old system\n");

    assert.equal(violation.line, 2);
    assert.equal(violation.patternId, "the-old-thing");
    assert.equal(violation.match, "the old");
    assert.equal(violation.kind, "external-ref");
    // The column points at the match, not at the start of the line — a
    // failure message that says "somewhere on line 2" is one people skim.
    assert.match(violation.text.slice(violation.column - 1), /^the old/);
  });

  it("catches every occurrence on a line, not just the first", () => {
    assert.deepEqual(ids("the old pool and the old queue"), ["the-old-thing", "the-old-thing"]);
  });

  it("catches every determiner in front of `old`, not only `the`", () => {
    // The shape is written `old(er)?` rather than `older?`, because `?` binds
    // to a single character — `older?` would mean "olde" plus an optional
    // "r" and match nothing anyone writes. `\bthe old\b` alone would carry
    // the whole shape and hide that: the commonest form covered, every other
    // determiner straight through.
    for (const text of [
      "an old system",
      "our old pool",
      "old scripts",
      "my old setup",
      "one old way of doing it",
      "an older version",
    ]) {
      assert.ok(ids(text).includes("the-old-thing"), text);
    }
  });

  it("matches regardless of case", () => {
    assert.ok(ids("TODAY the rules live elsewhere").includes("temporal-today"));
    assert.ok(ids("Replaces the wrapper").includes("supersession"));
  });

  it("has a stated reason for every pattern, because the message is the point", () => {
    for (const pattern of PATTERNS) {
      assert.ok(pattern.why.length > 20, `${pattern.id} needs a reason worth reading`);
    }
  });
});

describe("check-external-refs — the host allowlist", () => {
  // The one place a real name legitimately appears in the script, and the
  // reason it is safe: an allowlist names what this repository *may* say,
  // so it publishes nothing. These assertions are what stop it drifting into
  // the denylist the scanning rule forbids.
  it("lets a citation host and the example domains through", () => {
    for (const clean of [
      "See https://github.com/example-org/example-repo/issues/1 for the thread.",
      "The documentation is at https://playwright.dev/agent-cli/sessions.",
      "Post the claim to http://localhost:8080/claims.",
      "Open https://example.com/checkout in the leased tab.",
      "Health checks hit http://127.0.0.1:8080/healthz.",
    ]) {
      assert.deepEqual(scan(clean), [], clean);
    }
  });

  it("does not let a prefix of an allowed host through", () => {
    // `example.company-name.test` starts with an allowed name and is not one.
    // Without the inner boundary check, every host beginning "example.com…"
    // would pass — which is the failure mode of a naive allowlist.
    assert.ok(ids("Fetch https://example.company-name.test/cart").includes("unlisted-host"));
    assert.ok(ids("Fetch https://github.community-mirror.test/x").includes("unlisted-host"));
  });

  it("keeps the allowlist short and free of anything private", () => {
    // A growing allowlist is how this check gets quietly disabled: every
    // entry silences a whole host. Pinning the list makes each addition a
    // visible line in a diff with a reason next to it in the review.
    assert.deepEqual(ALLOWED_HOSTS, [
      "example.com",
      "example.org",
      "example.net",
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
      "github.com",
      "playwright.dev",
      "nodejs.org",
      "npmjs.com",
      "modelcontextprotocol.io",
      "opensource.org",
    ]);
  });
});

describe("check-external-refs — what it must not flag", () => {
  // The failure mode of a check like this is being too noisy to keep, so
  // these are the in-repo sentences it has to leave alone. Each is phrasing
  // that appears, or plausibly would appear, in this repository.
  const clean = [
    "The rules live in the service layer and are enforced, not requested.",
    "Only share a browser if the lease says you may.",
    "The key is used to route the call to the right tab.",
    "Reject it and name the holder of the lease.",
    "A claim is `queued`, `active`, `released`, `expired` or `revoked`.",
    "You cannot release a claim that is already terminal.",
    "Pick a host port that is not already in use.",
    "The published port of the service container is 8080.",
    "Replace the stub driver with the real one.",
    "Return the original error rather than wrapping it.",
    "Fill in the values for your environment.",
    "A compatibility shim, kept for one release.",
    "Keep supporting the legacy config format for one more major.",
    "The eslint flat-config legacy shim chokes on older syntax.",
    "Older captures keep pointing at the baseline they were compared against.",
    "A woken old session is told its lease expired rather than failing blankly.",
    // Path-shaped text that is *relative*, which is what this repository
    // writes. A check that fires on `docs/plans/PLAN.md` would be waived
    // into uselessness on its first run.
    "Baselines are written under the configured artefact root.",
    "See docs/plans/SCHEMA.md for the return shape.",
    "Run node scripts/check-external-refs.mjs before committing.",
    // Version-shaped numbers must not read as private addresses.
    "Requires Node 22.11.0 or later.",
    "Bumped from 10.2.1 to 10.3.0.",
  ];

  for (const text of clean) {
    it(`leaves this alone: ${text}`, () => {
      assert.deepEqual(scan(text), [], text);
    });
  }

  it("skips binary files and lockfiles rather than reading them", () => {
    assert.equal(isScannable("docs/plans/PLAN.md"), true);
    assert.equal(isScannable("src/service/claim.ts"), true);
    assert.equal(isScannable("package-lock.json"), false);
    assert.equal(isScannable("docs/diff-example.png"), false);
  });

  it("exempts only the two files that must contain the shapes", () => {
    // One defines the patterns, the other proves they are caught. If this
    // list ever grows, the growth is the bug: an exemption list that can be
    // extended quietly is a slower way of deleting the check.
    assert.deepEqual(SELF_EXEMPT, [
      "scripts/check-external-refs.mjs",
      "tests/check-external-refs.test.mjs",
    ]);
    for (const exempt of SELF_EXEMPT) {
      assert.equal(isScannable(exempt), false);
    }
  });

  it("skips only generated files, so coverage cannot be dropped by adding a name", () => {
    // Same reasoning as SELF_EXEMPT, for the other list that can silence a
    // file. Adding "README.md" here would disable scanning of the most
    // public file in the repository with the suite still green.
    assert.deepEqual(SKIPPED_FILES, ["package-lock.json"]);
  });
});

describe("check-external-refs — waivers", () => {
  it("a same-line waiver silences that line", () => {
    assert.deepEqual(
      scan("the old commit is still there <!-- external-ref-ok: this repository's own git history -->"),
      [],
    );
  });

  it("a next-line waiver silences the line after it", () => {
    const text = [
      "<!-- external-ref-ok-next-line: describes this repository's own migration check -->",
      "replaying the migration history no longer reproduces the schema",
    ].join("\n");

    assert.deepEqual(scan(text), []);
  });

  it("a next-line waiver silences only the next line", () => {
    const text = [
      "<!-- external-ref-ok-next-line: covers the migration note below -->",
      "no longer reproduces the committed schema",
      "and the old system did it differently",
    ].join("\n");

    assert.deepEqual(
      scan(text).map((v) => v.line),
      [3],
    );
  });

  it("works in a line comment as well as an HTML comment", () => {
    assert.deepEqual(scan("// external-ref-ok: this is about this repository's history"), []);
  });

  it("rejects a waiver with no reason — silencing the check has to cost an explanation", () => {
    const violations = scan("the old thing <!-- external-ref-ok: -->");

    assert.equal(violations.length, 1);
    assert.equal(violations[0].patternId, "waiver-without-a-reason");
    assert.equal(violations[0].kind, "empty-waiver");
  });

  it("rejects a waiver whose reason is too short to be a reason", () => {
    assert.deepEqual(ids("the old thing <!-- external-ref-ok: fine -->"), [
      "waiver-without-a-reason",
    ]);
  });

  it("rejects padding that is long enough but says nothing", () => {
    // A length check alone lets these through, which satisfies the letter of
    // "say why" and none of its point.
    assert.deepEqual(ids("the old thing <!-- external-ref-ok: xxxxxxxxxxxx -->"), [
      "waiver-without-a-reason",
    ]);
    assert.deepEqual(ids("the old thing <!-- external-ref-ok: ............ -->"), [
      "waiver-without-a-reason",
    ]);
  });

  it("rejects a reason made only of words that explain nothing", () => {
    // Each is three words and over twelve characters, so a length check and
    // a word count both pass them — and each says exactly as much as an
    // empty waiver.
    //
    // The last fixture is the one that pins DISTINCTNESS, and it is the only
    // one that does: every other entry here is killed by the filler list on
    // its own (`todo` is filler too), so dropping the `new Set` would leave
    // them all still rejected and the suite still green. "capture capture
    // capture" is one real word padded out to three — three words, twenty-
    // three characters, one distinct non-filler word — so it is rejected
    // today and accepted the moment distinctness goes.
    for (const junk of [
      "this is fine",
      "TODO TODO TODO",
      "lorem ipsum dolor",
      "it is fine really",
      "just ignore this one",
      "waived for reasons",
      "this is the one",
      "capture capture capture",
    ]) {
      assert.deepEqual(
        ids(`the old thing <!-- external-ref-ok: ${junk} -->`),
        ["waiver-without-a-reason"],
        junk,
      );
    }
  });

  it("accepts the reasons a real waiver in this repository actually gives", () => {
    // The other half of the test above, and the one that stops the filter
    // being tightened until it rejects honest waivers. The first two are
    // live waiver reasons in this repository.
    for (const real of [
      "this rule has to quote the phrasing it forbids in order to state it",
      "naming the shapes it matches is the documentation; they are grammar, not real values",
      '"no longer" is about this repository\'s own migration history, not an earlier system',
      "this one is about this repository",
    ]) {
      assert.deepEqual(scan(`the old thing <!-- external-ref-ok: ${real} -->`), [], real);
    }
  });

  it("a plain waiver covers its own line and no more", () => {
    // Worth pinning: the two forms differ, and getting this backwards would
    // silently widen every waiver in the repository.
    const text = [
      "<!-- external-ref-ok: this line is really about this repository -->",
      "the old pool is still described here",
    ].join("\n");

    assert.deepEqual(
      scan(text).map((v) => v.line),
      [2],
    );
  });

  it("reports how much the waivers in a file are silencing", () => {
    // A waiver covers a whole line, and a line is unbounded — one reason can
    // excuse several matches across several shapes. That is an acceptable
    // design only if it is visible, so the summary counts it.
    const wide =
      "the old pool and today's queue and the current script <!-- external-ref-ok: all three are about this repository -->";

    assert.deepEqual(scan(wide), []);
    const summary = summariseWaivers(wide);
    assert.equal(summary.waivers, 1);
    assert.ok(summary.suppressed >= 3, `expected at least 3 suppressed, got ${summary.suppressed}`);
  });

  it("counts the second line a -next-line waiver covers", () => {
    const text = [
      "<!-- external-ref-ok-next-line: this one is about this repository -->",
      "the old pool and today's queue and the current script",
    ].join("\n");

    assert.deepEqual(scan(text), []);
    const summary = summariseWaivers(text);
    assert.equal(summary.waivers, 1);
    assert.ok(summary.suppressed >= 3, `expected at least 3 suppressed, got ${summary.suppressed}`);
  });

  it("counts nothing when there are no waivers", () => {
    assert.deepEqual(summariseWaivers("the service refuses the call"), {
      waivers: 0,
      suppressed: 0,
    });
  });

  it("treats a waiver inside a fenced block as documentation, not a waiver", () => {
    // The rules file has to show the syntax to teach it. Those examples must
    // not be live, or every reader miscounts the real waivers — and worse,
    // violating text pasted into that block later would be silently excused.
    const text = [
      "```markdown",
      "<!-- external-ref-ok: why this one is really about this repository -->",
      "```",
      "the old pool is described here",
    ].join("\n");

    assert.deepEqual(summariseWaivers(text), { waivers: 0, suppressed: 0 });
    assert.deepEqual(
      scan(text).map((v) => v.line),
      [4],
    );
  });

  it("still scans inside a fence, so a violating example cannot hide there", () => {
    const text = ["```markdown", "the old pool, as an example", "```"].join("\n");

    assert.deepEqual(
      scan(text).map((v) => v.patternId),
      ["the-old-thing"],
    );
  });
});

describe("check-external-refs — shapes that straddle a line break", () => {
  // Every doc in docs/plans is hard-wrapped at ~100 columns, so a phrase
  // lands astride a break roughly as often as not. A line-at-a-time matcher
  // is blind to exactly those — a gap the width of the corpus.
  it("catches a shape split across a hard wrap", () => {
    const violations = scan("cannot drift the way the\nold per-client scripts could");

    assert.equal(violations.length, 1);
    assert.equal(violations[0].patternId, "the-old-thing");
    assert.equal(violations[0].line, 1);
    // The rendered line shows both halves, or the message is unactionable.
    assert.ok(violations[0].text.includes("⏎"));
  });

  it("reports a straddling match once, not twice", () => {
    // The same words on one line are found by the first pass; the second
    // pass must not double-report them.
    assert.equal(scan("cannot drift the way the old per-client scripts could").length, 1);
  });

  it("points at where the match starts, not at the start of the line", () => {
    // The second pass finds matches in the whole file flattened to one
    // string, then maps an offset in that string back to a line and column.
    // That arithmetic depends on the join separator being exactly one
    // character wide, and nothing else pins it: get it wrong and every
    // straddling match is still *reported*, just at coordinates that send the
    // reader to the wrong place. The clean lines above the straddle are
    // load-bearing — the drift only accumulates once there are earlier lines
    // to accumulate over, so a fixture starting on line 1 proves nothing.
    const lines = [
      "some clean text here",
      "another clean line",
      "cannot drift the way the",
      "old per-client scripts could",
    ];
    const [violation] = scan(lines.join("\n"));

    assert.equal(violation.patternId, "the-old-thing");
    assert.equal(violation.line, 3);
    assert.equal(violation.column, 22);
    assert.equal(lines[2].slice(violation.column - 1), "the");
  });

  it("catches a straddle whose continuation line is indented, and columns it correctly", () => {
    // Wrapped list items, numbered points and indented paragraphs continue on
    // a line starting with two or three spaces. Joining those raw puts three
    // spaces where the rendered text has one, so the phrase never matches —
    // and this corpus is mostly indented prose, so that would be most of it.
    //
    // The column assertion is the other half and needs the indented line to
    // be where the match *starts*: the trim has to be added back, or every
    // column on an indented line points at the wrong character.
    const lines = [
      "intro line",
      "  a bullet that wraps the way the",
      "  old per-client scripts could",
    ];
    const [violation] = scan(lines.join("\n"));

    assert.equal(violation.patternId, "the-old-thing");
    assert.equal(violation.line, 2);
    assert.equal(violation.column, 31);
    assert.equal(lines[1].slice(violation.column - 1), "the");
  });

  it("still catches a straddle when the line before the break has trailing whitespace", () => {
    // The trim does two jobs: dropping the *leading* whitespace the
    // indentation test above pins, and dropping *trailing* whitespace left by
    // an editor or a hard-wrap tool. Drop only the trailing half and this is
    // the fixture that goes red.
    const lines = ["a rule now lives in the   ", "old system that enforces it"];
    const [violation] = scan(lines.join("\n"));

    assert.equal(violation.patternId, "the-old-thing");
    assert.equal(violation.line, 1);
    assert.ok(violation.text.includes("⏎"));
  });

  it("does not weld a phrase across a blank line — that is a paragraph break, not a wrap", () => {
    // The flattening exists because a hard wrap is not a boundary in the
    // rendered text. A blank line is: it ends the paragraph, and the two
    // halves are never read as one sentence. Joining must not manufacture a
    // match out of them.
    //
    // This is the property pulling against the indentation fix above, which
    // is why both are pinned: an empty line trims to the empty string and
    // still contributes its own separator, so the halves end up two spaces
    // apart and cannot form a phrase.
    for (const blank of ["", "   "]) {
      const text = ["a rule lives in one place, not in the", blank, "old client-side wrapper"].join(
        "\n",
      );

      assert.deepEqual(scan(text), []);
    }
  });

  it("holds the blank-line guarantee only because every pattern uses a literal space", () => {
    // The blank-line test above is not a general truth about the join — it
    // holds *because* a blank line trims to "" and still contributes the
    // join's own separator, landing the two halves exactly two spaces apart,
    // and every shape in PATTERNS uses a literal single space between words
    // (`\bthe old\b`, never `\bthe\s+old\b`). A two-space gap cannot satisfy
    // a one-space literal, so the paragraph break holds.
    //
    // That is a property of the registry, not of the join, and nothing
    // enforces it structurally: the day a pattern is written with `\s+` or
    // `\s*`, a blank line starts welding unrelated paragraphs into false
    // matches across the whole corpus, and the blank-line test above would
    // not notice, because it only ever asserts through one shape. This is
    // the trip-wire for that.
    for (const pattern of PATTERNS) {
      assert.doesNotMatch(pattern.regex.source, /\\s/, `${pattern.id} uses a whitespace class`);
    }
  });

  it("respects a waiver on either side of the break", () => {
    const onFirst = [
      "<!-- external-ref-ok: this wrapped line is about this repository -->",
      "cannot drift the way the",
      "old per-client scripts could",
    ].join("\n");
    // The waiver covers its own line and, being a plain waiver, not the rest
    // — but the straddle starts on line 2, so waive there instead.
    assert.equal(scan(onFirst).length, 1);

    const onSecond = [
      "<!-- external-ref-ok-next-line: this wrapped line is about this repository -->",
      "cannot drift the way the",
      "old per-client scripts could",
    ].join("\n");
    assert.deepEqual(scan(onSecond), []);
  });
});

describe("check-external-refs — as CI runs it", () => {
  it("exits non-zero and names the file, line and shape", () => {
    // The seeded violation. This is the assertion that makes the gate a gate:
    // a check only ever proven to pass on clean input has never been run
    // against the thing it exists to catch.
    const { dir, file } = seedFile(
      "seeded.md",
      "# Notes\n\nIt replaces the old slot table, and the profile is at C:\\Users\\someone\\data.\n",
    );

    const result = runCli([file], dir);

    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("seeded.md:3"), result.stderr);
    assert.ok(result.stderr.includes("[supersession]"), result.stderr);
    assert.ok(result.stderr.includes("[the-old-thing]"), result.stderr);
    assert.ok(result.stderr.includes("[machine-path]"), result.stderr);
    // The failure has to say how to record a deliberate exception, or the
    // only thing anyone learns from it is how to skip the step.
    assert.ok(result.stderr.includes("external-ref-ok"), result.stderr);
  });

  it("exits zero on clean text and says how much it looked at", () => {
    const { dir, file } = seedFile(
      "clean.md",
      "# Notes\n\nThe rules live in the service layer and it refuses the call.\n",
    );

    const result = runCli([file], dir);

    assert.equal(result.status, 0);
    // Reports what it did *not* read as well as what it did — coverage that
    // only ever reports success can fall silently.
    assert.ok(result.stdout.includes("Scanned 1 of 1 files"), result.stdout);
  });

  it("says how many files it skipped, so coverage cannot drop unnoticed", () => {
    const { dir, file } = seedFile("clean.md", "The service refuses the call.\n");
    writeFileSync(path.join(dir, "package-lock.json"), "{}\n", "utf8");

    const result = runCli([file, "package-lock.json"], dir);

    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("Scanned 1 of 2 files (1 skipped"), result.stdout);
  });

  it("passes over this repository as it stands", () => {
    // The whole point of landing the sweep and the check together: the check
    // is not merely runnable, it is green on the tree it ships with.
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const result = runCli([], repoRoot);

    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
  });
});
