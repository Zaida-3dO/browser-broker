# Browser Broker — the plan

**Status:** planning. This is the document to read and correct. Its companions are `SCHEMA.md` (the
concrete shape of every table, tool, endpoint, command and guard) and `DECISIONS.md` (every decision
with its reasoning, including what was rejected).

**Name settled 2026-08-13.** The product is **Browser Broker**; the command you type is **`broker`**.
"Broker" is what it does — it stands between callers and a scarce resource, decides who gets it, and
refuses the rest. It also avoids naming a vendor's automation library, which is an implementation
detail the requirements never mandated and which a later decision should be free to change.

---

## What this is, in one paragraph

A service that owns a small, fixed set of real browsers and brokers access to them. A caller asks for
a **lease**; it gets back a secret key and one or more tabs it exclusively owns. Every later call
carries that key, and the service uses it to route the call, to decide whether that caller is allowed
to do that thing to that tab, to account for what the call costs, and to notice when the caller has
stopped talking. When capacity is full, callers queue. When a caller dies, its capacity comes back on
its own.

The important part: **the rules live in the service and are enforced, not requested.** A rule that
each client is merely asked to honour is a rule that drifts — every client honours it slightly
differently, and nothing notices until something breaks a long way from the cause.

---

## Arbitration is the product

It is worth being precise about what is being built, because there is a large, well-maintained
ecosystem for driving a browser and none of it is being rewritten here.

**Driving a browser is a solved problem, and gets reused.** Launching, sessions, tabs, persistence,
navigating, clicking, reading the accessibility tree, writing a snapshot to disk — all of that comes
from a first-party command-line automation tool. Browser Broker shells out to it and never
reimplements any of it.

**Arbitration is not solved, and that is the whole app**: a bound on how much browser exists, a lease
that says who owns what, a queue for when there is not enough, a time to live that reclaims from
callers that die, an explicit release, an ownership check on every operation, an append-only record
of every decision, and a policy on what captures cost. Nothing surveyed ships that combination, and
the pieces that come closest either bound the wrong thing (a pool of *browsers*, which is the
resource that must stay fixed) or re-expose every destructive operation to callers.

**The honest counter-argument** is that the automation ecosystem could grow arbitration later and
leave this owning a redundant service. The mitigation is the same as the reuse rule: keep it **thin**
— arbitration and policy only, never a reimplementation of the browser API — so retiring it costs a
configuration change rather than a migration.

---

## Two browsers. Everything else is tabs.

This is the decision the rest of the design hangs off.

| Browser | Profile | What it is for | Count |
|---|---|---|---|
| **regular** | persistent, signed in | everything that needs to be somebody — all stateful work, as tabs | 1, always up |
| **private** | ephemeral, signed in to nothing | clean-room work: design review, first-visit behaviour, anything that must not inherit a session | 1, always up |

A *browser* is a process with a storage partition. Tabs live inside it and **share that partition** —
cookies, local storage, cache, history. That is where "sign in once and every tab inherits it" comes
from, and it is also why an isolated session is not cheap: isolation at the session level costs a
whole extra browser process, whereas isolation at the tab level costs a renderer.

So the design expresses concurrency **entirely in tabs**:

- **Two browser processes is a hard ceiling that does not move with the number of callers.** Ten
  callers and one caller cost the same in processes. Memory grows by a renderer per tab (tens to a
  couple of hundred megabytes each) rather than by a browser per caller.
- **The bound is one total tab budget across both browsers** — not a count of slots, and not a
  separate allowance per browser. A claim asks for *n* tabs and is admitted if
  `total open tabs + n ≤ budget`, whichever browser it wants. **Default: 15.**

**Why one total and not one each.** The scarce resource is renderer processes and the memory they
hold, and a renderer costs the same whichever browser it belongs to. A per-browser cap would ration
something that is not scarce: it would refuse a fourteenth regular tab while a private allowance sat
unused, which is a refusal that protects nothing. One counter means the split falls out of demand —
14/1 on a stateful afternoon, 5/10 during a review sweep — and the only number anyone has to reason
about is the one that maps to memory.

### Be explicit about what "private" does and does not mean

