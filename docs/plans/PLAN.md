# Browser Broker — the plan

**Status:** planning. This is the document to read and correct. Its companions are `SCHEMA.md` (the
concrete shape of every table, tool, command, variable and guard) and `DECISIONS.md` (every decision
with its reasoning, including what was rejected).

**Name settled 2026-08-13.** The product is **Browser Broker**; the command you type is **`broker`**.
"Broker" is what it does — it stands between callers and a scarce resource, decides who gets it, and
refuses the rest. It also avoids naming a vendor's automation library, which is an implementation
detail the requirements never mandated and which a later decision should be free to change.

---

## What this is, in one paragraph

A service that brokers access to a small, fixed set of real browsers. A caller asks for a **lease**;
it gets back a secret key and **one tab** it exclusively owns. Every later call carries that key, and
the service uses it to route the call, to decide whether that caller is allowed to do that thing to
that tab, to account for what the call costs, and to notice when the caller has stopped talking. When
capacity is full, callers queue. When a caller dies, its capacity comes back on its own.

**Nothing here is a long-running server.** The service is spawned by its caller, serves that session
and exits with it, so installation is the whole of deployment. The browsers are *not* owned by it:
whichever caller finds none running launches one, everyone after that attaches, and the browser
outlives every process that ever touched it. What holds the design together is therefore the store —
a single file — rather than a process's memory.

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

| Browser | Profile | Window | What it is for | Count |
|---|---|---|---|---|
| **regular** | persistent, signed in | **headed** | everything that needs to be somebody — all stateful work, as tabs | 1 |
| **private** | ephemeral, signed in to nothing | headless | clean-room work: design review, first-visit behaviour, anything that must not inherit a session | 1 |

**One of each, started by whoever finds none running and left up afterwards** — not kept up by a
supervisor, because there is nothing resident to supervise. **The signed-in one is headed and stays
headed**: it is what a person signs into, it is the thing this design most needs not to lose, and
switching it between modes to sign in would be a chance to lose it that buys nothing. The private one
is headless, where the speed is free and there is nothing to lose.

A *browser* is a process with a storage partition. Tabs live inside it and **share that partition** —
cookies, local storage, cache, history. That is where "sign in once and every tab inherits it" comes
from, and it is also why an isolated session is not cheap: isolation at the session level costs a
whole extra browser process, whereas isolation at the tab level costs a renderer.

So the design expresses concurrency **entirely in tabs**:

- **Two browser processes is a hard ceiling that does not move with the number of callers.** Ten
  callers and one caller cost the same in processes. Memory grows by a renderer per tab (tens to a
  couple of hundred megabytes each) rather than by a browser per caller.
- **The bound is one total tab budget across both browsers** — not a count of slots, and not a
  separate allowance per browser. **A grant is one tab**, so the budget, the pool bound and the count
  of live leases are the same integer, and admission is one comparison:
  `live claims + 1 ≤ budget`, whichever browser it wants. **Need two tabs, claim twice. Default: 15.**

**Why one total and not one each.** The scarce resource is renderer processes and the memory they
hold, and a renderer costs the same whichever browser it belongs to. A per-browser cap would ration
something that is not scarce: it would refuse a fourteenth regular tab while a private allowance sat
unused, which is a refusal that protects nothing. One counter means the split falls out of demand —
14/1 on a stateful afternoon, 5/10 during a review sweep — and the only number anyone has to reason
about is the one that maps to memory.

**Why a grant is one tab and not an allowance.** Collapsing the three quantities into one deletes the
arithmetic rather than tuning it: no per-lease allowance, no reservation for a tab that has not opened
yet, no partial release, and no way for the number of leases and the number of open windows to
diverge — there is no pair of numbers that could disagree. The guidance that goes with it belongs in
the tool descriptions rather than in folklore: *work in your own single tab and navigate it between
URLs; parallel tabs are for genuine concurrency only.* A caller doing ordinary sequential work needs
one claim and never touches the queue.

**What it costs is real and is not solved here.** A caller that needs three tabs claims three times,
and two such callers can each hold part of what the other is waiting for and deadlock. It wants either
all-or-nothing admission for a multi-tab request or a specified acquire-everything-before-working
protocol with release-all on failure, and neither should be chosen without the transaction shape in
front of it. Open — `DECISIONS.md` §14, `SCHEMA.md` §2.3a.

**One tab per browser is never leased and never counted: the keeper tab.** Measured: headless, closing
a browser's final tab leaves it alive; **headed, the browser dies within 500 ms** — and the signed-in
browser is headed. Without a blank tab holding it open, the last caller to release its lease would
destroy the shared authenticated session by doing the single most correct thing a caller ever does.

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

The service works **two browsers of its own**, and the isolation between them and everything else on
the host runs in **both directions**. Both halves are requirements, and the second is the one that is
easy to miss.

**Outward — nothing this service does can disturb a browser that is not one of its two.** Other things
run browsers on the same machine: a person's own, and automation that is not part of this system at
all, which typically uses the default profile. The service never manages, attaches to, closes or
otherwise reaches any of them, and it refuses any operation naming one. It leaves them entirely
alone and entirely available.

**"Its own" is a directory, not a process handle.** Since a browser outlives every process that talks
to it, it cannot be defined as *the one this process started* — it is defined as **whatever is running
against this profile directory**. That is what makes the outward rule enforceable at all: identity
lives on disk, so a browser is either running against a directory the service owns or it is somebody
else's and untouchable.

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
- **No assumption that any other browser is absent.** The service is correct on a machine where three
  unrelated browsers are already running, because it never looks for "the browser" — only for what is
  running against its own profile directories. The port it attaches on is one the browser chose and
  recorded beside its profile, so it collides with nothing that was promised a fixed one.

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
  believes it holds a tab that it does not.
