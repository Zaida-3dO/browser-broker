# Browser Broker — decision log

Every decision with its reasoning, including what was rejected and why. Written so nothing depends on
a conversation surviving, and appended to in dated sections rather than edited in place — **check
here before re-litigating anything.**

**Companion documents:** `PLAN.md` (how it works, in prose) · `SCHEMA.md` (the concrete shape of
every table, tool, endpoint, command, setting and guard) · `MILESTONES.md` (the work queue).

---

## 0. Name

**Browser Broker.** The command is `broker`.

The name has to survive two things the design already settled. It must not name the automation
library, because that is a dependency the requirements never mandated and a later decision should be
free to change without the product being misnamed. And it must not describe capacity as a *pool of
slots*, because the unit of allocation here is a **lease over tabs**, and a name that says "slot"
teaches every reader the wrong model on the first line.

"Broker" says what it does: it stands between callers and a scarce resource, decides who gets it, and
refuses the rest.

---

## 1. What it is

One service holding a bounded set of browsers, one place the lease state lives, one place the rules
are checked, and every surface a thin adapter over that one place.

**The point:** a rule a client is asked to honour is a rule that drifts, because each client honours
it slightly differently and nothing notices. These rules are enforced — the service refuses the call.

**The service is useful without the capture policy and without diffing.** Arbitration alone is a
whole product; the policy and the comparison are value stacked on top of the fact that the service is
already the thing holding the browser.

---

## 2. The governing principle: the service owns the contract

Everything else in this document is downstream of one choice: **the caller talks to a contract this
project defines, not to a general-purpose automation surface.**

That is worth stating as the *primary* reason, because there is a tempting secondary one — a curated
contract is cheaper in tokens — and leading with the cheap-and-cheerful argument invites a bad future
optimisation. It goes: *"this particular operation is cheap, so let the caller reach the raw tool for
that one."* Every such shortcut reopens the hole the service exists to close, because arbitration
that can be bypassed for one operation can be bypassed.

Control is the driver. Cost is a constraint managed inside it, not the other way round.

**The corollary is the load-bearing part: the contract must be unbypassable, or it is a convention
again.** A caller that can reach the automation binary directly can also attach to a browser nobody
launched through the service — including a person's own, signed in to everything they use. That is
not closable at the tool layer, because an attach creates a *new* automation session pointing at a
foreign process. It is closable only by the binary being unreachable. `PLAN.md` ranks the four
available measures and says plainly that only one of them is a mechanism.

**Rejected: publishing an "escape hatch to the raw tool for advanced use."** It is the same decision
as above wearing a friendlier name. If an operation is needed, it becomes a contract operation with a
guard and an audit row.

---

## 3. References, not payloads

A tool result that arrives in an agent's conversation stays there and is re-read on every subsequent
turn. So the expensive property of a result is not what it costs once; it is that it is **resident**.

- `capture` returns `{path, width, height, bytes}` — never the image.
- `read` returns a path to the snapshot, console or network log on disk. The caller greps what it
  needs.
- `evaluate` returns small JSON inline, spilling to a path past a byte cap. This is the cheap path
  and it exists to be used.
- Lease operations return inline; they are tiny.

**This is orthogonal to whether the surface is an MCP or a command line**, and an early framing
claiming otherwise was wrong. Whatever holds the lease also takes the capture, so it can downscale,
cap counts and refuse over-budget requests either way. The real difference is **where results land**:
an MCP result enters the conversation automatically. A tool that writes an artefact to disk and hands
back a path does not. Choosing MCP and returning paths takes the discoverable, typed, schema-checked
surface *and* the property that made the alternative attractive.

**Independent confirmation this is the right shape:** a third-party browser-pool project arrived at
the same answer from the same pressure, offloading screenshots and PDFs above a size threshold to
blob references and reporting a drop from tens of thousands of tokens to roughly a hundred for the
reference. Different codebase, same conclusion. (It is cited as prior art, not adopted — see §10.)

**The expected landing, stated so nobody misreports it later:** results-in-context are eliminated;
schema residency is shrunk, not removed. The number should land much closer to a
write-to-disk-and-return-a-path tool than to a forty-tool general automation server, but not equal to
either. **Measure it. Do not trust a published figure, including this paragraph.**

---

## 4. Arbitration is the whole app

