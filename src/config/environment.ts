import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StartupRefusal } from '../errors.ts';
import { parseCommandLine } from '../secrets/resolver.ts';
import { resolveRealPath } from '../store/network-path.ts';

/**
 * One snapshot of the process environment, read on the way in.
 *
 * `SCHEMA.md` §6.3: "One snapshot of the environment per process, read at
 * the start and used throughout, so every rule inside one operation sees one
 * configuration." There is no cache to go stale and no re-check to schedule,
 * because a process lives for one session.
 *
 * Row #9 turns this into the full registry with the walk test that asserts
 * `.env.example` lists every declared variable. Row #3 declares the three
 * variables that must be known before the store can be opened, which are the
 * three this row's own code reads.
 */

/**
 * A variable's declared type. §6.1: "Values are plain strings and enums."
 *
 * Written as a union with a declaration shape per member rather than one
 * shape carrying a kind field, so a path's default (a function of the home
 * directory and the platform) and a number's default (a literal) cannot be
 * confused for one another at the point either is read.
 */
type Kind =
  | 'path'
  | 'optional-path'
  | 'optional-command'
  | 'positive-integer'
  | 'name-list'
  | 'host-list'
  | 'enum'
  | 'token';

interface PathDeclaration {
  readonly key: string;
  readonly kind: Extract<Kind, 'path'>;
  /**
   * Computed, never written down. `SCHEMA.md` §1.0: "Nothing about that path
   * is written down here, because writing one down would name one machine."
   * The hygiene gate enforces the same thing from the other side — a literal
   * application-data path in this file fails `machine-path` or `profile-path`.
   */
  readonly fallback: (home: string, platform: NodeJS.Platform) => string;
}

/**
 * A path with **no default at all**, which is a different thing from a path
 * whose default happens to be computed.
 *
 * Its own shape rather than a nullable `fallback` on {@link PathDeclaration},
 * because this file's own doctrine is "a declaration shape per member rather
 * than one shape carrying a kind field, so a path's default and a number's
 * default cannot be confused for one another at the point either is read". A
 * `fallback` that is sometimes absent is exactly that confusion, one level in.
 *
 * **Unset means the capability is off, not that a default applies.** There is
 * one of these — `BROKER_UPLOAD_ROOT` — and the reasoning is in its
 * declaration below. Read as `string | undefined`, and every reader has to say
 * what it does with the second case.
 */
interface OptionalPathDeclaration {
  readonly key: string;
  readonly kind: Extract<Kind, 'optional-path'>;
}

/**
 * A command line that may be absent, split into words without a shell.
 *
 * **Unset means the capability is off**, exactly as an optional path does.
 * There is one of these — `BROKER_SECRET_RESOLVER` — and the reasoning is in
 * its declaration below.
 */
interface OptionalCommandDeclaration {
  readonly key: string;
  readonly kind: Extract<Kind, 'optional-command'>;
}

/**
 * An opaque non-empty string with **no default** — a credential-shaped value
 * an operator supplies, or the capability it guards is off.
 *
 * ── What "read as its type" means for a value with no shape ─────────────
 *
 * A token has no structure to check beyond non-emptiness, so §6.3's table
 * applies to exactly two cases: blank (somebody wrote the variable and meant
 * nothing by it, which is not a token) and a string containing a null byte
 * (which cannot survive any transport it would be handed to). Anything else
 * is used verbatim — including surrounding whitespace, because trimming a
 * secret is a guess about what the operator typed, and a token that fails
 * only at the far end is a worse sentence than one used exactly as written.
 *
 * **A value this file must never echo.** Every refusal message names the
 * variable and never the value, and the accessors below keep the value out
 * of the resolved-map's error sentences. `DECISIONS.md` §13n states the rule
 * the consumers inherit: the token is passed through to the attach relay and
 * written nowhere — not to the store, not to the ledger, not to a log line.
 */
interface OptionalTokenDeclaration {
  readonly key: string;
  readonly kind: Extract<Kind, 'token'>;
  /** What the token guards, for the refusal's sentence. */
  readonly unit: string;
}

/**
 * A comma-separated list of site patterns: exact hosts, or `*.`-prefixed
 * wildcard domains.
 *
 * A different shape from {@link NameListDeclaration}'s names because hosts
 * carry dots, and the wildcard entry is a host with a prefix, not a name with
 * a flag — `*.example.org` is one token that means "every subdomain of
 * example.org, and not its apex", and `src/attach/gate.ts` is what reads it
 * that way. Like the name lists, there is no quoting, no escaping and no
 * nesting; a token either is a legal host pattern or is not, and an illegal
 * one refuses the spawn naming the variable — an entry that silently never
 * matches would turn a site the operator meant to allow into a quiet refusal,
 * which is configuration guessing §6.1 declines.
 */
interface HostListDeclaration {
  readonly key: string;
  readonly kind: Extract<Kind, 'host-list'>;
  readonly fallback: readonly string[];
  /** What the list governs, for the refusal's sentence. */
  readonly unit: string;
}

/**
 * A whole number greater than zero, with a fixed default.
 *
 * The default is a literal rather than a computation, because unlike a path
 * it names nothing about the machine it runs on. §6.2 carries the numbers and
 * the reasoning for each.
 */
interface IntegerDeclaration {
  readonly key: string;
  readonly kind: Extract<Kind, 'positive-integer'>;
  readonly fallback: number;
  /** What the number means, for the refusal's sentence. */
  readonly unit: string;
}

/**
 * A bounded, comma-separated list of browser names.
 *
 * ── Why a list is not the parser §6.1 declines to buy ─────────────────────
 *
 * §6.1 asks for *"plain strings and enums, nothing nested, nothing needing a
 * parser"*, and a comma-separated list of names satisfies it rather than
 * bending it: it **cannot nest**, it has no quoting and no escaping, and there
 * is no syntax error available to it. Every token either is a legal name or is
 * not — which is the same check a single enum runs, run once per token.
 * `split(',')` is a different object from a grammar.
 *
 * ── Why two lists split by kind, rather than one list with a flag ───────────
 *
 * This removes the per-entry attribute entirely, and that is the point.
 * §1.2's own reasoning is the authority: *"No `persistent` flag. Whether a
 * browser uses a persistent profile is a property of which browser it is… A
 * column would let the row disagree with the word in it."* A per-entry private
 * flag would reintroduce exactly the disagreement that reasoning rules out,
 * and it would need encoding to carry. Which list a name is written in **is**
 * its kind, so there is nothing for a name and its kind to disagree about.
 */
interface NameListDeclaration {
  readonly key: string;
  readonly kind: Extract<Kind, 'name-list'>;
  /** The list used when the variable is unset, as the names themselves. */
  readonly fallback: readonly string[];
  /**
   * The most names this list may hold.
   *
   * A bound that **cannot be moved at request time**, which is the whole
   * difference between this and an escape hatch that mints a browser on
   * demand (`DECISIONS.md` §6, §13i). Nothing reads it per call.
   */
  readonly maximum: number;
  /** Which kind of browser this list names, for the refusal's sentence. */
  readonly browserKind: string;
}

/**
 * One of a fixed set of words.
 *
 * The rejections are the specification, exactly as they are for a number: a
 * value that is set and unreadable **refuses and names the variable**, because
 * falling back to the default silently would run a configuration nobody chose
 * with nothing to notice it by (§6.3).
 */