**"Private" means "not signed in as the operator". It does not mean "isolated from other callers."**
Tabs in the private browser share its cookie jar, so two concurrent review callers are clean-room
relative to the regular profile but **not relative to each other**. That is fine for design review.

**It is not fine for multi-account work or two parallel sign-in flows, and there is no escape hatch
for those.** A third browser for the duration of one claim was considered and **rejected**: two
independent authenticated sessions can be done one after the other, and an exception that mints a
browser on demand would undo the exact bound it sits inside. **Exactly two browsers, no exceptions.**

What that gives up, stated plainly: **testing two independent authenticated sessions in parallel is
not possible through this service, by design.** Run them sequentially. If a case ever arises where
that genuinely will not do, it is a decision to take then, with the reason in front of it — not a
capability held open in advance on the chance it might be wanted.

One caveat that no design can remove: **per-tab session storage is per-tab in every browser**, so a
site that binds its session to it loses that on a new tab regardless of the shared partition. The
service reports this as a field on the response rather than pretending to guard it.

---

## Bidirectional isolation

The service runs **its own two browsers**, and the isolation between them and everything else on the
host runs in **both directions**. Both halves are requirements, and the second is the one that is
easy to miss.

**Outward — nothing this service does can disturb a browser it does not own.** Other things run
browsers on the same machine: a person's own, and automation that is not part of this system at all,
which typically uses the default profile. The service never manages, adopts, attaches to, closes or
otherwise reaches any of them, and it refuses any operation naming one. It leaves them entirely
alone and entirely available.

**Inward — nothing outside can block this service either.** This is the half that turns a good
intention into a design constraint, because "do not touch the wrong browser" is a rule about
behaviour, whereas being blocked is something that happens to you:

- **The service always launches with an explicit profile directory of its own, and never relies on a
  default path.** This is a hard requirement, not a precaution. The default persistent profile
  location is shared by anything else that also takes the default, and two processes on one profile
  contend on its lock file — so an unrelated automation run that happened to start first would stop
  the service starting at all.
- **No shared lock file, no shared port, no shared temporary directory.** Everything the service
  needs to acquire, it acquires somewhere it owns.
- **No assumption that a browser it did not launch is absent.** The service is correct on a machine
  where three other browsers are already running, because it never looks for "the browser" — only
  for the ones it started.

This is a cleaner statement of the boundary than a list of things not to touch, and — the reason it
is worth having as a property rather than as a habit — **it is testable**. "Do not disturb the wrong
browser" can only be reviewed. "Starts successfully while an unrelated browser holds the default
profile" is a test.

---

## The lease

**One entity, one secret key, five states.**

```
                 capacity?
   claim ──yes──────────────▶ active ──release──▶ released (terminal)
     │                          │
     └──no──▶ queued            ├──time-to-live lapses──▶ expired  (terminal)
                │               └──operator revokes─────▶ revoked  (terminal)
                ├──time-to-live lapses──▶ expired (terminal; re-queue at the back with a new key)
                └──capacity freed───────▶ active  (admission sweep, first in first out)
```

- **`claim`** either grants capacity or queues, atomically. There is no state in which a caller
  believes it holds tabs that it does not.
- **`renew`** resets the expiry in place, and is legal from both `queued` and `active`.
- **Every keyed call is an implicit renew.** A caller doing work never expires mid-work; the timer is
  a liveness signal, not a work limit.
- **`release`** is terminal, closes exactly that lease's tabs, and triggers the admission sweep.
- **The reaper** runs on a timer and on demand. On expiry of an active lease it closes exactly that
  lease's tabs and sweeps.
- **The admission sweep**: while capacity exists and the queue is not empty, promote the head of the
  queue.

### The queue is a real answer, not a failure

When capacity is exhausted the call **queues rather than failing**. The response carries the queue
position, an estimate, and — this part matters — an explicit statement of the expectation: *keep
checking in or lose your place*. A protocol that implies an obligation and does not state it is a
protocol whose clients will not meet it.

### Time to live: one rule, two defaults

**Settled.** The mechanism is uniform: *keep pinging or lose it*, applied identically to an active
holder and to a queued client, and renewed by any keyed call. Only the durations differ — **10
minutes for an active lease, 5 for a queue position** — both configurable.

