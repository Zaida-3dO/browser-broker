# Browser Broker — milestones and the work queue

> ## This file carries the mechanics
>
> `SCHEMA.md` says what is being built, for the reader deciding whether to agree with it, and
> **delegates the implementation detail here**: transaction shapes, index definitions, raw SQL and
> test construction. Those live in "Implementation notes" at the foot of this file, each block named
> for the row it belongs to. If a mechanic is described in neither place, it is not designed yet.
>
> **`SCHEMA.md` is written and settled**, so the rows below are a contract rather than a sketch —
> with one exception that matters more than the rule: **a row marked `open` is a decision somebody
> still owes, and its implementation is not schedulable until that decision lands.** Those rows
> schedule the *decision*. Building past one means building on an answer nobody chose.

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

**A row whose Status is `open` is not available, however complete its `Needs` column looks.** It is
waiting on a judgement, not on a merge, and the row says which one. This is the only way the queue
stops somebody implementing a guess and having it reviewed as though it were the design.

Prefer the lowest-numbered available row unless something else is genuinely more urgent. **Two rows
in the same milestone rarely conflict; two in different milestones almost never do**, which is what
makes running several agents in parallel safe here.

**Numbers are allocated in the order work was planned, not in the order it should be done.** A row
keeps its number for as long as it exists, because a number is how a dispatcher refers to a piece of
work and renumbering would repoint every `Needs` reference at once. So the numbers are out of order
in this file, deliberately: M8's rows are numbered #40–#49 and sit last, and M7's #35–#38 come before
them. **The `Needs` column is what gates; the number is only a tiebreak among rows that are already
available.** If those two ever disagree, `Needs` wins.

**#3 is the fan-out point.** Almost nothing else can start until it merges, because everything
downstream needs the package manifest, the store tooling and the test harness to exist. Knowing which
single merge widens the graph is what turns a queue into parallel work — so if #3 is available and
something else is too, #3 goes first regardless of what looks more interesting.

Every row after #1 is a branch and a pull request. Build it in a worktree, get it reviewed, merge it,
then immediately look up what that merge unblocked.

---

## M1 — Repository and pipeline

*Feature: the repository builds, it is installable, and nothing reaches `main` unreviewed or
unchecked.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **1** | The four planning documents and the directives file, **plus the public-repo hygiene gate and its self-test**, committed straight to `main` | — | `done` |
| **2** | Publish the repository and protect `main` — linear history, no force-push, no deletions, pull request required. **Ships the `LICENSE` file** (MIT, `DECISIONS.md` §13e) | 1 | |
| **3** | **The boilerplate (fan-out point).** Application skeleton, the store driver wired up, the executable entry point, CI workflow, test harness, lint and format | 2 | |
| **4** | Required status checks pointed at the jobs from #3 | 3 | `done` |
| **5** | Public-repo hygiene gate wired into CI on every pull request | 3 | `done` |
| **6** | **Install and run from a clean checkout** — a documented install, then a real spawn against a temporary store that steps the schema, answers one command and exits | 3 | `done` |

> **#1 and #2 are not really pull requests** — they are the two setup steps that make pull requests
> possible. They keep numbers because everything downstream points at them.
>
> **What exists and what does not, precisely.** #1's content is committed on `main` in a local
> repository: the documents, the directives, the hygiene gate and a hundred passing self-tests.
> **There is no remote yet.** Creating it, pushing, and turning on branch protection is #2's job, and
> nothing here has been published until that happens.
>
> **The `LICENSE` file is #2's, and it is not paperwork.** MIT is settled (`DECISIONS.md` §13e), and
> a decision recorded in a document grants nobody anything — **a public repository with no licence
> file gives its readers no rights at all**, which is almost never what publishing was for. It lands
> with the act of publishing or it lands after the repository has been readable without it.
>
> **#3 has no container image, no compose file and no image-release workflow, and their absence is
> the design rather than a deferral.** There is no long-lived process to build an image around: the
> service is spawned by its caller, serves that session and exits with it, so **installation is the
> whole of deployment** (`DECISIONS.md` §13e, `PLAN.md`). What ships instead is a package that
> installs and an executable that runs — which is what #6 proves.
>
> **#6 is what a release check looks like without a runtime to deploy.** Its assertion is that
> somebody who has just cloned the repository can install it and get a working spawn: the store file
> is created at the configured location, the schema steps from nothing to the version the build
> expects, a command answers, and the process exits. That covers the failure an image build would
> have caught — the thing does not actually start — and it covers it against the artefact people will
> really use.
>
> **#4's required checks are the six job names, spelled as the platform reports them.** A required
> check is matched by the job's *name*, so the matrix jobs are required as `test (node 22.18)` and
> `test (node 24)` rather than as `test` — the names are read off a real run rather than off the
> workflow file, because that is the only place the matrix expansion is visible. Renaming a job in
> `.github/workflows/ci.yml` therefore silently drops a required check: the pull request shows no
> red, it simply stops being gated. Rename one and update the protection in the same change.
>
> **What is deliberately NOT required: reviews, and administrator enforcement.** Review is a gate
> kept as a process rather than one the platform enforces, and requiring approvals would deadlock a
> loop in which the same account authors and merges. That is a decision, not an omission.
>
> **#5 is marked done because the gate shipped inside #1**, which is deliberate rather than
> convenient: a public-repo gate that lands *after* the first prose is a gate that never ran against
> the first prose, and the first prose is where the leaks are. What #5 has left is one CI step
> invoking `npm run check:external-refs`, which cannot exist until #3 creates the workflow.
>
> The gate runs on the Node test runner with **no dependencies**, so it works on a tree with nothing
> installed. #3 may move it to whatever runner the application settles on — if it does, the
> seeded-violation test moves with it or the move is not finished.

**Milestone done when:** a clean checkout installs, spawns, steps its own schema and answers a
command, and nothing reaches `main` without passing checks.

---

## M2 — State and the service core

*Feature: the store exists and there is one place rules can be enforced. No surface yet.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **7** | **The schema stepper, and step one: the whole schema.** Browsers, claims, tabs, events, captures, diffs and feedback, as raw SQL — **plus the two partial indexes** (`SCHEMA.md` §1.11). The store records its version; the stepper applies the steps between that and the version the build expects. Mechanics and the raw SQL are in "Implementation notes" below | 3 | |
| **8** | **Store access: open the file, resolve its location, and refuse a network one.** The location comes from the environment and from nothing else; the refusal is the two-check detection (`SCHEMA.md` §1.0). Every spawn opens, steps and is ready — there is no boot to be separate from | 7 | |
| **9** | **The environment-variable registry and `.env.example`.** Every value the service reads is a variable with a working default, resolved **once per process** on the way in; a variable that is set and unreadable as its type **refuses to start, naming it** (`SCHEMA.md` §6.1, §6.3). `.env.example` ships every variable with its options and its default, and a build check asserts no variable is credential-shaped | 8 | |
| **10** | Service-layer skeleton: **the immediate-transaction helper every arbitration path takes**, typed errors, and the rejection taxonomy every guard draws from | 8 | |
| **11** | Events: append a row on every decision — **allow and deny alike** | 10 | |
| **50** | **The two build checks that keep the transaction rule true**: `arbitration.immediate_transaction` and `arbitration.no_read_only_path` (`SCHEMA.md` §7.3), each with a seeded violation proving it fires | 10 | |

> **#7 is one step, and every change after it is another step.** The rule that steps are additive is
> not style: a step that has run somewhere is history, and editing one means two installations
> reporting the same version with different schemas — a difference nothing reports until something
> breaks far from the cause (`CLAUDE.md`). There is no drift check to teach, because the schema is
> the SQL rather than a model something else generates from.
>
> **#7 lands two partial indexes, and the count is two rather than three.** That is **a change in a
> count, recorded as one rather than edited quietly** (`SCHEMA.md` §1.11, §9.2). Three were built and
> exercised on the SQLite version this design targets, and the measurement stands — it simply covered
> one index more than the design contains, because the index enforcing one canonical picture per view
> went with the concept it enforced. What #7 ships: **one live tab row per physical driver tab**
> (partial, unique), and the **partial non-unique index that makes the capacity count index-only**.
>
> **#7 has no settings table**, because configuration is the environment (#9). The one value several
> processes must agree on is a single row with no write path, and it lands in #12 with the capacity
> check that reads it.
>
> **#8 has no connection pool, and looking for one is looking for the wrong shape.** A pool exists to
> share connections between concurrent work inside one long-lived process; here the callers are
> **separate operating-system processes** (`SCHEMA.md` §1.0a), each opening the file, doing its work
> and exiting. There is nothing for a pool to pool. What #8 owes instead is the thing that makes many
> processes on one file safe: the write-ahead log, and the refusal to sit on a filesystem where it
> does not work.
>
> **#8's network-location refusal needs both checks or it is theatre.** The resolved path's root, and
> the volume's reported type — because **a mapped network drive is lexically identical to a local
> one** and no amount of reading the string distinguishes them (`SCHEMA.md` §1.0). A check that does
> only the first passes on every machine with nothing mapped, which is every machine anybody writes
> the test on.
>
> **#9 is a registry with no store behind it, and that is the whole of it.** There is no table, no
> revision counter, no override resolution and no command that sets anything — a fresh install runs
> with nothing set. **The thing that makes that safe is the refusal**: a variable somebody set and
> got wrong refuses the spawn by name, because falling back to a default would run a configuration
> nobody chose with nothing to notice it by. **`.env.example` is the registry**, so a variable added
> in code and not added to that file is an undocumented setting; the row owes a test that walks the
> declared variables and asserts the file lists every one.
>
> **#11 is not optional telemetry.** A record that only contains refusals cannot answer "was this
> guard ever actually reached", which is the question asked the first time something behaves oddly.
>
> **#50 lands with the helper it polices, not after the paths that use it.** Both rules assert an
> **absence** — that no arbitration path opens a deferred transaction, and that none answers without
> writing — and an absence is only checkable by a build rule. The second is the one that matters
> most: a "check status without sweeping" fast path **would pass a low-contention test suite**, which
> is exactly what the deferred measurement demonstrates (`SCHEMA.md` §1.0a), so a test suite is not
> what catches it.

**Milestone done when:** a spawn steps its own store, refuses a network location, resolves every
value from the environment with a working default, writes a decision row on every service call, and
the build fails on an arbitration path that does not declare its intent to write.

---

## M3 — Arbitration

