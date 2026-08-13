# Browser Broker — milestones and the work queue

> ## ⚠️ Provisional until `SCHEMA.md` is settled
>
> `SCHEMA.md` is the output of the design interview, and it is not written yet. That interview will
> change **what the work is**, not merely the order it happens in — rows will be added, split, merged
> and dropped once every table, tool, endpoint and guard has a concrete shape somebody has argued
> with.
>
> So: read this as the shape of the work and the dependency structure, not as a contract. **Do not
> start M2 or later from this file alone.** M1 is safe — it is repository and pipeline work that no
> schema decision can invalidate.

Eight milestones. Each is a **feature you can point at** ("the service arbitrates", "an agent can
drive a browser through it"). Each contains pull requests, and **one pull request is one mergeable
branch** with its own review.

Every row lists what it delivers and what it needs. Status legend: `done` · `open` · blank = not
started.

---

## How to find work

```
available = rows where Status is blank AND every id in "Needs" is done
```

That one line is what lets an agent compute its next job without asking anyone, which is the entire
point of the format.

Prefer the lowest-numbered available row unless something else is genuinely more urgent. **Two rows
in the same milestone rarely conflict; two in different milestones almost never do**, which is what
makes running several agents in parallel safe here.

**Numbers are allocated in the order work was planned, not in the order it should be done.** M7 is
numbered #39–#43 and sits *before* M8's #35–#38 in this file, because renumbering would invalidate
every `Needs` reference in it. **The `Needs` column is what gates; the number is only a tiebreak
among rows that are already available.** If those two ever disagree, `Needs` wins.

**#3 is the fan-out point.** Almost nothing else can start until it merges, because everything
downstream needs the package manifest, the database tooling and the test harness to exist. Knowing
which single merge widens the graph is what turns a queue into parallel work — so if #3 is available
and something else is too, #3 goes first regardless of what looks more interesting.

Every row after #1 is a branch and a pull request. Build it in a worktree, get it reviewed, merge it,
then immediately look up what that merge unblocked.

---

## M1 — Repository and pipeline

*Feature: the repository builds, ships an image, and nothing reaches `main` unreviewed or unchecked.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **1** | The four planning documents and the directives file, **plus the public-repo hygiene gate and its self-test**, committed straight to `main` | — | `done` |
| **2** | Publish the repository and protect `main` — linear history, no force-push, no deletions, pull request required | 1 | |
| **3** | **The boilerplate (fan-out point).** Application skeleton, database tooling, Dockerfile, compose, CI workflow, image-release workflow, test harness, lint and format | 2 | |
| **4** | Required status checks pointed at the jobs from #3 | 3 | |
| **5** | Public-repo hygiene gate wired into CI on every pull request | 3 | `done` |
| **6** | First published image — trigger a release, pull it, prove it runs | 3 | |

> **#1 and #2 are not really pull requests** — they are the two setup steps that make pull requests
> possible. They keep numbers because everything downstream points at them.
>
> **What exists and what does not, precisely.** #1's content is committed on `main` in a local
> repository: the documents, the directives, the hygiene gate and a hundred passing self-tests.
> **There is no remote yet.** Creating it, pushing, and turning on branch protection is #2's job, and
> nothing here has been published until that happens.
>
> **#5 is marked done because the gate shipped inside #1**, which is deliberate rather than
> convenient: a public-repo gate that lands *after* the first prose is a gate that never ran against
> the first prose, and the first prose is where the leaks are. What #5 has left is one CI step
> invoking `npm run check:external-refs`, which cannot exist until #3 creates the workflow.
>
> The gate runs on the Node test runner with **no dependencies**, so it works on a tree with nothing
> installed. #3 may move it to whatever runner the application settles on — if it does, the
> seeded-violation test moves with it or the move is not finished.

**Milestone done when:** a merge to `main` produces an image the host can pull and run, and nothing
reaches `main` without passing checks.

---

## M2 — State and the service core

*Feature: the database exists and there is one place rules can be enforced. No surface yet.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **7** | Initial migration — the **whole schema** in one baseline: browsers, claims, tabs, events, captures, baselines, settings | 3 | |
| **8** | Database client, connection pooling, migrate-on-boot | 7 | |
| **9** | Typed settings registry — declared in code, database holds overrides only, a fresh database boots working | 8 | |
| **10** | Service-layer skeleton: transactions, typed errors, and the rejection taxonomy every guard draws from | 8 | |
| **11** | Events: append a row on every decision — **allow and deny alike** | 10 | |

> **#11 is not optional telemetry.** A record that only contains refusals cannot answer "was this
> guard ever actually reached", which is the question asked the first time something behaves oddly.

**Milestone done when:** the schema is applied by boot, settings resolve from code defaults over
database overrides, and every service call can write a decision row.

---

## M3 — Arbitration

*Feature: the service arbitrates. This is the app.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **12** | Capacity model: per-browser tab budget and the admission predicate | 10 | |
| **13** | Claim: atomic grant-or-queue, secret key issue, one live claim per session | 12 | |
| **14** | Renew, plus the implicit renew on every keyed call | 13 | |
| **15** | Release: terminal, closes exactly that claim's tabs, triggers the admission sweep | 13 | |
| **16** | The reaper: expiry, tab-scoped reclamation, sweep — on a timer and on demand | 14, 15 | |
| **17** | Queue: first in first out, position and estimate, queued-entry expiry, re-queue at the back with a new key | 13, 16 | |
| **18** | Ownership guards: every tab-addressed operation refuses a tab not owned by the key | 13 | |

> **#13 carries the partial-index question** (`SCHEMA.md` §1, `DECISIONS.md` §13b): one live claim
> per session cannot be expressed in the schema layer directly. It is decided in this pull request,
> with the transaction shape in front of it — a hand-written index with a documented drift-check
> exception, or serialised application-level enforcement, which is **not** race-proof without an
> explicit lock. Do not let it land as an unguarded read-then-write.

**Milestone done when:** every guard in `SCHEMA.md` §7 has a passing test **including its rejection**,
and every rejection test asserts the physical side-effect as well as the response.

---

## M4 — Browsers

*Feature: the service actually drives something.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **19** | Driver interface **+ a fake driver with a call log** — what makes a rejection test able to assert that nothing happened | 10 | |
| **20** | Real driver over `@playwright/cli`: hold the two browsers, **explicit profile paths, never the default**, restart on crash | 19 | |
| **21** | Tab lifecycle: open and close by opaque identifier, the identifier mapping, orphan sweep on restart | 20, 18 | |
| **22** | Navigate and act, tab-addressed, snapshot-to-path on every mutation | 21 | |
| **23** | Read: snapshot, console, network, cookie summary — all path-returning; **cookie values never returned** | 21 | |
| **24** | Evaluate, with an inline byte cap and spill-to-path | 21 | |

> **#19 lands as early as it possibly can, and that is the point of splitting it out.** It needs
> nothing but a service layer, and every rejection test written before it exists can only assert a
> response — which is the assertion that proves the least. See `DECISIONS.md` §5.
>
> **#20's explicit profile paths are not a preference.** The default persistent profile path is not
> documented as being keyed by session, so two persistent sessions may contend on one directory and
> its lock file. Passing an explicit path costs nothing and removes the question
> (`DECISIONS.md` §11).

**Milestone done when:** a claim can open a tab, navigate it, act on it, read from it and close it,
and nothing in the surface can touch a browser the service did not launch.

---

## M5 — Adapters and parity

*Feature: the same rules, whichever door you come in through.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **25** | Adapter contract and the shared conformance harness — **an unregistered adapter fails the suite** | 10 | |
| **26** | HTTP/JSON adapter | 25 | |
| **27** | MCP-over-HTTP adapter — the primary route, one shared long-lived process | 25 | |
| **28** | MCP-over-stdio adapter, over the same transport-agnostic core | 27 | |
| **29** | Command-line adapter (`broker claim` / `ls` / `release`) — the operations surface, and the parity proof | 25 | |
| **30** | Parity suite green across all four: identical operations, identical refusals, **identical side-effects** | 26, 27, 28, 29 | |

> **#29 is worth building even if no agent ever calls it.** It is the cheapest available proof that
> the rules live in the service layer rather than inside an MCP handler, and a rule inside a handler
> is a rule that holds on one transport and not the others.

**Milestone done when:** every adapter passes the conformance suite, and adding a new one without
registering it fails.

---

## M6 — Capture policy

*Feature: what a capture costs is decided by the thing taking it.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **31** | Capture pipeline: take, downscale to the ceiling, write, return `{path, width, height, bytes}` | 22 | |
| **32** | Per-capture telemetry: dimensions, bytes, downscaled-from, estimated token cost | 31, 11 | |
| **33** | Screenshot budget per claim: warn threshold, and a typed refusal that names the cheaper alternative | 31, 12 | |
| **34** | Resolution-ladder harness and the one-off study; publish the chosen ceiling **with its evidence** | 32 | |

> **#33's refusal message is the mechanism, not decoration.** A bare "budget exceeded" teaches a
> caller to ask for a bigger budget. A refusal that names the snapshot or evaluate that answers the
> same question teaches it the thing the policy exists to teach.
>
> **#34 settles the defaults with evidence rather than defending them.** Expect more than one
> threshold: text stops being legible before layout critique stops working.

**Milestone done when:** no capture can leave the service above the ceiling, and every one of them is
accounted for.

---

## M7 — Changed-region review

*Feature: a repeat review looks at what changed, not at everything.*

Its own milestone rather than an extension of M6, because a baseline store, a comparison and a
tunable threshold are a **feature** with its own state, not a policy setting — and the dependency
graph reads more honestly with the split (`DECISIONS.md` §13a).

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **39** | Baseline store: one baseline per view and breakpoint, promoting a capture to a baseline, and retention | 31 | |
| **40** | Compare: a capture against the stored baseline for that view, producing a diff mask. **Reuse a diff library; do not write a differ** | 39 | |
| **41** | Changed-region extraction: connected components over the mask into bounding boxes, merged and size-filtered | 40 | |
| **42** | Region crops returned as paths, and the comparison exposed as **one** operation on the tool surface — not a family | 41, 27 | |
| **43** | Threshold tuning: a configurable anti-aliasing threshold, a fixture set of known-clean and known-changed pairs, and a test proving a **real** change is not swallowed by the threshold | 41 | |

> **#43's negative direction is the one that matters.** Any threshold can be raised until nothing
> ever fails, and a comparison that reports "nothing changed" is indistinguishable from one that is
> working. The fixture set has to contain a change small enough to be interesting and prove it
> survives the threshold in force.
>
> **This is a second-visit feature and must never become a silent default.** With no baseline there
> is nothing to compare, and a comparison that quietly returns "no changes" on a first run is worse
> than one that refuses.

**Milestone done when:** a second capture of the same view returns only the regions that moved, and
the threshold can be tuned without anyone guessing.

---

## M8 — Adoption

*Feature: it runs somewhere, you can see what it is doing, and turning it on is safe.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **35** | Operations page: live claims, queue depth, tab budget, each claim's stated purpose. **One static page over the HTTP adapter — read-only, no controls, no sign-in** | 26 | |
| **36** | Deployment: image pulled on the host, configuration, health check | 6, 27 | |
| **37** | Measurement harness: the schema-residency count, and matched-pair comparison over real review work | 27 | |
| **38** | Rollout runbook: phased enablement from a zero tab budget to sole route, in the order that never leaves traffic unarbitrated | 36, 37 | |

> **#35 is deliberately one page and stays one page.** It answers "what is holding what, and how long
> is the queue". Anything needing a button is a different decision, taken separately, with a reason
> (`DECISIONS.md` §13b).
>
> **#38's ordering is the substance of it, not the prose.** Anything that reads state another
> component writes has to be removed before the component that writes it, or the readers spend the
> gap consulting a record nothing is updating.

**Milestone done when:** the service is the only route to a browser, and the sequence that got it
there is written down.

---

## Critical path

**1 → 2 → 3 → 7 → 8 → 10 → 12 → 13 → 19 → 20 → 22 → 27 → 38.**

That is a **narrative** of the sequence that matters rather than the graph's longest chain. Two
things fall out of it and are worth stating, because they are what to protect when the queue gets
busy:

- **#10 and #19 are the two widest fan-out points after #3.** Once both have merged, M3 and M4 run
  largely in parallel, and M5's adapters are parallel to each other after #25.
- **#19 is early on purpose despite being a testing concern.** Everything in M3 is guards, and a
  guard tested only through its response is a guard tested at the wrong layer.

## Sequenced wrong more often than anything else

- **#5 before the prose it polices.** A hygiene gate landing after the documents has already missed
  the run that mattered. This is why it shipped inside #1.
- **#19 before the guards.** It has one prerequisite and constrains how every M3 test is written.
  Landing it late means every rejection test written in the meantime asserts only a response.
- **M7 after M6.** The comparison needs the capture pipeline (#31) and nothing else from M6, so it
  can start well before the capture policy is finished. Its number says otherwise; its `Needs` does
  not.

## Not scheduled, deliberately

Multi-machine execution — the driver interface leaves the seam and nothing more · a read-only widget
another system embeds — the endpoint is designed so it stays possible, and that is where it stops ·
a visual-regression **test runner** — comparison exists here to make review cheap, and the moment a
feature reads as "fail the build when the pixels move" it belongs elsewhere · authentication on the
operations page — a read-only page on a single host does not have that problem yet, and inventing one
means inventing a user model too · any general widening of the tool surface, which is refused by
default and only ever accepted with a reason arbitration specifically requires.
