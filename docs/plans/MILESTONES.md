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
| **7** | Initial migration — the **whole schema** in one baseline: browsers, claims, tabs, events, captures, baselines, **comparisons**, settings and its revision counter. Mechanics, indexes and the uniqueness rules are in "Implementation notes" below | 3 | |
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
| **12** | Capacity model: **one total tab budget across both browsers** and the admission predicate over it | 10 | |
| **13** | Claim: atomic grant-or-queue, secret key issue, one live claim per session | 12 | |
| **14** | Renew, plus the implicit renew on every keyed call | 13 | |
| **15** | Release: terminal, closes exactly that claim's tabs, triggers the admission sweep | 13 | |
| **16** | The reaper: expiry, tab-scoped reclamation, sweep — on a timer and on demand | 14, 15 | |
| **17** | Queue: first in first out, position and estimate, queued-entry expiry, re-queue at the back with a new key | 13, 16 | |
| **18** | Ownership guards: every tab-addressed operation refuses a tab not owned by the key | 13 | |
| **46** | **Allocation is all-or-nothing, and a queued response says what would fit.** The service never splits a request; a request that cannot be met queues carrying the number of tabs grantable **right now** at a smaller size, which browser that offer is for, and a note saying release-and-re-ask is how to take it. The offer is a snapshot, not a reservation, and says so (`SCHEMA.md` §2.3) | 17 | |

> **#13 carries the uniqueness question** (`SCHEMA.md` §1.11, `DECISIONS.md` §13b): one live lease
> per session cannot be expressed in the schema file directly. Three answers, set out with their SQL
> in "Implementation notes" below — a hand-written index with a documented drift-check exception,
> application-level enforcement (**not** race-proof without an explicit lock), or moving live rows
> into their own small tables so an ordinary unique constraint expresses it. The owner rules; do not
> let it land as an unguarded read-then-write.

**Milestone done when:** every guard in `SCHEMA.md` §7 has a passing test **including its rejection**,
and every rejection test asserts the physical side-effect as well as the response.

---

## M4 — Browsers

*Feature: the service actually drives something.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **19** | Driver interface **+ a fake driver with a call log** — what makes a rejection test able to assert that nothing happened | 10 | |
| **20** | Real driver over `@playwright/cli`: hold the two browsers, **explicit profile directories, never a default path**, restart on crash. Ships the inward-isolation test — **starts cleanly while an unrelated browser already holds the default profile** | 19 | |
| **21** | Tab lifecycle: open and close by opaque identifier, the identifier mapping, orphan sweep on restart | 20, 18 | |
| **22** | Navigate and act, tab-addressed, snapshot-to-path on every mutation | 21 | |
| **23** | Read: snapshot, console, network, cookie summary — all path-returning; **cookie values never returned** | 21 | |
| **24** | Evaluate, with an inline byte cap and spill-to-path | 21 | |
| **44** | **The setup handshake.** `broker init`, also run by `broker serve` before it serves: migrate, confirm the two browser rows, **create a profile that is absent and use one that is present — never recreate**, prove each browser with one launch and the startup checks, and report which profiles it created against which it found. Idempotent. Refuses with a named reason when the profile root is unwritable or another process holds a profile's lock (`SCHEMA.md` §1.2a) | 20 | |
| **45** | **The artifact store.** One directory per lease with subfolders by kind, baselines outside it, rooted at an environment variable defaulting under the platform's per-user application-data location. **Every stored path is relative to that root**, labels are sanitised and never treated as paths, and retention prunes capture and crop files while exempting baselines (`SCHEMA.md` §1.7a) | 20 | |