*Feature: the service arbitrates. This is the app.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **12** | **Capacity: one integer**, and **the one row that keeps it one integer across processes.** One total tab budget across both browsers, and the admission predicate over it — `count of live claims + 1 <= budget`. No request size, no allowance, no reservation (`SCHEMA.md` §2.3). **The first process to open the store writes its budget in; a later process whose environment disagrees refuses to start and names both numbers** (`SCHEMA.md` §1.10, §7.2) | 10, 9 | |
| **13** | Claim: **atomic grant-or-queue for exactly one tab**, secret key issue. One claim, one tab, one row | 12 | |
| **14** | **Every keyed call extends the lease** — there is no renew operation, because a dedicated verb would be a second name for an effect every call already has (`SCHEMA.md` §3.1) | 13 | |
| **15** | Release on an active lease: terminal, **closes exactly that lease's one tab** — singular on every surface — and frees its capacity. **Forgiving**: releasing twice succeeds and says the lease had already ended | 13 | |
| **16** | **The lazy global sweep.** Every arbitration call first expires every lapsed claim and every lapsed queue entry across the whole store, in the same transaction, then answers from reconciled state. **Tab cleanup happens after commit, best effort** | 14, 15 | |
| **17** | Queue: **strict first in, first out**, position and estimate, queued-entry expiry by the same sweep, re-queue at the back with a new key. **The queued response carries the obligation, the number, and the mechanism** — check back at just under the lifetime, around nine minutes against ten | 13, 16 | |
| **72** | **Release also gives back a queue place** — one verb, both live states (`SCHEMA.md` §2.5, §3.4). A queued release is complete at commit, because there is nothing to close, and everyone behind moves up immediately | 15, 17 | |
| **51** | **The you-are-your-own-obstacle nudge.** When a claim is refused or queued **and the asking session already holds live leases**, the response names them with their keys, advises starting with what it holds, and offers release-and-retry. **Logged as a decision** — the nudge is advice, the ledger row is the evidence (`SCHEMA.md` §2.3a) | 12, 13, 11 | |
| **52** | **The two lifetimes, equal at ten minutes**, and the defaults that carry them: lease lifetime and queue-place lifetime as environment variables, both quoted in the queued response | 17, 9 | |
| **18** | Ownership guards: every tab-addressed operation refuses a tab not owned by the key | 13 | |

> **#12 is one comparison, and the arithmetic a reader expects is absent rather than hidden.** A
> grant *is* a tab, so capacity, grants and tabs are the same integer (`SCHEMA.md` §2.3). There is no
> per-claim tab allowance to check against, no requested-count term in the predicate, no reservation
> for a tab that has not opened, and no pair of numbers that could disagree. **Need two tabs, claim
> twice.** Anyone implementing a `tabs` argument on the claim call is implementing a design that was
> deleted rather than re-tuned.
>
> **#12 also owes the agreement check, and it is the only value that gets one.** Several processes
> arbitrate against the budget at the same moment, so **two of them believing different numbers means
> each admits correctly against its own belief and the ceiling silently stops being one** — nothing
> reports it, because every process is internally consistent. The first process to open the store
> writes its value; every later one compares and **refuses to start on a disagreement, naming both
> numbers.** Neither value is adopted and neither is overwritten: adopting runs a process against a
> bound it was not configured for, and overwriting lets the most recent starter move a bound others
> are mid-arbitration against. **The lease lifetime deliberately gets no such check** — disagreement
> there expires something early or late, which is degraded behaviour rather than a broken invariant.
> **That distinction is the rule** and it is what keeps this check to one row instead of growing into
> a stored configuration surface: a value several processes must *agree* on gets the row; a value they
> merely each *use* does not.
>
> **#15 is singular, on every surface.** One lease, one tab, one close. There is no plural
> close-my-tabs operation, not as a restriction but because there was never more than one to list —
> and a partial-release question therefore has no subject.
>
> **#72 is the other half of one verb, and it is split out only because the queue has to exist
> first.** **Releasing gives back whatever the lease holds** (`SCHEMA.md` §3.4): a queued caller that
> changes its mind otherwise has no way out and blocks everyone behind it until it lapses — the same
> failure as a dead entry at the head, with the aggravating detail that this one is alive and would
> happily have stood aside if asked. **The rule generalises in one line, which is what makes the verb
> memorable: whatever you are holding, releasing gives it back.** Two rows rather than one because
> #17 needs #16 which needs #15, so folding the queued half into #15 would be a cycle rather than a
> tidier table.
>
> **#16 is not a background sweeper on a shorter interval.** Nothing runs on a timer, because
> nothing runs between sessions (`DECISIONS.md` §13e). Reclamation is **lazy and global**: every
> call, not just a claim; every lapsed row store-wide, not just the caller's own; in the **same
> transaction** as the answer, because a reconciliation another statement reads is a race against
> every other process doing the same reconciliation. There is no sweep interval to configure, and a
> resident helper "just for the timer" is refused by name in `PLAN.md`.
>
> **#16 owes the ordering rule as much as the sweep**: the transaction reclaims capacity, and tabs
> are closed **after it commits**, best effort (`SCHEMA.md` §2.4b). Browser input or output inside
> the transaction would let **one wedged browser block every arbitration call on the machine**,
> because every caller is serialised behind the same writer. The consequence is the form that makes
> best-effort acceptable: **a tab that fails to close is a leaked tab, not a leaked lease.** The
> capacity is already back.
>
> **#16 also owes the lapse time as a distinct fact from the sweep time** (`SCHEMA.md` §2.4a). A
> lease lapsed when its last renewal plus its duration elapsed, not when somebody next called in.
> Recording only the sweep's own moment produces a record where leases expire in clean clusters at
> instants when nothing happened to them — a strong, entirely fictitious pattern that sends the first
> person investigating it to look at the sweep.
>
> **#17 is close to trivially correct, and that is a consequence rather than a claim about queues.**
> Every request is one tab, so there is nothing to skip ahead of and no starvation for an aging rule
> to protect against (`SCHEMA.md` §2.5). What is real is the dead entry at the head: it consumes no
> capacity and blocks everybody behind it, so **queue-entry expiry is the only thing that makes
> strictness safe** — it is not housekeeping.
>
> **#17's response owes the mechanism, not just the deadline, and that is the substance of the row
> rather than its wording.** A caller told *your place expires in ten minutes* will agree, intend to
> return, and be gone — the obligation is understood and unmet, and the place is lost without anybody
> deciding to lose it. So the response says **check back at just under the lifetime, around nine
> minutes**, because a check scheduled exactly at the deadline races the sweep and loses about half
> the time. Best practice belongs in the response; a paragraph in a specification is not in the room
> when the caller is deciding what to do next.
>
> **#51 is what a multi-tab caller gets instead of an admission change, and the distinction is the
> point.** Nothing is added to admission — no request size, no all-or-nothing grant, no acquisition
> protocol the service describes and cannot enforce (`SCHEMA.md` §2.3a). The starvation case is a
> caller waiting for capacity it is partly holding, and that is **an information problem before it is
> a scheduling problem**: every mechanism that was considered builds machinery to prevent a situation
> the caller can resolve itself in one step, if it simply knows. So the response names the leases the
> asking session already holds, tells it to **start with what it holds** — frequently self-solving,
> because finishing work on a held tab frees capacity the same caller reuses — and offers
> release-and-retry for work that genuinely cannot be serialised.
>
> **#51's detection is one comparison, and its ledger row is the part that is not optional.** The
> admission transaction already counts live leases and already knows the asking session; noticing
> that some of those leases belong to the requester costs nothing new — no table, no state, no tool.
> **Each occurrence resolves itself invisibly**, which is exactly why it is logged: without a record
> there is no way to learn that it has become common, and *common* is the signal that the budget is
> too tight or a caller is misbehaving. **The nudge is advice; the ledger row is the evidence.**
>
> **#52 delivers a decision that is already made, and the equality is the decision.** Ten minutes
> each, deliberately the same number (`SCHEMA.md` §2.5, `DECISIONS.md` §13f). Both arguments for
> making them differ turned out to point the other way: **polling is renewing**, so a queued caller
> holds exactly the instrument an active holder does and uses it exactly as often; and under strict
> ordering **a queue place held longer blocks everyone behind it**, so a generous queued lifetime is
> the harsher setting rather than the kinder one. **The cost of equality is stated rather than left to
> be found:** a caller that dies holds its place for the full ten minutes. That is bounded, visible in
> the queue depth, and cleared by the first arbitration call after it lapses.

**Milestone done when:** every rule in `SCHEMA.md` §7.1 has a passing test **including its
rejection**, every rejection test asserts the physical side-effect as well as the response, and the
concurrency tests below are green.

> **The concurrency tests M3 owes, and what makes them able to fail.** These are the assertions the
> whole design rests on, and each has a shape that is easy to write hollow:
>
> - **Cross-process, not in-process.** The contention here is between **separate operating-system
>   processes** (`SCHEMA.md` §1.0a), and a test using threads or promises inside one process proves
>   nothing about it — it exercises a mechanism this design does not have. Spawn real processes.
> - **The deferred-transaction failing control is part of the test, not a curiosity.** Measured: 30
>   concurrent processes on an immediate transaction all succeed; **the same test deferred, with a
>   widened read-then-write window, fails 15 times in 25**, with an error the busy-timeout setting
>   cannot retry. **Deferred passes at low contention** — so a suite that only runs the immediate
>   case and goes green has not demonstrated that the immediate case is what made it green. The
>   control is what makes the assertion capable of failing.
> - **Assert the double-issue refusal comes from the engine.** Two processes racing for the last unit
>   of capacity: one is granted, and the other receives a **uniqueness-constraint error** rather than
>   a second grant. A test that only checks the final count can be satisfied by application code that
>   got lucky.

---

## M4 — Browsers

