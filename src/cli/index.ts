import type { OperationName } from '../adapter/operations.ts';
import type { BrokerService } from '../adapter/service-seam.ts';
import fs from 'node:fs';

import { readEnvironment, type Environment } from '../config/environment.ts';
import { BrokerError } from '../errors.ts';
import { openStore, type StoreHandle } from '../store/open.ts';
import { stepSchema } from '../store/schema/step.ts';
import {
  DEFAULT_LIMIT,
  readFeedback,
  refuseFilters,
  renderFeedback,
  type FeedbackFilters,
} from '../feedback/read.ts';
import { isFeedbackCategory } from '../feedback/record.ts';
import { cliAdapter, EXIT, parseArguments, withoutSecrets } from './adapter.ts';
import { OPERATION_COMMANDS, parseCommand, STANDALONE_COMMANDS } from './commands.ts';
import { describeSetupReport, runSetupHandshake } from '../browser/setup.ts';
import { runDiffs } from './diffs.ts';
import { runDoctorCommand, runEventsCommand, runSnapshotCommand } from './operations-commands.ts';

/**
 * Argument parsing and command dispatch.
 *
 * Thin on purpose: row #29 fills the command surface. What this row owes is
 * the **seam** — a dispatcher that takes an argument vector and returns an
 * exit code, importable and therefore drivable **in process**.
 * `MILESTONES.md` reserves spawning for the case where the process boundary
 * is itself the thing under test, and asks for the command line to be driven
 * through its entry point with an argument vector for the parity suite
 * (#25/#30). If the dispatcher and the executable shim were one file, that
 * would be impossible without spawning.
 */