- **`renew`** resets the expiry in place, and is legal from both `queued` and `active`.
- **Every keyed call is an implicit renew.** A caller doing work never expires mid-work; the timer is
  a liveness signal, not a work limit.
- **`release`** is terminal, closes exactly that lease's tab — **one lease, one tab, one close** — and
  triggers the admission sweep.
- **The admission sweep**: while capacity exists and the queue is not empty, promote the head of the
  queue.
- **A lapse is a fact about time, not an event somebody fired.** A lease lapses at its last renewal
  plus its duration whether or not anybody was there to notice; the transition is applied by the next
  call from anyone. Which is why the record stores when the lease actually ended and not when the
  sweep saw it — the alternative produces leases expiring in clusters at instants when nothing
  happened to them, an artifact of the observer that reads like a real pattern.

### Nothing expires on a timer, because nothing is running to hold one

There is no reaper process, and inventing somewhere for one to live was rejected rather than
overlooked — a resident helper kept "just for the timer" reintroduces the whole lifecycle the
daemonless model removes, for the one responsibility that turns out not to need it. Reclamation moves
onto the calls instead:

> **Every arbitration call first expires every lapsed claim and every lapsed queue entry across the
> whole store — in the same transaction — and only then answers from the reconciled state.**

Each part of that carries weight. **Every call**, not only a claim, so a machine's capacity is not
pinned by a process nobody will ever ask about again. **Across the whole store**, not just the asking
caller's rows, for the same reason. **In the same transaction**, because a reconciliation whose result
is read by a second statement is a race against every other process doing the same reconciliation.

**The standing rule this produces: stored state is provisional, derived state is the truth.** A row
saying `active` whose expiry has elapsed is not an active lease; it is a lease that lapsed and has not
been swept yet, and the difference is invisible in the row. **Every reader that touches the store
directly must apply the same expiry derivation** — a generated operations view, a diagnostic
command, the doctor. A reader that trusts the stored state does not merely lag: it reports leases that do not
exist, which looks like the arbitration being wrong rather than the report being wrong.

### Never do browser work inside the arbitration transaction

**A hard rule, and the one whose violation would be worst.** Expiring a claim implies closing its tab,
and closing a tab is a round trip to a browser that can hang — a wedged browser does not refuse, it
simply never answers. Inside the transaction, **one unresponsive browser would block every arbitration
call on the machine**, including from callers with no interest in it, because they all need the same
writer. One stuck page would become a total outage that looked like the service being broken.

So the order is fixed: **the transaction reclaims capacity; tab cleanup happens after it commits, on a
best-effort basis.** Which makes the failure acceptable in the only form that matters:

> **A tab that fails to close is a leaked tab, not a leaked lease.**

The capacity is already back and the count is right. What is left is a window nobody owns — untidy,
recorded, recoverable by an administrative act, and strictly better than a lease nobody can reclaim.

### The queue is a real answer, not a failure

When capacity is exhausted the call **queues rather than failing**. The response carries the queue
position, an estimate, and — this part matters — an explicit statement of the expectation: *keep
checking in or lose your place*. A protocol that implies an obligation and does not state it is a
protocol whose clients will not meet it. Without that sentence a caller drops to the back for reasons
it cannot see, and from the inside "I was ordered fairly and my entry lapsed" is indistinguishable
from "this service is not serving me".

**Strictly first in, first out, with no aging and no priority** — and that is close to trivially
correct here rather than a claim about queues in general. **Every request is the same size**, so there
is nothing to skip ahead of: a freed tab fits the front of the queue, always. Aging exists to stop a
large request starving behind a stream of small ones, and where there is one size there is no such
thing as a large request. A caller's position only ever improves, by exactly one each time a tab comes
free.

**Queue entries expire by the same lazy sweep as leases, and that is what makes strictness safe.** A
caller that dies while queued consumes no capacity, so nothing else notices it is gone — and under
strict ordering it blocks everybody behind it indefinitely. A strict queue without entry expiry is a
queue with a permanent head.

### Time to live: one rule, one duration

**The mechanism is settled and uniform:** *keep pinging or lose it*, applied identically to an active
holder and to a queued client, and renewed by any keyed call. Both durations are configurable, and
**both default to ten minutes — deliberately equal** (`DECISIONS.md` §13f, `SCHEMA.md` §2.5).

**Equality is the decision, and the argument for an asymmetry does not survive inspection.** That
argument said a queued caller has nothing to renew with, being only a waiter. It does: **polling is
renewing.** The status call already renews, and asking whether anything has changed is exactly the
work a waiting caller has, continuously.

**And the cost runs the opposite way from the direction an asymmetry assumes.** Under strict first in,
first out, **a queue place held longer blocks everyone behind it.** A generous queued lifetime is
therefore the harsher setting, not the kinder one: it protects one distracted waiter at the price of
stalling every caller behind it for the same duration. Equality is what treats the queue as the shared
resource it is.

Two things make equality safe rather than merely defensible, and both are contract details rather than
numbers:

- **Release gives back a queue place as well as a lease.** Without it a queued caller that changes its
  mind has no exit — it can only stop polling and block everything behind it for a full lifetime while
  having already decided it does not want the tab. The verb that means *I am done* has to mean it in
  both states.