They differ because the failure costs are asymmetric. Expiring an active holder destroys work in
progress and can strand a half-finished authenticated flow. Expiring a queued client costs it a place
it can retake by asking again. Same rule, different price for getting it wrong.

**This is the mechanism that reclaims capacity from a caller that died holding it** — the one failure
no client-side convention can cover, because the client that ought to clean up is the one that is
gone.

If the transport can tell the service that a client disconnected, that shortens the effective expiry
to a brief grace period rather than revoking immediately, since clients do reconnect. If it cannot,
the time to live is the whole answer and the design says so rather than assuming a signal it may not
get.

### What reclaims what — the whole rule in one line

> **Every reclamation is tab-scoped and lease-scoped. Nothing is ever browser-scoped.**

The reaper closes tabs by the identifiers recorded when they were opened. The browsers are
lifecycle-managed by the service and are never closed by any caller's action, directly or indirectly.
This is not a rule clients are asked to respect; there is no operation through which they could do
otherwise.

---

## The contract: references, not payloads

A tool result that arrives in an agent's conversation stays there. It is re-read on every subsequent
turn, so a large result captured early is paid for once in money and repeatedly in context — and
context is the axis that drives compaction, truncation and the quality loss that follows.

An image is by far the worst case. A single screenshot at a high-resolution tier costs thousands of
tokens, and a design pass over a handful of views at several breakpoints is a five-figure token bill
resident for the rest of the run.

So the contract is:

- **`capture` returns `{path, width, height, bytes}` — never the image.** The caller opens the file
  only when it genuinely needs to *look*.
- **`read` returns a path to a file on disk** — the accessibility snapshot, the console, the network
  log. The caller greps the part it needs instead of ingesting all of it.
- **`evaluate` returns small JSON inline**, spilling to a path past a byte cap. This is the cheap
  path and it is meant to be used.
- **Lease operations return inline.** They are tiny.

### A deliberately small surface

Around ten tools, not forty. Every tool's description is resident in a connected agent's context on
every turn whether or not anything calls it, so surface area is a standing tax on every session. The
concrete list lives in `SCHEMA.md`; the principle is that browser *actions* collapse into one
tool with an action enum rather than one tool per verb, and the trade-off — an enum is less
discoverable, and its error messages have to work harder — is accepted deliberately.

Three things are **deliberately absent**, and their absence is part of the contract:

- **Anything browser-scoped and destructive.** No close-browser, no close-all, no kill-everything, no
  delete-profile-data. A caller can close its own tabs and nothing else. With two shared browsers,
  every browser-scoped operation is a shared-fate operation: one caller ends every other caller's
  work.
- **Anything that attaches to a browser the service did not launch.** A caller must not be able to
  reach a browser outside the service's control, which in practice means the person's own.
- **Anything that reads or writes credentials.** No storage-state dump or load, no cookie setting, no
  arbitrary script execution. A cookie summary returns names and domains, **never values**.

There is also **no "current tab"**. Every operation is addressed by an opaque tab identifier issued
with the lease. A shared implicit cursor is a bug class rather than a convenience: one caller
navigates, and another caller's page — the one holding the signed-in session — is silently gone. With
no current tab there is nothing to mis-target.

---

## Capture policy — and where each part of it can actually live

Half the value here is arbitration; the other half is that the service is the only place a capture
policy can be *enforced* rather than recommended, because the service is the thing taking the
capture.

| Control | Lives in | Why there |
|---|---|---|
| Low resolution by default, **with no parameter required to get it** | **The service** | It takes the capture, so it can apply the ceiling. A client convention can only advise, and advice is the thing this design exists to stop relying on |
| Higher resolution by **explicit opt-in**, never by accident | **The service** | The expensive thing should cost a decision. Asking for it is fine; getting it without asking is the failure |
| A **strong warning** rather than a refusal once a lease has taken a lot of captures, naming the cheaper alternative | **The service** | A refusal mid-review strands work that is already half-done; a warning that says what to do instead changes behaviour without destroying the run |
| Full-page capture off by default | **The service** | Unbounded page height is what pushes an image over the expensive tier, more often than width |

