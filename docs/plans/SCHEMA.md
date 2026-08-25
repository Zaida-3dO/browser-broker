# Browser Broker — what is being built, in concrete terms

Companion to `PLAN.md` (how it works, in prose) and `DECISIONS.md` (why, including what was
rejected). `MILESTONES.md` carries the work queue **and the implementation mechanics** — the
transaction shapes, the indexes, the raw SQL, the test construction.

**This document is written for the person who has to agree to it, not for the person who has to
build it.** So it says what is stored, what each surface offers, what the service refuses to do,
what that costs, and what is still undecided. Nothing here asks you to hold an algorithm in your
head. Where a decision needed a transaction shape or an index to be pinned down, that detail sits in
`MILESTONES.md` against the piece of work that will implement it — it is real design and it is
written down, just addressed to the reader who needs it.

**Status: draft for review. Nothing is built.** The store is **SQLite — one file, reached with plain
SQL** rather than through an object-relational mapper, so the types below are SQLite's and every rule
in this document is written directly in the language the database speaks. §1.0 says where that file
lives and what the service refuses to put it on. Where a number appears, somebody reasoned to it and
the reasoning is beside it, so it can be argued with rather than inherited.

**And there is no server sitting there waiting.** The service is **spawned by a caller, per session,
and exits with it** — so "the process" in this document means whichever short-lived process is
holding the file at that moment, and there may be several at once. That is the single property most
of the design below is shaped by, and §1.0a is the paragraph to read before any of the tables.

**Nothing is served, either.** There are **two routes in** — the tool surface an agent calls, and the
command line — and neither listens on anything. Looking at what is happening is a **file a command
generates and a person opens** (§4), not a page that has to be up.

Sections are numbered so a comment can cite `§3.4` rather than "the bit about the queue" — which is
why §3.6 and §3.12 are left vacant where tools were deleted, rather than renumbered.

---

## What needed your decision — all nine are settled

**Nine questions could not be answered from inside the design. Every one of them is closed, and
there is no ❓ NEEDS YOUR INPUT block left in this document.** Each is recorded below with its ruling
and where the consequence is written out, so the reasoning is auditable rather than merely applied.

**Most of them were dissolved rather than answered**, which is a stronger outcome and worth naming
as one: the thing the question asked about stopped existing, so there is nothing left to get wrong.
A question that is answered leaves a decision somebody has to keep honouring. A question that is
dissolved leaves nothing at all.

| | Question | Ruling | Where |
|---|---|---|---|
| 1 | Do capture files carry a version in their name? | **Dissolved.** No baselines, so no lineage for a name to carry. The naming rule is settled and derives the page slug from the address | §1.7a |
| 2 | Who creates the first baseline? | **Dissolved.** There is no baseline. A diff names the capture to compare against | §1.8 |
| 3 | How do the comparison's crop images reach a caller elsewhere? | **Answered:** one image endpoint, one return shape. The rejected inline-crop option is gone | §1.9 |
| 4 | Is a database-backed settings table worth it with no front end? | **Answered: no.** Every value is an environment variable with a working default. This reverses §1.10's own recommendation | §1.10, §6 |
| 5 | How does a multi-tab caller avoid deadlocking? | **Closed.** Nothing is added to admission — but a caller that is its own obstacle is told so, and told what to do about it | §2.3a |
| 6 | How much of a page address is stored? | **Dissolved.** The column that stored one is deleted | §1.4 |
| 7 | Should a queue place outlive a lease? | **Answered: no — the two are equal, ten minutes each.** This reverses the "must not be equal" rule | §2.5 |
| 8 | Free text or a fixed set for a capture escalation reason? | **Answered: free text**, because the study needs to learn what nobody guessed | §3.11 |
| 9 | Does the operations surface stay unauthenticated off the machine? | **Moot.** Nothing is served, so there is no binding to decide | §4.1 |
| — | The licence. | Still owed before publication | §9.1 |

**Four deletions did most of that work, and each is larger than the question it closed.** They are
set out where they belong and summarised in §9.2:

1. **The baseline concept is gone entirely** — no canonical picture, no promotion, no `baselines`
   table, no comparison tool. A capture is a capture with an identifier, and **a diff is an explicit
   request naming which prior capture to compare against**, carried as an optional argument on
   `browser_capture` (§1.8, §3.11).
2. **The settings table is gone** — every value is an environment variable with a working default,
   so a fresh install runs with nothing set (§1.10, §6).
3. **Nothing is served** — the operations view is a self-contained file a command generates and a
   person opens (§4).
4. **`tabs.last_url` is gone** — the most sensitive column in the design was a cached copy of
   something the browser already knows (§1.4).

**Three questions left this list earlier, and none left by being dropped.** How the "one live X"
rules are enforced was settled by measurement (§1.11). Strict queue order stopped being a trade-off
when every request became the same size (§2.5). And **evaluating inside a page is allowed on both
browsers, including the signed-in one** (§3.10): the exposure it was worried about is better handled
where every path converges, at the point anything is written to disk, than on the one path somebody
thought to ask about.

---

## 1. Tables

### 1.0 Where the store lives, and the one place it may not

**One SQLite file.** No database server to install, nothing to keep running, nothing to connect to
over a socket — which is what makes a service that is spawned per session and exits with it possible
at all. A caller starts the service, it opens the file, it does its work, it exits. The next caller
opens the same file.

**Where the file is, by default:** a directory of the service's own inside the per-user
application-data location the platform defines, which is a different path on each operating system
and is the platform's own answer to "where does an application keep its state". Nothing about that
path is written down here, because writing one down would name one machine (§1.7a).

**It is overridable by an environment variable and by nothing else.** Not a setting, not a flag
stored in a table — for the reason §6.1 gives in general and which is at its sharpest here: **the
location of the database cannot be stored in the database.** A value that is only readable after you
have opened the file cannot tell you which file to open, and a wrong value stored inside would be
unfixable through the surface it broke.

**The service refuses to start on a network location, and this is a refusal rather than a warning.**
SQLite's write-ahead log — the mode that lets several processes read while one writes, which is the
whole basis of §1.0a — coordinates through a **shared-memory index that requires every process using
the database to be on the same host**. The SQLite documentation states this outright rather than
leaving it to be discovered (`sqlite.org/wal.html`). On a network filesystem that requirement is
simply not met, and the failure is not a clean error: it is two hosts each believing they hold the
writer's position, which is corruption rather than contention.

**The detection needs two independent checks, and one is not enough.** Both run on the *resolved*
path:

| Check | Catches | Why the other check misses it |
|---|---|---|
| The resolved path's root is a network share | A path written as a share directly | A share can also be presented to the process as an ordinary drive letter with nothing in the path to say so |
| The volume's reported type is a network volume | A network location mounted so that it looks local | **A mapped network drive is lexically identical to a local one.** No amount of reading the string can tell them apart, because there is nothing in the string to read |

That second row is the reason there are two checks rather than one clean one. It would be
comfortable to believe a path can be judged by looking at it; it cannot, and a design that assumed so
would pass every test anybody wrote on a machine with no network drives mapped.

### 1.0a The concurrency model: separate processes, not connections

**This is the single most important property in the schema, and it is not the usual one.** The
familiar version of this problem is several connections inside one long-lived process, where the
process itself can hold a lock, keep a queue, or take a mutex. **None of that exists here.** The
callers are **separate operating-system processes** that may know nothing about each other, started
at unrelated moments, and the only thing they share is the file.

So every rule in this document has to be enforced by the database, because the database is the only
thing all of them are touching.

**What was measured.** The arbitration path was exercised by **30 concurrent operating-system
processes**, each performing the read-then-write that arbitration performs:

| What was run | Result |
|---|---|
| 30 concurrent processes, each opening an **immediate** transaction | **All 30 succeeded.** The counter incremented once per process, with no repeats and no lost writes |
| The same test with a **deferred** transaction and a widened window between the read and the write | **Failed 15 times out of 25.** The failure is a busy-snapshot error, and — the part that matters — **it is not retryable by the busy-timeout setting**: the transaction's read snapshot is already stale, so waiting longer cannot rescue it |

**The trap is that the deferred version passes at low contention.** It is not subtly wrong in a way a
test would catch; it is correct until enough callers arrive at once, which is exactly the condition
nobody reproduces on a laptop and everybody hits in use. And the arbitration path is a wide
read-then-write window **by construction** — it expires what has lapsed, counts what remains, and
then writes — so it is the worst possible shape for the transaction mode that fails.

Every arbitration path therefore declares its intent to write **at the moment it opens**, which is
what makes the database serialise the writers itself instead of discovering a conflict at the end.

> **The standing invariant, and the way it will one day be broken.**
>
> **The guarantee is writer serialisation, not full serialisability**, and those are different
> promises. It holds **only because every arbitration path writes.** The lazy sweep (§2.4) is what
> makes that true: even a call that just asks "where do I stand" expires what has lapsed, so it is a
> writer.
>
> The consequence is precise and worth stating before somebody proposes it as an optimisation: **a
> read-only fast path — "just check status, do not sweep" — silently reopens the hole.** It would
> take a read snapshot, answer from it, and have no serialisation against a concurrent writer at all.
> **And it would pass a low-contention test suite**, because that is what the measurement above says
> the failure looks like. Any change that makes an arbitration call not write is a change to this
> invariant, and has to be argued as one.

### 1.1 How to read these tables, and two rules that apply to all of them

Each table below is **column · type · what it's for**. The type you can mostly read off the name;
what a column is *for* you cannot, so that column carries the weight. A column whose name does not
explain itself is a documentation failure, and the fix is a better name or a better sentence — not a
reader who is expected to already know.

**Rule one: nothing is stored that can be derived.** A second copy of a fact is a copy that can drift
out of step with the first, and the day they disagree the service has two answers and no way to say
which is right. So every column here was asked "could this be computed from something else?" — and
where the answer was yes, it is gone. §1.12 lists what that removed. Where a derived value is
**kept** anyway, the reason is stated in the table itself, and there are only two acceptable reasons:

- **the derivation is expensive** on a read that happens constantly, or
- **the source can be pruned** while the row survives.

**Rule two: rows are permanent, the ledger is prunable.** Ordinary operation deletes nothing — a
finished claim and a closed tab are both kept, because they are the record. The `events` ledger
(§1.6) is the one thing that may be trimmed. That asymmetry is what justifies most of the timestamps
stored on rows: they have to outlive the ledger that could otherwise compute them.

Two conventions that are true everywhere and are not repeated per table:

- **Time is a timestamp, and every process reads the same clock.** Expiry is measured against the
  clock the database exposes, never against a value one caller computed and passed in. Several
  processes are running by design (§1.0a), and two of them disagreeing by a second would make an
  expiry non-deterministic in a way nothing will ever reproduce. Timestamps are stored in a single
  fixed textual form that sorts in chronological order, so a comparison is a comparison and needs no
  conversion in the middle of a transaction that is holding up every other caller.
- **`created_at` and `updated_at` are on every table.** `updated_at` moves on every change, in the
  same transaction as the `events` row that change produced, so the two cannot disagree.

**Identifiers are opaque `uuid`s**, except `browsers.id`, which is one of two words because callers
type it, and `events.id`, which counts upward because it doubles as a "everything since here" cursor.

### 1.2 `browsers` — a fixed two-row table

Exactly two rows, always: the **regular** browser (persistent, signed in) and the **private** one
(ephemeral, signed in to nothing). Not a collection, no third row, no named-profile concept
(`DECISIONS.md` §6). A table rather than a constant because it makes a future relaxation a check to
loosen rather than a design to redo.

#### Which one to claim — the two browsers are a choice, not a role assignment

**Nothing in this design assigns a kind of caller to a browser.** There is no reviewer browser and no
builder browser; `browser` is an argument on `browser_claim` (§3.2) that the caller states per lease,
and the same caller may sensibly pick differently on its next claim. **The choice is about what the
work needs, and it has exactly two answers:**

| What the work is | Which browser | Why |
|---|---|---|
| **An authenticated surface** — anything behind a sign-in | **The signed-in browser.** | That is what it is for. The profile is already signed in, by hand, and the sign-in survives every process here (§1.2a). Nothing else has to be arranged. |
| **Genuinely-fresh-visitor work** — first-visit behaviour, an undismissed banner, no personalisation, a consent prompt as a stranger sees it | **The private browser.** | It is for when you specifically need *not* to be signed in. An ephemeral profile is the only way to see what a page does for somebody who has never been there. |

**This is stated because the measurement says it is not obvious. Measured, over the same month-long
corpus as the numbers in §3.8: 25 sessions hand-seeded authentication tokens into an isolated
browser** — reaching for an execute-arbitrary-code verb to fabricate a signed-in session — **while the
signed-in browser sat unused.** That is 25 sessions doing by hand, unreliably, the one thing the
signed-in browser exists to provide. A capability nobody finds is worth what an absent capability is
worth, so the guidance is written wherever the choice is made: here, on the argument itself (§3.2),
and in the tool's own description text, which is the only one of the three a calling agent reads.

> **The honest caveat, stated in the same breath as the guidance:** **tabs in the signed-in browser
> share one cookie jar.** Two callers there are clean-room relative to the private profile and
> **clean-room relative to nothing else** — not to each other. That is right for reviewing an
> authenticated surface, where every caller wants the same identity and wants it to be the real one.
> It is wrong for exercising two identities at once, and **this design declares that unsupported**
> rather than pretending otherwise: there is no per-lease profile, no storage partition and no second
> signed-in row (§3.13). A caller that needs two identities simultaneously has come to the wrong
> service, and being told that plainly is cheaper than discovering it from a test that mysteriously
> sees the wrong account.

| Column | Type | What it's for |
|---|---|---|
| `id` | `text`, primary key | `regular` or `private`, and nothing else — the database refuses any other value. Callers type this word, so an opaque key would mean a lookup for something the caller already knows. |
| `state` | enum | `stopped` · `starting` · `running` · `signing-in` · `failed`. `signing-in` is the one mode where a person is driving a window (§5.5.1); it is a state rather than a flag because claims are refused during it and a refusal wants a reason it can name. `starting` is a real state with a real duration here, and §1.2b is about the gap it names. |
| `pid` | `int`, null when stopped | The browser process. **This is the isolation fact**: the service acts on processes recorded here and on nothing else, so a browser somebody else is running is never inspected and never touched. Note the wording — *the* process, not *the process this service launched*: the browser **outlives whichever caller started it** (§1.2a), so most processes that act on it did not start it. |
| `launched_at` | timestamp, null when stopped | When the running browser started. With `pid` and `state` this is one fact about *now* — how long the thing that is up has been up, which is not the same as how long any caller has been connected to it. |
| `endpoint` | `text`, null when stopped | Where to attach, as recorded by the browser itself (§1.2c). **A claim, never a proof** — it is written when the browser starts and it survives the browser dying, so nothing may attach on the strength of this column without checking first. |
| `browser_uuid` | `text`, null when stopped | The browser's own identifier for itself, read from it when it was adopted. **What makes the endpoint safe to trust once it has been checked**: a port number can be handed to something else entirely after the browser that had it exits, and matching the port alone would attach to a stranger. |
| `restart_count` | `int` | Restarts since this installation began. **Kept although the ledger could count it** (rule one), and **re-justified without reference to any view**: it is what the restart-backoff rule (§6.2) counts against, so it is read by an enforcement path on every launch and not merely displayed. A browser that has failed its maximum number of restarts is refused, and that refusal needs a number that survives the process which observed the failures — which no process here does. The secondary reason still holds: a crash loop is invisible in `state`, which reads `running` between crashes. Counted per installation rather than per process, because no process here is long-lived enough for a per-process count to mean anything. |

**What is deliberately not here**, because each was derivable:

- **No `persistent` flag.** Whether a browser uses a persistent profile is a property of *which*
  browser it is, and there are exactly two. A column would let the row disagree with the word in it.
- **No `profile_dir`.** A browser's profile directory is the configured profile root plus its own
  `id`, so storing it stores an absolute path that the database already knows how to compute — and
  §1.7a's rule is that no absolute path is ever stored anywhere. **What is *not* optional is the
  directory itself.** An explicit profile path is **mandatory on every launch**, and that is a
  consequence of adoption (§1.2a): when a browser outlives the process that started it, the only
  thing that says *which* browser this is is the directory it is running against. Identity lives on
  disk, so there is nothing to fall back on if a launch does not state it.
- **No `last_error`.** The latest failure for a browser is the most recent failure event for it in
  `events`, which is one indexed lookup over two browsers. Storing it is a second copy of a sentence
  the ledger already holds, and the copy is the one that goes stale.
- **No `surface_verified` flag.** A browser that fails the startup capture check never reaches
  `running` (§7.2), so `state` already carries the answer and a separate boolean could only ever
  agree with it or be wrong. *Why the check exists at all*, since the name explained nothing: a
  browser launched without the right capture setting will screenshot a background tab and quietly
  return **another tab's pixels**, with no error. The check refuses to serve rather than warning,
  because the failure looks exactly like success. The refusal is recorded as an event with its
  reason, which is where "why did this fail" is answered.

**How "exactly two" holds:** the two allowed values are enforced by the database and the primary key
makes each unique, so at most two rows can exist; the first migration creates both, so at least two
do. There is no create or delete operation for a browser on any surface (§3.13).

### 1.2a Browsers are adopted, not owned

**Two long-lived browsers remain the ceiling. What changes is who owns them: nobody.** No process
here is long-lived enough to be a browser's parent — the service is spawned by a caller and exits
with it (§1.0a) — so a browser that belonged to a process would die with the first caller that
finished, taking every other caller's tabs with it.

So the model is:

- **Whichever caller finds no browser running launches one.** There is no privileged starter, no
  first-run step somebody has to remember, and no ordering requirement between callers.
- **Everyone after that attaches to it.** Attaching is the ordinary case and launching is the rare
  one, which is the opposite of how it reads.
- **The browser outlives the caller that launched it.** It is still there for the next one.

**How the launch race is arbitrated: by the same transaction that arbitrates claims** (§1.0a). Two
callers arriving at an empty machine at the same instant are the same problem as two callers claiming
the last tab, and it gets the same answer rather than a second mechanism — **one row, one winner.**
The loser does not launch a second browser; it waits and then attaches to the winner's. A second
launch would be two browsers where the design says one, with two profiles contending on one directory
lock, which is the failure §1.0's isolation rules exist to prevent.

**The launch must be detached, and this is a measured requirement rather than a preference.** Two
things were tested:

| What was tried | What happened |
|---|---|
| Launching the browser through the automation library's own launcher, then closing that client | **The browser was killed with it.** The launching call owns what it starts, which is correct for a test and fatal for a shared browser |
| Attaching to an already-running browser, then closing that client | **The browser was unaffected.** An attaching caller does not own what it did not start |
| Spawning the browser binary **detached**, then killing the spawning process **uncleanly** | **The browser survived**, stayed healthy and re-attachable for around **90 minutes**, with its pages intact |

So a cold start spawns the **browser binary directly and detached** rather than going through the
automation library's launcher — the launcher's ownership is the whole problem, and it is not
configurable away.

**Attaching and detaching were measured to be non-destructive** to tabs, cookies and local storage: a
caller connecting and disconnecting leaves the browser exactly as it found it. That is the property
the whole shared-session design rests on, and it is why it was checked rather than assumed.

### 1.2b `starting` is a gap, not an instant — and it is open

**Winning the launch race and having a browser that will accept a connection are two different
moments**, separated by however long a browser takes to come up. The winner records that it is
launching; the loser sees `starting` and waits. **What the loser is waiting for is the part that is
not specified.**

The two things it could be waiting for are not the same:

- **The winner has recorded that it launched.** Known immediately, and not sufficient: attaching now
  fails, and the failure is indistinguishable from the browser having died.
- **The debugging endpoint accepts a connection.** The thing that actually matters, and the only one
  that can be observed by trying it.

A design that treats those as one moment produces a loser that attaches too early, reports a launch
failure, and quite possibly launches a second browser in response — which is precisely the outcome
the race arbitration exists to prevent. **This is recorded as an open gap rather than papered over
with a fixed pause**, because a fixed pause is a number that is too long on every fast machine and
too short on the one slow machine where it matters. What settles it is a readiness signal the loser
can poll and a bound on how long it polls before declaring the winner failed.

### 1.2c The discovery record — a claim, not a proof

Something has to tell the next caller where to attach. The choice made here, and why:

**The browser picks its own port and records it.** It is asked to listen on an unspecified port,
which means the operating system assigns a free one, and the browser writes the resulting address
into a file **inside its own profile directory**. Two properties come from that, and both are the
reason for it:

- **No collision with anything else on the machine.** A fixed port is a guess about what else is
  running, and the design's inward-isolation rule (`PLAN.md`) says the service must start correctly
  on a machine where unrelated things are already listening.
- **The record cannot drift from the identity it describes**, because it lives inside the profile
  directory that *is* the identity (§1.2). A record kept anywhere else is a second place the truth
  lives, and the two go out of step the first time something exits badly.

> **The record survives the browser. This was verified: the file was still there, still readable and
> still naming a port, while the endpoint behind it was dead.**
>
> So the record is **a claim, not a proof**, and a caller that attaches on the strength of it alone
> is attaching to nothing — or worse, to something else. Two checks are required before it is
> trusted:
>
> 1. **Liveness.** The endpoint answers. A file is not a process.
> 2. **Identity — match the browser's own identifier, not just the port.** Ports are reused. A port
>    named in a stale record can belong to an entirely unrelated program by the time somebody reads
>    it, and a check that compares only the number will connect to it and report success.

A record that fails either check is stale: the browser is treated as not running, and whichever
caller notices takes the launch race (§1.2a).

### 1.2d Setup — how the browsers and their profiles come to exist

The rows above describe browsers. Something has to **make** them, and that is an explicit step rather
than an assumption.

**Every spawn runs it, not just the first one.** `broker init` runs it explicitly, and every process
that opens the store runs it before doing anything else — which is not belt and braces but the only
workable arrangement when there is no long-lived process to have done it once. It is **idempotent by
design**: it creates what is absent and leaves alone what is present, so running it a hundred times a
day costs a version check a hundred times a day and nothing else.

| Step | First run | Every run after |
|---|---|---|
| Database file | Created at the configured location, refusing a network one (§1.0) | Opened where it is |
| Schema | Stepped up from nothing to the version this build expects | **Stepped up from whatever version it is at**, or nothing to do if it is already there |
| The two browser rows | Created by the first schema step | Present; nothing to do |
| Profile directory, per browser | Created under the configured profile root | **Found and used as it is.** Never recreated, never cleared |
| Browsers | Launched by whichever caller finds none running (§1.2a) | Attached to |
| Report | Says which profiles it created | Says which profiles it found |

**The schema is a version stepper that self-heals on every spawn**, rather than a migration tool that
somebody runs as a deployment step. The store records the version it is at; the build knows the
version it needs; the steps between the two are applied in order, in one transaction, and a store
already at the right version is left untouched. The reason is the shape of the thing: with no
deployment moment and no long-lived process, **there is no point at which "run the migrations" could
be a separate act somebody performs.** A caller that has just upgraded and a caller that has not may
both spawn within the same minute, so the check belongs on every spawn or it belongs nowhere.

The rule that migrations are additive (`CLAUDE.md`) is unchanged and matters more here, not less: a
step that has run somewhere is history, and editing one means two installations reporting the same
version with different schemas.

**Why "found and used as it is" is the load-bearing line.** The regular browser's profile holds a
sign-in that a person put there by hand (§5.5.1). A setup step that recreated a profile because it
looked unfamiliar would silently sign that person out, and they would find out at the least
convenient moment. So the rule is one-directional: setup may create, and may never destroy.
Discarding a profile is a deliberate act with its own command, not a side effect of starting up.

**It refuses rather than guessing** when the profile root cannot be written to, or when a profile
directory exists but another process holds its lock — the second being exactly the case the design
protects against, so the refusal names it in plain words rather than reporting a generic launch
failure.

`broker doctor` reports every one of these facts and changes none of them, so "what state is this
installation in" never requires running the thing that would change it.

### 1.3 `claims` — the lease

One row per lease, live or finished. This is the entity the whole service is about.

