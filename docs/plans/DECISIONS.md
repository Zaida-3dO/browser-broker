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

> **Principle upheld 2026-08-24 (§13f); its example is gone.** The rule — a destructive operation
> keeps its own name and is never folded under an action parameter — is unchanged and still binds
> every operation on the surface. **The tab-close tool it names is deleted**, because with a lease
> fixed at one tab (§13e) closing your tab left you holding a lease that owned nothing, and §13f
> removes the state rather than guarding it. Release is the verb that ends a lease. Read this
> paragraph for the rule, not for the tool.

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

> **Simplified 2026-08-18 (§13e): `requested` is always 1.** The single-counter decision is
> upheld — the argument below about renderers being the scarce thing is untouched — but the
> per-claim tab allowance is **deleted rather than re-tuned**, so a grant is exactly one tab and a
> caller wanting two claims twice. The predicate collapses to `live claims + 1 ≤ budget`, and the
> budget, the pool bound and the count of live claims become **the same integer**. The keeper tab
> (§13e) is never counted against it.

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
so the outage is self-limiting, and state reconciles on the next call rather than needing anything
to have stayed running — §13e makes that reconciliation the first thing every call does.

**Sharpened 2026-08-18 (§13e), and this section is strengthened rather than overturned.** Everything
above holds, and holds harder: with the service spawned per session, there is not even a process
that *could* have been put on another host. One machine stops being a choice made for simplicity
and becomes the only topology the deployment model admits. What changes underneath is the store —
SQLite in a file rather than a database server — and the reason is the same one this section gives:
a lease is a ten-minute fact whose entire value is a browser on that same host.

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
| **A stdio server is spawned per connecting session; an HTTP server is not** | **Still true as a fact; its conclusion is overturned — see §13e.** It was read as the structural reason to keep a listening process, on the assumption that per-session spawning was the thing to design away from. §13e takes the opposite lesson: per-session spawning is the deployment model, and the cross-caller ownership check is made meaningful by the *shared store* rather than by a shared process |
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

> **Mechanism upheld, durations reopened 2026-08-18 (§13e).** *Keep pinging or lose it* is
> unchanged and is now the mechanism reclamation rests on. The **numbers** are reopened: the
> reasoning above prices an expired queued client at *a place it can retake by asking again*,
> which was true of a queue that could be re-entered cheaply. Under strict first-in-first-out
> ordering, losing a place means losing everything ahead of it. §13e also records the structural
> asymmetry the original pair missed — a holder renews on its own work, a waiter has no work to
> renew from — and rules that **queued must not default to the same value as active.** Listed in
> §14.
>
> **Settled 2026-08-24 (§13f), and both numbers above are overturned: ten minutes each,
> deliberately equal.** The differentiated pair is gone and so is the asymmetry argument that
> replaced its reasoning. A queued caller polls, **and polling is renewing** — the status call
> already renews, so a waiter has exactly the same means of holding its place that a holder has.
> The cost also runs opposite to the direction both earlier arguments assumed: under strict
> first-in-first-out a queue place held longer **blocks everyone behind it**, so a longer queued
> lifetime is worse rather than kinder. §13f also adds the two things that make equality safe: the
> release verb releases a queue place as well as a lease, and the queued response carries an
> explicit scheduling nudge.

### No profiles table

Confirmed as written. One persistent browser holds many sign-ins simultaneously, so a purpose-named
profile is a purpose-named **tab**. Reasoning and the rejected alternative are in §6. The concrete
consequence for the next document: `SCHEMA.md` has a fixed two-row browsers table and **no profiles
table, no profile registry and no named-profile concept**.

### Pixel diffing belongs in this service — reversing the research recommendation

> **Conclusion upheld, mechanism overturned 2026-08-24 (§13f).** Diffing belongs in this service
> — that half is untouched, and the argument for it below is the argument §13f still runs on.
> **What fails is the premise underneath it: that a baseline is pool state.** §13f deletes the
> baseline concept outright. There is no canonical picture per view; every capture is a capture
> with an identifier, and a diff is an explicit request naming which earlier capture to compare
> against, carried as an optional argument on the capture tool rather than as an operation of its
> own. So *"baselines are pool state"* stops being the reason, and the reason that survives is the
> sentence after it — this service holds the browser and takes every capture, so it is the only
> thing with both images to hand. Two specific consequences: the baselines store below is deleted,
> and the **generated-baseline-name question is moot** rather than answered, because it existed
> only to give a lineage-bearing baseline a stable name.

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

### Stack: Node, TypeScript, Prisma, Postgres — **overturned 2026-08-18**

> **Overturned in §13e (2026-08-18).** The database and the storage access layer are both
> reversed: **SQLite in a single file, reached with raw SQL over the synchronous driver.** The
> premise below — *"a long-lived process"* — is the thing that stopped being true, and
> Postgres was chosen because of it. The rest of the row survives: Node, TypeScript, and a
> driver that shells out to a binary distributed for this ecosystem are unchanged. **The
> partial-index constraint recorded below is settled too** — §13e records it as verified
> working, and the two unfree answers it offers are both unnecessary. Read this subsection
> as the reasoning that was correct for a server, and §13e for why the shape changed.

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

> **Solved 2026-08-18 — see §13e.** All three indexes were measured working on the engine that
> ships, and with raw SQL the constraint is expressed directly, so neither of the two answers
> above is needed: no drift-check exception, and no application-level enforcement. The
> limitation named here stopped being a cost to be managed and became **a reason for the
> storage decision itself.**

### Everything on one host, including the database

A further change, and **not** the research recommendation, which had kept the durable state on a
separate always-on box. Reasoning and the trade are in §8: one machine, no network dependency, and
lease state that lives and dies with the host.

Worth being explicit that a real property is being surrendered rather than optimised away. The
argument that wins is that a lease is a short-lived fact whose entire value is a browser that is also
on that host, so surviving the host buys an accurate record of leases over browsers that went down
with it. The driver interface remains, and after this decision it is **the only thing** preserving
the option of ever splitting them.

### The visual surface is one read-only page, and no framework behind it — **premise changed 2026-08-18; reopened**

> **Reopened in §13e (2026-08-18), not decided against.** Every option weighed below — the
> chosen one included — assumes a process that is always listening: a static file has to be
> *served* by something, and the JSON endpoint it fetches has to be *answered* by something.
> With the service spawned per session and gone when that session ends, there is nothing
> holding a socket open for a browser to point at. **No answer is invented here.** The
> reasoning below stays on the record because the test it applies — *what does this buy a page
> that displays six numbers?* — outlives the transport, and whatever answers the question next
> should have to pass the same test. Listed as open in §14.
>
> **Closed 2026-08-24 (§13f): nothing is served at all.** The operations view is a **generated
> self-contained HTML file** — styling and behaviour inlined, produced by a command, opened from
> disk by a person. No server, no port, nothing left running once the command exits. It is a
> **snapshot, labelled as one**, and it does not refresh. So the choice below is overturned in
> both halves — there is no static file being served and no JSON endpoint being fetched — while
> the test it applied is what selected the answer: a page displaying six numbers buys nothing from
> a transport, so it gets none. Two things go with it: the **settings-write endpoint is deleted**
> (§13f deletes the settings table it wrote to) and the **health endpoint is deleted** as an
> artefact of a process that stays up, its job already done in the right shape by the doctor
> command. It also **moots the unauthenticated-off-machine question** entirely, since every option
> there concerned binding a served surface to an address.

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

> **Simplified further 2026-08-18 (§13e).** The ruling here stands. What changed is the predicate
> it produces: with a grant fixed at one tab, the admission test is `live claims + 1 ≤ budget`,
> and there is no requested-count term in it at all.

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

