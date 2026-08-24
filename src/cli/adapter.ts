import type { Adapter, OperationWaiver } from '../adapter/contract.ts';
import type { OperationName } from '../adapter/operations.ts';
import type { BrokerService, OperationOutcome } from '../adapter/service-seam.ts';
import { OPERATION_COMMANDS } from './commands.ts';

/**
 * The command line as an adapter: a thin shell over one service call.
 *
 * `SCHEMA.md` §5.1: "The command line is a full route in, and it is worth
 * building even if no agent ever calls it. It is the cheapest available proof
 * that the rules live in one place rather than inside a tool handler — a rule
 * inside a handler is a rule that holds on one route and nowhere else."
 *
 * ── What this file may and may not do ───────────────────────────────────
 *
 * It resolves an argument vector into arguments, calls **one** operation, and
 * shapes the outcome for a terminal. It reaches no database and no guard: it
 * is handed a {@link BrokerService} rather than finding one, so there is no
 * store handle in scope to be tempted by. Every rule that decides whether an
 * operation is allowed lives behind that seam, or it holds on this route and
 * not the others (`CLAUDE.md`).
 *
 * §5.2 is the consequence worth stating because it surprises people once: in
 * process, **any command that goes through arbitration performs the lazy
 * sweep** — so a listing command can close somebody else's lapsed tabs. That
 * is correct, and it is why no command reads the tables directly.
 */

/** Exit codes, chosen so opposite responses are distinguishable (§5.6). */
export const EXIT = {
  /**
   * Accepted — **including queued**. §5.6 is explicit: "queuing is an
   * outcome, not a failure". A caller that treated a queue place as an error
   * would abandon exactly the wait the queue exists to make orderly.
   */
  accepted: 0,
  /** Something this service did not anticipate. */
  unexpected: 1,
  /** The command itself was malformed. */
  malformed: 2,
  /**
   * Refused by a rule — distinct, "because a refusal is the service
   * working". A caller can retry a refusal intelligently; it cannot retry a
   * typo.
   */
  refused: 3,
  /** Not configured. */
  notConfigured: 4,
} as const;

/**
 * Fields never printed by any command, on any stream, in any mode.
 *
 * §5.6: "**The lease key is never printed by any command**, including in
 * error output and in the machine-readable mode, where the field is absent
 * rather than masked." Absent rather than masked is the specification — a
 * masked field tells a reader a key exists and is being withheld, which is an
 * invitation, and a masked value is one careless format change away from
 * being the real one.
 */
export const NEVER_PRINTED: readonly string[] = ['lease_key', 'leaseKey', 'key'];

/**
 * Strip anything that must never be printed, at every depth.
 *
 * Applied on the way out rather than trusted not to be included, because the
 * shape of an operation's result belongs to the operation and this route
 * cannot know what a later row will put in one. A rule enforced at the exit
 * holds for results that did not exist when it was written.
 */
export function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => withoutSecrets(entry));
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (NEVER_PRINTED.includes(key)) {
        continue;
      }
      output[key] = withoutSecrets(entry);
    }
    return output;
  }
  return value;
}

/**
 * Turn the words after a command into arguments.
 *
 * `--name value` and `--name=value`, plus bare `--flag` for a boolean. No
 * argument-parsing library: the manifest carries exactly one runtime
 * dependency and a command line of this shape does not need a second
 * (`MILESTONES.md`'s binding, and a framework here would be a design
 * regression rather than a convenience).
 *
 * Keys are normalised from the terminal's spelling to the service's:
 * `--session-id` becomes `session_id`, so a caller types what a terminal
 * reads and the service receives what §3 names.
 */
export function parseArguments(rest: readonly string[]): Readonly<Record<string, unknown>> {
  const parsed: Record<string, unknown> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === undefined || !word.startsWith('--')) {
      continue;
    }

    const body = word.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      parsed[normaliseKey(body.slice(0, equals))] = body.slice(equals + 1);
      continue;
    }

    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed[normaliseKey(body)] = true;
      continue;
    }
    parsed[normaliseKey(body)] = next;
    index += 1;
  }

  return parsed;
}

function normaliseKey(key: string): string {
  return key.replaceAll('-', '_');
}

/**
 * The waivers this route carries (§5.5).
 *
 * Every one of these is a **command that exists** with no service operation
 * behind it, which is why it is a written waiver rather than an absence: the
 * command line genuinely offers `snapshot`, `doctor`, `login` and `init`, and
 * none of them is a §3 operation to be at parity about.
 *
 * They do not name §3 operations, so nothing here is exempting this route
 * from an operation it should offer — the waiver rule in the runner refuses
 * that, and this list is deliberately empty of operation names for that
 * reason. It is kept as prose the reviewer can read rather than being
 * discarded, because "quietly absent from the matrix" is the failure
 * `MILESTONES.md` names.
 */
export const CLI_COMMAND_WAIVERS: readonly { readonly command: string; readonly reason: string }[] =
  [
    {
      command: 'snapshot',
      reason:
        'Writes the operations document and exits. It performs no service operation and refuses nothing, so it has nothing to be at parity with.',
    },
    {
      command: 'doctor',
      reason:
        'Reports preconditions and exits with a distinct code. It is a readiness check rather than an operation, and refuses no caller.',
    },
    {
      command: 'login',
      reason:
        'Hands a browser to a person to sign in to. A person drives it, no lease is granted, and the tool surface deliberately has no equivalent.',
    },
    {
      command: 'init',
      reason:
        'Shows the setup handshake report. Every spawn performs the handshake anyway, so the command causes no effect of its own.',
    },
  ];

/**
 * Operations this route does not offer, with the reason each is absent.
 *
 * **Empty, and that is the claim.** §5.3: every §3 operation has a command,
 * so parity is real rather than claimed. The array exists so that a later row
 * removing a command has somewhere to write down why — and so the runner's
 * waiver rule has something to check rather than an absence to interpret.
 */
export const CLI_OPERATION_WAIVERS: readonly OperationWaiver[] = [];

/** Every operation this route offers — all ten, from the command table. */
export const CLI_OPERATIONS: readonly OperationName[] = OPERATION_COMMANDS.map(
  (command) => command.operation,
);

/**
 * The command-line adapter.
 *
 * `readOnly` is false because this route performs writes, and that
 * declaration is what makes the waiver rule bite: a route exposing a write
 * operation may not waive an operation any rule can refuse
 * (`MILESTONES.md`). Declaring it read-only to buy waivers would be the
 * loophole, so the declaration is made honestly and the waiver list is empty.
 */
export const cliAdapter: Adapter = {
  id: 'cli',
  description:
    'The command line. In process, because there is nothing else for a command to talk to.',
  readOnly: false,
  operations: CLI_OPERATIONS,
  waivers: CLI_OPERATION_WAIVERS,
  invoke: async (
    service: BrokerService,
    operation: OperationName,
    input: unknown,
  ): Promise<OperationOutcome> => {
    // The route's own vocabulary is an argument vector. Anything else is a
    // caller reaching past the transport, so it is refused rather than
    // coerced — a shell only ever produces an array of strings.
    if (!Array.isArray(input) || input.some((word) => typeof word !== 'string')) {
      throw new TypeError('the command-line adapter takes an argument vector');
    }
    return service.perform({
      operation,
      adapter: 'cli',
      arguments: parseArguments(input as readonly string[]),
    });
  },
};
