# CLAUDE.md — Browser Broker

**Browser Broker** brokers access to a small, fixed set of browsers: it hands out **leases over
tabs**, queues callers when capacity is full, reclaims capacity from callers that die, and enforces a
capture policy on everything that comes back out. The command you type is `broker`.

The stack is settled at the design interview and recorded in `DECISIONS.md`; the shape these docs
assume is a long-lived service over a relational store, with the image built in CI and **pulled**
where it runs rather than built on the host.

Plans live in [`docs/plans/`](docs/plans/): `PLAN.md` (how it works), `SCHEMA.md` (tables, tools,
endpoints, commands, settings, guards), `DECISIONS.md` (why, including what was rejected),
`MILESTONES.md` (the work, as PR-sized pieces with prerequisites).

---

## ⚠️ This repository is PUBLIC

Anything committed here is world-readable **the moment it is pushed, and permanently** — deleting it
in a later commit does not remove it, because that commit is still in the history. Assume anything
that lands here has already been read and indexed.

### Scan every commit before making it

Read the staged diff — all of it, not just the files you think you touched — for:

| Category | What to look for |
|---|---|
| **Credentials** | Tokens, passwords, API keys, bearer tokens, session cookies, connection strings carrying a password, private keys, any real `.env` |
| **PII** | Real people's names, emails, phone numbers, addresses, OS usernames, account handles |
| **Local paths** | Anything absolute — a drive letter, a home directory, a mapped drive, a network share |
| **Private infrastructure** | Internal hostnames, LAN addresses, private URLs and dashboards, port mappings that reveal a real deployment |
| **Private project names** | Names of the owner's other repositories, self-hosted services, or automation tooling |
| **Browsing surface** | Real site hostnames, retailer or bank names, machine names, browser-profile directory paths — see the rule below, which is specific to this repository |

```bash
git diff --cached          # read it, all of it, before every commit
```

Treat a finding as a **stop**, not a note to fix later — with one narrow, named exception below. Do
not read that exception as licence to grade anything else in the table more gently; it applies to one
thing only.

**Exception: agent and crew codenames.** A worker instance's working codename — an internal identity
assigned to a process, never a real person, host, credential or product — is **shorthand, not a
secret**. It identifies no one and exposes nothing, so it does not belong in the same severity as the
rest of that table.

- **In commit messages and pull-request bodies, a codename is fine.** Narrating who built, reviewed
  or fixed something by its working name is not a finding and does not need amending or a rebase.
- **In tracked files, prefer role over name** — "the review found", "an earlier pass fixed" — because
  a file is read long after a codename means anything to anyone. A surviving instance is a **note**,
  worth clearing next time that file is already open, not a blocker on its own.
- **Everything else in the table is unchanged.** Credentials, PII, paths, hosts and every other
  private project name remain an unqualified stop.

### The rule this repository needs more than most: no real browsing surface

This is a browser-automation codebase. It accretes example URLs, example logins and example profile
directories by its nature, and each one is a fact about somebody's real life: where they shop, where
they bank, what their machine is called, which account is signed in. So:

- **Example URLs are `example.com` and friends**, or a loopback address with a port. Never a real
  site, however innocuous it looks.
- **Never a retailer, bank, employer or service name** in a fixture, a test, a docstring or a doc,
  even as a plausible-sounding illustration. "a shopping site", "a bank", "an authenticated site".
- **Never a machine name or a profile directory path.** Profile locations are configuration; docs
  refer to *"the configured profile directory"*, and `.env.example` carries the key with a
  placeholder.
- **Matched as shapes, never as a denylist.** Writing the real names into a check so they can be
  grepped for publishes exactly what the rule exists to keep out.

### Writing rules that keep it clean

- **Refer to people by role, never by name** — "the owner", "the operator", "a second caller".
  Identifiers in docs and fixtures are placeholders (`agent-a`, `session-b`), never real ones.
