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

The rules live in one service layer, and every surface is a thin adapter over it: **ten tools**,
served by the caller's own spawned process, and a `broker` command line that runs the same logic in
the process you typed it in. A shared conformance suite asserts that the same operation and the same
refusal happen on both.

**Nothing is served over a socket.** The operations view is a self-contained HTML file that a command
generates and a person opens from disk — a snapshot, labelled with the moment it was taken, which does
not refresh. It is generated from inside a live session, so it reads each tab's address from the
browser itself; a browser that does not answer within a timeout renders as unreachable rather than
hanging the report.

## Status

Planning. Nothing is built yet. Read [`docs/plans/PLAN.md`](docs/plans/PLAN.md) for how it works,
[`docs/plans/DECISIONS.md`](docs/plans/DECISIONS.md) for why it is shaped this way, and
[`docs/plans/MILESTONES.md`](docs/plans/MILESTONES.md) for the work queue.

## Licence

**MIT** — see [`LICENSE`](LICENSE), and `docs/plans/DECISIONS.md` §13e for the reasoning. A public
repository without a licence file grants no rights to anyone, so the decision alone was never enough;
the file carries it and `package.json` declares it.
