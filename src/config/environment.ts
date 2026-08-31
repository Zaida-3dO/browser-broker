import os from 'node:os';
import path from 'node:path';

import { StartupRefusal } from '../errors.ts';

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
type Kind = 'path' | 'positive-integer' | 'name-list' | 'enum';

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

type Declaration = PathDeclaration | IntegerDeclaration | NameListDeclaration | EnumDeclaration;

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
     * Which browser binary the signed-in browsers launch (§6.2).
     *
     * **One engine per kind, never per browser**, for the same reason there is
     * no per-entry private flag: an engine per entry reintroduces the
     * per-entry attribute this configuration exists without.
     *
     * The three accepted words are all Chromium over the same remote-debugging
     * protocol, which is what makes the choice a binary path rather than a
     * second driver.
     */
    key: 'BROKER_REGULAR_BROWSER_ENGINE',
    kind: 'enum',
    fallback: 'msedge',
    allowed: ['chrome', 'brave', 'msedge'],
    unit: 'a browser engine',
  },
  {
    /**
     * Which browser binary the clean-room browsers launch (§6.2).
     *
     * **May differ from the signed-in engine**, and separate variables are
     * what make that expressible: a person signs into the signed-in browser by
     * hand, so which binary that is can be a matter of what they already use,
     * while nobody signs into a clean-room browser at all.
     */
    key: 'BROKER_PRIVATE_BROWSER_ENGINE',
    kind: 'enum',
    fallback: 'msedge',
    allowed: ['chrome', 'brave', 'msedge'],
    unit: 'a browser engine',
  },
] as const satisfies readonly Declaration[];

/** Every variable this build declares. Row #9's walk test reads this. */
export const DECLARED_VARIABLES: readonly string[] = DECLARATIONS.map((d) => d.key);

/**
 * A browser binary this service knows how to launch.
 *
 * All three are Chromium over the same remote-debugging protocol, which is
 * why the choice is a path to resolve rather than a driver to write.
 */
export type BrowserEngine = 'chrome' | 'brave' | 'msedge';

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
  /** Which binary the signed-in browsers launch (§6.2). */
  readonly regularBrowserEngine: BrowserEngine;
  /** Which binary the clean-room browsers launch (§6.2). */
  readonly privateBrowserEngine: BrowserEngine;
}

export interface ReadEnvironmentOptions {
  /** The raw environment. Injected so a test does not mutate the real one. */
  readonly env?: NodeJS.ProcessEnv;
  readonly homedir?: () => string;
  readonly platform?: NodeJS.Platform;
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
 * Resolve one declaration by its kind.
 *
 * A `switch` over the kind rather than a chain of ternaries, so that adding a
 * fifth kind is a compile error here rather than a value silently read as
 * whichever branch the chain ended in.
 */
function readDeclaration(
  declaration: Declaration,
  raw: string | undefined,
  home: string,
  platform: NodeJS.Platform,
): string | number | readonly string[] {
  switch (declaration.kind) {
    case 'path':
      return readPath(declaration, raw, declaration.fallback(home, platform));
    case 'positive-integer':
      return readPositiveInteger(declaration, raw);
    case 'name-list':
      return readNameList(declaration, raw);
    case 'enum':
      return readEnum(declaration, raw);
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
  const resolved = new Map<string, string | number | readonly string[]>();
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

  const getList = (key: string): readonly string[] => {
    const value = resolved.get(key);
    if (!Array.isArray(value)) {
      throw new Error(`${key} was declared as a name list but not resolved as one`);
    }
    return value as readonly string[];
  };

  // The reader already refused anything outside the declared set, so this
  // narrows a checked value rather than trusting one.
  const getEngine = (key: string): BrowserEngine => {
    const value = resolved.get(key);
    if (value !== 'chrome' && value !== 'brave' && value !== 'msedge') {
      throw new Error(`${key} was declared as an engine but not resolved as one`);
    }
    return value;
  };

  const regularBrowsers = getList('BROKER_REGULAR_BROWSERS');
  const privateBrowsers = getList('BROKER_PRIVATE_BROWSERS');

  // **A name in both lists is refused rather than resolved**, because the
  // profile name is the lease-time key (§3.2): a name written in both kinds
  // has no single answer to *which browser is this*, and picking one of the
  // two would hand a caller the other kind roughly half the time it mattered.
  // Checked here rather than in either list's own reader, because neither
  // reader can see the other list.
  for (const name of regularBrowsers) {
    if (privateBrowsers.includes(name)) {
      throw new StartupRefusal(
        'config.value_readable',
        `${JSON.stringify(name)} is named in both BROKER_REGULAR_BROWSERS and BROKER_PRIVATE_BROWSERS. A browser name is what a caller claims by, so a name in both kinds has no single answer: rename one of them.`,
      );
    }
  }

  return {
    databasePath: get('BROKER_DB'),
    configuredDatabasePath: env['BROKER_DB'],
    artifactsRoot: get('BROKER_ARTIFACTS_ROOT'),
    profileRoot: get('BROKER_PROFILE_ROOT'),
    tabBudget: getNumber('BROKER_TAB_BUDGET'),
    leaseSeconds: getNumber('BROKER_LEASE_SECONDS'),
    queueSeconds: getNumber('BROKER_QUEUE_SECONDS'),
    launchReadinessTimeoutSeconds: getNumber('BROKER_LAUNCH_READINESS_TIMEOUT_SECONDS'),
    regularBrowsers,
    privateBrowsers,
    regularBrowserEngine: getEngine('BROKER_REGULAR_BROWSER_ENGINE'),
    privateBrowserEngine: getEngine('BROKER_PRIVATE_BROWSER_ENGINE'),
  };
}