### The resolution tiers

**Provisional defaults.** They are numbers somebody reasoned to, not numbers anybody measured, and
the resolution-ladder study exists to settle them with evidence. Treat them as the starting position.

| Tier | Long edge | How you get it |
|---|---|---|
| **default** | 1024 px | **Pass nothing.** This is the normal case and it requires no parameter at all |
| **`detail`** | 1568 px | Asked for explicitly. The ceiling of the cheap vision tier |
| **`max`** | 2576 px | Asked for explicitly, **and a `reason` string is mandatory** — which is recorded |

**Full-page capture is off by default.** Unbounded page height is what actually pushes an image over
the long edge, and a full-page capture of a long page is the worst offender there is.

**Nothing is ever refused on capture grounds.** Past the accounting threshold a capture is served
with a loud warning that names the cheaper alternative — the snapshot or the evaluate that answers
the same question. See `DECISIONS.md` §13d for why a warning beats a wall here.
| Prefer a snapshot to a screenshot for anything structural | **Both** | The service makes the snapshot cheap and accounts for the screenshot; only the caller knows which question it is asking |
| How many breakpoints, and which interaction states | **The caller** | The service has no concept of a "key view" |
| Delegating the looking to a sub-agent, so images live and die in a context that is thrown away | **The caller** | An orchestration pattern, not a browser operation |

The bias worth encoding on the caller's side, because the service cannot read intent: **to read a
value, a piece of configuration or a piece of state off a page, a snapshot or an evaluate is right
and a screenshot is wrong.** Screenshots answer one question — *does this look as it should* — and
that is the question they should be spent on. Exact numbers (computed styles, contrast ratios, box
geometry, spacing, line height) are a few hundred tokens of JSON from an evaluate, and are *more*
accurate than a model estimating them off a picture.

**The defaults are provisional and should be settled by evidence, not by argument.** The service logs
every capture's dimensions, bytes, what it was downscaled from and an estimated token cost, so the
question "what resolution do we actually need" becomes measurable. The measurement is a ladder: the
same page and the same tasks at several long-edge caps, one independent reviewer per rung, each asked
to do the same concrete jobs — read the body text, identify a named component, spot a planted visual
defect, report spacing and alignment. Expect **more than one threshold**: text stops being legible
before layout critique stops working, so the useful ceiling is the lowest rung that still passes the
checks that matter.

---

## Changed-region review

A capture can be compared against a **baseline** stored for that view and breakpoint, and what comes
back is not a boolean and not a full-page diff mask — it is the **regions that actually changed**,
cropped, as separate small images. A review of twenty-five screenshots becomes a review of the two
that moved.

This belongs here rather than in a separate tool because the service already holds the browser,
already takes every capture, and is already the place a per-view identity has to be recorded. A
baseline is pool state.

Two things to be honest about, because they decide whether it earns its place on any given run:

- **It needs a stable baseline**, and it is **useless on a first-time review**, where there is
  nothing to compare against. It is a second-visit optimisation living inside a service whose other
  features are first-visit ones. That tension is real; the answer is that repeat review is the
  common case, not that the tension is imaginary.
- **Anti-aliasing, font rendering and animation cause false positives** without a tuned threshold, so
  the threshold is configurable and the tuning is part of the work rather than an afterthought.

The comparison itself is a solved problem and gets reused from an existing pixel-diff library. The
part that needs writing is **bounding-box extraction**: most libraries emit a mask or a count, and
what a reviewer needs is a short list of rectangles. That is connected-components over the mask —
a small piece of code, not a project.

---

## Where it runs

**One machine. The service, the browsers and the database all sit on the host that renders the
pages.** No network dependency, nothing to reach across, nothing to be partitioned from.

The automation tool the service drives is machine-local: it has no listening socket and no server
mode, and its sessions persist because the browser processes stay up. A service on one machine
therefore cannot drive a browser on another by shelling out to it — so the service has to live beside
its browsers, and once it does, putting the database somewhere else buys nothing that a lease
lasting ten minutes actually needs.