/** Where output goes, injected so a test reads it instead of the terminal. */
export interface Streams {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface RunOptions {
  readonly streams?: Streams;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The service this run calls.
   *
   * Injected rather than constructed here, and that is the seam the whole
   * parity claim rests on: `MILESTONES.md` asks for the command line to be
   * driven "through its entry point with an argument vector", in process. A
   * dispatcher that built its own service could only be tested by spawning,
   * and a conformance driver that went around this function would be
   * measuring the service rather than the route.
   *
   * **When it is absent, the service layer is not reachable and commands say
   * so** rather than guessing. The service layer is not built yet (row #10
   * onward); see {@link serviceUnavailable}.
   */
  readonly service?: BrokerService;
}

const defaultStreams: Streams = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/**
 * The version this build reports. Read from the manifest rather than written
 * twice, so the two cannot disagree.
 */
async function readVersion(): Promise<string> {
  const manifest = await import('../../package.json', { with: { type: 'json' } });
  const version: unknown = (manifest.default as { version?: unknown }).version;
  return typeof version === 'string' ? version : '0.0.0';
}

/**
 * Usage, assembled from the command table rather than written out beside it.
 *
 * Two lists that have to agree is one list somebody eventually forgets, and
 * the forgetting is silent: a command that works and is undocumented reads
 * exactly like one that does not exist.
 */
function usage(): string {
  const pad = (words: readonly string[]): string => `broker ${words.join(' ')}`.padEnd(22);
  return [
    'broker — brokers access to a fixed set of browsers.',
    '',
    'Usage:',
    '  broker                open the store, step its schema, report and exit',
    '  broker --version      print the version this build reports',
    '  broker --help         print this message',
    '',
    'Operations — every one of these is one service call:',
    ...OPERATION_COMMANDS.map((command) => `  ${pad(command.words)}${command.summary}`),
    '',
    'Commands with no operation behind them:',
    ...STANDALONE_COMMANDS.map((command) => `  ${pad(command.words)}${command.summary}`),
    '',
    'Output: human-readable by default; --json for one document per call,',
    'with all human text on the error stream.',
  ].join('\n');
}

/**
 * What `broker <command> --help` prints.
 *
 * ── Why asking a command for help must not print the whole table ────────
 *
 * A global `--help` branch that matches the flag **anywhere in the argument
 * vector** answers every per-command request with the top-level table. The
 * caller asked what `doctor` does and is handed the list of every command,
 * which is the one answer they already had — and worse, it reads as though
 * `doctor` has no help rather than as though the flag was swallowed.
 *
 * The summary is taken from the command table rather than written out again
 * here, for the reason that table's own header gives: two lists that have to
 * agree is one list somebody eventually forgets, and the forgetting is silent.
 */
function commandUsage(words: readonly string[], summary: string): string {
  return [
    `broker ${words.join(' ')} — ${summary}`,
    '',
    'Usage:',
    `  broker ${words.join(' ')} [options]`,
    '',
    'Options:',
    '  --json                one document on the output stream, human text on the error stream',
    '  --help                print this message',
    '',
    'Run `broker --help` for every command.',
  ].join('\n');
}

/**
 * The setup handshake every spawn runs (`SCHEMA.md` §1.2d).
 *
 * "Every spawn runs it, not just the first one" — which is not belt and
 * braces but the only workable arrangement when there is no long-lived
 * process to have done it once. It is idempotent by design: it creates what
 * is absent and leaves alone what is present.
 *
 * The browser rows, the profile directories and the browsers themselves are
 * the rest of that table and belong to rows #7 and #19 onward. What this row
 * wires is the part that has to happen before any of them: the file, the
 * pragmas, and the schema version.
 */
async function openAndStep(environment: Environment, streams: Streams): Promise<StoreHandle> {
  const store = openStore(environment);
  const stepped = await stepSchema(store.db);

  streams.out(`store: ${store.location}`);
  if (stepped.applied.length === 0) {
    streams.out(`schema: already at version ${String(stepped.to)}, nothing to do`);
  } else {
    streams.out(
      `schema: stepped from version ${String(stepped.from)} to ${String(stepped.to)} (${String(stepped.applied.length)} step(s) applied)`,
    );
  }
  return store;
}

/**
 * Run the command line.
 *
 * Returns an exit code rather than calling out to the process, so the whole
 * of it is reachable from a test. Non-zero on refusal, with the reason on the
 * error stream.
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const streams = options.streams ?? defaultStreams;
  const json = argv.includes('--json');

  const wantsHelp = argv.includes('--help') || argv.includes('-h');

  // **Asked of a command, answered by that command.** The flag is dispatched
  // through the command table first, so `broker doctor --help` describes
  // `doctor`. Only a request that names no command falls through to the table
  // of everything — which is what `broker --help` means and all it means.
  if (wantsHelp) {
    const parsed = parseCommand(argv);
    if (parsed.kind === 'operation' || parsed.kind === 'standalone') {
      streams.out(commandUsage(parsed.command.words, parsed.command.summary));
      return EXIT.accepted;
    }
    streams.out(usage());
    return EXIT.accepted;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    streams.out(await readVersion());
    return EXIT.accepted;
  }

  if (argv.length > 0) {
    const parsed = parseCommand(argv);

    if (parsed.kind === 'operation') {
      // `broker feedback` carries **both halves** (§5.3): it writes a row with
      // the same arguments the tool takes, and **with no writing arguments it
      // reads the rows back**. The reading half has no service operation
      // behind it — a caller writes feedback and a person reads it — so it is
      // dispatched before the operation path rather than through it.
      if (parsed.command.operation === 'feedback' && isReadingFeedback(parsed.rest)) {
        return readFeedbackCommand(parsed.rest, { streams, json, options });
      }
      return runOperation(parsed.command.operation, parsed.rest, { streams, json, options });
    }

    if (parsed.kind === 'standalone') {
      const name = parsed.command.words.join(' ');

      // Built, and reaching their implementations. `login` is the one still
      // owed, and it keeps the honest refusal below rather than being quietly
      // absent — a command that pretended to work would be worse than one
      // that says it does not.
      if (name === 'snapshot' || name === 'doctor' || name === 'events' || name === 'diffs') {
        return await runOperationsCommand(name, parsed.rest, { streams, json, options });
      }

      if (name === 'init') {
        return await runInitCommand({ streams, json, options });
      }

      streams.err(`broker ${name} is not built yet — owed by ${parsed.command.owedBy}.`);
      return EXIT.unexpected;
    }

    // Reading the ledger is on the operations command surface (§5.4) rather
    // than being one of §5.5's four, so it is not in either table above: it
    // is neither a mirror of an agent operation nor a command with a written
    // waiver. It is a read of history, and it decides nothing.
    if (parsed.kind === 'unknown' && argv[0] === 'events') {
      return await runOperationsCommand('events', argv.slice(1), { streams, json, options });
    }
  }

  const unknownFlag = argv.find((argument) => argument.startsWith('-') && argument !== '--json');
  if (unknownFlag !== undefined) {
    streams.err(`Unrecognised option: ${unknownFlag}`);
    streams.err(usage());
    return EXIT.malformed;
  }

  if (argv.length > 0) {
    streams.err(`Unrecognised command: ${String(argv[0])}`);
    streams.err(usage());
    return EXIT.malformed;
  }

  let store: StoreHandle | undefined;
  try {
    const environment = readEnvironment({ env: options.env });
    store = await openAndStep(environment, streams);
    return EXIT.accepted;
  } catch (error) {
    if (error instanceof BrokerError) {
      // A refusal: this service declining to run, named by the rule that
      // refused. Not a stack trace — the message is the whole of what the
      // person who set the variable needs.
      streams.err(`refused (${error.rule}): ${error.message}`);
      return EXIT.unexpected;
    }
    throw error;
  } finally {
    store?.close();
  }
}

/**
 * The refusal every operation command gives while the service layer is
 * unbuilt.
 *
 * **This is a stub with a seam behind it, and it is deliberately not a
 * pretend success.** The service layer is row #10 onward and is not on `main`
 * yet; a command that answered `accepted` without one would be a route
 * reporting an operation that did not happen — the precise failure
 * `DECISIONS.md` §5 is about, in the other direction.
 *
 * It is shaped as an ordinary refusal rather than a crash so that the whole
 * refusal path — the exit code, the rule name, the machine-readable
 * document, the never-printed fields — is exercised by real tests now, and so
 * that the join is a substitution rather than a rewrite: pass a real
 * {@link BrokerService} and every command routes to it with nothing else
 * changing.
 */
export function serviceUnavailable(): BrokerService {
  return {
    perform: (request) =>
      Promise.resolve({
        outcome: 'refused' as const,
        code: 'service_unavailable',
        rule: 'service.not_built',
        message: `The service layer this build would call for "${request.operation}" is not present. Supply a service to run this command.`,
      }),
  };
}

interface OperationContext {
  readonly streams: Streams;
  readonly json: boolean;
  readonly options: RunOptions;
}

/**
 * Run one operation command: resolve the input, make **one** service call,
 * shape the outcome for a terminal.
 *
 * The three steps are the whole of an adapter's job (`CLAUDE.md`), and they
 * are in this order on purpose — nothing between the resolve and the call can
 * decide anything, because a decision here would be a rule that holds on this
 * route and nowhere else.
 */
async function runOperation(
  operation: OperationName,
  rest: readonly string[],
  context: OperationContext,
): Promise<number> {
  const service = context.options.service ?? serviceUnavailable();
  const outcome = await cliAdapter.invoke(service, operation, [...rest]);

  if (outcome.outcome === 'accepted') {
    // §5.6: a machine-readable mode produces one document per call and puts
    // all human text on the error stream, "so a caller that did not ask for
    // prose gets none".
    //
    // ── The one command that keeps its key, and why ───────────────────────
    //
    // §5.6's rule is that the lease key is never printed, and it is
    // load-bearing: "absent rather than masked" is the specification, because
    // a masked field advertises that a secret exists and is one format change
    // from being the real one. That rule is kept everywhere here except the
    // grant, which is the single named hole — spelled exactly as the tool
    // surface spells its own in `tool/session.ts`, so the two surfaces state
    // one rule rather than two.
    //
    // Without the hole, `broker claim` was a command that **succeeded and
    // could not be used**. It takes real capacity — §2.3 makes grants and
    // tabs the same integer — mints a lease, and then withheld the only thing
    // that can address it. §2.2 returns a key once and makes it unrecoverable
    // by construction, so there was no second way to learn it: the lease sat
    // holding a tab until its lifetime elapsed, and every one of the nine
    // keyed commands on this surface was unreachable for it. A command that
    // silently spends bounded capacity on an unusable lease is worse than one
    // that refuses.
    //
    // Removing `claim` from this surface was the alternative and is the wrong
    // one: `commands.ts` exists so that "every §3 operation has a command, so
    // parity is real rather than claimed", and dropping one would make that
    // sentence false to buy a secrecy the tool surface does not keep either.
    //
    // The exception is as narrow as it can be. It is keyed on the operation
    // being `claim`, so it cannot widen to a command added later; every other
    // command, and every refusal on every command including this one, still
    // goes through `withoutSecrets`.
    const value = operation === 'claim' ? outcome.value : withoutSecrets(outcome.value);
    if (context.json) {
      context.streams.out(JSON.stringify({ outcome: 'accepted', value }));
    } else {
      context.streams.out(renderForAPerson(value));
    }
    return EXIT.accepted;
  }

  const details = outcome.details === undefined ? undefined : withoutSecrets(outcome.details);
  if (context.json) {
    context.streams.out(
      JSON.stringify({
        outcome: 'refused',
        code: outcome.code,
        rule: outcome.rule,
        ...(details === undefined ? {} : { details }),
      }),
    );
    // The sentence is for a person, so in the machine-readable mode it goes
    // to the error stream rather than into the document (§5.6).
    context.streams.err(outcome.message);
  } else {
    context.streams.err(`refused (${outcome.rule}): ${outcome.message}`);
  }
  return EXIT.refused;
}

/**
 * The sentence a person gets when an operation was accepted but no browser
 * was reached.
 *
 * ── Why the boolean is not enough on this surface ───────────────────────
 *
 * `pageDriven` is what a *caller* branches on, and the machine-readable mode
 * prints it as-is because that mode is for a program. The default mode is for
 * a person, and §5.6 puts the prose there for exactly that reason. A line
 * reading `pageDriven: false` among four identifiers is true, but it asks the
 * reader to already know what the field means — and the whole defect being
 * fixed here is a truth that was only legible to someone who already knew
 * where to look. So the person-facing surface says it in words.
 *
 * It is derived from the same field rather than from a second source, so
 * there is no way for the sentence and the boolean to disagree.
 */
const NO_BROWSER_NOTE =
  'note: no browser is attached in this build, so the page was not driven. ' +
  'The lease, its tab and this decision are real and recorded; nothing was ' +
  'navigated, read or captured.';

/** Human-readable by default (§5.6): one `key: value` line per field. */
function renderForAPerson(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return String(value);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return 'done';
  }
  const lines = entries.map(
    ([key, entry]) =>
      `${key}: ${typeof entry === 'object' && entry !== null ? JSON.stringify(entry) : String(entry)}`,
  );
  if ((value as Record<string, unknown>).pageDriven === false) {
    lines.push(NO_BROWSER_NOTE);
  }
  return lines.join('\n');
}