> **#19 lands as early as it possibly can, and that is the point of splitting it out.** It needs
> nothing but a service layer, and every rejection test written before it exists can only assert a
> response — which is the assertion that proves the least. See `DECISIONS.md` §5.
>
> **#20's explicit profile directories are a hard requirement, not a preference**, and the test that
> proves it is the *inward* half of bidirectional isolation (`DECISIONS.md` §6a). A default profile
> path is shared with anything else that also takes the default, and two processes on one profile
> contend on its lock file — so an unrelated run that started first would stop this service starting
> at all. "Do not disturb the wrong browser" cannot be tested; "starts while something else holds the
> default profile" can, and that is the assertion this row owes.

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
| **31** | Capture pipeline: take, downscale to the tier, write, return `{path, width, height, bytes}`. **Three tiers, cheapest by default with no parameter**; the highest additionally requires a `reason`; full-page off by default | 22 | |
| **32** | Per-capture telemetry: dimensions, bytes, downscaled-from, the tier, the escalation `reason`, estimated token cost | 31, 11 | |
| **33** | Capture accounting per claim: **a loud warning, never a refusal**, naming the cheaper alternative | 31, 12 | |
| **34** | Resolution-ladder harness and the one-off study; publish the chosen tiers **with their evidence**, superseding the provisional numbers | 32 | |

> **#31 carries the lever, not #33.** The low default is what does nearly all the work, because most
> callers never pass an optional parameter — so getting "cheapest tier when nothing is asked for"
> right matters more than any threshold downstream of it (`DECISIONS.md` §13d). The mandatory
> `reason` on the highest tier is not bureaucracy either: it is the only mechanism that produces
> data about *why* anyone escalates, which is what #34 needs to tune the default.
>
> **#33's warning message is the mechanism, not decoration.** A bare "you have taken a lot of
> captures" teaches a caller to ask for a bigger budget. A warning that names the snapshot or the
> evaluate answering the same question teaches the thing the policy exists to teach. **It never
> becomes a refusal** — an agent stopped mid-run on a legitimate job concludes the service is an
> obstacle, and a service that is occasionally expensive survives that where one that is occasionally
> unusable does not.
>
> **#34 settles the numbers with evidence rather than defending them.** The tiers that ship in #31
> are provisional and are labelled as such everywhere. Expect more than one threshold: text stops
> being legible before layout critique stops working, which is the property that makes a low default
> push a caller toward the text-returning tools rather than merely make its pictures worse.

**Milestone done when:** the cheapest tier is what a caller gets for asking for nothing, every
escalation is recorded with its reason, and no capture is ever refused.

---

## M7 — Changed-region review

*Feature: a repeat review looks at what changed, not at everything.*

Its own milestone rather than an extension of M6, because a baseline store, a comparison and a
tunable threshold are a **feature** with its own state, not a policy setting — and the dependency
graph reads more honestly with the split (`DECISIONS.md` §13a).

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **39** | Baseline store: one live baseline per **view, browser, kind and breakpoint** (`SCHEMA.md` §1.8). Promotion **copies** the image into the baselines area, requires a reason, records who, retires the incumbent in the same transaction, and refuses when the source capture's file has been swept. **Baseline files are exempt from capture retention** | 31 | |
| **40** | Compare: a capture against the stored baseline for that view, producing a diff mask. **Reuse a diff library; do not write a differ.** Ships the **geometry guard** — same width, kind, browser and element, with height free on a full page — because two differently-sized images produce a wrong answer that looks right | 39 | |
| **41** | Changed-region extraction: connected components over the mask into bounding boxes, merged at a configurable distance, and filtered **on area with a thin-line allowance** — not on the shorter side, which discards a one-pixel line across a wide page | 40 | |
| **42** | Region crops returned as paths — **both the baseline crop and the new one, from the same rectangle, with padding** — plus the outlined overlay, and the comparison exposed as **one** operation on the tool surface, not a family | 41, 27 | |
| **43** | Threshold tuning: a configurable colour tolerance, a fixture set of known-clean and known-changed pairs, and a test proving a **real** change is not swallowed. Build the fixtures from thin lines, border widths, focus rings and underlines — the cases the size filter is most likely to eat | 41 | |
| **48** | **A read surface for comparisons** — an endpoint and a command listing them by view, baseline or lease. The table's entire justification is that tuning reads it, so a version with nothing reading it has a justification and no evidence | 40, 26 | |
| **49** | **Delivering the crops**, per the ruling in `SCHEMA.md` §1.9: an endpoint serving a stored artifact's bytes with the ownership check, and optionally an inline return on the comparison under a size cap. Without it, a caller connected over the network is handed paths it cannot open — on the one feature whose entire output is pictures | 42, 26 | |

