# Browser Broker — the concrete shape

Companion to `PLAN.md` (how it works, in prose) and `DECISIONS.md` (why, including what was
rejected). This is the concrete shape of everything a human or an agent will ever touch: every table,
every lease transition, every tool, endpoint and command, every setting, and every guard with the
refusal it produces.

**Status: draft for review. Nothing is built.** Types are Postgres. Where a number appears it is a
number somebody reasoned to, and the reasoning is beside it so it can be argued with rather than
inherited.

**The rule this document is held to: if a reader cannot disagree with it, it is not specific enough.**
"The claim table records the lease" is not a specification. A column, its type, its nullability, what
it is *for*, and what breaks if it is missing — that is one. Sections are numbered so a review
comment can cite `§3.4` rather than "the bit about the queue".

**Where this document and `PLAN.md` disagree, this one is later and wins**, and every such place is
listed in §9.2 rather than left for someone to trip over.

---

## 1. Tables

### 1.1 Conventions

- **Types are Postgres.** Prisma is the client and the migration tool; the schema lands as one SQL
  baseline (`MILESTONES.md` #7) and changes additively after that. Three constructions this schema
  wants cannot be expressed in a Prisma schema file at all — partial indexes, partial unique indexes
  and check constraints — and §1.11 is where that is faced rather than discovered.
- **Time is `timestamptz`, and the clock is the database's.** Every expiry comparison is against the
  database's `now()`, never a process clock. The command-line adapter can run the service layer
  in-process (§5.2), so there is more than one process, and two clocks a second apart make an expiry
  non-deterministic in a way nothing will ever reproduce.
- **Identifiers.** `browsers.id` is one of two known strings because callers type it. Everything else
  is a `uuid`, except `events.id`, which is a `bigserial` because it doubles as a cursor.
- **Nothing is deleted by ordinary operation.** Terminal rows are kept: they are the record. Only
  retention (§6.2) removes anything, and what it removes is files on disk rather than rows.
- **`created_at` / `updated_at` are on every table** and are not repeated in the column tables below.
  `updated_at` is bumped by every mutation in the same transaction as the `events` row it produces,
  so the two cannot drift.

### 1.2 `browsers` — a fixed two-row table

Exactly two rows, always: the regular browser (persistent, signed in) and the private one
(ephemeral). Not a collection, no third row, no profiles table and no named-profile concept
(`DECISIONS.md` §6).

| Column | Type | Null | For |
|---|---|---|---|
| `id` | `text` PK | no | `regular` or `private`, and nothing else — a `CHECK (id IN ('regular','private'))` makes that a database fact rather than a convention. Callers type this value, so an opaque key would mean a lookup for something the caller already knows. |
| `persistent` | `boolean` | no | Whether the launch uses a persistent profile. `true` for regular, `false` for private. Read by the driver at launch and by the response field that warns about per-tab session storage. |
| `profile_dir` | `text` | yes | **The absolute directory this browser was actually launched with** — a record of what happened, not a configuration value. Resolved from `browser.profile_root` (§6.2) as `<root>/<id>`, written by the service at launch, null before the first launch. Recording it is what makes the explicit-profile requirement (`DECISIONS.md` §6a) auditable after the fact instead of only assertable at startup. |
| `state` | enum | no | `stopped` · `starting` · `running` · `login` · `failed`. Five values. `login` is the headed sign-in mode (§5.5) and exists as a state rather than a flag because claims are refused during it and a refusal wants a reason to name. |
| `pid` | `int` | yes | The process the service launched. **This is the outward-isolation fact**: the service acts on processes recorded here and on nothing else, and the boot reconciliation (§2.6) uses it to tell its own leftovers from a browser somebody else is using. Null when not running. |
| `launched_at` | `timestamptz` | yes | |
| `surface_verified` | `boolean` | no | Whether the startup screenshot-surface assertion passed for this launch (§7, `launch.screenshot_surface`). Default `false`. A browser with `false` here never reaches `running`. Stored rather than inferred because the failure it guards against is silent: captures succeed and return another tab's pixels. |
| `restart_count` | `int` | no | Restarts since the service started. A crash loop is invisible in `state`, which reads `running` between crashes. The operations page shows this next to `state` for exactly that reason. |
| `last_error` | `text` | yes | Why the last launch or exit failed. The only field that answers "why is this `failed`" without reading a log. |

**Indexes: the primary key, and nothing else.** Two rows means no other index would ever be chosen,
and an index that is never chosen is a write cost with no read benefit.

**How "exactly two" is enforced, precisely:** the `CHECK` bounds the domain to two values and the
primary key makes each unique, so *at most* two rows can exist; the baseline migration seeds both, so
*at least* two do. There is no create or delete operation for a browser on any surface (§3.13).

### 1.3 `claims` — the lease

One row per lease, live or historical. This is the entity the whole service is about.

| Column | Type | Null | For |
|---|---|---|---|
| `id` | `uuid` PK | no | The public identifier. Safe to log, to print, and to show on the operations page. Everything a human or an operator names a lease by. |
| `key_hash` | `text` | no | **The secret key is never stored.** This is `sha256(key)`, hex. Every keyed call hashes what it was handed and looks up by this column, so the unique index on it is the hottest read in the service. |
| `session_id` | `text` | no | The caller's session identity, supplied by the caller. What the one-live-claim-per-session rule is over, and what attributes a capture to whoever took it. **Not a foreign key and there is no sessions table** — session identity is a shared key this service does not own (`PLAN.md`, "Composing with a work tracker"), so a constraint here would mean inventing a registry for something another system mints. |
| `browser_id` | `text` → `browsers.id` | no | Which browser this lease's tabs live in. Chosen at claim time and **immutable**, because a tab cannot move between browser processes and a lease is a set of tabs. |
| `state` | enum | no | `queued` · `active` · `released` · `expired` · `revoked`. Five values, three terminal. §2. |
| `tabs_requested` | `smallint` | no | How many tabs this lease was granted. `CHECK (tabs_requested >= 1)`. This is the size of the reservation, and §2.3 makes the reservation and the tab rows the same thing so there is only ever one number to count. |
| `purpose` | `text` | no | One line, `CHECK (length between 3 and 200)`. **Mandatory.** It is the only human-readable answer the operations page can give to *"what is holding four tabs"*, and an optional one is empty on precisely the rows somebody is staring at. |
| `expires_at` | `timestamptz` | no | **One expiry column for both live states.** This is the uniform mechanism made concrete: one column, one reaper query, and only the *value* written into it differs by state (`lease.active_ttl_seconds` against `lease.queued_ttl_seconds`). Two columns would be two code paths for one rule. |
| `ttl_seconds` | `int` | no | The duration in force for this claim, snapshotted when the state was entered. Stored rather than read from settings on each renew, because a renew must extend by the duration the caller was **told** — re-reading a setting mid-lease silently changes a contract a caller has already acted on, and makes the reaper's arithmetic unauditable after the fact. |
| `activated_at` | `timestamptz` | yes | When the claim became `active`. Null while `queued`, and null forever on a claim that expired in the queue. With `created_at` this is what separates *"held for eleven minutes"* from *"waited eleven minutes"*, which are the two numbers on the operations page and mean opposite things. |
| `renewed_at` | `timestamptz` | yes | Last renew, implicit or otherwise. |
| `renew_count` | `int` | no | How many keyed calls have renewed this lease. What distinguishes a caller doing work from a caller polling to hold capacity it is not using — the one abuse the queue cannot otherwise see. **Nothing acts on it in the first version**; it is the data that would justify acting, and saying so is more honest than implying a policy that does not exist. |
| `ended_at` | `timestamptz` | yes | Set on entry to any terminal state. One column rather than three, because `state` already says which terminal it was. `CHECK ((state IN ('released','expired','revoked')) = (ended_at IS NOT NULL))`. |
| `revoke_reason` | `text` | yes | Required exactly when `state = 'revoked'`: `CHECK ((state = 'revoked') = (revoke_reason IS NOT NULL))`. An operator taking capacity off a caller owes a sentence, and the caller's next call is refused with it (§2.2). |

**No `queue_position` column.** Position is `count(*)` of queued claims created earlier, computed at
read time. Storing it means rewriting every row behind the head on every admission — a write
amplification on the hot path to save a count over a table with tens of live rows.

**No `captures_taken` counter.** It is `count(*)` over `captures` for the claim, which has an index
on `claim_id` and tens of rows. A denormalised counter buys nothing here and can drift; the threshold
at which it would earn its place is a claim taking captures in the thousands, which the accounting
warning (§3.11) exists to make unlikely.

**Indexes:**

| Index | Why it exists |
|---|---|
| `UNIQUE (key_hash)` | Every keyed call, which is every call that does anything. |
| `UNIQUE (id, browser_id)` | Not a query index — it is the target of the composite foreign key on `tabs` (§1.4) that stops a tab claiming a browser its own claim did not. Free, given `id` is already unique. |
| `(state, expires_at)` | The reaper's scan: everything live and past its expiry, in one index range. |
| `(state, created_at)` | Head-of-queue, in first-in-first-out order (§2.5). Separate from the reaper's index because they order by different columns, and a scan that has to sort is a scan that gets slower as history accumulates. |
| `(session_id, created_at DESC)` | A session's own history, which is what `broker claims --session` reads. Live rows are already covered by the partial unique index in §1.11; this one is for the rows that are not. |

**On index volume, honestly:** at a tab budget of 15 the live set is tens of rows, and none of these
indexes changes a measurable thing on it. They are there for the historical rows, which are the part
that grows without bound.

### 1.4 `tabs` — the unit of capacity and the unit of ownership

| Column | Type | Null | For |
|---|---|---|---|
| `id` | `uuid` PK | no | **The opaque tab identifier handed to callers.** Opaque so that holding one tells you nothing about the shape of any other — there is no index arithmetic to get wrong, which deletes the entire class of bug where an operation lands on a tab the caller did not mean. Note what it is *not*: it is not a secret and it is not the security boundary. Ownership is checked against the lease key on every call; the opacity is about eliminating addressing mistakes, not about guessing. |
| `claim_id` | `uuid` → `claims.id` | no | **The ownership fact.** Every tab-addressed guard is a comparison against this column. Immutable: a tab is created for one claim and closed with it, which is what makes "one active lease per tab" structural rather than a constraint anybody has to enforce (§1.11). |
| `browser_id` | `text` → `browsers.id` | no | Denormalised from the claim so a driver call reads one row. Kept honest by a composite foreign key `(claim_id, browser_id) REFERENCES claims (id, browser_id)`, so a tab cannot name a browser its own claim did not — which is not expressible as a `CHECK`, because a check cannot reach another table. |
| `driver_tab_id` | `text` | yes | Whatever the driver calls this tab. Null between the row being written and the open confirming (§2.3). **Never returned to a caller on any surface** — it is the driver's namespace, and exposing it would hand callers a second, non-opaque way to name a tab, which is the addressing bug arriving through a different door. |
| `state` | enum | no | `opening` · `open` · `closing` · `closed` · `failed`. `closing` is not ceremony: it is the honest representation of *"the driver was asked and has not answered"*, and it is what stops a renderer that may still exist being counted as free. |
| `opened_at` | `timestamptz` | yes | Set when `open` is confirmed. |
| `closed_at` | `timestamptz` | yes | Set when `closed` is confirmed — by the driver's answer, not by having asked. |
| `last_url` | `text` | yes | Where this tab is, at whatever resolution `privacy.store_urls` allows (§6.2): the full address, the origin only, or nothing. **This is the most sensitive column in the schema** — a browsing history is what it is — so its granularity is a setting rather than a decision the schema takes on the operator's behalf, and the default stores the origin only. |
| `close_attempts` | `int` | no | How many times a close has been asked for and not confirmed. What makes a tab stuck in `closing` visible instead of merely counted, and what the sweep escalates on. |

**Indexes:**

| Index | Why it exists |
|---|---|
| `(claim_id)` | The ownership check, and everything the reaper and release do. |
| `(id) WHERE state IN ('opening','open','closing')` | A partial index **whose predicate is the capacity predicate**, so the capacity count in §7 is an index-only scan over exactly the live rows and never touches history. |
| `UNIQUE (browser_id, driver_tab_id) WHERE state IN ('opening','open','closing')` | Two live rows must never point at one physical tab, or an operation for claim A lands on claim B's page — the exact contamination the design exists to prevent. Partial because a driver may recycle an identifier after a close, and a total unique index would then reject a legitimate new tab. |

**No `established_origin` column.** The per-tab session-storage caveat is reported as a field on the
response (`DECISIONS.md` §6), and a response field needs no storage. A column would imply the service
guards something it has decided not to pretend to guard.

### 1.5 The queue — a view over `claims`, not a table

**The queue is `claims WHERE state = 'queued'`, ordered by `(created_at, id)`.** No table, no row
movement, no second identity.

The reasoning is worth stating because the alternative looks tidier. A queue table would mean a
queued claim exists twice: once as a claim and once as a queue entry. Every transition then has to
keep both in step, and the moment they disagree the service has two answers to *"where am I"* and no
way to tell which is right. Admission is the single mutation `state: queued → active` on the row that
was already there, which is one write and cannot half-happen.

The `id` in the ordering is not decoration: two inserts inside the same millisecond share a
`created_at`, and an unstable sort makes the head of the queue flip between reads.

**Estimated wait** is reported by the queue-position response and is a genuinely weak number:
`ahead × median hold time over the last 20 completed claims`. It is labelled an estimate everywhere
it appears, and it is deliberately not derived from the time-to-live, because a lease that is renewed
runs far past its expiry and an estimate built on the expiry would be confidently wrong in the common
case rather than vaguely wrong in all of them.

### 1.6 `events` — append-only, one row per decision

**Allow and deny alike.** A record containing only refusals cannot answer *"was this guard ever
actually reached"*, which is the first question anybody asks the day something behaves oddly.

| Column | Type | Null | For |
|---|---|---|---|
| `id` | `bigserial` PK | no | Also the cursor for anything reading a slice. |
| `at` | `timestamptz` | no | |
| `kind` | enum | no | The operation attempted — see the list below. |
| `outcome` | enum | no | `allow` · `deny`. Separate from `kind` so *"how often is this refused"* is a group-by rather than a set of parallel event names that have to be kept in step. |
| `guard` | `text` | yes | The identifier of the guard that refused, from §7's registry. Null on an allow. |
| `claim_id` | `uuid` → `claims.id` | yes | Null on service-level rows and on a claim that was refused before a row existed. |
| `tab_id` | `uuid` → `tabs.id` | yes | |
| `session_id` | `text` | yes | Denormalised from the claim, and **this is the important one**: a refused claim never becomes a claim row, so without this column every refusal on the busiest guard in the service is anonymous. |
| `adapter` | enum | no | `mcp-http` · `mcp-stdio` · `http` · `cli` · `internal`. What door the call came in through. `internal` covers the reaper, the sweep and boot reconciliation. This is also the column that turns §8's *"the same guard fires on every transport"* from a claim into a query. |
| `detail` | `jsonb` | no | Kind-specific payload, default `{}`. Typed as a discriminated union in the service layer, which is the only writer, and left as plain `jsonb` in the column so the ledger stays one queryable stream. A column per kind would be a wide sparse table; a table per kind would turn every slice read into a fifteen-way union. |

**`kind` values:** `claim_requested` · `claim_granted` · `claim_queued` · `claim_promoted` ·
`claim_renewed` · `claim_released` · `claim_expired` · `claim_revoked` · `tab_opened` ·
`tab_open_failed` · `tab_closed` · `navigate` · `act` · `read` · `evaluate` · `capture` · `compare` ·
`baseline_promoted` · `baseline_retired` · `browser_launched` · `browser_exited` · `sweep` ·
`setting_changed`.

An enum rather than text, because a typo in free text creates a phantom event class that every count
then silently misses. **Postgres cannot remove an enum value**, so one is added only when the code
that emits it exists.

**What an allow row does not record: which guards passed.** Only that the operation ran. Recording
every passing guard would multiply row count by the guard count to answer a question nobody asks —
and the question that *is* asked ("has this guard ever fired") is answered by the deny rows and by
§8's assertion 3, which fails the build for a guard with no observed rejection.

**Indexes:** `(at)` for the slice read · `(claim_id, id)` for one lease's whole history · `(kind, at)`
for the capture and compare rollups the resolution ladder reads · `(guard) WHERE guard IS NOT NULL`,
which is small because denials are rare and is the index behind *"which guard refuses most"*.

### 1.7 `captures` — what a picture cost

The table the resolution-ladder study (`MILESTONES.md` #34) reads to settle the provisional tiers
with evidence.

| Column | Type | Null | For |
|---|---|---|---|
| `id` | `uuid` PK | no | |
| `claim_id` | `uuid` → `claims.id` | no | Who took it. Survives the claim ending, which is the point. |
| `tab_id` | `uuid` → `tabs.id` | no | |
| `taken_at` | `timestamptz` | no | |
| `kind` | enum | no | `viewport` · `element` · `full_page`. |
| `tier` | enum | no | `default` · `detail` · `max`. |
| `reason` | `text` | yes | **Required exactly when `tier = 'max'`**: `CHECK ((tier = 'max') = (reason IS NOT NULL))`. This column is the entire mechanism by which anyone learns *why* callers escalate, which is what #34 needs to tune the default (`DECISIONS.md` §13d). |
| `source_width` · `source_height` | `int` | no | What the browser produced, before any downscale. "What it was downscaled from", as a pair of numbers rather than a flag. |
| `width` · `height` | `int` | no | What was written to disk. Equal to the source pair when no downscale happened, which is how "was it downscaled" is derived without a column that could disagree with the numbers beside it. |
| `bytes` | `int` | no | |
| `path` | `text` | no | **Relative to `artifacts.root`, never absolute.** An absolute path pins the row to one filesystem layout and breaks the moment the root moves; the root is a setting, so the row stores the part the root does not. |
| `estimated_tokens` | `int` | no | `ceil(width × height / 750)`, the documented approximation for a vision model's image cost. An estimate, recorded at capture time, and named as one. Worked at a 16:9 aspect: 1024×576 → 787 · 1568×882 → 1844 · 2576×1449 → 4977. Those three numbers are the whole argument for the tiers, so they belong where somebody can check them. |
| `view_key` | `text` | yes | The caller's identity for this view, when it supplied one. Null makes the capture ineligible for comparison, which is correct: a capture nobody named cannot be matched to a baseline. |
| `viewport_width` | `int` | no | The viewport width the capture was taken at. **This is the breakpoint**, and it is stored as a number rather than a name because a named breakpoint set is a vocabulary the service would have to own and does not. |
| `full_page_requested` | `boolean` | no | Whether the caller asked for a full page. Separate from `kind` so the rollup can answer *"how often does anyone actually want this"* — the answer decides whether the default is right. |
| `warned` | `boolean` | no | Whether the accounting warning fired on this capture. **The only way to find out whether the warning changes behaviour** is to know which captures carried one and look at what the same claim did next. |

**Indexes:** `(claim_id)` · `(taken_at)` · `(view_key, viewport_width) WHERE view_key IS NOT NULL`,
which is the promote-to-baseline lookup and skips every unnamed capture.

### 1.8 `baselines` — one per view and breakpoint

| Column | Type | Null | For |
|---|---|---|---|
| `id` | `uuid` PK | no | |
| `view_key` | `text` | no | The caller's identity for a view. Free text, normalised on write (lowercase, trim, collapse separators). **Deliberately not a reference table:** the service has no concept of a "view", and a registry would force a caller to declare a view before it could compare one, which is friction on the operation the feature exists for. The cost is that `checkout` and `check-out` are two views; normalisation kills case and separator variants and does not kill synonyms, and that limit is accepted rather than hidden. |
| `viewport_width` | `int` | no | The breakpoint. With `view_key` this is the identity a comparison matches on. |
| `path` | `text` | no | Relative to `artifacts.root`, same reasoning as `captures.path`. |
| `width` · `height` · `bytes` | `int` | no | |
| `promoted_from` | `uuid` → `captures.id` | yes | Which capture became this baseline. Null when a baseline was imported from a file rather than promoted from a capture — both are legitimate and only one has a capture row. |
| `promoted_at` | `timestamptz` | no | |
| `retired_at` | `timestamptz` | yes | **Baselines are retired, never deleted**, so a comparison recorded months ago can still name what it was compared against. A deleted baseline turns every historical comparison into an unfalsifiable claim. |
| `aa_threshold` | `real` | no | The anti-aliasing threshold in force for this baseline. **Per baseline rather than global, and this is a real design position:** a view dense with text needs a looser threshold than a view of flat colour, and one global number gets tuned to the noisiest view and then swallows genuine changes everywhere else. The global setting (§6.2) is the value a new baseline starts at, not the value it keeps. |
| `min_region_px` | `int` | no | The smallest bounding box worth reporting, in pixels on the shorter side. Same per-baseline reasoning. |

**Index:** `UNIQUE (view_key, viewport_width) WHERE retired_at IS NULL` — one live baseline per view
and breakpoint, and any number of retired ones. The third partial unique index in this schema, which
is why §1.11 is a decision about a construction rather than about one constraint.

### 1.9 `comparisons` — the one table nothing else in the plans asks for

**Every other table here is named by `PLAN.md` or `DECISIONS.md`. This one is not, so it owes a
justification.**

A comparison returns its regions to a caller and, without a row, that is the only place the result
ever exists. `MILESTONES.md` #43 asks for a test proving a real change is not swallowed by the
threshold — which is a question about the *history* of comparisons at a given threshold, not about
one call. Threshold tuning with no record of what the threshold did is guessing with extra steps.

| Column | Type | Null | For |
|---|---|---|---|
| `id` | `uuid` PK | no | |
| `capture_id` | `uuid` → `captures.id` | no | |
| `baseline_id` | `uuid` → `baselines.id` | no | Which baseline, including a retired one. |
| `claim_id` | `uuid` → `claims.id` | no | Who asked. |
| `at` | `timestamptz` | no | |
| `aa_threshold` | `real` | no | The threshold actually applied, copied from the baseline at comparison time. A later tune must not rewrite what an older comparison did. |
| `changed_pixels` | `int` | no | Raw count from the diff, before any region logic. The number that says whether "nothing changed" means *nothing moved* or *the threshold ate it*. |
| `region_count` | `int` | no | Regions after merging and size filtering. |
| `regions` | `jsonb` | no | `[{x, y, w, h, crop_path}]`, capped at `compare.max_regions`. |
| `truncated` | `boolean` | no | Whether regions were dropped by that cap. A truncated result that does not say so is a lie about completeness. |

**Index:** `(baseline_id, at DESC)` — the history of one view's comparisons, which is what tuning
reads.

### 1.10 `settings` and `settings_revision`

The registry is declared in code and the database stores **overrides only**, so a fresh database
boots fully working (§6.2).

**`settings`**

| Column | Type | Null | For |
|---|---|---|---|
| `key` | `text` PK | no | Matches a registry key. A row for a key the registry does not declare is inert, never deleted, and listed as unrecognised. |
| `value` | `jsonb` | no | The override. JSON `null` is a legal, meaningful value — retention forever, comparison off — and is **not** the same as no row, which means "at the code default". |
| `updated_at` | `timestamptz` | no | |
| `updated_by` | `text` | yes | A free-text actor label (`cli`, `ops`, a session identity). There is no people table and inventing one for an audit label would be a user model arriving by the back door. |

**`settings_revision`** — one row, `id int PK` always `1`, `revision bigint` bumped in the same
transaction as every settings write **including a clear**.

A counter rather than `max(updated_at)`, because clearing an override deletes a row and a delete can
lower a maximum — a change that moves state backwards would be invisible to anything watching a
high-water mark. The counter only rises, so *"have settings moved since I last looked"* is one
comparison, and it doubles as the entity tag on `GET /settings`.

**`settings` is never a secret store.** Every value is served unauthenticated by `GET /settings`
(§4.6) and printed by `broker config list`. There is no redaction path and none will be added,
because a value that cannot be shown cannot be edited on the surface the table exists to feed.
Credentials belong in the environment tier, which exists precisely because some values must not be
readable from the application (§7, `settings.no_secrets`).

### 1.11 The constraints that want a partial unique index

`DECISIONS.md` §13b names two constraints wanting this construction. **One of them turns out not to
need it, and two others do.** Saying that plainly matters more than keeping the count.

**"One active lease per tab" is structural, not a constraint.** `tabs.claim_id` is `NOT NULL` and
immutable, and a tab row is created by exactly one claim and closed with it. Two claims cannot own
one tab because there is no operation that reassigns one. Nothing to enforce, and no index to write.

**Three constraints genuinely want a partial index**, and only the first is a *unique* constraint on
the lease itself:

```sql
-- 1. one live claim per session
CREATE UNIQUE INDEX one_live_claim_per_session
  ON claims (session_id) WHERE state IN ('queued','active');

-- 2. two live tab rows must never name one physical tab
CREATE UNIQUE INDEX one_row_per_physical_tab
  ON tabs (browser_id, driver_tab_id) WHERE state IN ('opening','open','closing');

-- 3. one live baseline per view and breakpoint
CREATE UNIQUE INDEX one_live_baseline
  ON baselines (view_key, viewport_width) WHERE retired_at IS NULL;
```

Plus the non-unique partial index on `tabs` that makes the capacity count index-only (§1.4).

**Prisma cannot express any of these**, unique or not — a Prisma schema has no filter clause on
`@@index` or `@@unique`, and no check constraints either. So this is a decision about a construction
that recurs, not about one line. **Three answers, none free**, and the third only came into view
while writing this document:

| Answer | Race-proof | Cost |
|---|---|---|
| **A hand-written migration** carrying the raw index, with the schema-drift check taught to tolerate a documented exception | Yes | A permanent exception in a check whose entire value is having none — and the exception has to be per-index, or it becomes a hole anything can walk through |
| **Application-level enforcement** | **No, on its own.** Two concurrent claims can both read "no live claim" and both write one | Free in schema terms, and only acceptable inside a `SERIALIZABLE` transaction or behind an advisory lock keyed on the session — which is a real mechanism and has to be named as one rather than assumed |
| **A maintained nullable column with a total unique index.** `claims.live_session_id text NULL UNIQUE`, set to `session_id` on insert and set to null on every terminal transition | Yes — the unique index is real | Prisma expresses it natively and the drift check stays clean, but the service now maintains a derived value, and a path that forgets to null it wedges that session out of the service until somebody notices. A Postgres generated column removes the maintenance risk and puts the expression back into raw SQL, which is answer A again |

**This is not decided here.** It belongs to `MILESTONES.md` #13, decided with the actual transaction
shape in front of it. What *is* decided is that it will not be skipped: an unguarded read-then-write
is not enforcement, and the same choice has to be taken for all three indexes at once rather than one
at a time, or the drift check ends up carrying two different kinds of exception.

---

## 2. Lease states and transitions

### 2.1 The five states

| State | Live | Means |
|---|---|---|
| `queued` | yes | Capacity was not available. The claim holds a place and a key, and no tabs. |
| `active` | yes | The claim holds tabs. |
| `released` | terminal | The caller gave it up. |
| `expired` | terminal | Its expiry passed with no keyed call. |
| `revoked` | terminal | An operator took it, with a reason. |

**Terminal is terminal.** There is no path out of the bottom three, and a caller whose lease ended
gets a new lease or nothing. The alternative — reviving an expired claim on the next call — would
mean tabs that were closed have to be reopened, which is a different lease wearing an old identity.

### 2.2 Every transition, and what each refuses

| From | To | Trigger | Refused when |
|---|---|---|---|
| — | `active` | `claim`, capacity available | See the four claim refusals below |
| — | `queued` | `claim`, capacity unavailable | Same four |
| `queued` | `active` | Admission sweep promotes the head (§2.5) | Never refused — no caller is present to refuse |
| `queued` | `queued` | Any keyed call renews `expires_at` | — |
| `queued` | `expired` | Reaper, `expires_at` passed | — |
| `queued` | `released` | `release` | Idempotent, never refused (below) |
| `queued` | `revoked` | Operator `revoke` with a reason | `reason_required` when no reason is given |
| `active` | `active` | Any keyed call renews `expires_at` | — |
| `active` | `released` | `release` | Idempotent, never refused |
| `active` | `expired` | Reaper, `expires_at` passed | — |
| `active` | `revoked` | Operator `revoke` with a reason | `reason_required` |
| any terminal | anything | — | `claim_not_live`, naming the state and `ended_at` |

**The four refusals on `claim`**, each with the reason it is a refusal rather than a queue entry:

| Code | When | Why it is not queued |
|---|---|---|
| `unknown_browser` | `browser` is not `regular` or `private` | Nothing will ever make it valid |
| `tabs_exceeds_per_claim_cap` | `tabs` > `lease.max_tabs_per_claim` | Same. The cap exists so one caller cannot legally take the whole budget (§6.2) |
| `over_budget` | `tabs` > `capacity.tab_budget` | **A claim that can never be admitted must not sit in a queue pretending it might be.** A queue entry that is structurally unsatisfiable is worse than a refusal, because the caller waits for it |
| `session_already_holds_claim` | The session has a live claim | See below |

**`session_already_holds_claim` names the existing claim's id and state, and not its key.** The key
was returned once and is not recoverable, by construction — it is not stored (§1.3). That has a sharp
consequence worth stating rather than discovering: **a caller that loses the response to its own
`claim` call cannot recover the lease.** Its recovery is to wait out the time to live, or for an
operator to revoke it. This is the price of not storing keys, and the alternative — returning the
existing claim as a success — would silently hide the real bug this refusal catches, which is two
callers sharing one session identity.

**`release` is idempotent; `status` and every other keyed call is not.** Releasing an already-terminal
claim succeeds with `{released: true, tabs_closed: 0, already_ended: "expired"}`. Renewing one fails
with `claim_not_live`. The asymmetry is deliberate and is about what the caller is about to do: a
caller releasing in a cleanup path, and then again on shutdown, must not see an error for tidying up
twice, and there is no state to corrupt. A caller renewing is about to do work it cannot do, and
telling it "fine" would let it discover that one operation later, further from the cause.

**Rejections carry the guard identifier** (§7) as well as the code, so §8's third assertion can be
computed from what the service actually refused on rather than from what a test case declared.

### 2.3 Admission is two-phase, and capacity is taken in the first phase

A driver call cannot be inside a database transaction, so admission is split, and the split is
arranged so that **the failure mode is capacity held too long, never a bound overshot**.

**Phase one, one transaction:**

1. Count live tabs: `SELECT count(*) FROM tabs WHERE state IN ('opening','open','closing')`.
2. If `count + tabs_requested ≤ capacity.tab_budget`, insert the claim as `active` with
   `activated_at = now()`, and insert `tabs_requested` rows in `tabs` with `state = 'opening'` and
   `driver_tab_id = NULL`. Otherwise insert the claim as `queued` and insert no tab rows.
3. Append the `events` row. Commit.

The count and the insert are in one transaction at `SERIALIZABLE`, or behind an advisory lock on a
single capacity key. **Read-then-write without one of those is not a bound**, it is a bound that
holds until two callers arrive together, which is the only condition under which anybody cares.

**Phase two, after the commit:** the driver is asked to open each tab. On success the row takes its
`driver_tab_id` and `state = 'open'`. On failure it takes `state = 'failed'` and an
`tab_open_failed` event.

**Why the tab rows exist before the tabs do — this is the load-bearing choice.** Capacity is counted
over rows that are not yet confirmed closed, which means:

- a grant and its rows are **the same number**, always, so there is exactly one counter and
  `total open tabs + requested ≤ budget` is literally the predicate (`DECISIONS.md` §6);
- a tab stuck in `closing` still counts, which is correct, because its renderer may still exist;
- a crash between the two phases leaves rows that reserve capacity for tabs that do not exist — and
  the boot reconciliation (§2.6) is what clears them. **That is the trade, stated:** the service can
  briefly believe it is fuller than it is, and can never believe it is emptier.

**If every tab fails to open, the service releases the claim itself**, terminally, with an event
naming the driver error, and returns `browser_unavailable` to the caller. A lease with no tabs is
useless, and holding capacity for it is strictly worse than refusing. **If some open and some fail**,
the claim stays active with the tabs that worked, the response lists them, and a warning names the
shortfall — because a caller that asked for four and can use three is usually better served by three
than by nothing, and it is the caller that knows.

### 2.4 The reaper — exactly what it does

Runs every `lease.reaper_interval_seconds` (default 15) and on demand immediately after any release,
expiry or revoke.

**One transaction per claim, not one per pass.** A pass-wide transaction holds locks the hot path
needs, and a failure part-way through would un-expire the claims already handled.

Each pass, in this order:

1. **Queued claims past `expires_at` → `expired`.** No driver work: a queued claim owns nothing.
2. **Active claims past `expires_at` → `expired`.** In the transaction: mark the claim terminal, mark
   each of its `open` tabs `closing`. After the commit: ask the driver to close each one by its
   `driver_tab_id`, then mark it `closed`. A close that fails increments `close_attempts` and the tab
   stays `closing`, so it keeps counting against capacity until it is confirmed gone.
3. **Admission sweep** (§2.5).

**Escalation on a stuck close:** at `close_attempts >= 3` the reaper stops retrying that tab, writes a
`sweep` event naming it, and the operations page shows it. It is **not** force-closed by killing the
browser, because that is a browser-scoped action and there is no state in which the service takes one
(§7, `browser_scoped.never`). The honest consequence: a driver that cannot close a tab permanently
costs one unit of budget until the service restarts, and the boot reconciliation is what recovers it.

**Disconnect, if the transport offers one.** Where the transport can say a client went away, the
service sets the claim's `expires_at` to `now() + lease.disconnect_grace_seconds` (default 60) rather
than revoking, because clients reconnect. Where it cannot, the time to live is the whole answer.
**The MCP transport may not offer this signal at all**, so nothing depends on it and the grace path is
an optimisation that is allowed to be absent.

### 2.5 The admission sweep, and strict first-in-first-out

```
while the head of the queue exists
  and live_tabs + head.tabs_requested <= capacity.tab_budget:
      promote the head
```

**Strictly first in, first out. The sweep never skips a head that does not fit.** A claim asking for
four tabs blocks smaller claims behind it until four are free.

That cost is real and is accepted for one reason: **skipping is starvation**, and it is starvation
aimed precisely at the largest requests, which are the ones least able to be retried cheaply. A
service that quietly serves small claims first would make a four-tab claim unservable on a busy day
and give it no signal that this was happening — the queue position would sit at 1 indefinitely.
Head-of-line blocking is visible, fair, and bounded by the head's time to live.

The alternative — skip-ahead with an aging rule that eventually forces the head through — is a real
design and is listed in §9.1, because it is the sort of thing that is easy to argue for once and hard
to reason about at three in the morning.

### 2.6 Boot reconciliation, before any traffic is served

The service does not accept a single call until this completes, and the reason is arithmetic: a
capacity count that includes tabs nobody owns refuses work for no reason, and one that misses real
tabs overshoots the bound. Both are wrong and only one is loud.

1. **Expire anything already past its expiry**, queued or active, as an ordinary reaper pass.
2. **Fail every tab still `opening`.** Nothing can confirm an open that a dead process asked for.
3. **Ask the driver for the live tab list of each browser it launched** — identified by
   `browsers.pid`, so a browser somebody else is running is never inspected and never touched
   (`DECISIONS.md` §6a, outward half).
4. **Reconcile.** A live driver tab with no live claim owning it is closed. A `tabs` row in
   `open` or `closing` whose driver tab is gone is marked `closed`. A `tabs` row whose driver tab is
   present and whose claim is live is left alone.
5. **Run the admission sweep**, so capacity freed by steps 2–4 goes to the queue rather than sitting
   idle until the next caller arrives.

**If the browsers are not running at boot** — the ordinary case after a restart — steps 3 and 4 close
every live tab row instead, because a tab inside a process that has exited is closed by definition.

### 2.7 What reclaims what — the whole rule in one line

> **Every reclamation is tab-scoped and lease-scoped. Nothing is ever browser-scoped.**

The reaper closes tabs by the `driver_tab_id` recorded when they were opened. `release` closes
exactly the tabs of exactly that claim. `revoke` does the same. Boot reconciliation closes exactly
the tabs the service can prove it owns and no live claim wants.

The browsers are lifecycle-managed by the service and are never closed by any caller's action, direct
or indirect. **This is not a rule callers are asked to respect — there is no operation through which
they could do otherwise** (§3.13, §7 `browser_scoped.never`), and the driver's browser-close operation
is unreachable from any code path a request can enter.

---

## 3. MCP tools

### 3.1 The list, and what it costs

**Eleven tools.** Every description is resident in a connected session's context on every turn
whether or not anything calls it, so surface area is a standing tax and the list is short on purpose.

| # | Tool | One line |
|---|---|---|
| 1 | `browser_claim` | Ask for a lease. Get tabs, or a place in the queue. |
| 2 | `browser_status` | Where your lease stands. **Renews it** — this is the keep-pinging call. |
| 3 | `browser_release` | Give the lease back. Closes your tabs and nothing else. |
| 4 | `browser_tab_open` | Open a replacement tab inside your existing grant. |
| 5 | `browser_tab_close` | Close one of your tabs. |
| 6 | `browser_navigate` | Point one of your tabs at a URL. |
| 7 | `browser_act` | Click, type, fill, press, select, hover, check, scroll. |
| 8 | `browser_read` | Snapshot, console, network or cookie summary — written to disk, returned as a path. |
| 9 | `browser_evaluate` | Evaluate an expression in the page and get its value. |
| 10 | `browser_capture` | Take a picture. Returns a path and its dimensions, never the image. |
| 11 | `browser_compare` | Compare a capture against this view's baseline; get back the regions that moved. |

**Eleven, against the "around ten" the design aimed at.** The marginal one is `browser_compare`, and
it earns its place under `DECISIONS.md` §13a on the condition it stays **one operation and not a
family**: baseline promotion, retirement and listing live on the operations surface (§4.5, §5.4),
where a human is, and not in the tool list, where every session pays for them.

**Two collapses bought the budget, and both have a cost worth naming.** `browser_act` folds ten verbs
into one action enum — less discoverable, and its error messages have to work harder to say which of
ten shapes was wrong. `browser_read` folds four artefact kinds into one. **What was deliberately not
collapsed is `browser_tab_close`**: a destructive operation keeps its own name, because folding one
into a general operation under an action parameter is how a rule that matches on operation name
becomes invisible, and that failure is silent by construction (`DECISIONS.md` §5).

**On the `browser_` prefix.** Client namespacing is not universal, so a bare `claim` risks colliding
with another server's tool in the same session; the prefix costs roughly two tokens per name and buys
a name that reads correctly at the call site. It names the thing the caller thinks it is holding.

**Every tool except `browser_claim` takes `key`, and every keyed call renews the lease.** There is no
keyed call that does not renew, including the ones that only read — §3.3 explains why that is a rule
rather than an accident.

### 3.2 `browser_claim`

**Arguments**

| Name | Type | Required | Meaning |
|---|---|---|---|
| `session_id` | string | yes | The caller's session identity. The unit the one-live-claim rule is over. |
| `browser` | `"regular"` \| `"private"` | yes | **No default**, deliberately. Defaulting to `private` would silently give clean-room behaviour to a caller that needed a sign-in; defaulting to `regular` would put unnecessary work on the profile that has something to lose. Neither is a safe guess, so the caller states it. |
| `tabs` | int, 1–`lease.max_tabs_per_claim` | no, default 1 | How many tabs. **Asking for more than you use is not free** — a grant is capacity taken from the queue for the whole lease (§2.3). |
| `purpose` | string, 3–200 chars | yes | What this lease is for, in human words. Shown on the operations page. |

**Returns**

```jsonc
{
  "claim_id": "…",
  "key": "…",                       // returned once, never stored, never recoverable
  "state": "active",                // or "queued"
  "browser": "regular",
  "tabs": ["…", "…"],               // opaque tab ids; empty when queued
  "expires_at": "…",
  "renew_within_seconds": 600,
  "budget": { "tab_budget": 15, "tabs_in_use": 7 },
  "queue": null,                    // when queued: { "position": 3, "ahead": 2,
                                    //   "estimated_wait_seconds": 480, "estimate_is_rough": true }
  "notes": [ { "code": "…", "message": "…" } ]
}
```

**`notes` is where the protocol says out loud what it expects.** A queued claim always carries
`queue_keep_pinging`: *call `browser_status` with this key at least every N seconds, or lose your
place and re-queue at the back with a new key.* A protocol that implies an obligation and never states
it is a protocol whose clients will not meet it. Other notes: `session_storage_per_tab` on every
grant, `partial_grant` when fewer tabs opened than were asked for (§2.3), `private_shares_cookie_jar`
on a `private` grant — *"clean-room relative to the signed-in profile, not relative to other callers
on this browser"* (`DECISIONS.md` §6).

**Refuses:** `unknown_browser` · `tabs_exceeds_per_claim_cap` · `over_budget` ·
`session_already_holds_claim` · `browser_unavailable` when the requested browser is not `running`
(§2.2). **A browser that is down is an availability problem, not a capacity problem, so it is refused
rather than queued** — the queue's promise is that capacity frees, and nothing about a failed browser
promises that.

### 3.3 `browser_status`

**Arguments:** `{ key }`. **Returns:** the `browser_claim` shape without `key`.

**This call renews.** It is the "keep pinging" verb, and it is also what a queued caller polls with.

**There is no `renew` tool, and that is a change from the plan's state diagram.** A dedicated renew
would be a second name for an effect every keyed call already has, and two names for one effect is
how a caller ends up believing one of them does not renew. The diagram's `renew` edge is real; it is
just that every keyed call is the trigger. `PLAN.md`'s wording — *"every keyed call is an implicit
renew"* — is the whole mechanism, and `browser_status` is simply the call that does nothing else.

**Refuses:** `invalid_key` when nothing hashes to a claim · `claim_not_live` when the claim is
terminal, naming the state and `ended_at`, and for `expired` saying plainly that the tabs are gone and
a fresh claim is the way back.

### 3.4 `browser_release`

**Arguments:** `{ key }`. **Returns:** `{ released: true, tabs_closed: 2, already_ended: null }`.

Terminal. Closes exactly this claim's tabs and triggers the admission sweep. **Idempotent** — a second
release returns `{ released: true, tabs_closed: 0, already_ended: "released" }` (§2.2).

**Refuses:** `invalid_key` only. A release is never refused for state, which is the one place this
surface is deliberately forgiving.

### 3.5 `browser_tab_open`

**Arguments:** `{ key }`. **Returns:** `{ tab_id, notes }`.

Opens one tab **inside the grant this claim already holds** — so it is only usable after a
`browser_tab_close` freed one. It never enlarges a claim and never touches the global budget, because
the budget was taken at admission.

Its purpose is a genuinely fresh tab: no history, no in-page state. A caller that only needs a
different page navigates instead.

**Refuses:** `grant_exhausted`, naming how many tabs the claim holds and its grant · `claim_not_live`
· `browser_unavailable`.

### 3.6 `browser_tab_close`

**Arguments:** `{ key, tab_id }`. **Returns:** `{ closed: true }`.

**Keeps its own name because it is the destructive one** (§3.1).

**Refuses:** `tab_not_found` when the tab is unknown **or** belongs to another claim — deliberately
the same code and the same message for both. Distinguishing them would let a caller enumerate other
claims' tabs by probing, and there is no case where a caller legitimately needs to know that a tab
it does not own exists. · `tab_not_open` when the tab is already closed or failed.

### 3.7 `browser_navigate`

**Arguments:** `{ key, tab_id, url, wait_until? }` where `wait_until` is `load` (default) ·
`domcontentloaded` · `networkidle`.

**Returns:** `{ url, title, http_status, snapshot_path, notes }` — the final URL after redirects, and
a path to the accessibility snapshot written on arrival. **The snapshot is a path, never inline**
(§3.9's rule applied here): a snapshot of a real page is thousands of tokens, and a caller usually
wants one region of it.

**Refuses:** `tab_not_found` · `tab_not_open` · `invalid_url` for a scheme that is not `http`,
`https` or `about:blank` — `file:` in particular is refused, because it turns a browser lease into an
arbitrary read of the host's filesystem, which no part of this contract intends to grant.

### 3.8 `browser_act`

**Arguments:** `{ key, tab_id, action, ref, value?, options? }` where `action` is one of `click` ·
`double_click` · `fill` · `type` · `press` · `select` · `hover` · `check` · `uncheck` · `scroll`, and
`ref` is an element reference taken from a snapshot.

**Returns:** `{ ok: true, snapshot_path, console_delta_path?, notes }` — a fresh snapshot after every
mutation, because the caller's next `ref` has to come from the page as it is now, and a stale
reference is the most common cause of an action landing on the wrong element.

**Refuses:** `tab_not_found` · `tab_not_open` · `unknown_action`, which **lists the ten valid values**
— the enum's discoverability cost (§3.1) is paid back here or not at all · `ref_not_found`, naming
the snapshot the reference should have come from · `value_required` for the actions that need one.

### 3.9 `browser_read`

**Arguments:** `{ key, tab_id, kind, filter? }` where `kind` is `snapshot` · `console` · `network` ·
`cookies`.

**Returns:** `{ path, bytes, lines, truncated }`. **Never the contents.** The caller greps the part it
needs; a full accessibility snapshot or network log entering a conversation is paid for once in money
and on every subsequent turn in context.

**`kind: "cookies"` returns name, domain, path, expiry and flags — never `value`.** Not truncated,
not masked: the field is absent. A service handing over cookie values is a credential-export feature
whatever else it is called, and the conformance suite asserts this by seeding a cookie with a known
string and asserting that string appears nowhere in the response or in the written file (§7,
`read.cookies_no_values`).

**Refuses:** `tab_not_found` · `tab_not_open` · `unknown_kind`.

### 3.10 `browser_evaluate`

**Arguments:** `{ key, tab_id, expression }`. **Returns:** `{ value }` inline when the serialised
result is under `evaluate.inline_byte_cap` (default 4096), otherwise `{ path, bytes }`.

**This is the cheap path and it exists to be used.** Computed styles, contrast ratios, box geometry,
spacing, line height and reading width are a few hundred tokens of JSON and are *more* accurate than a
model estimating them off a picture.

**It also needs the honest paragraph, because two parts of `PLAN.md` pull against each other.** The
contract section keeps `evaluate`; the deliberately-absent list says "no arbitrary script execution".
Both are right about different things, and the line between them is **scope**:

- **In scope: page-scope evaluation.** The expression runs in the page and can do what that page's own
  scripts can do.
- **Out of scope: driver-scope execution.** Code running in the service's own process, with the
  automation library, the filesystem and the network in reach, is a different capability entirely and
  is not exposed by anything (§3.13).

**And the residual, stated rather than glossed:** on the signed-in browser, page-scope evaluation can
read that page's own storage, and no guard closes that without breaking the feature — a page's scripts
reading their own storage is the platform working as designed. The position taken here is that **a
lease on the signed-in browser already grants the ability to act as the signed-in user**, which is
what the lease is *for*, so evaluation widens nothing. What it could widen is exfiltration the record
cannot see, and the answer to that is that every expression and the size of its result land in
`events` (§1.6). Narrowly denying the obvious storage accessors was considered and rejected as
theatre: it stops nobody and it teaches a reader that the hole is closed.

**Refuses:** `tab_not_found` · `tab_not_open` · `expression_too_long` past
`evaluate.max_expression_bytes` (default 8192) — a long expression is a program, and a program wants
the driver-scope capability that is not on offer.

### 3.11 `browser_capture`

**Arguments**

| Name | Type | Required | Meaning |
|---|---|---|---|
| `key`, `tab_id` | | yes | |
| `tier` | `"detail"` \| `"max"` | **no** | Absent means the cheapest tier. **This is the lever** (`DECISIONS.md` §13d): most callers never pass an optional parameter, so a low default does nearly all the work of a ceiling without blocking anyone. Note that `"default"` is not an accepted *value* — passing nothing is how you get it, and there is no way to ask for the default explicitly, because a caller writing it out is a caller who thought about resolution and should have written `detail`. |
| `reason` | string, 8–200 chars | **iff `tier = "max"`** | Recorded on the row. The only mechanism that produces data about *why* anyone escalates, which is what the ladder study needs (`MILESTONES.md` #34). |
| `full_page` | bool | no, default `false` | Unbounded page height crosses the long edge far more often than width does. |
| `selector` | string | no | Capture one element. Mutually exclusive with `full_page`. |
| `view` | string | no | The view identity, for later comparison (§3.12). Without it a capture cannot be compared or promoted. |
| `label` | string | no | Becomes part of the filename, so a human reading the directory can tell one from another. |

**Returns**

```jsonc
{
  "path": "captures/<claim_id>/<capture_id>-<label>.png",
  "width": 1024, "height": 576,
  "source_width": 1512, "source_height": 850,
  "bytes": 84210,
  "tier": "default",
  "estimated_tokens": 787,
  "captures_this_claim": 13,
  "warning": { "code": "capture_budget_exceeded", "message": "…" }   // or null
}
```

**Never the image.** The caller opens the file only when it genuinely needs to *look*.

**Nothing is ever refused on capture grounds.** Past `capture.warn_after_per_claim` (default 12) every
capture is served **and** carries a warning, and the warning names the cheaper operation that answers
the same question — *"if you are reading a value, `browser_read` with `kind: snapshot` or
`browser_evaluate` returns it as text for a fraction of this"*. A bare "you have taken a lot of
captures" teaches a caller to ask for a bigger budget; naming the alternative teaches the thing the
policy exists to teach. And a warning on every capture past the threshold rather than only on the
first, because a warning that appears once has scrolled away by the time it matters.

**Refuses:** `tab_not_found` · `tab_not_open` · `reason_required` when `tier: "max"` arrives without
one · `selector_and_full_page` when both are given. **All four are argument errors. None is about
cost**, and §7 carries an assertion that no code path refuses a capture for cost.

### 3.12 `browser_compare`

**Arguments:** `{ key, capture_id, view?, viewport_width? }` — `view` and `viewport_width` default to
the capture's own, and are arguments only so a capture can be compared against a baseline it was not
labelled for.

**Returns**

```jsonc
{
  "changed": true,
  "changed_pixels": 4180,
  "region_count": 2,
  "regions": [ { "x": 24, "y": 320, "w": 412, "h": 96, "crop_path": "crops/…-1.png" } ],
  "truncated": false,
  "baseline_id": "…",
  "aa_threshold": 0.1
}
```

**Refuses:** `baseline_missing` when no live baseline exists for that view and breakpoint, naming the
promote operation. **This is a refusal on purpose** (`MILESTONES.md` #43): a comparison that quietly
returns "nothing changed" on a first run is indistinguishable from one that worked, and it would make
the feature silently useless exactly where it is least expected to be. · `capture_not_found` when the
capture belongs to another claim — same non-disclosing shape as `tab_not_found` · `capture_not_named`
when the capture carries no `view` and none was supplied.

### 3.13 Deliberately absent — this list is part of the contract

| Not exposed | Why |
|---|---|
| **Close, restart or delete any browser; close every tab; delete profile data** | Browser-scoped and destructive. With browsers shared between callers, one caller would end every other caller's work, and on the signed-in profile it destroys a session a person restores by hand. Browsers are lifecycle-managed by the service |
| **Attach to an already-running browser**, over a debugging port or an extension | It reaches a browser the service did not launch — which cannot be checked at the tool layer, because an attach creates a *new* automation session pointing at a foreign process. The outward half of bidirectional isolation depends on this operation not existing, and on the binary being unreachable (`PLAN.md`, "Being the only route in") |
| **Driver-scope code execution** | A different capability from §3.10's page-scope evaluation: the service's own process, its filesystem and its network. Nothing needs it and everything is reachable through it |
| **Save or load whole storage state; set a cookie; write local storage** | Credential export and credential injection on a shared signed-in profile. The read side is already limited to names and flags (§3.9) |
| **Select a tab / any notion of a current tab** | Every operation is addressed by an opaque `tab_id`. A shared implicit cursor is a bug class, not a convenience: one caller navigates and another caller's page — possibly the one holding the sign-in — is silently gone, with no error and nothing in any record to say what happened. With no current tab there is nothing to mis-target |
| **Bring a tab to the foreground** | The service is not the thing that decides what a person is looking at, and moving the foreground is the one action that would make it so. It is also unnecessary: background tabs accept every operation and screenshot correctly (§7, `foreground.never_moved`) |
| **Baseline promote / retire / list** | Not absent from the product — absent from the *agent* surface. They live on the operations surface (§4.5, §5.4), because they are decisions a human takes and every session would otherwise carry their descriptions on every turn |
| **A raw escape hatch to the underlying tool "for advanced use"** | The same decision as the first two rows wearing a friendlier name. If an operation is needed it becomes a contract operation, with a guard and an event row (`DECISIONS.md` §2) |

### 3.14 The error shape, on every tool

```jsonc
{ "error": { "code": "tab_not_found", "guard": "tab.owned",
             "message": "…", "details": { } } }
```

`code` is stable and is what a caller matches on. `guard` is the §7 identifier, present on every
refusal that came from a guard, and it is what §8's third assertion is computed from. `message` is
human text and is **deliberately not compared across adapters** — a terminal and a tool result should
word things differently, and asserting text is both brittle and a weaker claim than asserting the
code.

**Every rejection message names the way forward**, because the alternative teaches a caller to satisfy
the check rather than to do the right thing: `over_budget` names the budget and the largest claim that
would fit; `session_already_holds_claim` names the claim and when it expires; `grant_exhausted` names
`browser_tab_close`; the capture warning names `browser_read` and `browser_evaluate`.

---

## 4. HTTP endpoints

### 4.1 Shape, and who may call what

**Every endpoint is a thin shell over one service operation.** The mapping is one-to-one with §3 for
the agent-facing half, which is what §8 asserts rather than assumes.

**Two access classes, and only one of them has a credential.**

- **Keyed** — the lease's secret key in `Authorization: Bearer <key>`. Everything under `/lease`.
- **Unkeyed operations endpoints** — everything else, including `POST /claims/{id}/revoke`.

**The operations endpoints have no authentication, and the mechanism that makes that defensible is the
bind address.** `BROKER_BIND` defaults to `127.0.0.1` (§6.1), so by default nothing off the host can
reach them at all. Binding elsewhere is allowed — a person may genuinely want the operations page from
another machine — and **the service logs a loud warning at every startup when it is bound off
loopback**, naming what is exposed: an unauthenticated revoke, an unauthenticated settings write, and
a page listing what everything is doing.

It warns rather than refuses, which is the same posture as the capture policy and for the same reason:
**a service that is occasionally noisy survives; one that is occasionally unusable gets routed
around.** Refusing to start would strand a legitimate deployment on a decision the service is not
entitled to take.

### 4.2 The lease

| Method · path | Operation | Body → Response |
|---|---|---|
| `POST /claims` | `claim` | `{session_id, browser, tabs?, purpose}` → **201** with the full claim shape when `active`, **202** when `queued` |
| `GET /lease` | `status` | → the claim shape without `key`. **Renews.** |
| `DELETE /lease` | `release` | → `{released, tabs_closed, already_ended}` |

**201 against 202 is not decoration.** A queued claim is a successful outcome, not a failure — the
queue is the answer, not the error — and 202 says *"accepted, not yet done"*, which is exactly the
state. A caller that treats every 2xx alike still works; a caller that wants to branch has the code
without parsing the body.

**`GET /lease` renews, and a safe method having a side effect is a deliberate exception.** The
alternative is worse: a keyed call that does not renew is a hole in the one rule the liveness model
rests on, and it would produce leases that expire while their caller was politely only reading. The
side effect is on the lease's liveness rather than on the resource being read, which is the same shape
as a session being refreshed by a read, and it is stated here so nobody removes it as a bug.

### 4.3 Tabs and driving

All keyed. `{tab_id}` is the opaque identifier from the claim.

| Method · path | Operation |
|---|---|
| `POST /lease/tabs` | `tab_open` |
| `DELETE /lease/tabs/{tab_id}` | `tab_close` |
| `POST /lease/tabs/{tab_id}/navigate` | `navigate` |
| `POST /lease/tabs/{tab_id}/act` | `act` |
| `GET /lease/tabs/{tab_id}/read?kind=&filter=` | `read` |
| `POST /lease/tabs/{tab_id}/evaluate` | `evaluate` |
| `POST /lease/tabs/{tab_id}/capture` | `capture` |
| `POST /lease/compare` | `compare` |

Request and response bodies are the §3 argument and return shapes verbatim, minus `key` (which is the
header) and minus `tab_id` (which is the path). **The service never returns a `driver_tab_id` on any
of these**, so there is no second way to name a tab (§1.4).

### 4.4 Operations — reading what is happening

| Method · path | Returns |
|---|---|
| `GET /status` | The whole picture in one document: both browsers with state, `pid`, `restart_count` and `surface_verified`; the tab budget and how much is in use; live claims with id, session, browser, tab count, purpose, state and expiry; queue depth and the head's wait. **This is the endpoint the operations page consumes**, and it is designed so another system could fetch the same document as a read-only widget without anything here changing |
| `GET /claims?state=&session=&limit=` | Claim rows, live or historical. **Never `key_hash`** |
| `GET /claims/{id}` | One claim with its tabs and its events |
| `POST /claims/{id}/revoke` | `{reason}` → `{revoked: true, tabs_closed}`. Refuses `reason_required`, and `claim_not_live` on a terminal claim |
| `GET /events?since=&kind=&outcome=&limit=` | A **slice** of the ledger, never the whole thing. `since` is an `events.id`, and the response carries the next cursor |
| `GET /captures?claim_id=&view=&since=` | Capture rows with dimensions, tier, reason and estimated tokens. The rollup the resolution ladder reads |
| `GET /healthz` | `{ok, database, browsers:[{id,state,surface_verified}], migrations_applied}`. **`ok` is false when either browser is not `running`**, because a service that cannot serve a claim is not healthy however well the process is doing |

### 4.5 Baselines — a human surface, not an agent one

| Method · path | |
|---|---|
| `GET /baselines?view=&include_retired=` | List |
| `POST /baselines` | `{capture_id}` or `{view, viewport_width, file}` → promote. Retires the live baseline for that view and breakpoint in the same transaction, so the partial unique index in §1.11 can never be violated by a promote |
| `PATCH /baselines/{id}` | `{aa_threshold?, min_region_px?}` — the per-baseline tuning knobs (§1.8) |
| `DELETE /baselines/{id}` | Retires. **Never deletes** — a comparison recorded against it has to keep naming something real |

### 4.6 Settings

| Method · path | |
|---|---|
| `GET /settings` | Every declared key with its value, whether it is a default or an override, its schema, label, help and category. The registry, rendered. Carries `settings_revision` as the entity tag |
| `PATCH /settings` | Set and clear several keys in **one transaction**, one revision bump, one `setting_changed` event per key sharing a batch identifier — because one human act on a settings page is one act |
| `DELETE /settings/{key}` | Clear one override, returning the key to its code default |

**Which settings take effect when** is declared in the registry per key and shown in the response.
Three answers only: `immediately` (the reaper interval, the tiers, the thresholds), `next_claim` (the
budget, the time-to-live durations — a change must not retroactively shorten a lease a caller has
already been promised), and `restart` (the profile root, the artifact root).

### 4.7 Status codes

| Code | When |
|---|---|
| 200 | Read or mutation succeeded |
| 201 | Claim granted |
| 202 | Claim queued |
| 204 | Release, revoke, settings clear |
| 400 | Malformed — missing field, wrong type, unknown enum value |
| 401 | No key on a keyed endpoint |
| 404 | **Unknown key, terminal claim, unknown tab, and a tab belonging to another claim — all four.** The non-disclosure is deliberate for the last two (§3.6); the first two are 404 for consistency, and the body's `code` distinguishes `invalid_key` from `claim_not_live` for a caller that legitimately holds one |
| 409 | State conflict: `session_already_holds_claim` |
| 422 | Syntactically valid, unsatisfiable: `over_budget`, `tabs_exceeds_per_claim_cap` |
| 503 | `browser_unavailable`, with `Retry-After` |

**No 403 anywhere.** A 403 on a tab would confirm the tab exists, which is the thing §3.6 refuses to
disclose, and having exactly one rule is what stops the confirmation leaking back in through a route
somebody adds later.

**No 429.** Rate limiting is what a service does when it has no queue. This one has a queue, and a
caller that would have been rate-limited is a caller that should be told its position.

### 4.8 The operations page

`GET /` serves **one static HTML file** with no framework, no build step and no bundler. It fetches
`GET /status` and renders it client-side, refreshing on an interval.

**Read-only. No controls, no sign-in, no forms.** It shows both browsers with their state and restart
count, the budget and its use, every live claim with its purpose and expiry, the queue with positions
and waits, and the last N events. Revoking is deliberately absent from the page even though the
endpoint exists, because a button that can end somebody's work is exactly the kind of thing that wants
an actor recorded, and there is no user model here to record one (§9.1).

---

## 5. Command-line surface

### 5.1 Shape

`broker <noun> <verb>`, plus a small set of single-word commands that name one thing each.

**The command line is a full adapter, and it is worth building even if no agent ever calls it.** It is
the cheapest available proof that the rules live in the service layer rather than inside a tool
handler — a rule inside a handler is a rule that holds on one transport and nowhere else.

### 5.2 Two bindings

With `BROKER_URL` set, commands call the HTTP adapter. Without it, they use `DATABASE_URL` and run the
service layer in-process. `--direct` forces the second. One set of command implementations sits above
both, so only the two bindings could ever diverge, and §8 is the test that says they do not.

**In-process is not "no service".** The reaper, the sweep and the driver all live in the service
layer, so a command running in-process will do reaper work if it finds expired claims — which is
correct, and is stated here because it is surprising the first time a `broker claims` call closes
somebody's tabs.

### 5.3 The commands that mirror an operation

Every §3 operation, so parity is real:

```
broker claim   --session S --browser regular|private [--tabs N] --purpose "…" [--wait[=seconds]]
broker status  --key K
broker release --key K
broker tab open  --key K
broker tab close --key K --tab T
broker navigate  --key K --tab T --url U [--wait-until load|domcontentloaded|networkidle]
broker act       --key K --tab T --action click|… --ref R [--value V]
broker read      --key K --tab T --kind snapshot|console|network|cookies [--filter F]
broker evaluate  --key K --tab T --expression E
broker capture   --key K --tab T [--tier detail|max] [--reason "…"] [--full-page]
                                 [--selector S] [--view V] [--label L]
broker compare   --key K --capture C [--view V] [--viewport-width N]
```

**`--wait` is the command line's answer to the keep-pinging protocol**, and it is the one place this
adapter does something the tool surface does not. `broker claim --wait` polls `status` at half the
queued time to live until the claim becomes active or the queue position is lost, which is exactly
what a queued caller is supposed to do and is tedious to write in a shell. It calls the same
operation on every poll; it adds no operation of its own, so §8's parity assertion is untouched.

### 5.4 The operations commands

```
broker claims  [--state …] [--session …] [--json]
broker revoke  <claim-id> --reason "…"
broker browsers
broker events  [--since ID] [--kind …] [--outcome allow|deny] [--limit N]
broker captures [--claim …] [--view …]
broker baseline list|promote|retire|tune
broker config  get|set|unset|list
```

### 5.5 The commands that have no operation behind them

These are the adapter's own, and each one carries a **written waiver** in the conformance suite
(§8.4) rather than being silently absent from it.

| Command | What it does |
|---|---|
| `broker serve` | Runs the service: migrate, reconcile (§2.6), launch both browsers, listen |
| `broker doctor` | Every precondition, each reported separately: database reachable · migrations applied · driver binary present, and its version · artifact and profile roots writable · **the screenshot-surface assertion** · whether the bind address is loopback. Exits 4 on any failure, so it is usable as a readiness check |
| `broker login <browser>` | The headed sign-in mode — §5.5.1 |
| `broker init` | Finds or accepts a database, migrates, writes local configuration, proves it with a round trip. **Every other command preflights** and stops with "run `broker init` first", because a half-configured installation that behaves like a working one is the worst available outcome |

#### 5.5.1 `broker login` — the one time a human drives

Headless is the default for every browser the service runs: it is roughly an order of magnitude faster
to drive, identical in memory, and nothing about a review needs a window. **Signing in is the one
thing a person has to do, and it needs a window.**

`broker login regular` goes through the service and does this, in order:

1. **Refuses if any live claim holds tabs on that browser**, with `browser_busy`, naming the claims.
   The sequence stops the browser, and stopping it would destroy work the service has promised to
   someone. This refusal is why a login is a service operation and not something a person does to the
   process by hand.
2. Sets `browsers.state = 'login'`. From this moment claims for that browser are refused with
   `browser_unavailable` and a `Retry-After` (§3.2). Queued claims for it keep their places and keep
   their time to live, because a sign-in is a pause and not a cancellation.
3. Stops the browser, relaunches it **headed against the same profile directory**, and waits.
4. On the operator's confirmation, stops it and relaunches it headless against that same directory.
5. Back to `running`; the admission sweep runs.

**Why the same directory rather than a separate sign-in profile:** everything the sign-in produces —
cookies, local storage, indexed databases — is written into the profile, and a persistent profile
carries all of it between a headed and a headless launch in both directions. A separate directory
would need the state copied, which is the credential-export operation this contract does not have.

**Refuses on `private`:** `not_persistent`. Signing into an ephemeral profile produces nothing that
outlives the browser, so the command would appear to work and quietly do nothing — which is the worst
of the available failures.

### 5.6 Output, exit codes and identity

**Output** is human-readable by default. `--json` produces one document, one envelope —
`{ok: true, data}` or `{ok: false, error: {code, guard, message, details}}` — with **all human text on
standard error**, so standard output stays parseable by a caller that did not ask for prose.

**The `code` is the same identifier the HTTP adapter and the tool surface return.** That is what lets
identical enforcement be asserted rather than assumed (§8).

**Exit codes**, chosen so the situations that want opposite responses are distinguishable without
parsing anything:

| | |
|---|---|
| `0` | Accepted. **Includes a queued claim** — queuing is an outcome, not a failure. The state is in the output; `--wait` is there for a script that wants to block on it |
| `1` | Unexpected failure |
| `2` | Malformed command |
| `3` | **Refused by a rule.** Distinct from 1 because a refusal is the service working |
| `4` | Not configured, or a precondition failed. What `broker doctor` returns |

**Identity.** `--session` is the caller's identity for anything that claims, from `BROKER_SESSION_ID`
in practice. There is no `--as` and no person model; operations commands record `cli` as the adapter
and whatever `--by` is given as a free-text label on `settings.updated_by`. **The lease key comes from
`--key` or `BROKER_KEY` and is never printed by any command**, including in error output and including
in `--json`, where the field is absent rather than masked.

### 5.7 What needs a server, stated rather than discovered

Only the operations page. Every other surface is substituted: the tool surface over stdio, the
operations commands in-process, configuration through `broker config`, which renders the same registry
the settings endpoint does.

---

## 6. Configuration

### 6.1 The rule that decides where a value lives

Three tiers, and one question decides the tier:

> **What must be known before the process can reach the database?**

| Tier | Read from | Changed by |
|---|---|---|
| **Environment** | Environment variables | Editing the environment and restarting |
| **Settings** | The `settings` table, over a registry of typed defaults declared in code | `PATCH /settings` or `broker config set` |
| **Build constants** | Compiled in | Shipping a version |

Anything needed to connect and listen is an environment variable. Everything read after that point
comes from a database that is already reachable, so it is a setting — typed, validated, explained and
audited. Anything describing what this build *is*, rather than how it is configured, is a constant.

**Environment variables**

| Variable | Values | Meaning |
|---|---|---|
| `DATABASE_URL` | connection string | Postgres. The one value nothing else can be read without |
| `BROKER_BIND` | address, default `127.0.0.1` | Interface the server binds to |
| `BROKER_PORT` | int, default `8787` | Port it listens on |
| `NODE_ENV` | `development` · `production` · `test` | Set by the toolchain, not by an operator |
| `SHADOW_DATABASE_URL` | connection string | Development and continuous integration only. The disposable database the migration drift check drops and rebuilds |

The command line adds three of its own, environment-tier for the same reason:

| Variable | Meaning |
|---|---|
| `BROKER_URL` | Where a server is, if there is one. Present → commands call the API; absent → in-process over `DATABASE_URL` |
| `BROKER_SESSION_ID` | The session a command acts as. Exported by whatever launches a session, never typed by hand |
| `BROKER_KEY` | The lease key. Never printed by any command (§5.6) |

**Why bind and port are environment variables when the rule says they should be settings.** They
belong to the runtime rather than to the application — a container runtime supplies them — and, the
stronger reason: **a bad value stored in the database could only be fixed through the surface that the
bad value broke.** A configuration mistake that locks you out of the configuration surface is a
category of failure worth designing out rather than documenting.

### 6.2 The settings registry

**Every setting is declared in code**: key, schema, default, label, help text, category, and when a
change takes effect. **The database stores overrides only.** Three properties follow, and they are the
whole reason for the shape: a fresh database boots fully working with nothing to seed; the editing
surfaces are generated from the declaration rather than maintained alongside it; and a value has one
type in one place, so a guard reading a setting gets a number rather than an unknown.

| Key | Type · default | Category | Takes effect | Meaning |
|---|---|---|---|---|
| `capacity.tab_budget` | int, **15** | Capacity | `next_claim` | Total tabs across **both** browsers. There is no per-browser cap: the scarce resource is renderer processes and one costs the same in either browser (`DECISIONS.md` §6). **Provisional** — reasoned from roughly 50–150 MB per idle renderer plus two browser processes, so fifteen is one to two gigabytes |
| `lease.max_tabs_per_claim` | int, **4** | Capacity | `next_claim` | The most one claim may hold. Stops a single caller legally taking the whole budget. **Provisional and the weakest number here** — four is a guess at how many tabs one review needs |
| `lease.active_ttl_seconds` | int, **600** | Lease | `next_claim` | Ten minutes. Long, because expiring an active holder destroys work in progress |
| `lease.queued_ttl_seconds` | int, **300** | Lease | `next_claim` | Five minutes. Shorter, because expiring a queued client costs it a place it can retake by asking again. Same rule, different price for getting it wrong (`DECISIONS.md` §13a) |
| `lease.reaper_interval_seconds` | int, **15** | Lease | `immediately` | How often the reaper sweeps. Fifteen seconds against a five-minute floor on any expiry means the worst-case delay in returning capacity is around 5% of the shortest lease |
| `lease.disconnect_grace_seconds` | int, **60** | Lease | `immediately` | Used only where the transport surfaces a disconnect (§2.4). Where it does not, this value is inert and the operations page says so |
| `browser.headless` | bool, **true** | Browser | `restart` | Headless is roughly an order of magnitude faster to drive at identical memory. `broker login` (§5.5.1) is the one headed path and it does not read this |
| `browser.profile_root` | string, **`.broker/profiles`** | Browser | `restart` | Each browser launches with `<root>/<id>`, explicitly, **never a default profile location**. A relative default is deliberate: it is machine-independent, and two installations in different working directories get different roots without either of them configuring anything |
| `browser.restart_backoff_seconds` | int, **5** | Browser | `immediately` | |
| `browser.restart_max_attempts` | int, **5** | Browser | `immediately` | After this the browser is `failed` and claims for it are refused. It does not retry forever, because a browser that has failed five times is failing for a reason a retry will not fix |
| `artifacts.root` | string, **`.broker/artifacts`** | Artifacts | `restart` | Four subdirectories: `captures/`, `snapshots/`, `crops/`, `baselines/`. Every stored path is relative to this (§1.7) |
| `capture.tier_default_px` | int, **1024** | Capture | `immediately` | Long edge for a capture that passes no tier. **Provisional** — `MILESTONES.md` #34 exists to settle it with evidence |
| `capture.tier_detail_px` | int, **1568** | Capture | `immediately` | The ceiling of the cheap vision tier |
| `capture.tier_max_px` | int, **2576** | Capture | `immediately` | The top of the high-resolution tier. Requires a `reason` |
| `capture.full_page_default` | bool, **false** | Capture | `immediately` | Unbounded page height crosses the long edge more often than width does |
| `capture.warn_after_per_claim` | int, **12** | Capture | `immediately` | Captures per claim before every subsequent capture carries a warning. **Never a refusal** — §7 carries the assertion |
| `capture.file_retention_days` | int or null, **14** | Retention | `immediately` | Deletes capture *files*. **The rows are never deleted**, so the dimensions, tiers, reasons and token estimates the ladder study needs survive a disk that does not |
| `evaluate.inline_byte_cap` | int, **4096** | Evaluate | `immediately` | Past this, a result spills to a path |
| `evaluate.max_expression_bytes` | int, **8192** | Evaluate | `immediately` | |
| `compare.default_aa_threshold` | real, **0.1** | Compare | `next_baseline` | The starting threshold a new baseline takes. It is the diff library's own default, which is a better starting position than a number invented here precisely because it is not one |
| `compare.min_region_px` | int, **8** | Compare | `next_baseline` | |
| `compare.max_regions` | int, **12** | Compare | `immediately` | Past this the result is truncated and says so. A page-wide change produces hundreds of regions, and returning them all is the outcome the feature exists to avoid |
| `privacy.store_urls` | `full` · `origin` · `none`, **`origin`** | Privacy | `immediately` | How much of a tab's address is stored in `tabs.last_url`. Defaults to the origin because a full history is the most sensitive thing this schema could hold and the operations page only needs to say *where*, not *what* |
| `retention.events_days` | int or null, **null** | Retention | `immediately` | Null keeps the ledger |

**Settings that are deliberately absent**, because each would be a policy this design has already
taken a position on and a setting is how a position quietly gets reversed:

- **No `capture.refuse_after`.** Nothing is ever refused on capture grounds, and a setting that could
  turn a warning into a wall would make that promise conditional (`DECISIONS.md` §13d).
- **No `capacity.per_browser_budget`.** One counter, on purpose (`DECISIONS.md` §6).
- **No `browser.count` and no third-browser flag.** Exactly two, no exceptions, ever
  (`DECISIONS.md` §13c).
- **No switch that disables the off-loopback warning** (§4.1). A warning you can turn off is a warning
  nobody sees.

### 6.3 Resolution, caching, and disagreement

**Resolution.** Start from the registry defaults, apply any override that validates, freeze. The
output is a typed snapshot, not a lookup table.

**One snapshot per service call**, resolved at the entry and threaded through, so every guard inside
one transaction sees one configuration. Re-reading per guard would let two checks in the same
transaction disagree — a bug that would appear roughly never and be impossible to reproduce.

**Caching.** The long-lived process holds the snapshot and re-reads `settings_revision` at most once
every few seconds. The guarantee is therefore explicit and small: a change is visible immediately in
the process that made it, and within the revalidation interval everywhere else. A command-line
invocation builds a snapshot once and exits, so it is always current.

**When the registry and the stored overrides disagree, the registry wins and says so.**

| Situation | What happens |
|---|---|
| An override exists and validates | It is used |
| An override exists and fails its schema, because the schema tightened | **The default is used**, the key is logged at startup, and `GET /settings` shows the stored value beside the validation error. Not a boot failure — refusing to start because a bound moved turns a configuration nit into an outage. Not silently coerced either: a coerced value is one nobody chose |
| An override exists for a key the registry does not declare | The row is **inert**, listed as unrecognised, and never deleted. Deleting data on deploy loses the record of what somebody had configured |
| A default changes in a version | Every installation that never overrode that key changes behaviour on upgrade. **That is a behaviour change and is treated as one** — it belongs in release notes, not in a diff nobody reads |

### 6.4 Build constants

Fixed by the version, not configurable: the tool schema block and its descriptions; the protocol
version the MCP adapters speak; the guard registry (§7); the image-token estimate formula
`ceil(width × height / 750)`; and the enum values in the schema.

**The token formula is a constant rather than a setting on purpose.** A stored `estimated_tokens` was
computed by a specific formula, and letting an operator change the formula would silently make old and
new rows incomparable — which would break the one study the column exists for.

---

## 7. Guards

Every rule stated as a rule, with the refusal it produces. **A guard that never refuses anything
protects nothing, so the refusals are the specification**, and every row here owes a test that fires
it (`MILESTONES.md` M3's done condition).

Guards come in three enforcement classes, and mixing them up is how a rule ends up unenforced:

- **Per-call** — evaluated inside the service operation. Refuses that call.
- **Startup** — evaluated once at launch. Refuses to *serve*.
- **Build** — evaluated by a check in continuous integration. Refuses to *ship*.

### 7.1 Per-call guards

| id | Rule | Refuses with |
|---|---|---|
| `key.present` | Every operation except `claim` carries a key | `key_missing` |
| `key.valid` | The presented key hashes to a claim | `invalid_key` |
| `claim.live` | That claim is `queued` or `active` | `claim_not_live`, naming the state and `ended_at` |
| `claim.session_single` | A session has at most one live claim | `session_already_holds_claim`, naming the claim id, state and expiry |
| `claim.browser_known` | `browser` is `regular` or `private` | `unknown_browser` |
| `claim.per_claim_cap` | `tabs ≤ lease.max_tabs_per_claim` | `tabs_exceeds_per_claim_cap` |
| `claim.within_budget` | `tabs ≤ capacity.tab_budget` | `over_budget`. **Refused, never queued** — a claim that can never be admitted must not wait for something that will not happen |
| `capacity.admission` | `live tabs + requested ≤ capacity.tab_budget`, counted over `tabs` rows in `opening`, `open` or `closing` | **Not a refusal.** This is the predicate that decides `active` against `queued`, and it is the only guard whose failure is a successful outcome |
| `tab.owned` | The tab's `claim_id` equals this claim's id | `tab_not_found` — **the same code and message as an unknown tab**, so probing cannot enumerate another claim's tabs |
| `tab.open` | The tab's state is `open` | `tab_not_open` |
| `grant.available` | `tab_open` only within `tabs_requested` | `grant_exhausted`, naming the count, the grant and `browser_tab_close` |
| `browser.serving` | The browser's state is `running` | `browser_unavailable`, with a retry hint. Covers `login`, `failed`, `starting` and `stopped` |
| `browser.busy_for_login` | `login` refuses while any live claim holds tabs on that browser | `browser_busy`, naming the claims |
| `navigate.scheme_allowed` | `http`, `https` or `about:blank` | `invalid_url`. **`file:` is refused explicitly**: it turns a browser lease into an arbitrary read of the host's filesystem, which nothing in this contract intends to grant |
| `capture.max_tier_reason` | `tier: "max"` carries a `reason` of 8–200 characters | `reason_required`. **The only capture argument refusal that is about anything other than a malformed argument, and it is about recording rather than about cost** |
| `capture.exclusive_mode` | `selector` and `full_page` are not both given | `selector_and_full_page` |
| `evaluate.expression_bounded` | The expression is within `evaluate.max_expression_bytes` | `expression_too_long` |
| `compare.baseline_exists` | A live baseline exists for that view and breakpoint | `baseline_missing`, naming the promote operation. **A refusal on purpose**: silently reporting "nothing changed" with nothing to compare against is indistinguishable from working |
| `compare.capture_owned` | The capture belongs to this claim | `capture_not_found`, non-disclosing, same shape as `tab.owned` |
| `revoke.reason_required` | A revoke carries a reason | `reason_required` |
| `read.cookies_no_values` | A cookie read returns name, domain, path, expiry and flags | **Not a refusal — a shape.** The `value` field is absent, not masked. Asserted by seeding a cookie with a known string and asserting that string appears in neither the response nor the written file |

### 7.2 Startup assertions — the service refuses to serve

These come from the concurrency work the design rests on, and each one guards a failure that is
**silent**: the operation succeeds and returns something wrong.

| id | Rule | On failure |
|---|---|---|
| `launch.explicit_profile_dir` | Every browser launches with an explicit profile directory the service owns, resolved from `browser.profile_root`. **Never a default profile location** | Refuse to launch. `browsers.state = 'failed'`, `last_error` set, `broker serve` exits non-zero. This is the *inward* half of bidirectional isolation: a default location is shared with anything else that also takes the default, and two processes on one profile contend on its lock file, so an unrelated run that started first would stop this service starting at all (`DECISIONS.md` §6a) |
| `launch.default_args_intact` | The resolved launch arguments are the automation library's defaults **plus** what this service adds — never its defaults minus anything | Refuse to launch. The defaults include the flags that keep background tabs unthrottled and the flag that makes background capture work; stripping them is how a service becomes mysteriously slow and mysteriously wrong at once |
| `launch.screenshot_surface` | The resolved arguments contain the new-surface capture feature flag, **and** the environment does not carry the switch that selects the older capture path | Refuse to serve. `browsers.surface_verified = false`, and the browser never reaches `running`. Without the new surface, capturing a background tab in a headed browser is slow, flaky and sometimes returns the wrong tab — and it does so **without an error**, which is precisely why this is a refusal to start rather than a warning |
| `startup.reconcile_before_serve` | Boot reconciliation (§2.6) completes before the listener accepts | Refuse to serve. Serving against an unreconciled capacity count is either refusing work for no reason or overshooting the bound, and only one of those is loud |
| `startup.migrations_applied` | The schema is at the version this build expects | Refuse to serve, naming the gap |

### 7.3 Build checks — the service refuses to ship

Two prohibitions cannot be expressed as a runtime check, because the correct behaviour is that the
call **never happens**. A rule with no call site is not a guard, so each of these is enforced twice: a
source-level check that fails the build, and a fake-driver assertion that the call log never contains
it.

| id | Rule | Enforced by |
|---|---|---|
| `foreground.never_moved` | **The service never brings a tab to the foreground.** It is the only action that would move what a person is looking at, and background tabs accept every operation and capture correctly without it | A source check failing on the identifier anywhere outside the one file that documents the prohibition, plus a fake-driver assertion that no call log across the whole suite contains it |
| `capture.surface_required` | **No capture is ever taken with the from-surface option disabled.** In a headed browser it returns *another tab's pixels*, with no error — a wrong answer that looks exactly like a right one | Same pair: a source check, and an assertion that no recorded capture call carries the option |
| `browser_scoped.never` | **No registered operation is browser-scoped and destructive**, on any adapter. No close-browser, no close-all, no delete-profile-data | The operation registry is typed so that an operation declaring a browser target and a destructive effect does not compile. Adding one fails the build rather than the review |
| `driver.import_isolated` | Only the driver module imports the automation library | An import allowlist |
| `db.import_isolated` | Only the service layer, the settings resolver, and migrations and seeds import the database client | An import allowlist. **Stated as an allowlist rather than a denylist of route directories**, because a denylist is wrong the first time somebody adds a directory nobody thought of. If an adapter cannot reach the database except through a service, it cannot bypass a rule — not because it was reviewed carefully, but because it will not build |
| `settings.no_secrets` | No registry key is credential-shaped | A registry test failing the build. `GET /settings` is unauthenticated and prints every value, so a key whose value would be unsafe to read aloud is in the wrong tier (§1.10) |
| `capture.never_refused_for_cost` | **No code path refuses a capture for budget or resolution reasons.** This is an anti-guard: it asserts an absence | A test that takes several hundred captures on one claim and asserts every one succeeded, that the warning fired past the threshold, and that it fired on **every** capture past it rather than once |

### 7.4 The one that is only a warning, and stays one

`ops.loopback` — binding off `127.0.0.1` publishes an unauthenticated revoke, an unauthenticated
settings write and a page describing everything in flight. The service **warns loudly at every
startup** and serves anyway (§4.1). It is listed here rather than left out because a warning that is
not in the guard list is a warning nobody maintains.

---

## 8. Adapter conformance

Every way in — MCP over HTTP, MCP over stdio, HTTP/JSON, and the command line on each of its two
bindings — is a thin shell over one service call. **That is a claim, and this is the test that makes
it true rather than intended**, because the failure it guards against is silent: a rule implemented
inside an adapter is enforced for that adapter's callers and for nobody else, and nothing reports it.

### 8.1 The shape

**One driver per adapter, behind one interface**, in a map typed from the **adapter registry** — the
module the application mounts its adapters through, so the names are load-bearing at runtime rather
than a list maintained for a test. The registry's key type is the map's key type, so **adding an
adapter without adding its driver does not compile.**

**Cases are authored once per operation, never per adapter.** A case names an operation, a seed, an
input, and an expectation: accepted, or refused with a specific code and guard. The runner takes the
cross product with every driver exposing that operation, so a case costs nothing per adapter — which
is what stops the suite decaying at the point where writing cases becomes tedious.

### 8.2 What "the same operation through a different transport" is asserted to mean

1. **Identical outcomes.** The same acceptance, or the same rejection `code` and `guard`, from every
   driver. **Message text is deliberately not compared** — a terminal and a tool result should word
   things differently, and asserting text is brittle and a weaker claim than asserting the code.
2. **Identical side-effects.** §8.3, and it is the assertion specific to this application.
3. **Every operation has an accepting case and a refusing case.**
4. **Every registered guard appears in at least one *observed* refusal**, computed from the `guard`
   identifier the service returned, never from what a case declared — a case can name one rule while
   the service refuses on another. A new guard therefore fails the build until it has a case, and
   nobody has to remember to write per-adapter tests for it. **This is the assertion that keeps the
   suite honest a year from now.**
5. **Adapter completeness.** Every operation an adapter exposes maps to a registered service
   operation, and anything it deliberately does not expose carries a written waiver (§8.4).

### 8.3 The assertion this application needs and a conformance suite usually does not

A browser lease has a physical side. **A refusal that arrives after the tab already opened is not a
refusal** — it reports something that did not happen, and everything downstream believes it.

So the fake driver records every call it receives as `(operation, arguments)`, and a refusing case
asserts **two** things:

1. **The driver call log for that case is empty.** No tab was opened, nothing navigated, no file was
   written.
2. **The live tab count is unchanged**, read from the same predicate the capacity guard uses.

**Both, because they catch different bugs.** A guard that opens a tab and then closes it on the way to
refusing leaves the count unchanged and the log full. A guard that decrements a counter without
telling the driver leaves the log empty and the count wrong. One assertion each would let one of those
through, and the second is the one that quietly costs a unit of budget on every refusal.

**This is why the fake driver lands early** (`MILESTONES.md` #19) rather than arriving late as a
testing convenience: every rejection test written before it exists can only assert a response, which
is the assertion that proves the least.

### 8.4 Waivers, and how they stay bounded

Ops-only commands have no counterpart on the tool surface — `serve`, `doctor`, `login`, `init`,
`config`, the baseline commands, the operations reads. Each carries a **written waiver with a reason**
in one reviewed file, printed in the continuous-integration summary.

**Bounded by construction rather than by review attention:** no operation any registered guard can
refuse may be waived by an adapter that exposes any write operation. An adapter is read-only by
declaration, or fully covered, with nothing in between. Without that rule, a driver that declines to
expose anything passes assertion 1 vacuously.

### 8.5 Negative controls — one per claim

Each asserted to **fail**, because an assertion nobody has watched fail is an assertion nobody has
tested:

- a fixture adapter reaching past the service layer to the database;
- a registered guard with no case;
- a driver returning a different code for the same input;
- an operation with only an accepting case;
- **a refusing case whose fake-driver log is not empty** — the control for §8.3;
- **a refusing case that leaves the live tab count moved** — the second control for §8.3;
- an adapter exposing an operation the registry does not know;
- **and a direct assertion that the guard registry is not empty**, because an assertion evaluated over
  an empty set passes forever and silently.

### 8.6 Cost

Run in-process wherever the process boundary is not the thing under test — call the HTTP handler
directly, drive the command line through its entry point with an argument vector. Keep a much smaller
spawned smoke subset (a real process, a real stdio session, a real database) as its own job. The
in-process matrix runs on every change; the spawned subset proves the wiring and does not grow with
the case table.

---

## 9. Open, and deliberately so

### 9.1 Genuinely undecided

1. **How the partial unique indexes are enforced** (§1.11) — a hand-written migration with a
   documented drift-check exception, serialised application-level enforcement behind an explicit lock,
   or a maintained nullable column with a total unique index. Owned by `MILESTONES.md` #13, decided
   with the transaction shape in front of it. **What is settled is that all three indexes take the
   same answer**, or the drift check ends up carrying two kinds of exception.
2. **Strict first-in-first-out against skip-ahead with aging** (§2.5). Strict is written here, and its
   cost is that a four-tab claim blocks smaller ones behind it. Skip-ahead serves more callers sooner
   and starves the largest requests, which is worse in a way that is harder to see. Worth a ruling
   because it is easy to argue for once and hard to reason about later.
3. **Whether page-scope evaluation on the signed-in browser is acceptable** (§3.10). The position
   taken is that a lease on that browser already grants acting as the signed-in user, so evaluation
   widens nothing except what the record can see — and every expression is recorded. The alternative
   is to refuse `evaluate` on `regular` and allow it only on `private`, which costs the cheapest and
   most accurate measurement path on the browser where most stateful work happens.
4. **The `privacy.store_urls` default** (§6.2). `origin` is chosen. `full` makes the operations page
   and the audit trail far more useful and turns the database into a browsing history; `none` makes
   *"what is this claim doing"* unanswerable beyond its stated purpose.
5. **Whether the operations surface stays unauthenticated when bound off loopback** (§4.1). Warning
   loudly is chosen. The alternative is a shared token in the environment tier, which is small — and
   is a user model arriving one field at a time, which is exactly how one arrives.
6. **`reason` on the `max` tier: free text or a fixed set** (§3.11). Free text is chosen so the study
   can read what people actually say. The risk is that it fills with *"needed the detail"*, at which
   point a fixed set of three or four reasons becomes the better instrument.
7. **The licence** (`DECISIONS.md` §14), which blocks publication and is the owner's to choose.

### 9.2 Where this document supersedes an earlier one

Each of these is a change, not a clarification, and is listed so nobody reconciles them by accident.

| | |
|---|---|
| **"One active lease per tab" is not a partial index** | It is structural: `tabs.claim_id` is `NOT NULL` and immutable, so a tab has exactly one owner by construction. Two *other* partial unique indexes appear instead, plus one partial non-unique index (§1.11) |
| **There is no `renew` operation** | Every keyed call renews, so a dedicated verb would be a second name for one effect — and two names for one effect is how a caller comes to believe one of them does not renew. `browser_status` is the call that does nothing else (§3.3) |
| **The capacity counter is over `tabs` rows, not over a claim's requested number** | `DECISIONS.md` §6 says `total open tabs + requested ≤ budget`. That sentence is literally true here because the tab rows exist from the moment of admission, so a grant and its rows are the same number and the bound cannot be overshot by a claim that has not opened its tabs yet (§2.3). Read the other way — counting only tabs that are physically open — the bound is violable, which is why this reading was taken |
| **Eleven tools, not ten** | `browser_compare` is the marginal one, and its condition is that it stays one operation with baseline management on the operations surface (§3.1) |
| **Capture accounting warns per capture, not once** | A warning that appears once has scrolled away by the time it matters (§3.11) |
| **A `comparisons` table exists** that the skeleton did not list, justified by threshold tuning being unanswerable without one (§1.9) |

### 9.3 Numbers that are provisional, and what settles each

| Number | Settled by |
|---|---|
| `capture.tier_*_px` — 1024 / 1568 / 2576 | `MILESTONES.md` #34, the resolution ladder. Expect **more than one threshold**: text stops being legible before layout critique stops working |
| `capacity.tab_budget` — 15 | Watching real memory at real concurrency. The reasoning is 50–150 MB per idle renderer plus two browser processes; the measurement is what turns that into a number |
| `lease.max_tabs_per_claim` — 4 | The weakest number in the document. Settled by how many tabs a review actually uses, which the `claims` rows will say within a week of real traffic |
| `capture.warn_after_per_claim` — 12 | The `captures` and `comparisons` rows. Twelve is roughly a five-view sweep at two breakpoints plus slack |
| `compare.default_aa_threshold` — 0.1 | `MILESTONES.md` #43's fixture set, whose negative direction is the one that matters: a change small enough to be interesting must survive the threshold in force |
| `lease.*_ttl_seconds` — 600 / 300 | Whether real callers renew often enough. The `renew_count` column is what says so |

### 9.4 One thing to verify before the driver is trusted

**The concurrency properties this design rests on were proved against the automation *library*** —
that background tabs accept every operation, that capture never moves the foreground, that fifteen
concurrent tabs neither serialise nor contaminate each other. **The driver reaches those properties
through a command-line tool layered over that library**, and a layer can add a foreground move or
change a launch argument without saying so.

`launch.screenshot_surface` and `launch.default_args_intact` (§7.2) are the assertions that check the
flags survived the indirection, and `foreground.never_moved` (§7.3) checks this service does not add
one. **Neither covers the case where the tool itself moves the foreground on some operation nobody has
exercised yet**, so `MILESTONES.md` #20 owes one empirical check on the real driver: drive a
background tab through navigate, act and capture, and assert the foreground has not moved. That is a
test, not a code read, and it is the last place a proved property can quietly stop being true.