- **No absolute paths.** Not in code, not in docs, not in compose files. Anything machine-specific is
  a setting; `.env.example` carries the *key* with a placeholder value, never a real one.
- **Name no private services.** Refer to them by what they are — "the database host", "the chat
  channel", "the work tracker" — not by a product name or a deployment's own name for them.
- **Generic examples only.** Example machine names, areas and repository names in docs are invented
  (`web`, `infra`, `desktop`), never copied from a real installation.
- **Never write a denylist of the real values into this repository.** Listing the actual names,
  hosts or usernames "so they can be grepped for" publishes precisely what the rule keeps out. Scan
  by category, using judgement.
<!-- external-ref-ok-next-line: this rule has to quote the phrasing it forbids in order to state it -->
- **Nothing is described by what it succeeds.** No predecessor, no prior state, no "replaces X", no
  setup the reader is assumed to already run. Everything here reads as an application built from
  scratch, because that is the only version a reader of a public repository can verify. Where a
  decision's reasoning genuinely was *"because the other thing did X"*, rewrite it to the underlying
  principle. That is almost always the better sentence, and it survives the other thing changing:

  | Not this | This |
  |---|---|
  | "it stops the process explosion we had" | "process count is bounded by configuration, not by the number of connected clients" |
  | "the shared login kept getting destroyed" | "a shared authenticated profile must not be destroyable by any single client's action" |
  | "replaces the per-client guard scripts" | "rules enforced in one server-side place cannot drift the way per-client scripts do" | <!-- external-ref-ok: this row has to quote the phrasing it forbids in order to teach it -->
  | "the reserved browser is the owner's real one" | "a browser the service does not own must be unreachable through the service" |

### The check that enforces the last two rules

```bash
npm run check:external-refs     # every tracked file; runs in CI on every pull request
```

<!-- external-ref-ok-next-line: naming the shapes it matches is the documentation; they are grammar, not real values -->
It matches **pattern shapes** — `today's`, `the old …`, `replaces`, `port of`, an absolute path, a
private address literal, a URL whose host is not one this repository is allowed to name — and
deliberately **never a list of the real values**, per the rule above.

**A green run means the recurring phrasings are absent. It does not mean the prose is clean** — and
the difference is worth knowing before you trust a tick. No shape matches a private proper noun
dropped into a sentence, or a sentence that only makes sense to someone who has seen a system this
repository does not contain. The script's header records exactly where its edges are. So the check is
a backstop that keeps the recurring phrasings from eating the attention **reading the diff** needs —
not a substitute for doing it.

**Recording a deliberate exception.** Some shapes have honest in-repo uses. Waive one line at a time,
with a reason, in a comment the language already supports:

```markdown
<!-- external-ref-ok: why this one is really about this repository -->
// external-ref-ok-next-line: why this one is really about this repository
```

A waiver's own line is never scanned, so `external-ref-ok` covers the line it sits on and
`external-ref-ok-next-line` covers **that line and the one after**. A waiver covers the *whole* line,
so attach it precisely — on a long wrapped line it can silence more than you meant, and the run
summary reports how many matches a tree's waivers are silencing so creep stays visible.

**The reason is mandatory and must read as a phrase**, not padding — a waiver that says nothing fails
the check itself, so silencing it always costs an explanation that lands in the diff beside the text
it excuses. Prefer rewording: most matches are easier to fix than to justify.

### If something sensitive is committed

1. **Do not** just delete it in a follow-up commit — the history still has it.
2. Rewrite the history and force-push.
3. **If it was a credential, rotate it.** Assume it is already compromised; rewriting history does
   not un-publish it.
4. Say so plainly to the owner rather than quietly fixing it.

---

## Testing is a core tenet

**Every feature ships with extensive tests.** Not a smoke test — tests that would actually fail if
the behaviour regressed. A pull request that adds behaviour and no tests is incomplete, and "it's
covered by the integration tests" is not an answer when those do not exist yet.