| Column | Type | What it's for |
|---|---|---|
| `id` | `uuid`, primary key | The public name of a lease. Safe to log, to print and to show anywhere. |
| `key_hash` | `text` | **The secret key is never stored** — this is a one-way hash of it. Every call that carries a key hashes what it was handed and looks the lease up by this value. |
| `session_id` | `text` | The caller's identity, supplied by the caller. **Re-justified without the view:** it is what attributes a capture to whoever took it, so it is the join that makes the capture rows the resolution study reads (§9.3) attributable at all — the study asks which callers escalate, and a table of anonymous escalations answers nothing. It is also copied onto every refusal in the ledger (§1.6) for the same reason. Grouping several leases under one caller on the generated view (§4.5) is a use of the column, not its justification. **Not a foreign key, and there is no table of sessions** — session identity is a shared key this service does not own, so a constraint here would mean inventing a registry for something another system mints. |
| `browser_id` | `text` → `browsers.id` | Which browser this lease's tab lives in. Chosen when the lease is granted and **immutable**, because a tab cannot move between browser processes. |
| `state` | enum | `queued` · `active` · `released` · `expired` · `revoked`. Five values, three of them final. §2.1. |
| `purpose` | `text`, 3–200 characters | One line, **mandatory** — and this is the column whose justification took the most damage when the served view went away, so it is argued rather than asserted. **What it is no defence to cite:** "the operations page needs it". A required field on the most-called operation in the service cannot rest on a view somebody may never generate. **What it is justified by:** revoking. An operator taking capacity off a caller has to decide *which* caller, and `session_id` is a key some other system minted — it identifies the caller to that system and says nothing about what the tab is doing. Without `purpose` the revoke decision is made against a list of opaque identifiers, which means it is not made at all. Revoking is a real operation (§5.4) that owes its own reason (§7.1), and a decision that owes a reason needs something to reason about. **What it still costs, stated plainly:** three to two hundred characters of friction on every claim, paid by every caller, to make one comparatively rare operation possible. That is a real trade and it is made deliberately, not by inheritance. |
| `expires_at` | timestamp | When this lease lapses if nobody calls. **One column for both live states**: queued and active leases expire by the same mechanism and only the duration differs, so there is one column and one sweep rather than two of each. |
| `ttl_seconds` | `int` | The duration in force for this lease, fixed when it entered its current state. Stored rather than read from settings on each renewal, because a renewal has to extend by the duration the caller was **told** — re-reading a setting mid-lease silently changes a promise the caller has already acted on. |
| `activated_at` | timestamp, null while queued | When the lease got its tab. Null forever on one that expired while waiting. **Re-justified without the view:** it is the input to the wait estimate every queued response carries (§1.5) — how long recent leases were actually held is `ended_at` minus this column, and there is nowhere else that number can come from once the ledger has been trimmed. It also separates *"held for eleven minutes"* from *"waited eleven minutes"*, which mean opposite things, and only one of them is evidence that a duration is set wrong (§9.3). |
| `renew_count` | `int` | How many calls have extended this lease. What distinguishes a caller doing work from a caller polling to hold capacity it is not using. **Kept although the ledger could count it** (rule one): the claim row is permanent and the ledger is prunable, so the count has to live where it will survive. **Nothing acts on it in the first version** — it is the data that would justify acting, and saying so is more honest than implying a policy that does not exist. |
| `expired_at` | timestamp, null unless expired | **When the lease actually lapsed** — its last renewal plus its duration — **and not when a sweep noticed.** These are different moments and only one of them is a fact about the lease. §2.4a is why this is its own column rather than a reuse of the one below. |
| `ended_at` | timestamp, null while live | Set when the lease reaches any final state. One column rather than three, because `state` already says which. Same reason as `renew_count` for storing it: the row outlives the ledger. |
| `revoke_reason` | `text`, required only when revoked | An operator taking capacity off a caller owes a sentence, and the caller's next call is refused with it. |

**What is deliberately not here:**

- **No `tabs_granted`, and this is the column whose absence changes the most.** **A lease is one
  tab** (§2.3). There is no number to record, because there is no request size that could differ
  from one — and with it goes the entire class of question that column existed to answer, from
  "how much was reserved" to "what did this lease not use".
- **No `renewed_at`.** The last renewal is `expires_at` minus `ttl_seconds` — two columns already on
  the row. A third column agreeing with them is a third column that can stop agreeing with them.
- **No `queue_position`.** Position is a count of the queued leases that arrived earlier, computed
  when somebody asks. Storing it means rewriting every waiting row each time one is admitted.
- **No `captures_taken`.** A count over the captures of that lease, which is tens of rows.

**One session may hold several leases at once, and that is the ordinary case**, not an exception. A
caller that wants three tabs asks three times and holds three leases, each with its own key, its own
expiry and its own tab. **What this costs is set out in §2.3a**, and it is the one limit the capacity
model leaves behind.

### 1.4 `tabs` — the unit of capacity and the unit of ownership

**One live tab row per live lease, and that is now an identity rather than a limit.** A lease is a
tab (§2.3), so this table and the live part of `claims` have the same number of rows, always. What
that buys is in §2.3, and what it costs is in §2.3a.

| Column | Type | What it's for |
|---|---|---|
| `id` | `uuid`, primary key | **The tab identifier handed to callers.** Opaque, so holding one tells you nothing about any other. There is no index arithmetic to get wrong, which deletes the whole class of bug where an operation lands on a tab the caller did not mean. It is not a secret and it is not the security boundary — ownership is checked against the lease key on every call. |
| `claim_id` | `uuid` → `claims.id` | **The ownership fact.** Every tab-addressed check is a comparison against this. **Set once, never null, never changed** — which is not a convention but the reason no rule is needed to stop a tab acquiring a second owner: there is no state in which it has one (§1.11). |
| `browser_id` | `text` → `browsers.id` | Which browser holds this tab. **This is a copy of the lease's browser, and it is kept for one specific reason:** the rule *"two live rows must never name the same physical tab"* is a uniqueness rule over the pair (browser, driver's tab name), and a uniqueness rule can only be written over columns on one row. It cannot drift — the database refuses a tab whose browser disagrees with its lease's. |
| `driver_tab_id` | `text`, null until the tab opens | Whatever the automation tool calls this tab. **Never returned to a caller on any surface** — it is the tool's namespace, and exposing it hands callers a second, non-opaque way to name a tab, which is the addressing bug arriving through a different door. |
| `state` | enum | `opening` · `open` · `closing` · `closed` · `failed`. `closing` is not ceremony: it is the honest representation of *"the tool was asked and has not answered"*, and it is what stops a page that may still exist being counted as free. |
| `opened_at` · `closed_at` | timestamp, null until each happens | When the tab actually opened, and when a close was actually confirmed — not when one was asked for. Stored because the row is permanent and the ledger that could derive them is prunable. |
| `close_failed` | `boolean` | Whether the service gave up trying to close this tab after its lease's capacity had already been returned. **This is a leaked tab, not a leaked lease** (§2.4b). **Re-justified without the view:** it is the flag the administrative clear-a-leaked-tab operation (§4.3) selects on — that operation has to find its subjects, and a leaked tab is by definition one no live lease points at, so nothing else identifies it. Making it visible on the generated view (§4.5) is a use of the column, not its justification. The distinction the column preserves is the point: the budget is not affected, a page is. |
| `close_attempts` | `int` | How many closes have been asked for and not confirmed. What makes a stuck tab visible rather than merely counted, and what the sweep escalates on. |

**There is no column recording where a tab is.** That is a deliberate deletion and it is the single
largest privacy improvement available to this design, so it is stated rather than left as an absence
somebody proposes filling.

**What it would have been:** the address of the page each tab is on, kept so a reader could answer
*"what is this lease doing"*. **Why it is gone, on the argument that actually settles it:** it would
have been **a cached copy of something the browser already knows**, and it would have been read only
at a moment when the browser was available to be asked anyway. A generated view (§4) is produced by
a live process that is already attached to both browsers, so it reads the address off every open tab
directly and does not need a stored one. A column that is only ever read when its source is reachable
is a column with no consumer — it fails rule one on the ordinary derivability test, before any
privacy argument is reached.

**And the privacy consequence is not a mitigation, it is an absence.** A table of addresses kept over
months is a browsing history. There is no such table, so there is no retention setting to get wrong,
no redaction level to choose, and **no clear-history command to build** — nothing stored is nothing
to leak. The private browser becomes trivially leak-free by the same stroke: it stores nothing about
where it went, because nothing does.

**`captures.url` is a different column and survives** (§1.7). It records what one picture was of, at
one moment, and nothing else records it — a tab moves on, and the address it happened to be at when
something else asked is not the same fact as the address a stored image is an image of. The two are
easy to conflate and the justifications do not transfer.

**No column recording per-tab session storage.** A site that binds its session to per-tab storage
loses it on a new tab, in every browser, and no design can change that. The service reports it as a
note on the response rather than storing a flag implying it guards something it has decided not to
pretend to guard.

### 1.5 The queue — a state on the lease, not a table

**The queue is simply the leases whose state is `queued`, in the order they arrived.** There is no
queue table, no row moving between tables, and no second identity for a waiting caller.

That is worth stating because the alternative looks tidier and is worse. A queue table means a
waiting lease exists twice — once as a lease, once as a queue entry — and every change has to keep
both in step. The moment they disagree, the service has two answers to *"where am I"*. Admission is
one field changing on the row that was already there, which is a single write and cannot half-happen.

**Who is next, and on what field.** Ordered by **`created_at`** — when the lease was asked for —
tie-broken by `id`. It is *not* `activated_at`: that column is null for everyone in the queue, and it
is set at the moment you stop waiting, which is the answer rather than the question. The tie-break is
not decoration either: two requests in the same millisecond share a `created_at`, and without a
tie-break the front of the queue flips between reads.

**The queue, in plain language.** The budget is fifteen tabs across both browsers, and **every request
is for one tab**, because that is all a lease is (§2.3).

1. Twelve tabs are in use. You ask for one. Thirteen is within fifteen, so you are **granted**
   immediately: your lease becomes active, your tab row is created, and you get its identifier and a
   key.
2. Two more callers ask, and are granted. Fifteen tabs are in use.
3. A fourth caller asks. There is no capacity, so they are **queued**. They get a lease and a key but
   no tab, and their response tells them their position and a rough wait.
4. Two more callers ask and queue behind them.
5. You release. One tab comes back. The front of the queue is promoted: their lease flips to active
   and their tab row is created. **There is no arithmetic in that step** — there is no size to check
   a freed tab against, because every waiting request is the same size as every freed tab.
6. Anyone who stops calling in loses their place and their lease expires — and their expiry frees
   nothing, because a queued caller was never holding anything.

**Notice how much of the hard part is simply absent.** Nothing is ever partly granted, nothing waits
for a run of tabs to come free at once, and nobody is ever blocked behind a request larger than the
capacity available. **A freed tab always fits the front of the queue.** That is not a rule anybody
enforces; it is a consequence of every request being one tab.

**The wait estimate is a weak number and is labelled as one** everywhere it appears: the number
waiting ahead of you multiplied by how long recent leases were actually held. It is deliberately not
computed from the expiry, because a lease that keeps being renewed runs far past its expiry — an
estimate built on that would be confidently wrong in the common case rather than vaguely wrong in all
of them. It is, however, a **better** number than it was: with uniform request sizes, "how many are
ahead of me" translates directly into how many tabs have to come free, which is one fewer piece of
guesswork in the same calculation.

**A queued lease expires by the same sweep as a live one** (§2.4), and that expiry is load-bearing
rather than tidiness. A caller that died while waiting **consumes no capacity and blocks everyone
behind it** — it holds the front of the queue and never takes the tab it is offered. That is the one
failure in the queue that is invisible in a capacity count, because the count is correct the whole
time.

### 1.6 `events` — one row per decision, kept in order

**Every decision, allowed and refused alike.** A record containing only refusals cannot answer *"was
this rule ever actually reached"*, which is the first question anybody asks the day something behaves
oddly.

| Column | Type | What it's for |
|---|---|---|
| `id` | counter, primary key | Also the "everything since here" cursor for anything reading a slice of the ledger. |
| `at` | timestamp | When the row was written. **For an expiry this is not when the lease lapsed** — that is a different fact, and §2.4a says why it is recorded separately rather than being read off this column. |
| `kind` | enum | Which operation was attempted — the list is below. |
| `outcome` | enum | `allow` or `deny`. Separate from `kind` so *"how often is this refused"* is one question rather than a set of parallel event names that have to be kept in step. |
| `guard` | `text`, null on an allow | Which rule refused, named from §7's list. |
| `claim_id` | `uuid` → `claims.id`, null | Null on service-level rows, and on a request refused before any lease existed. |
| `tab_id` | `uuid` → `tabs.id`, null | Which tab, where the operation had one. |
| `session_id` | `text`, null | A copy of the lease's session identity, and **this is the one denormalisation in the schema that earns its place outright**: a refused request never becomes a lease, so without this column every refusal on the busiest rule in the service is anonymous. |
| `adapter` | enum | Which door the call came in through: the tool surface over either transport, the command line, or work the service did on its own behalf inside somebody else's call. **That last one is not a background job** — with no long-lived process there is nothing running in the background — so a sweep is attributed to the call that performed it. This is the column that turns *"the same rules apply on every route"* from a claim into a query. |
| `browser_id` | `text` → `browsers.id`, null | Which browser an operation ran against, where it had one. **Recorded on every evaluation specifically** (§3.10): what runs against the signed-in browser is not restricted, so it is recorded. A record, not a restriction — nothing refuses anything on the strength of this column. |
| `detail` | JSON text | The rest, shaped per kind. One queryable stream: a column per kind would be a wide, mostly-empty table, and a table per kind would turn every read of the ledger into a fifteen-way union. |

**The kinds:** a lease being requested, granted, queued, promoted, renewed, released, expired or
revoked · a tab opening, failing to open, or closing · a navigation, an action, a read, an
evaluation, a capture, a comparison · a browser launched, adopted or exited · a launch race lost · a
sweep.

A fixed list rather than free text, because a typo in free text creates a phantom category that every
count then silently misses. The list is added to only when the code that writes a new kind exists.

**What an allowed row does not record: which rules passed.** Only that the operation ran. Recording
every passing rule would multiply the ledger by the number of rules to answer a question nobody asks;
the question that *is* asked — "has this rule ever fired" — is answered by the refusals.

**Events are meant to be looked at, not merely written.** The ledger is one stream with a cursor, so
a page over it is a page over one query. `broker events` reads slices of it from the first version,
and the generated operations view (§4.5) includes the most recent entries; the shape above is what
keeps both cheap.

### 1.7 `captures` — what a picture cost

| Column | Type | What it's for |
|---|---|---|
| `id` | `uuid`, primary key | |
| `claim_id` | `uuid` → `claims.id` | Who took it. Survives the lease ending, which is the point. |
| `tab_id` | `uuid` → `tabs.id` | Which tab it came from. |
| `taken_at` | timestamp | When. |
| `kind` | enum | `viewport` · `element` · `full_page`. Also the answer to *"how often does anyone actually want a whole page"*, which decides whether the default is right. |
| `tier` | enum | `default` · `detail` · `max` — which resolution rung was asked for. Stored rather than inferred from the dimensions, because the rungs are configuration and can move between installations. |
| `reason` | `text`, **free text**, required only on the top tier | Why somebody escalated. **This column is the entire mechanism by which anyone learns why callers escalate**, which is what the resolution study needs — and §3.11 is why it is free text rather than a fixed set. |
| `source_width` · `source_height` | `int` | What the browser produced, before any shrinking. |
| `width` · `height` | `int` | What was written to disk. Equal to the pair above when nothing was shrunk, which is how "was this downscaled" is answered without a flag that could disagree with the numbers beside it. |
| `bytes` | `int` | File size. **This is what the token estimate is sanity-checked against** — the estimate is computed from the dimensions (below), and a file whose size is wildly out of step with them is the signal that a picture was not what the numbers said. Stored rather than measured on demand because measuring means opening every file to answer a question about a hundred rows. |
| `path` | `text` | Where the file is, **relative to the artifact root, never absolute** (§1.7a). This is the path the image endpoint resolves and serves (§1.9), and it is the reason that endpoint never has to accept a path from a caller. |
| `selector` | `text`, null | Which element, on an element capture. Part of what makes two captures comparable (§3.11). |
| `viewport_width` | `int` | The width the capture was taken at. **This is the breakpoint**, stored as a number rather than a name because a named set of breakpoints is a vocabulary the service would have to own and does not. Also what makes the resize action's dominant loop (§3.8) legible after the fact: a run of captures of one page at three widths is three rows differing in this column. |
| `url` | `text`, null | **What page this was a picture of.** Nothing else records it, and it is not derivable from anywhere: a tab moves on, so the tab's address at any later moment is a different fact. Without it, a set of captures somebody is diffing against each other cannot be checked for being pictures of the same page at all — which is the failure that produces a diff of everything with no explanation. **This is a different column from anything describing where a tab is**, and there is no such column (§1.4); the justifications do not transfer and conflating them is how a deleted privacy problem gets reintroduced. |
| `warned` | `boolean` | Whether the accounting warning fired on this capture. **The only way to find out whether the warning changes behaviour** is to know which captures carried one and look at what that caller did next. Not derivable after the fact: the threshold it was measured against is configuration that can move between installations. |

**What is deliberately not here:**

- **No `estimated_tokens`.** It is width times height divided by a fixed constant — a calculation
  over two columns on the same row. It is a genuinely useful number and it still appears on every
  capture response and every rollup; it is computed when asked for rather than frozen into a column
  that could disagree with the dimensions beside it.
- **No `full_page_requested`.** A full-page capture is one whose `kind` is `full_page`. Asking for
  one and getting one are the same event.
- **No version number, and no view name.** Both existed to place a capture in a lineage against a
  canonical picture, and there is no canonical picture (§1.8). A capture is a capture with an
  identifier; **the caller names which prior identifier it wants a diff against** (§3.11), so the
  service never has to work out which capture is "the previous one" and never has to be right about
  it. Ordering by `taken_at` remains available to anyone browsing, and it is a convenience rather
  than a mechanism anything depends on.

### 1.7a Where files live on disk

Browser automation produces a lot of files: a console log per tab, a network log, an accessibility
snapshot on every navigation and after every action, downloads a page triggers, and screenshots. Left
to itself, that lands wherever each tool happens to write. **Everything the service or the tool emits
has a defined home here**, so nothing has to be hunted for and a finished lease can be deleted as one
directory.

**Rooted at an environment variable**, `BROKER_ARTIFACTS_ROOT`, which defaults to a directory of the
service's own under the per-user application-data location the platform defines. An environment
variable rather than a setting for the same reason the database's own location is (§6.1): a bad value
stored in the database could only be fixed through the surface the bad value broke.

```
<artifact root>/
  claims/
    <claim id>/
      images/       captures, and the crops a comparison produces
      snapshots/    accessibility snapshots
      console/      console logs
      network/      network logs
      downloads/    anything a page downloaded
```

**One tree, no exceptions to it.** Everything the service writes is under a lease, because a lease is
the unit you delete. There is no second area holding images that outlive a lease, because there is no
category of image that does — every picture is a capture belonging to whoever took it.

**Every path stored in the database is relative to that root — never absolute.** The root can move,
and an absolute path pins every row to one machine's layout the moment it is written. A relative path
plus a root that is configuration survives the move; an absolute path turns it into a data migration.

**Nothing is returned to a caller unless it asked.** A capture returns its path, not its bytes; a
read returns a path, not a log. The files are there so the caller can open the one it needs, which is
the difference between a review that costs one picture and a review that costs twenty.

**One folder per lease is deliberate** — a lease is the unit you delete, and everything it produced
goes with it in one step.

#### File names, and why the page address is in them

**The adopted shape is `<page-slug>-<view-label>-<width>-<when>-<id>.png`.** Five parts, in that
order, because that order is what makes a directory listing sort into something a person can read:
all the pictures of one page together, then within a page all the pictures of one view, then within a
view the widths, then the sequence in time, and finally an identifier that guarantees uniqueness
without anybody coordinating. Region crops from a diff take the capture's name plus a region suffix,
so they sort immediately beside the picture they came from.

**The page slug is derived from the page address, and it is derived rather than supplied.** The
service takes the host and the path of the page actually captured — which it holds anyway, on
`captures.url` (§1.7) — and reduces it to a slug. That is what makes a directory of forty pictures
navigable at all: a caller's own label describes what it was *doing*, and the address describes what
it was *looking at*, and only the second is reliably distinct between two pieces of work that happen
to be described the same way.

**Four rules constrain that derivation, and they exist because a file name travels further than a
database column does.** This is the reasoning worth holding on to: a column is read by things that
were written to read it, whereas a file name ends up in log lines, in terminal output somebody
screenshots, in error messages, in a shell history, in the title bar of whatever opened the image.
It leaks by default and it leaks to places nobody enumerated. So:

1. **Query strings are stripped entirely**, before anything else. A query string is where identifiers,
   tokens, search terms and session material live — it is the part of an address most likely to carry
   something that should never have been written down, and it is the part least likely to help
   anybody tell two files apart.
2. **Safe characters only.** A restricted set, with everything outside it collapsed, so the name is
   the same on every filesystem and survives being pasted anywhere.
3. **Truncated to a bounded length**, so a deep path does not produce a name that is unusable or
   unprintable. What is lost to truncation is recoverable from `captures.url`; nothing depends on
   the name being complete.
4. **Never interpreted as a path.** Not on the way in and not on the way out — the derivation
   produces one path segment, and the separators that would make it more than one are not in the safe
   set. Same reasoning that refuses a local-file address in §3.7.

**A label a caller supplies is subject to rules two, three and four as well**, for the same reasons.
It is a label, not a location.

### 1.8 There is no baseline, and that is the largest deletion in this revision

**There is no canonical picture of anything.** No blessed image, no promotion, no retirement, no
`baselines` table, and no per-view identity the service maintains on a caller's behalf. **A capture
is a capture with an identifier**, and that is the whole of it.

> **A diff is an explicit request naming which prior capture to compare against.** The caller passes
> the identifier of the earlier capture as an optional argument on `browser_capture` (§3.11). No
> argument, no diff — just a picture.

**What this deletes, in one place, so nothing is discovered later as a surprise.** The `baselines`
table and every column of it: the view identity, the promotion lineage and its mandatory reason, the
retirement timestamp, and the three per-baseline tuning numbers. The uniqueness rule enforcing one
live baseline per view, browser, kind and breakpoint. Baseline management as an administrative
surface — listing, promoting, retiring, tuning. The `browser_compare` tool. The rule that a baseline
name is generated rather than supplied, which was a good rule about a thing that has stopped
existing. And the scheduling problem where running the resolution study would have invalidated every
blessed image at once, which was a real cost and is simply not incurred.

**Why the caller naming the target is better rather than merely simpler**, because "simpler" on its
own is not an argument:

- **The service cannot be wrong about which picture you meant.** Under a canonical picture the
  service picks the comparison target from an identity it maintains, and every way that identity can
  be imprecise — a theme, a language, a signed-in persona, a consent banner, a breakpoint spelled two
  ways — is a way it silently compares two things that were never the same page. Naming an identifier
  removes the entire class: there is one target, the caller chose it, and it is either that one or
  the request says so.
- **It deletes a required human step from the middle of an agent's work.** Under a blessed picture,
  the first visit to a view produces nothing comparable and somebody has to intervene before the
  second visit means anything. Under an identifier, visit one returns a picture with an identifier
  and visit two passes it back. The loop closes without a person in it.
- **It makes the feature the last thing built rather than the first thing depended on.** Nothing
  earlier in this document needs it, which is the property §3.11 is careful to preserve.

**What is honestly given up.** There is no service-maintained answer to *"what is the approved
appearance of this page"* — the caller keeps track of which identifier it wants to compare against,
and if it keeps track badly it will diff against the wrong picture and get a confusing answer. That
is a real transfer of responsibility to the caller and it is accepted deliberately: an identifier the
caller chose and got wrong is diagnosable in one step, whereas an identity the service inferred and
got wrong looks exactly like a page that changed.

**A view label is still accepted on a capture** (§3.11) and it is purely a label: it goes in the file
name, it makes a directory legible, and **the service attaches no meaning to it whatsoever.** It
matches nothing, groups nothing and identifies nothing. Two captures sharing a label are two captures
sharing a label.
### 1.9 `comparisons` — and what you actually get back

**What a diff returns — the question worth answering plainly.** It is **not** a set of coordinates
you then have to go and cut out of a picture yourself. The service does the cutting. For each region
that changed it writes **two** small images — that region as it was in the capture you named, and as
it is now, cut from the same rectangle with a little padding so the crop is identifiable — and
returns their paths alongside the numbers. It also writes one full-frame image with the changed
regions outlined, so *"where on the page"* is a single picture rather than arithmetic.

| What comes back | Type | What it's for |
|---|---|---|
| `changed` | boolean | **True when at least one region survives filtering** — not when any pixel differs. Defined explicitly because it is the field every caller branches on, and "three pixels moved but nothing survived the size filter" has to have one answer rather than two. |
| `changed_pixels` · `changed_ratio` | int · number | The raw count and its share of the image, before regions are worked out. What distinguishes *nothing moved* from *the threshold ate it*, and what lets a caller spot a whole-page re-render without opening anything. |
| `regions` | a list | One entry per changed area: its position and size **in the capture's own pixels, measured from the top left**, plus **two paths — the crop from the earlier capture and the crop from the new one**. Usable images, already cut, at the size of the thing that changed. Ordered largest first. |
| `overlay` | path | The new capture with the changed regions outlined. One picture that answers *where*. |
| `truncated` | boolean | Whether regions were dropped by the cap on how many come back — the smallest ones, since the list is ordered largest first. A truncated result that does not say so is a lie about completeness. |
| `compared_against` | id and path | **The capture the caller named.** Echoed back rather than assumed, so a caller that passed the wrong identifier can see that it did. |
| `settings applied` | numbers | The three values that decided the output: the colour tolerance, the smallest area reported, and the cap on regions. |

**Every one of those is a path, not an image.** The caller opens the two or three that matter. A
review of twenty-five screenshots becomes a review of the two regions that moved, and the cost of
looking is paid on the crops rather than on the pages.

#### The failure mode is the point: a missing target returns a picture, never a refusal

**If the capture the caller named cannot be found, the service returns the full screenshot and says
why.** In plain words on the response: it could not diff, because it could not find the image that
was named. **It never refuses.**