interface EnumDeclaration {
  readonly key: string;
  readonly kind: Extract<Kind, 'enum'>;
  readonly fallback: string;
  /** Every accepted word, in the order a refusal should list them. */
  readonly allowed: readonly string[];
  /** What the word selects, for the refusal's sentence. */
  readonly unit: string;
}

type Declaration =
  | PathDeclaration
  | OptionalPathDeclaration
  | OptionalCommandDeclaration
  | OptionalTokenDeclaration
  | IntegerDeclaration
  | NameListDeclaration
  | HostListDeclaration
  | EnumDeclaration;

/**
 * The per-user application-data location the platform defines, assembled from
 * the home directory and ordinary segment strings.
 */
function applicationDataDirectory(home: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Local');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support');
  }
  return path.join(home, '.local', 'share');
}

/** A directory of the service's own under that location. */
function ownDirectory(home: string, platform: NodeJS.Platform): string {
  return path.join(applicationDataDirectory(home, platform), 'browser-broker');
}

const DECLARATIONS = [
  {
    key: 'BROKER_DB',
    kind: 'path',
    fallback: (home, platform) => path.join(ownDirectory(home, platform), 'broker.db'),
  },
  {
    key: 'BROKER_ARTIFACTS_ROOT',
    kind: 'path',
    fallback: (home, platform) => path.join(ownDirectory(home, platform), 'artefacts'),
  },
  {
    key: 'BROKER_PROFILE_ROOT',
    kind: 'path',
    fallback: (home, platform) => path.join(ownDirectory(home, platform), 'profiles'),
  },
  {
    /**
     * Where `upload` may read files from — and **the only variable here with
     * no default**, deliberately.
     *
     * ── Why unset means off, rather than unset meaning somewhere ─────────
     *
     * `upload` is the one operation that moves data **from this machine** into
     * a shared, signed-in browser. Every other thing this service does moves
     * data that was already in a page. So a default root would hand inbound
     * filesystem reach to every existing installation on upgrade, silently,
     * without anyone choosing it — and §6.3's rule for a value nobody chose is
     * the one this file applies everywhere else: "falling back to the default
     * silently would run a configuration nobody chose with nothing to notice
     * it by."
     *
     * **Not the artifact root, which is the obvious wrong answer.** That is
     * where this service *writes*, and `<root>/claims/<claim id>/` holds other
     * leases' snapshots of their own pages. An upload root containing it would
     * let any lease read another lease's snapshot back into a web page — a
     * cross-lease read, assembled out of two operations that are each harmless
     * alone.
     *
     * A caller that tries `upload` on an installation that has not set this
     * gets a refusal naming the variable. That refusal is the design working:
     * it is the one moment anybody will read the sentence explaining that a
     * capability with filesystem reach exists and is off.
     */
    key: 'BROKER_UPLOAD_ROOT',
    kind: 'optional-path',
  },
  {
    /**
     * The command that turns a secret's name into its value (§3.8a) — and,
     * like the upload root, **off unless an operator says otherwise**.
     *
     * Spawned directly, never through a shell, with `resolve NAME` appended;
     * it prints one JSON object naming the value and the origins it may be
     * typed on. The words are split on whitespace, with double quotes
     * grouping a word that contains spaces; there is no other syntax.
     *
     * A default would be meaningless — there is no resolver to default to —
     * and unset is what makes a `{{secret:…}}` refuse with a sentence naming
     * this variable, which is the one moment anyone reads that it exists.
     */
    key: 'BROKER_SECRET_RESOLVER',
    kind: 'optional-command',
  },
  {
    /**
     * The total tab budget across **both** browsers (§6.2), and — since a
     * lease is a tab (§2.3) — the same number as the maximum count of live
     * leases. No per-browser cap: the scarce thing is page processes and one
     * costs the same in either browser.
     *
     * **This is the one value also written to the store** (§1.10), because
     * several processes arbitrate against it at the same moment and two of
     * them believing different numbers means the ceiling silently stops being
     * one. `src/store/budget.ts` is the agreement check; this is only where
     * the value is read.
     */
    key: 'BROKER_TAB_BUDGET',
    kind: 'positive-integer',
    fallback: 15,
    unit: 'a count of tabs',
  },
  {
    /**
     * How long an active lease lives without a call (§6.2).
     *
     * **Deliberately not given the agreement check the budget gets** (§1.10).
     * Two processes disagreeing here expires something early or late, which
     * is degraded behaviour rather than a broken invariant — no bound is
     * violated and no capacity is over-allocated. That distinction is the
     * rule: a value several processes must *agree* on gets the row; a value
     * they merely each *use* does not.
     */
    key: 'BROKER_LEASE_SECONDS',
    kind: 'positive-integer',
    fallback: 600,
    unit: 'a duration in seconds',
  },
  {
    /**
     * How long a place in the queue lives without a call (§6.2).
     *
     * **Equal to the lease lifetime, deliberately** (§2.5). Both arguments
     * for making them differ pointed the other way: polling *is* renewing, so
     * a queued caller holds exactly the instrument an active holder does; and
     * under strict ordering a queue place held longer blocks everyone behind
     * it, so a generous queued lifetime is the harsher setting rather than
     * the kinder one.
     *
     * It is a separate variable rather than a reuse of the one above because
     * they are two decisions that presently agree, and collapsing them would
     * make changing one impossible without changing both.
     */
    key: 'BROKER_QUEUE_SECONDS',
    kind: 'positive-integer',
    fallback: 600,
    unit: 'a duration in seconds',
  },
  {
    /**
     * How long a launch-race loser waits for the winner's browser to accept
     * a connection before declaring the launch failed (§1.2b, §9.3, row #55).
     *
     * **Settled by row #55: the signal is `verifyDiscoveryRecord` — liveness
     * plus identity, §1.2c — polled, not a fixed pause.** This is only the
     * bound on how long that poll runs, and it is the same 30 seconds the
     * loser already waited before this row made the number configurable.
     *
     * **Deliberately not given the agreement check the tab budget gets**
     * (§1.10). Two processes disagreeing here means one loser gives up
     * sooner or later than another watching the same launch — degraded
     * behaviour, not a broken invariant, so it does not need the row.
     */
    key: 'BROKER_LAUNCH_READINESS_TIMEOUT_SECONDS',
    kind: 'positive-integer',
    fallback: 30,
    unit: 'a duration in seconds',
  },
  {
    /**
     * The names of the persistent, signed-in browsers (§1.2, `DECISIONS.md`
     * §13i).
     *
     * **A bounded list defaulting to one entry**, which is what keeps the
     * property §6 defends: process count is bounded by configuration, not by
     * how many callers connect. The bound is a constant in this file and
     * nothing reads it per call, so there is no request that can widen it.
     *
     * The first entry is what an unstated `browser` resolves to on a claim
     * (§3.2) — the reason it is *first* rather than a separate setting is
     * that a separate setting could name a browser that is not in the list.
     */
    key: 'BROKER_REGULAR_BROWSERS',
    kind: 'name-list',
    fallback: ['regular'],
    maximum: 3,
    browserKind: 'signed-in',
  },
  {
    /**
     * The names of the ephemeral, signed-in-to-nothing browsers (§1.2).
     *
     * **Capped separately from the list above rather than sharing a total**,
     * deliberately: the two kinds are not interchangeable. One total would let
     * a configuration spend every place on signed-in browsers and leave **no
     * clean-room browser at all**, and clean-room is the one that cannot be
     * substituted for — a signed-in browser cannot show what a page does for
     * somebody who has never been there. A cap per list guarantees both kinds
     * remain reachable.
     */
    key: 'BROKER_PRIVATE_BROWSERS',
    kind: 'name-list',
    fallback: ['private'],
    maximum: 3,
    browserKind: 'clean-room',
  },
  {
    /**
     * The attached browsers — a person's own, reached read-only through the
     * attach relay and never launched or closed by this service (§1.2,
     * `DECISIONS.md` §13n).
     *
     * **The default is empty, and an empty list is the capability being
     * off.** Both other lists default to one name, because a fresh install
     * needs a browser to do anything at all. An attached browser is
     * different in kind: it is somebody's actual machine, and no default can
     * name it. Nothing listens for an attach until an operator writes the
     * word — §6's rule that a fresh install runs with nothing set, applied to
     * the one piece of configuration that could otherwise reach into a
     * person's browsing.
     *
     * **Capped at one**, separately from the other two caps and for a
     * different reason than either: an attached browser is the browser an
     * operator is looking at, and one installation's relay answers for one
     * browser. A second name would describe a second machine this build has
     * no way to address separately — configuration guessing of exactly the
     * kind §6.1 declines.
     */
    key: 'BROKER_ATTACHED_BROWSERS',
    kind: 'name-list',
    fallback: [],
    maximum: 1,
    browserKind: 'attached',
  },
  {
    /**
     * How many tabs may be held at once against one attached browser (§13n).
     *
     * **A cap in front of the budget, with the budget still standing.**
     * Those tabs are pages in somebody's own browser and count against
     * `BROKER_TAB_BUDGET` exactly as any other page does; this number answers
     * the different question of how much of a person's visible browsing one
     * caller may hold at a time. It is enforced by **refusing the claim
     * before any row is written** rather than by queueing it: the queue's
     * promotion math weighs the shared budget only, so a per-kind cap held
     * through the queue would be breached the moment capacity freed
     * (§13n records the reasoning).
     */
    key: 'BROKER_ATTACHED_TABS',
    kind: 'positive-integer',
    fallback: 3,
    unit: 'a count of tabs',
  },
  {
    /**
     * The Chrome extension id the attach relay routes to — the id Chrome
     * shows for the attach extension installed in the operator's browser
     * (§13n).
     *
     * **Required whenever the attached list is not empty**, and its shape is
     * checked once here rather than at lease time: the relay addresses the
     * extension by this id, so an attached browser without one is a browser
     * that can never be reached, and the startup refusal can still name the
     * variable and be acted on. The shape — thirty-two characters from `a`
     * to `p`, the alphabet Chrome assigns extension ids — mirrors the check
     * the relay itself runs on connect; a configuration that would fail
     * mid-lease must not start.
     */
    key: 'BROKER_ATTACHED_EXTENSION_ID',
    kind: 'token',
    unit: 'a Chrome extension id',
  },
  {
    /**
     * The token the connect URL carries to the attach extension (§13n).
     *
     * **Carried, never echoed and never written**: it is handed to the
     * connect page and kept out of the store, the ledger and every log
     * line — the rule {@link OptionalTokenDeclaration} states and
     * everything that reads this field inherits.
     *
     * What it changes is one thing: with it, the extension can finish a
     * reconnect without a person pressing *connect*; without it, a person
     * approves. It is **not presented to the relay and not checked by
     * it** — admission there is the loopback Host, the unguessable
     * per-lease path and the exact extension Origin — so unset is simply
     * the configuration where a person approves, not an open door. The
     * doctor reports the state so the choice stays visible (§13n).
     */
    key: 'BROKER_ATTACHED_TOKEN',
    kind: 'token',
    unit: 'the attach relay token',
  },
  {
    /**
     * The sites an attached browser may be **acted on** (§3.5 of the attach
     * safety plan): exact hosts or `*.`-prefixed wildcard domains.
     *
     * **Empty means acting is off entirely** — the read-only posture the
     * attached kind shipped with, and the default because no set of sites is
     * sensible for a machine this configuration does not know. Read freely
     * stays the default on every site: this list fences acting, never
     * reading. It is environment-only and an agent has no route to it — the
     * fence that stops a disguised button is the site, so the fence has to be
     * somewhere the button-pusher cannot reach (§3.5's residual-risk note:
     * keep the consequential sites **off** this list and the classifier is
     * the second line, not the first).
     *
     * The patterns are interpreted by `src/attach/gate.ts` — wildcard covers
     * subdomains and not the apex — and the shape is checked **here**, at
     * startup, because an entry that can never match a navigation is a silent
     * refusal the operator would chase through the lease forever.
     */
    key: 'BROKER_ATTACHED_ACT_SITES',
    kind: 'host-list',
    fallback: [],
    unit: 'a comma-separated list of hosts or *.-prefixed wildcard domains',
  },
  {
    /**
     * The signing secret for owner grants (§3.5's consequential-step seam).
     *
     * The operator side mints a one-time token for one exact step
     * (lease, ref, control name, host, moment, verb, value digest) with this
     * secret; the broker
     * **verifies and consumes** it, and never mints. **Unset means the seam
     * is inert**: a grant-bearing call is refused exactly as one without it —
     * never allowed "because there was no way to check" — which is why an
     * empty default is safe rather than a hole.
     *
     * **Where it lives decides what the seam is.** The service is started by
     * its caller, so the secret is in that caller's launch configuration and
     * the service's process environment: an agent that can read either can
     * mint a grant. The seam is a boundary only where the secret reaches the
     * service by a channel the agent cannot read, and advisory where it can
     * (`DECISIONS.md` §13o).
     *
     * **Carried, never echoed, never written**: the secret appears in no
     * store row, no ledger detail, no log line and no refusal sentence — the
     * same discipline `BROKER_ATTACHED_TOKEN` carries, inherited from
     * {@link OptionalTokenDeclaration}. The *grant* a caller sends is
     * likewise echoed nowhere; refusals name only the verdict (forged,
     * expired, replayed).
     */
    key: 'BROKER_OWNER_GRANT_SECRET',
    kind: 'token',
    unit: 'the owner-grant signing secret',
  },
] as const satisfies readonly Declaration[];

