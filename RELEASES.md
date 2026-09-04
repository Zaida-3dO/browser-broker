# Release notes

**What changes between versions, and specifically what changes *behaviour* on an installation that
sets nothing.**

That second half is the reason this file exists rather than the commit log being enough. A new
setting with a neutral default is not news: an installation that does not set it behaves exactly as
before. **A changed default is news**, because it moves an installation that has taken no action and
made no decision. `docs/plans/DECISIONS.md` §6.3 puts a changed default here rather than in a quiet
edit for that reason.

Entries are newest first. Each names what moved, what an installation has to do about it, and what
happens if it does nothing.

---

## Unreleased

### ⚠ Behaviour change: `wait_ms` on a navigate is now honoured

**What moved.** `browser_navigate` has advertised a `wait_ms` argument for some time, typed,
documented and accepted without complaint. **Nothing read it.** It now reaches the browser as the
navigation's timeout, and it is bounded by the lease: a wait longer than the lease can live is
refused, and the refusal names the accepted range rather than quietly clamping the value.

**Why this is a behaviour change and not a new feature.** An installation that has set nothing is
unaffected — but a *caller* that was already passing `wait_ms`, exactly as the schema invited, was
having it discarded and now is not. Nothing about that caller's code changes and its behaviour does.

**What an installation has to do.** Nothing. A caller passing no wait is unaffected: the argument is
omitted rather than defaulted, so the browser's own default still applies, and this service does not
invent a number the browser library owns.

**Worth knowing before relying on it:** the wait bounds the **load**, and does not cover work the
page starts afterwards. A canvas or a lazily-loaded region can still be unfinished when the call
returns, so two captures differing only in this argument tell you nothing about how long the page
was given to settle — see `browser_capture` on how to tell. An inert argument is worse than a
missing one precisely because a caller draws conclusions from it, and that is the conclusion most
easily drawn here.

### Dialog and form-filling become reachable from the command line, and a contradictory answer is refused

**What moved.** Two things a command-line caller had no way to do at all:

- `act dialog` and `act fill_form` take nested arguments that the flat command-line parser could not
  produce, so **no argument a person could type would ever parse**. They now assemble from ordinary
  flags — `--accept` / `--dismiss`, `--prompt-text`, and a repeatable `--field`.
- **A contradictory dialog answer is now refused instead of resolved silently.** Asking to accept
  and dismiss the same dialog used to take whichever the code read first. A caller answering a
  destructive `confirm()` deserves a refusal rather than a coin flip, and now gets one.

**What an installation has to do.** Nothing. Callers already sending a single, coherent answer — by
either surface — are unaffected.

### Capture responses point at `compare_to`

**What moved.** A capture response now carries a hint naming the comparison it could have made. The
comparison itself already existed and is roughly two orders of magnitude cheaper than reading a
screenshot back to answer *did this change* — and in all recorded history it had been used once,
because nothing pointed at it.

**What an installation has to do.** Nothing; the hint is additive. It is listed here because the
cheapest path through this service was, in practice, unreachable, and a caller that never learned
the verb existed was not making an informed choice.

### Closing a tab is recorded, and the doctor counts what was left behind

**What moved.** Tab closes now write their outcome, rows nothing could reach are settled, and
`broker doctor` reports tabs stranded in `closing`. Without that, a released lease can leave its tab
open with the record stuck mid-close and **nothing anywhere says so** — a state reachable only by
looking at the browser.

**What an installation has to do.** Nothing. **If it does nothing:** `broker doctor` may now report
stranded tabs that no check could see before. That is the check working, not a new fault appearing.

### The package is published, and it ships compiled JavaScript

**What moved.** The service is installable from the registry as `browser-broker`, so a caller can
spawn it without a checkout. The manifest's `bin` entries now name emitted JavaScript under `dist/`
rather than the TypeScript sources.

**Why the build exists**, given that the development path deliberately has none: **Node refuses to
strip types from any file under a `node_modules` path**, and an installed package is a directory
under `node_modules`. A manifest whose `bin` named a `.ts` file would install cleanly and then fail
on the machine of whoever installed it. There is no flag that changes this. The compiler therefore
runs once per release rather than on every machine that consumes the package, and `erasableSyntaxOnly`
stays on so the sources still run unbuilt — the two paths execute the same dialect.