*Feature: the service actually drives something.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **19** | Driver interface **+ a fake driver with a call log** — what makes a rejection test able to assert that nothing happened | 10 | |
| **20** | Real driver: **attach to a browser that is already running against one of the two profile directories**, and cold-start one **detached** when none is. Ships `launch.explicit_profile_dir`, `launch.detached`, `launch.default_args_intact` and `launch.capture_surface`, and the inward-isolation test — **starts cleanly while an unrelated browser already holds the default profile** | 19 | |
| **53** | **Discovery: the endpoint record, verified rather than trusted.** Ask the browser for an ephemeral port and read back what it recorded in its own profile directory; before attaching, **check the endpoint answers and that the browser identifier matches** (`SCHEMA.md` §1.2c) | 20 | |
| **54** | **The launch race, arbitrated by the same transaction as claims** — one row, one winner; the loser waits and attaches rather than starting a second browser (`SCHEMA.md` §1.2a) | 20, 12 | |
| **55** | **Decide what a caller that lost the launch race waits for, and for how long** (`SCHEMA.md` §1.2b, §9.3). Winning the race and having an endpoint that accepts connections are **different moments**, and the gap has no specified signal and no bound. Delivers the readiness signal, the poll, the timeout default and the declare-failed behaviour | 54 | `open` |
| **56** | **The keeper tab.** One blank, never-leased, never-addressable tab per browser, **never counted against the budget**, present before any lease is granted against that browser (`SCHEMA.md` §3.15, §7.2) | 20 | |
| **21** | Tab lifecycle: open and close by opaque identifier, the identifier mapping, and **reconciliation against the browser** — a browser that fails either discovery check is gone and every tab row in it is closed | 20, 18, 53 | |
| **22** | Navigate and act, tab-addressed, snapshot-to-path on every mutation. **The ordinary page verbs** — click, type, fill, press, select, hover, check, scroll — and the refusal that **lists every action by name** | 21 | |
| **61** | **`resize` as an action on `browser_act`** — set the tab's viewport, return a fresh snapshot. **Measured: 578 calls across 140 sessions — 58% of every session that used browser automation, and the sixth most-used verb** (`SCHEMA.md` §3.8). **High priority**: responsive review is inexpressible without it | 22 | |
| **62** | **`emulate` as an action on `browser_act`** — colour scheme, reduced motion and forced colours, returning a fresh snapshot because changing them changes what renders. **Measured: 19 calls across 9 sessions, with no page-side path** (`SCHEMA.md` §3.8) | 22 | |
| **63** | **Dialog handling as an action on `browser_act`** — answer or dismiss a native dialog. **Measured at 8 calls, and it is here on consequence rather than frequency**: an unhandled dialog blocks its tab and burns the lease (`SCHEMA.md` §3.8) | 22 | |
| **64** | **Batch fill, and drag-and-drop, as actions on `browser_act`.** Batch fill is measured at **78 calls across 35 sessions**; **drag and drop measured zero calls over a month and are unexercised** — folded in at low priority and recorded as such (`SCHEMA.md` §3.8) | 22 | |
| **23** | Read: snapshot by default; console, network and cookie summary on request — all path-returning; **cookie values never returned** | 21 | |
| **24** | Evaluate, with an inline byte cap and spill-to-path | 21 | |
| **65** | **`storage_seed` on `browser_claim`** — optional storage entries **written by the service through the automation layer's own storage interface**, before the tab's first navigation. **Never caller code executed as code.** Ships all five refusals: the count and size bounds, a non-string value, a non-web origin, cookies, and any entry on a lease that is not the caller's (`SCHEMA.md` §3.2) | 13, 21 | |
| **66** | **Browser-choice guidance, in the tool description text** — authenticated surface goes to the signed-in browser, genuinely-fresh-visitor work to the private one, **with the shared-cookie-jar caveat stated in the same breath**. Lands in the description and in the claim refusal, **because the description is the only place a calling agent reliably reads** (`SCHEMA.md` §1.2, §3.2) | 13 | |
| **44** | **The setup handshake, run on every spawn.** `broker init` runs it explicitly and every process that opens the store runs it before doing anything else: step the schema, confirm the two browser rows, **create a profile that is absent and use one that is present — never recreate**, and report which profiles it created against which it found. Idempotent. Refuses with a named reason when the profile root is unwritable or another process holds a profile's lock (`SCHEMA.md` §1.2d) | 20 | |
| **45** | **The artifact store.** One directory per lease with subfolders by kind, **and nothing outside it**, rooted at an environment variable defaulting under the platform's per-user application-data location. **Every stored path is relative to that root**, labels are sanitised and never treated as paths, and **a capture's file name derives its page slug from the page address** with the query string stripped first (`SCHEMA.md` §1.7a) | 20, 9 | |

> **#19 lands as early as it possibly can, and that is the point of splitting it out.** It needs
> nothing but a service layer, and every rejection test written before it exists can only assert a
> response — which is the assertion that proves the least. See `DECISIONS.md` §5.
>
> **#20's two halves are not equally common, and the naming misleads.** **Attaching is the ordinary
> case; launching is the rare one** (`SCHEMA.md` §1.2a). Browsers are **adopted, not owned**: no
> process here lives long enough to be a browser's parent, so whichever caller finds none running
> starts one and everyone after attaches to it.
>
> **#20's detached cold start is a measured requirement, not a preference.** Launching through the
> automation library's own launcher **kills the browser when that client closes** — correct for a
> test, fatal for a shared browser. Spawning the binary detached was measured to survive its
> launching process being killed uncleanly, staying healthy and re-attachable for around **90
> minutes** with its pages intact; attach and detach cycles were measured non-destructive to tabs,
> cookies and storage. Those two measurements are what make serial attachment by unrelated processes
> safe at all.
>
> **#20 must never infer that a launch worked.** A second browser started against a profile directory
> already in use **does not report a lock error**: it hands its address to the browser already
> holding the profile and **exits zero**, with nothing on the error stream and no debugging endpoint
> opened. So success is *having an endpoint that answers*, asserted positively. And the obvious
> cross-platform check does not work — the single-instance lock file a POSIX system leaves behind
> **does not exist on Windows**, so a check looking for it always passes there, which is worse than
> no check because it is trusted equally on both.
>
> **#20's explicit profile directories are a hard requirement with two independent justifications.**
> Bidirectional isolation wants one so nothing outside can block the service by holding the default
> profile (`DECISIONS.md` §6a); adoption wants one because **profile identity is a path, not a
> process handle** — without a stable path there is nothing to attach to. "Do not disturb the wrong
> browser" cannot be tested; "starts while something else holds the default profile" can, and that is
> the assertion this row owes.
>
> **#53's record is a claim, not a proof, and this was verified.** After the browser was killed
> outright the file remained, still readable, still naming a port that answered nothing. So liveness
> is checked, **and the browser's own identifier is matched — not merely the port**, because ports
> are reused: a stale record plus an unrelated process that happened to be given the same port reads
> as a successful match, and the service would attach to something it has no business touching.
>
> **#56 is a correctness mechanism for the signed-in browser, and its test has a specific way of
> being deleted later.** Measured: **headless, closing the final tab leaves the browser alive;
> headed, the browser dies within about half a second** — and the signed-in browser is headed.
> Without a keeper tab, the last caller to release its lease destroys the shared authenticated
> session by doing the single most ordinary and most correct thing a caller ever does. Therefore:
>
> > **The test asserting the keeper tab must run headed, and must say in a comment why it runs
> > headed.**
>
> Both halves. **A headless suite finds the keeper tab redundant** — every test passes without it,
> because the behaviour it protects against does not occur headless — so a future cleanup pass reads
> it as dead weight, removes it, and gets a green run confirming the removal. Running headed is what
> makes the test capable of failing; the comment is what stops somebody converting it to headless for
> speed and being rewarded with a tick.
>
> **#56 on the private browser is correct but not necessary, and that difference is not scheduled.**
> The private browser is headless, has no sign-in to lose and is cheap to relaunch, so the failure
> the keeper tab prevents does not occur there and nothing is destroyed if it does. Keeping a keeper
> tab in it is harmless and reaping it when idle is equally defensible — **that is an implementation
> call rather than v1 work**, and it is written here so nobody schedules a row for it or treats its
> absence as an omission.
>
> **#61 is the highest-value of the four action rows and the measurement is why.** No other tool on
> the surface offers a path to a viewport change: **a viewport is a property of the browsing context,
> not of anything reachable from inside the page**, so an expression can read the dimensions and can
> never set them (`SCHEMA.md` §3.8). The measured dominant loop is **resize → navigate → evaluate →
> capture, once per breakpoint**, and without this action that loop cannot be written at all. That is
> not awkwardness, it is a whole kind of review being inexpressible on a service whose main purpose
> is looking at pages.
>
> **#61 through #64 add no tools, and that is the test each of them passes.** Every one is scoped to
> one tab, non-destructive, invisible to other callers, and leaves nothing behind anybody has to
> recover from — which is exactly the shape `browser_act` exists to hold. A separate tool is for
> something that must be refusable by name or that changes what the caller owns; none of these is
> either.
>
> **#63's frequency is the wrong axis and the row says so.** Eight calls would not earn a tool on
> demand. **A native dialog blocks the tab it belongs to** — nothing else in that tab answers while it
> is up — so a caller that trips one holds a lease it cannot use and pays for it until the lifetime
> expires. Eight occurrences that each cost a lease are worth an action; eight that each cost two
> seconds would not be.
>
> **#64 carries an honest asymmetry and should not be split to hide it.** Batch fill is measured and
> ordinary. **Drag and drop measured zero calls across 2,007 transcripts**, they are the two most
> awkward verbs in browser automation to make reliable, and they are folded in at low priority with
> that number recorded — so if one of them turns out to matter, it arrives with the number to argue
> against, which is the correct burden.
>
> **#65 exists because seeding storage before the first load is not something a page can do to
> itself:** the page that would run the code does not exist until the load that needs the value
> already in place. **Measured: 40 calls across 25 sessions, all one shape** — fetch a token, write
> it into storage, navigate. **#66 shrinks this row's population and does not delete it**, which is
> worth saying plainly rather than claiming the guidance covers everything: the signed-in browser
> covers anything a person can log into by hand, and does not cover a service whose authentication is
> a token obtained from an interface rather than typed into a form.
>
> **#65's refusals are the row, and its structural property is what makes them credible.** Nothing in
> the argument is ever passed to an evaluator — the values go through a storage-writing interface
> taking a key and a string, so there is **no position in which a caller's bytes could be read as a
> program.** The bound is what keeps it a seeding argument rather than a payload channel, and the
> refusal of cookies is what stops it being credential injection on a shared profile. **The seed is
> recorded as an event — origins and keys, never values** — so *"which leases started life already
> holding a credential"* has an answer.
>
> **#66 is a correction rather than a nicety, and the measurement is the reason it is a row at all.**
> **25 measured sessions hand-seeded authentication tokens into an isolated browser while the
> signed-in browser sat unused** — doing by hand, unreliably, the one thing that browser exists to
> provide. **A capability nobody finds is worth what an absent capability is worth.** The guidance
> therefore lands where the choice is actually made: the tool's own description text, which is the
> only surface a calling agent reliably reads, and the claim refusal, because a caller re-reading a
> refusal is a caller re-making this decision. **The caveat travels with it**: tabs in the signed-in
> browser share one cookie jar, so two callers there are clean-room relative to the private profile
> and to nothing else, and two identities at once is declared unsupported rather than left to be
> discovered from a test that mysteriously sees the wrong account.
>
> **#44 runs on every spawn, which is what makes it trustworthy rather than what makes it expensive.**
> There is no long-lived process to have run setup once, so the check belongs on every spawn or it
> belongs nowhere — and the consequence is that there is no installation that passed months ago and
> has been drifting since. Its one-directional rule is load-bearing: **setup may create and may never
> destroy.** A profile recreated because it looked unfamiliar is a person silently signed out, who
> finds out at the least convenient moment.
>
> **#45 has no retention, and the absence is a ruling rather than a gap.** Nothing sweeps a capture
> file and nothing sweeps a crop (`SCHEMA.md` §6.2). **A retention window would have introduced a
> failure the caller cannot diagnose** — an identifier that was valid last week and is silently
> invalid now, for a reason nothing in the response mentions. What carries the case instead is the
> diff's own behaviour: the service either finds the image the caller named or explains that it could
> not, and the ordinary reason it cannot is that the caller named the wrong thing.
>
> **#45's file-naming rules exist because a file name travels further than a database column does.**
> A column is read by things written to read it; a name lands in log lines, terminal output somebody
> screenshots, error messages and title bars. So the query string is stripped **before anything
> else** — it is the part of an address most likely to carry a token and least likely to help anybody
> tell two files apart — then safe characters only, truncated, and never interpreted as a path.