This is a deliberate inversion and it is worth being explicit about, because the reflex goes the
other way. The reasoning:

- **The caller asked for a picture.** A diff is an *optional argument on a capture* (§3.11), not a
  separate operation — so the request that fails to find its target is still, underneath, a request
  for a screenshot, and that part of it can always be satisfied. Refusing the whole call would
  withhold something that succeeded because something optional did not.
- **A refusal costs a round trip on the most expensive surface there is.** The caller would have to
  notice the refusal, drop the argument, and ask again — two calls and a picture's worth of latency
  to arrive at exactly what returning the picture the first time delivers.
- **Nothing is hidden by doing it.** The explanation is on the response, it names what was not found,
  and the absence of a diff is visible in the shape of the result. A caller that branches on
  `changed` sees no diff, not a wrong one.

**There is no retention on any of this, which is what makes the situation rare.** Capture files are
not swept and crop files are not swept — there is no expiry schedule for either (§6.2). The service
either finds the image the caller named or it does not, and the ordinary reason it does not is that
the caller named the wrong thing, which is exactly the case an explanation helps with.

#### How the images reach the caller: one endpoint, one return shape

**An image request always returns an image, the same way, every time.** Whether the bytes are a full
capture or a crop from a diff depends on nothing except whether the caller passed a diff target. One
endpoint, one shape, no branching.

**This closes the question by rejecting the option it was leaning toward.** The tempting answer was
to return small crops inline in the result and paths for large ones, on the reasoning that a crop is
the size of the thing that changed and therefore cheap. **That reasoning does not hold, and the flaw
is specific: you cannot know that a diff is small.** A change to a component that appears on every
page changes every page — a header, a font, a spacing token, a colour — and the diff that follows is
not a small crop but a dozen of them, collectively as expensive as the screenshot the design spends
most of its effort avoiding. A rule whose cost is bounded only when the change happens to be local is
not a bounded rule; it is an unbounded one that behaves well in testing.

So the artifact-bytes surface is one thing and is described once:

- **It serves paths recorded in the database**, resolved under the artifact root — a capture's `path`
  (§1.7) or a crop path from a diff row. **It never accepts an arbitrary path from a request**, so
  there is no traversal to defend against: the only strings it can be asked for are identifiers of
  rows, and the path is looked up rather than supplied.
- **It serves only artifacts belonging to the asking lease**, checked the same way every other
  tab-addressed operation is checked, and refusing with the same non-disclosing wording as an unknown
  tab (§7.1) so probing cannot discover another lease's files.

**Why this is a table, given the rule that nothing is stored if it can be computed.** The weak
argument is that without a row the result exists only in the response, which is true of every read in
the service and proves nothing. The arguments that survive the rule:

1. **It cannot be reproduced from a rerun.** The three filtering numbers are configuration, so
   re-running a diff after any of them moves answers a different question from the one that was
   asked. What an earlier call *did*, under the numbers in force at the time, is exactly what tuning
   needs to know and is not recoverable afterwards.
2. **Its references can be enforced here and nowhere else.** Which capture, which target and which
   lease are real foreign keys in a table and are unenforceable inside a blob of data on a ledger
   entry.
3. **The honest alternative is a ledger entry**, since the ledger already has a comparison kind with
   room for detail. The reason it should not be one is that the ledger is the one thing in this
   design that may be trimmed (§1.1), so a future decision to trim it would silently destroy the
   tuning history.

The row keeps: which capture, which capture it was compared against, which lease, when, **the three
settings actually applied**, the changed-pixel count, the regions with their crop paths, and whether
the list was truncated. All three settings are copied rather than referenced, because all three are
mutable and all three determined the output — snapshotting one and referencing the others would be a
record that is half-true. **No separate region count** — it is the length of the list of regions.

### 1.10 There is no settings table — configuration is the environment

**Every value this service reads is an environment variable with a working default.** There is no
`settings` table, no revision counter, no code-declared registry the database shadows, no
`updated_by` audit label, and no `broker config set`. **A fresh install runs with nothing set.**

**This reverses a recommendation stated earlier in this document, and the reversal is recorded rather
than quietly applied.** The case for a database-backed settings table rested on two supports and both
gave way:

| The argument that was made | Why it does not hold |
|---|---|
| A table survives restarts, which a long-lived process would otherwise need | Never applied here. A process is spawned per session and reads its configuration on the way in (§6.3), so an environment change is in force for the next caller and costs nobody anything. This support was already acknowledged as unavailable |
| A table gives every process **one** answer, which matters because several processes arbitrate against the same bound (§1.0a) | **This one was correct, and it is the only thing the table was really buying.** It is answered directly in the paragraph below, at the cost of one row and no tools at all |

**And the decisive argument was the one about consumers, not about correctness.** A settings table
needs something that writes to it. With nothing served (§4) and no configuration command, the only
writer would have been a command built for the purpose — apparatus whose entire justification is that
it exists. **A table with no consumer is not a conservative choice; it is a surface to maintain, to
migrate, to validate and to test, bought with nothing.**

**What carries the configuration instead is specified rather than implied.** A file named
`.env.example` ships in the
repository and lists **every** variable the service reads, each with its options and its default.
That file is the registry — it is where somebody looks to find out what can be tuned, and it is
checkable by reading it beside the code. Values are plain strings and enums: no nested structures, no
encoded documents, nothing that needs a parser to be correct.

**Configuration is never a secret store.** Every value is readable by anything that can read the
process's environment and is printed by the command line. Credentials do not belong in it, and §7.3
keeps a build rule saying so.

#### The one exception, and it needs no tool: the tab budget

**One value cannot be an environment variable alone, and it is worth understanding exactly why,
because the reason does not generalise.**

> **Several processes arbitrate against the tab budget simultaneously** (§1.0a). In one process's
> environment the budget can be fifteen; in another's, thirty. Each admits callers against its own
> belief, each is internally consistent, and **the ceiling silently stops being a ceiling.** Nothing
> reports this. The count is correct in every process and the machine is over budget anyway.

That is not a degraded behaviour, it is a broken invariant — the one number the whole capacity model
is a comparison against, disagreed upon by the things doing the comparing.

**The resolution is one row and zero tools.** The budget stays an environment variable, and **the
first process to open the store writes the value it believes into the store.** Every process that
opens the store afterwards compares its own environment against that row:

- **They agree** — which is the ordinary case, because the ordinary case is one machine with one
  environment — and nothing happens at all.
- **They disagree** — the process **refuses to start, and says so**, naming both numbers. It does not
  adopt the stored value, because a process running against a bound it was not configured for is a
  configuration error somebody needs to see. It does not overwrite the stored value either, because
  that would let whichever process started most recently move a bound the others are mid-arbitration
  against.

**No configuration command, no settings surface, no write path a caller can reach.** The row is
written once, by whoever gets there first, and after that it is only ever compared against.

**The lease lifetime has a milder version of the same shape and is deliberately left alone.** Two
processes disagreeing about how long a lease lives means a lease expires a little early or a little
late depending which process happened to sweep it. That is **degraded behaviour, not a broken
invariant**: no bound is violated, no capacity is over-allocated, and the worst outcome is a caller
losing a lease sooner than it expected — which the expiry mechanism already tells it about. So it is
a plain environment variable with no stored copy and no check. **The distinction is the rule:** a
value several processes must *agree* on gets the row; a value they merely each *use* does not.
### 1.11 Making an illegal state impossible

**One rule needs the database to refuse a duplicate, and it does.** Two live tab rows must never name
the same physical tab. That is expressed as a partial unique index and it is **verified working**,
tested on the SQLite version this design targets.

> ### ⚠️ The count of indexes has changed, and it is stated rather than corrected quietly
>
> **This document has said, in several places, that there are *three* partial indexes and that all
> three were built and exercised. That measurement was true and it is still true — but one of the
> three indexed a table this design does not contain.**
>
> Deleting the baseline concept (§1.8) removes the partial unique index that enforced one live
> baseline per view, browser, kind and breakpoint. **There are two, and here is the honest accounting
> of what that does to the argument they were supporting.**
>
> | | |
> |---|---|
> | **What was measured** | Three partial indexes built and exercised on SQLite 3.53.4, with double-issue confirmed structurally impossible across processes |
> | **What survives that measurement** | Two of them, unchanged and still verified: the live-tab unique index, and the live-claims covering index. The measurement was not invalidated by the deletion — it simply covered one index more than the design now contains |
> | **What is gone** | The live-baselines unique index, along with the table it indexed |
> | **Effect on the argument for plain SQL over an object-relational mapper** | **Weakened, not broken**, and the honest word is weakened. One of the four supports is gone |
>
> **The remaining three supports stand on their own and are not affected by this at all:** startup
> latency, which is charged on **every spawn** here rather than once at boot and is therefore the
> support that matters most in a design with no long-lived process; install weight, for the same
> reason; and the version stepper (§1.2d), which applies its steps in the language the database
> speaks and would otherwise be reconciling two descriptions of one schema.
>
> **Why this is written as a change in a count rather than as a corrected number.** A reader who
> remembers "three, verified" and finds "two" with no explanation has to work out whether a
> measurement failed, whether an index was dropped for being wrong, or whether somebody miscounted.
> None of those happened. Editing the number silently would have made a straightforward deletion
> look like a retraction of evidence.

**Why a rule and not a check.** To create something, the service reads whether the thing already
exists, gets back no, and writes it. Two callers can do that at the same instant, and the reasonable
objection — that they cannot write *simultaneously*, so the second should fail — is wrong in a
specific way worth understanding.

**The writes do serialise. Serialising is not rejecting.** The second write lands after the first and
the database accepts it, because nothing has told the database that two such rows are illegal. Two
similar inserts are an entirely ordinary thing to do; without a rule saying otherwise, a database has
no reason to refuse one.

The staleness is not in the write. **It is in the read that came before it.** Both callers read
"nothing there" and both reads were true when they were made. By the time the second write lands, its
read has stopped being true — and nothing re-checks it, because a read is not a promise about the
future. Two correct reads, two legal writes, one broken rule.

**So the rule lives at the write.** The database is told it, and refuses the second insert itself
rather than being asked to agree with a check somebody did earlier. **Across separate processes
(§1.0a) that is not one option among several — it is the only place a rule can live**, because there
is no shared process to hold a lock in.

**What makes it awkward, and why it works anyway.** The rule is not "one tab row per physical tab" —
rows are permanent, so a physical tab that has been used and closed a dozen times has a dozen rows.
The rule is over the **live** ones: uniqueness among *some* of the rows. That is a **partial unique
index** — unique among rows matching a condition — and writing the schema in plain SQL means it is
written out directly, in one line, with nothing to work around.

> **Measured, not assumed.** The indexes were built and exercised on **SQLite 3.53.4**, and
> **double-issue was confirmed structurally impossible across processes**: a second process attempting
> the duplicate receives a uniqueness-constraint error from the engine rather than being admitted.
> That is the property that cannot be obtained from application code, however carefully written, and
> it is why this was tested rather than reasoned about.

**There are two indexes, and the second is not a uniqueness rule at all.**

| Index | Kind | What it does |
|---|---|---|
| Live tab rows, over browser and the driver's name for the tab | Partial, **unique** | Refuses a second live row naming a physical tab that is already spoken for |
| Live claims | Partial, **not unique** | **Makes the capacity count an index-only read.** The one number every arbitration call needs is the count of live claims (§2.3), and this index covers it — the answer comes out of the index without touching the table at all |

**That second one earns its place for a reason specific to this design.** The capacity count is not an
occasional read; it happens inside the transaction that every arbitration call opens, and every other
caller on the machine is waiting behind it (§1.0a). Making it a covering read is what keeps the
serialised section short. It is filtered to live rows for the same reason the other is: the table
grows forever and the live part does not.

**One rule that was on this list is not a rule at all — it is structural, and that is better.** A tab
row's lease reference is set when the row is created, is never null, and never changes (§1.4). So a
tab has exactly one owner **by construction**: there is no operation that could give it a second one,
no state in which it has none, and therefore nothing for an index to refuse. A rule you cannot break
needs no enforcement, and noticing that removed an index rather than adding one.

**And there is no "one live lease per session" rule**, because the model has no place for one: a
lease is one tab, so a session that wants three tabs holds three leases (§1.3). The thing such a rule
would incidentally catch — two callers accidentally sharing one session identity — is therefore not
caught anywhere, and §2.2 is where that lands.
### 1.12 What is stored, what is computed, and why

Every column above was tested against rule one. This is the audit, in one place.

**Removed, because it can be computed:**

| Was | Computed instead from |
|---|---|
| `browsers.persistent` | Which of the two browsers it is |
| `browsers.profile_dir` | The configured profile root plus the browser's own name — and an absolute path is never stored (§1.7a). The directory is mandatory on every launch; it is only the *column* that is derivable |
| `browsers.last_error` | The most recent failure event for that browser |
| `browsers.surface_verified` | `browsers.state` — a browser that fails the check never reaches `running` |
| `claims.renewed_at` | `expires_at` minus `ttl_seconds` |
| `claims.queue_position` | A count of the queued leases that arrived earlier |
| `claims.captures_taken` | A count of that lease's captures |
| `captures.estimated_tokens` | Width times height over a fixed constant — still returned on every response, just not frozen into a column |
| `captures.full_page_requested` | `captures.kind` |
| `comparisons.region_count` | The length of the region list |
| `tabs.established_origin` | Reported as a note on the response; the service does not claim to guard it |

**Removed, because the thing it described stopped existing.** A different category from the one
above, and worth separating: nothing computes these, because there is nothing left to compute.

| Was | Why it is gone |
|---|---|
| `claims.tabs_granted` | A lease is one tab (§2.3), so there is no size to record |
| `tabs.last_url` | **A cached copy of something the browser already knows**, read only when the browser was reachable anyway. Deleting it removes the most sensitive column in the design and leaves nothing to retain, redact or clear (§1.4) |
| Every column of `baselines` | There is no canonical picture. A diff names the capture to compare against (§1.8) |
| `captures.view_key` · `captures.version` | Both placed a capture in a lineage against a canonical picture. A view label survives as a label only, in the file name, meaning nothing to the service (§1.7) |
| Every column of `settings`, and the revision counter beside it | Configuration is the environment (§1.10). The one value several processes must agree on is a single stored row with no write path, not a table |

**Kept although computable, each with its reason:**

| Column | Why it stays |
|---|---|
| `claims.renew_count` · `claims.ended_at` | The lease row is permanent; the ledger it would be counted from is prunable |
| `browsers.restart_count` | Same, and the restart-backoff rule counts against it on every launch (§1.2), so an enforcement path reads it rather than only a report |
| `tabs.opened_at` · `tabs.closed_at` · `tabs.close_attempts` | Same permanence argument; `close_attempts` also drives escalation on a path that runs every few seconds |
| `tabs.close_failed` | What the administrative clear-a-leaked-tab operation selects on. A leaked tab is one no live lease points at, so nothing else identifies it (§1.4) |
| `tabs.browser_id` | A copy of the lease's browser, kept because a uniqueness rule can only be written over columns on one row (§1.11). It cannot drift — the database refuses a tab whose browser disagrees with its lease's |
| `claims.expired_at` | **Not the same fact** as when the expiry was noticed. Only the row can carry when a lease actually lapsed, and recording it is what stops every post-mortem showing a cluster of expiries at one instant (§2.4a) |
| `claims.activated_at` | The input to the wait estimate on every queued response, and the only thing separating time held from time waited once the ledger has been trimmed (§1.3) |
| `events.session_id` | A refused request never becomes a lease, so without the copy every refusal is anonymous |
| `captures.bytes` | What the token estimate is sanity-checked against, without opening every file to answer a question about a hundred rows |
| `captures.tier` · `captures.warned` | Both were measured against configuration that can move between installations, so the value in force at the time is not recoverable afterwards |
| `captures.url` | What one picture was of, at one moment. **Nothing else records it**, and it is a different fact from where a tab is — for which there is no column at all (§1.4) |
| The three settings copied onto `comparisons` | The values actually applied, copied when the diff ran. All three are mutable, so re-running later answers a different question — and snapshotting one while referencing the others would be a record that is half-true |
| `claims.ttl_seconds` | The duration the caller was promised. Re-reading configuration mid-lease would change a promise already acted on |
---

## 2. The lease's life

### 2.1 Five states

| State | Live | Means |
|---|---|---|
| `queued` | yes | Capacity was not available. The lease holds a place and a key, and no tabs. |
| `active` | yes | The lease holds tabs. |
| `released` | final | The caller gave it up. |
| `expired` | final | Nobody called in before it lapsed. |
| `revoked` | final | An operator took it back, with a reason. |

**Final is final.** There is no way out of the bottom three, and a caller whose lease ended gets a new
lease or nothing. Reviving an expired lease would mean reopening tabs that were closed, which is a
different lease wearing an old name.

### 2.2 What each change of state means, and what is refused

| From | To | What causes it |
|---|---|---|
| — | `active` | A request, with capacity available |
| — | `queued` | A request, with capacity unavailable |
| `queued` | `active` | The sweep promotes the front of the queue |
| `queued` or `active` | itself | Any call carrying the key extends the expiry |
| `queued` or `active` | `expired` | The expiry passed with no call |
| `queued` or `active` | `released` | The caller released it |
| `queued` or `active` | `revoked` | An operator revoked it, with a reason |
| any final state | anything | Refused, naming the state and when it ended |

**Two reasons a request is refused outright rather than queued**, each because waiting would not
help:

| Refusal | When | Why it is not a queue entry |
|---|---|---|
| unknown browser | The browser named is neither of the two | Nothing will ever make it valid |
| the browser is not available | It is starting, failed, or a person is signing in | A browser being down is an availability problem, not a capacity one. The queue's promise is that capacity frees up, and nothing about a failed browser promises that |

**Three refusals a reader might reasonably expect here are absent, and their absence is structural
rather than lenient.** Two would be about the size of a request — over a per-lease cap, or over the
whole budget — and **there is no size to be wrong about**: a request is for one tab (§2.3), one tab is
never more than the budget, and no per-lease cap exists to exceed. The third would be *"this session
already holds a lease"*, which cannot be a refusal when holding several is how a caller gets several
tabs.

**That third absence costs something, and the cost is larger than an earlier draft of this document
admitted.** A refusal there would catch a real bug as a side effect: two callers accidentally sharing
one session identity would show up immediately, as a refusal neither of them expected.

**Nothing catches it, and the mitigation that was offered has evaporated.** The consolation was that
one session holding an implausible number of tabs would be visible on a page somebody was watching.
That rested on a page being up. **Nothing is served** (§4) — the operations view is a file somebody
generates when they think to (§4.5), so it detects nothing on its own and detects a transient
condition not at all.

**So this is recorded as unresolved rather than mitigated**, which is the honest grade:

- **What is lost:** automatic detection of two callers sharing one session identity.
- **What partially covers it:** the condition leaves evidence. Several live leases carrying the same
  `session_id` and mutually implausible purposes is visible in a lease listing (§5.4) and in the
  generated view — **to somebody who goes and looks**, which is a diagnostic aid after suspicion,
  not a detector.
- **What would settle it:** knowing whether the condition happens at all. It is a caller-side
  configuration mistake, not a service bug, and the service has no way to distinguish it from a
  caller legitimately holding several tabs — which is the ordinary case (§1.3). **If it turns out to
  be common, the instrument is a warning on the response** when a session's live lease count crosses
  a threshold, not a refusal, because a refusal would break the legitimate case to catch the
  accidental one. That is deliberately not built on speculation.

**A key is returned once and is never recoverable, by construction** — it is not stored, only its
hash is (§1.3). The consequence is worth stating rather than discovering: **a caller that loses the
response to its own request cannot get that lease back.** It waits the lease out, or asks an operator
to revoke it. That is the price of not storing keys, and it is a price rather than an oversight.

**Releasing is forgiving; everything else is not.** Releasing a lease that already ended succeeds and
says so. Trying to *use* one fails. The asymmetry is about what the caller is about to do: a caller
tidying up in a cleanup path and again on shutdown must not see an error for tidying twice, and there
is nothing to corrupt. A caller about to do work it cannot do should be told now, not one operation
later, further from the cause.

### 2.3 A grant is one tab

**This is the single sentence the capacity model reduces to, and everything else in this section is a
consequence of it.**

> **Capacity, grants and tabs are the same integer.** The pool bound *is* the tab budget *is* the
> count of live claims. **Need two tabs? Claim twice.**

**Admission is one integer comparison.** Count the live claims; if that count is below the budget,
grant; otherwise queue. There is no request size to add, no per-lease allowance to check against, no
arithmetic of grants multiplied by an allowance, and — the part that would otherwise be the hardest
thing in this document to reason about — **no reservation.** Nothing is held for a lease that has not
opened its tab, because a lease *is* its tab.

**What that rules out, stated plainly, because each is a mechanism a reader may be expecting to find
and will not:**

| Mechanism a reader may look for | Why it cannot exist |
|---|---|
| A per-lease tab allowance | **Absent, and deliberately not re-derived at some other value.** Such a bound would be the one number in this design answering to no prior decision — invented to stop one caller taking everything. With a grant of one there is nothing for it to bound |
| Under-utilisation, where grants times allowance exceeds the tabs anyone opened | There is no multiplication. Granted and existing are the same number |
| Any divergence between what is granted and what exists | **Structurally impossible.** Not "guarded against" — there is no pair of numbers that could disagree |
| Partial grants, and the whole "all or nothing" question | A request of one is granted or it is not. There is no fraction of it to hand over |
| A queued response offering *"you could have three right now if you asked for fewer"* | There is no smaller request to suggest |

**And release becomes unambiguous, which is the quieter win.** One lease, one tab, one close. The
operation that closes a caller's tabs is **singular** on every surface — there is no plural
close-my-tabs, because there was never more than one. A whole class of question about partial release
and about which tabs a release refers to simply has no subject.

**Capacity is taken when the lease is granted**, and that means less than it sounds: the claim row
*is* the capacity, so there is no window in which capacity is reserved for a tab that does not exist
yet. A tab that fails to open ends its lease (below), and the count follows immediately because it is
a count of claims.

**If the tab fails to open**, the service ends the lease itself, records why, and tells the caller the
browser is unavailable. A lease with no tab is useless, and holding capacity for it is strictly worse
than refusing. **There is no partial case** — no "some opened and some failed" — because there is no
plural.

### 2.3a The limit this leaves: a caller that wants several tabs can starve

**This is a named limit rather than a solved problem, and it is put in front of you rather than left
to be discovered in use.** It is the price of the simplicity above.

**The shape of it.** A caller that needs three tabs claims three times. It is granted one, granted a
second, and queues for a third — **while holding the first two.** Another caller doing the same thing
at the same moment holds two of its own and waits for one more. Neither can proceed and neither will
release, because each is waiting for capacity the other is holding. **They hold and wait.** A timer
eventually breaks it, since leases expire — but only by destroying the work of both callers, which is
a resolution in the sense that a fire is a resolution.

**A design in which a multi-tab request is one atomic admission does not have this problem**, and it
is worth being honest about that rather than presenting the simplicity above as free: under atomic
admission a caller either holds everything it needs or waits holding nothing.

#### The ruling: multi-tab work is sequential, and the limit is stated rather than engineered around

**Nothing is added to admission.** No request size, no all-or-nothing grant, no acquisition protocol
the service describes but cannot enforce. **A caller that needs several tabs is expected to work
through them one at a time**, and a caller that chooses to hold several at once is choosing a risk
this document names.

Three reasons, in order of weight:

1. **The alternatives cost more than the problem does.** Atomic admission reintroduces exactly what
   §2.3 deleted — a request bigger than one, a queue entry a freed tab might not fit, and the
   reservation arithmetic that was the hardest thing in this design to reason about. Buying that back
   to solve a starvation case nobody has hit yet is a poor trade.
2. **A protocol the service cannot enforce is documentation wearing a rule's clothes.** "Acquire
   everything before starting, release everything on failure, stagger your retry" is sound advice and
   the service has no way to make any of it true. Writing it into the specification would create a
   guarantee whose enforcement does not exist, which is worse than the limit it papers over.
3. **Nobody knows how common concurrent multi-tab work is.** Choosing between the alternatives is a
   judgement about a frequency, and the frequency is unmeasured. Building for it now means guessing.

#### One thing *is* added, and it is not scheduling: the caller is told when it is its own obstacle

**A refusal or a queue placement tells a caller that it already holds leases, and names them.** This
is an information problem before it is a scheduling problem: the starvation above only bites a caller
that does not realise the capacity it is waiting for is partly capacity it is holding. Every
mechanism considered above builds machinery to prevent a situation the caller could resolve itself in
one step, if it simply knew.

So when a claim cannot be granted immediately **and the asking session already holds one or more live
leases**, the response carries three things:

1. **The leases it already holds — named, not keyed.** Each is identified by its lease identifier,
   state, purpose, browser and expiry, so a caller that lost track of its own grants can carry on
   with what it has instead of waiting for something it does not need. **The keys are deliberately
   absent, and cannot be otherwise:** only a hash is stored (§1.3) and a key is unrecoverable by
   construction (§2.2), so there is nothing to look up. The caller was handed each key on the
   response that granted it, and matches them against these identifiers itself. Returning keys here
   would require a key store, which would delete the single best security property in this design to
   save a caller one lookup of its own records.