- **Setup work is the exception, and only setup work.** Scaffolding, config, CI wiring and deployment
  plumbing are proved by the pipeline running. Everything after that needs tests.
- **Prefer many small pull requests, each fully tested, over one large one tested at the end.** A
  single guard is a perfectly good pull request: the guard, plus the tests proving it both allows
  what it should and **refuses what it shouldn't**. The refusals are the point — a guard that never
  refuses anything passes a happy-path suite and protects nothing.
- **Test the error paths and the boundaries**, not just the success case: the rejection message, the
  missing required field, the concurrent claim, the state that should not be reachable.
- **Integration and end-to-end tests come once the surface exists**, not before. Unit tests are not a
  placeholder for them; both are wanted.

If a change is genuinely untestable, say why in the pull request rather than skipping quietly.

### A rejection test asserts the physical side-effect, not just the response

This is the rule most specific to this codebase, and the reason a **fake browser driver lands early**
rather than arriving late as a testing convenience.

Every operation here has a physical consequence: a tab opens, a page navigates, a capture is written.
So an assertion that a call returned `denied` proves almost nothing on its own — **a guard that
returns "denied" after the tab has already opened is worse than no guard**, because it reports a
refusal that did not happen and everything downstream believes it.

So a rejection test asserts two things: the response the caller got, **and** that the driver was
never asked to do the thing. Same for capacity — refusing an over-budget claim means the tab count
did not move. If the test cannot observe the side-effect, the test is not finished; wire the fake
driver's call log into it.

### Every gating script ships a self-test

Any script used as a gate — the checks under `scripts/` that CI runs on every pull request — must
ship a test proving it **fails on a seeded violation**, not merely that it passes on clean input. A
gate only ever proven to pass has never been run against the thing it exists to catch, and a check
that cannot fail is a no-op with a green tick beside it.

That test must also **state plainly what a green result does, and does not, mean.** A check written
against a fixed set of known shapes can only certify the absence of those shapes; it was never taught
to look for anything else, and a shape it was never given cannot be caught by widening intent alone.
`scripts/check-external-refs.mjs` and its test are the precedent: the script's header states outright
that a green run means the recurring phrasings are absent rather than that the prose is clean, and
the test both seeds a violation to prove the gate fires and pins the exemption lists so they cannot
be widened quietly.

---

## Standing authorisation — keep the queue moving

**Merging is pre-authorised. Do not stop to ask.** Once a change has been through review and its
checks are green, merge it, and then **immediately start the work that merge just unblocked** — look
up which rows in `MILESTONES.md` have all their prerequisites met, and dispatch them.

A merge is not the end of a piece of work; **it is the event that releases the next one.** Waiting to
be told to continue wastes the entire reason the dependency graph exists.

Two things this authorisation does **not** cover, because they are not merges:

- Anything **outward-facing or hard to reverse** beyond the merge itself — deleting or renaming the
  repository, rewriting published history, changing who can access it.
- **Skipping the review.** Review is the gate this authorisation is conditional on. A green merge
  button is not a review, and neither is having written the code yourself in the same session.

If review finds something genuinely blocking, fix it and re-review — do not merge and file a
follow-up.

### Never leave a pull request unwatched

**When you open one, immediately start something that waits on its CI** — a backgrounded
`gh pr checks <n> --watch` with a timeout, so it returns either when the checks finish or when the
timeout expires, whichever comes first. Then act on the result.

Without it, branches get opened and quietly forgotten: the work is done, the checks went green, and
nothing merges because everyone moved on. **A pull request nobody is waiting on is indistinguishable
from one that failed.**

### Green is not the same as right

When several pull requests solve the same problem, **do not merge whichever went green first.** A
change that does less will often pass more easily — precisely because it left something stale behind.
Compare what they actually do, and prefer the one that finishes the job even if it needs a fix first.

The shape to watch for: two changes bump a dependency and pass; a third does the full migration,
including the companion tooling that has to move with it, and fails on a formatting nit. Merging on
green picks one of the first two and leaves the mismatch buried.