/** Every variable this build declares. Row #9's walk test reads this. */
export const DECLARED_VARIABLES: readonly string[] = DECLARATIONS.map((d) => d.key);

/**
 * The per-browser binary override: `BROKER_BROWSER_<NAME>_PATH`.
 *
 * ── Why this family is not a row in the table above ──────────────────────
 *
 * Every declaration above names a key that exists before the environment is
 * read. These do not: the set of keys is a **function of the browser-name
 * lists**, which are themselves read from the environment. There is no fixed
 * list to put in `DECLARATIONS`, and inventing one would mean fixing the
 * browser names — the thing §1.2 deliberately leaves configurable.
 *
 * So the family is declared as a *shape* instead, and
 * `scripts/check-argument-reachability.mjs` is taught that shape. That
 * matters more than it looks: the reachability gate finds declared variables
 * by matching the literal `key: 'BROKER_…'`, so a computed key would enter
 * the build **exempt from the one check that exists to stop inert
 * configuration** — which is the `wait_ms` defect, rebuilt. A whole
 * configuration surface nothing reads is exactly what that check was written
 * for, and a surface it structurally cannot see is worse than one it fails on.
 *
 * ── Why a literal path, and not an engine name ───────────────────────────
 *
 * `DECISIONS.md` declined engine *resolution* and still does. This buys the
 * wanted half — point the service at the browser you already have — without
 * the expensive half: no per-operating-system discovery, no per-engine doctor
 * check, no decision about what a named engine does when it is absent. The
 * owner knows where their binary is. It also covers builds this project has
 * never heard of, which an enumeration of engine names cannot.
 */