**Milestone done when:** a claim can open a tab, navigate it, act on it — including resizing it,
emulating media preferences and answering a dialog — read from it and close it; a second process
attaches to the browser the first one started; the browser survives every process that touched it;
and nothing in the surface can reach a browser outside the two profile directories the service
manages.

---

## M5 — Adapters and parity

*Feature: the same rules, whichever door you come in through.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **25** | Adapter contract and the shared conformance harness — **an unregistered adapter fails the suite** | 10 | |
| **27** | **Tool surface over stdio — the primary route.** The service is spawned by its caller, serves that session and exits with it | 25 | |
| **29** | Command-line adapter (`broker claim` / `status` / `release` / the operations commands) — **in process, because there is nothing else for a command to talk to** — and the parity proof. Ships `broker claim --wait`, which polls at just under the lease lifetime | 25 | |
| **30** | Parity suite green across every route: identical operations, identical refusals, **identical side-effects** | 27, 29 | |
| **67** | **`browser_feedback`, the tenth tool** — one row, no lease required, written to the installation's own store. Anchored 1–5 help-versus-hinder scale, five disjoint categories including a positive one, and **three auto-captured columns: the lease, the caller's last operation from the ledger, and the refusal it hit.** Local only, no outbound path. **Ships with its exit condition written down** (`SCHEMA.md` §3.16) | 27, 11, 7 | |
| **68** | **`broker feedback` reads the rows back**, most recent first, with filters for rating and category — **the one command whose reading half has no tool behind it**, because a caller writes feedback and a person reads it | 67, 29 | |