### Your pull request must be mergeable into `main` as it is *now*, not as it was when you branched

Required checks on `main` are **strict**: a branch has to be up to date with `main` before it can
merge. Passing checks is not enough — a green pull request that is `BEHIND` still cannot go in.

**Several agents usually work in parallel here, so `main` moves while you work.** Assume it will.
Your job is not finished when your change works; it is finished when your change works **on top of
current `main`**.

```bash
git fetch origin
git rebase origin/main          # force-pushing your own feature branch is fine — only main is protected
```

- **Rebase, never merge.** `main` requires linear history, so a merge commit cannot land.
- **Expect conflicts in shared files.** The package manifest, the lockfile and config files are the
  usual casualties, because dependency and tooling changes touch them constantly. Take `main`'s
  version of anything you did not deliberately change, then re-apply only your own additions on top.
  **Never revert someone else's landed change to resolve a conflict** — if `main` upgraded a
  dependency, keep the upgrade.
- **For a lockfile, regenerate rather than hand-merge.** Run the install again after the rebase; a
  hand-resolved lockfile is unreliable.
- **Re-run the full verification after rebasing, not just before.** You are now on code you have
  never tested against, and a rebase that quietly breaks the build is worse than being behind because
  it looks finished.
- **If `main` moves again while you wait on review, rebase again.** Being current is a state you
  hold, not a step you complete.

### Branch from `main`, never from another pull request's branch

CI's `pull_request` trigger filters on `branches: [main]`, so a pull request opened against a branch
that is itself not `main` matches no event and runs **zero** checks — and no runs at all reads as
quiet, not red, which is easy to miss when several agents are working in parallel. **No checks is not
the same claim as checks passed.**

There is a sharp corollary worth knowing before it bites: merging a parent pull request with
`--delete-branch` **auto-closes anything still open against that branch**, and reopening or
retargeting the closed one does not recover it — the only way out is a fresh pull request from the
same unchanged branch against `main`. Do not rebase onto `main` hoping to recover it either: an
approval is granted against a specific set of commit shas, and a rebase mints a fresh set, so a
rebase always needs a fresh approval to match.

### Do not pull the ground out from under a running crew

**A worktree belongs to the agent working in it until that agent has reported.** Do not
`git worktree remove` it, push to its branch, or merge its pull request while it is still live — it
will keep working against a directory deleted out from under it, and it cannot tell your
interference apart from a rogue process.

Clean up worktrees only after the agent that owns one has finished. If you must take over a branch
mid-flight, expect that agent's report to be confused about what happened, and say plainly it was
you.

---

## Working in this repo

- **`main` is protected.** Linear history, no force-pushes, no deletions, every change arrives by
  pull request with conversation resolution required. Zero approvals are *required* — the platform
  blocks self-approval and everything here is authored under one account — so **review is a process
  gate we keep ourselves, not one the platform enforces.** Do not skip it because the merge button is
  green.
- **One pull request is one piece of work**, from `MILESTONES.md`. Build it in a worktree on its own
  branch.
- **A row is available to pick up when everything in its `Needs` column is merged.** That rule is
  what makes the milestone list a work queue instead of a wish list, and it is what lets you compute
  your next job without asking anyone.
- **Migrations are additive.** The whole schema lands as one baseline; change it with an `ALTER`,
  never by editing a migration that has already been applied. A migration that has run somewhere is
  history, and editing history means two installations with the same version number and different
  schemas — a difference nothing will report until something breaks far away from the cause.
- **Every adapter is a thin shell over a service call.** No adapter may reach the database or a guard
  directly — it resolves its input, calls one service operation, and shapes the result for its
  transport. Every rule that decides whether an operation is allowed lives in the service layer, or
  it holds on one transport and not the others. Read this before writing an adapter, not after a
  failing lint.

## Commits

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:`). Say what changed
and why; the diff already says how.