export const BROWSER_PATH_PREFIX = 'BROKER_BROWSER_';
export const BROWSER_PATH_SUFFIX = '_PATH';

/**
 * The variable that overrides one browser's binary.
 *
 * A hyphen is legal in a browser name (`BROWSER_NAME` above) and illegal in
 * an environment variable, so it becomes an underscore. That is a **collapse
 * rather than a mapping**: `a-b` and `a_b` would land on one key. They cannot
 * both exist — an underscore is not a legal browser name at all — so the
 * collapse has no second pre-image and cannot be ambiguous.
 */
export function browserPathVariable(browser: string): string {
  return `${BROWSER_PATH_PREFIX}${browser.toUpperCase().replaceAll('-', '_')}${BROWSER_PATH_SUFFIX}`;
}

export interface Environment {
  readonly databasePath: string;
  /**
   * `BROKER_DB` as it was configured, before this platform's path rules were
   * applied to it — and **undefined when it was not configured at all**.
   *
   * The network-location refusal needs the raw form: resolving a path applies
   * the host platform's own idea of what a root is, and that is exactly the
   * information a share-shaped value loses on a platform that does not
   * recognise the spelling.
   *
   * **Undefined rather than a copy of the resolved value**, because those are
   * different situations and a caller that cannot tell them apart cannot say
   * so. A value equal to the default may have been chosen deliberately or may
   * be the default; anything reporting what an installation is configured for
   * would have to guess, and it would guess wrong for whichever caller wrote
   * the default out by hand.
   */
  readonly configuredDatabasePath: string | undefined;
  readonly artifactsRoot: string;
  readonly profileRoot: string;
  /**
   * Where `upload` may read files from, or **undefined when no operator has
   * said** — in which case the verb refuses and reads nothing.
   *
   * `string | undefined` rather than a string with a sentinel, because "off"
   * and "a directory" are different answers and a reader that could not tell
   * them apart would have to invent one of them. Every reader of this field
   * has to handle the second case, which is the point.
   */
  readonly uploadRoot: string | undefined;
  /**
   * The secret resolver's command, as words, or **undefined when no operator
   * has configured one** — in which case every secret sentinel refuses.
   */
  readonly secretResolver?: readonly string[] | undefined;
  /**
   * The total tab budget across both browsers (§2.3, §6.2).
   *
   * **This process's belief**, which is not yet known to agree with the
   * store's. `src/store/budget.ts` is what compares them, and it refuses the
   * spawn on a disagreement rather than adopting either number.
   */
  readonly tabBudget: number;
  /** How long an active lease lives without a call, in seconds (§6.2). */
  readonly leaseSeconds: number;
  /** How long a queue place lives without a call, in seconds (§2.5, §6.2). */
  readonly queueSeconds: number;
  /**
   * How long a launch-race loser waits for the winner's browser to accept a
   * connection before declaring the launch failed, in seconds (§1.2b, §9.3).
   *
   * **Settled by row #55.** The signal it bounds is `verifyDiscoveryRecord`
   * — liveness and identity (§1.2c) — polled, never a fixed pause; this is
   * only how long the poll runs before giving up on the winner.
   */
  readonly launchReadinessTimeoutSeconds: number;
  /**
   * The persistent, signed-in browsers, in the order they were configured
   * (§1.2). Never empty, and never longer than the cap.
   *
   * **The first entry is what an unstated `browser` resolves to** on a claim
   * (§3.2).
   */
  readonly regularBrowsers: readonly string[];
  /** The ephemeral, signed-in-to-nothing browsers, in configured order (§1.2). */
  readonly privateBrowsers: readonly string[];
  /**
   * The attached browsers, in configured order (§1.2, `DECISIONS.md` §13n).
   * **May be empty — empty is the capability being off** — and never longer
   * than one name. An attached browser is a person's own: this service never
   * launches it, never closes it, and reaches it read-only through the
   * attach relay.
   */
  readonly attachedBrowsers: readonly string[];
  /**
   * The most tabs that may be held at once against one attached browser
   * (§13n). A cap in front of `tabBudget`, not a substitute for it: those
   * pages count against the budget, and this answers how much of a person's
   * browsing a single caller may hold.
   */
  readonly attachedTabs: number;
  /**
   * The Chrome extension id the attach relay routes to, or `undefined` when
   * unset. Its shape has already been checked, and it is required whenever
   * `attachedBrowsers` is non-empty — so `undefined` here means the whole
   * capability is off, not that a lease will be missing it.
   */
  readonly attachedExtensionId: string | undefined;
  /**
   * The attach relay token, or `undefined` when unset. **Carried, never
   * echoed**: it goes to the relay at connect and nowhere else — not the
   * store, not the ledger, not a log line (§13n). Every consumer of this
   * field keeps that rule; nothing may format it into a message.
   */
  readonly attachedToken: string | undefined;
  /**
   * The sites an attached lease may be acted on (exact hosts or `*.`
   * wildcards), or **empty — empty is the whole acting capability off**, and
   * the read-only posture stays the default (§3.5 of the attach safety plan).
   * Shape-checked at startup; interpreted by `src/attach/gate.ts`.
   */
  readonly attachedActSites: readonly string[];
  /**
   * The owner-grant signing secret, or `undefined` when unset — unset means
   * the grant seam is **inert**: a grant-bearing call is refused exactly as
   * one without it. **Carried, never echoed**: like the attach token it is
   * formatted into no message, store row or log line, and the grant itself
   * is echoed nowhere either — only its verdict ever is.
   */
  readonly ownerGrantSecret: string | undefined;
  /**
   * The binary each browser was pointed at, by browser name.
   *
   * **A browser absent from this map takes the bundled Chromium**, which is
   * every browser in a default installation. A browser present in it was
   * configured deliberately and its path has already been checked to exist
   * and to be a file — an unusable one refuses the spawn rather than reaching
   * here, because the alternative is the silent fallback `DECISIONS.md`
   * pre-specified as the thing not to build.
   *
   * A map rather than a field per browser, because the browsers are named by
   * configuration and a field would have to fix their names.
   */
  readonly browserPaths: ReadonlyMap<string, string>;
}

export interface ReadEnvironmentOptions {
  /** The raw environment. Injected so a test does not mutate the real one. */
  readonly env?: NodeJS.ProcessEnv;
  readonly homedir?: () => string;
  readonly platform?: NodeJS.Platform;
  /**
   * Whether a configured browser binary is there.
   *
   * Injected for the same reason the environment itself is: a test asserting
   * that a missing binary refuses must not depend on what happens to be
   * installed on the machine running it, in either direction. The default
   * asks the filesystem.
   */
  readonly fileExists?: (candidate: string) => boolean;
}

/**
 * Read a value as its declared type, applying §6.3's table.
 *
 * Unset uses the default; set and valid is used; **set and unreadable
 * refuses, naming the variable**. Falling back to the default silently would
 * run a configuration nobody chose with nothing to notice it by.
 */
function readPath(declaration: PathDeclaration, raw: string | undefined, fallback: string): string {
  if (raw === undefined) {
    return fallback;
  }
  // A path that is empty or blank is set-and-unreadable rather than unset:
  // somebody wrote the variable and meant something by it, and no path is
  // the one thing it cannot mean.
  if (raw.trim() === '') {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set but empty. Expected a filesystem path; unset it to use the default.`,
    );
  }
  // A null byte cannot appear in a path and every filesystem call would
  // throw on it far from here, naming neither the variable nor the value.
  if (raw.includes('\0')) {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set to a value that is not a filesystem path. Expected a path, found a string containing a null byte.`,
    );
  }
  return path.resolve(raw);
}