/**
 * Run one of the three operations commands.
 *
 * ── Why `doctor` opens the store differently from the other two ─────────
 *
 * `snapshot` and `events` read the store, so they need one. **`doctor` must
 * answer without one** — a store that does not exist yet is a legitimate
 * state to ask about, and arguably the state where the answer is most useful,
 * since it is the one somebody has just installed into.
 *
 * It opens the store **only if one is already there, and never steps it**.
 * Both halves are load-bearing and the first was learned the hard way:
 * `openStore` creates the directory and the file, so a doctor that opened
 * unconditionally would *create* an empty store at version zero and then
 * truthfully report it as being at the wrong version — a failure the command
 * had itself caused, on an installation that was fine a moment earlier.
 * Reporting a fault you just produced is worse than reporting nothing. There
 * is no open-but-do-not-create mode to ask for, so the only way not to create
 * one is not to open one.
 *
 * The other two step on the way in, because `SCHEMA.md` §1.2d puts stepping
 * on every spawn.
 */
/**
 * `broker init` — run the setup handshake explicitly and show what it did.
 *
 * ── What the handshake is, and why a command runs it on purpose ─────────
 *
 * §1.2d describes this as what every spawn does: step the schema, confirm the
 * two browser rows are present, and establish a profile directory for each
 * browser — **creating one that is absent and using one that is present.**
 *
 * That last distinction is the whole point of the command existing separately
 * from the bare spawn. A signed-in profile holds a login **a person
 * established by hand**, and there is no recovering it if it is thrown away:
 * recreating the directory would sign them out, silently, at the moment they
 * were least expecting it. So the handshake never recreates and never clears,
 * and `broker init` is how somebody confirms that for themselves before
 * trusting the browsers to a run — the report names each profile as `created`
 * or `found`, which is exactly the question being asked.
 *
 * The store is opened and stepped first, because the handshake reads the
 * schema version and the browser rows out of it and refuses a store that has
 * not been stepped.
 */