- **Every queued response carries a scheduling nudge**, naming a check-back time just under the
  lifetime. Told only *your place expires in ten minutes*, a caller agrees, intends to return, and is
  gone; told *check back in nine*, it has something it can act on now. The service knows the number,
  and withholding it is how a fair queue produces unfair outcomes.

**This is the mechanism that reclaims capacity from a caller that died holding it** — the one failure
no client-side convention can cover, because the client that ought to clean up is the one that is
gone.

If the transport can tell the service that a client disconnected, that shortens the effective expiry
to a brief grace period rather than revoking immediately, since clients do reconnect. If it cannot,
the time to live is the whole answer and the design says so rather than assuming a signal it may not
get.

### What reclaims what — the whole rule in one line

> **Every reclamation is tab-scoped and lease-scoped. Nothing is ever browser-scoped.**

Releasing closes exactly that lease's tab; expiry does the same; revoking does the same — each by the
identifier recorded when the tab was opened. The browsers are shared and are never closed by any
caller's action, directly or indirectly. This is not a rule clients are asked to respect; there is no
operation through which they could do otherwise. Reaping or restarting a browser exists as a
command a person runs, never as a verb on the agent's surface.

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
  only when it genuinely needs to *look*. When it names an earlier capture to diff against, what comes
  back is the same shape, with the crops and the numbers alongside it.
- **`read` returns a path to a file on disk** — the accessibility snapshot by default, with the
  console, the network log and a cookie summary as explicit opt-ins. The caller greps the part it
  needs instead of ingesting all of it.
- **`evaluate` returns small JSON inline**, spilling to a path past a byte cap. This is the cheap
  path and it is meant to be used.
- **Lease operations return inline.** They are tiny.

### Evaluating inside a page is not running code inside the service

Two parts of this plan pull against each other: the contract keeps `evaluate`, and the
deliberately-absent list says no arbitrary script execution. Both are right about different things,
and the line between them is **scope**.

- **In scope: evaluation inside the page.** The expression runs in the page and can do what that
  page's own scripts can do. It is the cheapest and most accurate way to read a computed style, a
  contrast ratio, a box's geometry, spacing or line height — a few hundred tokens of structured data,
  and *more* accurate than a model estimating them off a picture.
- **Out of scope: code running in the service's own process**, with the automation library, the
  filesystem and the network in reach. That is a different capability entirely and nothing exposes
  it.

**And the residual, stated rather than glossed.** On the signed-in browser, an expression evaluated
in a page can read that page's own stored data, and no rule closes that without breaking the feature
— a page's scripts reading their own storage is the platform working as designed. **Evaluate is
allowed on both browsers, the signed-in one included**, with no allowlist of permitted expressions and
no filtering of what comes back on that path. The position is that **a lease on the signed-in browser
already grants the ability to act as the signed-in user**, which is what the lease is *for*, so
evaluation widens nothing; a restricted vocabulary would have to be guessed in advance, and every
measurement nobody guessed becomes a screenshot instead. Narrowly refusing the obvious storage
accessors was considered and rejected as theatre: it stops nobody and it teaches a reader that the
hole is closed.

**The exposure is handled where every path converges — at the point anything is written to disk.** One
shape-matcher runs over every artifact the service writes, which is the right place rather than a
compromise: **a page snapshot can capture a rendered credential with nobody having chosen to evaluate
anything**, and a control on the evaluate path would never have been near it. It matches shapes, never
a list of real values, for the reason `CLAUDE.md` gives. Alongside it, **which browser each evaluation
ran against is recorded** — a record, not a restriction, so that *"what has been evaluated against the
signed-in profile"* has an answer at all. `SCHEMA.md` §3.10 has the full reasoning.

### A deliberately small surface

**Ten tools, not forty.** Every tool's description is resident in a connected agent's context on
every turn whether or not anything calls it, so surface area is a standing tax on every session. The
concrete list lives in `SCHEMA.md`; the principle is that browser *actions* collapse into one tool
with an action enum rather than one tool per verb, and the trade-off — an enum is less discoverable,
and its error messages have to work harder — is accepted deliberately.

**What decides whether something gets its own name is a two-part test**, and it is narrower than
"folding hides things":

> **A separate tool when something must be able to refuse it by name, or when it changes what the
> caller owns. Folded otherwise.**

That is why a destructive operation keeps its own name — a rule that matches on the operation's name
becomes invisible the moment the operation is a parameter — while a comparison or a viewport resize
folds without costing anything, because nothing needs to refuse those by name and neither changes what
the caller holds.

**The action tool absorbs more than clicking and typing.** Click, type, fill, press, select, hover,
check and scroll, plus **resize**, **dialog handling**, drag and drop, and a **batch fill** taking an
array of field-and-value pairs in one call. That last one is measurement, not taste: **78 calls across
35 sessions** were filling forms one field at a time.

**Two of those additions were found by counting rather than by reasoning**, and both are worth naming
because the reasoning had been careful and still missed them:

- **Resize: 578 calls across 140 sessions — 58% of every session that used browser automation at all,
  and the sixth most-used verb**, measured across 2,007 transcripts. A surface without it makes
  responsive review *inexpressible* rather than awkward, because viewport size is context-scoped and
  evaluating an expression on the page structurally cannot reach it. The measured dominant loop is
  resize → navigate → evaluate → screenshot, once per breakpoint.