/**
 * Read a path that has no default: set and readable, or absent.
 *
 * The rejections are {@link readPath}'s, for the same reasons — somebody who
 * wrote the variable meant something by it, and neither blank nor a string
 * with a null byte is a path. What differs is only the unset case, which here
 * is an answer rather than a signal to use a default.
 */
function readOptionalPath(
  declaration: OptionalPathDeclaration,
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw.trim() === '') {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set but empty. Expected a filesystem path; unset it to leave the capability it enables switched off.`,
    );
  }
  if (raw.includes('\0')) {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set to a value that is not a filesystem path. Expected a path, found a string containing a null byte.`,
    );
  }
  return path.resolve(raw);
}

/** Read a command line into words, or `undefined` when unset (see {@link OptionalCommandDeclaration}). */
function readOptionalCommand(
  declaration: OptionalCommandDeclaration,
  raw: string | undefined,
): readonly string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const words = parseCommandLine(raw);
  if (words === undefined || raw.includes('\0')) {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set but is not a readable command: it is empty, contains a null byte, or has an unclosed double quote. Expected a program and its arguments separated by spaces; unset it to leave the capability it enables switched off.`,
    );
  }
  return words;
}

/**
 * Read a value as a whole number greater than zero, applying §6.3's table.
 *
 * **The rejections are the specification here.** Every one of these is a
 * value somebody wrote deliberately, and the alternative to refusing is
 * running a configuration nobody chose:
 *
 * - **A blank value.** Somebody set the variable and meant something by it,
 *   and no number is the one thing it cannot mean.
 * - **Anything that is not entirely digits**, including a decimal point, a
 *   sign, a trailing unit and leading text. Reading `10s` as ten would be a
 *   guess, and reading `1e3` as a thousand would let a typo of a thousand
 *   pass as a small number somewhere else.
 * - **Zero.** A budget of zero admits nobody and a lifetime of zero expires
 *   every lease before its first call, so both are configurations in which
 *   the service cannot work at all. Refusing at the loudest moment is
 *   better than every call refusing for a reason nothing names.
 * - **Anything above the safe-integer boundary**, because past it arithmetic
 *   stops being exact and a comparison against a budget stops being one.
 */
function readPositiveInteger(declaration: IntegerDeclaration, raw: string | undefined): number {
  if (raw === undefined) {
    return declaration.fallback;
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set but empty. Expected ${declaration.unit} as a whole number above zero; unset it to use the default of ${String(declaration.fallback)}.`,
    );
  }

  // Digits only. A permissive parse would read a decimal, a sign or a
  // trailing unit as a number the caller did not write, and every one of
  // those is a value somebody typed on purpose and got wrong.
  if (!/^\d+$/.test(trimmed)) {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set to ${JSON.stringify(raw)}, which is not a whole number. Expected ${declaration.unit} written in digits alone, above zero.`,
    );
  }

  const value = Number(trimmed);
  if (value === 0) {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set to zero. Expected ${declaration.unit} above zero; a value of zero is a configuration in which the service cannot serve anybody.`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set to ${JSON.stringify(raw)}, which is larger than this runtime counts exactly. Expected ${declaration.unit} below ${String(Number.MAX_SAFE_INTEGER)}.`,
    );
  }
  return value;
}

/**
 * A browser name is a word this service will make a directory of.
 *
 * **Narrow on purpose.** A name reaches three places that each have their own
 * idea of a legal string: it is a primary key in the store, it is the profile
 * directory's own name under the configured profile root (§1.2), and it is
 * what a caller types on `browser_claim`. Lower-case letters, digits and a
 * hyphen is the intersection, and refusing outside it here — once, at startup,
 * naming the entry — is the only place the refusal can name what was wrong.
 * Every later refusal would be a directory error or a constraint failure
 * naming neither the variable nor the value.
 *
 * A leading digit or hyphen is refused because a name is read as a word by a
 * person choosing between browsers, and the two names in the default
 * configuration are words.
 */
const BROWSER_NAME = /^[a-z][a-z0-9-]*$/;

/** The longest a name may be, so a directory name stays a directory name. */
const BROWSER_NAME_MAXIMUM = 32;

/**
 * Read a comma-separated list of browser names, applying §6.3's table.
 *
 * **Every rejection names the offending entry**, not merely the variable.
 * §6.3's rule is *"refuse to start, naming the variable and what was
 * expected"*, and for a list the useful half of "what was expected" is which
 * token failed — a caller told only that `BROKER_REGULAR_BROWSERS` is wrong
 * has to work out which of three names it meant.
 *
 * The rejections:
 *
 * - **Blank, or a blank entry.** Somebody wrote the variable and meant
 *   something by it, and no browser is the one thing it cannot mean. `a,,b` is
 *   a typo rather than a two-entry list, and reading it as one would silently
 *   run a configuration nobody wrote.
 * - **A name outside the shape above**, including whitespace inside a name and
 *   an upper-case letter. The store's key, the directory's name and the
 *   caller's word are the same string, so it has to be legal in all three.
 * - **A duplicate within one list.** Two entries naming one browser is not a
 *   pair of browsers, so a list that reads as three and launches two is a
 *   configuration whose count nobody can trust.
 * - **More entries than the cap.** The cap is what keeps the bound §6 defends
 *   — *"as many as are asked for, with a politer name"* is what an
 *   unbounded list is — so exceeding it is refused rather than truncated.
 *   Truncating would drop a browser somebody configured and say nothing.
 */
function readNameList(
  declaration: NameListDeclaration,
  raw: string | undefined,
): readonly string[] {
  if (raw === undefined) {
    return declaration.fallback;
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    if (declaration.fallback.length === 0) {
      // **Blank *is* the default here**, and that is the whole difference.
      // The refusal below rests on the list having something to fall back
      // to: writing the variable and leaving it empty cannot mean the
      // browser somebody clearly meant, so it refuses. A list whose default
      // is empty — `BROKER_ATTACHED_BROWSERS` is the one that has one — has
      // exactly one thing blank can mean: *none*, the capability off.
      // Refusing `NAME=` there would make the variable's natural off switch
      // an error, and the sentence below would not even parse.
      return declaration.fallback;
    }
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set but empty. Expected a comma-separated list of ${declaration.browserKind} browser names; unset it to use the default of ${declaration.fallback.join(', ')}.`,
    );
  }

  const entries = trimmed.split(',').map((entry) => entry.trim());

  const names: string[] = [];
  for (const entry of entries) {
    if (entry === '') {
      throw new StartupRefusal(
        'config.value_readable',
        `${declaration.key} is set to ${JSON.stringify(raw)}, which has an empty entry. Expected a browser name between every comma.`,
      );
    }
    if (entry.length > BROWSER_NAME_MAXIMUM) {
      throw new StartupRefusal(
        'config.value_readable',
        `${declaration.key} names a browser ${JSON.stringify(entry)}, which is longer than ${String(BROWSER_NAME_MAXIMUM)} characters. A browser name is also the name of its profile directory.`,
      );
    }
    if (!BROWSER_NAME.test(entry)) {
      throw new StartupRefusal(
        'config.value_readable',
        `${declaration.key} names a browser ${JSON.stringify(entry)}, which is not a usable name. Expected lower-case letters, digits and hyphens, starting with a letter: the name is the browser's key, the name of its profile directory, and the word a caller types to claim it.`,
      );
    }
    if (names.includes(entry)) {
      throw new StartupRefusal(
        'config.value_readable',
        `${declaration.key} names ${JSON.stringify(entry)} more than once. Two entries naming one browser is one browser, so the list would say a number it does not have.`,
      );
    }
    names.push(entry);
  }

  if (names.length > declaration.maximum) {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} names ${String(names.length)} browsers and the most it may name is ${String(declaration.maximum)}: ${names.join(', ')}. Each browser is a process before it holds a single tab, and the bound is what keeps the process count a property of configuration rather than of how many callers ask.`,
    );
  }

  return names;
}

/**
 * Read one of a fixed set of words, applying §6.3's table.
 *
 * The refusal lists every accepted word, because a caller that wrote one word
 * is a caller who will write another one, and the set is short enough that
 * naming it costs a clause.
 */
function readEnum(declaration: EnumDeclaration, raw: string | undefined): string {
  if (raw === undefined) {
    return declaration.fallback;
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set but empty. Expected ${declaration.unit}, one of ${declaration.allowed.join(', ')}; unset it to use the default of ${declaration.fallback}.`,
    );
  }

  if (!declaration.allowed.includes(trimmed)) {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set to ${JSON.stringify(raw)}, which is not ${declaration.unit} this service launches. Expected one of ${declaration.allowed.join(', ')}.`,
    );
  }

  return trimmed;
}

/**
 * Read one browser's binary override, applying §6.3's table — and **refusing
 * a path that is not there**.
 *
 * ── Why this refuses where `readPath` above merely resolves ──────────────
 *
 * The three path variables above name places this service **writes**, and it
 * creates them when they are absent; a directory that does not exist yet is
 * an ordinary first run rather than a mistake. This names a place it
 * **reads**, and one it cannot create: a binary that is not there is not a
 * first run, it is a value that will never come true.
 *
 * **The alternative is the defect this whole row exists to avoid.** Falling
 * back to the bundled Chromium would hand back a working browser that is not
 * the one the caller configured — a launch that succeeds while giving less
 * than it appears. `DECISIONS.md` pre-specified this exact case when it
 * declined engine resolution: *"If resolution is built, the fallback must not
 * be silent."* A validated-then-ignored setting is worse than an absent one,
 * because the validation is itself evidence to the caller that the mechanism
 * is live.
 *
 * So the refusal **names the variable and the path it tried**, which between
 * them are the whole of what the person has to fix — a refusal naming only
 * the variable leaves them looking at a value they have already read and
 * believed once.
 *
 * ── What is deliberately NOT checked ─────────────────────────────────────
 *
 * That the file is executable, and that it is a Chromium. Neither is portably
 * knowable without running it: the executable bit does not exist on Windows,
 * and identifying a Chromium means launching the thing. A launch failure or a
 * missing debugging endpoint reports both of those later and reports them
 * accurately, whereas a guess here would refuse a legitimate binary for a
 * property this code cannot actually see. Existence is the check that is both
 * cheap and true, so it is the one taken.
 */
function readBrowserPath(
  key: string,
  browser: string,
  raw: string,
  fileExists: (candidate: string) => boolean,
): string {
  if (raw.trim() === '') {
    throw new StartupRefusal(
      'config.value_readable',
      `${key} is set but empty. Expected the path of the browser binary to launch for ${JSON.stringify(browser)}; unset it to use the bundled Chromium.`,
    );
  }
  if (raw.includes('\0')) {
    throw new StartupRefusal(
      'config.value_readable',
      `${key} is set to a value that is not a filesystem path. Expected the path of a browser binary, found a string containing a null byte.`,
    );
  }

  const resolved = path.resolve(raw.trim());
  if (!fileExists(resolved)) {
    throw new StartupRefusal(
      'config.value_readable',
      `${key} points at ${JSON.stringify(resolved)}, and there is no file there. The browser ${JSON.stringify(browser)} will not be started from the bundled Chromium instead: a configured binary that is quietly ignored is a launch that succeeds while giving you something other than what you asked for. Correct the path, or unset ${key} to use the bundled Chromium deliberately.`,
    );
  }
  return resolved;
}

/**
 * The shape Chrome gives an extension id: thirty-two characters from the
 * first six letters of the alphabet. Mirrors the check the attach relay runs
 * on connect (`src/attach/` refuses `attached.bad_extension_id` with this
 * same rule); duplicated rather than imported so a bad value refuses at
 * startup, where the refusal can still name the variable, instead of at
 * lease time when it can only fail a caller.
 */
const ATTACHED_EXTENSION_ID = /^[a-p]{32}$/;

/**
 * Read a token: an opaque string that is either there or not there.
 *
 * The rejections are the two §6.3 cases a value with no structure has:
 *
 * - **Blank.** Somebody wrote the variable and meant something by it, and
 *   the empty string is the one thing a token cannot be. Unlike a name
 *   list, there is no "none" for a token to mean: absence is said by not
 *   setting the variable at all.
 * - **A null byte.** The same rule the command reader applies — a value
 *   carrying one cannot survive any transport it would be handed to.
 *
 * **Everything else is used exactly as written**, whitespace included:
 * trimming is a guess about what the operator typed, and a token that fails
 * only at the far end is a worse sentence than one used verbatim.
 *
 * No sentence from this function quotes the value. The variable is named;
 * the value is not (`OptionalTokenDeclaration`).
 */
function readToken(
  declaration: OptionalTokenDeclaration,
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw.trim() === '') {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set but empty. Expected ${declaration.unit}; leave it unset to leave the capability it guards off.`,
    );
  }
  if (raw.includes('\0')) {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set but is not a readable value: it contains a null byte. Expected ${declaration.unit}.`,
    );
  }
  return raw;
}

/** One DNS label as it may appear in a host pattern. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * Read a host-list: comma-separated exact hosts or `*.`-prefixed wildcards.
 *
 * Blank after the split refuses rather than being skipped — unlike a gate's
 * tolerant matching at the point of use, this is the startup check, and a
 * stray comma is somebody mid-edit, not a meaning. A port, a path, a scheme,
 * a space or an underscore is refused the same way: **these are hosts as
 * navigations report them**, and an entry that can never match one is a
 * silent never-allow the operator would debug from the lease side. The
 * wildcard apex rule (`*.x` does not cover `x`, which must be listed itself)
 * belongs to `src/attach/gate.ts` and is not restated here — this function
 * only says an entry is *shape*-legal.
 */
function readHostList(
  declaration: HostListDeclaration,
  raw: string | undefined,
): readonly string[] {
  if (raw === undefined) {
    return declaration.fallback;
  }
  if (raw.includes('\0')) {
    throw new StartupRefusal(
      'config.value_readable',
      `${declaration.key} is set but is not a readable value: it contains a null byte. Expected ${declaration.unit}.`,
    );
  }
  const entries: string[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry === '') {
      throw new StartupRefusal(
        'config.value_readable',
        `${declaration.key} has an empty entry${raw.startsWith(',') || raw.endsWith(',') ? ' (a leading or trailing comma counts as one)' : ''}. Expected ${declaration.unit}; each entry is a host like example.com or a wildcard like *.example.com.`,
      );
    }
    const host = entry.toLowerCase().startsWith('*.') ? entry.slice(2) : entry;
    if (
      !host
        .toLowerCase()
        .split('.')
        .every((label) => HOST_LABEL.test(label))
    ) {
      throw new StartupRefusal(
        'config.value_readable',
        `${declaration.key} contains "${entry}", which is not a host pattern. Each entry is a host like example.com — letters, digits and hyphens in dot-separated labels — or the same with a leading "*." to cover every subdomain. Ports, paths, schemes and wildcards inside a label are not hosts.`,
      );
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Resolve one declaration by its kind.
 *
 * A `switch` over the kind rather than a chain of ternaries, so that adding a
 * further kind is a compile error here rather than a value silently read as
 * whichever branch the chain ended in.
 */
function readDeclaration(
  declaration: Declaration,
  raw: string | undefined,
  home: string,
  platform: NodeJS.Platform,
): string | number | readonly string[] | undefined {
  switch (declaration.kind) {
    case 'path':
      return readPath(declaration, raw, declaration.fallback(home, platform));
    case 'optional-path':
      return readOptionalPath(declaration, raw);
    case 'optional-command':
      return readOptionalCommand(declaration, raw);
    case 'positive-integer':
      return readPositiveInteger(declaration, raw);
    case 'name-list':
      return readNameList(declaration, raw);
    case 'host-list':
      return readHostList(declaration, raw);
    case 'enum':
      return readEnum(declaration, raw);
    case 'token':
      return readToken(declaration, raw);
  }
}

/** One directory the upload root must not overlap, and the sentence saying why. */
interface ReservedLocation {
  readonly key: string;
  readonly location: string;
  readonly why: string;
}

/**
 * Does one directory contain the other, either way round?
 *
 * Compared on resolved paths, and `path.relative` rather than a string prefix:
 * `…/broker` and `…/broker-uploads` share a prefix and neither contains the
 * other, so a `startsWith` test would refuse a configuration that is fine. An
 * empty relative answer means they are the same directory, which counts.
 */
function overlaps(one: string, other: string): boolean {
  const oneToOther = path.relative(one, other);
  const otherToOne = path.relative(other, one);
  const contains = (relative: string): boolean =>
    relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  return contains(oneToOther) || contains(otherToOne);
}

/**
 * How a path is compared: as written, and as the filesystem resolves it.
 *
 * **Both, because each is blind where the other sees** — the same structure
 * `src/store/network-path.ts` uses, and for the same reason.
 *
 * The lexical form catches the ordinary case and is always meaningful. The
 * resolved form is what catches a link or a junction making two
 * lexically-distinct paths one directory, which is the trap the upload guard
 * exists for, applied here to configuration.
 *
 * ── Why a resolved form is only trusted for a path that exists ──────────
 *
 * {@link resolveRealPath} answers for the **nearest existing ancestor** of a
 * path that is not there yet. That is right for the question it was written
 * for — which volume will this file land on — and wrong for this one: two
 * sibling directories that do not exist yet both resolve to their shared
 * parent, and comparing those answers reports an overlap between paths that
 * do not overlap at all.
 *
 * That is not hypothetical. **Every first spawn** has an upload root beside a
 * profile root that has never been created, and a check that resolved both
 * would refuse to start on a configuration that is entirely correct. So a
 * path that does not exist contributes its lexical form only, which is the
 * exact information available about it.
 */
function comparableForms(target: string): readonly string[] {
  const lexical = path.resolve(target);
  if (!fs.existsSync(lexical)) {
    return [lexical];
  }
  const resolved = resolveRealPath(lexical);
  return resolved === lexical ? [lexical] : [lexical, resolved];
}

/**
 * Refuse the spawn if the upload root overlaps anything this service owns.
 *
 * Every form of one is compared against every form of the other, so an
 * overlap visible in either the written paths or the resolved ones refuses.
 */
function refuseOverlappingUploadRoot(
  uploadRoot: string,
  reserved: readonly ReservedLocation[],
): void {
  const uploadForms = comparableForms(uploadRoot);
  for (const entry of reserved) {
    const reservedForms = comparableForms(entry.location);
    const overlapping = uploadForms.some((one) =>
      reservedForms.some((other) => overlaps(one, other)),
    );
    if (overlapping) {
      throw new StartupRefusal(
        'config.value_readable',
        `BROKER_UPLOAD_ROOT is ${uploadRoot}, which overlaps ${entry.key} (${entry.location}). ${entry.why} Point BROKER_UPLOAD_ROOT at a directory that holds only files you intend to be uploadable.`,
      );
    }
  }
}

/**
 * Take the snapshot. Called once, at the start of a spawn.
 *
 * Unrecognised variables are ignored, per §6.3: a process cannot tell an
 * unrecognised variable of its own from any other variable in an environment
 * it shares with everything on the machine.
 */
export function readEnvironment(options: ReadEnvironmentOptions = {}): Environment {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir;
  const home = homedir();

  // One loop over the declarations rather than a call per variable, so a
  // declared variable that nothing reads is impossible: every key in the
  // table is resolved here, and the accessors below fail loudly on a key
  // that is not.
  const resolved = new Map<string, string | number | readonly string[] | undefined>();
  for (const declaration of DECLARATIONS) {
    const raw = env[declaration.key];
    resolved.set(declaration.key, readDeclaration(declaration, raw, home, platform));
  }

  // Every declared key is resolved above, so these cannot be absent. The
  // non-null assertions would be the wrong tool; a throw names the bug.
  const get = (key: string): string => {
    const value = resolved.get(key);
    if (typeof value !== 'string') {
      throw new Error(`${key} was declared as a path but not resolved as one`);
    }
    return value;
  };

  const getNumber = (key: string): number => {
    const value = resolved.get(key);
    if (typeof value !== 'number') {
      throw new Error(`${key} was declared as a number but not resolved as one`);
    }
    return value;
  };

  /**
   * A declared path that may legitimately be absent.
   *
   * Separate from {@link get} rather than a flag on it, because the two have
   * different notions of a bug: a missing value is an error there and an
   * answer here, and one function serving both would have to be told which
   * this call is — which is the declaration's kind, said twice.
   */
  const getOptional = (key: string): string | undefined => {
    const value = resolved.get(key);
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new Error(`${key} was declared as an optional path but not resolved as one`);
    }
    return value;
  };

  const getOptionalCommand = (key: string): readonly string[] | undefined => {
    const value = resolved.get(key);
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      throw new Error(`${key} was declared as an optional command but not resolved as one`);
    }
    return value as readonly string[];
  };

  const getList = (key: string): readonly string[] => {
    const value = resolved.get(key);
    if (!Array.isArray(value)) {
      throw new Error(`${key} was declared as a name list but not resolved as one`);
    }
    return value as readonly string[];
  };

  /**
   * A declared token that may legitimately be absent — see
   * {@link OptionalTokenDeclaration} for why the unset case is an answer.
   */
  const getOptionalToken = (key: string): string | undefined => {
    const value = resolved.get(key);
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new Error(`${key} was declared as a token but not resolved as one`);
    }
    return value;
  };

  const regularBrowsers = getList('BROKER_REGULAR_BROWSERS');
  const privateBrowsers = getList('BROKER_PRIVATE_BROWSERS');
  const attachedBrowsers = getList('BROKER_ATTACHED_BROWSERS');

  // **A name in two lists is refused rather than resolved**, because the
  // browser name is the lease-time key (§3.2): a name written in two kinds
  // has no single answer to *which browser is this*, and picking one would
  // hand a caller the other kind roughly half the time it mattered. Checked
  // here rather than in any list's own reader, because no reader can see the
  // others — and every configured list is in scope, attached included: a
  // browser named in both the signed-in list and the attached list is the
  // same impossible question with a worse second answer: one of the two is a
  // person's own machine.
  const LISTS: readonly [key: string, names: readonly string[]][] = [
    ['BROKER_REGULAR_BROWSERS', regularBrowsers],
    ['BROKER_PRIVATE_BROWSERS', privateBrowsers],
    ['BROKER_ATTACHED_BROWSERS', attachedBrowsers],
  ];
  for (let first = 0; first < LISTS.length; first += 1) {
    for (let second = first + 1; second < LISTS.length; second += 1) {
      const [firstKey, firstNames] = LISTS[first] as [string, readonly string[]];
      const [secondKey, secondNames] = LISTS[second] as [string, readonly string[]];
      for (const name of firstNames) {
        if (secondNames.includes(name)) {
          throw new StartupRefusal(
            'config.value_readable',
            `${JSON.stringify(name)} is named in both ${firstKey} and ${secondKey}. A browser name is what a caller claims by, so a name in two kinds has no single answer: rename one of them.`,
          );
        }
      }
    }
  }

  const attachedTabs = getNumber('BROKER_ATTACHED_TABS');
  const attachedExtensionId = getOptionalToken('BROKER_ATTACHED_EXTENSION_ID');
  const attachedToken = getOptionalToken('BROKER_ATTACHED_TOKEN');
  const attachedActSites = getList('BROKER_ATTACHED_ACT_SITES');
  const ownerGrantSecret = getOptionalToken('BROKER_OWNER_GRANT_SECRET');

  // **The extension id is checked here, not at connect.** It has a shape,
  // unlike the rest of what a token kind accepts, and an attached browser
  // with a wrong one can never be reached: the relay routes by extension id,
  // so the failure would otherwise surface as a queued-then-dead caller with
  // no sentence naming the variable that was wrong. The value is never
  // quoted — the same discipline the token itself is held to, kept uniform
  // rather than argued per variable.
  if (attachedExtensionId !== undefined && !ATTACHED_EXTENSION_ID.test(attachedExtensionId)) {
    throw new StartupRefusal(
      'config.value_readable',
      'BROKER_ATTACHED_EXTENSION_ID is set to a value that is not a Chrome extension id: expected thirty-two lower-case letters from a to p, the alphabet Chrome assigns extension ids. Copy the id Chrome shows for the attach extension, or unset the variable — but see the next sentence before unsetting it.',
    );
  }
  if (attachedBrowsers.length > 0 && attachedExtensionId === undefined) {
    // A half-enabled capability: the list says *listen for an attach*, and
    // the id is what an attach is addressed to. Nothing can satisfy such a
    // configuration, so it refuses rather than starting to fail later —
    // `DECISIONS.md` §13n.
    throw new StartupRefusal(
      'config.value_readable',
      `BROKER_ATTACHED_BROWSERS names ${attachedBrowsers.join(', ')} but BROKER_ATTACHED_EXTENSION_ID is unset. The relay routes an attach to an extension by its id, so an attached browser without one can never be reached. Set BROKER_ATTACHED_EXTENSION_ID to the id Chrome shows for the attach extension, or empty BROKER_ATTACHED_BROWSERS to leave the capability off.`,
    );
  }

  // **The upload root may not overlap anything this service owns**, and this
  // is checked rather than assumed because the default layout makes the
  // mistake a natural one to make. `ownDirectory` puts the store, the artefact
  // root and the profile root under a single parent, so an operator who sets
  // `BROKER_UPLOAD_ROOT` to that parent — an entirely reasonable-looking thing
  // to type — makes every browser profile's cookie store and saved-password
  // database readable into any web page. That is a credential-exfiltration
  // primitive produced by a plausible typo, so it refuses the spawn.
  //
  // **Both directions**, because "the upload root is inside the profile root"
  // and "the profile root is inside the upload root" are both fatal and only
  // one of them is the one people picture.
  //
  // **On realpath-resolved values**, because two lexically different paths can
  // be one directory through a link or a junction — which is the same trap the
  // upload guard itself is built around, applied here to configuration. A
  // purely lexical comparison would pass while describing nothing true.
  const uploadRoot = getOptional('BROKER_UPLOAD_ROOT');
  if (uploadRoot !== undefined) {
    refuseOverlappingUploadRoot(uploadRoot, [
      {
        key: 'BROKER_PROFILE_ROOT',
        location: get('BROKER_PROFILE_ROOT'),
        why: "The profile root holds each browser's cookie store and saved passwords, so an upload root overlapping it would let any lease read a credential into a web page.",
      },
      {
        key: 'BROKER_ARTIFACTS_ROOT',
        location: get('BROKER_ARTIFACTS_ROOT'),
        why: "The artefact root holds every lease's snapshots and captures, so an upload root overlapping it would let one lease read another lease's page content back into a web page.",
      },
      {
        key: 'BROKER_DB',
        location: path.dirname(get('BROKER_DB')),
        why: "The store records every claim and every event, so an upload root overlapping its directory would make the service's own bookkeeping uploadable.",
      },
    ]);
  }

  // Read after the two lists, because the set of keys **is** a function of
  // them: there is no `BROKER_BROWSER_CHECKOUT_PATH` to read until a
  // configuration has said the word `checkout`. Walked in configured order so
  // that a configuration with two bad paths refuses on the first one a reader
  // would meet rather than on whichever the iteration happened to reach.
  //
  // A variable naming a browser that is **not** configured is left alone
  // rather than refused, exactly as any other unrecognised variable is (§6.3):
  // this process cannot tell one of its own from anything else in an
  // environment it shares with the whole machine, and a leftover
  // `BROKER_BROWSER_OLD_PATH` from a renamed browser is not a reason to
  // refuse to start.
  const fileExists =
    options.fileExists ??
    ((candidate: string): boolean => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        // Unreadable and absent are one answer here: neither is a binary this
        // service can launch, and a caller told them apart could act on
        // neither differently.
        return false;
      }
    });

  // Attached names join the walk: for an attached browser the configured
  // binary is not one this service launches — it is the executable whose
  // connect page the operator opens, and the same "a configured path that is
  // quietly ignored" defect applies (§13n).
  const browserPaths = new Map<string, string>();
  for (const browser of [...regularBrowsers, ...privateBrowsers, ...attachedBrowsers]) {
    const key = browserPathVariable(browser);
    const raw = env[key];
    if (raw === undefined) {
      continue;
    }
    browserPaths.set(browser, readBrowserPath(key, browser, raw, fileExists));
  }

  return {
    databasePath: get('BROKER_DB'),
    configuredDatabasePath: env['BROKER_DB'],
    artifactsRoot: get('BROKER_ARTIFACTS_ROOT'),
    profileRoot: get('BROKER_PROFILE_ROOT'),
    uploadRoot,
    secretResolver: getOptionalCommand('BROKER_SECRET_RESOLVER'),
    tabBudget: getNumber('BROKER_TAB_BUDGET'),
    leaseSeconds: getNumber('BROKER_LEASE_SECONDS'),
    queueSeconds: getNumber('BROKER_QUEUE_SECONDS'),
    launchReadinessTimeoutSeconds: getNumber('BROKER_LAUNCH_READINESS_TIMEOUT_SECONDS'),
    regularBrowsers,
    privateBrowsers,
    attachedBrowsers,
    attachedTabs,
    attachedExtensionId,
    attachedToken,
    attachedActSites,
    ownerGrantSecret,
    browserPaths,
  };
}
