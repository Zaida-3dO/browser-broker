import type { OperationName } from '../adapter/operations.ts';
import type { BrokerService, OperationOutcome } from '../adapter/service-seam.ts';
import fs from 'node:fs';

import { readEnvironment, type Environment } from '../config/environment.ts';
import { BrokerError } from '../errors.ts';
import { openStoreForDiagnosis, prepareStore, type StoreHandle } from '../store/open.ts';
import {
  DEFAULT_LIMIT,
  readFeedback,
  refuseFilters,
  renderFeedback,
  type FeedbackFilters,
} from '../feedback/read.ts';
import { isFeedbackCategory } from '../feedback/record.ts';
import { cliAdapter, EXIT, parseArguments, withoutSecrets } from './adapter.ts';
import {
  OPERATION_COMMANDS,
  parseCommand,
  STANDALONE_COMMANDS,
  type CommandOption,
} from './commands.ts';
import { describeSetupReport, runSetupHandshake } from '../browser/setup.ts';
import { ArtifactStore } from '../artifacts/store.ts';
import { runDiffs } from './diffs.ts';
import { runCaptures } from './telemetry.ts';
import { runImage } from './image.ts';
import { runDoctorCommand, runEventsCommand, runSnapshotCommand } from './operations-commands.ts';
import { explainLoginFailure, runLoginCommand } from './login-command.ts';
import type { Broker } from '../service/broker.ts';

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

  /**
   * The typed service, for `login` — which is not one of the ten operations.
   *
   * A second field alongside {@link RunOptions.service} rather than one field,
   * because the two carry different surfaces on purpose: `service` is the
   * flat ten-operation seam every adapter drives and every parity assertion
   * is made over, and signing in is deliberately not on it (§5.4: the
   * administrative operations "are not on the agent surface and adding them
   * there fails the build"). A command that needs this and does not get it
   * says so rather than guessing.
   */
  readonly broker?: Broker;
  /** The open store, for the commands that need the setup handshake. */
  readonly store?: StoreHandle;
  /** The environment snapshot the runtime already read (§6.3: one per process). */
  readonly environment?: Environment;

  /**
   * How `claim --wait` waits between polls, injected for the same reason
   * {@link RunOptions.service} is.
   *
   * The interval `--wait` honours is **just under the queue-place lifetime**
   * (§5.3), which against the default is nine minutes. A test that waited
   * that long would not be run, and one that shortened the wait by reaching
   * into the clock would be measuring a different mechanism than the one that
   * ships. So the *sleeping* is injectable and the *duration* is not: a test
   * substitutes a sleep that returns immediately and **records what it was
   * asked to wait**, which is the assertion that matters — that the loop
   * honours the number the service told it, rather than one of its own.
   *
   * Absent, it is a real timer.
   */
  readonly sleep?: (milliseconds: number) => Promise<void>;
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
function commandUsage(
  words: readonly string[],
  summary: string,
  options: readonly CommandOption[] = [],
): string {
  // The command's own options come from the command table rather than from a
  // list kept here, for the reason that table's header gives: two lists that
  // have to agree is one list somebody eventually forgets.
  const width = Math.max(21, ...options.map((option) => option.flag.length + 2));
  return [
    `broker ${words.join(' ')} — ${summary}`,
    '',
    'Usage:',
    `  broker ${words.join(' ')} [options]`,
    '',
    'Options:',
    ...options.map((option) => `  ${option.flag.padEnd(width)}${option.summary}`),
    `  ${'--json'.padEnd(width)}one document on the output stream, human text on the error stream`,
    `  ${'--help'.padEnd(width)}print this message`,
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
  // The spawn path, which steps the schema and settles the budget agreement.
  //
  // **The report below reads `store.stepped` rather than stepping again.**
  // Stepping is idempotent, so a second call would truthfully answer "nothing
  // to do" — and this command would then report a store it had just created
  // from nothing as having already been at the current version.
  const store = await prepareStore(environment);
  const stepped = store.stepped;

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
 * The store this run works on: the one the spawn already opened, or a fresh
 * prepared one when nothing was supplied.
 *
 * ── Why a command must not simply open its own ──────────────────────────
 *
 * A shipped binary builds its runtime before dispatching, and that runtime has
 * already opened, stepped and settled the budget agreement on the store this
 * process is going to use (`src/bin/broker.ts`). A command that opened a
 * second one would put **two independent open paths in a single spawn**, and
 * two paths that each perform the same startup obligations are two paths that
 * can drift — with the drift invisible, because whichever one is still correct
 * satisfies any end-to-end assertion on its own. Measured: with the runtime's
 * agreement removed, a disagreeing spawn was still refused by the other path,
 * so nothing observable changed and no test could see the loss.
 *
 * So the supplied handle wins whenever there is one, and `owned` says whether
 * this run is the one that has to close it — closing a store the runtime owns
 * would pull the file out from under everything else the spawn is doing.
 *
 * Opening is still possible for the caller that supplied nothing: `run` is
 * driven in-process with an argument vector by the conformance suite and by
 * most command tests, and that caller has no runtime. It gets `prepareStore`,
 * which is the same three obligations in the same order.
 */
async function storeForRun(
  options: RunOptions,
  environment: Environment,
): Promise<{ store: StoreHandle; owned: boolean }> {
  if (options.store !== undefined) {
    return { store: options.store, owned: false };
  }
  return { store: await prepareStore(environment), owned: true };
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
      streams.out(
        commandUsage(parsed.command.words, parsed.command.summary, parsed.command.options),
      );
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
      if (
        name === 'snapshot' ||
        name === 'doctor' ||
        name === 'events' ||
        name === 'diffs' ||
        name === 'captures' ||
        name === 'image'
      ) {
        return await runOperationsCommand(name, parsed.rest, { streams, json, options });
      }

      if (name === 'init') {
        return await runInitCommand({ streams, json, options });
      }

      if (name === 'login') {
        return await runLogin(parsed.rest, { streams, json, options });
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
 * Whether this invocation asked to wait.
 *
 * Read off the argument vector rather than out of `parseArguments`, because
 * the parser is the *service's* input shaping — every key it produces is sent
 * on as an operation argument. `--wait` is not an argument to `claim` (§3.2
 * has no such field) and must not become one: it is a behaviour of this route
 * and of nothing else, which is the distinction §5.3 draws when it says this
 * is "the one place this route does something the tool surface does not".
 */
function wantsWait(rest: readonly string[]): boolean {
  return rest.includes('--wait');
}

/**
 * Poll a queued claim until it is granted, its place is lost, or it is
 * refused.
 *
 * ── The interval is the service's number, not this route's ──────────────
 *
 * §5.3 says "just under the lease lifetime", and the queued response already
 * carries that number as `checkBackSeconds` — computed by
 * `checkBackSeconds()` in the claim operation as nine parts in ten of the
 * place's lifetime. **This reads it off the response rather than recomputing
 * it**, so a deployment that shortens `BROKER_QUEUE_SECONDS` moves the poll
 * with it and this file has no second opinion to drift. The scheduling nudge
 * the queued caller is handed and the schedule `--wait` actually keeps are
 * therefore the same number by construction.
 *
 * The fallback exists only for a response with no such field, and is
 * deliberately the same nine-parts-in-ten rule rather than a constant.
 *
 * ── Polling is renewing, and there is no renew verb ─────────────────────
 *
 * §2.5: "any call carrying this key extends the place". `status` is that
 * call — it extends the lease as the *effect* of asking, which is why row #14
 * refuses to make renewal a verb of its own. So this loop calls `status` and
 * nothing else: the place is held **because** it is being asked about, and a
 * caller that stops asking loses it to the same lazy sweep that expires
 * leases. Adding a renew here would be inventing the verb the design removed.
 *
 * ── Why it can stop, and why that is not a timeout ──────────────────────
 *
 * There is no deadline of this route's own. It ends when the service says the
 * lease is `active` (granted), or when the service stops recognising the key
 * — which is what a lost place looks like from here, because the sweep
 * expires it and `key.valid`/`claim.live` then refuses. Both endings come
 * from the service; this loop invents neither.
 */
async function waitForGrant(
  service: BrokerService,
  granted: Extract<OperationOutcome, { outcome: 'accepted' }>,
  context: OperationContext,
): Promise<OperationOutcome> {
  const first = granted.value as Record<string, unknown>;

  // Already granted: nothing to wait for, and saying so matters more than it
  // looks. A caller that passes `--wait` on a service with spare capacity
  // gets its tab immediately, and a loop that polled once anyway would spend
  // a lease's worth of time proving what the first response already said.
  if (first['outcome'] !== 'queued') {
    return granted;
  }

  const key = first['key'];
  if (typeof key !== 'string') {
    // Nothing to poll with. Handing back the queued response is the honest
    // outcome — the caller still has a place, it simply cannot be waited on
    // from here.
    return granted;
  }

  const sleep = context.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // Said out loud, on the error stream so `--json` still produces exactly one
  // document (§5.6). A command that silently blocks for nine minutes is
  // indistinguishable from one that has hung.
  const announce = (line: string): void => {
    context.streams.err(line);
  };

  let interval = checkBackFrom(first);
  announce(
    `queued at position ${describe(first['position'])}; waiting. ` +
      `Checking in every ${String(interval)}s — just under the ${describe(first['queueSeconds'])}s this place lives, because a check made exactly at the deadline races the reclamation. ` +
      `Each check also holds the place; stopping loses it.`,
  );

  for (;;) {
    await sleep(interval * 1000);

    const polled = await cliAdapter.invoke(service, 'status', ['--key', key]);

    if (polled.outcome !== 'accepted') {
      // The place is gone, or the key stopped being valid. The service's own
      // refusal is the answer — returned rather than reworded, so the caller
      // sees the rule that ended the wait.
      return polled;
    }

    const value = polled.value as Record<string, unknown>;
    if (value['state'] === 'active') {
      announce('granted.');
      // **The claim's key with the status call's facts**, assembled field by
      // field rather than by spreading the queued response.
      //
      // The key has to come from the claim: it is returned exactly once
      // (§2.2), the grant is what carried it, and handing back the poll alone
      // would strip the caller of the only thing that addresses the lease.
      //
      // Everything else has to come from the poll, and spreading the queued
      // response would have been the bug: `position`, `queueSeconds` and the
      // `checkBack` sentence telling the caller how to hold a *place* are all
      // true of a state this lease has left. A granted response carrying
      // queue advice reads as though the wait had not finished.
      return {
        outcome: 'accepted',
        value: {
          outcome: 'granted',
          claimId: value['claimId'] ?? first['claimId'],
          key,
          browserId: value['browserId'] ?? first['browserId'],
          ...(typeof value['tabId'] === 'string' ? { tabId: value['tabId'] } : {}),
          ...(typeof value['expiresAt'] === 'string' ? { expiresAt: value['expiresAt'] } : {}),
          ...(typeof value['ttlSeconds'] === 'number' ? { leaseSeconds: value['ttlSeconds'] } : {}),
        },
      };
    }

    // Still queued. The interval is re-read every poll rather than captured
    // once, so a lease whose lifetime is reconfigured mid-wait is followed
    // rather than outlived.
    interval = checkBackFrom(value);
    announce(
      `still queued at position ${describe(value['position'])}; next check in ${String(interval)}s.`,
    );
  }
}

/**
 * A field of an arbitrary response, rendered for a person.
 *
 * The values come off a `Record<string, unknown>`, so the compiler is right
 * that an object could arrive — and `String({})` produces
 * `[object Object]`, which is worse than saying nothing. Numbers and strings
 * are what these fields actually are; anything else is reported as unknown
 * rather than stringified into noise.
 */
function describe(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '?';
}

/**
 * The poll interval a response asks for, in seconds.
 *
 * Nine parts in ten of the lifetime, which is the rule `checkBackSeconds()`
 * applies in the claim operation. Taken from the response where it is
 * offered; derived by the same rule where it is not; and never less than one
 * second, because a zero interval would be a busy loop rather than a wait.
 */
function checkBackFrom(value: Record<string, unknown>): number {
  const offered = value['checkBackSeconds'];
  if (typeof offered === 'number' && offered > 0) {
    return offered;
  }
  const lifetime = value['queueSeconds'] ?? value['ttlSeconds'];
  if (typeof lifetime === 'number' && lifetime > 0) {
    return Math.max(1, Math.floor(lifetime * 0.9));
  }
  return 1;
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
  const waiting = operation === 'claim' && wantsWait(rest);

  // **The flag is removed before the vector reaches the adapter.**
  // `parseArguments` normalises every `--name` it sees into the arguments
  // record, so leaving it in would send `wait: true` to the service as an
  // argument of `claim` — and §3.2 has no such field. §5.3 is explicit that
  // this is a behaviour of *this route*: "the one place this route does
  // something the tool surface does not". A route that smuggled an extra
  // argument into the operation would be inventing a rule the tool surface
  // cannot see, which is exactly what the service seam exists to prevent.
  const forwarded = waiting ? rest.filter((word) => word !== '--wait') : rest;

  let outcome = await cliAdapter.invoke(service, operation, [...forwarded]);

  // Runs only after the claim has been made and only when it came back
  // queued — so the flag changes nothing about the request, which is what
  // lets §5.3's "it calls the same operation on every poll and adds none of
  // its own" stay true.
  if (waiting && outcome.outcome === 'accepted') {
    outcome = await waitForGrant(service, outcome, context);
  }

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
 *
 * ── What it must not say, and why the wording is careful ────────────────
 *
 * It cannot name a cause, because `pageDriven: false` has several. A browser
 * is reached whenever one can be, so the field means one could not be
 * **started or reached for this call** — which covers a machine with none
 * installed, a launch that failed, a race this caller lost, and a browser that
 * died partway through. Naming any one of those would send a person to
 * investigate the wrong thing on three occasions out of four.
 *
 * So it reports the consequence, which is the same in every case and is the
 * part that matters: the decision is real and the page did not move.
 */
const NO_BROWSER_NOTE =
  'note: no browser was reached for this call, so the page was not driven. ' +
  'The lease, its tab and this decision are real and recorded; nothing was ' +
  'navigated, read or captured. A browser that is not installed, one that ' +
  'failed to start, and one that stopped answering all read this way.';

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
 * It opens the store **only if one is already there, and never steps it**, by
 * the one export that permits that — `openStoreForDiagnosis`. Both halves are
 * load-bearing and the first was learned the hard way: opening creates the
 * directory and the file, so a doctor that opened unconditionally would
 * *create* an empty store at version zero and then truthfully report it as
 * being at the wrong version — a failure the command had itself caused, on an
 * installation that was fine a moment earlier. Reporting a fault you just
 * produced is worse than reporting nothing. There is no open-but-do-not-create
 * mode to ask for, so the only way not to create one is not to open one.
 *
 * **And it must not settle the budget agreement either**, which is the second
 * reason it cannot use the spawn path: a store whose recorded budget disagrees
 * with this environment is precisely one of the states `doctor` exists to
 * report, and `prepareStore` refuses to return from it. Diagnosing that
 * disagreement through a path that throws on it would hand the operator a
 * refusal where the report naming both numbers is the whole point of asking.
 *
 * The other commands take the spawn path, because `SCHEMA.md` §1.2d puts
 * stepping on every spawn and §1.10 puts the budget agreement there too.
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
  let opened: { store: StoreHandle; owned: boolean } | undefined;

  try {
    const environment =
      context.options.environment ?? readEnvironment({ env: context.options.env });
    // The store the spawn already prepared, which is where the tab budget was
    // recorded. `broker init` is the command whose whole purpose is to make an
    // installation ready, so opening a second store here would be the last
    // place to acquire a second startup path.
    opened = await storeForRun(context.options, environment);
    const store = opened.store;

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
    // Closed only if this run opened it. A store the runtime owns outlives
    // this command, and closing it would pull the file out from under the rest
    // of the spawn.
    if (opened?.owned === true) {
      opened.store.close();
    }
  }
}

/**
 * `broker login` — hand the signed-in browser to a person (§5.5.1).
 *
 * ── Why this needs the typed service and says so when it lacks one ──────
 *
 * Every other command here either takes the flat ten-operation seam or takes
 * no service at all. This one takes neither: signing in is a service
 * operation (the live-lease refusal is a fact about leases, derived inside
 * the arbitration transaction) but it is **not** one of the ten, because a
 * person at a keyboard is not a caller and takes no tab budget.
 *
 * So when the typed service is absent it refuses, in the same shape
 * `serviceUnavailable` refuses, rather than opening a browser anyway. A
 * command that handed somebody a window without having claimed the browser
 * would be handing them one a caller might be using — which is the single
 * thing §5.5.1's first step exists to prevent.
 */
async function runLogin(
  rest: readonly string[],
  context: { streams: Streams; json: boolean; options: RunOptions },
): Promise<number> {
  const { streams, json, options } = context;
  const { broker, store, environment } = options;

  if (broker === undefined || store === undefined || environment === undefined) {
    streams.err(
      'refused (service.not_built): signing in claims the browser through the service, and no service was supplied to this run. Without it the command could hand somebody a window that a caller is already using.',
    );
    return EXIT.unexpected;
  }

  // The browser is a positional word rather than a flag, per §5.5's own
  // spelling of the command: `broker login <browser>`.
  const named = rest.find((word) => !word.startsWith('-'));

  try {
    return await runLoginCommand({
      broker,
      store,
      environment,
      streams,
      json,
      ...(named === undefined ? {} : { browser: named }),
    });
  } catch (error) {
    if (error instanceof BrokerError) {
      // The launch refusals get the extra sentence about what to do, which a
      // message about endpoints cannot supply on its own.
      streams.err(`refused (${error.rule}): ${explainLoginFailure(error)}`);
      return EXIT.refused;
    }
    throw error;
  }
}

async function runOperationsCommand(
  command: 'snapshot' | 'doctor' | 'events' | 'diffs' | 'captures' | 'image',
  rest: readonly string[],
  context: { streams: Streams; json: boolean; options: RunOptions },
): Promise<number> {
  const { streams, json } = context;
  let opened: { store: StoreHandle; owned: boolean } | undefined;

  try {
    const environment =
      context.options.environment ?? readEnvironment({ env: context.options.env });

    if (command === 'doctor') {
      let opened: StoreHandle | undefined;
      if (fs.existsSync(environment.databasePath)) {
        try {
          opened = openStoreForDiagnosis(environment);
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

    // The store the spawn prepared, rather than a second one of this
    // command's own — see `storeForRun`.
    opened = await storeForRun(context.options, environment);
    const store = opened.store;

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
    if (command === 'captures') {
      // The capture telemetry rollups (#37). Same stepped store, same absence
      // of a lease, and for the same reason: adding up what was recorded
      // decides nothing.
      return runCaptures(rest, { db: store.db, streams });
    }
    if (command === 'image') {
      // **Serving the bytes of one recorded image** (§1.9). Unlike `diffs` it
      // does take a lease key, because an artifact belongs to the lease that
      // took it — but it still decides nothing and drives no browser, which is
      // why it is a read beside the others rather than an operation.
      //
      // The artifact store is built here, from the same environment the
      // service builds its own from, because turning a stored path into a
      // location is the one thing this command cannot do for itself: the
      // resolver that refuses a path escaping the root lives on that store,
      // and a second one built anywhere else is the copy that would miss a
      // case.
      return await runImage(rest, {
        db: store.db,
        artifacts: new ArtifactStore(environment.artifactsRoot),
        streams,
      });
    }
    return runEventsCommand(rest, { db: store.db, streams, json });
  } catch (error) {
    if (error instanceof BrokerError) {
      streams.err(`refused (${error.rule}): ${error.message}`);
      return EXIT.refused;
    }
    throw error;
  } finally {
    // Closed only if this run opened it — see `storeForRun`.
    if (opened?.owned === true) {
      opened.store.close();
    }
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

  let opened: { store: StoreHandle; owned: boolean } | undefined;
  try {
    const environment =
      context.options.environment ?? readEnvironment({ env: context.options.env });
    opened = await storeForRun(context.options, environment);
    const store = opened.store;

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
    // Closed only if this run opened it — see `storeForRun`.
    if (opened?.owned === true) {
      opened.store.close();
    }
  }
}