That deletes an entire distributed-systems problem from the first version. A service that can only
*ask* a remote agent to touch a browser has to invent its own remote-call protocol, its own liveness
model and its own failure semantics before it can arbitrate anything.

**The trade, stated plainly:** lease state lives and dies with the host. If that machine reboots,
arbitration and its record go down together. That is acceptable — with no browsers there is nothing
to arbitrate, and a lease is a short-lived fact, not an archive — but it is a real property being
given up, and it is given up on purpose in exchange for the simplest thing that works.

**The seam is pre-cut, and it is now the only thing preserving the option.** The browser driver sits
behind an interface. If a second machine ever needs browsers, that interface grows a remote
implementation and nothing else changes.

### The stack

**Node and TypeScript, Prisma, Postgres.** Long-lived service process; the schema lands as one
baseline migration and changes additively after that.

**No application framework.** The only visual surface is a single read-only operations page — live
claims, queue depth, tab budget, each claim's stated purpose, no controls and no sign-in — and that
is one static HTML file served by the HTTP adapter, fetching the JSON endpoint that has to exist
anyway and rendering it in the browser. A framework would add a build step, a dependency tree and a
release surface to a page whose entire job is to display six numbers. If the page ever needs to be
something else, that is a decision to make then, with a reason.

### One process, not one per connection

The transport matters more than it looks. A server started over standard input and output is spawned
**once per connecting session**; an HTTP server is not. Ten sessions against a stdio server is ten
copies of everything; ten sessions against one HTTP server is one process holding two browsers.

So the primary adapter is **MCP over streamable HTTP, one long-lived process**. That is also what
makes the cross-caller ownership checks load-bearing for the first time: when every session has its
own private browsers, an ownership check has nothing to protect.

---

## Adapters, and the suite that keeps them honest

- **A core service layer** holds the lease, the queue, the timers, the ownership rules and the
  capture policy. It is the only thing that talks to the browser driver.
- **Adapters** are thin shells over it: MCP over HTTP (the primary route), MCP over stdio
  (single-machine installs), HTTP/JSON (operations views and anything that is not an MCP client), and
  the `broker` command line (people, and scripts).
- **A shared conformance suite** runs the same cases against every adapter and asserts **identical
  operations and identical refusals**. Registering an adapter is mandatory: adding one without adding
  it to the suite must itself fail.

The command-line adapter is worth building even if no agent ever calls it. It is the cheapest
available proof that the rules live in the service layer rather than inside an MCP handler — a rule
that lives in a handler is a rule that holds on one transport and not the others.

**One place this suite has to be stronger than a conformance suite usually is:** a browser lease has
a physical side. Assert not only that the refusal message matched, but that **no tab was opened**. A
guard that returns "denied" after the tab already exists is worse than no guard, because it reports a
refusal that did not happen. That is why a **fake driver** is early work rather than a testing
convenience.

---

## Being the only route in

Every guarantee above rests on one precondition: **the service is the only way a caller can reach a
browser.** A contract that can be routed around is a convention, and conventions are what this
design exists to stop depending on.

Ranked by whether each is a mechanism or a hope:

1. **Do not install the automation binary where callers can reach it.** The service vendors it inside
   its own installation directory and never puts it on a caller's path. **This is the only actual
   mechanism**, and it is the one that also closes the attach-to-a-running-browser hole — an
   operation that, by design, connects to a browser nobody launched through the service.
2. **Deny-list the binary in the harness.** Necessary, insufficient: an absolute path routes around
   a name-matched rule. Belt and braces.
3. **Configure no other browser automation in caller sessions.** Removes the alternative rather than
   forbidding it.
4. **Refuse, service-side, any operation on a browser it did not launch.** Good hygiene; does not
   stop an attach, because an attach creates a *new* session pointed at a foreign browser, which is
   why (1) carries the weight.

Worth recording the distinction: **a rule callers can route around is a nudge, not a mechanism — and
every guarantee in this document is a mechanism or it is nothing.** Only the first item qualifies.

---

## Bringing it into service

Enablement is phased, and at no point is there a reachable state in which browser traffic is
unarbitrated — because arbitration is a **precondition of serving any traffic at all**. No key, no
browser.