The automation ecosystem solves **routing**: which browser does this command reach, how do named
sessions work, how do profiles persist. It has no concept of **arbitration** — no bound, no lease, no
queue, no expiry, no explicit release, no ownership check, no capture policy.

So the split is clean, and it is the reuse rule doing its job rather than a preference:

| Concern | Call | Why |
|---|---|---|
| Driving a browser: launch, sessions, tabs, persistence, navigation, snapshot-to-disk | **Reuse** | First-party, actively developed, and already the routing half of what is needed |
| Bound, lease, queue, expiry, reclamation, explicit release, ownership, capture policy, curated contract | **Build** | Genuinely unowned — the survey found nothing shipping the combination |
| Pixel comparison itself | **Reuse** a diff library | Well-trodden; writing a differ would be a vanity project |
| Changed-region extraction from a diff mask | **Build** | Libraries emit a mask or a count; a reviewer needs rectangles. Connected components over the mask is small |

---

## 5. No browser-scoped destructive operation, ever — and no current tab

Two structural rules, both of which delete a bug class rather than guard against it.

**Nothing browser-scoped is exposed to callers.** No close-browser, no close-all, no kill-everything,
no delete-profile-data. With browsers shared between callers, every browser-scoped operation is a
**shared-fate** operation: one caller ends every other caller's work, and on the signed-in profile it
destroys an authenticated session that a person has to restore by hand. Browsers are lifecycle-managed
by the service. A caller can close its own tabs and nothing else.

**Every operation is addressed by an opaque tab identifier. There is no current tab.** An implicit
cursor shared between callers is a defect waiting for concurrency: one caller navigates, and the page
another caller was working in — possibly the one holding the signed-in session — is silently
replaced, with no error and nothing in any log to say what happened.

**And the destructive operation keeps its own name.** Closing a tab is `tab_close`, not
`tabs{action:"close"}`. Folding a destructive operation into a general one under an action parameter
is how a guard that matches on operation name becomes invisible, and the failure is silent by
construction: the guard does not fire, so nothing is recorded, so nothing looks wrong.

**Consequence for testing, and it is why the fake driver is early work:** *every rejection test
asserts the physical side-effect, not just the response.* A guard that returns "denied" after the tab
already opened is worse than no guard, because it reports a refusal that did not happen and
everything downstream believes it.

---

## 6. Exactly two browsers; concurrency is expressed in tabs

**Verified, not assumed.** A named automation session **is a browser instance** — its own process,
its own cookies, local storage, history and console. Tabs live inside a session and share its storage
partition. So "sign in once, every tab inherits it" is the documented behaviour, and an *isolated
session* costs a whole browser rather than a renderer.

| Browser | Profile | Uses | Count |
|---|---|---|---|
| regular | persistent, signed in | everything stateful, as tabs | 1 |
| private | ephemeral | clean-room work, as tabs | 1 |

Two processes is a **hard ceiling that does not move with caller count**. Memory grows by a renderer
per tab rather than by a browser per caller, so ten concurrent tabs is a gigabyte or two, flat in the
number of connected clients. **Process count is bounded by configuration, not by how many clients
connect** — that is the property, and it is the one worth defending against every future convenience.

### The tab budget is a single total, not an allowance per browser

**One counter across both browsers. Default 15.** A claim is admitted if
`total open tabs + requested ≤ budget`, whichever browser it asked for.

The scarce resource is renderer processes and the memory they hold, and a renderer costs the same
whichever browser owns it. A per-browser cap would ration something that is not the scarce thing: it
would refuse a fourteenth regular tab while a private allowance sat unused — a refusal that protects
nothing and costs a caller its work. With one counter the split falls out of demand (14/1, 5/10,
whatever the day is), and there is exactly one number to reason about, which is the one that maps to
memory.

**Rejected: per-browser caps.** They look like fairness and are actually two budgets, each of which
can be exhausted while the machine is idle.

**The behaviour change this implies must be stated rather than discovered.** "Private" means *not
signed in as the operator*. It does **not** mean isolated from other callers: tabs in the private
browser share its cookie jar, so two concurrent reviewers are clean-room relative to the regular
profile and not relative to each other. Fine for design review. Not fine for multi-account work or
two parallel sign-in flows.

