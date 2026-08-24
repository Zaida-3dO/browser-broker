import type { OperationName } from '../adapter/operations.ts';
import type { BrokerService } from '../adapter/service-seam.ts';
import { readEnvironment, type Environment } from '../config/environment.ts';
import { BrokerError } from '../errors.ts';
import { openStore, type StoreHandle } from '../store/open.ts';
import { stepSchema } from '../store/schema/step.ts';
import { cliAdapter, EXIT, withoutSecrets } from './adapter.ts';
import { OPERATION_COMMANDS, parseCommand, STANDALONE_COMMANDS } from './commands.ts';

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

  if (argv.includes('--help') || argv.includes('-h')) {
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
      return runOperation(parsed.command.operation, parsed.rest, { streams, json, options });
    }

    if (parsed.kind === 'standalone') {
      // The command is named and documented here because it exists on this
      // route (§5.5) — but the row that builds it has not landed, and a
      // command that pretended to work would be worse than one that says it
      // does not. Named honestly, with the row that owes it.
      streams.err(
        `broker ${parsed.command.words.join(' ')} is not built yet — owed by ${parsed.command.owedBy}.`,
      );
      return EXIT.unexpected;
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
    const value = withoutSecrets(outcome.value);
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

/** Human-readable by default (§5.6): one `key: value` line per field. */
function renderForAPerson(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return String(value);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return 'done';
  }
  return entries
    .map(
      ([key, entry]) =>
        `${key}: ${typeof entry === 'object' && entry !== null ? JSON.stringify(entry) : String(entry)}`,
    )
    .join('\n');
}