2. **Start with what you hold.** The strongest advice, because it is frequently self-solving —
   finishing the work on a held tab frees capacity the same caller can then reuse. It unblocks itself
   by working rather than by waiting.
3. **Release and retry if you genuinely need them at once.** The honest option when the work cannot
   be serialised: give back what you are holding rather than sitting on it.

**Detection is nearly free.** The admission transaction already counts live leases and already knows
the asking session; noticing that some of those leases belong to the requester is one comparison on
data already in hand. No new table, no new state, no new tool.

**It is also logged as a decision** (§1.6). Each occurrence resolves itself invisibly, so without a
record there is no way to learn that it has become common — which would be the signal that the tab
budget is too tight, or that a caller is misbehaving. **The nudge is advice; the ledger row is the
evidence.** This is the same posture as every other refusal here: say what to do next, and keep the
record.

**What is owed before this can be called settled rather than chosen.** One number: how often more
than one caller holds several leases at the same moment. **The lease rows answer it directly** —
overlapping live leases grouped by `session_id`, which is a query over data the service already keeps
(§1.3). If the answer is "routinely", atomic admission becomes worth its cost and this ruling should
be revisited. **If it is "never", nothing was built for nothing**, which is the outcome this position
is betting on.
### 2.4 How capacity comes back: lazily, globally, on every call

**Nothing expires on a timer, because there is nothing running to hold one.** With no long-lived
process (§1.0a), a background reaper has nowhere to live — and rather than inventing somewhere for it
to live, reclamation moves onto the calls themselves:

> **Every arbitration call first expires every lapsed claim and every lapsed queue entry across the
> whole store — in the same transaction — and only then answers from the reconciled state.**

Three things in that sentence are load-bearing and none is decoration:

- **Every call.** Not only a claim. Asking where you stand sweeps; releasing sweeps; an operations
  read that goes through arbitration sweeps. This is also what keeps the writer-serialisation
  guarantee true (§1.0a): the guarantee holds **only because every arbitration path writes**, and the
  sweep is what makes even a question a write.
- **Every lapsed entry, across the whole store.** Not just the caller's own, and not just the ones
  relevant to the answer. A global sweep costs a scan of the live rows — tens of them — and it means
  the state a call answers from is reconciled in full rather than in the part somebody remembered to
  reconcile.
- **In the same transaction.** The expiry and the answer are one atomic act. Split them and a caller
  can be told "no capacity" on the strength of leases the very same call has just decided are dead.

**So the three ways capacity comes back are unchanged; what changed is when anybody notices.**

- **The caller releases.** Its tab closes, and the freed capacity is available to the next call.
- **The lease lapses.** Nobody called in, and **the next arbitration call by anybody** notices and
  expires it.
- **An operator revokes it**, with a reason the caller sees on its next call.

> **The standing rule that falls out of this: stored state is provisional, derived state is the
> truth.**
>
> A row saying `active` whose expiry has elapsed is **not** an active lease. It is a lease that
> lapsed and has not been swept yet, and the difference is invisible in the row.
>
> **So every reader that touches the store directly must apply the same expiry derivation** — the
> status view, the health check, the command line, anything on the operations surface. A reader that
> trusts `state` alone **will report leases that do not exist**, and will do it most on the busiest
> installations, where the gap between lapsing and being noticed is filled with somebody looking at
> the page. This is the rule most likely to be broken by a well-meaning addition, because reading a
> column is the obvious thing to do and it is wrong here. **It binds the generated operations document
> too** (§4.5), which is a reader like any other.

**One duration, one rule.** *Keep calling in or lose it* applies identically to a caller holding a tab
and to one waiting in the queue — and **they are the same ten minutes**, deliberately rather than by
oversight. §2.5 sets out why, including why the argument for making them differ turned out to point
the other way.

### 2.4a Record when a lease lapsed, not when the sweep noticed

**These are different facts and only one of them is about the lease.** A lease with a ten-minute
duration whose caller stopped talking lapsed ten minutes after its last call — whether anybody
arrived to notice one second later or forty minutes later.

**So the lapse time is computed and stored** (`claims.expired_at`, §1.3): the last renewal plus the
duration in force. The ledger row is written when the sweep ran, and says so; the claim row says when
the lease actually ended.

**Why this is worth a column rather than a comment.** Recording only the sweep's own moment produces
a record in which **leases expire in clusters at instants when nothing happened to them** — every
lease that lapsed during a quiet hour stamped with the moment the next caller arrived. That is an
artifact of the observer, and it is a particularly bad kind of artifact, because it is not noise: it
is a strong, clean, entirely fictitious pattern. Anybody asking "why do leases expire in bursts"
would be investigating the sweep and learning nothing about the callers.

### 2.4b Never do browser work inside the arbitration transaction

**This is a hard rule, and it is the one whose violation would be worst.**

Expiring a claim has two halves: reclaim its capacity, and close its tab. The second half is a round
trip to a browser — **and a browser can hang.** A wedged browser does not refuse quickly; it accepts
the request and never answers.

> **Inside the transaction, one unresponsive browser blocks every arbitration call on the machine.**
> Not the caller that hit it — every caller, including ones that only wanted to know where they
> stand, because they are all serialised behind the same writer (§1.0a). One stuck page becomes total
> unavailability.

So the split is absolute:

| Inside the transaction | After it commits |
|---|---|
| Expire the lapsed claims and queue entries | Close the tabs they held |
| Reclaim the capacity | Best-effort, and failure is tolerated |
| Answer the caller | |

**The consequence, stated exactly: a tab that fails to close is a leaked tab, not a leaked lease.**
The capacity came back at commit; the lease is over; the count is right. What remains is a page in a
browser that nobody owns, recorded on its row (§1.4) and reported by `broker doctor` (§5.5). That costs
memory and it is worth fixing, but it does **not** cost budget and it does not block anybody —
which is the opposite of the earlier arrangement, where an unclosable tab held a unit of budget until
a restart.

Reclaiming a leaked tab is an administrative act, not a caller's (§3.13), and it is never done by
killing a browser (§2.7).


### 2.5 The queue is strictly first in, first out

**Strict order, and it is close to trivially correct** — which is worth saying, because in most
designs this is one of the harder trade-offs and here it is barely a decision.

Every request is the same size (§2.3). So:

- **There is nothing to skip ahead of.** Skipping ahead means passing over a request that does not
  fit in favour of one that does, and no request fails to fit — a freed tab fits the front of the
  queue, always.
- **There is no aging rule to design**, because there is no starvation to protect against. A caller
  cannot be overtaken forever by smaller requests when there is no such thing as a smaller request.
- **A caller's position only ever improves**, and it improves by exactly one each time a tab comes
  free.

The sweep promotes the front of the queue while capacity exists, and stops when it does not. That is
the whole rule.

**What is still real is the queue entry that has died.** A caller that stopped talking holds the
front of the queue and will never take the tab it is offered — **consuming no capacity while blocking
everybody behind it.** This is why queue entries expire by the same lazy sweep as leases (§2.4), and
why that expiry is not housekeeping. It is the only thing that unblocks the queue.

#### The two durations are equal — ten minutes each — and that is a decision

**A lease lives ten minutes. A queue place lives ten minutes.** They are the same number on purpose,
and this **reverses a rule stated earlier in this document**: that the two must never default to the
same value, on the reasoning that equal defaults make the distinction invisible.

**The reversal is recorded because the argument behind the rule was wrong, not merely outweighed.**
Two things settle it:

| The argument that was made | Why it does not hold |
|---|---|
| A queued caller has nothing to renew with, so its place must outlast a lease to be fair | **Polling *is* renewing.** `browser_status` extends whatever the key holds (§3.3), and polling is precisely what a queued caller is told to do. It has exactly the same instrument an active holder has, used exactly as often |
| Expiring a waiting caller punishes it for the queue being long, and it consumes no capacity while waiting, so generosity is cheap | **The cost runs the other way.** Under strict first-in-first-out, **a queue place held longer blocks everyone behind it for longer.** A dead entry at the front is the one failure that is invisible in a capacity count — the count is correct the entire time. So a longer queue duration is not kinder, it is worse, and the caller it is worst for is a live one waiting behind a dead one |

**With both arguments for asymmetry gone, there is nothing left recommending a difference.** Equal is
the answer, and one number is easier to hold in your head, easier to state in a response and easier
to reason about than two.

**The cost of equality, stated so nobody has to find it.** A caller that dies holds its place for the
full ten minutes rather than a shorter one. That is the worst case and it is bounded, visible in the
queue depth, and cleared by the first arbitration call after it lapses.

#### Releasing gives back a queue place too

**`browser_release` releases whatever you hold — a tab, or a place in the queue.** One verb, both
states.

**This closes a real gap.** A queued caller that changes its mind — the work was cancelled, the page
turned out not to need a browser, the caller is shutting down — otherwise has **no way out**. It
occupies its place until it lapses, blocking everyone behind it, for no reason at all. That is the
same failure as a dead entry at the front of the queue, with the aggravating detail that the caller
is alive and would happily have stood aside if asked.

The rule generalises cleanly and is worth stating in one line, because it is what makes the verb
memorable: **whatever you are holding, releasing gives it back.**

#### Every queued response carries a scheduling nudge, not just a position

**The expectation has to be stated in the response, not implied.** Every queued response says
explicitly: *call in with this key at least every N seconds, or lose your place and re-queue at the
back with a new key.* A protocol that implies an obligation and never states it is a protocol whose
clients will not meet it.

**And that is not enough on its own, which is the part worth writing down.** An agent told to call in
periodically will typically agree, do nothing about it, and rely on waking itself up at the right
moment — which it does not do. The obligation is understood and unmet, and the caller loses its place
without ever having decided to.

**So the response carries the mechanism, not just the deadline.** It tells the caller to set up a
recurring check at **just under the lifetime — around nine minutes** against a ten-minute place — and
says that is the way to hold a place rather than merely mentioning how long it lasts. Under, not at:
a check scheduled exactly at the deadline races the sweep and loses about half the time.

**Best practice belongs in the response rather than in a document nobody has open.** The caller
reading that response is deciding what to do next; a paragraph in a specification is not in the room.
### 2.6 There is no restart to recover from — but the browser can still be gone

**A process ending is the ordinary case here, not a failure**, so there is no "after a restart" step
in the sense of a service coming back up. Every spawn is a first spawn. The reconciliation that a
restarting service would have done once is the lazy sweep (§2.4), and it happens on every call
instead.

**What still needs answering is a harder question: the store says a tab is open, and the browser it
was in is gone.** The browser outlives any one caller (§1.2a) — but it does not outlive everything,
and when it dies every tab inside it dies with it while every row describing them survives.

So the reconciliation is against the **browser**, not against the process:

- **A browser whose discovery record fails either check** — the endpoint does not answer, or it
  answers and is a different browser (§1.2c) — **is gone.** Every tab row pointing at it is marked
  closed, because a tab inside a process that has exited is closed by definition, and their leases
  are ended.
- **A browser that is alive** is asked what is actually open. A page open that no live lease owns is
  closed; a tab a live lease believes it owns that is not there is marked closed and its lease ended.
- **Then the queue is swept**, so recovered capacity reaches whoever is waiting.

**All of that is browser work, so none of it happens inside the arbitration transaction** (§2.4b).
The transaction reconciles rows against what the last check established; the checking and the closing
happen outside it. The step-by-step is in `MILESTONES.md`.

**The consequence worth stating: a browser dying ends every lease in it at once.** That is not a
degraded mode this design hides — with two browsers and no third, there is no capacity to fail over
to. It is reported as what it is.

### 2.7 What reclaims what — the whole rule in one line

> **Every reclamation is scoped to a tab and to a lease. Nothing is ever scoped to a browser.**

Releasing closes exactly that lease's tab. Expiry does the same. Revoking does the same. The
reconciliation above closes exactly the pages the service can prove no live lease wants. The browsers
are shared and are never closed by any caller's action, direct or indirect — **and this is not a rule
callers are asked to respect, because there is no operation through which they could do otherwise**
(§3.13). Reaping or restarting a browser exists, and it is an administrative operation on a separate
surface (§3.13), never on the agent's.

---

## 3. What an agent can do

### 3.1 The list, and what it costs

**Ten tools.** Every description sits in a connected session's context on every turn whether or not
anything calls it, so surface area is a standing tax and the list is short on purpose.

| # | Tool | One line |
|---|---|---|
| 1 | `browser_claim` | Ask for a lease. Get **one tab**, or a place in the queue. **Pick the browser deliberately** (§1.2), and optionally seed storage before the first load. |
| 2 | `browser_status` | Where your lease stands. **Extends it** — this is the keep-calling-in verb, and the one a queued caller polls with. |
| 3 | `browser_release` | Give back whatever you hold — **your tab, or your place in the queue** (§2.5). |
| 4 | `browser_tab_replace` | Discard this lease's tab and open a fresh one in its place. **For a tab that has stopped responding.** |
| 5 | `browser_navigate` | Point your tab at an address. |
| 6 | `browser_act` | Click, type, fill, press, select, hover, check, scroll, **resize**, **emulate media preferences**, and answer a dialog. |
| 7 | `browser_read` | The page snapshot by default; console, network or cookies on request. Written to disk, returned as a path. |
| 8 | `browser_evaluate` | Evaluate an expression in the page and get its value. |
| 9 | `browser_capture` | Take a picture — **and, if you name an earlier capture, the difference from it.** Returns paths, never the image. |
| 10 | `browser_feedback` | Record that something here helped or got in the way. **No lease needed**, written locally, and **built to be removed** (§3.16). |

**Plus one thing that is not a tool: the operations snapshot** (§4.5). A command generates a
self-contained file a person opens. It is deliberately absent from this list because no agent needs
it, and a description on this list costs every session on every turn whether it is wanted or not.

#### Two tools were removed, and each for a reason worth keeping

**`browser_compare` is gone, folded into `browser_capture` as an optional argument** (§3.11). A diff
is a picture with an extra fact attached, and it was never a different operation — the caller wanted
an image either way, and the only question was whether it also wanted to know what moved.

**`browser_tab_close` is gone, and it should not be replaced.** It closed a caller's only tab while
keeping the lease alive — and since **a lease is a tab** (§2.3), that produced a lease owning nothing
while still consuming a unit of budget. **That is a state that should not exist.** The operation that
was actually wanted in almost every case is `browser_tab_replace`, and the one case it did not
cover — finishing with the browser entirely — is `browser_release`.

#### Reconciling the "destructive operations keep their own name" argument

**This document has argued that a destructive operation must keep its own name, because folding one
under a parameter is how a rule matching on the operation's name becomes invisible. Folding
comparison into capture appears to contradict that, and it does not — but the distinction has to be
stated, or the two positions just sit beside each other.**

> **The line is destructive versus not. It was never collapsed-versus-separate.**

Comparison is **not destructive**. It reads two images that already exist and writes some crops.
Nothing is closed, nothing is discarded, no other caller is affected, and there is no state it can
leave behind that anybody has to recover from. **There is no rule that would want to match on it**,
because there is nothing to refuse — which is exactly why folding it costs nothing. A parameter can
safely hide something that no rule needs to see.

Closing a tab is destructive, and that is why the argument was made in the first place. **The
resolution is that the destructive operation was deleted rather than folded** — `browser_tab_close`
is not now a parameter on something else, it is gone, and the operations that remain destructive
(`browser_release`, `browser_tab_replace`) each keep their own name.

**So the principle survives intact and is stated more precisely than it was:** a destructive
operation keeps its own name; a non-destructive one may be an argument on another. The earlier
wording implied the rule was about collapsing, and it is about consequences.

#### What the collapses cost

`browser_act` folds a set of verbs into one action name — less discoverable, and its error messages
have to work harder, which §3.8 pays back by listing them in every refusal. Reading folds several
kinds of artefact into one tool, with a filter (§3.9) so that only what is asked for is paid for.

**Every operation is singular in its tab**, because a lease is one tab (§2.3). There is no plural
close, no "close all my tabs", and nothing that takes a list of tabs — not as a restriction but
because there was never more than one to list.

#### The lease key is explicit on every call, and that is a decision

**Every tool except the first takes the lease key**, written out by the caller, and every call
carrying the key extends the lease. There is no keyed call that does not extend — a call that did not
would be a hole in the one rule the whole liveness model rests on, and it would produce leases that
lapse while their caller was politely only looking.

**Deriving the key implicitly from the session was considered and rejected.** It would have been less
to type and it is the obvious convenience, so the reason it is refused is worth having:

- **Delegation is the case that decides it.** An orchestrating caller may want to hand **one specific
  subagent** the key so that subagent, and only that subagent, can drive that tab. Under implicit
  identity that is either impossible — the subagent is a different session and cannot inherit the
  lease — or it is automatic for *every* subagent, since they all share the parent's identity.
  **Neither is what is wanted**, and there is no third behaviour available. An explicit key is a
  thing that can be passed to exactly one recipient, which is the whole point.
- **The key is the ownership check, not merely an address.** Every tab-addressed operation is a
  comparison against it (§1.4). Deriving it from the session would make the session the ownership
  boundary — and **the protocol these tools are exposed over forbids using a session for
  authentication**, for reasons that apply here undiminished.
- **Every server here communicates over the standard input and output of a process it was started
  as**, where the ownership boundary that exists in practice is the operating-system process
  boundary. That is a property of how the thing is deployed, not a guarantee the design may lean on,
  so the key carries ownership explicitly rather than inheriting it from an accident of deployment.

**There is no separate renew verb.** A dedicated one would be a second name for an effect every call
already has, and two names for one effect is how a caller comes to believe one of them does not
renew. `browser_status` is simply the call that does nothing else.
### 3.2 `browser_claim`

| Argument | Type | Required | What it's for |
|---|---|---|---|
| `session_id` | string | yes | The caller's identity. What a capture is attributed to, and what makes the resolution study's rows attributable (§1.3). **It is not a limit** — a session may hold as many leases as it is granted. |
| `browser` | `regular` or `private` | yes | **No default, deliberately.** Defaulting to private would silently give clean-room behaviour to a caller that needed a sign-in; defaulting to regular would put unnecessary work on the profile that has something to lose. Neither is a safe guess, so the caller states it. **Which one to pick is §1.2's table**, and the short form is repeated below because this is where the choice is actually made. |
| `purpose` | string, 3–200 characters | yes | What this lease is for, in human words. **What an operator reads when deciding whether to revoke** (§1.3). |
| `storage_seed` | list of entries, **at most 16**, each ≤ 4 KB | no | **Storage values written into the tab's origin before the first page load, applied by the service** (below). For the case where authentication is a token obtained from an API rather than a login form. |

**There is no `tabs` argument, and its absence is the model** (§2.3). A lease is one tab. A caller
that wants three calls this three times — and should read §2.3a first, because doing so while other
callers do the same is a named limit rather than a solved problem.

#### Picking the browser: authenticated surface, or genuinely fresh visitor

**An authenticated surface is the signed-in browser. Genuinely-fresh-visitor work is the private
one.** The full statement, including the measurement that says this needs saying and the cookie-jar
caveat that comes with it, is §1.2. Two things belong here, on the argument itself:

- **The refusal text says it too.** A claim that is refused for capacity or for a signing-in browser
  names both browsers and what each is for, because a caller re-reading a refusal is a caller
  re-making this decision.
- **So does the tool's description text**, which is the only place a calling agent reliably reads
  (§3.1's standing-tax argument cuts both ways — the description is paid for on every turn, so it
  should carry the sentence that changes behaviour).

#### `storage_seed` — seeded by the service, never executed as code

**Measured: 40 calls across 25 sessions** in the same corpus, all one shape — **fetch a token from a
local endpoint, write it into storage before the page loads, then navigate.** Every one of them went
through an execute-arbitrary-code verb, because seeding storage before first load is not something a
page can do to itself: the page that would run the code does not exist until the load that needs the
value already in place.

> **Addition 1 shrinks this and does not delete it, which is worth saying plainly rather than
> claiming the browser guidance covers everything.** The signed-in browser covers **anything a person
> can log into by hand** — it is signed in already and the sign-in outlives every process. It does
> **not** cover a service whose authentication is **a token obtained from an API** rather than
> entered into a form: there is no form for a person to fill in, so there is nothing to do by hand
> and nothing for the profile to remember.

**The shape.** Each entry names a storage area, a key and a string value, plus the origin it belongs
to:

| Field | What it is |
|---|---|
| `origin` | The origin the entry is written into, as a scheme and host — the same shape `browser_navigate` accepts (§3.7), and refused on the same grounds |
| `area` | `local` or `session`. Two areas, both per-origin, both ordinary key-value stores |
| `key` | A string |
| `value` | A string. **A string, never a structure and never an expression** — whatever the caller means by it is the caller's business, and it is stored verbatim |

**What the service does with it.** On grant, before the tab's first navigation, the service writes
each entry into the named origin's storage area **through the automation layer's own storage
interface**. The caller does not supply the mechanism, only the values. The tab is then handed over
already carrying them, which is the whole point: the first load sees them.

**What it refuses, and why each refusal is what stops this becoming an arbitrary-code channel:**

| Refused | Why |
|---|---|
| **More than 16 entries, or any value over 4 KB** | A bound is what makes this a seeding argument rather than a payload channel. The measured shape is one or two tokens; sixteen is generous against it |
| **A `value` that is not a string** | The only thing that could carry a structure is something that gets interpreted, and interpretation is the thing being refused |
| **An `origin` that is not ordinary web traffic** | Same rule and same reason as navigation (§3.7): a local-file origin turns a lease into filesystem reach |
| **Cookies** | Not an area on offer. A cookie is a credential the browser sends automatically to everything matching its domain, and the read side is already limited to names and flags (§3.9). Seeding one is credential injection on a shared profile, which §3.13 refuses by name |
| **Any entry at all on a lease that is not the caller's** | It is an argument on the claim, so it applies once, to the tab that claim grants, and there is no path to seeding somebody else's |

**It is not a code path and that is structural rather than a promise.** Nothing in the argument is
ever passed to an evaluator: the values go through a storage-writing interface that takes a key and a
string, so there is no position in which a caller's bytes could be read as a program. The
distinction is the same one §3.10 draws between evaluating inside a page and running code inside the
service, and this argument does neither.

**It is recorded.** The seed is an event on the grant — the origins and keys, **never the values**,
for the reason §3.9 gives about cookie values. So the question *"which leases started life already
holding a credential"* has an answer, which is the same mitigation §3.10 relies on where the
capability is not being narrowed.

**What comes back:** the lease's id, the key (**once — it is never stored and never recoverable**),
its state, the browser, **the tab identifier** (absent when queued), when it expires, how often to
call in, the budget and how much of it is in use, the queue information when queued, and a list of
notes.

**The notes are where the protocol says out loud what it expects.** A queued lease always carries
the obligation **and the mechanism** (§2.5): *call in with this key at least every N seconds, or lose
your place and re-queue at the back with a new key — set up a recurring check at just under that, at
around nine minutes, rather than intending to remember.* A protocol that implies an obligation and
never states it is a protocol whose clients will not meet it; one that states a deadline without
saying how to keep it is barely better, because the caller agrees and then does not act. Other notes:
per-tab session storage on every grant; and on a private lease, *clean-room relative to the signed-in
profile, not relative to other callers on this browser*.

### 3.3 `browser_status`

Takes the key. Returns the same shape without the key. **This call extends the lease**, and it is
what a queued caller polls with — **so polling is renewing**, which is what makes one duration serve
both states (§2.5).

Refuses when nothing matches the key, and when the lease has ended — naming the state and when, and
for an expired one saying plainly that the tab is gone and a fresh request is the way back.

**Like every arbitration call, this one sweeps** (§2.4). Asking where you stand expires every lapsed
lease in the store first, which is why the answer it gives is a fact rather than a stale row — and
why it is a write, which §1.0a explains is not incidental.

### 3.4 `browser_release`

Takes the key. **Gives back whatever the lease holds, and it applies to both live states:**

| The lease is | What is given back |
|---|---|
| `active` | Its tab is closed — one tab, one close — and the capacity is freed |
| `queued` | **Its place in the queue**, so everyone behind it moves up immediately (§2.5) |

**One verb for both, because the caller's intent is the same in both cases: I am done, take it back.**
A queued caller that changes its mind otherwise has no way out and blocks the queue until it lapses,
which is the same failure as a dead entry at the front — with the aggravating detail that this one is
alive and willing.

**Forgiving** — releasing twice succeeds and says the lease had already ended. Refused only for an
unrecognised key.

**On an active lease, the capacity is freed at commit and the tab is closed after it** (§2.4b). So a
release that returns successfully has definitely returned its capacity, and has *probably* closed its
page. If the close fails the page is leaked and the lease is not, which is the trade that section
explains. **On a queued lease there is nothing to close**, so the release is complete at commit.

### 3.5 `browser_tab_replace`

Takes the key. **Discards this lease's tab and opens a fresh one in its place**, keeping the lease and
its expiry. It never changes the budget — one tab out, one tab in — and the new tab gets a new
identifier, because it is a different page.

> **It exists for one reason: a tab that has stopped responding.** A page that has wedged — a script
> spinning, a modal the driver cannot dismiss, a renderer that has given up — **cannot be fixed by
> navigating**, because navigating is itself a request to that page and it will not be answered.
> Discarding the tab and opening another is the only move available, and without this tool the
> caller's only recourse is to release the lease and queue again for capacity it already holds.

