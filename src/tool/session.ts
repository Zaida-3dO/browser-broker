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
 * One block of a `tools/call` result's content, as the specification shapes
 * it.
 *
 * Only the text block is built here, because it is the only one this service
 * has anything to put in. A capture returns a *path* rather than an image
 * (§3.9), deliberately — a caller pays for the pictures it opens — so
 * answering with an `image` block would undo that decision on this route
 * alone and make a review's worth of screenshots arrive inline.
 */
export interface TextContentBlock {
  readonly type: 'text';
  readonly text: string;
}

/**
 * What a `tools/call` answers with, per Model Context Protocol
 * {@link PROTOCOL_VERSION}.
 *
 * ── `content` is required, and its absence is the defect this type exists
 *    to make unrepresentable ───────────────────────────────────────────────
 *
 * The specification's normative schema lists `content` in `required`, and a
 * conforming client renders that array and nothing else. A bare domain object
 * — `{outcome, value}` on a success, `{outcome, code, rule, message}` on a
 * refusal — is a perfectly good description of what happened that **no client
 * can display**: the call arrives empty even though the operation ran, the
 * lease was granted and the store was written. A caller that cannot see the
 * key it was issued cannot release the lease it is holding, which is the worst
 * property this service can have.
 *
 * So `content` is non-optional *here*, in the type, rather than assembled
 * correctly by each of the two call sites below and by every one added later.
 */
export interface ToolCallResult {
  readonly content: readonly TextContentBlock[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

/**
 * Render a value as the text a client shows, and carry it structured beside.
 *
 * ── Both, not either, and the specification asks for exactly that ───────
 *
 * "For backwards compatibility, a tool that returns structured content SHOULD
 * also return the serialized JSON in a TextContent block." A client too old
 * to know about `structuredContent` still has something to render, and one
 * that does know reads the object without parsing the string back.
 *
 * **The structured half is what keeps the refusal taxonomy machine-readable.**
 * `outcome`, `code` and `rule` are the fields a caller branches on — retry a
 * capacity refusal, do not retry a typo — and flattening them into a sentence
 * would leave every caller matching on English. That taxonomy is the best
 * thing on this surface and it survives this change intact: the same four
 * fields, in the same spellings, one level further in.
 *
 * Indented rather than dense, because the text block is the half a person
 * reads.
 */
function asContent(value: unknown): readonly TextContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/**
 * A refusal, shaped for the wire.
 *
 * ── Why a refusal is `isError: true` and still a *result* ───────────────
 *
 * It stays a JSON-RPC result — that part is unchanged and the reasoning below
 * it is unchanged. What is new is the flag, and the specification is explicit
 * about which way it goes: "Any errors that originate from the tool SHOULD be
 * reported inside the result object, with `isError` set to true, *not* as an
 * MCP protocol-level error response. Otherwise, the LLM would not be able to
 * see that an error occurred and self-correct."
 *
 * Self-correction is precisely what this service's refusals are for. They
 * name a rule and say what to do instead — `act.ref_resolves` tells a caller
 * to read the page again, `claim.browser_known` lists the browsers by name —
 * and a caller that acts on one recovers in a single attempt. Marking them as
 * errors is what puts them in front of the model rather than leaving them to
 * be mistaken for success.
 *
 * **`isError` is not a demotion of the taxonomy.** It is one boolean added
 * beside four fields that all survive; a caller reading `code` and `rule` out
 * of `structuredContent` gets everything it got before.
 *
 * What does *not* become `isError` is a protocol failure — an unknown tool,
 * an unknown method, a malformed call. The specification puts "errors in
 * finding the tool" on the protocol side, and this surface already answered
 * them there with its own name carried alongside the integer. That design is
 * untouched.
 */
function refusalResult(refusal: {
  readonly code: string;
  readonly rule: string;
  readonly message: string;
  readonly details?: unknown;
}): ToolCallResult {
  const structured = {
    outcome: 'refused' as const,
    code: refusal.code,
    rule: refusal.rule,
    message: refusal.message,
    ...(refusal.details === undefined ? {} : { details: withoutSecrets(refusal.details) }),
  };

  return {
    // **The sentence alone, not the serialised object.** A refusal's message
    // is written to be read — it says what was refused and what to do next —
    // and wrapping it in JSON braces would bury the one part of this result a
    // person or a model acts on. The machine-readable half is directly below
    // it, so nothing is lost by rendering this half plainly.
    content: [{ type: 'text', text: `refused (${refusal.rule}): ${refusal.message}` }],
    structuredContent: structured,
    isError: true,
  };
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
    const structured = { outcome: 'accepted' as const, value };
    const result: ToolCallResult = {
      // The whole outcome is serialised, `outcome` and `value` together,
      // rather than the value alone. A client showing only the inner object
      // would leave a caller unable to tell an acceptance from a refusal
      // without reading `isError`, and the two spellings agreeing is what
      // makes the text and the structure the same answer.
      content: asContent(structured),
      structuredContent: structured,
    };
    return { id: request.id, result };
  }

  // **A refusal is a successful response carrying a refusal, not a protocol
  // error.** `SCHEMA.md` §5.6: a refusal is the service working, and the
  // command line gives it its own exit code rather than the malformed-command
  // one for exactly this reason. A caller can retry a capacity refusal
  // intelligently; it cannot retry a typo. Collapsing the two would take that
  // distinction away from every caller on this route and from nobody on the
  // other, which is the drift the parity claim exists to catch.
  //
  // It is marked `isError` so a model sees it and self-corrects — see
  // {@link refusalResult}, which is also where the taxonomy is kept intact.
  return {
    id: request.id,
    result: refusalResult({
      code: outcome.code,
      rule: outcome.rule,
      message: outcome.message,
      ...(outcome.details === undefined ? {} : { details: outcome.details }),
    }),
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
      // A malformed line with no id has nobody to answer, so it is reported
      // on the log stream rather than dropped in silence — a surface that
      // ignored what it could not parse would leave a caller waiting forever
      // for a response it was never going to get.
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