- **Dialog handling: 8 calls**, far below anything frequency would justify, and added anyway because
  the argument is not about frequency. **An unhandled dialog blocks a tab, and a blocked tab burns the
  lease** — a rare event that consumes scarce capacity for a full lifetime while the caller cannot
  explain why. Add a capability at low measured usage when its absence costs the invariant rather than
  the caller's convenience.

**Measured at zero across 2,007 transcripts and deliberately skipped: drag, drop and back-navigation.**
Zero over that many transcripts is a real result and a different claim from *nobody thought of it*; if
one arrives as a genuine request later, it arrives with that count to argue against.

**Every operation is singular in its tab**, because a lease is one tab. There is no plural close and
nothing that takes a list of tabs. **There is no close-your-tab verb either** — with a lease fixed at
one tab, closing it left a caller holding a lease that owned nothing, a state reachable by doing
something perfectly reasonable and which every capacity count then had to be correct about. The state
is removed rather than guarded: **a lease is a tab, and the verb that ends one is release.**

**A replace survives, for one named reason: a crashed tab.** It discards this lease's tab and opens a
genuinely fresh one, with no history, in its place. That is the case navigation cannot fix — a wedged
or dead tab does not navigate — and recording the reason is what stops it reading as a worse spelling
of navigate and being proposed for deletion.

**Comparison is an argument, not a tool.** There is no separate compare verb and nothing administrative
behind one, because there is nothing to administer: a capture is a capture with an identifier, and a
diff is an optional argument on the capture tool naming which earlier capture to compare against. What
does *not* fold is the rule the whole surface sits inside: **the agent surface exposes no
browser-scoped destructive operation, ever.**

**Reading is filtered, and the filter is free.** The accessibility snapshot comes back by default;
console, network and cookies are explicit opt-ins. That costs nothing because console and network are
accumulated continuously — the service is watching them regardless, since it holds the browser — so the
filter decides what enters the response rather than what to go and collect. Not asking for something
costs nothing, and asking for it later finds it already there. What it saves is context residency,
which is exactly the thing worth saving.

Four things are **deliberately absent**, and their absence is part of the contract:

- **Anything browser-scoped and destructive.** No close-browser, no close-all, no kill-everything, no
  delete-profile-data. A caller can release its own lease, which closes its own tab, and nothing else.
  With two shared browsers, every browser-scoped operation is a shared-fate operation: one caller ends
  every other caller's work — and since a browser outlives every process that touches it, it ends the
  work of callers that have not started yet.
- **Anything that reaches a browser outside the two.** A caller must not be able to touch a browser
  running against a profile directory this service does not own, which in practice means the person's
  own.
- **Anything that reads or writes credentials.** No storage-state dump or load, no cookie setting. A
  cookie summary returns names and domains, **never values**.
- **Any verb that runs arbitrary code in the service's own process.** This one is not a coverage gap,
  it is the exact capability the no-destructive-verb rule exists to prevent: such a verb executes with
  the filesystem, the network and the automation library in reach, so it could close the shared
  browsers or read local files — and it is the one thing on this list that would be granted by a single
  convenient-looking tool. Evaluating an expression **inside a page** is a different capability and is
  kept (below). **The presumption that page evaluation covers the real use is measured but unverified:
  328 calls across 53 sessions were counted and their arguments were never sampled**, so what those
  calls were doing is not yet known. Sampling them is owed before build — `DECISIONS.md` §14.

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

**The service defaults to the lower tier and tells the caller how to escalate**, including that
escalation requires a written reason. The default does the work; the message makes the path
discoverable to a caller that genuinely needs it.

**The reason is free text, not a fixed set of options**, and the asymmetry decides it: free text can be
classified into categories later, and a fixed set's discarded nuance cannot be recovered. A fixed set
can only ever report which of the author's guesses each caller picked, and the one thing it can never
surface is a reason nobody thought to list — which is precisely what a study meant to settle these
numbers with evidence needs to learn.

**Full-page capture is off by default.** Unbounded page height is what actually pushes an image over
the long edge, and a full-page capture of a long page is the worst offender there is.

**Nothing is ever refused on capture grounds.** Past the accounting threshold a capture is served
with a loud warning that names the cheaper alternative — the snapshot or the evaluate that answers
the same question. See `DECISIONS.md` §13d for why a warning beats a wall here.

| Control | Lives in | Why there |
|---|---|---|
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

**A capture can name an earlier capture to compare against**, and what comes back is not a boolean and
not a full-page diff mask — it is the **regions that actually changed**, cropped, as separate small
images. A review of twenty-five screenshots becomes a review of the two that moved.

**There is no canonical picture of anything.** No blessed image, no promotion, no retirement, no
per-view identity the service maintains on a caller's behalf. **A capture is a capture with an
identifier**, and a diff is an explicit request naming which earlier one to compare against — carried
as an **optional argument on the capture tool**, not as a tool of its own. No argument, no diff: just a
picture.

**Why the caller naming its own target is better rather than merely smaller.** Where the service picks
the comparison target from an identity it maintains, every way that identity can be imprecise — a
theme, a language, a signed-in persona, a consent banner, a breakpoint spelled two ways — is a way it
silently compares two things that were never the same page. Naming an identifier removes the class:
there is one target, the caller chose it, and it is either that one or the request says so. It also
deletes a required human step from the middle of an agent's work — visit one returns a picture with an
identifier, visit two passes it back, and the loop closes with nobody standing between the two visits.

**A view label is still accepted and it is purely a label.** It goes in the file name and makes a
directory legible; the service attaches no meaning to it, matches nothing on it and groups nothing by
it. Two captures sharing a label are two captures sharing a label.

