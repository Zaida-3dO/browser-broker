import { readEnvironment, type Environment } from '../config/environment.ts';
import { BrokerError } from '../errors.ts';
import { openStore, type StoreHandle } from '../store/open.ts';
import { stepSchema } from '../store/schema/step.ts';

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

const USAGE = [
  'broker — brokers access to a fixed set of browsers.',
  '',
  'Usage:',
  '  broker            open the store, step its schema, report and exit',
  '  broker --version  print the version this build reports',
  '  broker --help     print this message',
].join('\n');

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

  if (argv.includes('--help') || argv.includes('-h')) {
    streams.out(USAGE);
    return 0;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    streams.out(await readVersion());
    return 0;
  }

  const unknownFlag = argv.find((argument) => argument.startsWith('-'));
  if (unknownFlag !== undefined) {
    streams.err(`Unrecognised option: ${unknownFlag}`);
    streams.err(USAGE);
    return 2;
  }

  if (argv.length > 0) {
    // Command nouns belong to the rows that own them — `init` to #44,
    // `doctor` to #71 — so this row defines none of them rather than
    // squatting on a name and having it mean something narrower later.
    streams.err(`Unrecognised command: ${String(argv[0])}`);
    streams.err(USAGE);
    return 2;
  }

  let store: StoreHandle | undefined;
  try {
    const environment = readEnvironment({ env: options.env });
    store = await openAndStep(environment, streams);
    return 0;
  } catch (error) {
    if (error instanceof BrokerError) {
      // A refusal: this service declining to run, named by the rule that
      // refused. Not a stack trace — the message is the whole of what the
      // person who set the variable needs.
      streams.err(`refused (${error.rule}): ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    store?.close();
  }
}
