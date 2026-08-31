# Rollout runbook

**How to go from an installed broker that arbitrates nothing to one that is the sole route to the
browsers — without ever passing through a state where some callers are brokered and others are not.**

That last clause is the whole point of this document, so it is worth being blunt about why. This
service exists because unarbitrated browser use caused a process explosion: several callers each
started their own browser, nothing counted them, and the ceiling that everybody assumed existed did
not. **A rollout with a window in which some traffic is brokered and some is not reproduces exactly
that failure**, and it reproduces it at the worst possible moment — while somebody is watching a
dashboard that says the broker is working, because from the broker's side it is. The brokered half
is counted correctly. The unbrokered half is invisible.

So the ordering below is not a sensible sequence among several that would work. **Each step is
forced**, and each one says by what.

---

## Before you start

Install and first-run are documented in the [README](../README.md) — `npm install`, then
`broker init` → `broker login` → `broker doctor`. Do that first; this document assumes a checkout
that already passes `broker doctor`. Nothing here repeats those steps.

**One prerequisite `npm install` does not cover: a browser binary.** This repository depends on
`playwright-core`, not the full `playwright` distribution, precisely because the browser binary is
spawned by this service, detached and by path (`src/browser/real.ts`) rather than downloaded and
managed by the package. **`playwright-core` does not download a browser on install.** A checkout
that has never had one fetched by some other tooling has none, and `broker doctor`'s automation
check (below) will genuinely fail with exit code 11 rather than silently reading as unevaluated —
that check is now wired to a real probe rather than always defaulting to absent. Fetch one with:

```bash
npx playwright-core install chromium
```

Run this once per machine, before `broker doctor`. It is the same install mechanism the full
`playwright` package would run automatically on `npm install`; `playwright-core` just does not run
it for you.

Two things this runbook uses throughout:

- **`broker doctor`** reports every precondition separately and exits with a **distinct code per
  failing group**, so a script can branch on *which* precondition failed rather than on "something
  is wrong". The codes are below, and they are the mechanism that makes each phase gate checkable.
- **`broker events`** reads the ledger. Every decision is appended to it, **allows and denies
  alike**, which is what lets you answer "is anything still going around the broker" with evidence
  rather than with an opinion.

### The doctor's exit codes

Read from `src/doctor/checks.ts`. On multiple failures the **lowest** code wins, so a script that
branches on the code is told about the most fundamental problem first.

| Code | Group | What failed |
|---|---|---|
| `0` | — | Every evaluable precondition passed |
| `10` | store | Where the store is, what filesystem it is on, what version it is at |
| `11` | automation | The automation tool is absent or unusable |
| `12` | roots | An artifact or profile root is not writable |
| `13` | browsers | A browser's discovery record does not check out |
| `14` | capture | The capture-surface check |
| `15` | keeper | A keeper tab is missing |
| `16` | budget | The stored tab budget disagrees with this process's environment |

**A `[--]` line is not a failure.** Checks that had nothing to examine are reported as unevaluated
and explicitly do not affect the exit code — the report says so at the bottom. A fresh install
legitimately shows nine or more of them.

---

## Phase 0 — Install, sign in, and arbitrate nothing

**Goal:** the broker is installed and healthy, and **no caller is pointed at it yet**.

This phase is where the one manual step happens, and it happens here for a forced reason: signing in
requires driving a browser window by hand, and `broker login` **refuses if any live lease holds a tab
on that browser**. Once callers are pointed at the broker there will be leases, and every sign-in
attempt becomes a race against them. Sign in while there is provably nobody to race.

```bash
broker init      # creates the store and both browser profiles; reports created vs found
broker login     # opens the shared browser headed; you sign in by hand
broker doctor    # confirms it took, without opening a browser
```

### The one-time sign-in — what actually happens

`SCHEMA.md` §5.5.1 says *"nothing is stopped and nothing is relaunched"*. **That sentence assumes a
browser is already headed and running.** The shipped behaviour has a seam worth knowing about, and
it is documented here rather than smoothed over:

- **If a browser is already running against that profile, `broker login` adopts it.** Same endpoint,
  same process id, nothing relaunched — the §5.5.1 description holds exactly.