**Diffing belongs in this service** because it holds the browser and takes every capture, so it is the
only thing with both images to hand. **It is also the last thing built, and nothing earlier depends on
it** — that ordering is a property worth preserving deliberately, not an accident of scheduling.

Three things to be honest about, because they decide whether it earns its place on any given run:

- **It is useless on a first visit**, where there is nothing to compare against. It is a second-visit
  optimisation living inside a service whose other features are first-visit ones. That tension is
  real; the answer is that repeat review is the common case, not that the tension is imaginary.
- **The caller carries the responsibility for tracking identifiers**, and if it tracks them badly it
  will diff against the wrong picture and get a confusing answer. That is a real transfer and it is
  accepted deliberately: an identifier the caller chose and got wrong is diagnosable in one step,
  whereas an identity the service inferred and got wrong looks exactly like a page that changed.
- **Anti-aliasing and font rendering cause false positives** without a tuned threshold, so the
  threshold is configurable and the tuning is part of the work rather than an afterthought.
- **Animation is a different problem and a threshold does not touch it.** A colour tolerance compares
  pixels in place; it has nothing to say about a banner mid-fade, a transition in flight, a blinking
  caret or an image that arrived a frame later. The answer is to settle the page before the shutter —
  stop animations, hide the caret, wait for fonts — and to let a caller paint over areas that
  legitimately move. Without that, the feature reports a change on every run forever, and an agent
  either burns the tokens the feature exists to save or learns to ignore it.

**A missing target returns a picture, never a refusal.** If the capture the caller named cannot be
found, the service returns the full screenshot and says plainly why it could not diff. The request was
still, underneath, a request for a screenshot, and that part of it can always be satisfied — refusing
the whole call would withhold something that succeeded because something optional did not, and cost a
round trip on the most expensive surface there is to arrive at exactly the picture returning it
immediately delivers. Nothing is hidden: the explanation names what was not found, and a caller that
branches on whether anything changed sees no diff rather than a wrong one.

**There is no retention on any of this**, which is what makes that situation rare. Capture files are
not swept and crop files are not swept; there is no expiry schedule for either. The service either
finds the image the caller named or it does not, and the ordinary reason it does not is that the caller
named the wrong thing — exactly the case an explanation helps with.

**One image request, one return shape, every time.** Whether the bytes are a full capture or a crop
from a diff depends on nothing except whether a diff target was passed. Returning small crops inline
under a size cap was considered and **rejected**, because **you cannot know a diff is small**: a change
to a component that appears on every page changes every page, so the diff of a one-line change is the
whole page, and the cap is discovered at the worst possible moment — after the work is done, on the
results that matter most. A conditional shape also makes every caller handle two cases forever to save
a path lookup on the cases that were cheap anyway.

The comparison itself is a solved problem and gets reused from an existing pixel-diff library. The
part that needs writing is **bounding-box extraction**: most libraries emit a mask or a count, and
what a reviewer needs is a short list of rectangles. That is connected-components over the mask —
a small piece of code, not a project.

---

## Where it runs

**One machine. The service, the browsers and the store all sit on the host that renders the pages.**
No network dependency, nothing to reach across, nothing to be partitioned from.

The automation tool the service drives is machine-local: it has no listening socket and no server
mode, and its sessions persist because the browser processes stay up. A service on one machine
therefore cannot drive a browser on another by shelling out to it — so it has to live beside its
browsers, and once it does, putting the store somewhere else buys nothing that a lease lasting minutes
actually needs.

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

**Node and TypeScript. The store is SQLite — one file, reached with plain SQL** rather than through an
object-relational mapper, so every rule is written in the language the database speaks. There is no
database server to install and nothing to keep running, which is what makes a service that is spawned
per session possible at all.

**The measurements that decided it, taken rather than cited:** 28 ms of process startup against 126, a
first query at 0.04 ms against roughly 35, and 27 MB in one package against 325 MB in 129. **The 35 ms
is what decides it, and only because of the deployment model** — that figure is per-process
initialisation, invisible in a server that pays it once at startup, and paid on every spawn here. A
fixed cost becomes a per-call cost when the process becomes per-call. Install weight is the second
reason, and a real one for anybody cloning a public repository to try it.

**The third reason turned out to be decisive rather than incidental: partial unique indexes.** They
carry this schema's most important guarantees — *one live claim per session*, *one live row per
physical tab* — and in plain SQL they are expressed directly and enforced by the storage engine, so two
processes racing to claim the same thing do not both succeed. **Measured working**, along with a
partial non-unique index that makes the capacity count an index-only scan. A guarantee that lives in
the engine is the only kind that survives a caller doing something nobody anticipated.

**The honest count is two.** A third such index would have guarded the canonical-picture concept, and
that concept is not part of this design — so the storage argument carries two verified indexes rather
than three, which weakens it by one and breaks nothing: both correctness guarantees above hold, and
the startup and install measurements are untouched. The count is stated here rather than absorbed,
because a number quietly rounded up is how an argument outlives its evidence (`DECISIONS.md` §13f).

**What is given up, recorded so the trade is honest: migration tooling.** In its place, the schema is
a version stepper the service applies to its own store on every spawn. That fits the model better than
a migration command does, because there is no deployment step to hang one off and no operator moment
at which to run one. Every spawn is the deploy.

**Where the file lives:** the operating system's application-data directory by default, resolved at
runtime and never written down here. **It is overridable by an environment variable and by nothing
else** — not by a setting in the store, because a value that says where the store lives cannot live in
the store; a bad one there breaks the very surface you would have to reach to correct it.