> **#27 is the primary route and it is one process per session, not one shared process.** The client
> spawns it, it serves that session, it exits (`DECISIONS.md` §13e). There is no resident server for
> several callers to share, which is why every fact two callers must agree on lives in the store and
> why concurrency here is between operating-system processes.
>
> **There are two routes, not three, and the parity claim is narrower rather than weaker.** Nothing
> is served (`SCHEMA.md` §4, §8), so there is no third adapter to conform. The assertion was never
> about the count of routes — it is that a rule holds on all of them, and two is still more than one.
> **The generated operations document is not a route**: it performs no operation and refuses nothing,
> so it has nothing to be at parity with. What it owes instead is the reader rule, asserted where it
> is generated (#35).
>
> **#29 is worth building even if no agent ever calls it.** It is the cheapest available proof that
> the rules live in the service layer rather than inside a tool handler, and a rule inside a handler
> is a rule that holds on one route and nowhere else.
>
> **#29 inherits a consequence worth stating because it surprises people once:** in process, **any
> command that goes through arbitration performs the lazy sweep** (`SCHEMA.md` §5.2) — so a listing
> command can close somebody else's lapsed tabs. That is correct, and it is also why no command reads
> the tables directly: a reader that printed `state` without applying the expiry derivation would
> **report leases that do not exist** (`SCHEMA.md` §2.4).
>
> **There is no separate stdio-versus-anything-else core to unify.** The core is a library the calling
> process runs; each adapter is a thin shell that resolves its input, calls one service operation and
> shapes the result. An adapter that reaches the store or a guard directly is the failure this
> milestone exists to make impossible.
>
> **#67 takes the agent surface from nine tools to ten, and that cost is paid deliberately.** A tenth
> description sits in every connected session's context on every turn whether or not anything calls
> it. It is worth it for one reason: **it is the only mechanism by which this service learns that a
> refusal failed to say what to do next**, which is the failure class this design is most exposed to.
> From inside the service a refusal whose guidance is wrong looks identical to one that works — the
> call was refused, the rule fired, the ledger says deny, everything is correct. Only the caller that
> was stuck can tell the difference.
>
> **#67 ships its own exit condition, and writing it down is part of the row.** This is v0
> scaffolding: **a long stretch in which nothing is logged is the signal to remove it**, and silence
> is the success condition rather than a failure to collect. That framing has three consequences the
> implementation has to honour — **no migration story is owed** (nothing later is expected to read
> these rows), **it does not have to be beautiful** (trivially callable, trivially readable, nothing
> else), and **removing it must stay a deletion rather than an extraction**: nothing else reads the
> table, no operation depends on a row existing, and no refusal changes shape when it goes. It is its
> own table rather than an event kind precisely to keep that true.
>
> **#67's three auto-captured columns are the design, not the prose field.** The lease, the caller's
> last operation read from the ledger, and the refusal it hit cost the caller no keystrokes and
> cannot be misremembered. **A row with those three plus prose is a report; prose alone is an
> anecdote.** The tool's guidance says outright not to supply them.
>
> **#67 requires no live lease, and that is the point rather than a convenience.** A caller whose
> claim was refused is the caller most likely to have something worth recording — a capacity refusal
> it could not act on, a browser choice it could not make sense of, a capability it came for and did
> not find. **Requiring a lease would silence exactly the population the tool exists to hear from.**
>
> **#67 is local and has no route out.** Nothing else in this design opens an outbound connection and
> nothing listens, so a feedback channel that transmitted would be **the only component with a reason
> to reach the network** — carrying exactly the material least suitable for it. The consequence is
> accepted: feedback is per-installation, invisible across installations, and read by somebody with
> access to the machine.

**Milestone done when:** every adapter passes the conformance suite, and adding a new one without
registering it fails.

---

## M6 — Capture policy

*Feature: what a capture costs is decided by the thing taking it.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **31** | Capture pipeline: take, downscale to the tier, write, return `{path, width, height, bytes}`. **Three tiers, cheapest by default with no parameter**; the highest additionally requires a **free-text** `reason`; full-page off by default. **Settles the page before every shutter** and supports a capture-time mask. **Consults nothing belonging to the diff feature** | 22, 45 | |
| **32** | Per-capture telemetry: dimensions, bytes, downscaled-from, the tier, the escalation `reason`, estimated token cost | 31, 11 | |
| **33** | Capture accounting per claim: **a loud warning, never a refusal**, naming the cheaper alternative, fired on **every** capture past the threshold | 31, 12 | |
| **34** | Resolution-ladder harness and the one-off study; publish the chosen tiers **with their evidence**, superseding the provisional numbers | 32 | |
| **69** | **The `capture.no_diff_dependency` build check** — no capture path reads anything belonging to the diff feature, with a seeded violation proving it fires (`SCHEMA.md` §7.3) | 31 | |

> **#31 carries the lever, not #33.** The low default is what does nearly all the work, because most
> callers never pass an optional parameter — so getting "cheapest tier when nothing is asked for"
> right matters more than any threshold downstream of it (`DECISIONS.md` §13d). The mandatory
> `reason` on the highest tier is not bureaucracy either: it is the only mechanism that produces data
> about *why* anyone escalates, which is what #34 needs to tune the default.
>
> **#31's `reason` is free text and the row must not quietly make it an enum.** A fixed set is
> countable immediately and produces tidier data, and it is refused anyway: **it can only ever report
> which of the author's guesses a caller picked**, having been written before anybody read a single
> real escalation. The asymmetry settles it — **free text can be classified afterwards; an enum's
> discarded nuance cannot be recovered by any amount of later work.** The known risk is accepted and
> named: free text can fill with *"needed the detail"* and measure very little, which is still
> strictly better than an instrument guaranteed to measure only what was guessed.
>
> **What a required reason is worth, so it is not mistaken for a deterrent.** A caller asked to
> justify itself will always produce a justification, so the friction is not the mechanism and tuning
> it — a longer field, a sterner wording — pursues an effect it was never going to have. **The value
> is the record**: every escalation leaves a reviewable row with a reason attached. Record for
> review, never friction for its own sake.
>
> **#31 is the row that makes the sequencing property real, and #69 is what keeps it true.** A
> capture is taken **at the tier the caller asked for, always**, and consults nothing else — no
> canonical picture's geometry, no comparison data model, nothing from M8. **Capture must not depend
> on diffing**, so a capture path that reads diff data makes earlier work depend on the last thing
> built. That is an absence, and an absence is only checkable by a build rule.
>
> **#33's warning message is the mechanism, not decoration.** A bare "you have taken a lot of
> captures" teaches a caller to ask for a bigger budget. A warning that names the snapshot or the
> evaluate answering the same question teaches the thing the policy exists to teach. **It never
> becomes a refusal** — an agent stopped mid-run on a legitimate job concludes the service is an
> obstacle, and a service that is occasionally expensive survives that where one that is occasionally
> unusable does not. `capture.never_refused_for_cost` is a build check asserting that absence
> (`SCHEMA.md` §7.3).
>
> **#34 settles the numbers with evidence rather than defending them.** The tiers that ship in #31
> are provisional and are labelled as such everywhere. Expect more than one threshold: text stops
> being legible before layout critique stops working, which is the property that makes a low default
> push a caller toward the text-returning tools rather than merely make its pictures worse.
>
> **#34 collides with nothing, and that falls out of there being no canonical picture.** A capture is
> stored at a tier and is never compared against something blessed at another one, so **changing a
> rung invalidates nothing** (`SCHEMA.md` §6.2, §9.3). A diff compares two
> captures the caller named, and if those two were taken at different rungs the result says so
> instead of the study having silently broken them. The row has no sequencing prerequisite for that
> reason.

**Milestone done when:** the cheapest tier is what a caller gets for asking for nothing, every
escalation is recorded with its reason, and no capture is ever refused.

---

## M7 — Adoption

*Feature: you can see what it is doing, and turning it on is safe.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **35** | **The operations snapshot: one command, one self-contained HTML file** with its styling and behaviour inlined, written to a path, and the process exits. Both browsers with state and restart count, budget and use, live leases grouped by session, the queue with positions and waits, leaked tabs, recent ledger entries, and what callers reported. **Read-only — no controls, no sign-in, no forms.** **Labelled with the moment it was taken, and it does not refresh.** **Renders derived state, never stored state** | 29, 11 | |
| **70** | **Tab addresses read live from the browsers at generation time**, with a **mandatory per-tab timeout**, and **a browser that does not answer renders as `unreachable`** — an explicit word, never blank, omitted or a placeholder (`SCHEMA.md` §4.2a) | 35, 21 | |
| **47** | **A view of the ledger** — sliced by kind, outcome and rule, with the cursor the counter primary key already provides. Read by `broker events` from the first version, and the most recent entries appear in the generated snapshot (#35); the shape in `SCHEMA.md` §1.6 is what keeps it one query | 29, 11 | |
| **71** | **`broker doctor`** — every precondition reported separately, **exiting with a distinct code on any failure**: the store's location, that it is not on a network filesystem, its version · the automation tool and its version · artifact and profile roots writable · each browser's discovery record checked for **liveness and identity** · the capture-surface check · the keeper tab · **and whether the stored tab budget agrees with this process's environment** (`SCHEMA.md` §5.5) | 29, 44, 53, 56, 12 | |
| **37** | Measurement harness: matched-pair comparison over real review work, and the capture telemetry rollups the study reads | 27 | |
| **38** | Rollout runbook: phased enablement from a zero tab budget to sole route, in the order that never leaves traffic unarbitrated. **Includes the one-time sign-in, by hand, into the window already open — nothing stopped, nothing relaunched** | 37, 44 | |
| **60** | **The empirical foreground check owed before the browser layer is trusted** (`SCHEMA.md` §9.4): drive a **background** tab through a navigation, an action and a capture, and assert the foreground did not move. A test on the real thing, not a code read | 22, 31 | |

> **There is no deployment row, and its absence is the design.** There is no image to pull onto a
> host, no configuration to place beside a running service and no health check on a process, because
> **there is no process between sessions** (`DECISIONS.md` §13e). What a deployment row would have
> proved is proved by #6 — a clean checkout installs, spawns and works — and what a health check
> would have watched does not exist to be watched. **There is no component of this design whose
> absence stops leases being granted** (`SCHEMA.md` §5.7).
>
> **#35 is a command that writes a file, and every property that matters follows from that.** With no
> long-lived process, a served page needs somebody to start a listener, keep it running, remember it
> is running and stop it — and what they get for that is a document they were going to read once
> (`DECISIONS.md` §13f). A file has none of that apparatus and delivers the same document: nothing
> left running, nothing to expose, nothing to depend on, and one artefact that can be sent to
> somebody or opened on a machine that has never run this service.
>
> **#35's hardest requirement is the one that looks like a detail.** A document assembled from direct
> table reads would **report lapsed leases as live**, and it would look entirely plausible while doing
> it — worst on the busiest installation. It is built from one status read that has already applied
> the expiry derivation (`SCHEMA.md` §2.4).
>
> **#35's second-hardest requirement is that it must not pretend to be a window.** A page showing
> leases, expiries and a queue *looks* like an operations console, and a console is a thing people
> read as current. So the moment it describes is **in the document, prominently** — not only in a
> footer and not in the file name, which can be renamed — and **nothing redraws itself**: no polling,
> no countdown, no live indicator. **A stale page that admits it is stale is useful; one that does not
> is misleading in the direction of confident wrong conclusions.**
>
> **#35 has no settings section and no health verdict**, and both absences are rulings. There is no
> settings table and no way to write one (#9), so a section listing environment variables would
> duplicate `.env.example` — which is the registry, and which sits beside the code where it can be
> checked against it. The health verdict is #71's job in a better shape.
>
> **#35 stays one page and stays read-only.** It answers "what is holding what, and how long is the
> queue". Revoking is deliberately absent even though the operation exists, and the reason is sharper
> for a file than it was for a page: **this document is a photograph.** A button in a photograph acts
> on state that has moved since the shutter, and the person clicking it is acting on what they can see
> rather than on what is true. Revoking is a command (`SCHEMA.md` §5.4), run against the service as it
> is at that moment.
>
> **#70 is what makes the generated file worth anything, and its two rules are not optional.** The
> generating process is alive and attached to both browsers, so it **asks** where each tab is instead
> of reading a cached copy — which is why no column stores one. **Every read carries a timeout**,
> because a browser can accept a request and never answer, and a generator that inherits that hang
> produces nothing at all, which is worse than an incomplete document. The timeout is per tab, so one
> wedged page costs one entry rather than the whole run. **And an unanswered read renders as an
> explicit word**: a missing address and an unanswered one are different facts, and the second is the
> one indicating something wrong.
>
> **#71 is what a health endpoint would have been for, in a better shape.** A health check asks
> repeatedly whether a thing is still up, which is a question about a process that is supposed to be
> up; **nothing here is supposed to be up** — a service that is not running has exited, which is what
> it does. `broker doctor` reports every precondition separately and exits with a distinct code, so it
> is usable exactly where a readiness check would have been used and is **strictly more informative**:
> a health verdict collapses every precondition into one word, and the word does not say which one
> failed.
>
> **#38's ordering is the substance of it, not the prose.** Anything that reads state another
> component writes has to be removed before the component that writes it, or the reader keeps
> consuming a value that has silently stopped changing. **No phase brings something up and leaves it
> running**, because there is nothing to bring up: each phase changes what callers are configured to
> reach.
>
> **#60 is the last place a proved property can quietly stop being true.** The concurrency properties
> were proved against the automation *library*; the service reaches them through a tool layered over
> it, and a layer can add a foreground move without saying so. Two spawn-time rules check that the
> launch settings survived the indirection and one build check says this service never moves the
> foreground — **none of them covers the tool doing it on an operation nobody has exercised.**

**Milestone done when:** the service is the only route to a browser, the sequence that got it there
is written down, and somebody can generate a document that shows what it is doing.

---

## M8 — Changed-region review

*Feature: a repeat review looks at what changed, not at everything.*

**This is the lowest-priority feature in the design and it is built last, deliberately.** Everything
before it ships returning full screenshots, and **nothing earlier may depend on anything in this
milestone** — a property #31 preserves and #69 enforces as a build rule. Its own milestone rather
than an extension of M6, because a comparison, region extraction and a tunable threshold are a
**feature** with its own state, not a policy setting (`DECISIONS.md` §13a).

**There is no canonical picture here and no baseline store.** A capture is a capture with an
identifier, and **a diff is an optional argument on `browser_capture` naming which earlier capture to
compare against** (`SCHEMA.md` §1.8, §3.11).

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **40** | **Diff: a capture against the earlier capture the caller named**, producing a diff mask and a `comparisons` row. **Reuse a diff library; do not write a differ.** **A missing target returns the full screenshot with an explanation, never a refusal.** Ships the **geometry handling** — a width mismatch is reported in the result rather than pre-empted, and a full page's height is allowed to differ, with the change in page length reported as its own fact | 31, 7 | |
| **41** | Changed-region extraction: connected components over the mask into bounding boxes, merged at a configurable distance, and filtered **on area with a thin-line allowance** — not on the shorter side, which discards a one-pixel line across a wide page | 40 | |
| **42** | Region crops written as paths — **both the earlier crop and the new one, from the same rectangle, with padding** — plus the outlined overlay, `truncated` when the region cap bites, and `compared_against` echoed back. **All of it rides on `browser_capture`; there is no comparison tool** (`SCHEMA.md` §3.13) | 41, 27 | |
| **43** | Threshold tuning: a configurable colour tolerance, a fixture set of known-clean and known-changed pairs, and a test proving a **real** change is not swallowed. Build the fixtures from thin lines, border widths, focus rings and underlines — the cases the size filter is most likely to eat | 41 | |
| **48** | **A read surface for diffs** — `broker diffs`, listing them by capture, by target or by lease. The table's entire justification is that tuning reads it, so a version with nothing reading it has a justification and no evidence | 40, 29 | |
| **49** | **Delivering the images: one endpoint, one return shape** (`SCHEMA.md` §1.9). An image request always returns an image the same way; whether the bytes are a full capture or a crop depends only on whether a diff target was passed. **It serves recorded paths under the artifact root, never a path supplied by a caller**, and only artifacts belonging to the asking lease. Ships `artifact.no_request_path` as a build check | 42, 27, 45 | |

> **The inline-crop option is rejected and #49 must not reintroduce it.** The tempting answer was to
> return small crops inline and paths for large ones, on the reasoning that a crop is the size of the
> thing that changed. **The flaw is specific: you cannot know a diff is small.** A change to a
> component that appears on every page changes every page — a header, a font, a spacing token, a
> colour — and the diff that follows is a dozen crops, collectively as expensive as the screenshot
> this design spends most of its effort avoiding. **A rule whose cost is bounded only when the change
> happens to be local is an unbounded rule that behaves well in testing.** A conditional return shape
> also makes every caller handle two cases forever, to save a path lookup on the cases that were
> cheap anyway.
>
> **#40's failure mode is the point, and it inverts the reflex.** If the named capture cannot be
> found, **the full screenshot comes back with a sentence saying why** — because the request that
> failed to find its target is still, underneath, a request for a picture, and that part of it can
> always be satisfied. Refusing would withhold something that succeeded because something optional
> did not, and it would cost a round trip on the most expensive surface there is. Nothing is hidden:
> the explanation names what was not found, and a caller branching on `changed` sees no diff rather
> than a wrong one.
>
> **#40 handles geometry at diff time rather than constraining the capture, and that is the coupling
> that was cut.** An arrangement in which a capture consulted a canonical picture and took the
> picture at *its* geometry made the ordinary capture path depend on this milestone's data model, and
> gave every capture a reason to fail that had nothing to do with capturing. **There is no such
> rule.** Two images are in hand at diff time, so a mismatch is reported against the specific pair
> that mismatched — and on a full page the height is allowed to differ, because two full-page pictures
> of one page legitimately differ in height when the content gets longer.
>
> **#43's negative direction is the one that matters.** Any threshold can be raised until nothing
> ever fails, and a comparison that reports "nothing changed" is indistinguishable from one that is
> working. The fixture set has to contain a change small enough to be interesting and prove it
> survives the threshold in force.
>
> **This is a second-visit feature and must never become a silent default.** With no target named
> there is nothing to compare, and a diff that quietly returned "no changes" when it had nothing to
> compare against would be worse than one that says so.
>
> **Two things #31 owes this milestone rather than M6**, because a diff is worthless without them:
> settling the page before every shutter (animations stopped, caret hidden, fonts waited for) and a
> capture-time mask. **Masking before the pixels exist beats filtering afterwards**, because a region
> that was never captured cannot be reported as changed. `SCHEMA.md` §3.11.
>
> **There is no retention on any of this**, which is what makes a missing target rare (`SCHEMA.md`
> §6.2). Nothing sweeps a capture file and nothing sweeps a crop, so the ordinary reason the service
> cannot find a named image is that the caller named the wrong thing — exactly the case an
> explanation helps with.
>
> **Before #40 starts, answer whether an off-the-shelf tool already does this half.** It is the one
> part of this design that is not arbitration, and no document here has checked. That question is
> cheap to answer and expensive to skip, and it is the reason this milestone opens with *reuse a diff
> library* rather than with a differ.

**Milestone done when:** a capture naming an earlier capture returns only the regions that moved, and
the threshold can be tuned without anyone guessing.

---

## Critical path

**1 → 2 → 3 → 7 → 8 → 10 → 12 → 13 → 16 → 19 → 20 → 22 → 27 → 38.**

That is a **narrative** of the sequence that matters rather than the graph's longest chain. Four
things fall out of it and are worth stating, because they are what to protect when the queue gets
busy:

- **#10 and #19 are the two widest fan-out points after #3.** Once both have merged, M3 and M4 run
  largely in parallel, and M5's adapters are parallel to each other after #25.
- **#19 is early on purpose despite being a testing concern.** Everything in M3 is guards, and a
  guard tested only through its response is a guard tested at the wrong layer.
- **#16 is on the critical path where a background reaper would not have been.** With reclamation on
  every call, the sweep is not a maintenance feature that can follow the surface — it is the thing
  that makes every arbitration answer correct, and it is what keeps the writer-serialisation
  invariant true by making even a question a write.
- **#22 is on it because four measured capabilities hang off it.** Resize, media emulation, dialog
  handling and batch fill (#61–#64) are all actions on the same tool, and resize alone is the sixth
  most-used verb measured. **The critical path runs through the action tool, not around it.**

**Nothing on the critical path touches M8.** Diffing is the last thing built and nothing before it
depends on it, which is why no row in M1–M7 lists a M8 row in its `Needs`.

## Sequenced wrong more often than anything else

- **#5 before the prose it polices.** A hygiene gate landing after the documents has already missed
  the run that mattered. This is why it shipped inside #1.
- **#19 before the guards.** It has one prerequisite and constrains how every M3 test is written.
  Landing it late means every rejection test written in the meantime asserts only a response.
- **#50 before the arbitration paths.** Both rules it enforces assert an absence, and an absence
  acquires violations quietly. A deferred transaction or a read-only fast path added before the check
  exists will pass every test written at the time.
- **#56 before any lease is granted against the signed-in browser.** The keeper tab is not a
  refinement to add once tabs work: the failure it prevents happens on the *ordinary* release path,
  so a window without it is a window in which the shared sign-in can be destroyed by correct
  behaviour.
- **#69 before, or with, anything in M8.** It asserts that no capture path reads diff data, and the
  violation it exists to catch arrives the moment somebody building a diff finds it convenient to
  reach back into capture. A check landing after that is a check that has to be argued with rather
  than one that fires.
- **#61 before the capture pipeline is judged.** The measured loop is resize, navigate, evaluate,
  capture — so a capture surface exercised without a resize action has been exercised at one width,
  which is not what anyone is going to use it for.
- **M8 after everything.** It needs the capture pipeline (#31) and the schema (#7) and nothing else,
  so its `Needs` would let it start early. **Do not.** It is the lowest-priority feature in the
  design, everything ships returning full screenshots without it, and building it early spends the
  attention that the arbitration core and the browser layer are the reason this service exists at
  all. Its number says last; its `Needs` under-constrains it; the ordering here is the ruling.

## Implementation notes — the mechanics, kept with the work that needs them

`SCHEMA.md` says what is being built and why, for a reader deciding whether to agree with it. This
section holds the part addressed to whoever implements it: transaction shapes, indexes, raw SQL and
test construction. Each block names the row it belongs to.

**Everything below is written directly in SQL**, because the store is one SQLite file reached with
plain SQL rather than through an object-relational mapper (`DECISIONS.md` §13e). There is no model
file to generate from, no drift check to teach an exception to, and no construction that has to be
worked around — which is what makes the partial indexes expressible at all.

### #7 — the stepper, the indexes, and the one uniqueness rule

**The stepper.** The store records the version it is at; the build knows the version it needs; the
steps between the two are applied **in order, in one transaction**, and a store already at the right
version is left untouched. Step one is the whole schema. **A store at a version this build does not
understand is a refusal, not an attempted downgrade** (`SCHEMA.md` §7.2) — two callers on different
builds against one store is an ordinary situation here, and guessing is how one of them corrupts it.

Every change after step one is **a new step with an `ALTER`**, never an edit to a step that has
already been applied. A step that has run somewhere is history.

**Indexes.** At a tab budget of fifteen the live set is tens of rows, so most of these change nothing
measurable on live data. They exist for the historical rows, which are the part that grows without
bound — with one exception, noted below, that is about the hot path rather than about history.

| Table | Index | Why |
|---|---|---|
| `claims` | `UNIQUE (key_hash)` | Every keyed call, which is every call that does anything |
| `claims` | `UNIQUE (id, browser_id)` | Not a query index — the target of the composite foreign key on `tabs` that stops a tab naming a browser its own lease did not. Free, given `id` is already unique |
| `claims` | `(state, expires_at)` | **The sweep's scan**: everything live and past its expiry, in one index range. Read on every arbitration call, so it is hot rather than historical |
| `claims` | `(state, created_at)` | Head of queue, first in first out. Separate from the sweep's index because they order by different columns, and a scan that has to sort gets slower as history accumulates |
| `claims` | `(session_id, created_at DESC)` | A session's own history — **and the query #51 needs**: a session's other live leases, read inside the admission transaction |
| `tabs` | `(claim_id)` | The ownership check, and everything release and the sweep do |
| `events` | `(at)` · `(claim_id, id)` · `(kind, at)` · `(guard) WHERE guard IS NOT NULL` | A slice read · one lease's whole history · the capture and diff rollups · which rule refuses most, small because denials are rare |
| `captures` | `(claim_id)` · `(taken_at)` | Listing, and the rollup |
| `comparisons` | `(source_capture_id, at DESC)` · `(target_capture_id)` | The diffs run from one capture, and the diffs run against one — which is what tuning reads |
| `feedback` | `(at DESC)` · `(category, at DESC)` | Reading it back, most recent first, filtered by kind (#68) |

**The two partial indexes, verified working on SQLite 3.53.4.** One is a uniqueness rule; the other
is not a rule at all.

```sql
-- One live tab row per physical driver tab.
CREATE UNIQUE INDEX one_row_per_physical_tab
  ON tabs (browser_id, driver_tab_id) WHERE state IN ('opening','open','closing');

-- Not a uniqueness rule: this makes the capacity count an index-only scan.
CREATE INDEX live_claims
  ON claims (state) WHERE state IN ('queued','active');
```

> **The count is two, and it is stated as a change in a count rather than a corrected number.**
> **Three** partial indexes were built and exercised on SQLite 3.53.4, and that measurement stands —
> it covered one index more than the design contains. The third enforced one canonical picture per
> view, browser, kind and breakpoint, and it went with the concept it enforced (`SCHEMA.md` §1.11,
> §9.2). **A reader who remembers "three, verified" and finds "two" with no explanation has to work
> out whether a measurement failed, whether an index was dropped for being wrong, or whether somebody
> miscounted. None of those happened**, and editing the number silently would have made a
> straightforward deletion look like a retraction of evidence.
>
> **The effect on the argument for plain SQL is *weakened*, and that is the honest word.** One of its
> four supports is gone. **The other three are untouched**: startup latency, charged on **every
> spawn** here rather than once at boot; install weight, for the same reason; and the version stepper,
> which applies its steps in the language the database speaks rather than reconciling two descriptions
> of one schema.

**Why the rule lives at the write rather than in a check before it.** To create something the service
reads whether it already exists, gets back no, and writes it. Two processes can do that at the same
instant, and the reasonable objection — that they cannot write *simultaneously*, so the second should
fail — is wrong in a specific way.

**The writes do serialise; serialising is not rejecting.** The second write lands after the first and
is accepted, because nothing has told the store that two such rows are illegal. The staleness is not
in the write — **it is in the read before it.** Both reads were true when made; by the time the second
write lands, its read has stopped being true, and nothing re-checks it. Two correct reads, two legal
writes, one broken rule.

So the rule is told to the store, and the store refuses the second insert itself. **Across separate
processes that is not one option among several — it is the only place a rule can live**, because
there is no shared process to hold a lock in. **Verified**: a second process attempting the duplicate
receives a uniqueness-constraint error from the engine rather than being admitted.

**The second index earns its place on the hot path, not on history.** The capacity count is read inside
the transaction that every arbitration call opens, with every other caller on the machine waiting
behind it. Making it a **covering index-only scan** — the answer coming out of the index without
touching the table — is what keeps the serialised section short. It is filtered to live rows for the
same reason the other is: the table grows forever and the live part does not.

**Two rules a reader may look for and will not find:**

- **"One live lease per tab" is not an index, because it is structural.** A tab row's lease reference
  is set when the row is created, is never null and never changes, so a tab has exactly one owner by
  construction — there is nothing for an index to refuse (`SCHEMA.md` §1.11).
- **"One live lease per session" was removed entirely**, not enforced differently. **A lease is one
  tab, so a session that wants three tabs holds three leases** — the rule is incompatible with
  claim-twice, which is the model. What it would have caught as a side effect, two callers
  accidentally sharing one session identity, is therefore not caught anywhere, and that is named as
  lost rather than quietly dropped (`SCHEMA.md` §1.11, §2.2).

### #9 and #12 — configuration is the environment, and the one row that is not

**There is nothing to resolve.** One snapshot of the process environment is read on the way in and
used throughout, so every rule inside one operation sees one configuration. No table, no override
merge, no revision counter, no cache to go stale and no re-check to schedule — a process lives for one
session, so a change made now is in force for every process after it.

| Situation | What the resolver does |
|---|---|
| Unset | **Use the default.** This is the ordinary case and it is what makes a fresh install work with nothing set |
| Set and valid | Use it |
| Set and unreadable as its declared type | **Refuse to start, naming the variable and what was expected.** Not the default silently: a caller that set a value and got the default is running a configuration it did not choose with no way to notice |
| Unrecognised | Ignore it. A process cannot tell an unrecognised variable of its own from any other variable in an environment it shares with everything on the machine |

**`.env.example` is the registry and the row owes a test that keeps it one.** Walk the declared
variables, assert the file lists every one with its default. A variable that exists in code and not in
that file is an undocumented setting, and it stays undocumented until somebody goes looking for a
behaviour they cannot explain.

**The tab budget's one row, which is a check rather than a configuration surface.** The first process
to open the store writes the value it believes. Every later process compares:

```
budget from this process's environment  ==  the value recorded in the store
  agree     -> nothing happens at all (the ordinary case: one machine, one environment)
  disagree  -> refuse to start, naming both numbers
               neither adopted, neither overwritten
```

**Adopting would run a process against a bound it was not configured for; overwriting would let the
most recent starter move a bound others are mid-arbitration against.** Both are worse than a refusal
at the loudest and cheapest possible moment.

### #10, #12, #13 and #16 — the arbitration transaction, which is one shape

**Every arbitration path is the same transaction shape, and #10 provides it once.** A path that opens
its own transaction differently is the bug both build checks in #50 exist to catch.

```
BEGIN IMMEDIATE
  1. Sweep, globally:
       every claim whose last_seen + ttl has elapsed  -> expired, expired_at = the computed lapse time
       every queue entry past its own expiry          -> expired
       collect the tab rows those claims held         -> to close after commit
  2. Answer, from the reconciled state:
       count live claims (index-only, over live_claims)
       admission: count + 1 <= budget  ->  grant, else queue at the back
       if not granted: count this session's other live leases (#51) -> attach the nudge
       insert / update / append the record row
COMMIT
  3. After the commit, outside every transaction:
       close the collected tabs, best effort
```

**`BEGIN IMMEDIATE`, and this is correctness rather than tuning.** The transaction declares its intent
to write **at the moment it opens**, which makes the store serialise the writers itself instead of
discovering a conflict at the end. Measured: **30 concurrent operating-system processes on an
immediate transaction all succeed**, counter incrementing cleanly, no repeats and no lost writes. **The
same test deferred, with a widened read-then-write window, fails 15 times in 25** with a busy-snapshot
error **the busy-timeout setting cannot retry** — the transaction holds a read snapshot it has lost the
right to upgrade, so there is nothing to wait for. And the shape above is a wide read-then-write window
**by construction**: sweep, then count, then insert.

**The standing invariant, and how it will one day be broken.** What the immediate transaction buys is
**writer serialisation, not full serialisability.** It holds **only because every arbitration path
writes** — the sweep in step 1 is what makes even a question a write. **A read-only fast path —
*"checking status does not need to sweep"* — silently reopens the hole, and it would pass a
low-contention test suite**, because that is exactly what the deferred measurement shows the failure
looks like. Anything added to the arbitration surface must either write, or be argued against this
paragraph explicitly. `arbitration.no_read_only_path` (#50) is the check that makes it a build failure
rather than a code-review hope.

**Step 1 is global, not scoped to the caller.** A caller asking about its own lease is often the only
call that will arrive for a while, and capacity held by something that died must come back on the next
call from *anyone*. Scoping the sweep would leave a machine's capacity pinned by a process nobody is
ever going to ask about again. It costs a scan of the live rows — tens of them.

**Step 1 is in the same transaction as step 2, not before it.** A reconciliation whose result a
separate statement reads is a race against every other process doing the same reconciliation, and a
caller can be told "no capacity" on the strength of leases the very same call has just decided are
dead.

**#51's detection sits inside step 2 and costs one comparison.** The transaction already counts live
claims and already knows the asking session, so the session's own live leases are a filter over data
in hand — no new table, no new state, no second query outside the transaction. The nudge goes on the
response and the occurrence goes on the ledger, both from inside the same call.

**Step 3 is outside, and this is the hard rule** (`SCHEMA.md` §2.4b). Closing a tab is a round trip to
a browser process that can hang — a wedged browser does not refuse, it simply does not answer. Inside
the transaction, **one unresponsive browser blocks every arbitration call on the machine**, including
every caller with no interest in that browser, because they are all serialised behind the same writer.
`arbitration.no_browser_io` (`SCHEMA.md` §7.3) makes a browser call reachable from inside the
transaction a build failure. The consequence, in the form that makes best-effort acceptable: **a tab
that fails to close is a leaked tab, not a leaked lease.** The capacity came back at commit.

**Admission is one integer comparison and there is no phase two to reserve for.** A claim is one tab,
so the claim row *is* the capacity: there is no window in which capacity is held for a tab that does
not exist yet, no requested-count term, and no reservation arithmetic. The tab is opened after the
commit; **if it fails to open, the service ends the lease, records why, and tells the caller the
browser is unavailable** — the count follows immediately, because it is a count of claims. There is no
partial case, because there is no plural.

**Escalation on a stuck close:** at three attempts, stop retrying that tab, write a record entry naming
it, and show it as a leaked tab on the generated snapshot. It is **never** force-closed by killing a
browser — every reclamation is scoped to a tab and a lease, and nothing is ever scoped to a browser
(`SCHEMA.md` §2.7). Clearing a leaked tab is an administrative operation (§4.3).

### #15 and #72 — releasing a queue place takes the same path as releasing a tab

**One verb, two states, one transaction shape.** Release resolves the key inside the arbitration
transaction and branches on the lease's state:

```
active  ->  end the lease, free the capacity at commit, collect the tab to close after it
queued  ->  end the queue entry at commit; everyone behind moves up immediately; nothing to close
```

**A queued release is complete at commit**, because there is no browser round trip in it — which is
the one case where the best-effort caveat in step 3 does not apply and the response can say so
without qualification.

**Releasing twice succeeds** and reports that the lease had already ended. The only refusal is an
unrecognised key. A forgiving release is what stops a caller that lost track of its own state from
choosing between an error it cannot act on and holding capacity it does not want.

### #54 — the launch race takes the same transaction

**A launch race is the same problem as two callers claiming the last tab, and it gets the same answer
rather than a second mechanism**: one row, one winner (`SCHEMA.md` §1.2a). The winner records that it
is launching; the loser sees `starting`, waits, and then attaches. A second launch would be two
browsers against one profile directory, contending on its lock — which is the failure the explicit
profile directory exists to prevent.

**What the loser waits *for* is #55's open decision, and it must not be papered over with a fixed
pause.** Winning the race and having an endpoint that accepts connections are **different moments**.
A fixed pause is a number that is too long on every fast machine and too short on the one slow machine
where it matters, and a loser that attaches too early reports a launch failure indistinguishable from
the browser having died — quite possibly launching a second browser in response, which is the precise
outcome the race exists to prevent.

### #21 — reconciliation is against the browser, not against a restart

**There is no "after a restart" step**, because a process ending is the ordinary case here and every
spawn is a first spawn. What still needs answering is harder: **the store says a tab is open and the
browser it was in is gone.** A browser outlives any one caller, but it does not outlive everything, and
when it dies every tab inside it dies while every row describing them survives.

So the reconciliation is against the **browser**:

1. **A browser whose discovery record fails either check** — the endpoint does not answer, or it
   answers and is a different browser (#53) — **is gone.** Every tab row pointing at it is marked
   closed, because a tab inside a process that has exited is closed by definition, and their leases are
   ended.
2. **A browser that is alive** is asked what is actually open. A page no live lease owns is closed; a
   tab a live lease believes it owns that is not there is marked closed and its lease ended.
3. **Then the queue is swept**, so recovered capacity reaches whoever is waiting.

**All of that is browser work, so none of it happens inside the arbitration transaction.** The
transaction reconciles rows against what the last check established; the checking and the closing
happen outside it.

**A browser dying ends every lease in it at once.** That is not a degraded mode this design hides —
with two browsers and no third there is no capacity to fail over to, and it is reported as what it is.

### #65 — the seed is written through a storage interface, and never evaluated

**The whole security property is structural rather than a promise, and the implementation is what makes
it so.** Each entry is a storage area, a key, a string value and an origin. On grant, before the tab's
first navigation, the service writes each entry through **the automation layer's own storage-writing
interface**, which takes a key and a string. **There is no position in that call in which a caller's
bytes could be read as a program**, which is what distinguishes this from the arbitrary-code verb this
design refuses by name.

**The five refusals, each with the reason that makes it more than a bound:**

| Refused | Because |
|---|---|
| More than 16 entries, or a value over 4 KB | A bound is what makes this a seeding argument rather than a payload channel. The measured shape is one or two tokens |
| A value that is not a string | The only thing that could carry a structure is something that gets interpreted, and interpretation is the thing being refused |
| An origin that is not ordinary web traffic | Same rule and same reason as navigation: a local-file origin turns a lease into filesystem reach |
| Cookies | Not an area on offer. A cookie is a credential the browser sends automatically to everything matching its domain, and seeding one is credential injection on a shared profile |
| Any entry on a lease that is not the caller's | It is an argument on the claim, so it applies once, to the tab that claim grants. There is no path to seeding somebody else's |

**The seed is an event on the grant — origins and keys, never values.** Same reasoning as cookie
values: the question *"which leases started life already holding a credential"* needs an answer, and
the answer does not need the credential in it.

### #25 and #30 — how the parity suite is built

**One driver per route, behind one interface**, in a map typed from the route registry the application
actually mounts through, so **adding a route without adding its driver does not compile.**

**Cases are authored once per operation, never per route.** A case names an operation, a seed, an
input and an expectation. The runner takes the cross product with every driver exposing that
operation, so a case costs nothing per route — which is what stops the suite decaying at the point
where writing cases becomes tedious.

**The fake browser records every call it receives**, and a refusing case asserts **two** things: the
call log for that case is empty, and the live claim count is unchanged, read from the same predicate
the capacity check uses. Both, because they catch different bugs — a guard that opens a tab and closes
it on the way to refusing leaves the count unchanged and the log full; a guard that decrements a
counter without telling the browser leaves the log empty and the count wrong.

**Waivers stay bounded by construction rather than by review attention:** no operation any registered
rule can refuse may be waived by a route that exposes any write operation. A route is read-only by
declaration, or fully covered, with nothing in between — otherwise a driver that declines to expose
anything passes the first assertion vacuously. **The commands with no operation behind them carry
written waivers** (`SCHEMA.md` §5.5) rather than being quietly absent from the matrix.

**Negative controls, each asserted to fail**, because an assertion nobody has watched fail is an
assertion nobody has tested: a fixture route reaching past the service layer to the store · a
registered rule with no case · a driver returning a different code for the same input · an operation
with only an accepting case · a refusing case whose call log is not empty · a refusing case that
leaves the claim count moved · a route exposing an operation the registry does not know · and a direct
assertion that the rule registry is not empty, because an assertion evaluated over an empty set passes
forever and silently.

**Cost.** Run in process wherever the process boundary is not the thing under test — call the handler
directly, drive the command line through its entry point with an argument vector. **The exception is
the concurrency suite, where the process boundary *is* the thing under test** (below). Keep a smaller
spawned smoke subset (a real process, a real session, a real store) as its own job. The in-process
matrix runs on every change; the spawned subset proves the wiring and does not grow with the case
table.

### #12–#17 — how the concurrency tests are constructed

**These are the tests most likely to be written hollow, because the hollow version passes.**

**Spawn real processes.** The contention this design has is between **separate operating-system
processes**, and a test using threads or promises inside one process exercises a mechanism that does
not exist here — one process can hold a lock in memory, and none of the callers can. A single-process
version of this test can be made green by code that would deadlock or double-issue in use.

**Ship the deferred-transaction failing control alongside the immediate case.** Run the same
contention harness twice: once on `BEGIN IMMEDIATE`, once on a deferred transaction with a widened
read-then-write window. **The immediate run is asserted to succeed; the deferred run is asserted to
fail.** Without the second assertion the suite cannot distinguish "the transaction mode is what makes
this correct" from "there was never enough contention to tell", and **deferred passes at low
contention** — that is the whole trap. The single-character change that breaks this test is dropping
`IMMEDIATE`.

**Assert the engine refused, not merely that the total came out right.** For double-issue, assert the
losing process received a **uniqueness-constraint error**. A test that only checks a final count can
be satisfied by application code that happened not to race on that run.

**Assert the sweep is global.** Seed a lapsed claim belonging to session A, then have session B make
an unrelated arbitration call, and assert A's claim is expired and its capacity available. A sweep
scoped to the caller passes every test that only ever asks about the caller's own rows.

**Assert the browser round trip is outside the transaction.** With a fake driver whose close call
blocks, a second process's arbitration call must still complete. This is the test that would catch
`arbitration.no_browser_io` being violated in a way the build check's source scan missed.

**Assert the budget disagreement refuses.** Two processes, two different budget values in their
environments, one store: the first starts and records its value, the second **refuses to start and
names both numbers.** The single-character change that breaks this test is turning the comparison into
an adoption of the stored value, which is the change somebody makes to be helpful.

### #56 — the keeper-tab test runs headed, and says why

**The test must launch a headed browser**, open one leased tab beside the keeper, release the lease,
and assert the browser is **still alive and re-attachable** afterwards.

**It must carry a comment stating that it runs headed deliberately, and why.** Measured: headless,
closing the final tab leaves the browser alive; **headed, it dies within about half a second.** So a
headless version of this test **passes with the keeper tab deleted** — the behaviour it protects
against does not occur headless — and a future cleanup pass would remove the keeper, get a green run,
and be confirmed in the removal. The comment is the only thing standing between that pass and a
destroyed shared sign-in.

The single-character change that breaks this test is flipping the headed flag on the browser it
launches — which is exactly the change the comment exists to argue with.

### #35 and #70 — the generated document, and reading addresses live

**One command, one file, then the process exits.** The document is assembled from **one status read**
— which has already applied the expiry derivation — plus the live address read below. Styling and
behaviour are written inline: no separate stylesheet, no separate script, no fonts fetched, nothing
loaded from anywhere. That is not asceticism, it is the only kind of file that still renders when it is
moved, sent to somebody, or opened on a machine with nothing installed.

**Assert the reader rule where the document is generated.** Build a store with a lapsed-but-unswept
lease and assert the document does not show it as live. A generator assembled from direct table reads
passes every test that only ever seeds live rows, and it fails worst on the busiest installation —
which is the one nobody tests against.

**Assert the snapshot label is in the document body**, not only in a footer and not in the file name.
The file name can be renamed; the body cannot be renamed by accident.

**The live address read, per tab:**

```
for each live tab:
    ask its browser where the tab is, with a per-tab timeout
      answered      -> the address
      timed out     -> the literal word for unreachable
      no such tab   -> the literal word for unreachable
```

**The timeout is per tab and it is mandatory.** A browser can accept a request and never answer, and a
generator that inherits that hang produces nothing at all — worse than an incomplete document. Per tab
rather than per run, so one wedged page costs one entry.

**Assert unreachable renders as the word.** Seed a driver that never answers and assert the output
contains the explicit token rather than an empty cell or a placeholder address. **A missing address and
an unanswered one are different facts**, and a test that only checks "no crash" cannot tell them apart
either.

**Nothing is written to the store by generation.** Reading where a tab is, is a read.

### #3, #50 and #69 — how the build-time rules are enforced

| Rule | Enforced by |
|---|---|
| Every arbitration path opens a transaction declaring its intent to write | A source check over the arbitration module: no transaction is opened except through the one helper (#10), and that helper's mode is asserted. Paired with the failing control in the concurrency suite |
| No arbitration path answers without writing | A source check that every registered arbitration operation routes through the sweep, **plus** a registry test asserting the set of arbitration operations is not empty — an assertion over an empty set passes forever and silently |
| No browser call inside the arbitration transaction | An import and call-graph check: the browser module is unreachable from the transaction helper's body, **plus** a fake-driver assertion that no call is logged between open and commit |
| The foreground is never moved | A source check failing on the identifier anywhere outside the one file that documents the prohibition, **plus** a fake-browser assertion that no call log across the whole suite contains it. #60 is the empirical half, against the real tool |
| No capture with the correct-surface option disabled | The same pair: a source check, and an assertion that no recorded capture call carries the option |
| No browser-scoped destructive operation on the agent surface | The operation registry is typed so that an operation declaring a browser target and a destructive effect does not compile on that surface. Adding one fails the build rather than the review. Reap and restart exist administratively, and what fails the build is either appearing on the agent surface |
| **No capture path reads anything belonging to the diff feature** (#69) | An import and call-graph check from the capture module into the diff module, with a seeded violation. **This is what makes the sequencing property real rather than intended**: diffing is built last, so a capture that consulted it would make the earlier work depend on the later |
| **No path that serves bytes accepts a filesystem path from a caller** (#49) | A signature check over the image surface: it takes row identifiers, never a path. There is no traversal to defend against because there is no input to arrive through |
| Only the browser module imports the automation library; only the service layer, the configuration resolver and the schema steps import the store client | An import **allowlist**, not a denylist of route directories — a denylist is wrong the first time somebody adds a directory nobody thought of |
| No variable this service reads is credential-shaped | A registry test over the declared variables, failing the build |
| **`.env.example` lists every declared variable with its default** | A test walking the registry against the file. A variable in code and not in that file is an undocumented setting |
| No path refuses a capture for cost | A test taking several hundred captures on one lease, asserting every one succeeded, that the warning fired past the threshold, and that it fired on **every** capture past it rather than once |
| The store location is read from the environment and never from the store | A source check that the resolver has no read path through the store client, plus a test seeding a location-shaped row and asserting it is ignored |
| **No code path opens a listening socket** | A source check over the whole tree. Nothing is served, and the way that stays true a year from now is a rule rather than a habit — a page somebody adds "just to look at it locally" is precisely how a served surface arrives |

**Every one of these ships with a seeded violation proving it fires** (`CLAUDE.md`). A gate only ever
proven to pass has never been run against the thing it exists to catch.

## Not scheduled, deliberately

**An execute-arbitrary-code verb, and this refusal is evidence-backed rather than cautious.** A verb of
that shape was measured at **328 calls across 53 sessions**, and its arguments were sampled and
classified rather than left as a count. **101 calls across 33 sessions exercised a real shared-pool
hazard** — something a page-scoped expression could not have done, reaching past the caller's own
lease. The three largest classes: **16 calls in one session enumerated other callers' tabs and drove
one it did not own**; **2 read a local environment file and extracted administrative credentials in
cleartext**; **49 made outbound authenticated network requests from the service process**, which is not
a browser operation at all. Roughly two thirds were page expressions, which `browser_evaluate` provides
on both browsers with no allowlist. **What stays unreachable, with its reason:** outbound authenticated
network calls, because **an agent that needs to make authenticated network calls does not need a
browser** — routing one through a browser lease buys it nothing but this service's credentials and this
service's blast radius; other callers' tabs, because every browser is shared and that is a shared-fate
operation; and the service's own filesystem and process. **A caller that hits one of these gets a
refusal naming the alternative**, and where there is genuinely no alternative, that is what #67 is for.

Multi-machine execution — the driver interface leaves the seam and nothing more · a read-only widget
another system embeds — the surface is designed so it stays possible, and that is where it stops · a
visual-regression **test runner** — diffing exists here to make review cheap, and the moment a feature
reads as "fail the build when the pixels move" it belongs elsewhere · authentication on the generated
snapshot — it is a file, so reachability is the operating system's question, answered by who can read a
file · **a resident helper kept "just for the timer"** — it will be proposed, because lazy reclamation
looks like a workaround for a missing sweeper; it is not, and a helper reintroduces the whole lifecycle
the design does not have, for the one responsibility that turns out not to need it · **any served
surface at all** — no bind address, no port, no health endpoint; `nothing.listens` is the build rule
that keeps it that way · **a settings table, a configuration command or any write path for a setting** —
configuration is the environment and `.env.example` is the registry, and the one value several
processes must agree on is a row with no writer after the first · **retention on captures or crops** —
nothing sweeps an image, because a retention window makes an identifier silently invalid for a reason
nothing in the response mentions · **drag and drop as their own work** — folded into #64 at low priority
against a measurement of zero calls over a month across 2,007 transcripts, and recorded with the number
so a later request arrives with something to argue against · **reaping the private browser's keeper
tab** — correct but unnecessary, since that browser is headless with nothing to lose and is cheap to
relaunch, so it is an implementation call rather than a row · any general widening of the tool surface,
which is refused by default and only ever accepted with a reason arbitration specifically requires.