| Phase | What happens | Why it is safe |
|---|---|---|
| **0** | Service up, tab budgets set to zero, one manual test claim | Nothing is routed to it |
| **1** | Registered as an available route, HTTP transport, one shared process. Callers are still briefed on whatever they were using | It holds its own browsers, so the worst case is resource contention rather than interference |
| **2** | Move the clean-room work over first — reviewers claim `private` | Lowest blast radius: disposable tabs, no sign-in to lose |
| **3** | Sign the regular profile in **once, by hand, by the operator**. Run a real authenticated flow end to end. Only then move stateful work over | A profile is proven by a real sign-in, not by a code read |
| **4** | Remove the alternatives, in dependency order | Anything that reads state another component writes has to go before the component that writes it |

**Nothing in this sequence adopts a browser the service did not launch.** Enablement adds a route to
the service's own two browsers and takes routes away; at no point does it take ownership of something
that was already running. That is the outward half of bidirectional isolation, and it holds during
the rollout as well as after it.

---

## Composing with a work tracker

Browser Broker is a **resource** service. If it sits alongside a system that tracks *work*, the two
compose at the orchestration level and nowhere else:

- **Session identity is a shared key that neither system owns.** Both key off whatever session
  identifier the harness issues; each stores its own copy. No foreign key, no cross-system join at
  write time.
- **A lease does not belong on a work board.** A lease is a resource fact, not a work item; putting
  it on a board makes the board overstate how much work is in flight. Visibility belongs in this
  service's own operations view, or later as a read-only widget a board fetches over HTTP.
- **Separate databases**, even if they share a server. Independent migrations, deploys and failure
  domains; sharing a server is an operational convenience, sharing a schema couples two release
  trains for nothing.
- **They compose at the orchestrator's level.** An orchestrator briefs a worker with a work item; the
  worker claims a browser. Neither system needs to know both.
- **The one genuine overlap is cost telemetry.** Both will want per-session token facts. This service
  *publishes* its capture telemetry over HTTP and never writes into another system's tables.

---

## Open questions for you

The list is short, which is the point of having settled the rest.

1. **The licence.** Not chosen here, because it is not a build's to choose. It has to be settled
   before anything is published: a public repository with no `LICENSE` file grants its readers no
   rights at all, which is almost never what publishing was for.
2. **How the one-live-claim-per-session constraint is enforced** — a hand-written unique index with
   a documented exception in the schema-drift check, or serialised enforcement in the application.
   Deliberately left to the pull request that lands it, because it should be decided with the actual
   transaction in front of it rather than in the abstract. The one thing already decided is that it
   will not be skipped: an unguarded read-then-write is not enforcement. `DECISIONS.md` §13b.

Everything else the design interview raised is settled and recorded in `DECISIONS.md` §§13a–13d. The
capture-policy numbers are **settled as provisional** rather than open: they are the starting
position, and the resolution ladder is scheduled to settle them with evidence.

---

## What's not in this plan

Deliberately out of scope, so that scope creep has somewhere to be refused:

- **A general-purpose browser API.** The tool surface is small on purpose and stays small. Anything
  that reads as "expose one more browser verb because a caller wanted it" is a proposal to
  reimplement the automation library one function at a time, and the answer is no unless it comes
  with a reason arbitration specifically requires it.
- **Hosted or remote browsers.** Page content stays on the machine that renders it. Any service that
  sends a page off-box is out on privacy grounds, not on cost.
- **Multi-machine execution.** One machine holds the browsers in the first version. The driver
  interface leaves the seam, and that is all it does.
- **A record-and-replay or test-authoring product.** Diffing exists here to make review cheap, not to
  become a visual-regression test runner. The moment a feature is best described as "fail the build
  when the pixels move", it belongs somewhere else.
- **Deciding what a caller should look at.** The service enforces cost. Which views, which
  breakpoints and which interaction states matter is a judgement it has no way to make.
- **Anything with an LLM in it.** The service arbitrates and measures. Nothing in it calls a model.

**And nothing is built yet.** This is the plan to correct. `SCHEMA.md` — the concrete shape of every
surface — comes out of the design interview, and the work queue in `MILESTONES.md` is provisional
until it does.