**And the service refuses to start on a network location**, rather than warning. The write-ahead log's
shared-memory index requires every process using the database to be on the same host, which a network
share is precisely not — and this design has many processes touching one file by construction. The
detection takes two checks, because **a mapped network drive is lexically identical to a local one**:
inspect the resolved path's root, *and* ask the operating system what the volume actually is. A check
that does only the first looks like a guard while passing the most ordinary way there is of getting
this wrong.

### Configuration is the environment, and a fresh install runs with nothing set

**Every value the service reads is an environment variable with a working default.** There is no
settings table, no stored overrides, no revision counter and no configuration command. A
`.env.example` ships in the repository listing every variable, its options and its default — that file
is the registry, and it is checkable by reading it beside the code.

**A table was considered and it has no consumer.** The one thing it would genuinely buy is answered
below for the price of a single row; everything else it would need — a writer, a validator, a
migration, a surface to edit it from — is apparatus whose only justification is that it exists.
Nothing is served (below), so there is nothing to edit settings *from* in the first place.

**One value cannot be an environment variable alone, and the reason does not generalise: the tab
budget.** Several processes arbitrate against it simultaneously. If one process's environment says
fifteen and another's says thirty, each admits callers against its own belief, each is internally
consistent, and **the ceiling silently stops being a ceiling** — the count is correct in every process
and the machine is over budget anyway.

> **The first process to open the store writes its budget in. Any later process whose environment
> disagrees refuses to start and says so, naming both numbers.**

It does not adopt the stored value, because a process running against a bound it was not configured for
is a configuration error somebody needs to see; it does not overwrite it either, because that would let
whichever process started most recently move a bound the others are mid-arbitration against. A startup
refusal is the loudest place this can surface and the cheapest to fix.

**Lease lifetime deliberately gets no such check**, and the distinction is the rule worth carrying:
processes running different lifetimes reclaim at different times, which is **degraded behaviour rather
than a broken invariant** — no lease is double-issued and no capacity is lost, some things simply
expire sooner than their holder expected. **A value several processes must agree on to keep an
invariant gets the check; a value they merely ought to agree on for consistent behaviour does not.**

**And there is no retention setting**, because there is no retention. Capture files and crop files are
never swept, so no schedule exists to configure.

### Spawned per session, not run as a server

**The client starts the service, it serves that session, and it exits when the session ends.** There
is no daemon to install, no service to configure, nothing to start on boot or restart on crash, no
port to keep free, and no class of failure that consists of the process being dead while everything
depending on it assumes otherwise. **Installation is the whole of deployment**, which removes the
entire category of setup that makes people not bother.

**What it costs is stated rather than discovered, because most of this document is shaped by it:**

- **Nothing can happen on a timer.** No sweeper, no expiry loop, no background reconciliation —
  everything that has to happen eventually happens on a call.
- **There is no shared memory between callers.** Every fact two callers must agree on lives in the
  store, and the store is the only synchronisation primitive there is. **Concurrency is between
  operating-system processes**, not between connections inside one.
- **Per-process startup cost is paid on every call**, which is what decides the storage layer above.
- **Nothing is listening**, so anything that assumed a socket has lost its premise.

**Concurrency is therefore the database's problem, and the transaction mode is part of the correctness
argument rather than a tuning choice.** Measured: 30 concurrent processes, each taking a transaction
that declares its intent to write at the moment it opens — all 30 succeed, no repeats, no lost writes.
The same test with a deferred transaction and a widened read-then-write window **fails 15 times out of
25**, with an error the busy-timeout setting cannot retry. **The trap is that the deferred version
passes at low contention**, which is exactly the condition a test suite reproduces and a busy machine
does not. And the hot path here — sweep, then count, then insert — is a wide read-then-write window by
construction.

> **The standing invariant: what this buys is writer serialisation, not full serialisability**, and
> the difference stays invisible only while **every arbitration path writes.** The lazy sweep is what
> makes that true. A read-only fast path — *"checking status does not need to sweep"* — would silently
> reopen the hole, **and it would pass a low-contention test suite.** Anything added to the
> arbitration surface must either write, or be argued against this paragraph explicitly.

**Ownership checks carry weight here that they would not carry in a per-session world.** The browsers
are shared between callers that know nothing about each other, so a check on who owns a tab is the
only thing standing between two of them — where every session had browsers to itself, such a check
would have nothing to protect.

### The browsers are adopted, not owned

**Exactly two browsers remains the ceiling. What changes is who owns them: nobody**, because a process
that dies with its session cannot own something that has to outlive it.

**Whichever caller finds no browser running launches one; everyone after that attaches to what is
already there.** There is no privileged starter and no first-run step anybody has to remember.
Attaching is the ordinary case and launching is the rare one, which is the opposite of how it reads.
The launch race is arbitrated by the same transaction that arbitrates claims — one row, one winner —
so the loser waits and attaches rather than starting a second browser.

**Measured, and the measurements are why the launch works the way it does:**

| What was tried | What happened |
|---|---|
| Launching through the automation library's own launcher, then closing that client | **The browser died with it.** The launching call owns what it starts — correct for a test, fatal for a shared browser |
| Attaching to an already-running browser, then closing that client | **Unaffected.** An attaching caller does not own what it did not start |
| Spawning the browser binary **detached**, then killing the spawning process uncleanly | **The browser survived** — healthy and re-attachable for around **90 minutes**, pages intact |