async function runInitCommand(context: {
  streams: Streams;
  json: boolean;
  options: RunOptions;
}): Promise<number> {
  const { streams, json } = context;
  let store: StoreHandle | undefined;

  try {
    const environment = readEnvironment({ env: context.options.env });
    store = openStore(environment);
    await stepSchema(store.db);

    const report = await runSetupHandshake(store, environment.profileRoot);

    if (json) {
      streams.out(JSON.stringify(report, null, 2));
    } else {
      streams.out(`schema: version ${String(report.schemaVersion)}`);
      streams.out(`browsers: ${report.browserRows.join(', ')}`);
      for (const line of describeSetupReport(report)) {
        streams.out(line);
      }
    }
    return EXIT.accepted;
  } catch (error) {
    if (error instanceof BrokerError) {
      streams.err(`refused (${error.rule}): ${error.message}`);
      return EXIT.refused;
    }
    throw error;
  } finally {
    store?.close();
  }
}

async function runOperationsCommand(
  command: 'snapshot' | 'doctor' | 'events' | 'diffs',
  rest: readonly string[],
  context: { streams: Streams; json: boolean; options: RunOptions },
): Promise<number> {
  const { streams, json } = context;
  let store: StoreHandle | undefined;

  try {
    const environment = readEnvironment({ env: context.options.env });

    if (command === 'doctor') {
      let opened: StoreHandle | undefined;
      if (fs.existsSync(environment.databasePath)) {
        try {
          opened = openStore(environment);
        } catch (error) {
          if (!(error instanceof BrokerError)) {
            throw error;
          }
          // The store is there and could not be opened. The checks read the
          // environment and the filesystem directly, so the report is still
          // worth producing — and the location check names the same refusal.
        }
      }
      try {
        return runDoctorCommand({ db: opened?.db, environment, streams, json });
      } finally {
        opened?.close();
      }
    }

    store = openStore(environment);
    await stepSchema(store.db);

    if (command === 'snapshot') {
      return await runSnapshotCommand(rest, {
        db: store.db,
        streams,
        json,
        version: await readVersion(),
      });
    }
    if (command === 'diffs') {
      // Reading the comparison history back. It takes the same stepped store
      // the other reads do; what it does not take is a lease, because it
      // decides nothing.
      return runDiffs(rest, { db: store.db, streams });
    }
    return runEventsCommand(rest, { db: store.db, streams, json });
  } catch (error) {
    if (error instanceof BrokerError) {
      streams.err(`refused (${error.rule}): ${error.message}`);
      return EXIT.refused;
    }
    throw error;
  } finally {
    store?.close();
  }
}