**Rejected: an isolated third browser as an escape hatch.** An earlier draft held one open — granted
for the duration of a single claim, explicitly requested and explicitly released — for the
multi-account case. It is **dropped, not deferred**, and the reasoning is better than the exception
was:

- **Sequential execution already solves it.** Two independent authenticated sessions can be run one
  after the other. The escape hatch buys parallelism, not capability.
- **An exception that mints a browser on demand undoes the bound it sits inside.** "Exactly two,
  except when someone asks" is the same thing as "as many as are asked for", with a politer name and
  a delay before anyone notices.
- **A capability held open in advance, on the chance it might be wanted, is a surface with no
  caller.** If a case genuinely arises, it is a decision to take then, with the real requirement in
  front of it rather than an imagined one.

**Exactly two browsers, no exceptions, ever.** What is given up is stated rather than buried:
**testing two independent authenticated sessions in parallel is not possible through this service, by
design.**

**Rejected: a library of purpose-named profiles**, one per site or per account. It sounds like it
buys isolation and mostly buys processes: one persistent browser holds many sign-ins simultaneously,
because that is what a shared cookie jar is. A purpose-named profile becomes a **purpose-named tab**
on the regular browser. **There is no profiles table and no profile registry** — adding one would
turn a fixed two-row fact into an unbounded collection, which is the same decision reversed by
accident.

**One caveat no design removes:** per-tab session storage is per-tab in every browser, whatever is on
disk. A site binding its session to it loses that on a new tab. The service reports this as a field
on the response rather than pretending to guard it.

---

## 6a. Bidirectional isolation — a first-class property, not a rule about behaviour

**The service runs its own two browsers, and is isolated from everything else on the host in both
directions.**

Other browsers exist on the same machine. A person's own. Automation that is not part of this system
at all, which typically takes the default profile. **The service does not manage any of them, and
leaves them entirely free for whoever is using them.** It runs its own.

**Outward: nothing this service does can disturb a browser it does not own.** It never adopts,
attaches to, closes or reaches any process it did not start, and it refuses any operation naming one.

**Inward: nothing outside can block this service either.** This half is the one that changes the
design, because it is not a rule about what the service does — being blocked is something done *to*
it, and no amount of careful behaviour prevents it. Three consequences, all structural:

- **The service always launches with an explicit profile directory of its own, and never relies on a
  default path.** This is a **hard requirement**, not a precaution. The default persistent profile
  location is shared by anything else that also takes the default, and two processes on one profile
  contend on its lock file — so an unrelated run that happened to start first would stop the service
  starting at all. That is precisely the inward failure, arriving through the most ordinary door
  there is.
- **No shared lock file, no shared port, no shared temporary directory.** Anything the service has to
  acquire, it acquires somewhere it owns.
- **No assumption that a browser it did not launch is absent.** The service has to be correct on a
  machine where three unrelated browsers are already running, because it never looks for "the
  browser" — only for the ones it started.

**Why this framing rather than a list of things not to touch:** a list of prohibitions can only be
reviewed, and reviews are exactly the mechanism this design is trying to stop depending on. *"Do not
disturb the wrong browser"* has no test. *"Starts successfully while an unrelated process holds the
default profile"* is a test, and it fails loudly the day someone removes the explicit path because it
looked redundant.

---

## 7. Self-hosted only

No hosted or remote browser service. Page content stays on the machine that renders it.

This is a **privacy** decision, not a cost one, and the distinction matters because a cost decision
can be reversed by a better price. Sending a page to a third party sends whatever is on it: an
authenticated dashboard, an account page, a document. There is no price at which that becomes fine,
so it is not a trade-off being managed — it is a boundary.

---

## 8. One machine

**The service, the browsers and the database all run on the host that renders the pages.**

The automation tool is machine-local: no listening socket, no server mode. Sessions persist because
the browser processes stay up, and attaching over a debugging port is a client-side attach rather
than a server. So a service on machine A cannot drive a browser on machine B by shelling out, and any
design that splits them has to invent a remote-call protocol, a liveness model and failure semantics
**before it can arbitrate anything**.

Once the service must sit beside its browsers, putting the database elsewhere buys very little: a
lease is a ten-minute fact, not an archive.