**That reason is stated explicitly because a reader will otherwise reach for this tool when navigate
would do.** For a working tab, `browser_navigate` is the operation that changes the page and it is
strictly cheaper: no new tab, no new identifier, nothing else to rediscover.

The secondary use is a genuinely fresh tab — no history, no in-page state, none of the per-tab
session storage the previous one accumulated. That is real, and it is much rarer than the crash case.

Refused when the lease has ended, and when the browser is unavailable.
### 3.6 — retired

**This number described `browser_tab_close` and is left vacant on purpose.** Section numbers exist so
that a comment can cite `§3.4` rather than "the bit about releasing", and renumbering the sections
below would silently repoint every citation written against them — here and in the companion
documents. **A vacant number is cheap; a citation that quietly means something else is not.** Why the
tool is gone is in §3.1.

### 3.7 `browser_navigate`

Takes the key, a tab, an address, and optionally how long to wait for the page. Returns the final
address after redirects, the title, the response status, and **a path to the accessibility snapshot**
written on arrival — a path rather than the snapshot itself, because a snapshot of a real page is
thousands of tokens and a caller usually wants one part of it.

Refused for an unknown tab, a closed tab, and any address that is not ordinary web traffic or a blank
page. **A local-file address is refused specifically**: it turns a browser lease into an arbitrary
read of the machine's filesystem, which no part of this contract intends to grant.

### 3.8 `browser_act`

Takes the key, a tab, one action from a fixed list, a reference to an element taken from a snapshot
where the action needs one, and sometimes a value. Returns a **fresh snapshot after every change**,
because the caller's next element reference has to come from the page as it is now — a stale
reference is the most common cause of an action landing on the wrong element.

The list is the ordinary page verbs — click, type, fill, press, select, hover, check, scroll — plus
three that are argued for below, because none is obvious and two of them are the difference between
a whole kind of review being possible and being inexpressible.

#### `resize` — and the measurement that put it here

**Measured**, over a month of real transcripts: **578 calls across 140 sessions — 58% of every
session that used browser automation at all, and the sixth most-used verb of any kind.**

**No tool on this surface offers a path to it without this action**, and the gap is not a matter of
convenience:

> **It is not workaroundable.** A page's viewport is a property of the **browsing context**, not of
> anything reachable from inside the page — so `browser_evaluate` (§3.10) cannot set it. An
> expression can *read* the dimensions and can change what the page renders, and it cannot change the
> window it renders into. **There is no expression that substitutes for this action.**

**The consequence, stated as what it costs rather than as a missing feature:** the measured dominant
loop is **resize → navigate → evaluate → capture, once per breakpoint.** Without a resize action that
loop cannot be written at all, which makes **responsive review inexpressible** on this surface — not
awkward, not expensive, absent. Reviewing how a page behaves across widths is one of the main things
a caller would come here to do.

**It adds no tool, because it qualifies as an action on every count that matters.** It is scoped to
one tab, it is non-destructive, it affects no other caller, and it leaves nothing behind that anybody
has to recover from. It is exactly the shape of thing `browser_act` exists to hold.

#### Dialog handling — a small number and a large consequence

**Measured at only 8 calls in the same corpus**, which on frequency alone would not earn a place.

**It is here on consequence rather than frequency, and the consequence is lease integrity.** A native
dialog — an alert, a confirm, a prompt, a credential challenge — **blocks the tab it belongs to.**
Nothing else in that tab responds while it is up: not a navigation, not an action, not a capture, not
an evaluation. So a caller that trips one has a tab it cannot use and **a lease it is still holding
and still paying for**, and its only exit is to burn the lease — release, re-queue, and start again
against capacity it already had.

**That is a capacity failure wearing a convenience failure's clothes**, which is why the frequency
does not decide it. Eight occurrences that each cost a lease are worth an action; eight occurrences
that each cost a caller two seconds would not be.

#### `emulate` — media preferences, and the same gap `resize` has

**Measured: 19 calls across 9 sessions** in the same corpus. One action setting the media preferences
a page renders against:

| Preference | What it sets |
|---|---|
| Colour scheme | `light`, `dark`, or the no-preference state |
| Reduced motion | Whether the page is told a person prefers less animation |
| Forced colours | Whether a high-contrast colour override is in force |

**The gap is identical in shape to `resize`'s, and identical in that it is not workaroundable:**

> **A media preference is a property of the browsing context, not of anything reachable from inside
> the page.** An expression can *read* which preferences are in force, and a caller can toggle a
> page's own theme switch where the page happens to have one — **neither is the same thing.** Reading
> the preference does not set it, and a page's own switch exercises the page's own state rather than
> what the browser reports, which is precisely the code path a dark-mode review exists to check.
> **There is no expression that substitutes for this action** (§3.10), which is why the frequency of
> 19 is not the whole argument.

**And these are first-class concerns for a visual-review product rather than accessibility
niceties bolted on the side.** Dark mode is a second full rendering of every surface, maintained by
nobody who can see it unless they can switch into it. Reduced motion decides whether a capture
settles at all — §3.11 settles animations before the shutter, and a page that honours the preference
settles because it never moved. Forced colours is where a design's contrast assumptions either
survive or collapse. A service whose main purpose is looking at pages cannot reach any of the three
without this, which makes it the same class of absence `resize` was: not awkward, absent.

**It adds no tool, on the same test `resize` passes.** Tab-scoped, non-destructive, affects no other
caller, and leaves nothing behind anybody has to recover from — the preference belongs to the
browsing context the lease already owns, and it ends with the tab. It is exactly the shape
`browser_act` exists to hold, and it folds under the principle §3.1 states: a separate tool when
something must be refusable by name or when it changes what the caller owns, folded otherwise. This
is neither.

**It returns a fresh snapshot like every other action**, because changing the colour scheme can
change the page's rendered content and every subsequent element reference has to come from the page
as it is now.

#### Refusals

Refused for an unknown or closed tab; for an action that is not on the list, **listing every action**
(the discoverability cost of folding them into one tool is paid back here or not at all); for an
element reference that does not resolve, naming the snapshot it should have come from; and for a
missing value on the actions that need one.

#### Measured and deliberately not included

**Recorded with the numbers, so the absence is a decision rather than an oversight.** Over the same
month and the same **2,007 transcripts**: **drag had zero calls, drop had zero calls, and
back-navigation had zero calls.** Not "few" — none.

None of the three is added. Dragging and dropping are the two most awkward verbs in browser
automation to make reliable, and paying that cost for something no caller reached for once in a month
is the clearest possible case of surface area bought with nothing. Back-navigation is expressible
already: a caller that knows where it was navigates there.

**If any of them turns up in use, the number that justified leaving it out is written down and can be
argued with**, which is the point of recording it rather than simply omitting the verbs.

### 3.9 `browser_read`

Takes the key, a tab, and which artefacts it wants. **Returns a path per artefact, its size, and
whether it was truncated — never the contents.** The caller searches the part it needs; a full
snapshot or network log entering a conversation is paid for once in money and on every later turn in
context.

#### What comes back by default, and what has to be asked for

| Artefact | Default | |
|---|---|---|
| The page snapshot — the accessibility tree | **On** | What a caller needs to act at all: every element reference in `browser_act` comes from it (§3.8), so a read that omitted it would be useless in the ordinary case |
| Console output | Off | Ask for it |
| Network activity | Off | Ask for it |
| Cookie summary | Off | Ask for it |

**The default is the snapshot because it is the only one that is load-bearing.** The others answer
questions a caller has sometimes and most callers never have at all, and each one is a file to write
and a path to carry back.

#### Why this filter is free, which is the part worth understanding

**Console output and network activity are accumulated continuously by the browsing context.** The
browser is recording them from the moment the context exists, whether or not anybody intends to ask.
They are not fetched on demand and there is no request that starts or stops the collection.

> **So this is a filter on what gets written to disk, not on what gets collected.** The question it
> answers is *do we serialise this into a file and hand back a path*, and **the cost of not asking is
> zero** — nothing was avoided by not asking, because nothing was being done on demand in the first
> place. A caller that realises afterwards that it wanted the console asks on its next read and gets
> the accumulated history, not a recording that started when it asked.

**That is the reason the default can be narrow without being a trap.** A default that withheld
something expensive to reproduce would push callers into asking for everything defensively; this one
withholds nothing that becomes harder to get.

> **So there is no console-listener gap, and this is written down so nobody re-derives one.**
> A reader who has thought about capturing console output usually arrives expecting an action that
> starts listening — attach a listener, do the thing, read what arrived — and then notices there is no
> such action on `browser_act` and reads the absence as a hole. **It is not a hole; the requirement
> has a home already.** Collection begins when the browsing context opens, which is before the lease
> is handed over and therefore before the caller could have asked for anything. So the sequence a
> listener exists to make possible — *arm, act, collect* — is served by *act, then read*, and the read
> returns everything from the start of the context rather than from the moment of asking.
>
> **What that buys, concretely:** a caller that acts and only afterwards realises the console mattered
> has lost nothing, which is the exact case an action-scoped listener would have failed at anyway,
> because the decision to listen would have had to be made before the interesting thing happened.
> Adding a listener action would add surface (a standing tax, §3.1) to weaken a guarantee. Network
> activity works the same way and gets the same answer.

**Console output and network activity are the only two artefacts this applies to.** Cookies are the
live query named below, and the snapshot is generated on request. So *"is it already being
collected"* has a stable answer per artefact rather than being something to reason out each time.

**Cookies are the exception and it is worth naming as one.** A cookie summary is a **live query
against the browsing context**, answered at the moment of asking. There is no accumulated log to read
from, so asking is a real operation with a real cost — small, but not zero, and the answer is a
snapshot of that instant rather than a history. It is off by default for that reason as well as for
the obvious one.

**A cookie summary returns names, domains, paths, expiries and flags — never values.** Not truncated,
not masked: the field is absent. A service handing over cookie values is a credential-export feature
whatever else it is called, and there is a test that seeds a cookie with a known string and asserts
that string appears nowhere in the response or in the file.
### 3.10 `browser_evaluate`

Takes the key, a tab and an expression. Returns the value inline when it is small, and a path when it
is not.

**This is the cheap path and it exists to be used.** Computed styles, contrast ratios, box geometry,
spacing, line height and reading width are a few hundred tokens of structured data and are *more*
accurate than a model estimating them off a picture.

**It is allowed on both browsers, including the signed-in one.** No allowlist of permitted
expressions, no fixed vocabulary of measurements somebody decided in advance, and no filtering of
what comes back on this path. Three reasons, in order of weight:

1. **A lease on the signed-in browser already grants the ability to act as the signed-in user.** That
   is what the lease is *for*. An expression that reads a page's own storage is doing something
   strictly smaller than what the same lease can do by driving the page, so restricting it protects
   nothing.
2. **A restricted vocabulary would have to be guessed in advance**, and every measurement nobody
   guessed becomes a screenshot instead — pushing callers toward the expensive path this design
   spends most of its effort discouraging.
3. **Refusing the obvious storage accessors was considered and rejected as theatre.** It stops
   nobody who is trying, and it teaches a reader that a hole is closed when it is not. A rule that
   only stops the honest is worse than no rule, because it is believed.

**The exposure is real and it is handled somewhere else — at the artifact-write layer.** Rather than
policing what a caller may ask a page, **one shape-matcher runs over everything written to disk**, on
every path that writes. The reason that is the right place rather than a compromise:

> **A page snapshot can capture a rendered credential with nobody having chosen to evaluate
> anything.** A token printed on a settings page, a key shown once after being generated, an account
> identifier in a heading — all of it lands in a snapshot taken for entirely unrelated reasons. A
> control on the evaluate path would not have been near it.

So the control sits where every path converges. It matches **shapes, never a list of real values**,
for the reason `CLAUDE.md` gives: writing the real values into a check publishes exactly what the
check exists to keep out.

**And which browser every evaluation ran against is recorded** (§1.6). That is a **record, not a
restriction** — nothing is refused on the strength of it. Its purpose is that the question *"what has
been evaluated against the signed-in profile"* has an answer at all, which is the mitigation that
actually works when the capability itself is not going to be narrowed.

Refused for an unknown or closed tab, and for an expression past a size limit — a long expression is
a program, and a program wants a capability that is not on offer (§3.13). The distinction between
evaluating inside a page and running code inside the service is set out in `PLAN.md`.

> ### The "execute arbitrary code" verb: the arguments were sampled, and this is what they contained
>
> **A verb whose description is executing arbitrary code was called 328 times across 53 sessions** in
> the same month-long corpus that produced the numbers in §3.8. That count on its own said only how
> often something was reached. **The arguments have since been sampled and classified**, so what
> follows is a finding rather than a flag.
>
> **What that verb actually is, stated plainly, because the name understates it:** it executes code
> **in the automation server's own process** — with that process's filesystem, its network, and its
> full automation interface, which reaches every browser and every tab the server can see. It is not
> a page-scoped capability that happens to be broadly worded. **This design does not implement it**,
> and §3.13 refuses it by name.
>
> **The measured hazard: of the 328 calls, 101 calls across 33 sessions exercised a real shared-pool
> hazard** — something a page-scoped expression could not have done, and something that reaches past
> the caller's own lease. The three largest classes:
>
> | Measured | What it did |
> |---|---|
> | **16 calls, one session** | **Enumerated other callers' tabs and drove one it did not own.** One session, reading and acting on pages leased to somebody else |
> | **2 calls** | **Read a local environment file and extracted administrative credentials in cleartext** — the service process's filesystem, reached from a browser lease |
> | **49 calls** | **Made outbound authenticated network requests from the server process**, which is not a browser operation at all |
>
> **So the refusal is justified by evidence rather than by caution.** The question this box used to
> put — whether the verb was only page expressions after all — is answered, and the answer is that a
> third of its measured use was the thing §3.13 exists to prevent. **Roughly two thirds were page
> expressions**, and those are exactly what `browser_evaluate` provides, on both browsers, without an
> allowlist (above).
>
> **What is now covered, and it is most of the rest:**
>
> - **Page expressions** — `browser_evaluate`, this section. The largest class by far.
> - **Viewport changes** — the `resize` action (§3.8), which was reached through this verb because
>   there was no other way to reach it.
> - **Media preferences** — the `emulate` action (§3.8), for the same reason.
> - **Seeding storage before first load** — `storage_seed` on `browser_claim` (§3.2), which is the
>   measured login-bootstrap cluster, applied by the service instead of executed as caller code.
> - **Reaching an authenticated surface at all** — often the signed-in browser was the answer and
>   went unused (§1.2). **Measured: 25 sessions hand-seeded tokens into an isolated browser** while
>   it sat there.
>
> **What remains deliberately unreachable, and will stay so:**
>
> | Class | Why it is not coming |
> |---|---|
> | **Outbound authenticated network calls from the service process** — 49 measured calls | **An agent that needs to make authenticated network calls does not need a browser.** This service brokers tabs; a caller wanting an HTTP client wants an HTTP client, and routing one through a browser lease buys it nothing but this service's credentials and this service's blast radius |
> | **Reaching other callers' tabs** — 16 measured calls in one session | Every browser is shared (§1.2a), so this is the shared-fate operation §3.13's opening line refuses outright. That one session could have corrupted any concurrent caller's work with no record of having touched it |
> | **The service's own filesystem and process** — including the 2 credential reads | §3.13, unchanged. Nothing needs it and everything legitimate is reachable without it |
>
> **A caller that hits one of these gets a refusal that names the alternative** (§3.14) — and where
> there is genuinely no alternative, that is what the feedback tool is for (§3.16), which is how the
> next revision of this list gets written from evidence rather than from guessing again.

### 3.11 `browser_capture`

| Argument | Type | Required | What it's for |
|---|---|---|---|
| `tab_id` | | yes | Which tab. |
| `tier` | `detail` or `max` | **no** | Absent means the cheapest resolution. **This is the lever**: most callers never pass an optional parameter, so a low default does nearly all the work of a ceiling without blocking anyone. There is deliberately no way to ask for the default explicitly — a caller writing it out is a caller who thought about resolution and should have said which. |
| `reason` | string, 8–200 characters, **free text** | **only on the top tier** | Recorded. The only mechanism that produces data about *why* anyone escalates. |
| `diff_against` | capture id | **no** | **The identifier of an earlier capture to compare this one against.** Absent means no diff — just a picture. Present means the response carries the diff as well (§1.9). |
| `full_page` | boolean | no, default off | Unbounded page height pushes an image over the expensive threshold far more often than width does. |
| `selector` | string | no | Capture one element. Cannot be combined with a full page. |
| `label` | string | no | A caller's own name for what this is a picture of. **Goes in the file name and nothing else** — the service attaches no meaning to it, matches nothing on it, and groups nothing by it (§1.8). Restricted to a safe character set and a length, and never treated as a path (§1.7a). |
| `mask` | list of rectangles | no | Areas to paint over before the picture is taken. Masking *before* the pixels exist beats filtering afterwards, because a region that was never captured cannot be reported as changed. |

#### The diff is an argument, and capture does not depend on it

**`diff_against` is optional and nothing else in this document depends on it.** That is deliberate and
it is a sequencing property, not just a tidiness one:

> **Capture must not depend on diffing.** Diffing is the **last** thing built, and nothing earlier may
> require it. A capture takes a picture of a tab at a tier and writes it down — that operation is
> complete on its own, testable on its own, and shippable before any comparison code exists.

**This is a coupling that was deliberately cut.** An earlier arrangement had a capture consult a
canonical picture for the view it named and **take the picture at that picture's geometry**, which
made the ordinary capture path depend on the comparison feature's data model. Every capture then
carried a reason to fail that had nothing to do with capturing. **There is no such rule now**: a
capture is taken at the tier the caller asked for, always, and geometry is a question for the diff to
answer when a diff is asked for.

**Where geometry is handled instead:** in §1.9, at diff time, where the two images are already in
hand and a mismatch can be reported against the specific pair that mismatched. A width that does not
match is described in the result rather than pre-empted by constraining the capture — and on a
full-page picture the height is allowed to differ, because two full-page pictures of one page
legitimately differ in height when the content gets longer. The change in page length is reported as
its own fact rather than as a region, and the comparison runs over the height they share.

**If the named capture cannot be found, the picture still comes back** with an explanation (§1.9).
Never a refusal.

#### Every capture settles the page first

Animations and transitions are stopped, the text caret is hidden, and web fonts are waited for. This
is one line of instruction to the automation tool and it is the highest-value line in the whole
comparison feature, because **without it the same page produces different pixels run to run** — a
fading banner, a transition mid-flight, a blinking caret, a spinner, an image that arrived one frame
later. No threshold fixes any of that: a colour tolerance is a per-pixel comparison and has nothing to
say about something that moved. A comparison feature that reports a change on every run of an
unchanged page either burns the tokens it exists to save or teaches its callers to ignore it, and both
are worse than not having it.

#### What comes back, and how to escalate

**What comes back:** a path, the dimensions written, the dimensions before shrinking, the file size,
the tier, an estimated token cost, how many captures this lease has taken, the diff when one was
asked for, and a warning or nothing. **Never the image.** The caller opens the file only when it
genuinely needs to *look*.

**And on a default-tier capture, the response says how to escalate.** Not merely that higher tiers
exist — **which fields to pass**, naming `tier` and its two values, **and that the top tier requires a
written reason.** A caller that cannot read the fine print out of a specification it does not have
open is a caller that either never escalates or escalates by trial and error, and both waste a call.

**Nothing is ever refused on cost grounds.** Past a threshold, every capture is still served **and**
carries a warning — and the warning names the cheaper operation that answers the same question: *"if
you are reading a value, a snapshot or an evaluation returns it as text for a fraction of this."* A
bare "you have taken a lot of captures" teaches a caller to ask for a bigger budget; naming the
alternative teaches the thing the policy exists to teach. And the warning appears on **every** capture
past the threshold rather than only the first, because a warning that appears once has scrolled away
by the time it matters.

The only refusals are argument mistakes: an unknown or closed tab, the top tier without a reason, and
a selector combined with a full page.

#### `reason` is free text, and the reason it is not an enum

**Settled: free text.** The alternative — a fixed set of three or four choices — is countable
immediately and produces tidier data, and it is refused anyway.

**The argument that decides it is about what each instrument can discover, not about which is easier
to analyse:**

> **A fixed set can only ever report which of the author's guesses a caller picked.** It is written
> before anybody has read a single real escalation, so it encodes what somebody imagined the reasons
> would be — and a caller whose reason is not on the list picks the nearest one, which records a
> reason they did not have. **The study exists precisely to learn what nobody anticipated**, and an
> enum is structurally incapable of returning that.

**And the asymmetry in what can be recovered later settles the remaining doubt.** Free text can be
classified afterwards — read a few hundred and the categories fall out, and the categories are then
grounded in what callers actually wrote. **An enum's discarded nuance cannot be recovered by any
amount of later work**, because it was never written down. One direction is reversible and the other
is not.

**The known risk is accepted and named:** free text can fill up with *"needed the detail"* and say
nothing, at which point the study has an instrument that measured very little. That is a real
possibility. It is still strictly better than an instrument that is guaranteed to measure only what
was guessed, and the minimum length is what makes the empty answer slightly harder to give than a
real one.

> **What a required reason is actually worth, stated so it is not mistaken for a deterrent.** Asking
> for a written justification does **not** make callers escalate less, and the design should not be
> read as hoping it will: **a caller asked to justify itself will always produce a justification.**
> The friction is not the mechanism and treating it as one leads to tuning the wrong dial — making
> the field longer, or the wording sterner, in pursuit of an effect it was never going to have.
>
> **The value is the record.** Every escalation leaves a reviewable row with a reason attached, and
> that is what turns *"the top tier gets used a lot"* into *"here is what people were doing when they
> used it."* **The escalation is allowed and recorded, not discouraged** — the low default (§3.11) is
> what does the work of a ceiling, and this field is what makes the exceptions legible.
>
> **This is the same posture the feedback tool takes** (§3.16), and it is the general rule for any
> point in this design where a caller is asked to explain itself: **record for review, never friction
> for its own sake.**

### 3.12 — retired

**This number described `browser_compare` and is left vacant**, for the same reason §3.6 is: a
citation that quietly repoints is more expensive than a gap. Diffing is an argument on
`browser_capture` (§3.11) and what it returns is §1.9.

### 3.13 Deliberately absent — this list is part of the contract

**One line governs the whole list: the agent surface exposes no browser-scoped destructive operation,
ever.** Not gated behind a flag, not available with a reason attached, not present and refused — 
absent. Every browser is shared by every caller (§1.2a), so every browser-scoped operation is a
shared-fate operation, and one caller's convenience is everybody else's outage.

| Not offered | Why |
|---|---|
| **Closing, restarting, reaping or deleting a browser; closing every tab; deleting profile data** | Browser-wide and destructive. One caller would end every other caller's work, and on the signed-in profile it destroys a session a person restores by hand. **Reaping and restarting do exist** — as administrative operations, on the administrative surface (§4.3) |
| **Attaching to a browser outside the two this service manages** | Attaching is the ordinary way a caller reaches a browser here (§1.2a), so the rule is not about attaching — it is about *which* browser. The service attaches to the two profiles it manages and to nothing else, and a browser somebody else is running is never inspected and never touched. This cannot be enforced at the tool layer, because an attach is a fresh connection to whatever it is pointed at; the guarantee rests on there being no operation that takes an arbitrary target, and on the automation binary being unreachable to callers |
| **Running code inside the service itself** | A different capability from evaluating inside a page: the service's own process, its filesystem and its network. Nothing needs it and everything is reachable through it |
| **Saving or loading whole storage state; setting a cookie; writing local storage** | Credential export and credential injection on a shared signed-in profile. The read side is already limited to names and flags |
| **Any notion of a "current tab"** | Every operation names its tab. A shared implicit cursor is a bug class, not a convenience: one caller navigates and another caller's page — possibly the one holding the sign-in — is silently gone, with no error and nothing in the record to say what happened. With no current tab there is nothing to mis-target |
| **Bringing a tab to the front** | The service is not the thing that decides what a person is looking at, and moving the foreground is the one action that would make it so. It is also unnecessary: background tabs accept every operation and screenshot correctly |
| **A canonical picture to compare against, and anything that manages one** | Not moved to another surface — **it does not exist anywhere** (§1.8). There is nothing to create, bless, retire, list or tune, here or elsewhere. Diffing is here, as an argument on a capture, and the caller names which picture it means |
| **Closing the keeper tab** | It is not a tab any caller holds, and it is not addressable (§3.15). A caller cannot close what it cannot name |
| **Closing your tab while keeping the lease** | It produced a lease that owned nothing while still consuming a unit of budget — a state that should not exist when a lease *is* a tab (§2.3). `browser_tab_replace` covers the case that wanted it, and `browser_release` covers the rest (§3.1) |
| **A raw escape hatch to the underlying tool "for advanced use"** | The first rows wearing a friendlier name. If an operation is needed it becomes a real operation, with a rule and a record |

### 3.14 What a refusal looks like

Every refusal carries a **stable code** the caller matches on, the **name of the rule** that refused
(§7), a human sentence, and any details. The code and the rule name are identical on every surface;
the sentence is deliberately worded differently for a terminal and for a tool result, and is never
compared between them — asserting text is brittle and a weaker claim than asserting the code.

