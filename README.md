# Browser Broker

**Several agents, two browsers, no collisions.**

Browser Broker brokers access to a small, fixed set of real browsers. A caller asks for a lease; it
gets back a secret key and **one tab** it exclusively owns. Every later call carries that key, and the
service uses it to route the call, to enforce what that caller may touch, and to account for what it
costs. There is nothing running in the background: the service is started by its caller and exits
with it, and the browsers outlive any one of them.

## What it gives you

- **A hard ceiling on browser processes.** Concurrency is expressed in tabs inside a fixed set of
  browsers, so process count is bounded by configuration rather than by how many clients connect. A
  lease is exactly one tab, so the budget, the pool bound and the number of live leases are one
  integer that cannot disagree with itself. Need two tabs, claim twice.
- **Leases, with a queue.** When capacity is full a caller is queued rather than refused, and told
  its position and when to check back.
- **Reclamation from callers that die.** Every key carries a time to live that any call renews, so a
  client that vanishes mid-work returns its capacity on its own. This is the failure a client-side
  convention cannot cover, because the client that should clean up is the one that is gone. Nothing
  expires on a timer: every arbitration call first expires whatever has lapsed across the whole
  store, then answers from the reconciled state.
- **A shared signed-in profile that no single caller can destroy.** Nothing browser-scoped is
  exposed. A caller can close its own tab; it cannot close a browser, and no operation reaches a
  browser outside the ones the service is configured to run.
- **References, not payloads.** Screenshots and page snapshots are written to disk and returned as a
  path with its dimensions and size. An agent opens one only when it genuinely needs to look, so a
  capture is paid for once instead of on every subsequent turn.
- **A capture policy applied by the thing that takes the capture.** Screenshots come back at a low
  resolution unless you ask for more, and asking for the most expensive tier costs a stated reason in
  free text. Nothing is ever refused — going over budget warns loudly and names the cheaper way to
  get the same answer.
- **Changed-region review.** A capture can name an earlier capture to compare against, and the
  regions that actually moved come back as crops — so a repeat review looks at what changed instead
  of at everything. There is no canonical picture to bless first: a capture is a capture with an
  identifier, and the caller says which one it means. If that image is missing, the full screenshot
  comes back with an explanation rather than a refusal.
- **Nothing to configure before it runs.** Every value is an environment variable with a working
  default, so a fresh install runs with nothing set, and `.env.example` documents the whole set. The
  one value several processes must agree on — the tab budget — is written into the store by the first
  process to open it, and a later process whose environment disagrees refuses to start and names both
  numbers.

## Surfaces

The rules live in one service layer, and every surface is a thin adapter over it: **twelve tools**,
served by the caller's own spawned process, and a `broker` command line that runs the same logic in
the process you typed it in. A shared conformance suite asserts that the same operation and the same
refusal happen on both.

**Nothing is served over a socket.** The operations view is a self-contained HTML file that a command
generates and a person opens from disk — a snapshot, labelled with the moment it was taken, which does
not refresh. It is generated from inside a live session, so it reads each tab's address from the
browser itself; a browser that does not answer within a timeout renders as unreachable rather than
hanging the report.

## Install

**Installation is the whole of deployment.** There is no image to pull, no daemon to register and no
service to keep running: the process is started by whatever calls it and exits with it. So getting it
working is a clone, an install and one more fetch below — there is no step after that.

You need **Node 22.18 or newer**. The sources are TypeScript and run through the runtime's own type
stripping, so there is no build step to perform.

```bash
git clone https://github.com/Zaida-3dO/browser-broker.git
cd browser-broker
npm install
```

That compiles the one runtime dependency's native binding, which is *not* the only part of the install
that does real work: this repository depends on `playwright-core`, not the full `playwright`
distribution, precisely because the browser binary is spawned by this service, detached and by path,
rather than downloaded and managed by the package. `playwright-core` does not fetch a browser on
install, so a checkout that has never had one fetched by some other tooling has none, and `broker
doctor`'s automation check will genuinely fail with exit code 11 until you run:

```bash
npx playwright-core install chromium
```

Run this once per machine, before the first `broker doctor`. It is the same install mechanism the
full `playwright` package would run automatically on `npm install`; `playwright-core` just does not
run it for you. Then run the broker itself:

```bash
node src/bin/broker.ts
```

The first run creates the store, brings its schema up to the version the build expects, prints where
the file is, and exits:

```
store: <the resolved store location>
schema: stepped from version 0 to version 1 (1 step(s) applied)
```

Run it again and it says the schema is already where it should be. **Every spawn does this**, not
just the first — with no long-lived process, there is no other moment at which it could happen, and a
caller that has upgraded and one that has not may both start within the same minute.

To get the command on your path as `broker`, link the package from the checkout:

```bash
npm link          # then: broker --help
```

### Configuring it

