# Browser Broker

**Several agents, two browsers, no collisions.**

Browser Broker owns a small, fixed set of real browsers and brokers access to them. A caller asks for
a lease; it gets back a secret key and one or more tabs it exclusively owns. Every later call carries
that key, and the service uses it to route the call, to enforce what that caller may touch, and to
account for what it costs.

## What it gives you

- **A hard ceiling on browser processes.** Concurrency is expressed in tabs inside a fixed set of
  browsers, so process count is bounded by configuration rather than by how many clients connect.
- **Leases, with a queue.** When capacity is full a caller is queued rather than refused, and told
  its position and when to check back.
- **Reclamation from callers that die.** Every key carries a time to live that any call renews, so a
  client that vanishes mid-work returns its capacity on its own. This is the failure a client-side
  convention cannot cover, because the client that should clean up is the one that is gone.
- **A shared signed-in profile that no single caller can destroy.** Nothing browser-scoped is
  exposed. A caller can close its own tabs; it cannot close a browser, and no operation reaches a
  browser the service did not launch.
- **References, not payloads.** Screenshots and page snapshots are written to disk and returned as a
  path with its dimensions and size. An agent opens one only when it genuinely needs to look, so a
  capture is paid for once instead of on every subsequent turn.
- **A capture policy that is enforced rather than recommended.** A resolution ceiling and a
  per-lease screenshot budget are applied by the thing that takes the capture.
- **Changed-region review.** Captures can be compared against a stored baseline for a view, and the
  regions that actually moved are returned as crops — so a repeat review looks at what changed
  instead of at everything.

## Surfaces

The rules live in one service layer. Every surface is a thin adapter over it: MCP over HTTP, MCP over
stdio, an HTTP/JSON API, and a `broker` command line. A shared conformance suite asserts that the
same operation and the same refusal happen on every one of them.

## Status

Planning. Nothing is built yet. Read [`docs/plans/PLAN.md`](docs/plans/PLAN.md) for how it works,
[`docs/plans/DECISIONS.md`](docs/plans/DECISIONS.md) for why it is shaped this way, and
[`docs/plans/MILESTONES.md`](docs/plans/MILESTONES.md) for the work queue.

## Licence

Not chosen yet — see `docs/plans/DECISIONS.md` §14. A public repository with no `LICENSE` file grants
no rights to anyone, so this is decided before the repository is published, not after.
