# Browser Broker — the concrete shape

**Status: not written yet. This is a stub, and deliberately so.**

This document is the output of the **design interview** — the pass where the owner is asked, question
by question, what each surface should actually look like, and the answers are written down concretely
enough to argue with. It is written *after* that conversation, not before it, because inventing a
schema now would pre-empt exactly the answers the interview exists to collect, and a specification
nobody chose is one that gets discovered to be wrong during the build rather than during a review.
Everything below is the section skeleton it will fill.

**The rule this document is held to: if a reader cannot disagree with it, it is not specific enough.**
"The claim table records the lease" is not a specification. A column, its type, its nullability, what
it is *for*, and what breaks if it is missing — that is one. Sections are numbered so a review
comment can cite `§4.2` rather than "the bit about the queue".

**Until this is settled, `MILESTONES.md` is provisional.** The interview will change what the work
is, not merely its order.

---

## 1. Tables

Every table, every column, every constraint, and what each one is *for*. Expected:

- **`browsers`** — a fixed two-row table: the regular (persistent, signed-in) browser and the private
  (ephemeral) one. Fixed rows, not a collection. **There is no profiles table and no named-profile
  concept**; a purpose-named profile is a purpose-named tab on the regular browser (`DECISIONS.md`
  §6).
- **`claims`** — the lease: its secret key, its state, which browser, how many tabs, its stated
  purpose, its expiry, and the timestamps that make the state machine auditable.
- **`tabs`** — opaque tab identifiers, which claim owns each one, and the mapping to whatever the
  driver calls them.
- **the queue** — either its own table or a view over `claims`; the decision, and its reason, belongs
  here.
- **`events`** — append-only, one row per decision, **allow and deny alike**. A gate that only
  records refusals cannot answer "was this ever actually running".
- **`captures`** — dimensions, bytes, what it was downscaled from, and an estimated token cost, so
  the capture policy's defaults can be replaced by evidence.
- **`baselines`** — a baseline image per view and breakpoint, its identity, when it was promoted and
  from what, plus the comparison threshold in force for it (`DECISIONS.md` §13a).
- **`settings`** — overrides only; the typed registry is declared in code so a fresh database boots
  working.

Also to be settled here: the two constraints that want **partial unique indexes** — one live claim
per session, one active lease per tab — and which of the two available answers is taken
(`DECISIONS.md` §13b).

## 2. Lease states and transitions

The five states, every transition, what triggers each, and — the part that matters — **what each
transition refuses and with what message.** A transition table without its rejections is half a
specification.

## 3. MCP tools

For each tool: its name, its arguments and their types, its return shape, its rough behaviour, and
**what it refuses**. Deliberately small — around ten — because every description is resident in a
connected session's context on every turn.

Includes the comparison operation for changed-region review: **one operation, not a family**
(`DECISIONS.md` §13a). Baseline management belongs on the operations surface rather than in the
agent-facing tool list.

This section also carries the **deliberately absent** list, which is part of the contract: nothing
browser-scoped and destructive, nothing that attaches to a browser the service did not launch,
nothing that reads or writes credentials, and no implicit current tab.

## 4. HTTP endpoints

Same treatment: path, method, request shape, response shape, status codes, and what each refuses.
Includes the read-only endpoint the operations page consumes.

## 5. Command-line surface

Every `broker` command: its arguments, its output in both human and machine-readable form, its exit
codes, and what it refuses.

## 6. Configuration

Every setting, its type, its default, and what it means. Plus the rule that decides where each one
lives: **what must be known before the database is reachable is an environment variable; everything
else is a settings row.** Anything machine-specific is a setting, never a literal.

## 7. Guards

Each rule stated as a rule, with the rejection it produces: ownership, capacity, budget, state
preconditions, and the operations that are refused unconditionally.

Every guard here must be enforced somewhere executable. **A property that is only written down is not
a property** (`DECISIONS.md` §12).

## 8. Adapter conformance

What "the same operation through a different transport" is asserted to mean: identical outcomes,
identical refusals, and — because a browser lease has a physical side — **identical side-effects**. A
refusal that arrives after the tab already opened is not a refusal. Registering a new adapter is
mandatory: adding one without adding it to the suite must itself fail.
