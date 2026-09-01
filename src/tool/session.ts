import type { BrokerService } from '../adapter/service-seam.ts';
import { toolStdioAdapter } from './adapter.ts';
import {
  decodeMessage,
  encodeMessage,
  METHODS,
  negotiateProtocolVersion,
  NOTIFICATIONS,
  type MessageId,
  type ProtocolRequest,
  type ProtocolResponse,
} from './protocol.ts';
import { TOOLS_BY_NAME, TOOL_DEFINITIONS } from './tools.ts';

/**
 * One session on the tool surface: read a line, answer it, exit when the
 * input ends.
 *
 * ── The lifecycle is the row ────────────────────────────────────────────
 *
 * `MILESTONES.md` #27: **the service is spawned by its caller, serves that
 * session, and exits with it.** There is no port, no daemon and no container,
 * and this file is where that is true rather than merely described. The loop
 * ends when standard input ends — which is what happens when the caller
 * closes the pipe or goes away — and the process it runs in has nothing left
 * to do.
 *
 * The consequence worth stating: **every fact two callers share lives in the
 * store**, because there is no shared process for it to live in
 * (`SCHEMA.md` §1.0a). Nothing in this file holds state between sessions, and
 * anything that appeared to would be a bug rather than a cache.
 *
 * ── Reading is a seam, not `process.stdin` ──────────────────────────────
 *
 * {@link serveSession} takes lines from an async iterable and writes with a
 * callback, so the whole loop is reachable from a test without spawning
 * anything. `MILESTONES.md` reserves spawning for the case where the process
 * boundary is itself the thing under test; the parity matrix runs in process
 * and a smaller spawned smoke subset proves the wiring.
 */

/** Where a session's output goes, injected so a test reads it. */
export interface SessionStreams {
  /** One encoded message, without its newline. */
  readonly write: (line: string) => void;
  /** Human text. Never the protocol stream — a line here would corrupt it. */
  readonly log?: (line: string) => void;
}

export interface SessionOptions {
  readonly service: BrokerService;
  readonly streams: SessionStreams;
}

/**
 * What this surface calls itself during the handshake.
 *
 * The name is the package's, and the version is deliberately **not** read
 * from `package.json` at runtime: that file is `"version": "0.0.0"` and
 * `"private": true`, so reading it would report a version that means
 * "unset" as though it were a release. What a client does with `serverInfo`
 * is identify and log the thing it connected to, and a literal here says the
 * true thing — this is the surface, built from this tree — without implying a
 * published artefact that does not exist. The day the package is versioned
 * for real, this is the one line that has to agree with it.
 */
export const SERVER_INFO = {
  name: 'browser-broker',
  version: '0.0.0',
} as const;

/**
 * What `initialize` returns: the negotiated revision, what this server can
 * do, and what it is.
 *
 * **`capabilities` announces `tools` and nothing else, because there is
 * nothing else.** This surface serves no resources and no prompts, and
 * claiming either would make a client offer its user a menu that answers
 * `method_not_found` when chosen. An empty object is the specification's way
 * of saying "this capability, with no optional extras" — notably not
 * `listChanged`, since the twelve tools are fixed at build time and a surface
 * that promised change notifications would owe notifications it can never
 * have a reason to send.
 */
export function initializeResult(
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    protocolVersion: negotiateProtocolVersion(params['protocolVersion']),
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  };
}

/** What `tools/list` returns: the twelve, with their descriptions and schemas. */
export function listTools(): Readonly<Record<string, unknown>> {
  return {
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          tool.arguments.map((argument) => [
            argument.name,
            { type: argument.type, description: argument.description },
          ]),
        ),
        required: tool.arguments
          .filter((argument) => argument.required)
          .map((argument) => argument.name),
      },
    })),
  };
}

/**
 * Fields never written to the protocol stream, on any message.
 *
 * §5.6 states it for the command line — "the lease key is never printed by
 * any command, including in error output and in the machine-readable mode,
 * where the field is absent rather than masked". **The same rule holds here,
 * and holding it on one route only would be exactly the drift the parity
 * claim exists to prevent.**
 *
 * There is one deliberate exception, and it is the reason this list is not
 * simply reused from the command line: `browser_claim` **has to** return the
 * key it just issued, or the lease it granted is unreachable. So the rule is
 * enforced on the way out of every *other* tool, and the grant is the single
 * named hole.
 */
export const NEVER_RETURNED: readonly string[] = ['lease_key', 'leaseKey', 'key'];

/** Strip anything that must never be returned, at every depth. */
export function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => withoutSecrets(entry));
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (NEVER_RETURNED.includes(key)) {
        continue;
      }
      output[key] = withoutSecrets(entry);
    }
    return output;
  }
  return value;
}

/**
 * Answer one request.
 *
 * Exported so a test can drive a single exchange, and so the conformance
 * driver can go through the real handler rather than around it.
 */
