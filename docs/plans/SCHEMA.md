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

**Status: draft for review. Nothing is built.** Types are Postgres. Where a number appears, somebody
reasoned to it and the reasoning is beside it, so it can be argued with rather than inherited.

Sections are numbered so a comment can cite `§3.4` rather than "the bit about the queue".

---

## What needs your decision

Eleven questions cannot be answered from inside the design. Each one appears as a **❓ NEEDS YOUR
INPUT** block where its subject is discussed, with the problem, the options and their real
trade-offs, a recommendation, and what changes if you pick differently. Everything outside those
blocks is a statement you can agree or disagree with, not a question waiting on you.

| | Question | Where |
|---|---|---|
| 1 | Do capture files carry a version in their name, so lineage is readable from the name? | §1.7a |
| 2 | **Who creates the first baseline — must a person stand between visit one and visit two?** | §1.8 |
| 3 | How do the comparison's crop images reach a caller that is not on this machine? | §1.9 |
| 4 | Is a database-backed settings table worth it when there is no front end? | §1.10 |
| 5 | How is "one live lease per session" made impossible to violate — a filtered rule the schema tooling cannot express, or splitting live rows into their own small tables? | §1.11 |
| 6 | How much of a page address is stored? | §1.4 |
| 7 | Strict first-in-first-out, or skip-ahead with an aging rule? | §2.5 |
| 8 | Is evaluating inside a page acceptable on the signed-in browser? | §3.10 |
| 9 | On the top capture tier, is `reason` free text or a fixed set? | §3.11 |
| 10 | Does the operations surface stay unauthenticated when it is reachable off the local machine? | §4.1 |
| 11 | The licence. | §9.1 |

**Question 2 is the one to read first.** Your own worked example — capture the home page, then next
time ask for the capture *and* the difference — does not work as this document specifies it, and the
reason is a deliberate decision somebody has to confirm or overturn.

---

## 1. Tables

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
finished claim, a closed tab and a retired baseline are all kept, because they are the record. The
`events` ledger (§1.6) has a retention setting and may be trimmed. That asymmetry is what justifies
most of the timestamps stored on rows: they have to outlive the ledger that could otherwise compute
them.

Two conventions that are true everywhere and are not repeated per table:

- **Time is `timestamptz`, and the clock is the database's.** Every expiry is measured against the
  database's own clock, never a process clock. More than one process can be running, and two clocks a
  second apart make an expiry non-deterministic in a way nothing will ever reproduce.
- **`created_at` and `updated_at` are on every table.** `updated_at` moves on every change, in the
  same transaction as the `events` row that change produced, so the two cannot disagree.

**Identifiers are opaque `uuid`s**, except `browsers.id`, which is one of two words because callers
type it, and `events.id`, which counts upward because it doubles as a "everything since here" cursor.

### 1.2 `browsers` — a fixed two-row table

Exactly two rows, always: the **regular** browser (persistent, signed in) and the **private** one
(ephemeral, signed in to nothing). Not a collection, no third row, no named-profile concept
(`DECISIONS.md` §6). A table rather than a constant because it makes a future relaxation a check to
loosen rather than a design to redo.

| Column | Type | What it's for |
|---|---|---|
| `id` | `text`, primary key | `regular` or `private`, and nothing else — the database refuses any other value. Callers type this word, so an opaque key would mean a lookup for something the caller already knows. |
| `state` | enum | `stopped` · `starting` · `running` · `signing-in` · `failed`. `signing-in` is the one mode where a person is driving a window (§5.5.1); it is a state rather than a flag because claims are refused during it and a refusal wants a reason it can name. |
| `pid` | `int`, null when stopped | The process this service launched. **This is the isolation fact**: the service acts on processes recorded here and on nothing else, so a browser somebody else is running is never inspected and never touched. |
| `launched_at` | `timestamptz`, null when stopped | When the running process started. With `pid` and `state` this is one fact about *now* — how long the thing that is up has been up. |
| `restart_count` | `int` | Restarts since the service started. **Kept although the ledger could count it** (rule one): a crash loop is invisible in `state`, which reads `running` between crashes, so this is the number that has to be on the operations page beside `state` — and the ledger it would be counted from is prunable. |

**What is deliberately not here**, because each was derivable:

- **No `persistent` flag.** Whether a browser uses a persistent profile is a property of *which*
  browser it is, and there are exactly two. A column would let the row disagree with the word in it.
- **No `profile_dir`.** A browser's profile directory is the configured profile root plus its own
  `id`, so storing it stores an absolute path that the database already knows how to compute — and
  §1.7a's rule is that no absolute path is ever stored anywhere.
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

### 1.2a Setup — how the browsers and their profiles come to exist

The rows above describe browsers. Something has to **make** them, and that is an explicit step rather
than an assumption.

`broker init` runs it, and `broker serve` runs it before serving, so it happens whether or not
anybody remembers to type it. It is **idempotent by design**: it creates what is absent and leaves
alone what is present.

| Step | First run | Every run after |
|---|---|---|
| Database | Applies the schema | Confirms the schema is at the version this build expects |
| The two browser rows | Created by the first migration | Present; nothing to do |
| Profile directory, per browser | Created under the configured profile root | **Found and used as it is.** Never recreated, never cleared |
| One proving launch, per browser | Launches, runs the startup checks, shuts down | Same checks, against the profile that is already there |
| Report | Says which profiles it created | Says which profiles it found |

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
| `id` | `uuid`, primary key | The public name of a lease. Safe to log, to print and to show on the operations page. |
| `key_hash` | `text` | **The secret key is never stored** — this is a one-way hash of it. Every call that carries a key hashes what it was handed and looks the lease up by this value. |
| `session_id` | `text` | The caller's identity, supplied by the caller. The unit the one-live-claim rule is over, and what attributes a capture to whoever took it. **Not a foreign key, and there is no table of sessions** — session identity is a shared key this service does not own, so a constraint here would mean inventing a registry for something another system mints. |
| `browser_id` | `text` → `browsers.id` | Which browser this lease's tabs live in. Chosen when the lease is granted and **immutable**, because a tab cannot move between browser processes. |
| `state` | enum | `queued` · `active` · `released` · `expired` · `revoked`. Five values, three of them final. §2.1. |
| `tabs_granted` | `smallint` | How many tabs this lease is entitled to. **Not derivable from the tab rows**, and that is the point: a queued lease has no tab rows yet and its size is exactly what the queue must know, and an active lease that closes a tab keeps its entitlement so it can open a replacement. |
| `purpose` | `text`, 3–200 characters | One line, **mandatory**. It is the only human-readable answer the operations page can give to *"what is holding four tabs"*, and an optional field is empty on precisely the rows somebody is staring at. |
| `expires_at` | `timestamptz` | When this lease lapses if nobody calls. **One column for both live states**: queued and active leases expire by the same mechanism and only the duration differs, so there is one column and one sweep rather than two of each. |
| `ttl_seconds` | `int` | The duration in force for this lease, fixed when it entered its current state. Stored rather than read from settings on each renewal, because a renewal has to extend by the duration the caller was **told** — re-reading a setting mid-lease silently changes a promise the caller has already acted on. |
| `activated_at` | `timestamptz`, null while queued | When the lease got its tabs. Null forever on one that expired while waiting. With `created_at` this is what separates *"held for eleven minutes"* from *"waited eleven minutes"*, which mean opposite things on an operations page. |
| `renew_count` | `int` | How many calls have extended this lease. What distinguishes a caller doing work from a caller polling to hold capacity it is not using. **Kept although the ledger could count it** (rule one): the claim row is permanent and the ledger is prunable, so the count has to live where it will survive. **Nothing acts on it in the first version** — it is the data that would justify acting, and saying so is more honest than implying a policy that does not exist. |
| `ended_at` | `timestamptz`, null while live | Set when the lease reaches any final state. One column rather than three, because `state` already says which. Same reason as `renew_count` for storing it: the row outlives the ledger. |
| `revoke_reason` | `text`, required only when revoked | An operator taking capacity off a caller owes a sentence, and the caller's next call is refused with it. |

**What is deliberately not here:**

- **No `renewed_at`.** The last renewal is `expires_at` minus `ttl_seconds` — two columns already on
  the row. A third column agreeing with them is a third column that can stop agreeing with them.
- **No `queue_position`.** Position is a count of the queued leases that arrived earlier, computed
  when somebody asks. Storing it means rewriting every waiting row each time one is admitted.
- **No `captures_taken`.** A count over the captures of that lease, which is tens of rows.

### 1.4 `tabs` — the unit of capacity and the unit of ownership

| Column | Type | What it's for |
|---|---|---|
| `id` | `uuid`, primary key | **The tab identifier handed to callers.** Opaque, so holding one tells you nothing about any other. There is no index arithmetic to get wrong, which deletes the whole class of bug where an operation lands on a tab the caller did not mean. It is not a secret and it is not the security boundary — ownership is checked against the lease key on every call. |
| `claim_id` | `uuid` → `claims.id` | **The ownership fact.** Every tab-addressed check is a comparison against this. Immutable: a tab is created for one lease and closed with it, so no operation can hand a tab to a second owner (§1.11). |
| `browser_id` | `text` → `browsers.id` | Which browser holds this tab. **This is a copy of the lease's browser, and it is kept for one specific reason:** the rule *"two live rows must never name the same physical tab"* is a uniqueness rule over the pair (browser, driver's tab name), and a uniqueness rule can only be written over columns on one row. It cannot drift — the database refuses a tab whose browser disagrees with its lease's. |
| `driver_tab_id` | `text`, null until the tab opens | Whatever the automation tool calls this tab. **Never returned to a caller on any surface** — it is the tool's namespace, and exposing it hands callers a second, non-opaque way to name a tab, which is the addressing bug arriving through a different door. |
| `state` | enum | `opening` · `open` · `closing` · `closed` · `failed`. `closing` is not ceremony: it is the honest representation of *"the tool was asked and has not answered"*, and it is what stops a page that may still exist being counted as free. |
| `opened_at` · `closed_at` | `timestamptz`, null until each happens | When the tab actually opened, and when a close was actually confirmed — not when one was asked for. Stored because the row is permanent and the ledger that could derive them is prunable. |
| `last_url` | `text`, null | Where this tab is, at whatever detail the privacy setting allows: the full address, the site only, or nothing. **This is the most sensitive column in the schema** — a browsing history is what it is — so how much of it is kept is a setting rather than a decision taken on the operator's behalf. |
| `close_attempts` | `int` | How many closes have been asked for and not confirmed. What makes a stuck tab visible rather than merely counted, and what the sweep escalates on. |

> **❓ NEEDS YOUR INPUT — How much of a page address is stored (§1.4 `last_url`)**
>
> **The problem:** the operations page needs to answer *"what is this lease doing"*. The most useful
> answer is the address of the page each tab is on. But a table of addresses, kept over months, is a
> browsing history — the single most sensitive thing this design could hold, and it would sit in a
> database with an unauthenticated read surface on the same machine.
>
> **Options:**
> - **Store the full address.** Best operations page, best record when something goes wrong, and a
>   real browsing history in a database nobody thinks of as holding one.
> - **Store the site only** — the part before the first slash. You can see *where* a lease is
>   working, not *what* it is looking at. Enough to spot a lease on the wrong site; not enough to
>   reconstruct a session.
> - **Store nothing.** *"What is this lease doing"* is answerable only from the purpose the caller
>   typed, which is a sentence written before the work started and may say very little.
>
> **Recommendation: the site only.** It answers the operations question and refuses the surveillance
> one, and it is the choice that stays defensible when this runs on a machine that is also somebody's
> own.
>
> **What changes if you pick differently:** one setting's default, and nothing structural — the
> column and every surface are identical in all three cases. It can also be changed after the fact,
> though changing it does not rewrite what is already stored.

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

**The queue, in plain language.** The budget is fifteen tabs across both browsers.

1. Twelve tabs are in use. You ask for two. Fourteen is within fifteen, so you are **granted**
   immediately: your lease becomes active, two tab rows are created for you, and you get their
   identifiers and a key.