> **#43's negative direction is the one that matters.** Any threshold can be raised until nothing
> ever fails, and a comparison that reports "nothing changed" is indistinguishable from one that is
> working. The fixture set has to contain a change small enough to be interesting and prove it
> survives the threshold in force.
>
> **This is a second-visit feature and must never become a silent default.** With no baseline there
> is nothing to compare, and a comparison that quietly returns "no changes" on a first run is worse
> than one that refuses.
>
> **M6 is scheduled to break M7 and neither row said so.** #34 exists to change the resolution rungs.
> A comparison runs at its baseline's geometry, so **changing a rung invalidates every baseline made
> at it**. Whichever of #34 and #39 lands second owes a re-blessing step and a line in the release
> notes; the tier settings' help text says so too (`SCHEMA.md` §6.2).
>
> **Two things #31 owes M7 rather than M6**, because the comparison is worthless without them:
> settling the page before every shutter (animations stopped, caret hidden, fonts waited for) and a
> capture-time mask. Masking before the pixels exist beats filtering afterwards. `SCHEMA.md` §3.11.
>
> **`baselines.ignore_regions` lands in #7 even though M7 does not use it.** The schema arrives as
> one baseline migration and changes additively after that, so a column left out now costs a
> migration later for something already known to be wanted (`SCHEMA.md` §9.1a).
>
> **Before #39 starts, answer whether an off-the-shelf tool already does this half.** It is the one
> part of this design that is not arbitration, and no document here has checked.

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
| **47** | **A view of the record on the operations page** — the ledger sliced by kind, outcome and rule, with the cursor the endpoint already returns. Written from the first version, read from this one; the shape in `SCHEMA.md` §1.6 is what keeps it one query | 35 | |

> **#35 is deliberately one page and stays one page.** It answers "what is holding what, and how long
> is the queue". Anything needing a button is a different decision, taken separately, with a reason
> (`DECISIONS.md` §13b).
>
> **#38's ordering is the substance of it, not the prose.** Anything that reads state another
> component writes has to be removed before the component that writes it, or the reader keeps
> consuming a value that has silently stopped changing.

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

## Implementation notes — the mechanics, kept with the work that needs them

`SCHEMA.md` says what is being built and why, for a reader deciding whether to agree with it. This
section holds the part addressed to whoever implements it: transaction shapes, indexes, raw SQL and
test construction. Each block names the row it belongs to.

### #7 — indexes, and the three uniqueness rules

**Indexes.** At a tab budget of fifteen the live set is tens of rows, so none of these changes a
measurable thing on live data. They exist for the historical rows, which are the part that grows
without bound.

| Table | Index | Why |
|---|---|---|
| `claims` | `UNIQUE (key_hash)` | Every keyed call, which is every call that does anything |
| `claims` | `UNIQUE (id, browser_id)` | Not a query index — the target of the composite foreign key on `tabs` that stops a tab naming a browser its own lease did not. Free, given `id` is already unique |
| `claims` | `(state, expires_at)` | The reaper's scan: everything live and past its expiry, in one index range |
| `claims` | `(state, created_at)` | Head of queue, first in first out. Separate from the reaper's index because they order by different columns, and a scan that has to sort gets slower as history accumulates |
| `claims` | `(session_id, created_at DESC)` | A session's own history |
| `tabs` | `(claim_id)` | The ownership check, and everything release and the reaper do |
| `tabs` | `(id) WHERE state IN ('opening','open','closing')` | A partial index **whose predicate is the capacity predicate**, so the capacity count is an index-only scan over exactly the live rows and never touches history |
| `events` | `(at)` · `(claim_id, id)` · `(kind, at)` · `(guard) WHERE guard IS NOT NULL` | A slice read · one lease's whole history · the capture and comparison rollups · which rule refuses most, small because denials are rare |
| `captures` | `(claim_id)` · `(taken_at)` · `(view_key, viewport_width) WHERE view_key IS NOT NULL` | Listing, the rollup, and the promote lookup, which skips every unnamed capture |
| `comparisons` | `(baseline_id, at DESC)` | The history of one view's comparisons, which is what tuning reads |