**The trade, stated rather than glossed: lease state lives and dies with the host.** A property worth
having — the record surviving the machine that holds the browsers — is deliberately given up in
exchange for the simplest first version that works. With no browsers there is nothing to arbitrate,
so the outage is self-limiting, and state reconciles on restart.

**What preserves the option is the driver interface**, and after this decision it is the *only* thing
that does. The browser driver sits behind an interface with a fake implementation beside it; a remote
implementation is an addition rather than a redesign. Keep that seam even when it looks like
ceremony.

---

## 9. Measure your own numbers before migrating on someone else's

A published figure comparing two ways of driving a browser is evidence that a mechanism exists. It is
not evidence about **this** service, which is a third thing that shares properties with both.

Two measurements, and it is worth being exact about what each can and cannot claim:

- **Schema residency.** Count the curated tool block's tokens and compare it against a general
  automation server's. Available immediately, needs nothing built, and is the number the small-surface
  decision predicts.
- **End-to-end, on real review work.** Compare matched pairs — the same review target reviewed twice,
  once each way, several pairs — rather than population means, because difficulty varies enormously
  between runs and a blind population comparison measures which runs happened to be hard.

**What that number means, written down so nobody misreports it later:** it measures *this service
against whatever the deployment did before*, which is the decision-relevant comparison. It does not
measure "command line versus MCP" in the abstract and never will, because no arm of the experiment is
a stock command line.

---

## 10. What was surveyed, and what was rejected

Recorded because "we looked" is worthless without "and here is what we found."