2. Somebody else asks for four. Fourteen plus four is over the budget, so they are **queued**. They
   get a lease and a key but no tabs, and their response tells them their position, a rough wait, and
   — because a bare "wait" is not useful — **how many tabs they could have right now** if they asked
   for fewer (§2.3).
3. A third caller asks for one. There is one tab free, but they go **behind** the four-tab caller,
   who arrived first and is still waiting. That is the deliberate cost of strict order (§2.5).
4. You release. Two tabs come back, so twelve are in use and three are free. The front of the queue
   wants four. Four does not fit in three, so **nobody is promoted** — including the one-tab caller
   behind, who could have fitted.
5. Somebody else releases three. Nine in use, six free. The four-tab caller is promoted: their lease
   flips to active and their tab rows are created. Ten in use, five free. The next in line is the
   one-tab caller, who fits, so they are promoted too. The queue keeps promoting from the front until
   the front does not fit.
6. Anyone who stops calling in loses their place and their lease expires. Their capacity was never
   held, so nothing has to be given back.

**The wait estimate is a weak number and is labelled as one** everywhere it appears: the number
waiting ahead of you multiplied by how long recent leases were actually held. It is deliberately not
computed from the expiry, because a lease that keeps being renewed runs far past its expiry — an
estimate built on that would be confidently wrong in the common case rather than vaguely wrong in all
of them.

### 1.6 `events` — one row per decision, kept in order

**Every decision, allowed and refused alike.** A record containing only refusals cannot answer *"was
this rule ever actually reached"*, which is the first question anybody asks the day something behaves
oddly.

| Column | Type | What it's for |
|---|---|---|
| `id` | counter, primary key | Also the "everything since here" cursor for anything reading a slice of the ledger. |
| `at` | `timestamptz` | When. |
| `kind` | enum | Which operation was attempted — the list is below. |
| `outcome` | enum | `allow` or `deny`. Separate from `kind` so *"how often is this refused"* is one question rather than a set of parallel event names that have to be kept in step. |
| `guard` | `text`, null on an allow | Which rule refused, named from §7's list. |
| `claim_id` | `uuid` → `claims.id`, null | Null on service-level rows, and on a request refused before any lease existed. |
| `tab_id` | `uuid` → `tabs.id`, null | Which tab, where the operation had one. |
| `session_id` | `text`, null | A copy of the lease's session identity, and **this is the one denormalisation in the schema that earns its place outright**: a refused request never becomes a lease, so without this column every refusal on the busiest rule in the service is anonymous. |
| `adapter` | enum | Which door the call came in through: the tool surface over either transport, the web interface, the command line, or the service's own internal work. This is the column that turns *"the same rules apply on every route"* from a claim into a query. |
| `detail` | `jsonb` | The rest, shaped per kind. One queryable stream: a column per kind would be a wide, mostly-empty table, and a table per kind would turn every read of the ledger into a fifteen-way union. |

**The kinds:** a lease being requested, granted, queued, promoted, renewed, released, expired or
revoked · a tab opening, failing to open, or closing · a navigation, an action, a read, an
evaluation, a capture, a comparison · a baseline promoted or retired · a browser launched or exited ·
a sweep · a setting changed.

A fixed list rather than free text, because a typo in free text creates a phantom category that every
count then silently misses. The list is added to only when the code that writes a new kind exists.

**What an allowed row does not record: which rules passed.** Only that the operation ran. Recording
every passing rule would multiply the ledger by the number of rules to answer a question nobody asks;
the question that *is* asked — "has this rule ever fired" — is answered by the refusals.