**Nothing needs setting.** Every value is an environment variable with a working default, so the
install above runs as-is; [`.env.example`](.env.example) documents the whole set, with placeholders
rather than real values. Nothing reads that file — configuration is the process environment.

The default store location is a directory of the service's own under the per-user application-data
location your platform defines. It is computed rather than written down anywhere, because writing one
down would name one machine. To put it somewhere else, set `BROKER_DB`:

```bash
BROKER_DB=/some/writable/path/broker.db node src/bin/broker.ts
```

**The browsers are configuration too.** Two lists, at most three names each, defaulting to one of
each — `regular` and `private`. A name is what a caller claims by and what its profile directory is
called, and a caller that names no browser gets the first signed-in one:

```bash
BROKER_REGULAR_BROWSERS=regular,checkout      # persistent, signed in, at most 3
BROKER_PRIVATE_BROWSERS=private               # ephemeral, at most 3
BROKER_REGULAR_BROWSER_ENGINE=msedge          # chrome | brave | msedge
BROKER_PRIVATE_BROWSER_ENGINE=msedge          # may differ from the line above
```

Two signed-in browsers is how two identities are exercised at once: tabs within one browser share
its cookie jar, so they are isolated from other browsers and not from each other. **Note that each
browser is a process before it holds a single tab**, which the tab budget does not count —
`.env.example` gives the arithmetic beside the variables.

A variable that is set but cannot be read as its type **refuses the spawn and names the variable**,
rather than quietly falling back to the default — a configuration nobody chose is worse than a
refusal nobody missed. For a list, the refusal names the offending **entry**: a duplicate within one
list, a name in both lists, more names than the cap, or a name that is not a usable word. A store location that resolves to a network share is refused for the same
reason it has to be: the write-ahead log coordinates through shared memory that requires every
process using the file to sit on one host.

### Pointing a client at the tools