**Every refusal names the way forward**, because the alternative teaches a caller to satisfy the
check rather than to do the right thing. A queued caller is told its position and how often to call
in, **and how to keep it** — a recurring check at just under the lifetime (§2.5). A caller whose lease
has ended is told which state it ended in and when. A caller whose tab has stopped responding is
pointed at the operation that opens a fresh one (§3.5). A caller that named a picture that could not
be found gets the picture it asked for and a sentence saying why there is no diff (§1.9). And a
default-tier capture is told which fields escalate it, and that the top tier owes a written reason
(§3.11). The capture warning names the two cheaper operations.

### 3.15 The keeper tab — one blank page that is never leased

**One tab is always open in each browser, is never leased to anybody, is never addressable, and is
never counted against the budget.** It holds nothing, does nothing and is on a blank page.

It looks like waste, and it is the opposite. **What it prevents was measured:**

| Browser | Closing the last remaining tab |
|---|---|
| Headless | **The browser stays alive.** Nothing is lost |
| **Headed** | **The browser dies within about half a second** |

**The signed-in browser is headed**, so without a keeper tab the sequence is: the last caller
finishes, releases its lease, its tab closes, that was the only tab, and **the browser exits — taking
the shared authenticated session with it.** The next caller finds nothing running, launches a fresh
browser against the same profile, and discovers whether the sign-in survived. The person who signed
in by hand finds out at the least convenient moment.

**So the keeper tab is a correctness mechanism, not tidiness**, and it is worth understanding as one:
the release path is the *ordinary* path, so the failure it prevents is not an edge case — it is what
happens every time the machine goes quiet.

**It is not counted against the budget** because it is not capacity anybody can use. Counting it
would mean the tab budget was one lower than it says, which is a number that is wrong in the
documentation rather than in the code.

**And it is reported wherever pages are counted** — by `broker doctor` (§5.5), which checks it is
present before either browser is allowed to serve, and in the generated operations snapshot (§4.5).
**Re-justified without any served page:** a person looking at a browser window sees one more tab than
the budget accounts for, and a count that cannot be reconciled reads as a leak. This is what makes it
reconcilable. It is also a spawn-time precondition in its own right (§7.2), so something has to
report on it whether or not anybody generates a view.

### 3.16 `browser_feedback` — the tenth tool, and the one with a planned removal

**An agent that hit a problem using this service records it here.** One call, no lease required,
written to the installation's own store and read back with a command.

#### It is v0 scaffolding with an exit condition, and the design says so on purpose

**This tool is not intended to be permanent.** It exists for the period in which the service is being
actively built, tested and used by its own authors, and **the signal to remove it is a long stretch
in which no caller logs anything.** Silence is the success condition: once agents have stopped
finding things to report, a channel for reporting them has nothing left to carry, and it goes.

**Saying that changes what the tool has to be, which is why it is stated as design rather than left
as an aspiration:**

- **It needs no migration story.** Nothing is expected to read these rows in a later version, so the
  table does not have to be one anybody would want to keep.
- **It does not have to be beautiful.** It has to be trivially callable and trivially readable, and
  nothing else.
- **Removing it is a deletion, not an extraction.** Nothing else in the design reads the table, no
  operation depends on a row existing, and no refusal changes shape when it goes. That property is
  worth protecting deliberately as the rest of the service grows.

#### What it is for: reading a log instead of excavating transcripts

**The diagnostic question this service most needs answered is "what did a caller want to do that it
could not do here."** The measured evidence in §3.10 exists because somebody sampled a month of
session transcripts by hand. **That is the work this tool removes.** A caller that reaches for a
capability this surface does not offer, or that gets a refusal it cannot act on, says so at the
moment it happens — and the next revision of §3.13's list is written by reading a table rather than
by excavating transcripts again.

> **This is the only mechanism by which the product learns that a refusal message failed to say what
> to do next**, and that is the failure class this design is most exposed to. §3.14 commits every
> refusal to naming the way forward, and a great deal of the design rests on that commitment — the
> unreachable classes in §3.10, the destructive operations in §3.13, the capacity refusals in §2.
> **A refusal whose guidance is wrong or missing is indistinguishable from one that works**, from
> inside the service: the call was refused, the rule fired, the event says `deny`, and everything
> looks correct. The only thing that can tell the difference is the caller that was stuck, and until
> there is somewhere to say so, the caller's only options are to guess or to give up quietly.

#### The row: what the caller supplies, and what comes free

**Most of the value does not need the caller to type it.** At the moment of the call the service
already knows what the caller was doing, and a row carrying that plus prose is worth many rows of
prose alone — a complaint with no context is nearly worthless, and the same complaint against a named
operation and a named refusal is actionable.

| Field | Source | What it is |
|---|---|---|
| `id` | auto | Counter, primary key |
| `at` | auto | When it was written |
| `session_id` | auto where known | The calling session's identity |
| `claim_id` | **auto**, null when there is no lease | The lease the caller holds or most recently held |
| `last_event_id` | **auto** → `events.id`, null | **The caller's last operation.** Read from the ledger, so it names what was actually attempted rather than what the caller remembers attempting |
| `last_guard` | **auto**, null | **The refusal that was hit**, if the caller's last event was a denial — the rule's name from §7 |
| `rating` | caller, required | 1–5, anchored below |
| `category` | caller, required | One of the fixed set below |
| `note` | caller, required, 20–2,000 characters | Prose. What it was trying to achieve and what it expected |

**Those three auto-captured columns are the design.** `claim_id`, `last_event_id` and `last_guard`
are the ones that make a row diagnosable, and none of them costs the caller a keystroke or can be
misremembered. **A row with those three plus prose is a report; prose alone is an anecdote.**

#### The rating: did this help you get the work done, or did you have to work around it

**A 1–5 scale, with both ends and the middle written out**, because an unanchored scale is used
differently by every caller and produces numbers that cannot be compared — which defeats the only
reason to have a number at all.

**The axis is not satisfaction.** It is not whether the caller liked the service. It is **whether the
service moved the caller's actual work forward or got in its way:**

| | Means |
|---|---|
| **1** | **It stalled the work.** The caller could not do what it came to do, or spent more effort working around this service's limits than on the task itself |
| **2** | Substantial friction. The work got done, but the detour was a significant part of the effort |
| **3** | **Neutral.** The service neither sped the work up nor got in its way — it was a means to an end and behaved like one |
| **4** | It helped. The work went faster than it would have otherwise, with a rough edge worth mentioning |
| **5** | **It made the work faster.** The caller got where it was going quicker than it would have by any other route available to it |

**A caller rating anything other than 3 should say what moved it**, which is what the prose field is
for. The number makes rows comparable across many callers; it does not explain anything by itself.

#### The category: a small fixed set, chosen to be greppable

**The number says how bad. The category says what kind.** A fixed set is what makes many callers'
rows countable together, which free prose never is.

| Category | Means |
|---|---|
| `refusal-unclear` | The service refused, and the message did not say what to do next |
| `no-path` | The task could not be accomplished at all with the tools available |
| `worked-around` | The caller got there, but by an awkward or indirect route |
| `surprised-me` | It worked — but not the way the caller expected |
| `worked-well` | Positive. Something helped, and it is worth knowing which thing |

**`worked-well` is in the set deliberately.** A category list with no positive value collects only
complaints, and a channel that can only ever report problems produces a picture in which nothing
works — which is both wrong and useless for deciding what to keep. The exit condition above depends
on being able to tell *nothing to report* apart from *nobody bothered*.

**The set is small and the meanings are disjoint**, which is the whole reason it works. Two
categories that overlap get chosen by coin-flip and their counts mean nothing.

> **The tension is real and both halves are here on purpose.** The fixed set is what makes the data
> comparable **and it is exactly what makes it lossy** — every row is flattened into one of five
> words chosen before anybody knew what callers would hit. **The prose field is what recovers the
> nuance**, and it is required rather than optional for that reason. The same argument decides
> capture's `reason` in favour of free text (§3.11): a fixed set can only report which of the
> author's guesses somebody picked, and the nuance it discards cannot be recovered later, whereas
> prose can be classified afterwards by somebody who has read a hundred of them. **So this field has
> both, and neither is a substitute for the other.**

#### What good feedback looks like

**The service knows what happened. It cannot know what the caller was trying to do, or what it
expected instead.** That is the caller's whole job in the prose field, and it is the difference
between a row somebody can act on and a row somebody files away.

**Supply these three:**

1. **What you were trying to achieve** — the goal, not the call. *"Check the sign-in page at three
   widths"*, not *"call resize"*.
2. **What you expected to happen.** This is the one that catches a wrong mental model, which is often
   the actual defect — the service worked exactly as designed and the design taught the caller
   something false.
3. **What you did instead**, if anything — the workaround, the abandoned attempt, the route you took.

**Do not supply** the lease id, the operation that was refused, or the rule that refused it. All
three are captured for you and typing them adds a chance of being wrong.

| Not this | This |
|---|---|
| "resize didn't work" | "Wanted the page at a narrow width to check the collapsed navigation. Expected the viewport to change; the page reflowed but the sticky header kept its wide layout. Carried on and captured anyway." |
| "confusing error" | "Tried to claim a second tab while holding one. Refused for capacity. Expected the message to say whether waiting would help — I could not tell if I was the obstacle or somebody else was." |
| "good tool" | "The snapshot-then-act loop meant I never needed a screenshot to find an element. Rated 5 for that specifically." |

**A required explanation earns its place through the record it leaves, not through the friction it
imposes.** An agent asked to justify itself will always produce a justification — so the value was
never in making it stop and think, and a design that expects the pause to change behaviour is
expecting the wrong thing. **The value is a reviewable row with a reason attached to it.** That is
the posture here, it is the posture for capture's escalation reason (§3.11), and it is why neither
mechanism refuses anything: both record.

#### It is local, and it does not phone home

**The store is the installation's own SQLite file. There is no route out and that is a decision, not
an omission.**

> **A tool that sent anything anywhere would change what this project is.** Nothing else in this
> design opens an outbound connection, nothing listens (§5.7), and the whole surface is a browser, a
> file and a process that exits. **A feedback channel that transmitted would be the only component
> with a reason to reach the network**, and it would carry exactly the material least suitable for
> it: prose written by a caller about a page it was looking at, next to a lease identifier and a
> session identity. Whoever installs this would then need to be told what leaves the machine, which
> is a conversation this design does not otherwise have to have.

**So it is per-installation, and the consequence is accepted:** feedback from one installation is
invisible to another, there is no aggregate across users, and reading it requires access to the
machine. For a mechanism whose purpose is the authors learning about their own service during v0,
that is the whole population anyway.

#### Arguments, and no lease required

| Argument | Type | Required | |
|---|---|---|---|
| `rating` | integer 1–5 | yes | Anchored above |
| `category` | one of the five | yes | Refused with the full list if it is not one of them |
| `note` | string, 20–2,000 characters | yes | The floor is deliberate — twenty characters is roughly the shortest useful sentence, and it stops a reflexive one-word row |
| `session_id` | string | no | Supplied when there is no lease to read an identity from |
| `lease_key` | string | no | When held. **Its only effect is to attach the row to a lease** — it is not an authorisation |

**It does not require a live lease, and that is the point rather than a convenience.** A caller whose
claim was refused is the caller most likely to have something worth recording — a capacity refusal it
could not act on, a browser choice it could not make sense of, a capability it came for and did not
find. **Requiring a lease would silence exactly the population the tool exists to hear from.**

**Nothing about it is rate-limited or gated.** It writes a row and returns. The worst case is a noisy
caller writing many rows into a table nothing depends on, in a store that gets deleted when the tool
does.

#### Why it is a tool rather than an argument on something else

**§3.1's principle decides it: a separate tool when something must be refusable by name or when it
changes what the caller owns; folded otherwise.** Feedback is neither of those — and it is also not
an operation on a tab at all, which is the part that settles it. Every other tool takes a lease key
and addresses a tab. This one addresses nothing, may be called with no lease at all, and has no
browser behind it. **There is no existing tool it could be an argument on without that tool
pretending to be two things.**

**The count going from nine to ten is a real cost and is paid deliberately.** A tenth description
sits in every connected session's context on every turn whether or not anything calls it, which is
the standing tax §3.1 opens with. It is worth it for one reason: **it is the only way to find out
that a refusal failed to guide**, and this design puts more weight on refusals carrying guidance than
on almost anything else. **A tax that is removed the moment it stops earning** — the exit condition
above — is a different proposition from a permanent one.

#### Reading it back

**`broker feedback`** lists the rows, most recent first, with filters for rating and category —
`broker feedback --category no-path` is the query that says what callers came for and did not find,
and it is the one that would otherwise have been a transcript search. The rows also appear in the
generated operations snapshot (§4.5), because somebody looking at what the service has been doing
should see what callers said about it in the same document.

**It is joinable to the ledger**, which is where most of its value comes from: `last_event_id` points
at a real event, so a row can be read next to what the caller was actually doing, what the adapter
was, and which browser it ran against (§1.6).

#### Why it is its own table rather than an event kind

**It rides beside the ledger, not inside it, and the argument is worth stating because the opposite
choice is defensible.** `events` is one row per decision the service made, with a fixed kind list and
a `detail` blob that could hold a rating and a note. Folding it in would add no table.

**Three things decide it the other way:**

1. **The ledger records what the service did. This records what a caller thought.** Every existing
   kind is an operation with an outcome; a feedback row has no outcome, refuses nothing, and is not a
   decision. Putting it in the same stream means every count over `events` has to start excluding a
   kind that is not an event.
2. **The removal has to be a deletion.** The exit condition above only stays cheap if this leaves as
   one table and one tool. Folded into `events`, removing it means retiring a kind from a fixed list
   that other rows still use, and deciding what happens to the rows already written — which is
   exactly the migration story this tool was defined not to need.
3. **The ledger is the prunable thing** (§1.9) and it is written on every call by every process. This
   table is written rarely and read by hand. They have opposite lifecycles, and a table that is
   deleted wholesale should not share a lifecycle with the one thing everything else writes to.

**What it does borrow is the ledger's cursor discipline:** a counter primary key, so reading
"everything since I last looked" is the same one query it is everywhere else here.

---

## 4. Looking at what is happening — a generated file, not a served page

**Nothing is served. There is no port, no bind address, no request path and no process left running.**

**A command produces one self-contained file.** One HTML document with its styling and its behaviour
written inside it — no separate stylesheet, no separate script, no fonts to fetch, nothing loaded from
anywhere. The person opens it the way they open any other file.

That follows from the model rather than being chosen against it. With no long-lived process (§1.0a),
a served page needs somebody to start a listener, keep it running, remember it is running, and stop
it — and what they get for that is a document they were going to read once. **A file has none of that
apparatus and delivers the same document.**

What it buys, in order of weight:

| | |
|---|---|
| **Nothing to leave running** | No process to forget about, no port occupied, no listener outliving the person's interest in it |
| **Nothing to expose** | There is no address to bind, so there is no question about what may reach it. A file is reachable by whoever can read the file, which is a question the operating system already answers |
| **Nothing to depend on** | Every arbitration operation was already reachable without it (§5.2). There is not even a component whose absence somebody could mistake for an outage |
| **Trivially shareable** | One file. It can be sent to somebody, kept beside a report, or opened on a machine that has never run this service |

### 4.1 It is a snapshot, and it says so

**The single most important property of a generated file is that it is a photograph, not a window,
and the design's job is to make that impossible to mistake.**

> **It carries the moment it was taken, prominently and in the document itself** — not in the file
> name, which can be renamed, and not only in a footer. **It does not refresh, and it must not pretend
> to.** No polling, no countdown, no "live" indicator, nothing that redraws itself.

**Why this is a stated rule rather than an obvious consequence.** A page showing leases, expiries and
a queue *looks* like an operations console, and an operations console is a thing people read as
current. Somebody who opens this file an hour after generating it, and who is not reminded, will
reason about expiries that lapsed long ago and a queue that has drained. **A stale page that admits it
is stale is useful; a stale page that does not is actively misleading**, and it is misleading in the
direction of confident wrong conclusions rather than of confusion.

**The expiry derivation still applies at generation time** (§2.4): what is written into the document
is what was live at that instant, not what a row said. A snapshot of derived truth is honest. A
snapshot of stored state would be wrong twice over.

### 4.1a The unauthenticated-access question is moot

**Every option that was under consideration was about how to bind a served surface** — keep it local,
require a shared token when it is bound wider, or refuse to bind wider at all. **There is nothing
served, so there is nothing to bind**, and all three options describe a decision that has no subject.

Its consequences went with it, which is the substantive part rather than a technicality:

- **There is no unauthenticated write surface**, because there is no request path at all. Revoking is
  a command somebody runs (§5.4), and running it means having access to the machine.
- **There is no startup warning to design**, and no question of whether it can be switched off.
- **Reachability is the operating system's question**, answered by who can read a file, using
  machinery that already exists and that nobody here has to invent.

**One thing does carry over and is stated rather than assumed:** the generated document contains
purposes, session identities and page addresses read live from the browsers. **It is as sensitive as
what it describes**, and it is an ordinary file, so it should be treated like one. It contains no lease
key — that is §5.6's rule and it holds here.

### 4.2 What is in the document

| Section | Notes |
|---|---|
| Both browsers | State, restart count, and whether the discovery record checks out — **checked properly, against both of §1.2c's conditions**, because a record naming a dead endpoint is exactly what an unchecked report would call fine |
| The budget and its use | The count of live claims against the bound, with the keeper tab accounted for separately so the numbers reconcile against a browser window (§3.15) |
| Every live lease | Session, browser, purpose, state, expiry, **and where its tab actually is** (§4.2a), grouped by session so one caller holding several reads as one caller |
| The queue | Depth, positions, and the front caller's wait |
| Leaked tabs | Anything §2.4b left behind, which is what the administrative clear operation acts on |
| The most recent ledger entries | A slice, with its cursor, from §1.6 |
| **What callers reported** | The most recent feedback rows with their ratings and categories (§3.16). Somebody reading what the service has been doing should see what callers said about it in the same document — and **this section disappearing entirely is the signal that tool has done its job** |

**Every lease in it has had the expiry derivation applied** (§2.4) — it reports what was live, not
what a row said.

**Two things are deliberately not in it**, and both were in an earlier design:

- **No settings section.** There is no settings table and no way to write one (§1.10). A section
  listing environment variables would duplicate `.env.example`, which is the registry and is checked
  into the repository where it can be read beside the code.
- **No health verdict.** §4.4 explains why.

### 4.2a Addresses are read from the browsers, live, at generation time

**The process generating this document is alive and attached to both browsers**, so it does not need
a stored copy of where each tab is. **It asks.** That is the whole reason the column that would have
cached it is deleted (§1.4): the only moment anybody wanted the answer is a moment when the source was
right there.

**Two rules make that safe, and neither is optional:**

1. **Every read carries a timeout.** A browser can hang — it accepts the request and never answers
   (§2.4b) — and a document generator that inherits that hang produces nothing at all, which is a
   worse outcome than an incomplete document. The timeout is per tab, so one wedged page costs one
   entry rather than the whole run.
2. **A browser that does not answer renders as `unreachable`**, in the document, where an address
   would otherwise sit. **Not blank, not omitted, not a placeholder address** — an explicit word saying the
   question was asked and went unanswered. A missing address and an unanswered one are different
   facts, and the second is the one that indicates something wrong.

**Nothing is written to the store by this.** Reading where a tab is, is a read.

### 4.3 The administrative operations

**What these have in common is that each acts on something every caller shares**, which is why they
are not on the agent surface (§3.13): reap a browser that has wedged, restart one, and clear a tab
that leaked (§2.4b). They are commands (§5.4), so a person runs them and the ledger records that a
person did.

**There is no baseline management here or anywhere**, because there are no baselines (§1.8). That was
the other half of this surface and it is gone — along with the promotion reason, the derived naming
rule, and the scheduling problem where the resolution study would have invalidated every blessed
image at once (§9.3). **All of it was cost incurred to maintain a canonical picture, and there is no
canonical picture.**

### 4.4 There is no health check, and `broker doctor` is why

**A health endpoint reporting "can this service grant a lease" was a sound idea for a long-lived
process and is the wrong shape here.** It is removed rather than reimplemented.

**What it was for:** something outside the service asking, repeatedly, whether the thing was still
working — which is a question you ask of a process that is supposed to be up. **Nothing here is
supposed to be up.** A service that is not running has not failed; it has exited, which is what it
does.

**What answers the underlying question instead:** `broker doctor` (§5.5). It reports every
precondition separately — the store, its location, its version, the automation tool, the roots, each
browser's discovery record checked for liveness *and* identity, the capture-surface setting, the
keeper tab — and it **exits with a distinct code on any failure**, so it is usable exactly where a
readiness check would have been used. It is strictly more informative: a health verdict collapses
every precondition into one word, and the word does not say which one failed.

**And a served endpoint would have contradicted the plan of record.** `MILESTONES.md` has no work
item standing one up, so shipping it would mean either an unbuilt endpoint documented as though it
existed, or work nobody scheduled. Naming that outright is cheaper than leaving two documents
disagreeing.

### 4.5 Generating it

**One command, one file** (§5.5). It writes the document wherever it is told, reports the path, and
exits. It leaves nothing behind and holds nothing open.

**No framework and no build step.** The document is assembled from one status read plus the live
address read in §4.2a, and its styling and behaviour are written inline. That is not asceticism: a
self-contained file is the only kind that still renders correctly when it is moved, sent to somebody,
or opened on a machine that has nothing installed.

**It renders derived state, never stored state** (§2.4). The status it is built from has already had
the expiry derivation applied — **a document assembled from direct table reads would show lapsed
leases nobody has swept as though they were live**, and it would look entirely plausible while doing
it.

**Read-only: no controls, no forms, nothing to click.** Revoking is deliberately absent even though
the operation exists, and the reason is sharper here than it was for a served page: **this document is
a photograph.** A button in a photograph would act on state that has moved on since the shutter, and
the person clicking it would be acting on what they can see rather than on what is true. Revoking is a
command (§5.4), run against the service as it is at that moment.

---

## 5. The command line

### 5.1 Shape

`broker <noun> <verb>`, plus a few single-word commands that name one thing each.

**The command line is a full route in, and it is worth building even if no agent ever calls it.** It
is the cheapest available proof that the rules live in one place rather than inside a tool handler —
a rule inside a handler is a rule that holds on one route and nowhere else.

### 5.2 Everything runs in the process that invoked it

**A command opens the store and runs the service's own logic in its own process.** That is not a mode
or a fallback — it is the only arrangement, because there is nothing else for a command to talk to.
No server to point at, no socket to find, no daemon to be running or not running.

**In process is not "no service".** The sweep, the expiry and the browser work all live in the service
layer, so **any command that goes through arbitration performs the lazy sweep** (§2.4) — it expires
every lapsed lease in the store before answering. That is correct and it is stated here because it is
surprising the first time a listing command closes somebody's tabs.

**Which also means the command line is subject to the reader rule** (§2.4): a command that read the
tables directly and printed `state` would report leases that do not exist. Every command goes through
the service for that reason, not merely for tidiness.

### 5.3 The commands that mirror an operation

Every §3 operation has one, so parity is real rather than claimed: `claim`, `status`, `release`,
`tab replace`, `navigate`, `act`, `read`, `evaluate`, `capture`, `feedback`. **Ten commands for ten
tools**, and the diff rides on `capture` here exactly as it does there (§3.11) rather than being an
eleventh.

**`broker feedback` carries both halves** — it writes a row with the same arguments the tool takes,
and with no arguments it reads the rows back (§3.16). That is the one command whose reading half has
no tool behind it, because a caller writes feedback and a person reads it.

**`broker claim --wait` is the command line's answer to the keep-calling-in protocol**, and it is the
one place this route does something the tool surface does not. It polls at **just under the lease
lifetime** until the lease becomes active or the place is lost — which is exactly what a queued caller
is told to do (§2.5) and is tedious to write in a shell. It calls the same operation on every poll and
adds none of its own. **It is the mechanism the queued response describes**, available to anyone who
would rather not build it.

### 5.4 The operations commands

List leases · revoke one with a reason · show the browsers · read the ledger · list captures · **list
diffs** · **read back what callers reported** (§3.16) · **reap or restart a browser, and clear a
leaked tab** · **generate the operations snapshot** (§4.5).

**There is no configuration command.** Nothing gets, sets, clears or lists a setting, because
configuration is the environment (§1.10) and `.env.example` is where the variables are documented. A
command that printed the environment back would be a second, less reliable copy of a file that already
lists every key with its default.

**There is no baseline command**, because there are no baselines (§1.8).

**The browser commands are the administrative operations from §4.3**, and they are on this route for
the same reason the rest of that surface is: a person is deciding, and the ledger has somewhere to put
who. They are not on the agent surface and adding them there fails the build (§7.3).

### 5.5 The commands that have no operation behind them

Each carries a **written waiver** in the parity suite rather than being quietly absent from it.

