# The cross-process contention suite

These tests spawn **real operating-system processes** and let them contend over one store file.
Everything else in `tests/` runs in process, deliberately — this directory is the exception the cost
rule names, because **here the process boundary is the thing under test**.

## Why this exists

The standing invariant of the whole design is that **writer serialisation holds only because every
arbitration path writes**. A "check status without sweeping" fast path would reopen the hole, and —
this is the part that matters — **it would pass a low-contention test suite**.

Two things guard that invariant and neither substitutes for the other:

| | What it proves | What it cannot |
|---|---|---|
| `scripts/check-arbitration.mjs` | The arbitration surface is narrow: no transaction is opened except through the one helper, that helper's literal declares intent to write, every registered operation is dispatched through the runner, and none can declare itself read-only | That the mode is what makes concurrency safe. It reads source; a savepoint and a bare statement both bypass a `BEGIN` scan |
| **This suite** | That real processes contending over one file actually serialise, and that the immediate mode is what delivers it | That every path in the tree takes that mode. It runs the paths it calls |

The check's own header names this suite as its counterpart, and says outright that it is not the
stronger of the two.

## What each file proves

| File | Property |
|---|---|
| `transaction-mode.test.ts` | 30 processes on `BEGIN IMMEDIATE` all commit, and no two read the same value. **25 on `BEGIN DEFERRED` with a widened read-then-write window are asserted to FAIL**, with a busy-snapshot error the busy timeout cannot retry |
| `arbitration.test.ts` | A budget of K under N racing processes yields exactly K grants and N−K queue placements — never K+1. No tab row is shared between two claims, and every claim a caller was told about is a row that exists |
| `queue-order.test.ts` | Positions handed out under contention are exactly 1..depth with no repeats. **A position never gets worse when callers share a `created_at`** — with the tie forced rather than raced |
| `sweep.test.ts` | A lapsed claim belonging to a session that never calls again is reclaimed by strangers, expired **exactly once** however many processes sweep it simultaneously, stamped with the moment it lapsed rather than the moment a sweep noticed, and its capacity is reissued |
| `budget-agreement.test.ts` | A process whose configured budget disagrees with the store's **refuses to start**, names the rule and both numbers, and does not overwrite the stored value |

## The two details the suite's honesty rests on

### The start barrier is load-bearing

Every child is handed one wall-clock instant and spins until it arrives, so the transactions
**overlap** rather than queue.

**Measured while building this:** without the barrier, process startup costs far more than the
transaction does, the children arrive spread out, each finds the store idle — and the deferred
control, the variant that is *supposed* to fail, **passed 25 of 25**. A suite shipping that would
have reported a green failing-control and proved nothing.

With the barrier the same run fails 21–24 times in 25, every run. `CONTENTION_LEAD_MS` in
`harness.ts` is generous on purpose: a child arriving after the instant does not wait at all, and
every child that misses it is one fewer transaction in the overlap. **Missing the barrier fails
open** — it quietly reduces contention while still reporting success — so the number is set well
above what is needed rather than trimmed to what is.

### The failing control is asserted, not observed

`transaction-mode.test.ts` asserts that the deferred run **fails**. If it ever stops failing, the
suite goes red and says why in the assertion message: a green deferred run means the processes did
not actually overlap, not that deferred is safe. **Do not relax that assertion to allow zero
failures** — the repair is to restore the contention.

Without it, the immediate arm going green is equally consistent with the mode mattering and with
there never having been enough contention to tell.

## What this suite does NOT prove

Stated plainly, because implying coverage it does not have is the failure mode these tests exist to
prevent:

- **Nothing about browsers.** No driver is supplied to any child, so no tab is ever really opened or
  closed. The claim row *is* the capacity, which is what makes that sound here rather than a hole —
  but the assertion that a browser round trip happens outside the transaction is **not in this
  directory**, and must not be read into it. That test needs a driver whose close call blocks, and it
  belongs with the row that owns the driver.