So a cold start spawns the browser binary directly and detached. Attach and detach cycles were also
measured to be non-destructive to tabs, cookies and local storage, which is the property that makes
serial attachment by unrelated processes safe at all.

**Profile identity therefore moves to disk**, and that is what makes an explicit profile directory
mandatory for a second independent reason: bidirectional isolation wanted one so nothing outside could
block the service, and adoption wants one because without a stable path there is nothing to attach to.
Two arguments converging on one requirement is the strongest position a requirement can be in.

**A launch is never inferred to have worked.** A second browser started against a profile directory
already in use **does not report a lock error**: it hands its address to the browser already holding
the profile and exits successfully, with nothing on the error stream and no debugging endpoint opened.
So success is *having an endpoint that answers*, asserted positively — not a launch command returning
zero, which is the one signal a caller is most likely to trust and the one measured to be misleading.

**Discovery is a port the browser chooses and records beside its own profile.** Nothing fixed, and
nothing this service picks: a fixed port collides with whatever else on the host wanted it, and a
record kept anywhere other than the profile directory is a second place the truth lives. The record
was measured to **survive a hard kill** — still readable, still naming a port that answered nothing —
so it is **a claim, not a proof**: a caller checks that the endpoint answers *and* that the browser
identifies itself as the one expected, because ports are reused and matching a number alone would
attach to a stranger.

---

## Adapters, and the suite that keeps them honest

- **A core service layer** holds the lease, the queue, the expiry rules, the ownership rules and the
  capture policy. It is the only thing that talks to the browser driver, and it runs inside whichever
  short-lived process invoked it.
- **Two adapters**, both thin shells over it: the **nine-tool surface** a caller's own spawned process
  serves, and the **`broker` command line** (people, and scripts). There is no third.
- **A shared conformance suite** runs the same cases against every adapter and asserts **identical
  operations and identical refusals**. Registering an adapter is mandatory: adding one without adding
  it to the suite must itself fail.

### The operations view is a file, not a page that is served

**Nothing listens on a socket, so nothing is reachable, and the whole question of what may reach it
closes by subtraction** — no binding to decide, no token to issue, no unauthenticated surface to
reason about.

**The operations view is a self-contained HTML file**, styling and behaviour inlined, produced by a
command and opened from disk by a person. It is generated from the command line only: a person runs it,
no caller has a use for it, and putting it on the tool surface would spend context residency on an
operation nothing calls.

**It is a snapshot and it says so**, labelled with the moment it describes. It does not refresh and it
does not poll. That is the honest property for a document read from disk — a page that looks live and
is not is worse than one that plainly announces it is a photograph, because only the second tells a
reader when to regenerate it.

**Generating it inside a live session is what makes it worth anything.** The command runs where the
browsers are reachable, so it **reads each tab's current address from the browser itself** rather than
from any stored copy — and nothing stores one, for that reason (below). That read is bounded by a
timeout, and **a browser that does not answer renders as unreachable rather than hanging the
generation**: the report degrades to a named gap, which is what the rule about browser round trips
demands everywhere else.

**Two endpoints that a resident process would have wanted do not exist.** There is nothing to write
settings to, since configuration is the environment. And there is nothing to ask *whether the service
is alive*, because something is only askable that if it is supposed to be alive continuously — the
doctor command does that job in the shape this deployment actually has, by being run.

**Like every reader, it is bound by the rule that makes readers correct**: stored state is provisional,
derived state is the truth. A view rendering a stored state without applying the expiry derivation
reports lapsed leases as live, and it would do so most on the busiest installation.

### Nothing stores what page a tab is on

**The store keeps no copy of a tab's address.** Such a column would be a cached copy of something the
browser already knows, and its only reader generates while the browser is reachable and can therefore
ask the source. **A cache read exclusively at moments when the source is available is not a cache; it
is a second version of the truth waiting to disagree with the first.**

Three consequences, and the middle one is why this is a decision rather than a tidy-up:

- **It removes the most sensitive field in the design.** A page address is the single thing most likely
  to record where somebody actually went.
- **It makes the private browser trivially leak-free.** That browser's whole promise is that it leaves
  nothing behind, and a promise kept by storing nothing needs no guard, no test and no reviewer to
  notice when a later change quietly widens it. **Nothing stored is nothing to leak.**
- **It makes a clear-history command unnecessary.** A command to erase the record is only needed where
  there is a record.

The command-line adapter is worth building even if no agent ever calls it. It is the cheapest
available proof that the rules live in the service layer rather than inside a tool handler — a rule
that lives in a handler is a rule that holds on one route and nowhere else. It also inherits the
consequence of lazy reclamation, which is worth stating because it surprises people once: **any
command that goes through arbitration performs the sweep**, so a listing command can close somebody
else's lapsed tabs.

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
   mechanism**, and it is the one that also closes the attach-to-a-running-browser hole. Attaching
   is not itself the problem — it is how every caller after the first reaches the two browsers. The
   hole is that the same operation, in a caller's own hands, points anywhere: at a browser running
   against a profile directory this service knows nothing about.
2. **Deny-list the binary in the harness.** Necessary, insufficient: an absolute path routes around
   a name-matched rule. Belt and braces.
3. **Configure no other browser automation in caller sessions.** Removes the alternative rather than
   forbidding it.
4. **Refuse, service-side, any operation on a browser that is not running against one of its own
   profile directories.** Good hygiene; does not stop an attach, because an attach creates a *new*
   session pointed at a foreign browser, which is why (1) carries the weight.