| Command | What it does |
|---|---|
| `broker snapshot` | Writes the **operations document** (§4) to a path and exits. One self-contained file, labelled with the moment it was taken. **Nothing keeps running afterwards** — this is the whole of the visual surface, and it is a command rather than a server for the reasons §4 sets out |
| `broker doctor` | Every precondition, reported separately: the store's location, that it is **not on a network filesystem** (§1.0), and that it is at the version this build expects · automation tool present, and its version · artifact and profile roots writable · each browser's discovery record, **checked for liveness and identity rather than merely present** (§1.2c) · the capture-surface check · the keeper tab (§3.15) · **and whether the stored tab budget agrees with this process's environment** (§1.10). Exits with a distinct code on any failure, so it is usable as a readiness check — **and it is what a health endpoint would have been for** (§4.4), in a better shape, because it names which precondition failed rather than collapsing all of them into one word |
| `broker login <browser>` | The one time a person drives — §5.5.1 |
| `broker init` | The setup handshake (§1.2d), run explicitly. **Every spawn does it anyway**, so this command is for seeing the report rather than for causing the effect |

#### 5.5.1 `broker login` — the one time a person drives

**The signed-in browser runs headed and stays headed.** That is a change from an earlier position
that ran everything headless for speed, and the reason is the keeper tab measurement (§3.15): the
signed-in profile is the thing this design most needs not to lose, a headed browser is what a person
signs into, and relaunching it between modes is a chance to lose it that buys nothing. The private
browser is headless, where the speed is free and there is nothing to lose.

**So signing in does not switch modes** — the window is already there. What the command does is claim
the browser for the person:

1. **Refuses if any live lease holds a tab on that browser**, naming them. Somebody is about to drive
   the window by hand, and doing that underneath a caller's work would corrupt it. That refusal is
   why signing in is a service operation and not something a person does to the browser directly.
2. Puts the browser into its signing-in state. From that moment, requests for it are refused with a
   retry hint. **Queued callers keep their places and their timers**, because a sign-in is a pause and
   not a cancellation.
3. Hands the person the window. They sign in.
4. On their confirmation, the browser goes back to `running` and the queue is swept.

**Nothing is stopped and nothing is relaunched**, which removes the step where a sign-in could be
lost. Everything a sign-in produces is written into the profile directory (§1.2), and the profile is
the identity — so there is no state to copy anywhere, and no credential-export operation to invent.

**Refused on the private browser.** Signing into an ephemeral profile produces nothing that outlives
the browser, so the command would appear to work and quietly do nothing — the worst of the available
failures.

### 5.6 Output, exit codes and identity

**Human-readable by default**, with a machine-readable mode that produces one document per call and
puts all human text on the error stream, so a caller that did not ask for prose gets none.

**The refusal codes are the same identifiers the other surfaces return.** That is what lets identical
enforcement be asserted rather than assumed.

**Exit codes are chosen so situations wanting opposite responses are distinguishable without parsing
anything:** accepted (**including queued** — queuing is an outcome, not a failure) · unexpected
failure · malformed command · **refused by a rule**, distinct because a refusal is the service
working · not configured.

**The lease key is never printed by any command**, including in error output and in the
machine-readable mode, where the field is absent rather than masked.

**There is exactly one exception, and it is the grant.** `claim` returns the key it just issued,
because a lease whose key was never returned is a lease nobody can address: §2.2 returns a key once
and makes it unrecoverable by construction, so there is no second way to learn it. Withholding it
made `claim` a command that **succeeded and could not be used** — it took real tab budget (§2.3
makes grants and tabs the same integer), minted a lease, and left every keyed command on this
surface unable to reach it. The lease then held its tab until its lifetime elapsed. A command that
silently spends bounded capacity on an unusable lease is worse than one that refuses.

This is deliberately the *same* exception the tool surface already carries and states, rather than a
second rule for a second surface: one hole, named identically in both places, is what keeps
"identical enforcement asserted rather than assumed" true. The alternative considered was removing
`claim` from the command line, and it was rejected because §5.3 requires every §3 operation to have
a command "so parity is real rather than claimed" — dropping one would make that false in exchange
for a secrecy the other surface does not keep either.

**The hole is exactly this wide:** the key appears on `claim`, on the grant, and nowhere else. Every
other command strips it, and so does every refusal, including a refusal of `claim` itself. The
edges are asserted rather than intended — the operations check drives a second command with the key
and confirms it does not come back.

### 5.7 Nothing needs anything running

**Every surface runs in the process that invoked it.** The tool surface runs in the service a caller
spawned; every command runs in process; the operations document is written by a command that exits
(§4.5); and configuration is the environment each process already has (§1.10).

**So the property is unqualified, which it was not when a page had to be served:** there is no
component of this design whose absence stops anything working. Not leases, not the queue, not
captures, not diffs, not looking at what is happening. The thing that would ordinarily be "the
service" is a library the caller runs, and the only things that survive between callers are a browser
and a file.

---

## 6. Configuration

### 6.1 Everything is an environment variable, and everything has a working default

**There is one place configuration lives and it is the process environment.** No settings table, no
configuration file format, no configuration command, no resolver reconciling a declared default
against a stored override (§1.10).

> **A fresh install runs with nothing set.** Every variable has a working default, so the shortest
> path from installing this to using it is to install it and use it.

**`.env.example` is the registry.** It ships in the repository and lists **every variable the service
reads, its options, and its default** — so "what can I change" is answered by reading one file that
sits beside the code and can be checked against it. It carries keys with placeholder values, never
real ones.

**Values are plain strings and enums.** Nothing nested, nothing encoded, nothing needing a parser to
be correct. A configuration format is a thing that can be malformed, and a value that can be malformed
needs a validator, an error path and a decision about what to do when it fails — all of which is
apparatus this design declines to buy.

**Configuration is never a secret store.** Every value is readable by anything that can read the
process environment. Credentials do not belong in it, and §7.3 keeps a build rule saying so.

**The one value that is also written to the store is the tab budget**, for the reason §1.10 sets out
in full: several processes arbitrate against it at once, and a bound they can disagree about is not a
bound. The first process to open the store records it; any later process whose environment disagrees
refuses to start and says so. **That is a check, not a configuration surface** — there is nothing to
set and no command that sets it.

### 6.2 The variables, their defaults, and when a change lands

**When a change lands is simpler than it looks**, because a process is spawned per session and reads
its environment on the way in (§6.3). **A change is in force for the next process**, which is one call
away. The only genuine exception is anything a browser reads at launch, because the browser outlives
the process that started it — and those say so by naming the browser rather than by naming a restart.

| Variable | Default | What it's for |
|---|---|---|
| `BROKER_DB` | A directory of the service's own under the per-user application-data location the platform defines | **Where the database file is** (§1.0). Refused at startup if it resolves to a network location |
| `BROKER_ARTIFACTS_ROOT` | Likewise | Where files are written (§1.7a) |
| `BROKER_PROFILE_ROOT` | Likewise | Where the two browser profiles live. Each browser launches against this plus its own name, **explicitly and mandatorily** — never a default profile location, and never nothing (§1.2) |
| `BROKER_SESSION_ID` | Absent | The identity a command acts as. Exported by whatever launches a session, never typed by hand |
| `BROKER_KEY` | Absent | The lease key. Never printed by any command (§5.6) |
| Tab budget | **15** | Total tabs across **both** browsers, and — since a lease is a tab (§2.3) — **the same number as the maximum count of live leases**. No per-browser cap: the scarce thing is page processes and one costs the same in either browser. The keeper tab in each browser is not counted (§3.15). **Provisional** — reasoned from roughly 50–150 MB per idle page process plus two browser processes, so fifteen is one to two gigabytes. **This is the one value also written to the store** (§1.10) |
| Lease lifetime | **10 minutes** | How long an active lease lives without a call |
| Queue-place lifetime | **10 minutes** | How long a place in the queue lives without a call. **Deliberately equal to the row above** — §2.5 sets out why, including why the argument for making them differ pointed the other way |
| Headed, per browser | **signed-in: on · private: off** | The signed-in browser is headed because that is what a person signs into and the keeper tab exists to keep it alive (§3.15). The private one is headless, where the speed is free and there is nothing to lose. **Read at browser launch**, not per call |
| Launch-readiness timeout | **open — see §1.2b** | How long a caller that lost the launch race waits for the winner's browser to accept a connection before declaring it failed. **No default is offered**, because what it should wait *for* is itself unresolved |
| Restart backoff · maximum restarts | **5 s · 5** | After the maximum, the browser is failed and requests for it are refused. It counts against `browsers.restart_count` (§1.2). It does not retry forever, because a browser that has failed five times is failing for a reason a retry will not fix |
| The three resolution rungs | **1024 · 1568 · 2576 px** on the long edge | What a capture is shrunk to. **Provisional** — a study exists to settle them with evidence (§9.3). **Changing a rung invalidates nothing**, because nothing is stored at a rung and compared against later: a diff compares two captures the caller named, and if they were taken at different rungs the result says so (§1.9) |
| Full page by default | **off** | Unbounded page height crosses the expensive threshold more often than width does |
| Captures per lease before warning | **12** | Roughly a five-view sweep at two breakpoints plus slack. **Never a refusal** |
| Inline result cap · expression size cap | **4 KB · 8 KB** | Past the first, a result spills to a path; past the second, an expression is refused |
| Colour tolerance · smallest change reported · most regions returned | **0.1 · 64 px² · 12** | The tolerance is the diff library's own default, which is a better starting position than a number invented here precisely because it is not one. The size filter is on **area with a thin-line allowance**, so a one-pixel line across a page survives it. Past the region cap the result is truncated, smallest first, and says so |
| How far apart two changes stay separate · padding on a crop | **8 px · 16 px** | The first decides whether two nearby changes are reported as one region or two; the second is context around a crop, because a tight box with nothing around it can be genuinely unidentifiable |
| How long the ledger is kept | **forever** | Trimming it is possible and is not the default |

**Variables that are deliberately absent**, because each would be a position this design has already
taken and a setting is how a position quietly gets reversed:

- **No capture-file retention, and no crop retention.** **Both are deleted** (§1.9). Nothing sweeps
  an image. A diff names an earlier capture and the service either finds it or explains that it could
  not — and with no sweeper, the ordinary reason it cannot is that the caller named the wrong thing,
  which is exactly the case an explanation helps with. **A retention window would have reintroduced a
  failure the caller cannot diagnose**: an identifier that was valid last week and is silently invalid
  now, for a reason nothing in the response mentions.
- **No grace period after a disconnect.** **Deleted**, and it is worth saying why rather than simply
  dropping it: it was inert by its own description. On the ordinary route the caller and the service
  exit together, so there is no disconnect signal to read, and a lease that has stopped being renewed
  is the only evidence there is. **A value whose only behaviour is an explanation of why it does
  nothing is documentation wearing configuration's clothes**, and it invites somebody to tune it and
  expect an effect.
- **No "refuse captures after N".** Nothing is ever refused on capture grounds, and a value that could
  turn a warning into a wall would make that promise conditional.
- **No per-browser budget.** One counter, on purpose.
- **No per-lease tab allowance.** **Deleted rather than defaulted** (§2.3). A lease is one tab, so
  there is nothing for such a number to bound.
- **No sweep interval.** There is no timer to schedule — reclamation happens on every arbitration call
  (§2.4), so the only tunable that could exist is how often callers call, which is not this service's
  to set.
- **No browser count and no third-browser flag.** Exactly two, no exceptions, ever.
- **No bind address and no port.** Nothing is served (§4).
- **No variable permitting a network location for the store.** The refusal (§1.0) is about a guarantee
  the write-ahead log cannot provide, not about a policy somebody might disagree with.
- **No variable controlling how much of a page address is stored.** Nothing stores one (§1.4).

### 6.3 Reading configuration, and what a bad value does

**One snapshot of the environment per process**, read at the start and used throughout, so every rule
inside one operation sees one configuration. **There is no cache to go stale and no re-check to
schedule**: a process lives for one session, so a change made now is in force for every process after
it. The guarantee is unusually simple as a result, and it is worth noticing that it is simple
*because* nothing is long-lived — this is one of the few places the daemonless model makes something
easier rather than harder.

| Situation | What happens |
|---|---|
| A variable is unset | **Its default is used.** This is the ordinary case and it is what makes a fresh install work with nothing set |
| A variable is set and valid | It is used |
| A variable is set and cannot be read as its type | **Refuse to start, naming the variable and what was expected.** Not the default silently: a caller that set a value and got the default would be running a configuration it did not choose and has no way to notice. The value is one line in one file and the fix is immediate, so refusing costs a correction rather than an outage |
| The tab budget disagrees with the value in the store | **Refuse to start, naming both numbers** (§1.10). Neither is adopted and neither is overwritten |
| A variable the service does not recognise is set | Ignored. A process cannot tell an unrecognised variable of its own from any other variable in an environment it shares with everything else on the machine |
| A default changes between versions | Every installation that never set that variable changes behaviour on upgrade. **That is a behaviour change and is treated as one** — it belongs in release notes, not in a change nobody reads |

**A version mismatch is not a configuration problem and is not handled here.** Two callers on
different builds can spawn against the same store; the schema stepper (§1.2d) is what reconciles that,
and a build that finds a store newer than it understands refuses rather than guessing (§7.2).

### 6.4 Fixed by the version, not configurable

The tool descriptions, the protocol version the agent surfaces speak, the list of rules (§7), the
formula that estimates an image's token cost, and the fixed value lists in the schema.

**The token formula is fixed on purpose.** An estimate is only comparable across time if it was
computed the same way, and letting an operator change the formula would silently make old and new
numbers incomparable — which would break the one study they exist for.
---

## 7. Every rule, and what it refuses

**A rule that never refuses anything protects nothing, so the refusals are the specification.** Every
row here owes a test that fires it. Rules come in three kinds, and mixing them up is how one ends up
unenforced: some are checked on every call, some once at startup, and some by a check that stops the
build.

### 7.1 Checked on every call

| Rule | What it requires | Refuses with |
|---|---|---|
| `key.present` | Every operation except requesting a lease carries a key, **written out explicitly by the caller and never derived from a session** (§3.1) | key missing |
| `key.valid` | The key matches a lease | unrecognised key |
| `claim.live` | That lease is queued or active | lease has ended, naming the state and when |
| `claim.browser_known` | The browser named is one of the two | unknown browser |
| `capacity.admission` | **The count of live claims is below the budget.** One integer against one integer — there is no request size to add, because a claim is one tab (§2.3) | **Not a refusal.** This is the test that decides granted against queued — the one rule whose failure is a successful outcome. **It reads a count that the same transaction has just reconciled** (§2.4), so it can never admit against capacity held by a lease that has already lapsed |
| `arbitration.writes` | **Every arbitration path declares its intent to write when it opens its transaction, and every one of them does write.** Enforced because the guarantee is writer serialisation, not full serialisability (§1.0a) | **Not a refusal — an invariant.** A path that reads without writing is not refused at run time; it is a change to the model, and §7.3 is where it is caught |
| `arbitration.no_browser_io` | **No browser call happens inside the arbitration transaction** (§2.4b) | **Not a refusal — an invariant**, and the one whose violation would be worst: a wedged browser inside the transaction blocks every arbitration call on the machine. Caught by the build (§7.3) |
| `tab.owned` | The tab belongs to this lease | tab not found — **the same refusal as an unknown tab**, so probing cannot discover another lease's tabs |
| `tab.open` | The tab is open | tab not open |
| `release.gives_back_either` | **Releasing returns whatever the lease holds — a tab, or a place in the queue** (§2.5, §3.4) | **Not a refusal — a shape.** Releasing is forgiving in both states, and a queued caller that has no way to stand aside is the failure this rule exists to make impossible |
| `browser.serving` | The browser is available | browser unavailable, with a retry hint. Covers signing-in, failed, starting and stopped |
| `browser.attach_verified` | **A browser is attached to only after its discovery record passes both checks** — the endpoint answers, and the browser identifies itself as the expected one (§1.2c) | browser unavailable. **Never attach on the strength of the record alone**: it was verified to survive a hard kill, and a reused port makes the number alone a false match |
| `browser.busy_for_login` | Signing in is refused while any live lease holds a tab on that browser | browser busy, naming the leases |
| `keeper.never_leased` | **The keeper tab is never handed to a caller and is never addressable** (§3.15) | **Not a refusal — a shape.** A caller cannot name it, so there is nothing to refuse |
| `navigate.scheme_allowed` | Ordinary web traffic or a blank page | invalid address. **A local-file address is refused explicitly**: it turns a browser lease into an arbitrary read of the machine's filesystem |
| `capture.max_tier_reason` | The top tier carries a reason, **free text within its length bounds** (§3.11) | reason required. **The only capture refusal about anything other than a malformed argument, and it is about recording rather than about cost** |
| `capture.exclusive_mode` | A selector and a full page are not both asked for | cannot do both |
| `capture.independent_of_diff` | **A capture is taken at the tier the caller asked for, and consults nothing else** (§3.11) | **Not a refusal — an invariant.** Capture must not depend on diffing, because diffing is the last thing built and nothing earlier may require it |
| `diff.target_missing_returns_image` | **When the named capture cannot be found, the full screenshot is returned with an explanation** (§1.9) | **Never a refusal, and that is the rule.** The caller asked for a picture; it gets a picture, plus a sentence saying the diff could not run because the image it named was not found |
| `evaluate.expression_bounded` | The expression is within its size cap | expression too long |
| `artifact.owned_by_lease` | **An image request serves only artifacts belonging to the asking lease** (§1.9) | not found, non-disclosing, same shape as an unknown tab |
| `artifact.path_never_supplied` | **An image request names a row, never a path.** The path is looked up from the database and resolved under the artifact root | **Not a refusal — a shape.** There is no request path to traverse, because a caller cannot supply one |
| `capture.page_settled` | Animations stopped, caret hidden, fonts waited for, before every picture | **Not a refusal — a shape.** Without it the same page produces different pixels run to run, and no colour tolerance can address something that moved (§3.11) |
| `capture.name_from_address` | **A capture's file name derives its page slug from the page address, with the query string stripped, restricted to safe characters, truncated, and never treated as a path** (§1.7a) | **Not a refusal — a shape.** A file name travels further than a database column does, so the query string is removed before anything else |
| `capture.label_safe` | A caller's label is within a safe character set and length, and is never treated as a path | invalid label. The same reasoning that refuses a local-file address |
| `revoke.reason_required` | A revoke carries a reason | reason required |
| `read.default_snapshot_only` | **A read returns the page snapshot unless console, network or cookies were asked for** (§3.9) | **Not a refusal — a default.** Console and network are accumulated by the browsing context regardless, so this filters what is written to disk and the cost of not asking is zero. **Cookies are the exception**: a live query, so asking is a real operation |
| `read.cookies_no_values` | A cookie read returns names, domains, paths, expiries and flags | **Not a refusal — a shape.** The value field is absent, not masked |
| `artifact.write_scanned` | **Everything written to disk passes a shape-matcher first** — captures, snapshots, logs, crops (§3.10) | **Not a refusal of the operation.** It is the single place the credential-exposure question is answered, chosen because a snapshot can capture a rendered credential with nobody having asked for one. Matched as shapes, never as a list of real values |
| `evaluate.browser_recorded` | **Which browser an evaluation ran against is recorded** (§1.6) | **Not a refusal — a record.** Evaluation is permitted on both browsers, so this is what makes the question *"what has run against the signed-in profile"* answerable |
| `reader.derives_expiry` | **Any reader touching the store applies the expiry derivation before reporting** (§2.4) | **Not a refusal — an invariant.** A reader that trusts `state` alone reports leases that do not exist, and it does so most on a busy installation |
| `act.verb_known` | **The action named is one this build performs.** The check that the closed union of actions is closed at the boundary as well as in the type system (§3.8) | unknown action, listing every action the service performs. **See the naming note below** — the real service raises this as `act.action_known` |
| `act.action_known` | **An action is an object naming what to do and what to do it to**, and the verb is one of the known set (§3.8) | unknown action, listing every action the service performs |
| `act.ref_required` | An action that addresses an element carries a reference **taken from that tab's most recent snapshot** (§3.8) | reference required, naming the action and the field. The reference is a handle the snapshot minted, never a selector the caller composed |
| `act.value_required` | An action that applies a value carries one | value required, naming the action |
| `act.viewport_bounded` | A viewport side is **a whole number of pixels greater than zero** | invalid viewport, naming the side and the value |
| `act.emulate_preference_named` | An emulate names **at least one** media preference from the known set | preference required, listing the preferences |
| `act.dialog_answer_named` | Answering a dialog says **whether to accept or dismiss it** | answer required. A dialog left unanswered blocks the page, so there is no default to fall back on |
| `act.form_fields_bounded` | A batch fill carries **at least one field and no more than the maximum**, each with a reference and a value | invalid fields, naming the maximum |
| `act.drag_ends_differ` | A drag's two references **are not the same element** | invalid drag. A drag onto itself is a caller mistake rather than a no-op, and silently succeeding would hide it |
| `read.artifact_known` | A read names **which artefacts it wants**, from the known set (§3.9) | unknown artefact, listing the artefacts |
| `evaluate.result_serialisable` | An evaluation's result **has a plain representation** — no cycles, nothing the service cannot return (§3.9) | unserialisable result, saying to evaluate to plain data. **The refusal carries the reason and never the value**, for the same reason a cookie read returns no values |
| `feedback.rating_in_scale` | A rating is **a whole number within the scale**, on a help-versus-hinder axis rather than a satisfaction one (§3.12) | rating out of range, naming the bounds and the anchors |
| `feedback.category_known` | The category is one of the five | unknown category, listing all five with their descriptions |
| `feedback.note_bounded` | The note is **within its length bounds** | note out of bounds. The message says what to write, and says that the lease, the operation and the refusing rule are captured automatically rather than supplied |
| `service.not_built` | **A command that needs the service layer has one.** A build without it refuses the command rather than failing partway through it | service unavailable, naming the operation. **Not a caller mistake** — it is a statement about how this build was assembled |

**A naming divergence, recorded rather than quietly reconciled.** `act.verb_known` and
`act.action_known` are the same check under two names: the conformance double raises the first and
the real service raises the second. Both are listed above because **both are cited in the source**,
and §3.14 requires a refusal to cite a rule that exists here — so listing only one would leave the
other a dangling citation. Reconciling them is a change to the conformance suite and to the service
double, which is a code change rather than a documentation one, and it is left to the row that owns
that seam.

**`arbitration.registered` is deliberately absent.** It is cited in `refusals.ts`, but that file
states outright that it is *"not a §7.1 row"* — the arbitration runner raises it for an operation
named on a surface this build does not register, which is a version mismatch between a caller and
this service rather than a per-call rule. It is recorded here so that a later reader running the same
diff does not conclude it was missed.

### 7.2 Checked on every spawn — the service refuses to run

Each of these guards a failure that is **silent**: the operation succeeds and returns something wrong.

**"On startup" means on every spawn here** (§1.2d), which makes these cheaper to trust than they
would be against a long-lived process: there is no installation that passed the checks once, months
ago, and has been drifting since.

| Rule | What it requires | On failure |
|---|---|---|
| `store.not_on_network_filesystem` | **The resolved database path is not a network location** — checked two ways, because one is not enough: the resolved path's root is not a network share, **and** the volume's reported type is not a network volume (§1.0) | **Refuse to run.** The write-ahead log's shared-memory index requires every process on one host (`sqlite.org/wal.html`), and the failure on a network filesystem is corruption rather than a clean error. **A mapped network drive is lexically identical to a local one**, which is why the second check exists and why the first alone would pass every test written on a machine with nothing mapped |
| `store.location_from_environment_only` | The database location comes from the environment and is never read from the database | **Refuse to run.** A value only readable after opening the file cannot say which file to open (§6.1) |
| `budget.agrees_with_store` | **This process's tab budget matches the value recorded in the store** (§1.10) | **Refuse to run, naming both numbers.** Several processes arbitrate against this bound simultaneously, so two of them believing different numbers means each admits correctly against its own belief and **the ceiling silently stops being one.** Neither value is adopted and neither is overwritten — adopting would run a process against a bound it was not configured for, and overwriting would let the most recent starter move a bound others are mid-arbitration against |
| `config.value_readable` | Every variable that is set can be read as its declared type (§6.3) | **Refuse to run, naming the variable.** Falling back to the default would run a configuration nobody chose, with nothing to notice it by |
| `launch.explicit_profile_dir` | Every browser launches with an explicit profile directory the service owns. **Never a default profile location, and never absent** | Refuse to launch. A default location is shared with anything else that also takes the default, and two processes on one profile contend on its lock file — so an unrelated run that started first would stop this service starting at all. **And with browsers adopted rather than owned** (§1.2a), the directory is what identifies a browser at all |
| `launch.detached` | **A cold start spawns the browser binary detached**, never through the automation library's launcher (§1.2a) | Refuse to launch. The launcher's client owns what it starts — verified: closing it killed the browser — so a browser started that way dies with the first caller that finishes |
| `launch.default_args_intact` | The launch settings are the automation library's defaults **plus** what this service adds — never its defaults minus anything | Refuse to launch. Those defaults include what keeps background tabs running at full speed and what makes capturing them work; removing them is how a service becomes mysteriously slow and mysteriously wrong at once |
| `launch.capture_surface` | The browser is launched with the setting that makes screenshots capture the right tab | Refuse to serve; the browser never reaches running. Without it, capturing a background tab can return **another tab's pixels** with no error — which is why this is a refusal to start rather than a warning |
| `startup.schema_stepped` | The store is stepped to the version this build expects before anything else happens (§1.2d) | Refuse to run. **A store at a version this build does not understand is a refusal, not an attempted downgrade** — two callers on different builds against one store is an ordinary situation here, and guessing is how one of them corrupts it |
| `setup.profile_never_destroyed` | Setup creates a profile that is absent and uses one that is present | Refuse to launch rather than recreate. A recreated profile is a person silently signed out (§1.2d) |
| `keeper.present` | Each browser has its keeper tab open before any lease is granted against it (§3.15) | Refuse to serve that browser. **Measured**: headed, closing the last remaining tab kills the browser within about half a second — and the signed-in browser is headed |