**Measured defaults.** These were reasoned to rather than measured, and the resolution-ladder study
(`MILESTONES.md` #34) has since settled them with evidence — **it kept all three unchanged.** The
property they rest on held: a downscale destroys a feature once its period falls below roughly two
and a half *destination* pixels, so layout-scale features survive the whole ladder while fine text
detail does not. Evidence and the per-rung table are in `src/capture/tiers.ts`.

What the study did **not** settle is the absolute legibility floor — what a reader can actually read
— because the instruments measure what the pipeline destroys, which bounds that question without
answering it. That much is still open and is still labelled so, on the same principle that kept these
numbers labelled before: a number presented as settled fact stops being questioned.

| Tier | Long edge | How a caller gets it | What #34 measured it delivering |
|---|---|---|---|
| default | 1024 px | **passes nothing** | layout and headings intact; small body copy damaged |
| `detail` | 1568 px | asks for it — the ceiling of the cheap vision tier | ordinary body copy recovered |
| `max` | 2576 px | asks for it **and gives a mandatory `reason`**, which is recorded | everything, at every font size tested |

> **Extended 2026-08-24 (§13f), not overturned: the reason is free text.** The tiers, the default
> and the mandatory reason all stand. What §13f settles is the reason's *shape* — prose the caller
> writes, never a choice from a fixed set — and it adds a second obligation on the response: when
> a caller lands on the default tier, the service tells it **how** to escalate, including that
> escalation costs a written reason.

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

## 13e. Design round four — the service stops being a server (2026-08-18)

The largest round so far, and the one that moves the most already-written text. A single ruling —
**the service does not run as a long-lived process** — pulls the ground out from under several
decisions that were correct given a server and are wrong without one. Everything here is settled;
what remains genuinely undecided is listed in §14 rather than hedged in place.

Two conventions for reading this section. **Where a decision below overturns one above, the earlier
one keeps its text and gains a dated banner** — the reasoning that was right at the time is worth
more than a tidy document, and a decision quietly deleted is a decision that gets proposed again.
And **every number here was measured.** Where something was reasoned to rather than measured, it says
so; nothing unverified is written as fact.

### The service is spawned by its caller and dies with the session

**Settled: no long-running process.** The service installs and runs the way a per-session tool does
— the client starts it, it serves that session, and it exits when the session ends. **There is no
daemon to install, no service to configure, and nothing to monitor for having stopped.**

The property this buys is that **installation is the whole of deployment.** There is no second
lifecycle to get wrong: no start-on-boot, no restart-on-crash, no supervisor, no port to keep free,
no version of the service running that differs from the version that was installed, and no class of
failure that consists of the process being dead while everything depending on it assumes otherwise.
For a tool meant to be picked up and used, that removes the entire category of setup that makes
people not bother.

**What it costs is stated rather than discovered, because it is the source of most of this
section.** With no process that outlives a session:

- **Nothing can happen on a timer.** No sweeper, no expiry loop, no background reconciliation.
  Everything that has to happen eventually has to happen *on a call* — see the reclamation ruling
  below.
- **There is no shared memory between callers**, so every fact two callers must agree on lives in
  the store, and the store is the only synchronisation primitive there is. Concurrency is therefore
  **between operating-system processes**, not between connections inside one.
- **Per-process startup cost is paid on every call rather than once.** A cost that rounds to nothing
  in a server is paid every time here, which is what decides the storage layer below.
- **Nothing is listening**, so anything that assumed a socket — an operations page, a JSON endpoint
  a second system could poll — has lost its premise.

**Rejected: keeping a small resident helper "just for the timer".** It reintroduces exactly the
lifecycle the ruling removes, and it does so for the one responsibility that turns out not to need
it: lazy reclamation is not a workaround for a missing timer, it is a better model than the timer
was, because it makes the store's state provisional by design rather than accidentally stale between
sweeps.

### State is SQLite in a single file, and its location is an environment variable only

> **Extended 2026-08-24 (§13f), not overturned — the rule below generalises to every setting.**
> The store's location keeps its environment-variable-only ruling, and gains company: **there is
> no settings table at all**, and every configurable value is an environment variable with a
> working default. The argument below — *a value that configures where the store lives cannot
> live in the store* — was the narrow case of a wider one, and §13f records the wider one.

**Settled: SQLite, one file.** The default location is **the operating system's application-data
directory, resolved per platform.** No path is written into this repository — the location is
resolved at runtime and documented as a key, never as a value.

**It is overridable by environment variable, and by nothing else.** Specifically **not** by a setting
stored in the database, and the reason is worth keeping because it generalises: **a value that
configures where the store lives cannot live in the store.** A bad value there breaks the very
surface you would have to reach to correct it, and the failure presents as the store being missing
rather than as a setting being wrong. Configuration that determines reachability is bootstrap
configuration, and bootstrap configuration comes from the environment.

**Hard refusal at startup: a network path is not a valid location.** If the resolved path is a UNC
path or sits on a mapped network drive, the service **refuses to start**, with the reason. This is a
refusal rather than a warning, and §13d's preference for warnings over refusals does not reach it —
that preference is about a caller mid-run whose work a refusal would strand, whereas this fires
before there is any work to strand, and what it prevents is not an expensive result but a **silently
corrupt** one.

The reason it is hard: **the write-ahead log does not function on a network filesystem.** Its
shared-memory index requires every process touching the database to be on the same host, which a
network share is precisely not (sqlite.org/wal.html). And this design has *many* processes touching
one file by construction, so the single condition the mechanism requires is the one thing the
topology cannot promise. A warning would be read, dismissed, and followed by intermittent corruption
that looks like anything but its cause.

**Detection needs two checks, and the second is the one that gets forgotten.** Resolve the path
first — the resolution is what makes the rest meaningful — then:

1. **Check for a UNC root**, remembering that the forward-slash spelling normalises to the same
   thing, so matching one spelling catches half the cases.
2. **Check that the drive type is not a network drive.** This one cannot be skipped, because **a
   mapped drive is lexically identical to a local one.** No amount of string inspection distinguishes
   them; it takes asking the operating system what the drive actually is.

A check that does only the first is the worst of both worlds: it looks like a guard, and it passes
the most ordinary way there is of getting this wrong.

### The storage access layer is raw SQL over the synchronous driver, not the ORM

**Settled, and it overturns §13b.** The measurements, all taken rather than cited:

| | Raw SQL over the synchronous driver | The ORM |
|---|---|---|
| Process startup | **28 ms** | 126 ms |
| First query | **0.04 ms** | ~35 ms |
| Install weight | **27 MB, 1 package** | 325 MB, 129 packages |

**The ~35 ms is the number that decides it**, and it decides it only because of the ruling above.
That figure is per-process initialisation — in a long-lived server it is paid once at boot and is
invisible forever after, which is exactly why §13b was right to disregard it. **Spawned per session,
it is paid on every spawn**, against a first query costing 0.04 ms the other way. A fixed cost
becomes a per-call cost when the process becomes per-call; that is the whole argument, and it is a
consequence of the deployment model rather than a complaint about the ORM.

**Correcting a wrong reason explicitly, because dropping it quietly would leave it available to be
re-argued.** An earlier reading rejected the ORM for shipping a heavy native query engine. **That
reasoning is wrong and must not be repeated.** The ORM's current major version has **no query engine
for SQLite at all** — it uses driver adapters, and its SQLite adapter **depends on the same
synchronous driver** chosen here. It is a layer sitting on top of the accepted dependency, not an
alternative to it, so **the native-module rebuild risk is taken either way** and cannot be scored
against one side. The decision has to stand on the reasons that survive that correction, and it does:

1. **The measured startup cost, paid per spawn** — above.
2. **Install weight for a public repository.** 325 MB and 129 packages against 27 MB and one is a
   real difference to anyone cloning this to try it, and it is 129 more things to have an opinion
   about in a dependency audit.
3. **The partial-index limitation §13b already conceded** — which is **decisive now rather than a
   known constraint**, because partial unique indexes turn out to be this schema's most important
   guarantee. A limitation you route around is a cost; a limitation in the exact mechanism your
   correctness rests on is a disqualification.

**What the ORM genuinely won, recorded so the trade is honest: migrations.** That was a real
advantage and it is given up deliberately. In its place: **a schema-version stepper that self-heals
on every spawn** — the service checks the schema version as it starts and steps it forward if it is
behind. That fits the deployment model better than a migration command does, because there is no
deploy step to hang a migration off and no operator moment at which to run one. Every spawn is the
deploy.

### The partial-index question is resolved, and it was the good outcome

**Measured working on SQLite 3.53.4:** two partial **unique** indexes, plus one partial
**non-unique** index that makes the capacity count a true **index-only (covering index) scan**. Not
reasoned to, not read in documentation — run.

> **Count corrected 2026-08-24 (§13f): three measured indexes became two.** The third belonged to
> the baselines store, and §13f deletes the baseline concept, so it has nothing left to index. The
> measurement was sound and the two that remain are the two the correctness argument actually
> rests on — one live claim per session, one active lease per tab — but **the evidence for the
> storage decision is genuinely thinner than it reads below**, and thinning it quietly by editing
> a number would be the exact dishonesty this document exists to prevent. What is untouched:
> the measured startup cost (**28 ms against 126 ms**), the install weight (**27 MB and 1 package
> against 325 MB and 129**), and the self-healing schema stepper. The decision stands on those,
> **weakened by one index rather than broken.**

**Double-issue is structurally impossible across processes.** Two processes racing to claim the same
thing do not both succeed: the engine returns a **uniqueness-constraint error** to one of them rather
than accepting two claims. The guarantee sits in the storage engine, which is the only place a
guarantee survives a caller doing something nobody anticipated.

This closes §13b's open question by removing it rather than by answering it. §13b offered two unfree
answers — a hand-written migration with a permanent exception in the drift check, or
application-level enforcement that is not race-proof without a serialised transaction or an advisory
lock. **With raw SQL the constraint is expressed directly, so neither compromise is bought.** Worth
noticing as a pattern: the option that looked like more work at the schema layer removed a compromise
at two other layers.

### Concurrency is between processes, and the transaction mode is load-bearing

**Measured: 30 concurrent operating-system processes, each taking an IMMEDIATE transaction, all
succeed** — the counter increments cleanly, with no repeats and no lost writes.

**The same test with a DEFERRED transaction and a widened read-then-write window fails 15 times out
of 25**, with a busy-snapshot error that **the busy-timeout setting cannot retry.** That last clause
is the important one: the usual reflex for a contention error is to raise the timeout, and here the
timeout does not apply — the transaction is holding a read snapshot it has lost the right to
upgrade, so there is nothing to wait for.

**The trap is that deferred passes at low contention.** It is not subtly wrong in a way a test
catches; it is *correct* until enough callers arrive at once, which is exactly the condition a test
suite does not reproduce and a real machine does. And the shape of this application's hot path —
**sweep, then count, then insert** — is a wide read-then-write window **by construction**, not by
carelessness. The mode is therefore not a tuning choice; it is part of the correctness argument.

#### Standing invariant: the guarantee is writer serialisation, not serialisability

**Record this as an invariant, not a note.** What the immediate transaction buys is that **writers
are serialised.** It is *not* full serialisability, and the difference stays invisible only while one
condition holds:

> **Every arbitration path writes.**

That is the whole load-bearing premise. Because every path takes a write lock — the reclamation
ruling below guarantees it, since every call expires whatever has lapsed — every path is serialised
against every other, and the weaker guarantee is indistinguishable from the stronger one.

**A future read-only fast path would silently reopen the hole.** The tempting version is obvious and
will be proposed: *"checking status does not need to sweep, so let it skip the transaction."* Such a
path takes a read snapshot without a write lock, and the guarantee stops covering it — **and it will
pass a low-contention test suite**, because that is precisely what the deferred measurement above
demonstrates. Anything added to the arbitration surface must either write, or be argued against this
paragraph explicitly.

### Reclamation is lazy and global, and derived state is the truth

With nothing running on a timer, **nothing expires by itself.** So: **any arbitration call first
expires every lapsed claim and every lapsed queue entry across the whole store** — everything whose
`last_seen + ttl` has already elapsed, not merely the rows the caller asked about — **in the
same transaction**, and only then answers from the reconciled state.

**Global, not scoped to the caller**, because a caller asking about its own lease is often the only
call that will arrive for a while, and capacity held by something that died must come back on the
next call from *anyone*. Scoping the sweep to the asking caller would leave a machine's capacity
pinned by a process nobody is ever going to ask about again.

**Same transaction, not before it**, because a reconciliation whose result is read by a separate
statement is a race against every other process doing the same reconciliation.

#### Standing rule: stored state is provisional; derived state is the truth

The rows in the store are **a record of what was last written, not a statement of what is true.** A
claim row with a lapsed timestamp is not a lease; it is a lease-shaped row awaiting its next reader.
The truth is what falls out of applying expiry to the record.

**Every reader that touches the store directly must apply the same expiry derivation** — an
operations view, a health check, a diagnostic command, anything at all. A reader that skips it does
not merely lag: it **reports leases that do not exist**, which is the most misleading failure
available, because it looks like the arbitration being wrong rather than the report being wrong. If a
reader cannot apply the derivation, it must not read the store.

### Hard rule: never do browser input or output inside the arbitration transaction

**Settled, and it is a hard rule rather than a guideline.** Expiring a claim implies closing its tab,
and closing a tab is **a round trip to a browser process that can hang** — a wedged browser does not
refuse, it simply does not answer.

If that round trip happened inside the arbitration transaction, **one unresponsive browser would
block every arbitration call on the machine.** Not degrade: block. Every caller, including every one
with no interest in that browser, because they all need the same write lock and the transaction
holding it is waiting on a process that is never going to reply. A single wedged tab would become a
total outage, and the failure would look like the service being broken rather than a browser being
stuck.

So the order is fixed: **the transaction reclaims capacity; tab cleanup happens after commit, on a
best-effort basis.** The consequence is worth stating in the form that makes it acceptable:

> **A tab that fails to close is a leaked tab, not a leaked lease.**

The capacity is already back — the transaction did that, and it committed. What is left behind is a
window nobody owns, which is untidy and recoverable by hand. That is a strictly better failure than a
lease nobody can reclaim, and the asymmetry is the entire justification for accepting best-effort
cleanup.

### Browsers are adopted, not owned

**The ceiling stands: exactly two browsers (§6), and no exceptions.** What changes is **who owns
them**, and it changes because a process that dies with its session cannot own anything that has to
outlive it.

**Settled: browsers are launched on demand by whichever caller finds none running, and attached to
by everyone afterwards.** The first caller to need a browser starts it; every caller after that
attaches to what is already there. There is no designated owner, because there is no process durable
enough to be one.

**Cold start must spawn the browser binary detached, rather than through the automation library's
launcher.** This is not a preference — it is measured behaviour: **the owning-launch call kills the
browser when its client closes**, whereas the attach call does not own what it attaches to. Launched
through the library, the browser would die with the very session that started it, which is the one
thing it must not do.

**Measured, on a live run:** a browser spawned detached in this way **survived its launching process
being killed uncleanly**, stayed healthy, and remained attachable over the debugging protocol for
roughly **90 minutes**, with its pages intact. **Attach and detach cycles are non-destructive** to
tabs, cookies and local storage — also measured, and it is the property that makes serial attachment
by unrelated processes safe at all.

**The consequence is the part that changes other decisions: profile identity moves to disk.** The
persistent browser cannot be defined as *the process this service launched*, because no process here
is durable enough to have launched it. It is defined as **whatever is running against this profile
directory.** Identity is a path, not a process handle.

That makes **an explicit profile directory mandatory, and for a second independent reason.** §6a
required it so that nothing outside could block the service by holding the default profile; that
reasoning stands untouched. This adds to it: **without an explicit path there is no stable identity
to attach to**, and the whole adoption model has nothing to name. Two separate arguments now converge
on the same requirement, which is the strongest position a requirement can be in.

### A profile collision fails silently, so the launch needs a positive assertion

**Measured, and it is worse than a bad error message.** A second browser launched against a profile
directory already in use **does not report a lock error.** It hands its URL to the browser already
holding the profile and **exits successfully** — exit code zero, nothing on the error stream, and
**no debugging endpoint opened**. A launcher waiting on its own endpoint therefore waits for
something that will never appear, and times out with nothing anywhere explaining why.

**And the obvious cross-platform check does not work.** The single-instance lock file that a POSIX
system leaves in the profile directory **does not exist on Windows**, so a check looking for it does
not report "no lock" there — it **always passes**, on every platform where that file is simply not
the mechanism. A guard that cannot fail on one platform is worse than no guard, because it is trusted
equally on both.

**So an explicit profile path is necessary but not self-verifying.** The rule that falls out:

> **Never infer that a launch worked. Assert positively that a debugging endpoint was obtained.**

Success is *having the endpoint, and having it answer*. It is not *the launch command returning
zero* — which is the one signal a caller is most likely to trust, and the one measured to be actively
misleading.

### Discovery: an ephemeral port the browser records itself, matched by identity

**Settled: ask the browser to take an ephemeral port, and read back the port it chose from the file
it writes inside the profile directory.** Not a fixed port, and not a port this service picks.

Two reasons, and the second would not have been obvious in advance:

1. **A fixed port collides with whatever else on the host happened to want it**, which is the inward
   half of §6a's isolation arriving through the most ordinary door there is. An ephemeral port cannot
   collide with anything, because nothing else was promised it.
2. **The record lives inside the profile directory, so it cannot drift from the identity it
   describes.** Since profile identity is a path (above), keeping the endpoint record beside the
   profile puts the answer to *"what is running against this profile?"* in the one place that cannot
   get out of step with the question. A registry kept anywhere else is a second source of truth about
   the same fact.

**Measured, and it changes how the file must be read: the file survives a hard kill.** After the
browser was killed outright, the file remained, naming a port that answered nothing. So:

> **The record is a claim, not proof.**

A caller must **verify liveness before trusting it**, and must **match the recorded browser
identifier, not merely the port.** Matching on the port alone is unsound because ports are reused: a
stale file plus an unrelated process that happened to be given the same port reads as a successful
match, and the service would attach to something it has no business touching — the exact outward
violation §6a forbids. The identifier is what makes a match mean *this browser* rather than *this
port number*.

### A grant is one tab

**Settled, and the per-claim tab allowance is deleted rather than re-tuned.** Capacity, grants and
tabs collapse into **one integer**:

> **pool bound = tab budget = count of live claims.**

A claim is for exactly one tab. **Need two tabs, claim twice.**

**What this buys is that release becomes unambiguous** — one lease, one tab, one close — and **the
reservation arithmetic disappears entirely.** There is no partial release, no question of what a
lease still holds after a caller closed some of its tabs, no admission predicate summing a requested
count against a budget, and no way for the number of leases and the number of open windows to
diverge. Three quantities that had to be kept consistent with one another become one quantity that
cannot disagree with itself.

**Default guidance, to be encoded in the tool descriptions rather than left as folklore:** *work in
your own single tab and navigate it between URLs; parallel tabs are for genuine concurrency only.*
The cheap path and the correct path coincide again — a caller doing ordinary sequential work needs
exactly one claim and never touches the queue.

**Open, and deliberately not solved here:** a caller that claims several tabs can **hold and wait,
and deadlock against another doing the same** — two callers each holding one tab, each waiting on a
second that the other holds. It needs either **all-or-nothing admission** for a multi-tab request, or
**a specified acquire-everything-before-working protocol, with release-all on failure.** Both are
real designs, and neither should be picked without the transaction shape in front of it. Listed in
§14.

### The queue is strict first-in-first-out, and queue entries expire

**Settled: strict first-in-first-out, with no aging and no priority.**

**It is close to trivially correct, and that is a consequence of the ruling above rather than a claim
about queues in general.** Because **every request is the same size — one tab — there is no large
request for a small one to skip ahead of.** Head-of-line blocking has nothing to block on: the entry
at the head needs exactly what the entry behind it needs. Aging exists to stop a big request starving
behind a stream of small ones, and where there is one size there is no such thing as a big request,
so aging solves a problem that cannot occur. Uniform request size is what makes the simplest possible
queue also the correct one.

**Queue entries expire by the same lazy sweep as leases, and this is load-bearing rather than
hygiene.** A caller that dies while queued holds a place and consumes nothing, so nothing else
notices it is gone — and **it blocks everyone behind it indefinitely** under strict ordering. A
strict queue without entry expiry is a queue with a permanent head. Expiry is what makes strictness
safe.

**The consequence must be explicit in the response to a queued caller**, and this is a contract
detail rather than a nicety: **keep asking, or lose your place.** A caller that does not know this
drops to the back for reasons it cannot see — and, the part that matters, **it cannot distinguish
that from the queue being broken.** From the inside, "I was ordered fairly and my entry lapsed" and
"this service is not serving me" look identical. Anything the service knows that a caller needs in
order to interpret its own experience belongs in the response.

**Flagged for design (§14): the queue-entry lifetime should probably be more generous than the lease
lifetime, and the two must not default to the same value.** The asymmetry is structural rather than a
matter of taste. **A lease renews on every call because its holder is working** — it is doing things,
and each thing is a renewal. **A queued caller is by definition only waiting**, so its sole means of
renewal is asking again about nothing having changed, and it has no work generating those calls
naturally. Giving the two the same duration demands the same attentiveness from a waiting caller as
from a working one, while giving it far less to be attentive with. §13a set active at 10 minutes and
queued at 5, reasoning that expiring a queued caller is cheap because it can retake its place by
asking again; that reasoning was sound where a place was freely retakable, and is worth re-deriving
now that strict ordering means losing a place means losing everything ahead of it.

> **Overturned 2026-08-24 (§13f): both lifetimes are ten minutes, deliberately equal.** The
> paragraph above is wrong in its load-bearing clause. *"A queued caller has no work to renew
> from"* is false — **a queued caller polls, and polling is renewing**: the status call renews,
> and asking about nothing having changed is precisely the work a waiter has. The direction of the
> cost was inverted too. Under strict first-in-first-out a queue place held longer **blocks every
> entry behind it**, so a more generous queued lifetime is the harsher setting rather than the
> kinder one, and the sentence flagging it for design was arguing for the wrong end. §13f settles
> the number at ten and adds the two things equality needs: **release must release a queue place**
> — a queued caller changing its mind otherwise has no exit — and the queued response must carry a
> **scheduling nudge** naming when to check back.

### The keeper tab is structural, and the test asserting it must run headed

**Settled: one blank, never-leased tab stays open at all times, and is never counted against the
budget.**

**It was carried as belt-and-braces and turned out to be load-bearing.** Measured: **headless,
closing the final tab leaves the browser process alive**; **headed, the browser dies within 500 ms.**

The persistent, signed-in browser is headed. So without a keeper tab, **the last caller to release
its lease destroys the shared authenticated session** — not through any destructive operation, but
through the single most ordinary and most correct thing a caller ever does. §5 removes every
browser-scoped destructive operation from the surface precisely so no caller can end another
caller's work; releasing the final tab would walk through that guarantee by the front door. **A
shared authenticated profile must not be destroyable by any single client's action** — and without
the keeper tab, releasing correctly *is* that action.

**Record the testing hazard, because it is how this gets deleted later.** **A headless test suite
would find the keeper tab redundant.** Every test would pass without it — the behaviour it protects
against does not occur headless — so a future cleanup pass would read it as dead weight, remove it,
and get a green run confirming the removal. Therefore:

> **The test asserting the keeper tab must run headed, and must say in a comment why it runs headed.**

Both halves are required. Running headed is what makes the test capable of failing; the comment is
what stops someone converting it to headless for speed and being rewarded with a green tick. This is
§5's rule about rejection tests asserting the physical side-effect, in a second setting: a test that
cannot fail on the thing it names is a comment with a runtime cost.

### Licence: MIT

**Settled: MIT**, closing §14's second open item. **A real `LICENSE` file is required** — the
decision is not made by writing it in a document, and a public repository without the file grants no
rights to anyone who reads it, which is almost never what publishing was for.

MIT is the permissive default for a tool meant to be picked up, used and vendored without anyone
having to read a lawyer's opinion first. Nothing about this project argues for a copyleft obligation:
it is a small arbitration service, not a platform whose value depends on downstream improvements
coming back.

---

## 13f. Design round five — nine open questions closed, and three concepts deleted (2026-08-24)

Every question §14 carried is answered here, and the answers were mostly **deletions**. Three
concepts leave the design outright — the baseline, the settings table, and the served page — and in
each case what remains is smaller than what the open question was asking to specify. That pattern is
worth naming before the rulings, because it recurs: **several of these questions were hard only
because the thing they were about did not need to exist.**

The two reading conventions from §13e carry forward unchanged. **A decision here that overturns one
above leaves the earlier text in place and adds a dated banner**, because reasoning that was correct
at the time is worth more than a tidy document and a decision quietly deleted is a decision that
gets proposed again. And **every number here was measured**; where something was reasoned to rather
than measured it says so, and one ruling below is explicitly marked unverified.

One round-level correction is recorded before anything else, because it changes how much weight the
rest of the round can carry.

### Method: a scan window of 20–40 sessions would have produced a confidently wrong answer

The tool-surface rulings below rest on counting what callers actually did. The first attempt at that
count sampled **20–40 recent session transcripts and found zero browser-automation calls** — a
result that reads as a clean finding and would have justified building nothing. It was wrong.

The real figure came from scanning **all 2,007 transcripts**, and the reason the sample missed is
structural rather than bad luck: **88% of the sessions that used browser automation were subagents
rather than top-level sessions.** A recency window over top-level sessions is sampling the wrong
population, and it cannot tell that from an empty one — zero calls found and zero calls made look
identical from inside the sample.

> **A sample that returns zero is not evidence of absence until the sampling frame has been
> checked against the population it claims to represent.**

Two rulings below exist only because the full scan was run. Neither would have been proposed on the
sample.

### The baseline concept is deleted; a diff names its own comparison target

**Settled: there is no canonical picture per view, and no blessed capture.** Every capture is a
capture with an identifier. **A diff is an explicit request naming which earlier capture to compare
against**, and it is carried as an **optional argument on the capture tool** rather than as a tool
of its own.

What this deletes is the whole apparatus a baseline needs: the store keyed by view and breakpoint,
the promotion step that decides which capture becomes the blessed one, the lineage that makes a
baseline the descendant of an earlier baseline, and the question of what a caller means by "the"
baseline for a view it has captured at three widths.

**§13a's conclusion survives; only its mechanism fails.** Diffing still belongs in this service, and
for the reason §13a gave second rather than first: this service holds the browser and takes every
capture, so it is the only thing with both images to hand. §13a's *leading* reason — *baselines are
pool state* — is the one that goes, because there are no baselines to be state. The banner on §13a
says so precisely rather than implying the whole subsection fell.

**It also moots the generated-baseline-name question rather than answering it.** That question —
lineage recorded in the store, name derived from it — existed only because a baseline had ancestry
worth naming. A capture identifier has no lineage to encode.

**And it costs the storage argument one measured index, which is recorded rather than absorbed.**
§13e's case for raw SQL over the object-relational mapper cited **three partial indexes, verified
working**. The third indexed the baselines store, so the honest count is now **two**. The
correctness guarantees that argument leans on are both intact — one live claim per session, one
active lease per tab — and the rest of the case is untouched: **28 ms against 126 ms** of process
startup, **27 MB and 1 package against 325 MB and 129** of install weight, and a self-healing schema
stepper that fits a deployment with no deploy step. **The decision is weakened by one index, not
broken**, and editing the number quietly would have been the failure this document exists to
prevent.

### Every setting is an environment variable; the settings table is deleted

**Settled, and it reverses §13e's own settings ruling** — which was itself a rebuild of an earlier
argument, so this is the second time the question has moved. Recording the reversal with its reason
matters more than usual here, because the argument that produced the table is **still correct** and
will be raised again by anyone who reads it.

**What survives from §13e: several concurrent processes must agree on one tab budget**, or the
ceiling silently stops being a ceiling. That is a real correctness property and it is not being
waived. **What fails is the inference that it needs a table** — see the ruling immediately below,
which preserves the property with a one-row check.

**What removes the table's last reason is that it has no consumer.** The editing surface §13e named
was a configuration command; with no served surface at all (below), there is nothing to edit
settings *from*, no endpoint that writes them, and no reader that would prefer a stored value to an
environment one. A table nothing writes and nothing reads is a schema with a maintenance cost.

So: **every value has a working default, and a fresh install runs with nothing set.** A
`.env.example` documents every variable, its options and its defaults — the file being the
documentation surface a settings table was standing in for.

**Retention is deleted with it.** No retention setting, no sweep of capture files, no sweep of crop
files. The agent supplies the identifier of the capture it wants to diff against; **if that file is
missing, the service returns the full screenshot and explains why** rather than refusing. That is
the §13d instinct applied to storage: a caller mid-review is not stranded by an absence, it is told
what happened and handed the thing it can still use.

### The tab budget needs no table and no tool — an environment variable plus a one-row check

**Settled.** The budget is an environment variable. **The first process to open the store writes its
value in, and any later process whose environment disagrees refuses to start and says so.**

This is the whole of §13e's correctness property, bought without a settings table and without a
tool. The failure it prevents is specific and quiet: two processes running with different budgets do
not produce an error, they produce a ceiling that is whichever number the admitting process happened
to hold — so the bound stops being a bound while every process involved believes it is enforcing
one. A one-row check turns that into a startup refusal naming both values, which is the loudest
place it can possibly surface and the cheapest to fix.

**Lease lifetime deliberately gets no such check.** Disagreement there is milder in kind: processes
running different lifetimes reclaim at different times, which is **degraded behaviour rather than a
broken invariant** — no lease is double-issued and no capacity is lost, some things simply expire
sooner than their holder expected. A refusal to start is too heavy a response to that, so lifetime
is a plain environment variable. **The distinction to carry forward: a value that several processes
must agree on to keep an invariant gets the check; a value they merely ought to agree on for
consistent behaviour does not.**

### There is no served web surface; the operations view is a generated file

**Settled, and this closes §13b's reopened question rather than deferring it again.** The operations
view is **a self-contained HTML file, styling and behaviour inlined, generated by a command and
opened from disk by a person.** No server, no port, nothing left listening once the command exits.

**It is a snapshot, and it is labelled as one.** It does not refresh, it does not poll, and it
states the moment it describes. That property is the honest one for a document read from disk: a
page that looks live and is not is worse than a page that says plainly it is a photograph, because
only the second one tells a reader when to regenerate it.

Two things go with it, both deleted rather than relocated:

- **The settings-write endpoint**, which has no table left to write to.
- **The health endpoint**, which was an artefact of a process that stays up — something has to be
  askable *whether it is alive* only if it is supposed to be alive continuously. The doctor command
  already does that job in the shape this deployment actually has, by being run.

**It also moots the unauthenticated-off-machine question entirely.** Every option that question
weighed — bind to loopback only, require a token, put it behind something else — was a way of
deciding what a served surface may be reached by. Nothing is served, so nothing is reachable, and
the most sensitive question in the design closes by subtraction.

**At generation time the process is alive, and that is what makes the file worth anything.** Because
the command runs inside a live session, it can talk to the browsers, so it **reads each tab's
current address directly from the browser** instead of from any stored copy. That read is bounded by
a timeout, and **a browser that does not answer renders as unreachable rather than hanging the
generation** — the report degrades to a named gap, which is the behaviour §13e's rule about browser
round trips demands everywhere else.

### The stored page-address column is deleted

**Settled.** The store keeps no copy of what page a tab is on.

The column was **a cached copy of something the browser already knows**, and the ruling above shows
the cache never paid for itself: the only reader was the operations view, which generates while the
browser is reachable and can therefore ask the source. A cache read exclusively at moments when the
source is available is not a cache, it is a second version of the truth waiting to disagree with the
first.

Three consequences, and the middle one is the reason this is a decision rather than a tidy-up:

- **It removes the most sensitive column in the design.** A page address is the single field most
  likely to record where somebody actually went.
- **It makes the private browser trivially leak-free.** The clean-room browser's whole promise is
  that it leaves nothing behind, and a promise kept by *storing nothing* needs no guard, no test and
  no reviewer to notice when a later change quietly widens it. **Nothing stored is nothing to
  leak.**
- **It makes a clear-history command unnecessary.** A command to erase the record is only needed
  where there is a record.

### The tool surface is nine, plus a command-line-only snapshot generator

**Settled at nine agent-facing tools**, with the operations-view generator reachable from the
command line only — it is a thing a person runs, not a thing an agent calls, and putting it in the
tool list would spend schema residency (§3) on an operation no caller has a use for.

**Deleted, both for reasons that follow from earlier rulings:**

- **The separate comparison tool**, now an optional argument on capture. One fewer tool, and it
  removes the class of call that asks to compare something that was never captured.
- **The tab-close tool.** With a lease fixed at one tab (§13e), closing your tab left you holding a
  **lease that owned nothing** — a state the caller could reach by doing something perfectly
  reasonable, and which every capacity count then had to be correct about. §13f removes the state
  rather than guarding it: **a lease is a tab**, and the verb that ends one is release. §5's rule
  that a destructive operation keeps its own name is untouched; it simply has one fewer operation to
  govern.

**The tab-replace tool survives, for one named reason: a crashed tab.** That is the case navigation
cannot fix — a wedged or dead tab does not navigate — and it is why the operation is not merely a
worse spelling of navigate. Recording the reason matters because without it this reads as a
duplicate and gets proposed for deletion in the next round.

#### A viewport-resize capability is added, and measurement is what found it

**This is the round's clearest case of measurement correcting a design nobody had reason to doubt.**
The nine tools were reasoned about carefully and none of the reasoning was obviously wrong. The
count says otherwise.

**Measured across 2,007 session transcripts: 578 resize calls across 140 sessions** — **58% of every
session that used browser automation at all**, and the **sixth most-used verb**. Against that, the
surface as designed had **no path to it whatsoever.**

**It is not workaroundable, and that is the part that makes it a defect rather than an omission.**
Viewport size is context-scoped, so **evaluating an expression on the page cannot reach it** — the
escape hatch that absorbs so many missing capabilities is structurally incapable of absorbing this
one. The measured dominant loop is **resize → navigate → evaluate → screenshot, once per
breakpoint**, which means the surface as designed made **responsive review inexpressible.** Not
awkward: impossible.

So resize is added as an action on the general action tool, and the lesson is worth more than the
tool: **a design can be internally coherent, carefully argued, and missing the sixth most common
thing its users do.** Nothing in the reasoning would have surfaced it. Only the count did.

#### Dialog handling is added at 8 measured calls, for lease integrity rather than convenience

**Measured at 8 calls** — far below anything that would justify a tool on demand, and it is added
anyway, because the argument is not about frequency.

**An unhandled dialog blocks a tab, and a blocked tab burns the lease.** The tab is unusable, the
caller cannot make progress, and the capacity stays held until the lifetime expires — so a rare
event consumes a scarce resource for its full duration and the caller cannot explain why. Frequency
is the wrong axis for a capability whose absence damages the arbitration itself.

> **Add a capability at low measured usage when its absence costs the invariant rather than the
> caller's convenience.**

#### Measured and deliberately skipped, with the numbers

Recorded because a surface that lists only what it includes cannot be reviewed for what it omits.

| Capability | Measured calls in the scanned month | Call |
|---|---|---|
| Drag | **0** | Skipped |
| Drop | **0** | Skipped |
| Back-navigation | **0** | Skipped |

Zero is a strong result over 2,007 transcripts, and it is a very different claim from *we did not
think of it*. Should one of these arrive as a real request later, it arrives with this table to
argue against, which is the correct burden.

#### The read tool gains filtering, and the filter is free

**Settled: the accessibility snapshot by default; console, network and cookies by explicit opt-in.**

The property that makes this cheap rather than a trade is where the work happens. **Console and
network are continuously accumulated rather than fetched on request** — the service is watching
them regardless, because it holds the browser. So the filter is a **write-time** decision about what
enters the response, not a read-time decision about what to go and collect. **The cost of not asking
for something is zero**, and the cost of asking for it later is that it was already there. A filter
that saved collection work would be a trade-off worth arguing about; this one only saves residency
(§3), which is exactly the thing worth saving.

### The lease key stays explicit on every call

**Settled, and implicit or session-derived identity was considered and rejected.** Every call
carries its key.

**The deciding argument is delegation.** An orchestrator may want to hand **one specific subagent**
the key so that agent, and only that agent, can drive the tab. Implicit identity makes that either
**impossible** — the key is welded to whoever holds the session — or **automatic for every
subagent**, which grants it to all of them by default. Neither is wanted, and an explicit key gives
both behaviours by choosing who receives it.

**The key is not merely addressing; it is the ownership check.** That framing is what makes the
extra argument on every call worth its weight: it is not saying *which* lease, it is proving
*entitlement* to the lease, and a proof that the transport supplies invisibly is a proof nobody can
delegate or withhold.

Two pieces of supporting evidence, offered as support rather than as the reason:

- **The protocol forbids using sessions for authentication**, so deriving authority from a session
  identifier would be building the thing the specification tells implementers not to build.
- **Under a standard-input transport, ownership is carried by the operating-system process
  boundary** — which works, and **would not survive a move to a shared network-facing broker**. An
  explicit key survives that move unchanged; an implicit one has to be reinvented at exactly the
  moment the system got harder.

### Lease lifetime and queue-place lifetime are both ten minutes, deliberately equal

**Settled: ten minutes each. This reverses §13e's "they must not be equal" and the reopened-durations
note in §13a**, and it reverses them because **the argument that produced the asymmetry was
wrong**, not because the numbers were retuned.

**The false premise: "a queued caller has nothing to renew with."** It does. **Polling is renewing**
— the status call already renews, and asking whether anything has changed is precisely the work a
waiting caller has. The asymmetry rested on a waiter having no natural source of calls, and a waiter
that is waiting properly generates exactly one kind of call, continuously.

**And the cost runs the other way from the direction both earlier arguments assumed.** Under strict
first-in-first-out, **a queue place held longer blocks everyone behind it.** A generous queued
lifetime is therefore the *harsher* setting: it protects one distracted waiter by stalling every
caller behind it for the same duration. §13e read a longer queued lifetime as kindness. It is the
opposite, and equality is the setting that treats the queue as the shared resource it is.

Two additions make equality safe rather than merely defensible:

**Release must also release a queue place.** A queued caller that changes its mind has no exit
otherwise — it can only stop polling and wait out its own lifetime, blocking everything behind it
for the full duration while having already decided it does not want the tab. The verb that means *I
am done* has to mean it in both states.

**The queued response must carry a scheduling nudge**, naming a check-back time just under the
lifetime. This is a contract detail of the same kind §13e identified for *keep asking or lose your
place*, and it exists because of an observed behaviour worth stating plainly: **agents assume they
will wake themselves and then do not.** A caller told only *your place expires in ten minutes* will
agree, intend to return, and be gone. A caller told *check back in nine* has an instruction it can
act on immediately. The service knows the number; withholding it and expecting the caller to derive
it is how a fair queue produces unfair outcomes.

### The capture escalation reason is free text

**Settled: free text, not a fixed set of options.**

The behaviour is that the service **defaults to the lower resolution tier and tells the caller how
to escalate**, including that escalation requires a written reason. The default does the work (§13d)
and the message makes the escalation path discoverable to a caller that genuinely needs it.

**Free text because the resolution study needs to learn why callers escalate, and a fixed set cannot
teach it that.** A fixed set can only report which of the author's guesses each caller picked — its
entire output is a distribution over categories somebody invented before seeing any data, and the
one thing it can never surface is a reason nobody thought to list. The asymmetry decides it:
**free text can be classified into categories later, and a fixed set's discarded nuance cannot be
recovered.** Given a study whose purpose is to settle provisional numbers with evidence
(`MILESTONES.md` #34), throwing away the evidence at collection time is the one irreversible
mistake available.

### One image endpoint, one return shape

**Settled: an image request always returns an image the same way.** Whether what comes back is a
full capture or a diff depends only on whether a comparison identifier was passed.

**Rejected: returning crops inline under a size cap.** It sounds safe — a small crop is cheap, so
inline it — and the flaw is that **you cannot know a diff is small.** A change to a shared component
changes every view that uses it, so the diff of a one-line change is the whole page, and the size
cap is discovered at the worst possible moment: after the work is done, on the results that matter
most. A conditional return shape also makes every caller handle two cases forever, to save a path
lookup on the cases that were cheap anyway.

One shape, one endpoint, no conditional.

---

## 13g. Two intermittent test failures, diagnosed (2026-08-26)

`MILESTONES.md` #72. Two failures had each been sighted **once**, during unrelated builds, and
neither could be reproduced by repeating the failing case on its own. Both were therefore at risk of
being attributed to whatever change happened to be in front of them. They turned out to have
**nothing in common except the conditions that expose them**, and one of the two is a defect on a
shipped route rather than a test fault.

### They do not share a cause; they share a shape

The row asked whether the two shared a cause and whether that cause was shared temporary state
between cases. The answer to both halves is **no**, and the second half is worth stating plainly
because it was the leading theory: **no state is shared between cases.** The conformance runner
builds a fresh subject with its own temporary directory and its own store per case-and-route pair,
and a subject's live-claim count was measured at zero at birth. Every temporary directory in the
test tree comes from `mkdtempSync`, so no two runs can collide on a path. Nothing under `src/`
writes to `process.env`, and nothing binds a fixed port.

What they do share is that **`node --test` runs test files in separate child processes,
concurrently**, up to the machine's processor count. That is what makes both failures load-dependent,
and it is the reason repeating a single case never reproduced either: running one case alone removes
the ~30 concurrent peers that create the conditions. **A single-case loop is the one probe that
cannot find either of these**, which is worth remembering, because it is the probe both earlier
investigations reached for.

### The browser suite: a teardown that could not wait

`tests/browser/sign-in-evidence.test.ts` removed its profile directory with
`fs.rmSync(root, { recursive: true, force: true })` in a `finally`. `force` suppresses `ENOENT` and
nothing else, so a handle the operating system has not finished releasing surfaces as `EPERM`.
Thrown from a `finally`, that error is attributed by `node --test` to the **file** rather than to any
test, which is why the sighting showed every assertion passing and the file failing.

Measured: launch a persistent context, send `Browser.close`, remove the root immediately. Bare
`rmSync` failed **5 times in 5**; the repository's own `removeDirectory` helper failed **0 times in
5** over the same race in the same loop. The bare arm is the control that shows the race was present
on every trial. Under artificial processor contention the unfixed test failed **13 runs out of 13**.

The fix is to use the retrying helper that already existed for exactly this — `removeDirectory`,
whose own header documents this failure mode, as does `service-subject.ts`. **The three-second wait
before it is deliberately left alone**: that wait exists so the signed-in assertion can read a
flushed cookie store, which is a different requirement from removing a directory.

### The conformance suite: a lease key that began with two dashes

This one is a **real defect on the command-line route**, not a test fault, and it would have reached
users.

A lease key is 32 random bytes rendered as base64url, and **the base64url alphabet contains `-`**.
So about **one key in 6,250** begins with `--` (measured: 32 in 200,000). The command line's parser
decided that an option was a boolean whenever the following word started with `--`. A key of that
shape was therefore read as the next option: `lease_key` arrived as `true`, the key never reached the
service, and the caller was refused for a **missing key** while holding a perfectly good one, with
nothing in the message pointing at the cause.

It was caught by instrumenting the runner to print the refusal's rule and then running the
conformance suite 25 rounds of 16 concurrent processes: two hits, both `key_missing` / `key.present`,
and both seed keys began with `--`.

Two consequences worth recording:

- **It explains why the failure never named a consistent case.** The seed mints a fresh key per
  case-and-route pair, so the case that fails is whichever pair happened to draw an unlucky key —
  observed on `read`, on `evaluate`, and on `tab_replace` across different runs. A reader looking for
  the bug in the failing case was looking in the wrong place every time.
- **The tool surface is immune**, because it carries JSON rather than a word list, and this was
  verified rather than assumed. That asymmetry is the parity suite doing its job: the same input
  reached the same service through two doors and only one door mangled it.

The parser now decides "is the next word an option?" by **shape rather than by the leading dashes**:
an option's name is lower-case letters, digits and hyphens, which every option this command line has
satisfies and no base64url key does. Two real flags in a row still parse as two booleans.

### The finding that named no rule

A contributing cause deserves its own note, because it is what made the conformance failure resist
two investigations. The runner's `outcome-mismatch` finding recorded only *"expected accepted, got
refused"* — it discarded the refusal's code and rule one line before reporting them. The rule name
was the entire diagnosis. It is now carried in the finding, so the next occurrence names its own
cause.

## 13h. The handshake: hand-rolled, not imported (2026-08-31)

The tool surface had ten tools, a conformance suite proving each of them behaves identically to its
command-line twin, and **no way for any client to reach a single one of them.** `protocol.ts`
declared exactly two methods — `tools/list` and `tools/call` — over bare JSON objects, one per line.
A Model Context Protocol client opens with `initialize`, waits for the server's `protocolVersion`,
`capabilities` and `serverInfo`, sends `notifications/initialized`, and only then asks what tools
exist. Against that surface the first message came back `method_not_found` and the client hung up.

The defect is worth naming precisely, because it is a shape that recurs: **every layer was tested and
the composition was not.** Nothing was broken. The tools worked, the framing worked, the refusals
were correct on both routes, and the parity claim held. What did not exist was the doorway, and no
test could have failed because no test spoke as a client — the conformance driver and the spawned
smoke subset both open with `tools/list`, which is the second thing a client says, not the first.

> **A surface tested only by callers who know its conventions is not tested as a surface.** The
> question that would have caught this is not "does each method work" but "what does the first
> message a stranger sends get back".

### The dependency question, decided rather than defaulted

The real choice was whether to adopt `@modelcontextprotocol/sdk` and let it own the handshake, or to
write it out here. **Settled: hand-rolled**, and the argument for the other side is strong enough to
record properly rather than dismiss.

**What the SDK would have bought** is the thing that actually matters here: the specification moves,
and a maintained client library moves with it. Spec drift is a class of bug this repository is now
exposed to and has no instrument for — nothing in the test suite can notice that a revision published
next year changed what `initialize` must return. That is a real, permanent cost and it is accepted
with open eyes.

**What decided it against** was three things, in order of weight:

1. **The dependency would not have been small.** The SDK brings a server abstraction, a transport
   abstraction and a registration model, and adopting it means the session loop, the framing and the
   dispatch all become its rather than this repository's. That is not adding a dependency; it is
   handing over the surface. This service has **four runtime dependencies**, each doing something
   genuinely hard — a native SQLite binding, a browser driver, an image decoder, a pixel comparison.
   A protocol envelope is not in that category.
2. **The thing being imported is a documented wire format, and the subset used is small.** What was
   missing is one request, one notification, an envelope with four fields and a version comparison.
   It came to roughly a hundred lines including the reasoning. A framework earning its place has to
   do more than that.
3. **The existing refusal taxonomy would have been the price.** See below — this is the part that
   would have been quietly lost.

The honest summary: **the SDK is the better answer for a service that expects to track the
specification closely, and the worse answer for one that implements a small fixed subset and wants to
keep its own error semantics.** This is the second kind. If that stops being true — if the surface
grows resources, prompts, sampling or server-initiated messages — the balance flips, and this entry
should be read as the thing to overturn rather than as settled forever.

### Two code spaces, because flattening one would have cost a real distinction

JSON-RPC requires numeric error codes from a small fixed set. This surface already had a vocabulary:
`method_not_found`, `tool_not_found`, `malformed_call`, `malformed_message`, `unexpected_failure`.
Those are not decoration — `SCHEMA.md` names `unexpected_failure` when describing what a caller sees
if a constraint is reached by a path that should have refused earlier, and two build checks read
these names to distinguish a structured refusal from a crash.

Mapping them onto five integers is many-to-one and lossy: `method_not_found` and `tool_not_found`
both become `-32601`, and they are genuinely different facts about what the caller did wrong.

**Settled: both travel.** The numeric code goes in `error.code` where the transport requires it, and
this surface's own name goes in `error.data.code`, which is the field JSON-RPC reserves for exactly
this. A generic client reads the integer and behaves correctly. A caller that knows this service
reads the name and keeps every distinction it had before. Nothing was flattened, and the mapping is
one function rather than a rewrite.

This is the same principle §5.6 already holds elsewhere: **a refusal is the service working, and a
caller that cannot tell a typo from a capacity refusal will retry the one and give up on the other.**
Collapsing the taxonomy to satisfy a transport would have taken that distinction away from every
caller on this route to buy nothing.

### The notification is the part most likely to be got wrong

`notifications/initialized` has no identifier, and a message with no identifier **must not be
answered**. A surface that treats it as a request with a missing field will either reject it as
malformed or — worse — invent an identifier and reply, which a strict client is entitled to read as a
broken stream.

So the absence of the identifier is decoded as a *kind* rather than as a defect, and the type
carrying it **cannot express an identifier at all**. That is deliberate: the failure mode is
answering one by accident, and a type that has no field to answer to cannot do it accidentally. The
test asserting this counts messages in against messages out — four in, three out — because the
absence of a response is the whole claim and it is not observable any other way.

### Version negotiation answers; it does not refuse

A client asking for a revision this surface does not implement is told which revision it does speak,
and decides for itself whether to go on. **That is a negotiation rather than a rejection**, and it is
what the specification asks for. The alternative — refusing an unfamiliar version string — would
break this surface on the next revision of the specification rather than on anything wrong with the
client, which is a failure mode that arrives on somebody else's release schedule.

`SUPPORTED_PROTOCOL_VERSIONS` is a list of revisions this surface has actually been made to speak,
newest first. A revision is added to it when that is true and not before: the point of the list is
that it is a claim.

### What is still owed

**The version in `serverInfo` is the literal `0.0.0`**, and it is a literal rather than a read of
`package.json` because that file says `"version": "0.0.0"` and `"private": true` — reading it would
report a value meaning *unset* as though it were a release. The packaging question behind that
(whether this is ever published, given `README.md`'s position that installation is the whole of
deployment) is untouched here and is recorded in §14 rather than decided in passing.

## 14. Still open

Closed items keep their place here as struck-through pointers rather than being deleted, because
**an item that vanishes from this list reads as forgotten rather than settled** — and a reader who
cannot tell the two apart will raise it again.

**Closed 2026-08-18 (§13e):**

- ~~**The partial-index question in §13b.**~~ **Closed** — measured working, and with raw SQL neither
  of the two unfree answers is needed. §13e. *(Count corrected 2026-08-24: three verified indexes
  became two when the baselines store was deleted — see §13f, which records the weakening rather
  than editing the number.)*
- ~~**The licence.**~~ **Closed: MIT.** A real `LICENSE` file is still required before publication;
  the decision does not grant anything on its own. §13e. Blocks `MILESTONES.md` #2.

**Closed 2026-08-24 (§13f).** Nine questions were answered in one round, and most were answered by
deleting the thing that raised them:

- ~~**The visual surface, reopened by the daemonless ruling.**~~ **Closed: nothing is served.** The
  operations view is a generated self-contained HTML file, opened from disk, labelled as a snapshot.
  §13f. It applied the original test — *what does this buy a page that displays six numbers?* — and
  the answer was *nothing*.
- ~~**How an unauthenticated surface should behave off-machine.**~~ **Moot, not decided.** Every
  option concerned binding a served surface to an address, and nothing is served. §13f.
- ~~**How a baseline gets its generated name.**~~ **Moot, not decided.** The question existed only
  because a baseline carried lineage; the baseline concept is deleted. §13f.
- ~~**Where settings live and what may edit them.**~~ **Closed: environment variables only, no
  settings table.** Every value has a working default and `.env.example` documents the set. §13f.
- ~~**How several processes agree on one tab budget.**~~ **Closed: a one-row check.** The first
  process to open the store writes the value; a later process whose environment disagrees refuses to
  start. §13f.
- ~~**Whether the stored page-address column is worth its sensitivity.**~~ **Closed: deleted.** It
  cached something the browser knows and was read only when the browser was reachable anyway. §13f.
- ~~**Whether the lease key could be implicit.**~~ **Closed: explicit on every call.** Delegation
  decides it — an orchestrator must be able to hand one specific subagent the key. §13f.
- ~~**The queue-entry lifetime, and how far it should exceed the lease lifetime.**~~ **Closed: both
  ten minutes, deliberately equal.** The asymmetry argument was wrong — polling is renewing, and
  under strict ordering a longer queued lifetime blocks everyone behind it. §13f.
- ~~**Whether the escalation reason should be a fixed set.**~~ **Closed: free text**, because the
  resolution study needs to learn reasons nobody thought to list. §13f.
- ~~**Multi-tab hold-and-wait deadlock.**~~ **Closed, and nothing was added to admission.** Neither
  all-or-nothing admission nor an acquire-everything protocol was taken: the first buys back the
  reservation arithmetic a grant-is-one-tab deleted, and the second is advice the service cannot
  enforce. What the case actually needed was information, not scheduling — a caller only starves
  here when it does not realise the capacity it waits for is partly capacity it holds. So a refusal
  names the leases the asking session already holds, advises starting with those, and offers
  release-and-retry; the transaction that counts live leases already knows the session, so detection
  is one comparison. It is recorded as a decision, because each occurrence resolves itself invisibly
  and only the ledger can show it becoming common. §2.3a.

**Open:**

0. **Whether this is ever published, and what `serverInfo` should then say.** `package.json` is
   `"private": true` with `"version": "0.0.0"`, no `files` field, and a `bin` pointing at a raw
   TypeScript file. `README.md`'s position — *installation is the whole of deployment* — is coherent
   and matches a service that binds nothing, but it makes install git-clone-only: it cannot be
   installed or run from the registry by anyone. That is very likely the intended design; what makes
   it worth an entry is that `private: true` and `0.0.0` read as *not yet considered* rather than as
   *decided*, and §13h now has a `serverInfo` version literal that has to agree with the answer.
   **Not a defect and not blocking the handshake** — a client spawns a path and never consults a
   registry.
1. **Whether the four capabilities added in §13f cover what the refused arbitrary-code verb was
   being used for.** The arguments **have since been sampled**, and the presumption they were tested
   against was half right. Of **328 calls across 53 sessions**, 186 (56.7%) are expressible on the
   surface as designed — the largest single group, 54 calls, being a bare page-expression wrapper,
   which is somebody reaching for the unsafe verb to get the safe one. The remaining 142 drove the
   four additions: storage seeding (40 calls / 25 sessions), media emulation (19 / 9), console
   collection, and browser choice. **What is not yet known is whether those four close the
   remainder** — and unusually, the design ships the instrument that answers it: the feedback tool's
   `no-path` category, filtered, is exactly this question asked of the callers who hit it. Not owed
   before launch; owed before the feedback tool is retired.
2. **The capture-policy numbers (§13d) — now largely answered.** The resolution-ladder study
   (`MILESTONES.md` #34) has run and **kept all three rungs**, so the numbers themselves are settled
   with evidence rather than argument. §13f settles the escalation reason's *shape* as free text,
   which is what let that study learn anything. **What remains open is narrower than the original
   question:** the absolute legibility floor, which the study bounds but cannot answer, because no
   automated instrument can establish what a reader can read.