export async function handleRequest(
  request: ProtocolRequest,
  options: SessionOptions,
): Promise<ProtocolResponse> {
  if (request.method === METHODS.initialize) {
    return { id: request.id, result: initializeResult(request.params ?? {}) };
  }

  if (request.method === METHODS.listTools) {
    return { id: request.id, result: listTools() };
  }

  if (request.method !== METHODS.callTool) {
    return {
      id: request.id,
      error: {
        code: 'method_not_found',
        message: `This surface answers ${METHODS.initialize}, ${METHODS.listTools} and ${METHODS.callTool}. It has no "${request.method}".`,
      },
    };
  }

  const params = request.params ?? {};
  const name: unknown = params['name'];
  if (typeof name !== 'string') {
    return {
      id: request.id,
      error: { code: 'malformed_call', message: 'A tool call names the tool it is calling.' },
    };
  }

  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) {
    return {
      id: request.id,
      error: {
        code: 'tool_not_found',
        message: `There is no tool named "${name}". Call ${METHODS.listTools} for the twelve this surface offers.`,
      },
    };
  }

  const outcome = await toolStdioAdapter.invoke(options.service, tool.operation, {
    name,
    arguments: params['arguments'],
  });

  if (outcome.outcome === 'accepted') {
    // A grant has to carry the key it issued or the lease is unreachable;
    // everything else is stripped. The exception is named rather than
    // implicit, so widening it is a visible change.
    const value = tool.operation === 'claim' ? outcome.value : withoutSecrets(outcome.value);
    return { id: request.id, result: { outcome: 'accepted', value } };
  }

  // **A refusal is a successful response carrying a refusal, not a protocol
  // error.** `SCHEMA.md` §5.6: a refusal is the service working, and the
  // command line gives it its own exit code rather than the malformed-command
  // one for exactly this reason. A caller can retry a capacity refusal
  // intelligently; it cannot retry a typo. Collapsing the two would take that
  // distinction away from every caller on this route and from nobody on the
  // other, which is the drift the parity claim exists to catch.
  return {
    id: request.id,
    result: {
      outcome: 'refused',
      code: outcome.code,
      rule: outcome.rule,
      message: outcome.message,
      ...(outcome.details === undefined ? {} : { details: withoutSecrets(outcome.details) }),
    },
  };
}

/**
 * Serve one session: answer every line until the input ends, then return.
 *
 * Returns the number of requests answered, so a caller — or a test — can tell
 * a session that served nothing from one that served something without
 * parsing what it wrote.
 */
export async function serveSession(
  lines: AsyncIterable<string>,
  options: SessionOptions,
): Promise<number> {
  let answered = 0;

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }

    const decoded = decodeMessage(line);

    // **A notification draws no response, and that is the whole handling.**
    // `notifications/initialized` is the client saying the handshake is
    // complete; there is nothing to do with it and — the part that matters —
    // nothing to send back. A strict client that receives a reply to a
    // message it sent without an identifier is entitled to treat the stream
    // as broken, so this branch deliberately writes nothing and does not
    // count toward the answered total, which is what makes "answered
    // nothing" assertable by a test.
    if (decoded.kind === 'notification') {
      const known = (Object.values(NOTIFICATIONS) as readonly string[]).includes(
        decoded.notification.method,
      );
      options.streams.log?.(
        known
          ? `noted ${decoded.notification.method}`
          : // An unknown notification is still a notification. Answering it
            // with `method_not_found` would be a reply to something that must
            // not be replied to, so it is logged and dropped — which is what
            // the specification asks of a receiver that does not recognise
            // one.
            `ignored an unrecognised notification: ${decoded.notification.method}`,
      );
      continue;
    }

    if (decoded.kind === 'malformed') {
      // `decoded.id === undefined` means the id KEY itself was absent — a
      // notification-shaped line this surface could not otherwise read —
      // so there is nobody to answer, and it is reported on the log stream
      // rather than dropped in silence. `decoded.id === null` is different:
      // the key was present but unusable (not a number or a string), which
      // is a request with an id this surface cannot echo back — answered
      // below with `id: null`, JSON-RPC's own way of saying so, rather than
      // silently read as the notification it is not.
      if (decoded.id === undefined) {
        options.streams.log?.(`ignored a message that could not be answered: ${decoded.why}`);
        continue;
      }
      options.streams.write(
        encodeMessage({
          id: decoded.id,
          error: { code: 'malformed_message', message: decoded.why },
        }),
      );
      answered += 1;
      continue;
    }

    const response = await answerOrReportFailure(decoded.request, options);
    options.streams.write(encodeMessage(response));
    answered += 1;
  }

  return answered;
}

/**
 * Answer a request, turning an unexpected throw into a protocol error.
 *
 * **A session that died on one bad call would take the caller's whole session
 * with it**, including a lease it is holding, which the caller then cannot
 * release. So an unexpected failure is answered and the loop continues. This
 * is not swallowing: the caller is told, by identifier, that the call failed.
 */
async function answerOrReportFailure(
  request: ProtocolRequest,
  options: SessionOptions,
): Promise<ProtocolResponse> {
  try {
    return await handleRequest(request, options);
  } catch (error) {
    return {
      id: request.id,
      error: {
        code: 'unexpected_failure',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Split a byte stream into lines, for the real standard input. */
export async function* linesFrom(input: AsyncIterable<string | Buffer>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of input) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  // A final line with no trailing newline is still a message. Dropping it
  // would make the surface's behaviour depend on whether the caller's last
  // write happened to end in a newline, which is not a distinction any caller
  // knows it is making.
  if (buffer.trim() !== '') {
    yield buffer;
  }
}

/** Every message id this module answers to, re-exported for a test. */
export type { MessageId };