- **If no browser is running, `broker login` starts one, and says so.** It prints:

  > `No browser was running against this profile, so one was started for you to sign into.`

  This is the ordinary case on a fresh install, because nothing has launched a browser yet. It is
  not a fault and it loses nothing — there was no session to lose. **But the honest reading of
  §5.5.1 is that it describes the adoption path, and the start path exists too.**

**Ending the sign-in: close the window.** Closing it is what ends the step. While it is open the
browser serves nobody: requests for it are refused with a retry hint, and **queued callers keep
their places and their timers** — a sign-in is a pause, not a cancellation.

**On interrupting a sign-in.** An interrupted sign-in is now recoverable: a browser left in
`signing-in` whose owning process is gone is reclaimed, and `broker doctor` carries a check for it
(*"No sign-in has been abandoned on the … browser"*). A **live** sign-in is never stolen. However, a
catchable interrupt could not be reliably delivered on every platform — on Windows in particular, the
default disposition terminates the process without unwinding, so the handler that would clean up may
never run. **Both facts are true, and the advice that follows from them is: close the window rather
than pressing Ctrl-C.** The recovery path is a safety net for the case where you had no choice, not
the intended way to finish.

Two refusals, both deliberate:

- **A browser with live work on it** — it names the leases holding it. Waiting is enough; every
  lease expires on its own if its holder stops calling in.
- **The private browser** — its profile is discarded on exit, so a sign-in there would appear to work
  and leave you signed into nothing.

### Verify phase 0

```bash
broker doctor            # expect exit 0
```

The sign-in line should read `[ok ]` and report a stored cookie count. If it reads `[--]`, that is
the *absence of evidence*, not evidence of absence — a site that keeps its session only in local
storage looks identical, and a browser that is still running may not have written its cookies down
yet. **The doctor never reports a missing sign-in as a failure**, because a profile with no session
is the ordinary state of every installation until somebody signs in.

### Back out of phase 0

Delete the store file and the profile root. Nothing outside them has been touched, and no caller was
ever pointed here. This is the only phase whose reversal is unconditional.

---

## Phase 1 — Set the budget deliberately, before any caller arrives

**Goal:** the tab budget is a number somebody chose, recorded, and can name — **before** anything
arbitrates against it.

### Why this phase is forced to come before callers, not after

The tab budget is the one configuration value several processes must **agree** on. Every spawn
arbitrates against it simultaneously; if one process believes fifteen and another believes thirty,
each admits callers correctly against its own belief and **the ceiling silently stops being a
ceiling**. Nothing reports it. The count is right in every process and the machine is over budget
anyway — which is the original failure, wearing the broker's uniform.

So the design records the budget in the store: **the first process to open the store writes its
budget in, and a later process whose environment disagrees refuses to start and names both numbers.**
Neither number is adopted and neither overwrites the other, because both accommodating answers are
worse than a refusal — adopting the stored value runs a process against a bound nobody configured for
it, and overwriting lets the most recently started process move a bound the others are
mid-arbitration against.

**Set it once, in one place, before the first caller.** If several machines or several shells will
spawn the broker, they must all carry the same `BROKER_TAB_BUDGET`, or the ones that disagree will
refuse to start.

> ### ⚠️ Known gap — this refusal does not fire in the shipped executable
>
> **Verified on this revision, and it is the most important caveat in this document.**
>
> The check (`budget.agrees_with_store`) is implemented in `src/store/budget.ts` and is called from
> `prepareStore` in `src/store/open.ts`. **The shipped executable does not go through
> `prepareStore`**: `createRuntime` in `src/service/runtime.ts` calls `openStore` and `stepSchema`
> directly and never calls `agreeOnTabBudget`. `prepareStore` has no production callers at all — only
> the test helpers use it.
>
> The observable consequence: after `broker init` with a budget set, the `tab_budget` table is still
> **empty**, and `broker doctor` says so in as many words —
> *"No budget has been recorded in this store. The first process to open it records the value it
> believes."* Two processes configured with different budgets both start without complaint.
>
> **Until that is fixed, the budget agreement is a convention you enforce, not a guard the product
> enforces.** Treat a single shared environment definition as mandatory rather than as a
> belt-and-braces nicety, and re-read this section once the gap is closed.

### A note on "a zero tab budget"

**`BROKER_TAB_BUDGET=0` is refused outright**, at startup, by the environment reader:

```
refused (config.value_readable): BROKER_TAB_BUDGET is set to zero. Expected a count of tabs
above zero; a value of zero is a configuration in which the service cannot serve anybody.
```