- **Nothing about a lease being renewed by its holder over time.** Every child here is a single-shot
  caller.
- **Nothing about release under contention.** Only `claim` is driven concurrently.
- **That every path in the tree uses the immediate mode.** That is a source fact and the build check
  is what checks it.
- **The double-issue refusal coming from the engine as a uniqueness-constraint error.** The
  specification asks for this, and this suite does **not** assert it: with capacity taken by the
  claim row rather than by a reserved tab, two processes racing for the last unit are serialised by
  the transaction and the loser is *queued* rather than refused by a constraint. The engine-level
  refusal would need a path where two callers write the same unique value, and the arbitration
  design does not produce one. The properties above are asserted instead, and this gap is named
  rather than papered over.

## Mutation results

Reviewers make these by hand. Each was applied to the tree, the suite run, and the change reverted.

| Mutation | Result |
|---|---|
| `BEGIN IMMEDIATE` → `BEGIN DEFERRED` in `store/transaction.ts` — **the headline one** | **Kills 3 tests**, 3 runs of 3: capacity, atomicity and queue positions. The transaction-mode pair survives by design, because it issues its own literal so the control stays independent of the source |
| `admits()` → `activeClaims + 1 <= budget + 1` | **Kills both** `arbitration.test.ts` tests — the K+1 the capacity assertion is named for |
| The sweep's `WHERE` made to match nothing | **Kills** `sweep.test.ts` |
| The sweep scoped to sessions resembling the callers | **Kills** `sweep.test.ts` — *after* the fix below |
| Budget refusal disabled, adopting the stored value instead | **Kills** the budget-disagreement test — the "helpful" change the specification names |
| Queue ordered by `created_at, id` rather than `arrival` | **Kills** the forced-tie test **5 runs out of 5** |
| `CONTENTION_LEAD_MS` → `0`, removing the start barrier | **Kills the deferred control**, which is the point: the control fails loudly rather than silently passing |

### One hollow test the sweep caught, and the fix

The caller-scoped sweep mutation **survived the first time**. The seeded dead caller was named
`session-that-died`, and the live children name themselves `session-0`, `session-1` — so a sweep
scoped by that prefix still reconciled the row, and the test passed with the defect present.

It is now `a-departed-caller-from-another-namespace`, which resembles no live caller by prefix or by
shape, and the same mutation kills it. This is exactly the failure the suite exists to catch, caught
in the suite itself.

## A finding about the startup path, recorded rather than asserted

**Processes spawning simultaneously against an *empty* store race in the schema stepper**, and some
fail with `table browsers already exists`. Two processes as well as eight; the count barely matters.

The mechanism is a check-then-act across a transaction boundary: `stepSchema` reads `user_version`
**outside** the transaction, decides there is work to do, and only then opens one. Two processes both
read zero, both decide to apply step one, and the loser runs a `CREATE TABLE` the winner has already
committed. It is the same read-then-write hazard the arbitration transaction exists to prevent, on
the one path that does not go through the arbitration runner.

`budget-agreement.test.ts` therefore steps the store before its own contention begins, so that a
failure there is attributed to the budget check rather than to the stepper. **The defect is recorded
here rather than asserted**, because asserting it would pin it in place as though it were intended.
It belongs to the row that owns the schema stepper.

## Cost, and where these run

Every test here spawns processes and waits out a start barrier, so the directory is **seconds rather
than milliseconds** — roughly 25–30 seconds in total. That is the price of the only evidence that can
distinguish a correct design from a lucky one, and it is paid on every platform in the matrix.

The suite runs on **all three test jobs** — `test (node 22.18)`, `test (node 24)` and
`test (windows)` — with nothing platform-specific and nothing skipped. Children are started with an
argument vector and no shell, so a path containing a space is not a quoting problem, and the barrier
is wall-clock rather than signal-based, so nothing depends on a mechanism one platform spells
differently.