Worth recording the distinction: **a rule callers can route around is a nudge, not a mechanism — and
every guarantee in this document is a mechanism or it is nothing.** Only the first item qualifies.

---

## Bringing it into service

**Installation is the whole of deployment.** The service is added to a client's configuration and
spawned per session; the first run creates the store and the profile directories, and every run after
that finds them. There is nothing to provision, nothing to start and nothing to keep alive.

**The one manual step in the whole of it is a person signing into the persistent browser, once, in a
headed window.** That is a step no code can take, and it is the only one.

Enablement is phased, and at no point is there a reachable state in which browser traffic is
unarbitrated — because arbitration is a **precondition of serving any traffic at all**. No key, no
browser.

| Phase | What happens | Why it is safe |
|---|---|---|
| **0** | Installed, tab budget set to zero, one manual test claim from the command line | Nothing is routed to it |
| **1** | Registered as an available route. Nothing yet depends on it | It works its own two browsers, so the worst case is resource contention rather than interference |
| **2** | Move the clean-room work over first — reviewers claim `private` | Lowest blast radius: disposable tabs, no sign-in to lose |
| **3** | Sign the regular profile in **once, by hand, by the operator** — into the window that is already open, with nothing stopped and nothing relaunched. Run a real authenticated flow end to end. Only then move stateful work over | A profile is proven by a real sign-in, not by a code read. Signing in is a service operation so it can refuse while any live lease holds a tab on that browser |
| **4** | Close every other route to a browser, in dependency order | Anything that reads state another component writes has to go before the component that writes it |

**Nothing in this sequence reaches a browser outside the two.** Callers attach to browsers running
against the service's own profile directories, and to nothing else; enablement adds a route to those
two and takes other routes away. At no point does it reach something unrelated that was already
running. That is the outward half of bidirectional isolation, and it holds during the rollout as well
as after it.

**There is no phase in which something is brought up and left running**, because there is nothing to
bring up: each phase is a change to what callers are configured to reach, not to what is resident on
the machine.

---

## Composing with a work tracker

Browser Broker is a **resource** service. If it sits alongside a system that tracks *work*, the two
compose at the orchestration level and nowhere else:

- **Session identity is a shared key that neither system owns.** Both key off whatever session
  identifier the harness issues; each stores its own copy. No foreign key, no cross-system join at
  write time.
- **A lease does not belong on a work board.** A lease is a resource fact, not a work item; putting
  it on a board makes the board overstate how much work is in flight. Visibility belongs in this
  service's own generated operations view — and because that view is a plain reader of the same data
  anything else would read, a second consumer stays possible without a redesign.
- **Separate stores.** This one is a single file of its own, and nothing else writes to it. Sharing a
  schema would couple two things that have no reason to release together.
- **They compose at the orchestrator's level.** An orchestrator briefs a worker with a work item; the
  worker claims a browser. Neither system needs to know both.
- **The one genuine overlap is cost telemetry.** Both will want per-session token facts. This service
  *exposes* its capture telemetry to be read and never writes into another system's tables.

---

## What is still open

**The nine questions `SCHEMA.md` carried are all closed**, and its header records each ruling beside
the thing it is about. Most were closed by deletion rather than by decision — the baseline, the
settings table and the served surface all left the design, and a question about a thing that does not
exist needs no answer. `DECISIONS.md` §14 is the authoritative list of what remains, and it is three
items:

1. **Whether page evaluation genuinely covers the use an arbitrary-code verb was serving.** Such a
   verb is deliberately not implemented (above). The presumption is that evaluating an expression
   inside a page absorbs the real work, and **that presumption is measured but unverified: 328 calls
   across 53 sessions were counted and their arguments were never sampled.** If a material share of
   them reach outside a page context, the presumption is false and the surface is short a capability.
   **Owed before build**, and the work is small — sample the arguments, classify them, record the
   split.
2. **How a multi-tab caller avoids deadlocking** (`SCHEMA.md` §2.3a). A grant is one tab, so a caller
   wanting three claims three times and can hold two while waiting on a third another caller holds.
   It wants either all-or-nothing admission or a specified acquire-everything-before-working protocol
   with release-all on failure, and the choice belongs to the work that lands admission.
3. **The capture-policy numbers.** The tiers are reasoned to rather than measured, and the
   resolution-ladder study exists to settle them with evidence. The escalation reason's *shape* is
   settled as free text, which is what makes that study able to learn anything; the **numbers** are
   what is still open.

**The licence is settled and carried: MIT**, with a `LICENSE` file in the repository and the
declaration in `package.json` (`DECISIONS.md` §13e).

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
- **A resident helper kept "just for the timer".** It will be proposed, because lazy reclamation
  looks like a workaround for a missing sweeper. It is not: making stored state provisional by design
  is the stronger model, and a helper reintroduces the entire lifecycle — install, start, supervise,
  notice it died — for the one responsibility that turns out not to need it.
- **An array of browsers.** The browser channel is configurable per browser, defaulting to the same
  channel for both, and that is the extent of it. **There are still exactly two.** The ceiling is the
  point: it does not scale with the number of callers, and a configurable channel is not a licence to
  make it a list.
- **A verb that runs arbitrary code in the service's own process.** Named here as well as on the
  absent list, because it is the single most likely thing to be proposed as a convenience and it grants
  the filesystem, the network and the automation library in one argument.

**And nothing is built yet.** This is the plan to correct, and the work queue in `MILESTONES.md`
follows from it.