That refusal is correct — a service configured to serve nobody is a configuration nobody chose on
purpose. **So "start from a zero budget" cannot be taken literally as an environment setting.** What
it means in practice is *start from a state where the broker grants nothing*, and there are two
honest ways to reach it:

1. **Point no callers at it** (phase 0). This is the real zero: the budget is irrelevant because
   nothing is asking.
2. **Start at the smallest budget that is allowed, which is `1`**, and let exactly one lease exist at
   a time. This is the first increment, not the starting state.

This runbook uses reading (1) for phase 0 and treats `1` as the first real increment.

### What each increment buys

The budget is a count of **tabs across both browsers**, and a lease is exactly one tab, so the budget,
the pool bound and the number of live leases are one integer that cannot disagree with itself. Need
two tabs, claim twice.

| Budget | What it buys | What it costs |
|---|---|---|
| `1` | One caller at a time; everybody else queues. Every concurrency bug becomes a queueing question instead of a race. | Throughput is one. Any caller that holds a lease blocks all others. |
| `2`–`3` | Genuine concurrency, small enough that the queue is still exercised regularly and you can watch it work. | Contention is real; wait estimates start mattering. |
| Default `15` | Ordinary operation. | The queue becomes rare, so queue-path bugs stop being observed in normal use. |

**Increment deliberately, and only when the queue is boring.** The reason to raise the budget is that
callers are waiting longer than the work is worth — not that a higher number looks better.

### Verify phase 1

```bash
broker doctor            # expect exit 0; a budget disagreement would be exit 16
```

Given the gap above, **also check the value you believe is in force is the value every spawner
exports**. That is a check on your configuration management, not on the broker.

### Back out of phase 1

Lower the number and respawn. Nothing persists a grant beyond its lease, and every lease expires on
its own, so a reduced budget takes effect as the outstanding leases end. **Reducing the budget never
revokes a live lease** — it stops new ones being granted until the count falls below the new bound.

---

## Phase 2 — One caller, brokered, with every other route to a browser removed from it

**Goal:** exactly one real caller goes through the broker, and **that caller has no other way to a
browser.**

### Why "removed", not "preferred"

This is the ordering choice the whole document exists for. The tempting version of this phase is
*"point one caller at the broker and leave its old path in place as a fallback"*. **That is the
unarbitrated window, and it is worse than not starting.** A caller with a fallback takes the fallback
exactly when the broker refuses it — and the broker refuses it precisely when the budget is full,
which is precisely when another browser must not be started. The fallback converts the one moment the
ceiling is doing its job into the one moment it is bypassed.

So the rule is: **a caller is either brokered or it is not migrated yet.** For the caller you move,
every other route to a browser must be gone — not deprioritised, not behind a flag that defaults
to the broker, gone.
Callers you have not moved keep their old route entirely, and that is fine: they are a known,
countable, unmigrated set. **The thing that is never acceptable is a single caller that could go
either way**, because that is the one configuration where nothing can tell you which it did.

Pick the caller that is easiest to reverse, not the busiest one.

### Verify phase 2

```bash
broker doctor            # exit 0: preconditions still hold under real traffic
broker events            # the migrated caller's decisions appear here
broker snapshot --path ./ops.html   # a self-contained page; open it from disk
```

**Use each for what it is for:**

- **`doctor`** answers *"is this installation able to serve?"* Run it before and after each phase
  change, and in any readiness check. It changes nothing, so it is always safe.
- **`events`** answers *"what did it actually decide?"* This is the phase-gate evidence: the migrated
  caller's grants, queues and refusals should all be here. **An operation you know happened that has
  no ledger entry is the signal that traffic went around the broker.**
- **`snapshot`** answers *"what does it look like right now?"* It writes one self-contained HTML file
  labelled with the moment it was taken and exits — **a photograph, not a window; it does not
  refresh.** Generate it when you want to show somebody the current picture, not as a monitor.

**The specific thing to confirm before phase 3:** the migrated caller's operation count in the ledger
matches what you know it did. Equal counts mean it is fully brokered. Fewer ledger entries than
operations means something is still going around.

### Back out of phase 2

Restore that one caller's old route and stop pointing it at the broker. The broker keeps running for
nobody, which is phase 0. **Reversal is per-caller and complete**, which is why the phase moves one
caller rather than several.

---