**What an installation has to do.** Nothing. A checkout is unaffected: `node src/bin/broker.ts` still
runs the sources with no build. An installation that would rather not track a checkout can point at
the package instead, and npm revalidates the version on every spawn:

```json
{ "command": "npx", "args": ["-y", "-p", "browser-broker", "broker-tool"] }
```

The `-p` is not decoration: the package ships two executables and neither is named for the package,
so `npx browser-broker` cannot choose between them and refuses to run at all.

**Worth weighing before switching:** `npx` performs a registry round-trip on every spawn, costing
seconds where a path on disk costs a fraction of one. It buys an upgrade path, not speed.

**One surface changes what it reports.** The tool handshake's `serverInfo.version` was the literal
`0.0.0` while the package was unversioned, and now reads the manifest — so a client logging it sees
the released version rather than a placeholder.


### The default browser engine is named Edge, but resolving it is not built yet

**What moved.** `BROKER_REGULAR_BROWSER_ENGINE` and `BROKER_PRIVATE_BROWSER_ENGINE` default to
**`msedge`** rather than being unset. `DECISIONS.md` §13i chose Edge as the default *name* because it
is present on every Windows machine, applying §6.1's *"a fresh install runs with nothing set"* to
which engine a fresh install prefers.

**What this does not do: it does not change which binary launches, and it does not remove the browser
download step.** Resolving an engine name to an executable path is deliberately not built (§13i) —
`executablePathForEngine` only looks up a path this process was *given* for that engine, and nothing
in this repository supplies one. So the launch still falls through to `chromium.executablePath()`
regardless of which engine is named, and a machine that has never fetched a Chromium build still
needs to, exactly as before this change. The earlier release note claiming this default removed the
download step was wrong and is corrected here.

**What an installation has to do.** Nothing, either way — the engine setting has no observable effect
yet. Setting it now is preparation for when per-engine resolution is built, not a way to skip the
browser fetch:

```bash
BROKER_REGULAR_BROWSER_ENGINE=chrome     # chrome | brave | msedge — has no effect on which binary launches
BROKER_PRIVATE_BROWSER_ENGINE=chrome     # accepted and validated, and read by nothing — see below
```

Both are parsed and validated, and an unaccepted value is refused at startup and named — that much is
finished. **The private variable goes one step less far than the regular one:** one driver serves
every browser in a process, and only the regular engine is handed to it, so the private value is
validated and then never read by anything at all. It is not merely ineffective downstream; it has no
downstream.

**If it does nothing:** browsers keep launching under whichever Chromium build `playwright-core`
resolves, same as before this change. **No profile is signed out by setting an engine**, which an
earlier note claimed would happen: a profile directory is named for its *browser*, not for an engine,
so there is no engine-keyed profile to move between and nothing to sign in again.
`setup.profile_never_destroyed` holds, as it did before. The per-engine profile and sign-in
consequences described in `DECISIONS.md` §13i are what would follow once resolution is wired, and
describe nothing that happens now.

### Browsers are a configured list, and `browser` on a claim is optional

**What moved.** Two things, both reversals of recorded decisions — the argument for each is in
`DECISIONS.md` §13i:

- **The fixed pair of browsers becomes a bounded list per kind**, at most three each, named in
  configuration. A name is what a caller claims by and what its profile directory is called.
- **`browser` on `browser_claim` becomes optional.** Unstated resolves to the first signed-in
  browser; `regular` or `private` resolves to the first of that kind; a configured name resolves to
  that browser exactly.

**What an installation has to do.** Nothing. The defaults name one browser of each kind, `regular`
and `private`, which is the pair that existed before — so an installation that sets nothing has the
same two browsers under the same two names, and a caller that states `browser` explicitly is
unaffected.

**Worth reading before configuring more than the default two:** the tab budget counts *tabs*, and
each browser costs a process **before it holds a single tab**. `BROKER_TAB_BUDGET=15` with six
browsers is six browser processes, plus up to fifteen tabs, plus six keeper tabs that are not
counted against the budget at all. `.env.example` states this beside the variables.

**One schema step.** The store gains a `kind` column on `browsers` and drops the check constraint
that limited a browser's name to two literals. It is applied on the next spawn, like every step, and
the two existing rows are backfilled to their own kinds. **A store stepped by this build is not
readable by an earlier one**, which is the ordinary direction — a build refuses a store newer than
itself rather than downgrading it.