### 7.3 Checked by the build — the service refuses to ship

These prohibitions cannot be checked at run time, because the correct behaviour is that the call
**never happens**, and a rule with no call site is not a rule.

| Rule | What it requires |
|---|---|
| `arbitration.immediate_transaction` | **Every arbitration path opens a transaction that declares its intent to write.** Measured: 30 concurrent processes on an immediate transaction all succeeded; the same test on a deferred one with a widened read-then-write window **failed 15 times in 25**, with an error the busy-timeout setting cannot retry (§1.0a) |
| `arbitration.no_read_only_path` | **No arbitration path answers without writing.** This is the invariant most likely to be broken by a well-intentioned optimisation — a "check status without sweeping" fast path — and the reason it must be caught by the build is that **it would pass a low-contention test suite** |
| `arbitration.no_browser_io` | **No browser call is reachable from inside the arbitration transaction** (§2.4b). One unresponsive browser inside it blocks every arbitration call on the machine |
| `foreground.never_moved` | **The service never brings a tab to the front.** It is the only action that would move what a person is looking at, and background tabs accept every operation and capture correctly without it |
| `capture.surface_required` | **No capture is ever taken with the correct-surface setting disabled.** In a windowed browser it returns another tab's pixels, with no error — a wrong answer that looks exactly like a right one |
| `browser_scoped.never` | **No operation on the agent surface is browser-wide and destructive**, on any transport. Reap and restart exist administratively (§4.3); what fails the build is either of them appearing on the agent surface |
| `capture.no_diff_dependency` | **No capture path reads anything belonging to the diff feature.** This is what keeps the sequencing property real rather than intended: diffing is built last, so a capture that consulted it would make the earlier work depend on the later (§3.11) |
| `artifact.no_request_path` | **No path that serves bytes accepts a filesystem path from a caller.** It resolves a recorded path under the artifact root or it serves nothing, so traversal has no input to arrive through (§1.9) |
| `driver.import_isolated` · `db.import_isolated` | Only the browser module reaches the automation library, and only the service layer reaches the database. If a surface cannot reach the database except through a service, it cannot bypass a rule — not because it was reviewed carefully, but because it will not build |
| `config.no_secrets` | No variable this service reads is credential-shaped. Configuration is readable by anything that can read the process environment, so a value that would be unsafe to read aloud is in the wrong place (§6.1) |
| `capture.never_refused_for_cost` | **No path refuses a capture for budget or resolution reasons.** This one asserts an absence, and it is what makes the "never a refusal" promise checkable |
| `nothing.listens` | **No code path opens a listening socket.** Nothing is served (§4), and the way that stays true a year from now is a rule rather than a habit — a page somebody adds "just to look at it locally" is precisely how a served surface arrives |

### 7.4 There is no rule that is only a warning

**An earlier design had one**, covering a served surface bound beyond the local machine: it warned
loudly and served anyway. **Nothing is served** (§4), so the situation it warned about cannot arise
and the rule is gone rather than reworded.

**Its absence is recorded rather than left silent**, because a rule leaving a list of rules is exactly
the kind of change that should be visible. What replaced it is not a stricter rule but a deleted
capability: there is no bind address, so there is nothing to warn about, and `nothing.listens` (§7.3)
is what keeps that true.
---

## 8. The same rules through every door

Every route in — the tool surface over either transport, and the command line — is a thin shell over
one service call. **That is a claim, and there is a suite that makes it true rather than intended**,
because the failure it guards against is silent: a rule implemented inside one route is enforced for
that route's callers and for nobody else, and nothing reports it.

**There are two routes rather than three, because nothing is served** (§4). That makes the parity
claim narrower and it does not weaken it: the assertion was never about the count of routes, it was
about a rule holding on all of them, and two is still more than one. **The generated operations
document is not a route** — it performs no operation and refuses nothing, so it has nothing to be at
parity with. What it does owe is the reader rule (§2.4), asserted where it is generated rather than
here.

What the suite asserts:

1. **The same outcome** — the same acceptance, or the same refusal code and the same rule name, from
   every route. Wording is deliberately not compared.
2. **The same physical effect**, which is the assertion this application needs and a parity suite
   usually does not. A browser lease has a physical side, and **a refusal that arrives after the tab
   already opened is not a refusal** — it reports something that did not happen and everything
   downstream believes it. So a refusal is asserted to have opened nothing *and* to have left the tab
   count unchanged. Both, because they catch different bugs.
3. **Every operation has a case that succeeds and a case that is refused.**
4. **Every rule in §7 appears in at least one refusal the service actually produced** — computed from
   what the service returned, never from what a test declared. A new rule therefore fails the build
   until it has a case. **This is the assertion that keeps the suite honest a year from now.**
5. **Every route is registered**, and anything it deliberately does not offer carries a written
   waiver with a reason.
6. **Contention is exercised across real operating-system processes, not across connections in one
   process.** This is the assertion that is specific to this design and the easiest one to fake
   without noticing. **A suite that spawns several clients inside one process proves nothing about
   the property that matters** (§1.0a) — that process can serialise them by accident, and the result
   is a green suite over a model that does not exist in use. The measurement this design rests on was
   run at 30 concurrent processes, and the test that keeps it true has to be too.

**And the control that proves assertion six can fail** is worth naming, because it is the one whose
absence would be invisible: **the deferred-transaction variant must be kept as a deliberately-failing
case.** It fails 15 times in 25 under contention and **passes at low contention**, so a suite that
only ever ran the correct version would never demonstrate that the test can distinguish them. Keeping
the broken one, and asserting it breaks, is what makes the passing result mean something.

How the suite is built, and the deliberately-failing controls that prove each assertion can fail, are
in `MILESTONES.md`.

---

## 9. What is settled, what is not, and what was measured

### 9.1 The nine are closed — and one thing still needs you

**Every one of the nine questions this document put to you is answered or dissolved.** The index at
the top carries the rulings; each is written out where its subject is discussed. **There are no ❓
blocks left**, and that is a checkable claim rather than a stylistic one.

**Six of the nine were dissolved rather than answered**, which is the outcome worth noticing. In each
case the thing being asked about stopped existing: no canonical picture, so no question of who blesses
the first one or whether file names carry a lineage; no stored page address, so no question of how
much of one to keep; nothing served, so no question of who may reach it; no settings table, so no
question of whether it earns its machinery. **A dissolved question leaves nothing to keep honouring.**

**One item still needs you and it is not a design question: the licence.** It is not a build's to
choose, and it has to be settled before anything is published — a public repository with no licence
file grants its readers no rights at all, which is almost never what publishing was for.

### 9.1a Unresolved, and named so none of it is discovered

**Everything here is genuinely open. Each entry says what would settle it**, because an open question
with no route to closure is just a worry.

- **Whether the tools added in response to the sampled "execute arbitrary code" arguments are the
  right ones** (§3.10). The sampling is done and the finding is written out there: **101 of 328 calls,
  across 33 of 53 sessions, exercised a shared-pool hazard**, and the rest divide into page
  expressions and four specific gaps that are addressed — viewport, media preferences, storage
  seeding, and simply claiming the signed-in browser. **What is open is narrower than the question
  that closed:** whether those four cover the non-hazardous remainder in practice. **What would settle
  it:** the feedback table (§3.16), filtered to `no-path`, which is the mechanism that exists so this
  does not require sampling a corpus by hand a second time.
- **What a caller that lost the launch race is waiting for** (§1.2b). Winning the race and having a
  browser that accepts connections are different moments, and the gap has no specified signal and no
  bound. **What would settle it:** a readiness signal the loser can poll, and a bound on how long it
  polls before declaring the winner failed. A fixed pause is not an answer — it is too long on every
  fast machine and too short on the one slow machine where it matters.
- **Whether two callers accidentally sharing one session identity ever actually happens** (§2.2). The
  refusal that would have caught it as a side effect does not exist, and the consolation that somebody
  would notice it on a page rested on a page being up. **What would settle it:** whether the condition
  occurs at all. If it does, the instrument is a warning on the response when a session's live lease
  count crosses a threshold — never a refusal, which would break the legitimate case to catch the
  accidental one.
- **How common concurrent multi-tab work is** (§2.3a). The starvation case is named rather than
  engineered around, and that ruling is a bet on the frequency being low. **What would settle it:** a
  query over the lease rows — overlapping live leases grouped by session identity — which is data the
  service already keeps.
- **Whether masking known-volatile areas is needed.** A carousel, a video, an advertisement slot or a
  live timestamp legitimately differs on every load and produces a large, correctly-detected change
  every time. The size filter removes *small* regions; nothing removes *known-volatile* ones. **The
  capture-time mask (§3.11) is the half that does ship, and it is the better half**: an area that was
  never captured cannot be reported. **What would settle the rest:** whether real use produces
  volatile regions the capture-time mask cannot reach.
- **Whether an off-the-shelf tool already does the diffing half of this.** A research question no
  document here answers, and worth answering before that work starts, because it is the one part of
  this design that is not arbitration.

**And two columns are re-justified on thinner ground than the rest, which is said rather than
smoothed over.** `claims.purpose` is **mandatory on the most-called operation in the service**, and
what now justifies it is one comparatively rare operation — revoking (§1.3). That is a real trade
rather than a comfortable one. `claims.session_id` rests on the resolution study reading it (§1.3),
which is a study that has not run. Both survive; neither survives as strongly as it did when a page
somebody was watching was assumed to exist.

### 9.2 Where this document changes an earlier decision

Each is a change rather than a clarification, and is listed so nobody reconciles them by accident.

| | |
|---|---|
| **There is no baseline, and the whole concept is deleted** | The largest change in this revision. No canonical picture, no `baselines` table, no promotion or retirement, no per-baseline tuning, no baseline administration, and no `browser_compare` tool. **A diff is an optional argument on `browser_capture` naming which prior capture to compare against** (§1.8, §3.11) |
| **The count of verified partial indexes is two, not three** | **A change in a count, stated rather than corrected silently.** The measurement of three on SQLite 3.53.4 was true and covered one index more than the design contains; deleting baselines removed the live-baselines unique index. What remains: the live-tab unique index, and the live-claims covering index. **This weakens the case for plain SQL over an object-relational mapper without breaking it** — startup latency charged on every spawn, install weight and the version stepper all stand (§1.11) |
| **The settings table is deleted; configuration is the environment** | **This reverses a recommendation this document itself made.** With nothing served and no configuration command, the table had no writer. Every value has a working default and a fresh install runs with nothing set (§1.10, §6) |
| **The tab budget is checked against the store, and disagreement refuses to start** | The one correctness property the settings table was really buying, kept at the cost of one row and no tools. Several processes arbitrate against this bound at once, so two of them believing different numbers means the ceiling silently stops being one. **The lease lifetime deliberately gets no such check** — it degrades rather than breaking an invariant (§1.10) |
| **Nothing is served; the operations view is a generated file** | One self-contained document a command writes and a person opens. **It is a snapshot and is labelled with the moment it was taken** (§4). The health endpoint is deleted with it — `broker doctor` answers the same question in a better shape (§4.4) |
| **Addresses are read live from the browsers at generation time, with a timeout** | The generating process is attached to both browsers, so it asks rather than reading a cached copy. A browser that does not answer renders as unreachable rather than hanging the run (§4.2a) |
| **`tabs.last_url` is deleted** | A cached copy of something the browser already knows, read only when the source was reachable anyway. **Deleting it removes the most sensitive column in the design**, leaves nothing to retain or redact, makes the private browser trivially leak-free, and makes a clear-history command unnecessary. **`captures.url` is a different column and survives** (§1.4) |
| **The tool surface is ten, plus a command-line snapshot** | `browser_compare` folded into capture as an argument; `browser_tab_close` deleted outright, because it produced a lease owning nothing while still consuming budget; **`browser_feedback` added as the tenth** (§3.1, §3.16) |
| **The "execute arbitrary code" arguments were sampled, and the refusal is now evidence-backed** | **Measured: 101 of 328 calls, across 33 of 53 sessions, exercised a real shared-pool hazard** — including **16 calls in one session that enumerated other callers' tabs and drove one it did not own**, **2 that read a local environment file and extracted administrative credentials in cleartext**, and **49 that made outbound authenticated network requests from the server process.** The §3.10 box that flagged this as counts-only is replaced by the finding. **Outbound network calls and cross-tab reach stay unreachable** — an agent that needs authenticated network calls does not need a browser (§3.10, §3.13) |
| **Browser choice is guidance now, and it is a correction** | **Nothing here ever assigned a kind of caller to a browser** — the two are a choice at claim time. **Measured: 25 sessions hand-seeded auth tokens into an isolated browser while the signed-in one sat unused.** Authenticated surface → the signed-in browser; genuinely-fresh-visitor work → the private one. **With the caveat stated alongside: tabs in the signed-in browser share one cookie jar**, so two callers there are clean-room relative to nothing, and two identities at once stays unsupported (§1.2, §3.2) |
| **`storage_seed` is added to `browser_claim`** | **Measured: 40 calls across 25 sessions**, all the same shape — fetch a token, seed it before load, navigate. **Applied by the service through a storage interface, never caller code executed as code**, bounded at 16 entries and 4 KB each, and refusing cookies. **The browser guidance shrinks this without deleting it:** the signed-in browser covers anything a person can log into by hand, and does not cover a token obtained from an API (§3.2) |
| **`emulate` is added as an action — colour scheme, reduced motion, forced colours** | **Measured: 19 calls across 9 sessions**, and **no page-side path exists**: media preferences are context-scoped exactly as viewport is, so evaluation cannot reach them and a page's own theme switch tests the page's state rather than the browser's. First-class concerns for a visual-review product. Tab-scoped and non-destructive, so it adds no tool (§3.8) |
| **Console listeners are confirmed covered rather than added** | Console and network are accumulated from the moment the context opens, so *act then read* serves what *arm, act, collect* would have — and returns history from before the caller thought to ask. Written down at §3.9 so the gap is not re-derived |
| **`browser_tab_replace` survives for one named reason: a crashed tab** | Navigate cannot fix a page that has stopped responding, because navigating is itself a request that page will not answer. Said explicitly, or a reader reaches for it when navigate would do (§3.5) |
| **`resize` is added as an action** | **Measured: 578 calls across 140 sessions — 58% of every session that used browser automation, and the sixth most-used verb.** It is **not workaroundable**: viewport is context-scoped, so evaluation cannot reach it. Without it the measured dominant loop — resize, navigate, evaluate, capture, per breakpoint — cannot be written, which makes responsive review inexpressible. Tab-scoped and non-destructive, so it adds no tool (§3.8) |
| **Dialog handling is added on consequence, not frequency** | Measured at only 8 calls. **An unhandled dialog blocks its tab and burns the lease**, so it is a lease-integrity issue rather than a convenience (§3.8) |
| **Drag, drop and back-navigation are measured and skipped** | **Zero calls each, over a month, across 2,007 transcripts.** Recorded with the number so the absence can be argued with (§3.8) |
| **The destructive-operations argument is reconciled, and stated more precisely** | The line is **destructive versus not**, never collapsed versus separate. Comparison is non-destructive and nothing would want to match on it, so folding it under a parameter hides nothing. The destructive operation was **deleted rather than folded** (§3.1) |
| **`browser_read` filters, and the filter is free** | The page snapshot by default; console, network and cookies on request. Console and network are **accumulated continuously by the browsing context**, so this is a write-time filter rather than a fetch-time one and the cost of not asking is zero. **Cookies are the exception — a live query** (§3.9) |
| **The lease key stays explicit on every call** | Implicit session-derived identity was considered and rejected. **Delegation decides it:** an orchestrator may want to hand one specific subagent the key, and implicit identity makes that either impossible or automatic for every subagent. The key is also the ownership check, and the protocol forbids using a session for authentication (§3.1) |
| **The two lifetimes are equal — ten minutes each** | **This reverses this document's own "must not be equal" rule**, which rested on a wrong argument: that a queued caller has nothing to renew with. **Polling is renewing.** And the cost runs the other way — under strict order, a queue place held longer blocks everyone behind it, so longer is worse rather than kinder (§2.5) |
| **`browser_release` also releases a queue place** | A queued caller that changes its mind otherwise has no way out and occupies its place until it lapses. One verb, both states: whatever you hold, you give back (§2.5, §3.4) |
| **The queued response carries a scheduling nudge, not just a position** | It tells the caller to set up a recurring check at just under the lifetime — around nine minutes — because callers assume they will wake themselves up and then do not (§2.5) |
| **Capture `reason` is free text, and the default is the lower tier** | Free text because the study needs to learn why callers escalate; **an enum can only report which of the author's guesses they picked, and free text can be classified later while discarded nuance cannot be recovered.** The response tells a default-tier caller which fields escalate and that the top tier owes a written reason (§3.11) |
| **Capture does not depend on diffing** | The rule that a capture was taken at a canonical picture's geometry is deleted. **Diffing is the last thing built and nothing earlier may depend on it** (§3.11); geometry is handled at diff time (§1.9) |
| **One image endpoint, one return shape** | The rejected inline-crop option is gone. **You cannot know a diff is small** — a change to a shared component changes every page — so a rule bounded only when the change happens to be local is unbounded. It serves recorded paths under the artifact root, belonging to the asking lease, **never an arbitrary request path** (§1.9) |
| **A missing diff target returns the picture and an explanation** | Never a refusal. The caller asked for a picture and gets a picture, plus a sentence saying the image it named was not found (§1.9) |
| **Capture-file and crop retention are deleted** | Nothing sweeps an image. A retention window would have made an identifier silently invalid for a reason nothing in the response mentions (§6.2) |
| **The disconnect grace period is deleted** | Inert by its own description — a value whose only behaviour was an explanation of why it did nothing (§6.2) |
| **File names derive their page slug from the page address** | Host and path, **query strings stripped**, safe characters, truncated, never interpreted as a path. **A file name leaks further than a database column does** — into logs, terminal screenshots and error messages (§1.7a) |
| **A grant is one tab, and the per-claim tab allowance is deleted** | Capacity, grants and tabs are one integer; admission is one comparison; there is no reservation arithmetic. Need two tabs, claim twice (§2.3) |
| **The store is one SQLite file reached with plain SQL** | No database server, no object-relational mapper, and the schema written in the language the database speaks (§1.0, §1.11) |
| **There is no long-running process** | Spawned per session, exits with it. Nothing listens and nothing sweeps on a timer (§1.0a) |
| **Reclamation is lazy and global** | Every arbitration call expires every lapsed lease and queue entry across the whole store, in the same transaction, before answering (§2.4) |
| **The concurrency model is between operating-system processes** | Not connections in one process. Every rule lives in the database, and the transaction mode is a measured requirement rather than a preference (§1.0a) |
| **Browsers are adopted, not owned** | Launched detached by whoever finds none running, attached to by everyone after, outliving every process. The launch race is arbitrated by the same transaction as claims (§1.2a) |
| **The signed-in browser is headed, and a keeper tab holds it open** | Measured: headed, closing the last tab kills the browser within about half a second, which would destroy the shared authenticated session on the ordinary release path (§3.15) |
| **"One live lease per tab" is not a uniqueness rule at all** | Structural: a tab's lease is set once, never null, never changed, so it has exactly one owner by construction (§1.11) |
| **"One live lease per session" is gone entirely** | Removed, not enforced differently. What it caught as a side effect is named as lost, and the mitigation that was offered has evaporated with the served page (§2.2) |
| **Evaluation is allowed on both browsers, with no allowlist and no result filtering** | The exposure is handled at the artifact-write layer, which also covers a snapshot capturing a rendered credential nobody chose to evaluate (§3.10) |
| **There is no renew operation** | Every call carrying the key extends the lease (§3.1) |
| **The capture warning fires on every capture past the threshold, not once** | A warning that appears once has scrolled away by the time it matters (§3.11) |
| **A diffs table exists** | Justified by threshold tuning being unanswerable without one, and by the ledger being the one prunable thing (§1.9) |
| **The artifact root and the profile root are environment variables** | Along with everything else now (§6.1) |
| **Files are organised by lease first and kind second** | One folder per lease, subfolders by kind, **and nothing outside it** — there is no category of image that outlives a lease (§1.7a) |
| **Every capture settles the page before the shutter** | Animations, caret and fonts. No colour tolerance can address something that moved (§3.11) |
| **The size filter is on area with a thin-line allowance** | A one-pixel line across a wide page has a shorter side of one, and filtering on it discards exactly the small-but-real changes the feature has to prove it does not swallow (§6.2) |
| **Section numbers §3.6 and §3.12 are left vacant** | The tools they described are deleted. Renumbering would silently repoint every citation written against the sections below them |

### 9.3 Numbers that are provisional, and what settles each

| Number | Settled by |
|---|---|
| The three resolution rungs | The resolution study. Expect **more than one threshold**: text stops being legible before layout critique stops working, so the useful ceiling is the lowest rung that still passes the checks that matter. **Changing a rung invalidates nothing**, because nothing is stored at a rung and compared against later (§6.2) |
| The tab budget | Watching real memory at real concurrency. The reasoning is 50–150 MB per idle page process plus two browser processes; the measurement turns that into a number. **It is also the maximum count of live leases**, so the lease rows measure it directly |
| The two lifetimes, now equal at ten minutes | **Settled as a decision, and still provisional as a number.** Whether ten is right is answered by the renewal counts and by how often queue places lapse; whether they should be equal is argued in §2.5 and is not a number question |
| The launch-readiness timeout | §1.2b, and it cannot be settled before the thing it waits *for* is decided |
| Captures per lease before a warning | The capture rows |
| The colour tolerance, and the smallest change reported | A fixture set whose negative direction is the one that matters: a change small enough to be interesting must survive the filters in force. Thin lines, border widths, focus rings and underlines are the cases to build it from |
| How often callers actually call in | The renewal count, which is what says whether the lifetime is wrong |

### 9.4 One thing to verify before the browser layer is trusted

**The concurrency properties this design rests on were proved against the automation *library*** —
that background tabs accept every operation, that capturing never moves the foreground, that fifteen
concurrent tabs neither serialise nor contaminate each other. **The service reaches those properties
through a command-line tool layered over that library**, and a layer can add a foreground move or
change a launch setting without saying so.

Two of the spawn-time rules (§7.2) check that the settings survived the indirection, and one build
check (§7.3) checks that this service does not add a foreground move. **Neither covers the case where
the tool itself moves the foreground on some operation nobody has exercised yet**, so one empirical
check is owed on the real thing: drive a background tab through a navigation, an action and a capture,
and assert the foreground has not moved. That is a test, not a code read, and it is the last place a
proved property can quietly stop being true.

**What has been measured, and therefore does not belong on that list**, is recorded where each one
matters rather than gathered here:

| Measurement | Where |
|---|---|
| Writer serialisation across 30 concurrent processes, and the deferred-transaction failure at 15 in 25 | §1.0a |
| Two partial indexes on SQLite 3.53.4, out of the three that were built and exercised | §1.11 |
| Detached launch surviving an unclean kill of its spawning process for around 90 minutes with pages intact; attach non-destructive to tabs, cookies and storage | §1.2a |
| The discovery record surviving a hard kill while its endpoint was dead | §1.2c |
| A headed browser dying within about half a second when its last tab closes | §3.15 |
| `resize` at 578 calls across 140 sessions — 58% of sessions using browser automation, sixth most-used verb | §3.8 |
| Dialog handling at 8 calls | §3.8 |
| Drag, drop and back-navigation at zero calls each, over a month, across 2,007 transcripts | §3.8 |
| `emulate` at 19 calls across 9 sessions, with no page-side path to media preferences | §3.8 |
| An "execute arbitrary code" verb at 328 calls across 53 sessions — **and its arguments sampled**: 101 calls across 33 sessions exercised a shared-pool hazard, 16 of them in one session enumerating and driving other callers' tabs, 2 extracting administrative credentials from a local environment file, 49 making outbound authenticated requests from the server process | §3.10 |
| The login-bootstrap shape at 40 calls across 25 sessions — fetch a token, seed storage, navigate | §3.2 |
| 25 sessions seeding auth into an isolated browser while the signed-in browser went unused | §1.2 |

**Each of those is written down as a measurement rather than as a fact**, and that distinction is the
one to hold onto when reading this document: everything here that was measured says so, and everything
that was not is either reasoned from something or named as open.

**The arbitrary-code row is worth reading as a lesson about the other rows.** For a while it was a
call count and nothing else, and it was labelled that way deliberately — a count says how often
something was reached, never what it did, and the temptation to read a plausible story into a large
number is exactly the error this document is written to avoid. **Sampling the arguments turned one
number into a finding**, and the finding was not what either available guess had proposed: not purely
page expressions, not uniformly dangerous, but a third of it reaching past the caller's own lease in
ways a page could not. **Every other row here is still a count**, and the same discipline applies to
each of them.