The twelve tools are served over standard input and output by `src/bin/broker-tool.ts`, which speaks
[the Model Context Protocol](https://modelcontextprotocol.io/specification/2025-06-18) — revision
`2025-06-18`, with `2025-03-26` accepted for a client that asks for it. A client spawns that file,
opens with `initialize`, and the twelve tools are listed to it.

Most clients read a JSON file naming the servers they may spawn. The block is the same shape in all
of them; put it in whichever file yours reads — commonly `.mcp.json` in a project, or the client's
own configuration:

```json
{
  "mcpServers": {
    "browser-broker": {
      "command": "node",
      "args": ["/absolute/path/to/browser-broker/src/bin/broker-tool.ts"]
    }
  }
}
```

**The path has to be absolute**, because the client chooses the working directory it spawns from and
it is rarely the checkout. Nothing else is required: there is no port to configure, no token to
issue, and no process to have started first — the client starts it, and it exits when the client
closes the pipe.

**If that configuration file is itself synchronised between machines, an absolute path is the one
thing in it that cannot travel.** A home directory differs per machine and often per user, so one
entry naming a checkout is correct on the machine it was written on and names nothing on the other
— where it fails as a connection that closes immediately, which reads as a broken service rather
than as a path that does not exist. Give each machine its own entry under its own server name, or
point the shared entry at the published package, which carries no machine's path:

```json
{
  "mcpServers": {
    "browser-broker": {
      "command": "npx",
      "args": ["-y", "-p", "browser-broker", "broker-tool"]
    }
  }
}
```

To point it at a store other than the default, add the environment to the same block:

```json
{
  "mcpServers": {
    "browser-broker": {
      "command": "node",
      "args": ["/absolute/path/to/browser-broker/src/bin/broker-tool.ts"],
      "env": { "BROKER_DB": "/some/writable/path/broker.db" }
    }
  }
}
```

Every client sharing a store sees the same leases, which is the point of the store being a file: the
capacity being arbitrated is one set of browsers, and two clients that could not see each other's
claims would both think the whole of it was free.

**To check the wiring without a client**, speak the handshake by hand. This writes three messages and
reads two back — the notification is the one that draws no reply:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node src/bin/broker-tool.ts
```

The first response carries the negotiated `protocolVersion`, the server's `capabilities` and its
`serverInfo`; the second message is a notification and is deliberately not answered; the third lists
the twelve tools. A client that gets that far will work.

## First run

There is **one step a person performs by hand**, and it happens once: signing the shared browser in.
Everything else — creating the profiles, starting browsers, adopting them, keeping them alive — the
service does for itself. This is the whole of it, from a clean clone:

```bash
git clone https://github.com/Zaida-3dO/browser-broker.git
cd browser-broker
npm install

node src/bin/broker.ts init     # create the store and both browser profiles
node src/bin/broker.ts login    # open a browser and sign in, by hand
node src/bin/broker.ts doctor   # confirm the sign-in took
```

**`broker init`** creates the store, steps its schema, and establishes a profile directory for each
browser. It reports each one as `created` or `found`, which is the distinction worth reading: a
profile reported as `created` on a machine where you expected a sign-in is the earliest possible
warning that you are about to be asked to sign in again. It never recreates or clears a profile that
is already there.

**`broker login`** opens the shared browser, headed, against that profile and hands it to you:

```
A browser window is open for you to sign in.

  1. Switch to the browser window that just opened. It is the regular browser,
     running against the profile at regular under the configured
     profile root — which is the profile every caller will share.
  2. Go to whichever site you want this service to be signed in to, and sign in
     normally. This is a real browser and a real sign-in: what you type goes to
     that site exactly as it would in your own browser.
  3. Close the window when you are done. Closing it is what ends this step.
```

Sign in to whatever you want the service to have access to, then **close the window** — that is what
ends the step. While it is open the browser is not serving callers: anything that asks for it is told
a person is signing in and to try again shortly, and anything already waiting in the queue keeps its
place and its timer. A sign-in is a pause, not a cancellation.

Two things it will refuse, both on purpose:

- **A browser with live work on it.** If a caller holds a tab there, signing in would mean driving the
  window by hand underneath somebody's work. It names the leases holding it; waiting is enough,
  because every lease expires on its own if its holder stops calling in.
- **The private browser.** Its profile is discarded when it exits, so a sign-in there would appear to
  work and leave you signed into nothing.

**Nothing records what you type.** The sign-in is written into the browser's own profile directory by
the browser itself. This service never sees a credential and stores nothing about one anywhere —
which is also why there is no way to copy a sign-in between machines: the profile *is* the identity.

**`broker doctor`** then tells you whether it took, without opening a browser:

```
[ok  ] The regular browser’s profile carries a sign-in
         The profile holds 1 stored cookie(s), so a session was established and written down.
```

Before you have signed in, the same line reads:

```
[--  ] The regular browser’s profile carries a sign-in
         The profile has a cookie store and it holds no cookies. That is what a profile nobody has
         signed into looks like — though a site that keeps its session only in local storage would
         look the same, so this is the absence of evidence rather than evidence of absence.
```

**It never reports this as a failure**, and it will say `unknown` rather than guess. A profile with no
session is the ordinary state of every installation until somebody signs in, and a check that went red
on a working machine is one people learn to ignore. It also cannot see everything: it reads the
browser's stored cookies, so a site that keeps its session somewhere else is invisible to it, and a
browser that is still running has not necessarily written its cookies down yet — in that case it says
so and tells you to close the browser and ask again.

### Checking an install

```bash
npm run check:install
```

This spawns the executable as a real process against a temporary store, and asserts it creates the
file, steps the schema to the version the build expects, answers a command and **exits**. It is what
continuous integration runs on a clean hosted runner, and it is the check that stands in for the one
an image build would have given: proof that the thing actually starts.

Run everything the pipeline runs with `npm run check`.

### Recovering from leaked browsers, on Windows

<!-- external-ref-ok-next-line: this repository's own first-party PowerShell tool, named for the reader who needs to find it -->
The emergency sweep in `scripts/reap-broker-browsers.ps1` reports leaked broker browsers by default
and does not touch them; pass `-Execute` to terminate what it found, and add `-PruneDirs
-OlderThanHours <n>` to also clear stale profile directories older than that many hours. Not part of
the pipeline: a browser this project launches is spawned `detached: true` by design (see the header
of `src/browser/launch.ts`) so it survives the process that started it, and every known way that
leak could happen has since been fixed at its source — see the script's own header for the list.
Keep it installed anyway as insurance against whatever the next one turns out to be, and as the tool
to run if a machine is already in the frozen state a leak like this can cause. Matches processes by
profile-directory command line, never by image name, so it cannot touch an unrelated Chrome window
or this repository's own Playwright MCP tooling; see the script's own SAFETY section.

## Status

Under construction — the store, the executable and the pipeline are in place, the arbitration
surface is being built, and the one manual step is wired: `broker login` hands a person the shared
browser and `broker doctor` reports whether the sign-in took. Read [`docs/ROLLOUT.md`](docs/ROLLOUT.md) for taking it from installed to sole route in an order that
never leaves traffic unarbitrated, [`docs/plans/PLAN.md`](docs/plans/PLAN.md) for how it works,
[`docs/plans/DECISIONS.md`](docs/plans/DECISIONS.md) for why it is shaped this way, and
[`docs/plans/MILESTONES.md`](docs/plans/MILESTONES.md) for the work queue, and
[`RELEASES.md`](RELEASES.md) for what changes between versions — in particular for defaults that
move, which change an installation that has taken no action.

## Licence

**MIT** — see [`LICENSE`](LICENSE), and `docs/plans/DECISIONS.md` §13e for the reasoning. A public
repository without a licence file grants no rights to anyone, so the decision alone was never enough;
the file carries it and `package.json` declares it.