## Phase 3 — Migrate the remaining callers, one at a time

**Goal:** every caller is brokered.

Repeat phase 2's move for each remaining caller. **One at a time, each with its old route removed as
it moves**, for the same reason: a caller mid-migration with two possible routes is the unarbitrated
window, and moving several at once means that if the ledger comes up short you cannot tell which one
is leaking.

**Raise the budget only between caller migrations, never during one.** Two variables changing at once
means a queue that got longer cannot be attributed to either.

### Verify phase 3

After each caller:

```bash
broker doctor            # expect exit 0
broker events            # the new caller's decisions are present and complete
```

The running check is the same one as phase 2, applied cumulatively: **total ledger operations should
account for all known browser work**. This is the only check that can detect the failure this
runbook is built to prevent, so it is the one worth doing carefully each time.

### Back out of phase 3

Per-caller, exactly as in phase 2. Because callers moved one at a time, backing one out returns you
to a state you were in and verified, rather than to an unvisited one.

---

## Phase 4 — Sole route

**Goal:** the broker is the only way to a browser, and you can demonstrate it.

### What "sole route" means

Not *"every caller is configured to use the broker"* — that is phase 3, and it is a statement about
configuration. **Sole route is a statement about capability: there is no route to a browser that does
not go through the broker, whether or not anything wants to take one.** The difference is the
fallback that nobody uses until the day something goes wrong.

### How you know you have arrived

All of these, together. Any one alone is weaker than it looks:

1. **No caller retains an unbrokered route.** Not disabled — absent. This is a code and configuration
   audit, not something the broker can tell you, because a route the broker never sees is exactly the
   thing it cannot report on.
2. **The ledger accounts for all browser work.** Every operation you can name has a corresponding
   entry in `broker events`. A gap here is a caller you missed.
3. **The browser process count matches the configuration.** The whole promise is that process count is
   bounded by configuration rather than by how many clients connect. Count the browser processes on
   the machine and compare against the two the broker runs. **A third browser process is the original
   failure, still present**, and it is the check most likely to catch a route the audit missed.
4. **`broker doctor` exits 0**, including the browser discovery records checking out for both
   browsers — meaning the browsers the store knows about are the browsers that are actually running.

Point (3) is the one to run last and to trust most, because it is the only one that observes the
machine rather than the configuration.

### Back out of phase 4

**Phase 4 adds no mechanism, so there is nothing to reverse.** It is the removal of the last
alternate routes plus an audit. Backing out means restoring a route for a specific caller, which is
phase 3's reversal. **Keep whatever you removed in version control** so that restoring it is a revert
and not a reconstruction — that is what keeps this phase reversible at all, and it is the only
preparation phase 4 requires.

---

## What this document could not verify

**Every command quoted above was run against a real store on a real machine while writing this**, and
the outputs shown are real: the bare spawn, `init`, `doctor` (both the healthy exit 0 and a genuine
exit 10 against a network-path store), `snapshot` (confirmed to contain zero external references) and
`events`. The `BROKER_TAB_BUDGET=0` refusal and the empty `tab_budget` table were both observed
directly, which is how the phase 1 gap was found.

**What could not be verified, and why:**

- **The phase sequence itself has never been executed**, because there is no existing fleet of
  callers to migrate. The ordering is derived from the failure it must avoid and from behaviour that
  was verified command by command — but **no rollout has been performed against this document**, and
  it should be treated as a design for one rather than as a transcript of one.
- **The budget-disagreement refusal could not be demonstrated**, because it does not fire
  in the shipped executable. The gap box in phase 1 is what was observed instead.
- **The multi-caller ledger-completeness check is described but not exercised.** With no real callers
  there was nothing to count, so the check's *shape* is verified (the ledger records allows and denies
  alike, and `broker events` reads it) while its use as a phase gate is not.
- **Checks that need a live, running browser still report `[--]` on a machine where nothing has
  launched one** — the keeper-tab, capture-surface and discovery-record lines were seen in their
  unevaluated form only, and that is unchanged. (The automation-tool *presence* check, above, is a
  different question — "is a browser binary resolvable at all" rather than "does a browser have a
  process running right now" — and it is wired to a real answer rather than always reading as
  unevaluated.)

**Anything below that line is a claim about behaviour that was tested. Anything in it is a claim
about a process that has not been run.** Do not read the two as carrying equal weight.