| Considered | Call | Why |
|---|---|---|
| **`@playwright/cli`** — first-party automation with named sessions, persistent profiles, tab operations, snapshot-to-disk | **Adopt as the driver** | It is the routing half of the requirement, actively developed, and distributed as a plain binary |
| **A general automation MCP server, one per session** | **Rejected** | Spawned per connecting session, so process count scales with clients — the exact property §6 exists to bound. Also exposes every destructive operation §5 removes |
| **`playwright-parallel-mcp`** — per-session process isolation with a session timeout | **Rejected** | A timeout is not a lease. No bound, no queue, no ownership, no persistent profiles |
| **`concurrent-playwright-mcp`** — session-isolated contexts sharing one browser process | **Rejected** | Right instinct on process count, but no bound, queue or expiry, and isolated contexts do not share a sign-in, which is the property the regular browser exists to provide |
| **`browser-pool-mcp`** — dynamic port per session | **Rejected** | Same gaps, and unvetted |
| **`nickweedon/playwright-proxy-mcp`** — browser pool with first-in-first-out leases and blob references for large results | **Cited as prior art, not adopted** | Genuinely closest, and independent confirmation of §3. But: one star, no licence file (the listing claims one, the platform's API reports none), and unmaintained for months. Its expiry is on *blobs*, not leases — so it does not reclaim from a caller that died. No queue, no explicit release. It proxies the full upstream tool list, reinstating every destructive operation. And a pool of N means N browser processes, which is the topology §6 rejects |
| **`chrome-devtools-mcp`** — first-party, debugging-oriented, with performance tracing | **Rejected as a substitute; complementary** | Tuned for debugging rather than arbitration. Nothing about it addresses the bound, the lease or the queue |
| **Hosted browser services** | **Rejected** | §7 — privacy, not cost |
| **Named-session support arriving upstream** | **Checked, and it is not coming** | Two separate upstream requests for named multi-session support are closed — one as *not planned*, one pointing at "run multiple servers, or use the command line". Both are the *routing* answer, and neither is arbitration |

**Upstream requests, for anyone re-checking:**
<https://github.com/microsoft/playwright/issues/40585> ·
<https://github.com/microsoft/playwright-mcp/issues/1530> · prior art:
<https://github.com/nickweedon/playwright-proxy-mcp> · session semantics:
<https://playwright.dev/agent-cli/sessions>

**The honest counter-argument to building at all:** upstream could ship arbitration later and leave
this owning something redundant. The mitigation is the same as the reuse rule — keep it **thin**, so
retiring it costs a configuration change rather than a migration.

---

## 11. Facts the design rests on

Each was checked rather than assumed, and each one a decision above leans on. Where something could
only be read from documentation rather than proved, it says so — that is the difference between a
fact and a plan.

| | |
|---|---|
| **A named session is a browser** | Documented explicitly: each session has its own browser instance, cookies, local storage, history and console; tabs are session-scoped state. This is what makes §6's arithmetic work |
| **The automation tool is machine-local** | No listening socket, no server mode. Sessions persist because processes stay up; attaching over a debugging port is a client-side attach. §8 rests entirely on this |
| **A stdio server is spawned per connecting session; an HTTP server is not** | The single structural reason the primary adapter is HTTP. It is also what makes a cross-caller ownership check meaningful — with private browsers per session there is nothing for one to protect |
| **The raw tool surface is large and includes credential operations** | Roughly fifty commands, including arbitrary code evaluation, whole storage-state save and load, full cookie and storage CRUD, and attach-to-an-external-browser. This is why §2's corollary is a precondition rather than hygiene |
| **The default persistent profile path is not documented as session-keyed** | Two processes taking the default therefore contend on one profile directory and its lock file. **Unverified — needs a live run**, and it does not matter that it is unverified, because §6a makes an explicit profile path a hard requirement either way: relying on a default is how something outside the service blocks it from starting |
| **High-resolution vision tiers bill an image at up to roughly 4,800 tokens** at a 2576-pixel long edge, against roughly 1,600 at the 1568-pixel tier | Why the ceiling is a service-enforced number rather than advice, and why full-page capture is off by default: unbounded page height crosses the boundary more often than width |
| **A page snapshot is text** | Headings, labels, alternative text, focus order, element geometry and touch-target size are all readable from the accessibility tree, and a large share of a design-review checklist is measurable from the document rather than from a picture |
| **Changed-region extraction is not off-the-shelf** | Diff libraries emit a mask, a count or a boolean; test-runner-shaped tools are built to *fail a build*, not to hand crops to a reader. Connected components over the mask is the missing piece and it is small |

---

## 12. Where the research was wrong

Recorded because a document that only contains the conclusions it kept is a document nobody can
calibrate. Three findings overturned something an earlier pass had asserted, including one the same
pass had asserted itself.

**The deployment split does not survive contact with the tool.** An earlier design put the state in
one place and the execution in another, with a coordinating half on each machine. That shape assumes
the automation tool can be reached across a network. It cannot — there is no daemon and no port —
so the "brain here, hands there" design would have had to build its own remote-call protocol,
liveness model and failure semantics before arbitrating anything. The substance of the original
constraint was *"the durable thing and the volatile thing should not be the same thing"*, and §8
records that this was reconsidered again and given up outright in exchange for a single-host first
version. **The lesson worth keeping is the general one: verify a component's deployment model before
designing a topology around it.**

**The cost case was overstated by roughly ten times, in one specific respect.** The claim that an
image captured early is re-read on every subsequent turn is **exactly right as a statement about the
context window**, and a resident image genuinely does get re-ingested tens of times over a long run.
But as a statement about *money* it is roughly a tenth of its apparent size, because a resident
result on later turns is a cache read at a small fraction of the base input price rather than a fresh
bill. This does not change the recommendation — the context-window axis is the one that drives
compaction, truncation and quality loss, and it is the one that matters — but the case should be made
honestly rather than inflated. **An argument that is true on one axis does not become stronger by
being restated on an axis where it is weak.**

**A sequencing gate was written that nothing could satisfy.** An earlier constraint said: do not
commit to this until the ratio has been verified against a particular measurement. That measurement
had not been built, was not scheduled, and had no owner — so the gate was not a gate, it was an
indefinite hold wearing the costume of rigour. It is re-expressed in §9 as **a measurement this
repository owns and can run**, which preserves everything the constraint was actually protecting.
**A precondition that depends on work nobody has started is a decision to stop, stated as a decision
to be careful.**

**And one thing the research got right that is worth naming, because it generalises.** A capacity
pool documented as holding sign-ins, but configured to run every browser isolated, holds no sign-ins
at all — and the guards written to protect those sign-ins were protecting a property that was never
there. **A property that is only written down is not a property.** Every invariant in `SCHEMA.md`
must be enforced somewhere executable, or it is a comment.

---

## 13. Public repository, and the writing rules that keep it publishable

This repository is public from its first commit, so the scanning rules and the writing rules in
`CLAUDE.md` are part of the design rather than a policy bolted on later.

The rule that takes the most discipline: **nothing is described by what it succeeds.** Not because
the history is embarrassing, but because it is unverifiable — a reader of a public repository can
check what the code does and cannot check a claim about a system that is not here. Every requirement
is therefore restated as a capability or a principle, and the exercise is not a loss: *"a shared
authenticated profile must not be destroyable by any single client's action"* is a better sentence
than any account of the incident that motivated it, and it survives the incident being forgotten.

**Enforced by a check that matches pattern shapes, never a denylist of real values**, because writing
the real names into a check so they can be grepped for publishes exactly what the rule protects. The
one exception is the opposite construction — an **allowlist** of hosts this repository may name —
which publishes nothing, and it is used for exactly one shape.

**One shape class is specific to this codebase and earns its place.** A browser-automation repository
accretes example URLs, example sign-ins and example profile directories by the nature of the work,
and each one is a fact about where somebody really goes, what their machine is called, and which
account is signed in. So absolute paths, browser-profile locations, private address literals and
unlisted URL hosts are matched as shapes alongside the phrasing rules.

**What a green check does not mean** is stated in the script's own header and in its test: it
certifies the absence of the shapes it was taught, not that the prose is clean. A private proper noun
in an ordinary sentence passes every pattern. Reading the diff is the mechanism; the check exists so
the recurring phrasings do not eat the attention that reading needs.

---

## 13a. Design interview, round one (2026-08-13)

Four questions answered by the owner. Two changed what the documents say.

### The name is settled, and it is not a slot model

**`browser-broker`, command `broker`.** Reasoning in §0. Recorded here as well because the earlier
working name did two harmful things at once — it named the automation library, and it described
capacity as a pool of slots when the unit is a lease over tabs.

### Time to live: one rule, two defaults

**Settled: uniform mechanism, differentiated durations.** *Keep pinging or lose it* applies
identically to an active holder and to a queued client, and any keyed call renews. The durations
differ: **active 10 minutes, queued 5**, both configurable.

The mechanism is one rule because two rules would be two things to reason about for no gain. The
durations differ because the **failure costs are asymmetric**: expiring an active holder destroys
work in progress and can strand a half-finished authenticated flow, whereas expiring a queued client
costs it a place it can retake by asking again. Same rule; different price for getting it wrong.

### No profiles table

Confirmed as written. One persistent browser holds many sign-ins simultaneously, so a purpose-named
profile is a purpose-named **tab**. Reasoning and the rejected alternative are in §6. The concrete
consequence for the next document: `SCHEMA.md` has a fixed two-row browsers table and **no profiles
table, no profile registry and no named-profile concept**.

### Pixel diffing belongs in this service — reversing the research recommendation

The research pass recommended deferring changed-region diffing to a separate small tool, on the
grounds that it is a second-visit optimisation and that the diff itself is a library call. **The
owner chose the opposite, and the reasoning is better than the recommendation's:** baselines are pool
state. This service already holds the browser, already takes every capture, and is already the only
place a per-view identity can be recorded. A separate tool would have to be handed images by
something that has them, which is this.

So the service gains a baselines store keyed by view and breakpoint, a compare operation, changed-
region bounding-box extraction, region cropping, and a tunable anti-aliasing threshold. The diff
itself is a library; the bounding-box extraction is the part that needs writing.

**Two things to hold onto rather than smooth over.**

**It widens a tool surface that was deliberately kept small.** §3 argues surface area is a standing
tax on every connected session, and this adds to it. The mitigation is that it is *one* operation
rather than a family — a compare that takes a capture and a view identity and returns regions — and
that the baseline management belongs on the operations surface rather than in the agent-facing tool
list. That constraint should be defended in review, because "one more diffing tool" is exactly the
shape of request that arrives next.

**It is useless on a first visit.** Diffing pays off on **repeat** review of the same views and does
nothing at all where there is no baseline, so it is a second-visit feature living inside a service
whose other features are first-visit ones. The honest answer is not that the tension is imaginary; it
is that repeat review is the common case and the feature is opt-in per call. It should never become
a default path that quietly fails open on a first run.

**Consequence for the work queue:** diffing gets its **own milestone** rather than being appended to
the capture-policy one. Its store, its tuning and its extraction step are a feature, not a policy
setting, and the dependency graph reads more honestly with the split. See `MILESTONES.md`.

---

## 13b. Design interview, round two (2026-08-13)

Three more answered. One is another reversal.

### Stack: Node, TypeScript, Prisma, Postgres

Settled. It matches what the operations need — a long-lived process, a small relational schema with
real constraints, and a driver that shells out to a binary distributed for this ecosystem.

**Known constraint, recorded now so the pull request that hits it is not surprised.** Prisma **cannot
express partial unique indexes**, and this schema wants at least two: *one live claim per session*
and *one active lease per tab*. Both are exactly the constraint a partial index exists for — unique
among the rows in a particular state, unconstrained among terminal ones. There are two answers and
neither is free:

- **A hand-written migration** carrying the raw index, with the schema-drift check taught to tolerate
  that one documented exception. Race-proof, at the cost of a permanent exception in a check whose
  value comes from having none.
- **Application-level enforcement.** No exception needed, and **not race-proof on its own** — two
  concurrent claims can both read "no live claim" and both write one. Only acceptable with a
  serialised transaction or an advisory lock around the check, which is a real mechanism and should
  be named as one rather than assumed.

**This is not solved here.** It belongs to the pull request that lands the constraint, decided with
the actual transaction shape in front of it. What is decided is that it will not be skipped.

### Everything on one host, including the database

A further change, and **not** the research recommendation, which had kept the durable state on a
separate always-on box. Reasoning and the trade are in §8: one machine, no network dependency, and
lease state that lives and dies with the host.

Worth being explicit that a real property is being surrendered rather than optimised away. The
argument that wins is that a lease is a short-lived fact whose entire value is a browser that is also
on that host, so surviving the host buys an accurate record of leases over browsers that went down
with it. The driver interface remains, and after this decision it is **the only thing** preserving
the option of ever splitting them.

### The visual surface is one read-only page, and no framework behind it

**One page: live claims, queue depth, tab budget, and each claim's stated purpose. No controls, no
sign-in story.** An operations view answers *"what is holding what, and how long is the queue"*, and
that question needs no buttons.

**Chosen: a single static HTML file served by the HTTP adapter, fetching the JSON endpoint that has
to exist anyway and rendering it client-side.** No application framework, no build step, no bundler,
no dependency tree, no second release surface. The alternatives were considered and rejected on the
same test — *what does this buy a page that displays six numbers?*

- **A full application framework** brings routing, rendering modes and a build pipeline for one
  route, and a permanent upgrade obligation for something with no interactivity.
- **A separate front-end application** adds a second deployable and a cross-origin story to a page
  served by a process that already answers HTTP.
- **Server-rendered templates** would work, and were rejected only because a fetch-and-render page is
  fewer moving parts than a template engine plus a refresh strategy, and it makes the page a plain
  consumer of the public JSON endpoint — which is the property that lets another system fetch the
  same data later as a read-only widget without anything here changing.

**Deliberately not built:** that widget. The endpoint is designed so it stays possible; nothing is
written for it.

---

## 13c. Design interview, round three (2026-08-13)

Three rulings. One changed the capacity model, one deleted a planned feature, and one corrected a
premise the research had wrong.

### The tab budget is one total, not one per browser

**Settled: a single counter across both browsers, default 15.** Reasoning and the rejected
alternative are in §6. The short version: the scarce thing is renderer processes, a renderer costs
the same in either browser, and two budgets can each be exhausted while the machine is idle.

**Consequence for the work queue:** the capacity pull request builds one admission predicate over one
counter, not a per-browser allowance table.

### The isolated third browser is dropped, not deferred

**Settled: exactly two browsers, no exceptions, ever.** Reasoning in §6, including the plain
statement of what it costs — two independent authenticated sessions cannot run in parallel through
this service, and the answer is to run them sequentially.

Worth recording *why this is a better outcome than deferring it*, because "we'll add it if anyone
asks" sounds like the safe option and is not. A deferred exception still shapes the design: every
capacity decision has to leave room for it, every count is really a count-plus-maybe-one, and the
first time anything is tight somebody argues the exception is the fix. Dropping it outright makes the
bound a fact rather than a default.

### The unmanaged browser: the premise was wrong, and the correction is better

The research framed the browser outside the service as *the owner's own everyday browser*, and built
a guard-and-exception story around not touching it. **That premise was wrong.** What actually sits
outside is a **default browser profile used by automation that is not part of this system**, and the
ruling is not "guard it" but *"leave it alone entirely — the service runs its own two"*.

The requirement attached to it is the valuable part, and it is **bidirectional**: the service must
neither disturb what is outside it nor be blocked by it. That is written up as a first-class property
in **§6a**, because it is a cleaner boundary than a list of prohibitions and — the reason it earns
its own section — it is **testable**, which a list of prohibitions is not.

The concrete thing this changes: an explicit profile directory stops being a sensible precaution
against an unverified quirk and becomes a **hard requirement**, because a default path is the most
ordinary way for something outside the service to stop it starting.

### Capture policy: the shape, without the numbers

**Settled in shape:** low resolution **by default, with no parameter required to get it**; higher
resolution by **explicit opt-in**; and a **strong warning rather than a refusal** once a lease has
taken a lot of captures.

Each half of that is a decision. Low-by-default with nothing to pass means the cheap path is the path
of least effort, which is the only version of a default that actually holds. Opt-in for the expensive
path means the cost is a decision somebody made rather than something that happened to them. And a
warning rather than a refusal because a refusal mid-review strands work that is already half-done —
the goal is to change what the next capture looks like, not to destroy the run. A warning that names
the cheaper alternative does that; a bare refusal teaches a caller to ask for a bigger budget.

**The numbers are still open** (§14).

---

## 13d. Capture policy, settled (2026-08-13)

**This reverses the research recommendation**, which was a hard service-enforced ceiling with a
refusal past a per-lease budget. What ships instead is a low default, an explicit opt-in to go
higher, and a warning that never becomes a wall.

### The tiers

**Provisional defaults** — reasoned to, not measured, and the resolution-ladder study (`MILESTONES.md`
#34) exists to settle them with evidence. The documents say "provisional" everywhere on purpose,
because a number presented as settled fact stops being questioned.

| Tier | Long edge | How a caller gets it |
|---|---|---|
| default | 1024 px | **passes nothing** |
| `detail` | 1568 px | asks for it — the ceiling of the cheap vision tier |
| `max` | 2576 px | asks for it **and gives a mandatory `reason`**, which is recorded |

Full-page capture is off by default: unbounded page height crosses the long edge far more often than
width does, and a full-page capture of a long page is the worst offender there is.

### Why a default beats a ceiling

**1. Defaults are a stronger lever than refusals.** Most callers never pass an optional parameter, so
a low default does nearly all of the work of a ceiling without blocking anyone. And it removes the
one failure mode that would genuinely kill this service: an agent stopped mid-run on a legitimate job
concludes the service is an obstacle and starts looking for a way around it. A service that is
occasionally expensive survives that; a service that is occasionally *unusable* does not.

**2. An opt-in teaches something a refusal cannot.** Escalating to a higher tier is a deliberate act
that lands in telemetry with its reason attached, so what accumulates is *who* escalates and *why* —
which is precisely the data needed to tune the default. A refusal produces one fact: somebody hit a
wall. It cannot distinguish a caller who needed the pixels from a caller who was being careless, and
those want opposite responses.

**3. The cheap path and the correct path coincide, and that is designed rather than lucky.** Text
legibility breaks at a **higher** resolution than layout critique does — spacing, alignment and
rhythm are judgeable on an image far too coarse to read the labels on. So a low default naturally
pushes a caller that needs to *read* something toward the snapshot or the evaluate, which return text
and cost almost nothing. The policy does not have to argue anyone into the cheaper tool; the default
makes the expensive tool bad at the job the cheaper one is good at. **State it as a property, because
a property survives someone raising the default and a coincidence does not.**

### What is still enforced

The default, the opt-in and the mandatory reason are all service-side, because the service takes the
capture. What is given up is only the *refusal* — and giving that up is the point, not a concession.

---

## 14. Still open

1. **The partial-index question in §13b** — a hand-written migration with a documented drift-check
   exception, or serialised application-level enforcement. Owned by the pull request that lands the
   constraint, decided with the transaction shape in front of it.
2. **The licence.** Deliberately not chosen here, because it is the owner's to choose and not a
   detail a build decides by default. It has to be settled **before** the repository is published:
   a public repository with no `LICENSE` file grants no rights to anyone who reads it, which is
   almost never what publishing was for. Blocks `MILESTONES.md` #2.