**Events are meant to be looked at, not merely written.** The ledger is one stream with a cursor, so
a page over it is a page over one query. `GET /events` and `broker events` read slices of it from the
first version; a view on the operations page is scheduled work (`MILESTONES.md` #47) and the shape
above is what keeps it cheap to add.

### 1.7 `captures` — what a picture cost

| Column | Type | What it's for |
|---|---|---|
| `id` | `uuid`, primary key | |
| `claim_id` | `uuid` → `claims.id` | Who took it. Survives the lease ending, which is the point. |
| `tab_id` | `uuid` → `tabs.id` | Which tab it came from. |
| `taken_at` | `timestamptz` | When. |
| `kind` | enum | `viewport` · `element` · `full_page`. Also the answer to *"how often does anyone actually want a whole page"*, which decides whether the default is right. |
| `tier` | enum | `default` · `detail` · `max` — which resolution rung was asked for. Stored rather than inferred from the dimensions, because the rungs are settings and can move. |
| `reason` | `text`, required only on the top tier | Why somebody escalated. **This column is the entire mechanism by which anyone learns why callers escalate**, which is what the resolution study needs. |
| `source_width` · `source_height` | `int` | What the browser produced, before any shrinking. |
| `width` · `height` | `int` | What was written to disk. Equal to the pair above when nothing was shrunk, which is how "was this downscaled" is answered without a flag that could disagree with the numbers beside it. |
| `bytes` | `int` | File size. Stored because capture files are deleted on a retention schedule and the row is permanent. |
| `path` | `text` | Where the file is, **relative to the artifact root, never absolute** (§1.7a). |
| `view_key` | `text`, null | The caller's name for this view, when it gave one. Null makes a capture ineligible for comparison, which is correct: a picture nobody named cannot be matched to a baseline. §1.8 says what a view name has to carry. |
| `selector` | `text`, null | Which element, on an element capture. Part of what makes two captures comparable (§1.8). |
| `viewport_width` | `int` | The width the capture was taken at. **This is the breakpoint**, stored as a number rather than a name because a named set of breakpoints is a vocabulary the service would have to own and does not. |
| `url` | `text`, null | What page this was a picture of, at whatever detail the privacy setting allows (§1.4). **Not the same as the tab's address**, which moves on: a capture is of one page at one moment, and without this a view name accidentally pointed at two different pages is undetectable. |
| `warned` | `boolean` | Whether the accounting warning fired on this capture. **The only way to find out whether the warning changes behaviour** is to know which captures carried one and look at what that caller did next. Not derivable after the fact: the threshold it was measured against is a setting that can move. |

**What is deliberately not here:**

- **No `estimated_tokens`.** It is width times height divided by a fixed constant — a calculation
  over two columns on the same row. It is a genuinely useful number and it still appears on every
  capture response and every rollup; it is computed when asked for rather than frozen into a column
  that could disagree with the dimensions beside it.
- **No `full_page_requested`.** A full-page capture is one whose `kind` is `full_page`. Asking for
  one and getting one are the same event.
- **No version number.** Which capture of a view came before which is `taken_at` over the captures
  of that view, which is one indexed read. §1.7a's callout is about whether the *file name* should
  carry it as well.

### 1.7a Where files live on disk

Browser automation produces a lot of files: a console log per tab, a network log, an accessibility
snapshot on every navigation and after every action, downloads a page triggers, and screenshots. Left
to itself, that lands wherever each tool happens to write. **Everything the service or the tool emits
has a defined home here**, so nothing has to be hunted for and a finished lease can be deleted as one
directory.

**Rooted at an environment variable**, `BROKER_ARTIFACTS_ROOT`, which defaults to a directory of the
service's own under the per-user application-data location the platform defines. An environment
variable rather than a setting for the same reason as the address the server binds to (§6.1): a bad
value stored in the database could only be fixed through the surface the bad value broke.

```
<artifact root>/
  claims/
    <claim id>/
      images/       captures, and the crops a comparison produces
      snapshots/    accessibility snapshots
      console/      console logs
      network/      network logs
      downloads/    anything a page downloaded
  baselines/        one live image per view, browser, kind and breakpoint, plus retired ones
```

**Every path stored in the database is relative to that root — never absolute.** The root can move,
and an absolute path pins every row to one machine's layout the moment it is written. A relative path
plus a root that is configuration survives the move; an absolute path turns it into a data migration.

**Nothing is returned to a caller unless it asked.** A capture returns its path, not its bytes; a
read returns a path, not a log. The files are there so the caller can open the one it needs, which is
the difference between a review that costs one picture and a review that costs twenty.

**One folder per lease is deliberate** — a lease is the unit you delete, and everything it produced
goes with it in one step. Baselines are the exception and sit outside, because a baseline outlives
every lease that ever compared against it.

**File names are legible and sort into order.** A capture is named after its view, its width, the
moment it was taken and its own identifier, so listing a directory puts a view's pictures in sequence
and every name is unique without anybody coordinating. Region crops from a comparison take the
capture's name plus a region suffix, so they sort next to it. **A label a caller supplies is
restricted to a safe set of characters and a length, and is never interpreted as a path** — the same
reasoning that refuses a local-file address in §3.7.

> **❓ NEEDS YOUR INPUT — Should file names carry a version number? (§1.7a)**
>
> **The problem:** you asked for names where the relationship is computable from the name alone —
> `homepage`, `homepage-v2`, `homepage-v3` — so that stripping the version yields the base image.
> The intent is right and the thing you want is real: *"I want to see the previous screenshot"*. But
> a version number in a file name **is a second record of lineage**, sitting alongside the one the
> database already keeps, and a second record of one fact is the exact failure this schema's own
> rules are built to prevent. It has three specific problems: a file name cannot be allocated
> transactionally, so two leases capturing one view race for `-v2` with nothing to stop them; the
> version implies a total order that the data does not have, because a baseline can be replaced,
> retired and replaced again; and it has no answer at all for a baseline imported from a file, which
> was never a capture.
>
> **Options:**
> - **Legible sortable names, lineage from a query.** `<view>-<width>-<when>-<id>.png`. Listing the
>   directory sorts into sequence, and *"show me the previous picture of this view"* is one command
>   — the captures of a view in order, and the baselines of a view including retired ones. Nothing
>   can race and nothing can drift. What you give up is the arithmetic you described: you cannot get
>   from one name to another by deleting characters.
> - **Version numbers in the name, as you described.** You get exactly the property you asked for.
>   You also get a number the service has to allocate under contention, a name that stops being
>   truthful the first time a baseline is retired out of order, and two places that answer "which
>   came first" — which will eventually disagree.
> - **Both: sortable names, plus a version number recorded in the database.** The lineage is
>   queryable and unambiguous, and a caller that wants "v3" can ask for it. It is still a second
>   record, but a transactional one, so it cannot race; what it cannot do is make the *file name*
>   carry it, which was the part you wanted.
>
> **Recommendation: the first.** It gives you the outcome — seeing the previous picture, browsing a
> view in order — without minting a second source of truth. This is your own standing rule pointing
> against your own request, which is why it is a question rather than a decision taken for you.
>
> **What changes if you pick differently:** the file-naming rule and, for the third option, one
> column on `captures`. No surface changes and no other table changes; comparison and promotion work
> identically under all three.

### 1.8 `baselines` — the picture everything is compared against

A baseline is the picture a later capture is compared against. Bless one for a view, and every
comparison of that view runs against it until it is replaced.

| Column | Type | What it's for |
|---|---|---|
| `id` | `uuid`, primary key | |
| `view_key` | `text` | The caller's name for a view. Free text, tidied on the way in (case, spacing, separators). **Deliberately not a reference table:** the service has no concept of a "view", and a registry would force a caller to declare one before it could compare one — friction on the operation the feature exists for. The cost is that two spellings are two views; tidying kills case and punctuation variants and does not kill synonyms, and that limit is accepted rather than hidden. |
| `browser_id` | `text` → `browsers.id` | **Which browser took it, and this is part of the identity.** A picture from the signed-in browser and one from the clean browser are different pages — a signed-in header, personalised content, a consent banner or not — and both can honestly be called "the home page". Without this column the second silently compares against the first and reports the whole page as changed, forever. |
| `kind` | enum | Viewport, full page, or one element. Part of the identity for the same reason: a viewport picture and a full-page picture of one view at one width are different images. |
| `viewport_width` | `int` | The breakpoint. |
| `selector` | `text`, null | Which element, on an element baseline. Not part of the identity — it is what a comparison checks against, so an element capture compared to a baseline of a *different* element is refused by name rather than diffed. |
| `width` · `height` · `bytes` | `int` | The image's own facts. Stored so listing baselines does not mean opening every file, and so a comparison can check the geometry matches before diffing anything (§1.9). |
| `tier` | enum | Which resolution rung this baseline was made at. **A comparison is performed at the baseline's geometry**, so this is what a later capture of the same view is taken at. |
| `path` | `text` | Relative to the artifact root (§1.7a). **Promotion copies the image into the baselines area; it does not point at the capture's file.** That is stated rather than implied because the other reading is silent data loss on a two-week fuse: capture files are deleted on a retention schedule, and a baseline row that still says "live" pointing at a file that has been swept is a comparison that fails on a missing file. **Baseline files are exempt from capture retention.** |
| `promoted_from` | `uuid` → `captures.id`, null | Which capture became this baseline. Null when a baseline came from a file rather than from a capture — both are legitimate and only one has a capture row. |
| `promoted_at` · `promoted_by` | `timestamptz` · `text` | When, and a free-text label for who. |
| `promote_reason` | `text` | **Mandatory**, and consistent with the rest of this design: a lease states its purpose, a revoke states its reason, the top capture tier states why. A baseline is a longer-lived commitment than any of those — everything compared against it inherits whatever it happens to contain — and *"blessed with a consent banner up"* is a mistake nobody can diagnose six weeks later without a sentence. |
| `retired_at` | `timestamptz`, null while live | **Baselines are retired, never deleted**, so a comparison recorded months ago can still name what it was compared against. Deleting one turns every comparison against it into an unfalsifiable claim. |
| `aa_threshold` | `real` | How much pixel-colour noise to ignore. **Per baseline rather than one global number, and this is a real design position:** a view dense with text needs a looser threshold than a view of flat colour, and one global number gets tuned to the noisiest view and then swallows genuine changes everywhere else. The global setting is what a *new* baseline starts at, not what it keeps. |
| `min_region_area` | `int` | The smallest change worth reporting, measured as **area with an allowance for thin lines** rather than as the shorter side of the box. A one-pixel divider that changed colour across a wide page is a box one pixel tall, and filtering on the shorter side discards it — along with border widths, focus rings and underlines, which are precisely the small-but-real changes this feature has to prove it does not swallow. |
| `ignore_regions` | `jsonb`, null | Rectangles a comparison skips. A carousel, a video, a live counter or a "last updated" timestamp legitimately differ on every load and produce a large, correctly-detected change every time. **The column lands with the first migration even though the first version does not use it**, because the schema arrives as one baseline and changes additively after that, so a column left out now costs a migration later for something already known to be needed. |

**A view name is the caller's whole identity for a view, and it has to carry what the service cannot
see.** Theme, language, which persona is signed in, whether reduced motion is on — none of these are
visible to the service, and all of them change the pixels. A caller comparing a dark-mode page must
name it distinctly (something like `homepage@dark`), because whichever one is blessed first owns the
baseline and the other reports everything as changed forever. That is a limit rather than a defect,
and stating it is what turns it into a chosen one.

**One live baseline per view, browser, kind and breakpoint, and any number of retired ones.** That is
a uniqueness rule the database enforces, and how it is expressed is §1.11.

> **❓ NEEDS YOUR INPUT — Who creates the first baseline? (§1.8)**
>
> **The problem:** your worked example was *load the home page and capture it; next time, ask for the
> capture and the difference.* **As this document specifies it, the second run is refused** — because
> creating a baseline is deliberately a person's decision on the operations surface, and the agent
> cannot take it. Until somebody promotes one by hand, run two, run three and run four are all
> refused identically. The refusal itself is right and should stay: a comparison that quietly returns
> "nothing changed" with nothing to compare against is indistinguishable from one that worked, which
> would make the feature silently useless exactly where it is least expected to be. What is wrong is
> that nothing tells you a person has to stand between visit one and visit two.
>
> **Options:**
> - **Keep it person-only, and say so loudly.** The strongest guarantee: nothing is ever compared
>   against a picture nobody looked at. Every new view costs a human step before diffing works, and
>   an agent doing a first sweep of twenty views queues twenty of them.
> - **Let the caller decide, on each call, with no default.** The comparison takes an explicit
>   instruction for the case where no baseline exists: refuse, or promote this capture and say it
>   did. **With no default it cannot fail open** — a caller that says nothing gets the refusal — and
>   the tool count does not move. A baseline created this way is recorded as self-blessed, so the
>   operations page can show which baselines nobody has actually looked at.
> - **Automatically make the first capture of a view a provisional baseline.** Your example works
>   with no ceremony at all. It also means the very first picture — possibly mid-load, possibly with
>   a banner up, possibly of an error page — becomes the thing everything is measured against, and
>   nobody finds out until every comparison is wrong in the same way.
>
> **Recommendation: the second.** It makes your example work in one call, it keeps the refusal as the
> default so nothing fails open by accident, and the self-blessed marker means a person can still
> come along and confirm or replace what an agent chose.
>
> **What changes if you pick differently:** one optional argument on one tool, one column on
> `baselines` recording how it was blessed, and one line on the operations page. No other surface
> and no other table.

### 1.9 `comparisons` — and what you actually get back

**What a comparison returns — the question worth answering plainly.** It is **not** a set of
coordinates you then have to go and cut out of a picture yourself. The service does the cutting. For
each region that changed it writes **two** small images — that region as it was in the baseline, and
as it is now, cut from the same rectangle with a little padding so the crop is identifiable — and
returns their paths alongside the numbers. It also writes one full-frame image with the changed
regions outlined, so *"where on the page"* is a single picture rather than arithmetic.

| What comes back | Type | What it's for |
|---|---|---|
| `changed` | boolean | **True when at least one region survives filtering** — not when any pixel differs. Defined explicitly because it is the field every caller branches on, and "three pixels moved but nothing survived the size filter" has to have one answer rather than two. |
| `changed_pixels` · `changed_ratio` | int · number | The raw count and its share of the image, before regions are worked out. What distinguishes *nothing moved* from *the threshold ate it*, and what lets a caller spot a whole-page re-render without opening anything. |
| `regions` | a list | One entry per changed area: its position and size **in the capture's own pixels, measured from the top left**, plus **two paths — the crop from the baseline and the crop from the new capture**. Usable images, already cut, at the size of the thing that changed. Ordered largest first. |
| `overlay` | path | The new capture with the changed regions outlined. One picture that answers *where*. |
| `truncated` | boolean | Whether regions were dropped by the cap on how many come back — the smallest ones, since the list is ordered largest first. A truncated result that does not say so is a lie about completeness. |
| `baseline` | path and id | What it was compared against, including a retired one. |
| `settings applied` | numbers | The three values that decided the output: the colour tolerance, the smallest area reported, and the cap on regions. |

**Every one of those is a path, not an image.** The caller opens the two or three that matter. A
review of twenty-five screenshots becomes a review of the two regions that moved, and the cost of
looking is paid on the crops rather than on the pages.

**Which surfaces return it:** the `browser_compare` tool (§3.12), the comparison endpoint (§4.2), and
`broker compare` (§5.3) — the same result on all three, because they are the same operation.

> **❓ NEEDS YOUR INPUT — How do the crop images reach the caller? (§1.9)**
>
> **The problem:** the service returns paths on a disk. That works when the caller is a process on
> this machine, which can open the file. It does not work at all for a caller connected over the
> network — and the design deliberately supports exactly that, because the primary route in is one
> long-lived server that several sessions connect to. So as written, the one feature whose entire
> output *is* pictures cannot deliver them to a caller on another machine, and nothing says so.
>
> **Options:**
> - **Paths only, and state plainly that comparison is for callers on this machine.** No new surface.
>   It makes an explicitly supported deployment quietly unable to use one feature, which is the kind
>   of limit that is discovered rather than read.
> - **Add one endpoint that serves an artifact's bytes**, given its stored path, and check the path
>   belongs to the asking lease. Small, and it makes every path in the design fetchable rather than
>   only the crops. It also creates the first endpoint that returns arbitrary file content, so the
>   ownership check on it has to be exactly right.
> - **Return the crops inline in the comparison result.** Everything else in this design returns
>   paths because the payloads are enormous — a full screenshot is thousands of tokens. **A crop is
>   not that**: it is the size of the thing that changed, and it *is* the answer, so returning it
>   closes the loop in one call instead of two. The risk is a page-wide change producing a dozen
>   crops that are collectively as expensive as the screenshot the design avoided.
>
> **Recommendation: the second, with the third as a bounded option** — an endpoint that serves bytes
> so nothing is undeliverable, plus an opt-in on the comparison call that returns crops inline when
> the total is under a size cap and paths when it is over. The rule everywhere else — never return
> what is enormous — survives, and the one case where the picture is small and *is* the answer stops
> being an exception nobody wrote down.
>
> **What changes if you pick differently:** one endpoint and one optional argument. No table changes
> and no change to what is written to disk.

**Why this is a table, given the rule that nothing is stored if it can be computed.** The weak
argument is that without a row the result exists only in the response, which is true of every read in
the service and proves nothing. The arguments that survive the rule:

1. **It cannot be recomputed.** The output is a function of two images and some settings — and
   capture files are deleted on a retention schedule, so past that window there is no price at which
   the answer can be recovered.
2. **It cannot be reproduced.** The threshold belongs to the baseline and can be re-tuned, so
   re-running the comparison later answers a different question from the one that was asked. What
   the older call *did* is exactly what tuning needs to know.
3. **Its references can be enforced here and nowhere else.** Which capture, which baseline, which
   lease are real foreign keys in a table and are unenforceable inside a blob of data on a record
   entry.
4. **The honest alternative is a record entry**, since the record already has a comparison kind with
   room for detail. The reason it should not be one is that how long the record is kept is a live
   setting, so a future decision to trim it would silently destroy the tuning history.

The row keeps: which capture, which baseline, which lease, when, **the three settings actually
applied**, the changed-pixel count, the regions with their crop paths, and whether the list was
truncated. All three settings are copied rather than referenced, because all three are mutable and
all three determined the output — snapshotting one and referencing the others would be a record that
is half-true. **No separate region count** — it is the length of the list of regions.

### 1.10 `settings` — and whether they should exist at all

**The rule this design uses:** an environment variable carries only what must be known **before the
process can reach the database**. Everything read after that point is a **setting** — declared in
code with a type, a default, a label and help text, where the database stores nothing but the
*overrides*. A fresh database therefore boots fully working, with nothing to seed.

| Column | Type | What it's for |
|---|---|---|
| `key` | `text`, primary key | Matches a key the code declares. A row for a key the code does not declare is inert, listed as unrecognised, and never deleted — deleting somebody's configuration because a version stopped using it loses the record of what they had chosen. |
| `value` | `jsonb` | The override. An explicit empty value is meaningful — retention forever, comparison off — and is **not** the same as having no row, which means "whatever the code says". |
| `updated_at` | `timestamptz` | When it changed. |
| `updated_by` | `text`, null | A free-text label for who changed it. There is no table of people, and inventing one for an audit label is a user model arriving by the back door. |

A second one-row table holds a counter that moves on **every** settings write, including clearing
one. A counter rather than "the latest timestamp", because clearing an override deletes a row and a
deletion can lower a maximum — a change that moved state backwards would be invisible to anything
watching a high-water mark.

**Settings are never a secret store.** Every value is readable without authentication and printed by
the command line. There is no redaction path and none will be added, because a value that cannot be
shown cannot be edited on the surface the table exists to feed. Credentials belong in the environment.

> **❓ NEEDS YOUR INPUT — Is a settings table worth the machinery, with no front end? (§1.10)**
>
> **The problem:** the obvious objection is a good one. There is no web form here — the only visual
> surface is a read-only page — so if nobody can click anything, environment variables would do, and
> a table plus a code registry plus a revision counter plus a resolver is a lot of apparatus for
> values a person could put in a file.
>
> **Options:**
> - **Everything in the environment.** Simplest possible thing: one file, no table, no registry, no
>   resolver. Every change needs a **restart**, and here that is not a small word — **a restart kills
>   both browser processes, every open tab and every live lease**, including the sign-in work
>   somebody is halfway through. Changing the tab budget from fifteen to twelve would destroy the
>   work of everyone holding tabs at that moment. There is also no record of who changed what, and no
>   validation beyond whatever the code does when it reads a string.
> - **Environment for what the process needs to start, settings for everything else.** Tuning the tab
>   budget, the lease durations, the resolution rungs, the comparison thresholds or the privacy level
>   takes effect without stopping anything. Every value is typed and validated on the way in, so a
>   wrong one is refused rather than absorbed. Every change writes a row saying when and by whom.
>   **The editing surface is the command line** — `broker config set` — so "no front end" does not
>   mean "no way to change it", and if a page ever grows a form the registry is already what it would
>   render.
> - **Environment plus a config file the service watches.** Avoids the table. Adds a file format, a
>   file watcher, and a second place configuration lives; the audit trail and the validation still
>   have to be built, so most of the apparatus arrives anyway without the one property a database
>   gives — one answer, from one place, that every process agrees on.
>
> **Recommendation: the second.** The argument is specific to this service rather than general: its
> whole job is holding long-lived, expensive, stateful things, so **the cost of a restart is
> unusually high here** and the ability to change a number without one is worth real machinery. The
> apparatus is also smaller than it sounds — the registry is a list of declarations in code, and the
> table has four columns.
>
> **What changes if you pick differently:** if you choose environment-only, the two tables go, §6.2's
> registry becomes a list of environment variables, `broker config` goes, and every tuning change
> becomes a restart that ends every live lease. Nothing else in the design moves — no surface and no
> other table depends on settings being editable.

### 1.11 Making an illegal state impossible

**The rule in question:** a session may hold **at most one live lease**. Two more rules have the same
shape: two live tab rows must never name the same physical tab, and a view may have at most one live
baseline per breakpoint.

**The problem, from the beginning.** To grant a lease, the service checks whether that session
already has one. So it reads: *"does a live lease exist for session S?"* The answer comes back no,
and it writes one.

Two callers can do that at the same instant. The reasonable objection is that they cannot write
*simultaneously* — one write must land before the other, so the second should fail. **The writes do
serialise. Serialising is not rejecting.** The second write lands after the first and the database
accepts it, because nothing has told the database that two rows saying "session S has a live lease"
are illegal. Two similar inserts into a table are an entirely ordinary thing to do; without a rule
saying otherwise, a database has no reason to refuse the second one.

The staleness is not in the write. **It is in the read that came before it.** Both callers read "no
live lease" and both reads were true when they were made. By the time the second write lands, its
read has stopped being true — and nothing re-checks it, because a read is not a promise about the
future. That is the whole race: two correct reads, two legal writes, one broken rule.

**So the fix has to live at the write, not at the read.** The database has to be told the rule, so it
refuses the second insert itself rather than being asked to agree with a check somebody did earlier.

**Why that is awkward here.** The rule is not "one lease per session" — a session takes many leases
over its life and all the finished ones stay, because rows are permanent. The rule is "one **live**
lease per session": uniqueness over *some* of the rows. An ordinary unique constraint covers all
rows, so it would refuse a session's second-ever lease. What matches the rule exactly is a **filtered
uniqueness rule** — unique among rows in a live state — which the database supports and the
object-relational mapper this project uses **cannot express in its schema file at all**. That is
where the pressure comes from, and it is why this is one decision about a shape that recurs three
times rather than three separate details.

> **❓ NEEDS YOUR INPUT — How the "one live X" rules are enforced (§1.11)**
>
> **The problem:** three rules need the database to refuse a duplicate among *live* rows only. The
> tool that generates the schema cannot describe a filtered rule, so something has to give: either
> the schema file stops being the whole truth, or the tables change shape so an ordinary rule fits.
>
> **Options:**
> - **A — Hand-written rules the schema file does not know about.** The migration carries them and
>   the drift check that compares the schema file to the database is taught to expect three
>   differences, forever. Correct, and the smallest change. The cost is a permanent exception in a
>   check whose entire value is having none — and the exception has to name each rule individually,
>   or it becomes a hole anything can walk through.
> - **B — Check it in the application code instead.** No schema change at all. **It does not work on
>   its own** — it is exactly the read-then-write above — so it needs the writes forced into single
>   file, either by the strictest transaction mode or by an explicit lock taken on the session name.
>   That is a real mechanism, it has to be named as one rather than assumed, and it is a rule that
>   holds only as long as every path that writes a lease remembers to take the lock.
> - **C — Give live rows their own small table.** A lease's permanent record stays where it is; a
>   second, tiny table holds only the leases that are live, keyed by session, and a row is **deleted**
>   when the lease ends rather than flagged as finished. Uniqueness over that table is then an
>   **ordinary** unique constraint — the schema file expresses it natively, the drift check stays
>   clean with no exception, and the same shape works unchanged for the tab rule and the baseline
>   rule. It has a second benefit worth naming: *"how many tabs are in use"* becomes a count of a
>   table with tens of rows rather than a filtered scan of one that grows forever. The cost is three
>   more tables, two writes per transition instead of one, and one invariant the service must
>   maintain — a live row exists exactly while the lease is live. Getting that wrong wedges a session
>   out of the service until somebody notices; the mitigation is that it fails **loudly and
>   immediately**, on that session's very next request, and a stale row is visible on the operations
>   page rather than hidden in an index.
>
> **Recommendation: C.** It is the only option that ends with the rule written in ordinary language
> the tooling understands, and you said plainly that a permanent exception is not something you want
> to carry. It costs more tables and buys a schema file that is the whole truth. B is not a
> standalone answer and should not be read as one.
>
> **What changes if you pick differently:** **A or B** leave every table in this document exactly as
> written; A adds a documented exception to one continuous-integration check, B adds an explicit lock
> to the grant path and nothing to the schema. **C** moves three things out of the tables above into
> companion tables — a lease's live state and its session key, a tab's driver name, and a baseline's
> retirement flag — and changes nothing else: same columns, same meanings, same surfaces, same
> responses. It is a schema decision, not a product one, and it is reversible before anything is
> built.

### 1.12 What is stored, what is computed, and why

Every column above was tested against rule one. This is the audit, in one place.

**Removed, because it can be computed:**

| Was | Computed instead from |
|---|---|
| `browsers.persistent` | Which of the two browsers it is |
| `browsers.profile_dir` | The configured profile root plus the browser's own name — and an absolute path is never stored (§1.7a) |
| `browsers.last_error` | The most recent failure event for that browser |
| `browsers.surface_verified` | `browsers.state` — a browser that fails the check never reaches `running` |
| `claims.renewed_at` | `expires_at` minus `ttl_seconds` |
| `claims.queue_position` | A count of the queued leases that arrived earlier |
| `claims.captures_taken` | A count of that lease's captures |
| `captures.estimated_tokens` | Width times height over a fixed constant — still returned on every response, just not frozen into a column |
| `captures.full_page_requested` | `captures.kind` |
| `captures.version` | The file name (§1.7a) |
| `comparisons.region_count` | The length of the region list |
| `tabs.established_origin` | Reported as a note on the response; the service does not claim to guard it |

**Kept although computable, each with its reason:**

| Column | Why it stays |
|---|---|
| `claims.renew_count` · `claims.ended_at` | The lease row is permanent; the ledger it would be counted from is prunable |
| `browsers.restart_count` | Same, and it is read on every operations page render beside `state`, which reads `running` between crashes |
| `tabs.opened_at` · `tabs.closed_at` · `tabs.close_attempts` | Same permanence argument; `close_attempts` also drives escalation on a path that runs every few seconds |
| `tabs.browser_id` | A copy of the lease's browser, kept because a uniqueness rule can only be written over columns on one row (§1.11). It cannot drift — the database refuses a tab whose browser disagrees with its lease's |
| `events.session_id` | A refused request never becomes a lease, so without the copy every refusal is anonymous |
| `captures.bytes` | Capture files are deleted on a retention schedule; the row is permanent |
| `captures.tier` · `captures.warned` | Both were measured against settings that can move, so the value in force at the time is not recoverable afterwards |
| `captures.url` | **Not a copy of the tab's address** — a tab moves on, and this is what one picture was of. Nothing else records it |
| `baselines.width` · `height` · `bytes` · `tier` | Computable from the capture a baseline was blessed from, except that a baseline can also come from a file and then has no capture. A column that is right most of the time and absent the rest is worse than one that is always there |
| The three settings copied onto `comparisons` | The values actually applied, copied when the comparison ran. All three are mutable, so re-running later answers a different question — and snapshotting one while referencing the others would be a record that is half-true |
| `claims.ttl_seconds` | The duration the caller was promised. Re-reading a setting mid-lease would change a promise already acted on |
| `claims.tabs_granted` | A queued lease has no tab rows to count, and an active one that closes a tab keeps its entitlement |

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

**Five reasons a request is refused outright rather than queued**, each because waiting would not
help:

| Refusal | When | Why it is not a queue entry |
|---|---|---|
| unknown browser | The browser named is neither of the two | Nothing will ever make it valid |
| more tabs than one lease may hold | Over the per-lease cap | Same. The cap exists so one caller cannot legally take the whole budget |
| more tabs than exist | Over the whole budget | **A request that can never be granted must not sit in a queue pretending it might be.** A structurally impossible queue entry is worse than a refusal, because the caller waits for it |
| this session already holds a lease | The session has a live lease | Below |
| the browser is not running | It is starting, failed, or a person is signing in | A browser being down is an availability problem, not a capacity one. The queue's promise is that capacity frees up, and nothing about a failed browser promises that |

**"This session already holds a lease" names the existing lease and its state, and not its key.** The
key was returned once and is not recoverable, by construction — it is not stored. That has a sharp
consequence worth stating rather than discovering: **a caller that loses the response to its own
request cannot get its lease back.** Its options are to wait the lease out or ask an operator to
revoke it. That is the price of not storing keys, and the alternative — quietly returning the
existing lease as a success — would hide the real bug this refusal catches, which is two callers
sharing one session identity.

**Releasing is forgiving; everything else is not.** Releasing a lease that already ended succeeds and
says so. Trying to *use* one fails. The asymmetry is about what the caller is about to do: a caller
tidying up in a cleanup path and again on shutdown must not see an error for tidying twice, and there
is nothing to corrupt. A caller about to do work it cannot do should be told now, not one operation
later, further from the cause.

### 2.3 Allocation is all or nothing

**If four tabs are free and ten are asked for, the service does not grant four.** It never splits a
request. The caller asked for ten because it planned for ten; handing it four leaves it holding a
lease that cannot do the job it described, and the decision about how to re-plan belongs to the
caller, which is the only party that knows what the work is.

**But a bare refusal is not the answer either.** The request queues, and the queued response says
what a caller actually needs to decide what to do:

| What comes back | What it's for |
|---|---|
| Position in the queue, and how many are ahead | Where you stand |
| A rough wait | Roughly how long, labelled as rough |
| **How many tabs could be granted right now** | The number this caller could have immediately if it asked for fewer — the whole point of the response |
| Which browser that offer is for | Free capacity is one total across both browsers, but a lease names one |
| A note saying what to do about it | *You are third in the queue for ten tabs. Three are free right now: release this lease and ask for three if you would rather start than wait.* |

**The offer is a snapshot, not a reservation.** Somebody else may take those three before the caller
acts, and the note says so. Reserving them would mean holding capacity for a caller that has not
decided — which is the thing the whole design refuses to do.

**Taking the offer means releasing and asking again**, which puts the caller at the back of the queue
for its original request. That is the right trade when it is about to be granted immediately anyway.
Letting a queued lease shrink in place was considered and left out: it is a second way to change a
lease's size, and it saves a caller a place in a queue it is choosing to leave.

**Capacity is taken when the lease is granted, not when the tabs finish opening.** The consequence is
worth stating because it is a deliberate trade: the service can briefly believe it is fuller than it
is, and can never believe it is emptier. A crash at the wrong moment leaves tabs reserved that never
opened, and the restart check (§2.6) is what clears them. The other way round — counting only tabs
that are physically open — the budget can be overshot, which is the failure that costs memory on a
machine somebody is using.

**If every tab fails to open**, the service ends the lease itself, records why, and tells the caller
the browser is unavailable. A lease with no tabs is useless and holding capacity for it is strictly
worse than refusing. **If some open and some fail**, the lease stays active with the tabs that
worked, the response lists them and names the shortfall — a caller that asked for four and can use
three is usually better served by three than by nothing, and it is the caller that knows.

### 2.4 How capacity comes back

Three ways, and only three:

- **The caller releases.** Its tabs close and the queue is swept.
- **The lease lapses.** Nothing called in before the expiry, so the service closes its tabs and sweeps.
- **An operator revokes it**, with a reason the caller sees on its next call.

A sweep runs on a short timer and immediately after any of the three, so freed capacity goes to
whoever is waiting rather than sitting idle until the next caller happens to arrive.

**Two durations, one rule.** *Keep calling in or lose it* applies identically to a caller holding
tabs and to one waiting in the queue; only the duration differs — ten minutes for a lease that holds
tabs, five for a place in the queue. They differ because the costs are asymmetric: expiring an active
holder destroys work in progress and can strand a half-finished sign-in, while expiring a waiting
caller costs it a place it can retake by asking again.

**A tab the tool will not close keeps counting.** Asking is not the same as it having happened, so a
tab stays counted until a close is confirmed. After a few failed attempts the service stops retrying,
records it, and shows it on the operations page. It is **not** force-closed by killing the browser,
because there is no state in which this service takes a browser-wide action (§2.7). The honest
consequence: a tab that will not close costs one unit of budget until the service restarts.

### 2.5 The queue keeps strict order

The sweep promotes the front of the queue while the front fits, and **stops the moment the front does
not fit** — it never skips ahead to a smaller request behind it. A four-tab request blocks
single-tab requests behind it until four tabs are free.

> **❓ NEEDS YOUR INPUT — Strict order, or skip-ahead with an aging rule? (§2.5)**
>
> **The problem:** strict order is fair and easy to explain, and it wastes capacity — three tabs can
> sit idle because the front of the queue wants four, while somebody behind wants one. Skipping ahead
> uses that capacity and serves more callers sooner. What it does is aim the cost at the largest
> requests, which are the ones least able to retry cheaply.
>
> **Options:**
> - **Strict first-in, first-out.** A caller's position only ever improves. The blocking is visible,
>   fair and bounded by the front caller's expiry. Idle capacity while a large request waits.
> - **Skip ahead to whoever fits.** Higher use of the tabs. On a busy day a four-tab request can wait
>   indefinitely while single-tab requests overtake it forever, and the signal it gets is a queue
>   position that sits at 1 and never moves — starvation that looks exactly like a queue working.
> - **Skip ahead, with an aging rule** that eventually stops anyone overtaking a request that has
>   waited too long. Gets most of the throughput without unbounded starvation. It also adds a second
>   number to reason about, and the behaviour at the boundary is the kind of thing that is easy to
>   argue for once and hard to reason about later, when it matters.
>
> **Recommendation: strict order for the first version.** The queue is short, the leases are minutes
> long, and the wasted capacity is bounded by one lease's expiry. Choosing the version whose failure
> is *visible* over the one whose failure is *silent* is worth more than the throughput here.
>
> **What changes if you pick differently:** the sweep only — a few lines of the promotion rule, plus
> one setting if aging is chosen. No table, no response and no surface changes, and it can be changed
> after the service is running.

### 2.6 After a restart

The service serves nothing until it has reconciled, and the reason is arithmetic: a capacity count
that includes tabs nobody owns refuses work for no reason, and one that misses real tabs overshoots
the budget. Both are wrong and only one is loud.

It expires anything already past its expiry, gives up on tabs that were mid-open when the process
died, asks the automation tool what is actually open **in the browsers it launched** — identified by
the process it recorded, so a browser somebody else is running is never inspected — closes anything
open that no live lease owns, marks closed anything a lease thinks it owns that is gone, and then
sweeps the queue so recovered capacity goes to whoever is waiting.

If the browsers are not running at restart — the ordinary case — every tab row is marked closed,
because a tab inside a process that has exited is closed by definition. The step-by-step is in
`MILESTONES.md`.

### 2.7 What reclaims what — the whole rule in one line

> **Every reclamation is scoped to a tab and to a lease. Nothing is ever scoped to a browser.**

Releasing closes exactly that lease's tabs. Expiry does the same. Revoking does the same. The restart
check closes exactly the tabs the service can prove it owns and no live lease wants. The browsers are
managed by the service and are never closed by any caller's action, direct or indirect — **and this
is not a rule callers are asked to respect, because there is no operation through which they could do
otherwise** (§3.13).

---

## 3. What an agent can do

### 3.1 The list, and what it costs

**Eleven tools.** Every description sits in a connected session's context on every turn whether or
not anything calls it, so surface area is a standing tax and the list is short on purpose.

| # | Tool | One line |
|---|---|---|
| 1 | `browser_claim` | Ask for a lease. Get tabs, or a place in the queue. |
| 2 | `browser_status` | Where your lease stands. **Extends it** — this is the keep-calling-in verb. |
| 3 | `browser_release` | Give the lease back. Closes your tabs and nothing else. |
| 4 | `browser_tab_open` | Open a replacement tab inside the grant you already hold. |
| 5 | `browser_tab_close` | Close one of your tabs. |
| 6 | `browser_navigate` | Point one of your tabs at an address. |
| 7 | `browser_act` | Click, type, fill, press, select, hover, check, scroll. |
| 8 | `browser_read` | Snapshot, console, network or cookie summary — written to disk, returned as a path. |
| 9 | `browser_evaluate` | Evaluate an expression in the page and get its value. |
| 10 | `browser_capture` | Take a picture. Returns a path and its dimensions, never the image. |
| 11 | `browser_compare` | Compare a capture against this view's baseline; get back the regions that moved, already cropped. |

**Two collapses bought that budget, and both have a cost worth naming.** `browser_act` folds ten
verbs into one action name — less discoverable, and its error messages have to work harder. Reading
folds four kinds of artefact into one tool. **What was deliberately not collapsed is closing a tab**:
a destructive operation keeps its own name, because folding one into a general operation under a
parameter is how a rule that matches on the operation's name becomes invisible.

**Every tool except the first takes the lease key, and every call carrying the key extends the
lease.** There is no keyed call that does not, including the ones that only read — a call that did
not extend would be a hole in the one rule the whole liveness model rests on, and it would produce
leases that lapse while their caller was politely only looking.

**There is no separate renew verb.** A dedicated one would be a second name for an effect every call
already has, and two names for one effect is how a caller comes to believe one of them does not
renew. `browser_status` is simply the call that does nothing else.

### 3.2 `browser_claim`

| Argument | Type | Required | What it's for |
|---|---|---|---|
| `session_id` | string | yes | The caller's identity. The unit the one-live-lease rule is over. |
| `browser` | `regular` or `private` | yes | **No default, deliberately.** Defaulting to private would silently give clean-room behaviour to a caller that needed a sign-in; defaulting to regular would put unnecessary work on the profile that has something to lose. Neither is a safe guess, so the caller states it. |
| `tabs` | int | no, default 1 | How many. **Asking for more than you use is not free** — a grant is capacity taken from the queue for the whole lease. |
| `purpose` | string, 3–200 characters | yes | What this lease is for, in human words. Shown on the operations page. |

**What comes back:** the lease's id, the key (**once — it is never stored and never recoverable**),
its state, the browser, the tab identifiers (empty when queued), when it expires, how often to call
in, the budget and how much of it is in use, the queue information when queued (§2.3), and a list of
notes.

**The notes are where the protocol says out loud what it expects.** A queued lease always carries one
saying: *call in with this key at least every N seconds, or lose your place and re-queue at the back
with a new key.* A protocol that implies an obligation and never states it is a protocol whose
clients will not meet it. Other notes: per-tab session storage on every grant; a shortfall when fewer
tabs opened than were asked for; and on a private lease, *clean-room relative to the signed-in
profile, not relative to other callers on this browser*.

### 3.3 `browser_status`

Takes the key. Returns the same shape without the key. **This call extends the lease**, and it is
what a queued caller polls with.

Refuses when nothing matches the key, and when the lease has ended — naming the state and when, and
for an expired one saying plainly that the tabs are gone and a fresh request is the way back.

### 3.4 `browser_release`

Takes the key. Closes exactly this lease's tabs and sweeps the queue. **Forgiving** — releasing twice
succeeds and says the lease had already ended. Refused only for an unrecognised key.

### 3.5 `browser_tab_open`

Takes the key. Opens one tab **inside the grant this lease already holds**, so it is usable only
after a close freed one. It never enlarges a lease and never touches the budget, because the budget
was taken when the lease was granted. Its purpose is a genuinely fresh tab — no history, no in-page
state. A caller that only needs a different page navigates instead.

Refused when the lease is already at its grant (naming how many it holds and how many it may),
when the lease has ended, and when the browser is unavailable.

### 3.6 `browser_tab_close`

Takes the key and a tab. **Keeps its own name because it is the destructive one.**

Refused when the tab is unknown **or belongs to another lease** — deliberately the same refusal and
the same wording for both, because distinguishing them would let a caller discover other leases' tabs
by probing, and there is no case where a caller legitimately needs to know that a tab it does not own
exists. Also refused when the tab is already closed.

### 3.7 `browser_navigate`

Takes the key, a tab, an address, and optionally how long to wait for the page. Returns the final
address after redirects, the title, the response status, and **a path to the accessibility snapshot**
written on arrival — a path rather than the snapshot itself, because a snapshot of a real page is
thousands of tokens and a caller usually wants one part of it.

Refused for an unknown tab, a closed tab, and any address that is not ordinary web traffic or a blank
page. **A local-file address is refused specifically**: it turns a browser lease into an arbitrary
read of the machine's filesystem, which no part of this contract intends to grant.

### 3.8 `browser_act`

Takes the key, a tab, one of ten actions, a reference to an element taken from a snapshot, and
sometimes a value. Returns a **fresh snapshot after every change**, because the caller's next element
reference has to come from the page as it is now — a stale reference is the most common cause of an
action landing on the wrong element.

Refused for an unknown or closed tab; for an action that is not one of the ten, **listing the ten**
(the discoverability cost of folding them into one tool is paid back here or not at all); for an
element reference that does not resolve, naming the snapshot it should have come from; and for a
missing value on the actions that need one.

### 3.9 `browser_read`

Takes the key, a tab, and which artefact: the accessibility snapshot, the console, the network log,
or a cookie summary. **Returns a path, its size, and whether it was truncated — never the contents.**
The caller searches the part it needs; a full snapshot or network log entering a conversation is paid
for once in money and on every later turn in context.

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

Refused for an unknown or closed tab, and for an expression past a size limit — a long expression is
a program, and a program wants a capability that is not on offer (§3.13). The distinction between
evaluating inside a page and running code inside the service is set out in `PLAN.md`.

> **❓ NEEDS YOUR INPUT — Evaluation on the signed-in browser (§3.10)**
>
> **The problem:** an expression evaluated inside a page can do what that page's own scripts can do,
> which includes reading that page's own stored data. On the signed-in browser, that means a lease
> can read the storage of a site the operator is signed in to. No rule can close that without
> breaking the feature, because a page's scripts reading their own storage is the platform working as
> designed.
>
> **Options:**
> - **Allow it on both browsers.** The position being taken: a lease on the signed-in browser already
>   grants the ability to *act as* the signed-in user — that is what the lease is for — so evaluation
>   widens nothing except what leaves a record, and every expression and the size of its result are
>   recorded.
> - **Allow it only on the private browser.** Closes the storage question completely. It also removes
>   the cheapest and most accurate measurement path from the browser where most stateful work
>   happens, which pushes callers toward screenshots — the expensive thing this design spends effort
>   discouraging.
> - **Allow it on both, but refuse expressions that touch the obvious storage accessors.** Rejected
>   rather than offered as a real option, and the reason is worth having: it stops nobody who is
>   trying, and it teaches a reader that the hole is closed. A rule that only stops the honest is
>   worse than no rule, because it is believed.
>
> **Recommendation: allow it on both.** The capability the lease already grants is strictly larger
> than the one being worried about, and the record is the mitigation that actually works.
>
> **What changes if you pick differently:** one rule and its refusal, plus a line in the tool
> description. No table changes. Reversible at any time.

### 3.11 `browser_capture`

| Argument | Type | Required | What it's for |
|---|---|---|---|
| `tab_id` | | yes | Which tab. |
| `tier` | `detail` or `max` | **no** | Absent means the cheapest resolution. **This is the lever**: most callers never pass an optional parameter, so a low default does nearly all the work of a ceiling without blocking anyone. There is deliberately no way to ask for the default explicitly — a caller writing it out is a caller who thought about resolution and should have said which. |
| `reason` | string, 8–200 characters | **only on the top tier** | Recorded. The only mechanism that produces data about *why* anyone escalates. |
| `full_page` | boolean | no, default off | Unbounded page height pushes an image over the expensive threshold far more often than width does. |
| `selector` | string | no | Capture one element. Cannot be combined with a full page. |
| `view` | string | no | The view's name, for later comparison. Without it a capture can be neither compared nor promoted. §1.8 says what a view name has to carry. |
| `mask` | list of rectangles | no | Areas to paint over before the picture is taken. Masking *before* the pixels exist beats filtering afterwards, because a region that was never captured cannot be reported as changed. |
| `label` | string | no | Becomes part of the file name, so a person reading the directory can tell one from another. Restricted to a safe character set and a length, and never treated as a path. |

**Every capture settles the page first.** Animations and transitions are stopped, the text caret is
hidden, and web fonts are waited for. This is one line of instruction to the automation tool and it
is the highest-value line in the comparison feature, because **without it the same page produces
different pixels run to run** — a fading banner, a transition mid-flight, a blinking caret, a spinner,
an image that arrived one frame later. No threshold fixes any of that: the colour tolerance in §1.8
is a per-pixel comparison and has nothing to say about something that moved. A comparison feature
that reports a change on every run of an unchanged page either burns the tokens it exists to save or
teaches its callers to ignore it, and both are worse than not having it.

**A capture that names a view with a live baseline is taken at the baseline's geometry**, whatever
tier was asked for, and the response says so. Otherwise a picture at one size gets compared against a
picture at another, and a comparison handed two different sizes either fails with an unexplained
error or compares the overlapping corner and calls everything else changed — a wrong answer that
looks exactly like a right one.

**What comes back:** a path, the dimensions written, the dimensions before shrinking, the file size,
the tier, an estimated token cost, how many captures this lease has taken, and a warning or nothing.
**Never the image.** The caller opens the file only when it genuinely needs to *look*.

**Nothing is ever refused on cost grounds.** Past a threshold, every capture is still served **and**
carries a warning — and the warning names the cheaper operation that answers the same question:
*"if you are reading a value, a snapshot or an evaluation returns it as text for a fraction of this."*
A bare "you have taken a lot of captures" teaches a caller to ask for a bigger budget; naming the
alternative teaches the thing the policy exists to teach. And the warning appears on **every** capture
past the threshold rather than only the first, because a warning that appears once has scrolled away
by the time it matters.

The only refusals are argument mistakes: an unknown or closed tab, the top tier without a reason, and
a selector combined with a full page.

> **❓ NEEDS YOUR INPUT — On the top capture tier, free-text reason or a fixed set? (§3.11)**
>
> **The problem:** the reason is the only instrument that will ever say why callers escalate
> resolution, and the study that settles the default rungs reads it. Free text captures things nobody
> anticipated; a fixed set produces data that can be counted.
>
> **Options:**
> - **Free text.** Reads back what callers actually say, including the reason nobody predicted. The
>   risk is that it fills up with *"needed the detail"* and says nothing, at which point the study has
>   an instrument that measured nothing.
> - **A fixed set of three or four.** Countable immediately, and it makes the escalation a moment of
>   thought rather than a string. It can only ever record the reasons somebody guessed in advance.
> - **Both — a fixed set plus an optional note.** Countable and open. Two fields on the one call the
>   design is trying to keep cheap, and the note tends to go unused once a box has been ticked.
>
> **Recommendation: free text for the first version, and read it after a few weeks.** The fixed set
> is a better instrument, and it can only be written well by somebody who has read a few hundred
> real answers first.
>
> **What changes if you pick differently:** the validation on one argument, and one column's type.
> The rows already collected stay readable either way.

### 3.12 `browser_compare`

Takes the key and a capture, optionally overriding which view and breakpoint to compare against, and
— pending the ruling in §1.8 — an explicit instruction for the case where no baseline exists.
**What comes back is §1.9** — crops of what changed, an outlined overlay, and the numbers.

Refused when no live baseline exists for that view and breakpoint, naming the operation that would
create one. **That refusal is on purpose:** a comparison that quietly returns "nothing changed" on a
first run is indistinguishable from one that worked, and it would make the feature silently useless
exactly where it is least expected to be. Also refused when the capture belongs to another lease
(same non-disclosing wording as an unknown tab), when the capture was never given a view name, when
the capture and the baseline **do not match in geometry** or came from different browsers, kinds or
elements, and when the baseline's own image is missing from disk.

**On a full page, the height is allowed to differ.** Two full-page pictures of one view legitimately
differ in height when the content gets longer, so the width must match exactly and the height need
not; the change in page length is reported as its own fact rather than as a region, and the
comparison runs over the height they share.

### 3.13 Deliberately absent — this list is part of the contract

| Not offered | Why |
|---|---|
| **Closing, restarting or deleting a browser; closing every tab; deleting profile data** | Browser-wide and destructive. With browsers shared between callers, one caller would end every other caller's work, and on the signed-in profile it destroys a session a person restores by hand |
| **Attaching to a browser this service did not launch** | It reaches a process outside the service's control. This cannot be checked at the tool layer, because attaching creates a *new* automation session pointed at a foreign process — so the guarantee rests on the operation not existing and on the automation binary being unreachable |
| **Running code inside the service itself** | A different capability from evaluating inside a page: the service's own process, its filesystem and its network. Nothing needs it and everything is reachable through it |
| **Saving or loading whole storage state; setting a cookie; writing local storage** | Credential export and credential injection on a shared signed-in profile. The read side is already limited to names and flags |
| **Any notion of a "current tab"** | Every operation names its tab. A shared implicit cursor is a bug class, not a convenience: one caller navigates and another caller's page — possibly the one holding the sign-in — is silently gone, with no error and nothing in the record to say what happened. With no current tab there is nothing to mis-target |
| **Bringing a tab to the front** | The service is not the thing that decides what a person is looking at, and moving the foreground is the one action that would make it so. It is also unnecessary: background tabs accept every operation and screenshot correctly |
| **Promoting, retiring or listing baselines** | Not absent from the product — absent from the *agent's* surface. They are decisions a person takes, and they live on the operations surface, where every session does not pay for their descriptions on every turn |
| **A raw escape hatch to the underlying tool "for advanced use"** | The first two rows wearing a friendlier name. If an operation is needed it becomes a real operation, with a rule and a record |

### 3.14 What a refusal looks like

Every refusal carries a **stable code** the caller matches on, the **name of the rule** that refused
(§7), a human sentence, and any details. The code and the rule name are identical on every surface;
the sentence is deliberately worded differently for a terminal and for a tool result, and is never
compared between them — asserting text is brittle and a weaker claim than asserting the code.

**Every refusal names the way forward**, because the alternative teaches a caller to satisfy the
check rather than to do the right thing. Over-budget names the budget and the largest request that
would fit. A session that already holds a lease is told which one and when it expires. A lease at its
grant is told to close a tab. The capture warning names the two cheaper operations.

---

## 4. The web interface

### 4.1 Two classes of caller, and only one has a credential

- **Keyed** — the lease's own secret key. Everything a lease does.
- **Operations** — everything else, including revoking somebody's lease. **No credential.**

**What makes that defensible is the address the server binds to**, which defaults to the local
machine only, so by default nothing off the machine can reach it. Binding it wider is allowed — a
person may genuinely want the operations page from another machine — and **the service warns loudly
at every startup** when it is, naming exactly what is exposed: an unauthenticated revoke, an
unauthenticated settings write, and a page listing what everything is doing.

It warns rather than refusing, which is the same posture as the capture policy and for the same
reason: **a service that is occasionally noisy survives; one that is occasionally unusable gets
routed around.** Refusing to start would strand a legitimate installation on a decision the service is
not entitled to take.

> **❓ NEEDS YOUR INPUT — Does the operations surface stay unauthenticated off the local machine? (§4.1)**
>
> **The problem:** the operations endpoints can revoke a lease and change a setting. On the local
> machine that is fine — anything that can reach them can already do worse. Bound wider, they are an
> unauthenticated write surface on whatever network the machine is on.
>
> **Options:**
> - **Warn loudly and serve anyway.** No credential to manage, no user model, no lockout. The warning
>   is on every startup and cannot be switched off, because a warning you can turn off is a warning
>   nobody sees.
> - **Require a shared token from the environment when bound wider.** Small — one value, one header
>   check. It is also a user model arriving one field at a time, and one field at a time is exactly
>   how one arrives.
> - **Refuse to bind wider at all.** Simplest and safest. It also decides, on the operator's behalf,
>   that they may not look at their own operations page from a laptop.
>
> **Recommendation: warn and serve.** The default keeps it local, and an operator who deliberately
> changes that has made a decision this service should not overrule.
>
> **What changes if you pick differently:** one environment variable and one check in the request
> path. No table changes. It can be added later without disturbing anything.

### 4.2 What each endpoint does

**Every endpoint is a thin shell over one service operation**, and the mapping to §3 is one-to-one for
everything an agent can do — which is asserted rather than assumed (§8).

| What it does | Notes |
|---|---|
| Request a lease | Answers differently for granted and for queued, so a caller can branch without reading the body |
| Read your lease · release it | Reading **extends the lease**. A read having an effect is a deliberate exception: the alternative is a keyed call that does not extend, which is a hole in the one rule liveness rests on |
| Open a tab · close a tab | Inside your own grant |
| Navigate · act · read · evaluate · capture · compare | The §3 operations, one endpoint each |
| The whole picture in one document | Both browsers with their state and restart count; the budget and its use; every live lease with its session, browser, tab count, purpose, state and expiry; the queue depth and the front caller's wait. **This is what the operations page reads**, and it is designed so another system could fetch the same document as a read-only panel without anything here changing |
| List leases, live or finished · one lease with its tabs and its record | **Never the key hash** |
| Revoke a lease | Requires a reason |
| A slice of the record | Never the whole thing. Takes a cursor and returns the next one |
| Capture rows with their dimensions, tier, reason and estimated cost | What the resolution study reads |
| **Comparison rows**, filtered by view, baseline or lease | What threshold tuning reads. A table whose whole justification is being read has to have something that reads it, or it is write-only and the justification is theoretical |
| **The bytes of a stored artifact**, subject to the ruling in §1.9 | Without it, a caller that is not on this machine can be handed a path it cannot open |
| Health | Reports **unhealthy when either browser is not running**, because a service that cannot grant a lease is not healthy however well the process is doing |

**The tab identifier a caller sees is never the automation tool's own**, on any endpoint, so there is
no second way to name a tab.

### 4.3 Baselines — a person's surface, not an agent's

List them, promote a capture or a file to be one, tune a baseline's own thresholds, and retire one.
**Retiring never deletes** — a comparison recorded against a baseline has to keep naming something
real. Promoting retires the live baseline for that view in the same breath, so there is never a
moment with two.

**Promoting requires a reason, copies the image**, and refuses when the capture's file has already
been swept by retention — rows live forever and files do not, so a caller can legitimately hold the
identifier of a capture whose bytes are gone, and that has to be a named refusal rather than a
missing file discovered later.

### 4.4 Settings

Read every declared key with its value, whether that value is a default or an override, its type, its
label, its help text and when a change takes effect. Write several keys at once — **one human act on
a settings page is one act**, so it is one change, one revision, and one record entry per key sharing
a batch. Clear one override and it returns to what the code says.

**Three answers to "when does this take effect", declared per key:** immediately (thresholds, the
sweep interval, the resolution rungs), on the next lease (the budget and the durations — a change
must not retroactively shorten a lease a caller was already promised), or on restart.

### 4.5 The operations page

**One static page, no framework, no build step.** It fetches the one status document and renders it,
refreshing on an interval. It shows both browsers with their state and restart count, the budget and
its use, every live lease with its purpose and expiry, the queue with positions and waits, and the
most recent entries in the record.

**Read-only: no controls, no sign-in, no forms.** Revoking is deliberately absent from the page even
though the operation exists, because a button that can end somebody's work is exactly the kind of
thing that wants an actor recorded, and there is no user model here to record one.

---

## 5. The command line

### 5.1 Shape

`broker <noun> <verb>`, plus a few single-word commands that name one thing each.

**The command line is a full route in, and it is worth building even if no agent ever calls it.** It
is the cheapest available proof that the rules live in one place rather than inside a tool handler —
a rule inside a handler is a rule that holds on one route and nowhere else.

### 5.2 With a server, or without one

Point it at a running server and the commands call it. Point it at a database instead and they run
the service's own logic in process. One set of commands sits above both.

**In process is not "no service".** The sweep, the expiry and the browser work all live in the
service layer, so a command running in process will do sweep work if it finds lapsed leases — which
is correct, and is said here because it is surprising the first time a listing command closes
somebody's tabs.

### 5.3 The commands that mirror an operation

Every §3 operation has one, so parity is real rather than claimed: `claim`, `status`, `release`,
`tab open`, `tab close`, `navigate`, `act`, `read`, `evaluate`, `capture`, `compare`.

**`broker claim --wait` is the command line's answer to the keep-calling-in protocol**, and it is the
one place this route does something the tool surface does not. It polls at half the queue's duration
until the lease becomes active or the place is lost — which is exactly what a queued caller is
supposed to do and is tedious to write in a shell. It calls the same operation on every poll and adds
none of its own.

### 5.4 The operations commands

List leases · revoke one with a reason · show the browsers · read the record · list captures · **list
comparisons** · list, promote, retire and tune baselines · get, set, clear and list settings.

### 5.5 The commands that have no operation behind them

Each carries a **written waiver** in the parity suite rather than being quietly absent from it.

| Command | What it does |
|---|---|
| `broker serve` | Runs the service: migrate, reconcile (§2.6), launch both browsers, listen |
| `broker doctor` | Every precondition, reported separately: database reachable · schema at the right version · automation tool present, and its version · artifact and profile roots writable · the startup capture check · whether the bind address is local. Exits with a distinct code on any failure, so it is usable as a readiness check |
| `broker login <browser>` | The one time a person drives — §5.5.1 |
| `broker init` | The setup handshake (§1.2a): find or accept a database, migrate, create what is absent, prove it with a round trip. **Every other command checks first** and stops with "run `broker init`", because a half-configured installation that behaves like a working one is the worst available outcome |

#### 5.5.1 `broker login` — the one time a person drives

Every browser the service runs is headless: roughly an order of magnitude faster to drive, identical
in memory, and nothing about a review needs a window. **Signing in is the one thing a person has to
do, and it needs a window.**

It goes through the service, and in this order:

1. **Refuses if any live lease holds tabs on that browser**, naming them. The sequence stops the
   browser, and stopping it would destroy work the service has promised to somebody. That refusal is
   why signing in is a service operation and not something a person does to the process by hand.
2. Puts the browser into its signing-in state. From that moment, requests for it are refused with a
   retry hint. **Queued callers keep their places and their timers**, because a sign-in is a pause and
   not a cancellation.
3. Stops the browser and relaunches it with a window, against **the same profile directory**.
4. On the person's confirmation, stops it and relaunches it headless against that same directory.
5. Back to running; the queue is swept.

**Why the same directory rather than a separate sign-in profile:** everything a sign-in produces is
written into the profile, and a persistent profile carries all of it between a windowed and a
headless launch in both directions. A separate directory would need the state copied across, which is
the credential-export operation this contract does not have.

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

### 5.7 What actually needs a server

Only the operations page. Every other surface has a substitute: the tool surface over the other
transport, the operations commands in process, and configuration through the command line, which
renders the same declarations the web interface does.

---

## 6. Configuration

### 6.1 The one question that decides where a value lives

> **What must be known before the process can reach the database?**

That, and only that, is an environment variable. Everything read after that point comes from a
database that is already reachable — so it is a setting: typed, validated, explained and recorded.
Anything describing what this *build is*, rather than how it is configured, is a constant.

| Variable | What it's for |
|---|---|
| `DATABASE_URL` | The database. The one value nothing else can be read without |
| `BROKER_BIND` · `BROKER_PORT` | Where the server listens. Defaults to the local machine only |
| `BROKER_ARTIFACTS_ROOT` | Where files are written (§1.7a). Defaults to a directory of the service's own under the per-user application-data location the platform defines |
| `BROKER_PROFILE_ROOT` | Where the two browser profiles live. Each browser launches against this plus its own name, explicitly — **never a default profile location** |
| `BROKER_URL` | Where a server is, if there is one. Present, and the command line calls it; absent, and it runs in process |
| `BROKER_SESSION_ID` | The identity a command acts as. Exported by whatever launches a session, never typed by hand |
| `BROKER_KEY` | The lease key. Never printed by any command |

**Why the addresses and the two roots are environment variables when the rule would make them
settings.** They belong to the machine rather than to the application, and — the stronger reason — **a
bad value stored in the database could only be fixed through the surface that the bad value broke.** A
configuration mistake that locks you out of the configuration surface is a category of failure worth
designing out rather than documenting.

### 6.2 What can be tuned without a restart

**Every setting is declared in code** with its type, default, label, help text and when a change takes
effect. **The database stores overrides only**, so a fresh database boots fully working.

| Setting | Default | Takes effect | What it's for |
|---|---|---|---|
| Tab budget | **15** | next lease | Total tabs across **both** browsers. There is no per-browser cap: the scarce thing is page processes and one costs the same in either browser. **Provisional** — reasoned from roughly 50–150 MB per idle page process plus two browser processes, so fifteen is one to two gigabytes |
| Most tabs one lease may hold | **4** | next lease | Stops a single caller legally taking the whole budget. **Provisional, and the weakest number here** |
| How long an active lease lives | **10 minutes** | next lease | Long, because expiring an active holder destroys work in progress |
| How long a queue place lives | **5 minutes** | next lease | Shorter, because expiring a waiting caller costs it a place it can retake |
| How often the sweep runs | **15 seconds** | immediately | Against a five-minute floor on any expiry, the worst-case delay in returning capacity is around 5% of the shortest lease |
| Grace after a disconnect | **60 seconds** | immediately | Used only where the transport says a client went away. Where it does not, this is inert and the operations page says so |
| Headless | **on** | restart | Roughly an order of magnitude faster to drive at identical memory. Signing in is the one windowed path and does not read this |
| Restart backoff · maximum restarts | **5 s · 5** | immediately | After the maximum, the browser is failed and requests for it are refused. It does not retry forever, because a browser that has failed five times is failing for a reason a retry will not fix |
| The three resolution rungs | **1024 · 1568 · 2576 px** on the long edge | immediately | What a capture is shrunk to. **Provisional** — a study exists to settle them with evidence. ⚠️ **Changing a rung invalidates every baseline made at it**, because a comparison runs at the baseline's geometry (§1.8). Baselines have to be re-blessed after a change, and the study that settles these numbers is scheduled to trigger exactly that |
| Full page by default | **off** | immediately | Unbounded page height crosses the expensive threshold more often than width does |
| Captures per lease before warning | **12** | immediately | Roughly a five-view sweep at two breakpoints plus slack. **Never a refusal** |
| Inline result cap · expression size cap | **4 KB · 8 KB** | immediately | Past the first, a result spills to a path; past the second, an expression is refused |
| Starting colour tolerance · smallest change reported · most regions returned | **0.1 · 64 px² · 12** | next baseline / immediately | The tolerance is the diff library's own default, which is a better starting position than a number invented here precisely because it is not one. The size filter is on **area with a thin-line allowance**, so a one-pixel line across a page survives it (§1.8). Past the region cap the result is truncated, smallest first, and says so |
| How far apart two changes stay separate · padding on a crop | **8 px · 16 px** | immediately | The first decides whether two nearby changes are reported as one region or two; the second is context around a crop, because a tight box with nothing around it can be genuinely unidentifiable |
| How much of an address is stored | **the site only** | immediately | §1.4 |
| How long capture files are kept | **14 days** | immediately | Deletes **files**. The rows are never deleted, so the dimensions, tiers, reasons and estimates the study needs survive a disk that does not. **Baseline files are exempt** (§1.8) |
| How long crop files are kept | **7 days** | immediately | A crop's value expires when the review turn ends. Bytes are not the risk — a page's worth of crops is small — but up to twelve files per comparison with nothing pruning them is hundreds of thousands of files a year |
| How long the record is kept | **forever** | immediately | Trimming it is possible and is not the default |

**Settings that are deliberately absent**, because each would be a position this design has already
taken and a setting is how a position quietly gets reversed:

- **No "refuse captures after N".** Nothing is ever refused on capture grounds, and a setting that
  could turn a warning into a wall would make that promise conditional.
- **No per-browser budget.** One counter, on purpose.
- **No browser count and no third-browser flag.** Exactly two, no exceptions, ever.
- **No switch that silences the off-machine warning.** A warning you can turn off is a warning nobody
  sees.

### 6.3 When the code and the stored value disagree, the code wins and says so

| Situation | What happens |
|---|---|
| An override exists and is valid | It is used |
| An override exists and fails its type, because the type tightened | **The default is used**, the key is reported at startup, and the settings view shows the stored value beside the error. Not a startup failure — refusing to start because a bound moved turns a configuration nit into an outage. Not silently corrected either: a corrected value is one nobody chose |
| An override exists for a key the code does not declare | The row is inert, listed as unrecognised, and never deleted |
| A default changes between versions | Every installation that never overrode that key changes behaviour on upgrade. **That is a behaviour change and is treated as one** — it belongs in release notes, not in a change nobody reads |

**One snapshot of the configuration per call**, resolved at the start and used throughout, so every
rule inside one operation sees one configuration. A long-running process re-checks for changes every
few seconds, so the guarantee is explicit and small: a change is visible immediately where it was
made, and within seconds everywhere else.

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
| `key.present` | Every operation except requesting a lease carries a key | key missing |
| `key.valid` | The key matches a lease | unrecognised key |
| `claim.live` | That lease is queued or active | lease has ended, naming the state and when |
| `claim.session_single` | A session has at most one live lease | session already holds a lease, naming its id, state and expiry |
| `claim.browser_known` | The browser named is one of the two | unknown browser |
| `claim.per_claim_cap` | The request is within the per-lease cap | too many tabs for one lease |
| `claim.within_budget` | The request is within the whole budget | more tabs than exist. **Refused, never queued** — a request that can never be granted must not wait for something that will not happen |
| `capacity.admission` | Tabs in use plus tabs requested is within the budget | **Not a refusal.** This is the test that decides granted against queued — the one rule whose failure is a successful outcome (§2.3) |
| `tab.owned` | The tab belongs to this lease | tab not found — **the same refusal as an unknown tab**, so probing cannot discover another lease's tabs |
| `tab.open` | The tab is open | tab not open |
| `grant.available` | Opening a tab stays within the grant | grant exhausted, naming the count, the grant, and how to close one |
| `browser.serving` | The browser is running | browser unavailable, with a retry hint. Covers signing-in, failed, starting and stopped |
| `browser.busy_for_login` | Signing in is refused while any live lease holds tabs on that browser | browser busy, naming the leases |
| `navigate.scheme_allowed` | Ordinary web traffic or a blank page | invalid address. **A local-file address is refused explicitly**: it turns a browser lease into an arbitrary read of the machine's filesystem |
| `capture.max_tier_reason` | The top tier carries a reason | reason required. **The only capture refusal about anything other than a malformed argument, and it is about recording rather than about cost** |
| `capture.exclusive_mode` | A selector and a full page are not both asked for | cannot do both |
| `evaluate.expression_bounded` | The expression is within its size cap | expression too long |
| `compare.baseline_exists` | A live baseline exists for that view, browser, kind and breakpoint | no baseline, naming how to bless one. **A refusal on purpose**: silently reporting "nothing changed" with nothing to compare against is indistinguishable from working |
| `compare.geometry_match` | The capture and the baseline are the same width, and the same kind, browser and element | geometry mismatch, naming both sizes and how to fix it. Handed two different sizes, a differ either fails without explaining itself or compares the overlapping corner and calls the rest changed — a wrong answer that looks exactly like a right one |
| `compare.baseline_file_present` | The baseline's image is on disk | baseline image missing. Reachable only if something outside the service removed it, since baseline files are exempt from retention |
| `compare.capture_owned` | The capture belongs to this lease | capture not found, non-disclosing, same shape as an unknown tab |
| `baseline.promote_reason_required` | Blessing a baseline carries a reason | reason required. Everything compared against a baseline inherits whatever it contains, so it is a longer-lived commitment than a lease's purpose or a revoke's reason |
| `baseline.source_file_present` | The capture being blessed still has its file | capture file swept. Rows outlive files, so a caller can hold a valid identifier for bytes that are gone |
| `capture.page_settled` | Animations stopped, caret hidden, fonts waited for, before every picture | **Not a refusal — a shape.** Without it the same page produces different pixels run to run, and no colour tolerance can address something that moved (§3.11) |
| `capture.label_safe` | A caller's label is within a safe character set and length, and is never treated as a path | invalid label. The same reasoning that refuses a local-file address |
| `revoke.reason_required` | A revoke carries a reason | reason required |
| `read.cookies_no_values` | A cookie read returns names, domains, paths, expiries and flags | **Not a refusal — a shape.** The value field is absent, not masked |

### 7.2 Checked at startup — the service refuses to serve

Each of these guards a failure that is **silent**: the operation succeeds and returns something wrong.

| Rule | What it requires | On failure |
|---|---|---|
| `launch.explicit_profile_dir` | Every browser launches with an explicit profile directory the service owns. **Never a default profile location** | Refuse to launch. A default location is shared with anything else that also takes the default, and two processes on one profile contend on its lock file — so an unrelated run that started first would stop this service starting at all |
| `launch.default_args_intact` | The launch settings are the automation library's defaults **plus** what this service adds — never its defaults minus anything | Refuse to launch. Those defaults include what keeps background tabs running at full speed and what makes capturing them work; removing them is how a service becomes mysteriously slow and mysteriously wrong at once |
| `launch.capture_surface` | The browser is launched with the setting that makes screenshots capture the right tab | Refuse to serve; the browser never reaches running. Without it, capturing a background tab can return **another tab's pixels** with no error — which is why this is a refusal to start rather than a warning |
| `startup.reconcile_before_serve` | The restart check (§2.6) finishes before anything is accepted | Refuse to serve. Serving against an unreconciled count either refuses work for no reason or overshoots the budget, and only one of those is loud |
| `startup.migrations_applied` | The schema is at the version this build expects | Refuse to serve, naming the gap |
| `setup.profile_never_destroyed` | Setup creates a profile that is absent and uses one that is present | Refuse to launch rather than recreate. A recreated profile is a person silently signed out (§1.2a) |

### 7.3 Checked by the build — the service refuses to ship

Three prohibitions cannot be checked at run time, because the correct behaviour is that the call
**never happens**, and a rule with no call site is not a rule.

| Rule | What it requires |
|---|---|
| `foreground.never_moved` | **The service never brings a tab to the front.** It is the only action that would move what a person is looking at, and background tabs accept every operation and capture correctly without it |
| `capture.surface_required` | **No capture is ever taken with the correct-surface setting disabled.** In a windowed browser it returns another tab's pixels, with no error — a wrong answer that looks exactly like a right one |
| `browser_scoped.never` | **No operation is browser-wide and destructive**, on any surface. Adding one fails the build rather than the review |
| `driver.import_isolated` · `db.import_isolated` | Only the browser module reaches the automation library, and only the service layer reaches the database. If a surface cannot reach the database except through a service, it cannot bypass a rule — not because it was reviewed carefully, but because it will not build |
| `settings.no_secrets` | No setting is credential-shaped. Settings are readable without authentication and printed by the command line, so a value that would be unsafe to read aloud is in the wrong place |
| `capture.never_refused_for_cost` | **No path refuses a capture for budget or resolution reasons.** This one asserts an absence, and it is what makes the "never a refusal" promise checkable |

How each is enforced is in `MILESTONES.md`.

### 7.4 The one that is only a warning, and stays one

Binding the server off the local machine publishes an unauthenticated revoke, an unauthenticated
settings write, and a page describing everything in flight. The service **warns loudly at every
startup** and serves anyway (§4.1). It is listed here rather than left out, because a warning that is
not in the list of rules is a warning nobody maintains.

---

## 8. The same rules through every door

Every route in — the tool surface over either transport, the web interface, and the command line on
either binding — is a thin shell over one service call. **That is a claim, and there is a suite that
makes it true rather than intended**, because the failure it guards against is silent: a rule
implemented inside one route is enforced for that route's callers and for nobody else, and nothing
reports it.

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

How the suite is built, and the deliberately-failing controls that prove each assertion can fail, are
in `MILESTONES.md`.

---

## 9. Open, and deliberately so

### 9.1 The eleven that need you

They are indexed at the top of this document and written out where their subject is discussed. In
short: whether file names carry a version (§1.7a) · **who creates the first baseline (§1.8), which is
the one that decides whether your own worked example works** · how crop images reach a caller off
this machine (§1.9) · whether settings live in the database (§1.10) · how the "one live X" rules are
enforced (§1.11) · how much of a page address is stored (§1.4) · strict queue order against
skip-ahead (§2.5) · evaluating inside a page on the signed-in browser (§3.10) · free text or a fixed
set for a capture escalation reason (§3.11) · whether the operations surface stays unauthenticated
off the machine (§4.1).

The eleventh has no natural home in a section and sits here: **the licence.** It is not a build's to
choose, and it has to be settled before anything is published — a public repository with no licence
file grants its readers no rights at all, which is almost never what publishing was for.

### 9.1a Judged, deferred, and named so it is not discovered

- **Masking known-volatile areas is deferred, and the column is not.** A carousel, a video, an
  advertisement slot or a live timestamp legitimately differs on every load and produces a large,
  correctly-detected change every time. The size filter removes *small* regions; nothing removes
  *known-volatile* ones. The first version ships without the feature, and the column ships with the
  first migration anyway (§1.8), because the schema arrives as one baseline and a column left out now
  costs a migration later for something already known to be wanted. The capture-time mask (§3.11) is
  the part that does ship, and it is the better half: an area that was never captured cannot be
  reported.
- **Comparison is a second-visit feature and cannot be a silent default.** With no baseline there is
  nothing to compare, and that stays a refusal.
- **Whether an off-the-shelf tool already does the comparison half of this** is a research question
  that no document here answers. It is worth answering before the comparison work starts, because it
  is the one part of this design that is not arbitration.

### 9.2 Where this document changes an earlier decision

Each is a change rather than a clarification, and is listed so nobody reconciles them by accident.

| | |
|---|---|
| **"One live lease per tab" is not a uniqueness rule at all** | It is structural: a tab's lease is set once and never changes, so a tab has exactly one owner by construction. Two *other* rules need the filtered-uniqueness treatment instead, plus the baseline rule (§1.11) |
| **There is no renew operation** | Every call carrying the key extends the lease, so a dedicated verb would be a second name for one effect (§3.1) |
| **Capacity is counted over tab rows, not over what leases asked for** | The tab rows exist from the moment a lease is granted, so a grant and its rows are the same number and the budget cannot be overshot by a lease that has not opened its tabs yet (§2.3) |
| **Eleven tools, not ten** | `browser_compare` is the marginal one, and its condition is that it stays one operation with baseline management on the operations surface (§3.1) |
| **The capture warning fires on every capture past the threshold, not once** | A warning that appears once has scrolled away by the time it matters (§3.11) |
| **A comparisons table exists** that the outline did not list, justified by threshold tuning being unanswerable without one (§1.9) |
| **The artifact root and the profile root are environment variables, not settings** | A path that must exist before anything runs, and whose bad value would break the surface used to fix it (§6.1) |
| **Files are organised by lease first and kind second** | One folder per lease, subfolders by kind, and baselines outside it because they outlive every lease. An earlier draft grouped by kind first, which scatters one lease's output across four places and makes deleting a finished lease a four-directory operation (§1.7a) |
| **A view's identity is view name, browser, kind and breakpoint** | A picture from the signed-in browser and one from the clean browser are different pages, and a viewport picture and a full-page picture are different images. An identity of name-and-width alone compares them silently (§1.8) |
| **A comparison runs at the baseline's geometry, and refuses a mismatch** | Two images of different sizes handed to a differ produce a wrong answer that looks like a right one (§1.8, §3.11) |
| **Blessing a baseline copies the image, and baseline files are exempt from capture retention** | The other reading is silent data loss on a two-week fuse (§1.8) |
| **Every capture settles the page before the shutter** | Animations, caret and fonts. No colour tolerance can address something that moved, so without this the feature reports a change on every run forever (§3.11) |
| **The size filter is on area with a thin-line allowance, not on the shorter side of the box** | A one-pixel line across a wide page has a shorter side of one, and filtering on it discards exactly the small-but-real changes the feature has to prove it does not swallow (§1.8) |
| **Twelve columns are gone as derivable** | The audit is §1.12 |

### 9.3 Numbers that are provisional, and what settles each

| Number | Settled by |
|---|---|
| The three resolution rungs | The resolution study. Expect **more than one threshold**: text stops being legible before layout critique stops working, so the useful ceiling is the lowest rung that still passes the checks that matter |
| The tab budget | Watching real memory at real concurrency. The reasoning is 50–150 MB per idle page process plus two browser processes; the measurement turns that into a number |
| The per-lease tab cap | The weakest number in the document. Settled by how many tabs a review actually uses, which the lease rows will say within a week of real traffic |
| Captures per lease before a warning | The capture rows |
| The starting colour tolerance, and the smallest change reported | A fixture set whose negative direction is the one that matters: a change small enough to be interesting must survive the filters in force. Thin lines, border widths, focus rings and underlines are the cases to build it from |
| The two lease durations | Whether real callers call in often enough, which the renewal count is what says |

### 9.4 One thing to verify before the browser layer is trusted

**The concurrency properties this design rests on were proved against the automation *library*** —
that background tabs accept every operation, that capturing never moves the foreground, that fifteen
concurrent tabs neither serialise nor contaminate each other. **The service reaches those properties
through a command-line tool layered over that library**, and a layer can add a foreground move or
change a launch setting without saying so.

Two of the startup rules (§7.2) check that the settings survived the indirection, and one build check
(§7.3) checks that this service does not add a foreground move. **Neither covers the case where the
tool itself moves the foreground on some operation nobody has exercised yet**, so one empirical check
is owed on the real thing: drive a background tab through a navigation, an action and a capture, and
assert the foreground has not moved. That is a test, not a code read, and it is the last place a
proved property can quietly stop being true.