**The three uniqueness rules**, as raw SQL, under the option named A in `SCHEMA.md` §1.11:

```sql
CREATE UNIQUE INDEX one_live_claim_per_session
  ON claims (session_id) WHERE state IN ('queued','active');

CREATE UNIQUE INDEX one_row_per_physical_tab
  ON tabs (browser_id, driver_tab_id) WHERE state IN ('opening','open','closing');

CREATE UNIQUE INDEX one_live_baseline
  ON baselines (view_key, browser_id, kind, viewport_width) WHERE retired_at IS NULL;
```

**The object-relational mapper cannot express any of these**, unique or not — its schema file has no
filter clause on an index, and no check constraints either. So this is one decision about a
construction that recurs three times. **Three answers, none free:**

| Answer | Race-proof | Cost |
|---|---|---|
| **A — hand-written migration** carrying the raw index, with the drift check taught to tolerate a documented exception | Yes | A permanent exception in a check whose entire value is having none, and it has to be per-index or it becomes a hole anything can walk through |
| **B — application-level enforcement** | **No, on its own.** Two concurrent requests can both read "no live lease" and both write one | Free in schema terms, and only acceptable inside a `SERIALIZABLE` transaction or behind an advisory lock keyed on the session — a real mechanism that has to be named as one |
| **C — live rows in their own small tables**, deleted rather than flagged | Yes — an ordinary unique constraint | Expressed natively, drift check clean, and the capacity count becomes a count of a small table. Three more tables, two writes per transition, and one cross-table invariant the service maintains. Failure is loud and immediate rather than silent |

**All three rules take the same answer**, or the drift check ends up carrying two kinds of exception.
`SCHEMA.md` §1.11 recommends C and leaves the ruling to the owner.

### #12 and #13 — admission is two-phase, and capacity is taken in the first phase

A browser call cannot sit inside a database transaction, so admission is split, and the split is
arranged so **the failure mode is capacity held too long, never a bound overshot**.

**Phase one, one transaction.** Count live tabs (`state IN ('opening','open','closing')`). If the
count plus the request is within the budget, insert the lease as active with its activation time and
insert that many `tabs` rows as `opening` with no driver identifier yet. Otherwise insert the lease as
queued and insert no tab rows. Append the record row. Commit.

**The count and the insert are in one `SERIALIZABLE` transaction, or behind an advisory lock on a
single capacity key. Read-then-write without one of those is not a bound** — it is a bound that holds
until two callers arrive together, which is the only condition under which anybody cares.

**Phase two, after the commit.** Ask the browser to open each tab. On success the row takes its driver
identifier and becomes `open`; on failure it becomes `failed` with a record entry.

**Why the tab rows exist before the tabs do.** A grant and its rows are the same number, so there is
exactly one counter and *total open tabs plus requested is within budget* is literally the predicate;
a tab stuck closing still counts, which is correct because its page may still exist; and a crash
between the phases leaves rows reserving capacity for tabs that do not exist, which #21's
reconciliation clears.

### #16 — the reaper

Runs every sweep interval and on demand immediately after any release, expiry or revoke.

**One transaction per lease, not one per pass.** A pass-wide transaction holds locks the hot path
needs, and a failure part-way through would un-expire the leases already handled.

Each pass, in this order: queued leases past their expiry become expired, with no browser work
because a queued lease owns nothing; active leases past their expiry become expired — in the
transaction, mark the lease final and each open tab `closing`; after the commit, ask the browser to
close each one and mark it `closed`, where a failed close increments the attempt count and leaves the
tab `closing` so it keeps counting against capacity; then the admission sweep.

**Escalation on a stuck close:** at three attempts the reaper stops retrying that tab, writes a sweep
entry naming it, and the operations page shows it. It is **not** force-closed by killing the browser.

**Disconnect, where the transport offers one.** Set the expiry to now plus the grace period rather
than revoking, because clients reconnect. The agent transport may not offer the signal at all, so
nothing depends on it.

