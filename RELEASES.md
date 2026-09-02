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


### ⚠ Behaviour change: the default browser engine is Edge

**What moved.** A browser launched by this service uses **`msedge`** by default. The previous
behaviour was to launch whatever `chromium.executablePath()` resolved to — the Chromium build the
automation library had fetched.

**Why.** Edge is present on every Windows machine, so a fresh install runs with nothing set, with no
separate browser download step. That is `DECISIONS.md` §6.1's *"a fresh install runs with nothing
set"* applied to the one prerequisite `npm install` genuinely could not cover.

**What an installation has to do.** Nothing, if Edge is acceptable. To keep the prior behaviour, or
to pick a different browser, set the engine per kind:

```bash
BROKER_REGULAR_BROWSER_ENGINE=chrome     # chrome | brave | msedge
BROKER_PRIVATE_BROWSER_ENGINE=chrome     # may differ from the line above
```

**If it does nothing:** browsers launch under Edge. **Profiles are per browser and are not shared
between engines**, so an installation whose signed-in profile was established under a different
binary will find that browser signed out, and a person will be asked to sign in once more with
`broker login`. Nothing is destroyed — `setup.profile_never_destroyed` still holds, and the earlier
profile directory is left exactly where it is.

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