/**
 * Whether this invocation is the reading half.
 *
 * **Reading is the default and writing is the flagged case**, which is the
 * way round §5.3 describes: "with no arguments it reads the rows back". A
 * submission is recognised by carrying `--rating`, which is required on every
 * write — so a caller that meant to write and mistyped the flag gets a
 * listing rather than a row it did not intend, and a caller that meant to
 * read never accidentally writes.
 */
export function isReadingFeedback(rest: readonly string[]): boolean {
  return !rest.some((word) => word === '--rating' || word.startsWith('--rating='));
}

/**
 * `broker feedback` — read the rows back, most recent first (#68).
 *
 * It opens the store and reads one table. **That is not a route reaching past
 * the service layer**, and the distinction is worth stating rather than
 * assuming: the reader rule (§2.4, §5.2) exists because a command that
 * printed `state` from a table would report leases that do not exist, since
 * liveness is derived rather than stored. **Feedback has no derived state.**
 * A row is written once and never changes, no sweep touches it, and nothing
 * expires — so there is nothing a service call would derive that this read
 * would miss. Every other command goes through the service because for every
 * other command that is false.
 */
async function readFeedbackCommand(
  rest: readonly string[],
  context: OperationContext,
): Promise<number> {
  const parsed = parseArguments(rest);
  const asInteger = (value: unknown): unknown =>
    typeof value === 'string' && /^-?\d+$/u.test(value) ? Number(value) : value;

  const requested = {
    ...(parsed['rating'] === undefined ? {} : { rating: asInteger(parsed['rating']) }),
    ...(parsed['category'] === undefined ? {} : { category: parsed['category'] }),
    ...(parsed['limit'] === undefined ? {} : { limit: asInteger(parsed['limit']) }),
  };

  const refusal = refuseFilters(requested);
  if (refusal !== undefined) {
    context.streams.err(`refused (${refusal.code}): ${refusal.message}`);
    return EXIT.malformed;
  }

  const filters: FeedbackFilters = {
    ...(typeof requested.rating === 'number' ? { rating: requested.rating } : {}),
    ...(typeof requested.category === 'string' && isFeedbackCategory(requested.category)
      ? { category: requested.category }
      : {}),
    limit: typeof requested.limit === 'number' ? requested.limit : DEFAULT_LIMIT,
  };

  let store: StoreHandle | undefined;
  try {
    const environment = readEnvironment({ env: context.options.env });
    store = openStore(environment);
    await stepSchema(store.db);

    const rows = readFeedback(store.db, filters);
    const narrowed = filters.rating !== undefined || filters.category !== undefined;

    if (context.json) {
      context.streams.out(JSON.stringify({ outcome: 'accepted', value: { feedback: rows } }));
    } else {
      context.streams.out(renderFeedback(rows, narrowed));
    }
    return EXIT.accepted;
  } catch (error) {
    if (error instanceof BrokerError) {
      context.streams.err(`refused (${error.rule}): ${error.message}`);
      return EXIT.notConfigured;
    }
    throw error;
  } finally {
    store?.close();
  }
}