### #21 — reconciliation before any traffic is served

1. Expire anything already past its expiry, as an ordinary reaper pass.
2. Fail every tab still `opening` — nothing can confirm an open that a dead process asked for.
3. Ask the browser for the live tab list of **each browser this service launched**, identified by the
   recorded process, so a browser somebody else is running is never inspected.
4. Reconcile: a live browser tab no live lease owns is closed; a row in `open` or `closing` whose
   browser tab is gone is marked closed; a row whose tab is present and whose lease is live is left
   alone.
5. Run the admission sweep, so capacity freed by 2–4 goes to the queue rather than sitting idle.

If the browsers are not running at start — the ordinary case — steps 3 and 4 close every live tab row
instead, because a tab inside a process that has exited is closed by definition.

### #25 and #30 — how the parity suite is built

**One driver per route, behind one interface**, in a map typed from the route registry the
application actually mounts through, so **adding a route without adding its driver does not compile.**

**Cases are authored once per operation, never per route.** A case names an operation, a seed, an
input and an expectation. The runner takes the cross product with every driver exposing that
operation, so a case costs nothing per route — which is what stops the suite decaying at the point
where writing cases becomes tedious.

**The fake browser records every call it receives**, and a refusing case asserts **two** things: the
call log for that case is empty, and the live tab count is unchanged, read from the same predicate the
capacity check uses. Both, because they catch different bugs — a guard that opens a tab and closes it
on the way to refusing leaves the count unchanged and the log full; a guard that decrements a counter
without telling the browser leaves the log empty and the count wrong.

**Waivers stay bounded by construction rather than by review attention:** no operation any registered
rule can refuse may be waived by a route that exposes any write operation. A route is read-only by
declaration, or fully covered, with nothing in between — otherwise a driver that declines to expose
anything passes the first assertion vacuously.

**Negative controls, each asserted to fail**, because an assertion nobody has watched fail is an
assertion nobody has tested: a fixture route reaching past the service layer to the database · a
registered rule with no case · a driver returning a different code for the same input · an operation
with only an accepting case · a refusing case whose call log is not empty · a refusing case that
leaves the tab count moved · a route exposing an operation the registry does not know · and a direct
assertion that the rule registry is not empty, because an assertion evaluated over an empty set
passes forever and silently.

**Cost.** Run in process wherever the process boundary is not the thing under test — call the handler
directly, drive the command line through its entry point with an argument vector. Keep a much smaller
spawned smoke subset (a real process, a real session, a real database) as its own job. The in-process
matrix runs on every change; the spawned subset proves the wiring and does not grow with the case
table.

### #3 — how the build-time rules are enforced

| Rule | Enforced by |
|---|---|
| The foreground is never moved | A source check failing on the identifier anywhere outside the one file that documents the prohibition, **plus** a fake-browser assertion that no call log across the whole suite contains it |
| No capture with the correct-surface option disabled | The same pair: a source check, and an assertion that no recorded capture call carries the option |
| No browser-wide destructive operation | The operation registry is typed so that an operation declaring a browser target and a destructive effect does not compile. Adding one fails the build rather than the review |
| Only the browser module imports the automation library; only the service layer, the settings resolver and migrations import the database client | An import **allowlist**, not a denylist of route directories — a denylist is wrong the first time somebody adds a directory nobody thought of |
| No setting is credential-shaped | A registry test failing the build |
| No path refuses a capture for cost | A test taking several hundred captures on one lease, asserting every one succeeded, that the warning fired past the threshold, and that it fired on **every** capture past it rather than once |

## Not scheduled, deliberately

Multi-machine execution — the driver interface leaves the seam and nothing more · a read-only widget
another system embeds — the endpoint is designed so it stays possible, and that is where it stops ·
a visual-regression **test runner** — comparison exists here to make review cheap, and the moment a
feature reads as "fail the build when the pixels move" it belongs elsewhere · authentication on the
operations page — a read-only page on a single host does not have that problem yet, and inventing one
means inventing a user model too · any general widening of the tool surface, which is refused by
default and only ever accepted with a reason arbitration specifically requires.
