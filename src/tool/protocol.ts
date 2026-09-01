/**
 * The wire format the tool surface speaks, implemented directly.
 *
 * ── Why this is written out rather than taken from a package ────────────
 *
 * `MILESTONES.md`'s binding for this row: no runtime dependency is added for
 * it, because the protocol is a documented wire format and a framework would
 * be a design regression rather than a convenience. The whole of what a
 * caller needs is here: newline-delimited JSON objects on standard input and
 * standard output, an integer or string identifier correlating a response
 * with its request, and a small fixed set of method names.
 *
 * The cost of that choice is stated rather than implied: this implements the
 * subset this service uses — the handshake, listing the tools and calling one
 * — and nothing else. A caller sending a method outside that set gets an
 * explicit `method_not_found` rather than silence, which is the part that
 * makes the subset honest instead of merely small.
 *
 * ── The envelope is JSON-RPC 2.0, because a client will not speak anything ─
 *
 * The subset above was, for a time, *only* those last two methods, framed as
 * bare JSON objects. That was reachable by a program written against this
 * file and by nothing else: a Model Context Protocol client opens with
 * `initialize`, waits for the server's `protocolVersion`, `capabilities` and
 * `serverInfo`, sends `notifications/initialized`, and only then asks what
 * tools exist. Against a surface with no `initialize` the very first message
 * is answered `method_not_found` and the client hangs up — so ten working,
 * conformance-proven tools sat behind a doorway that did not open.
 *
 * So the envelope here is the real one: `jsonrpc: "2.0"` on every message,
 * the identifier echoed, `result` exclusive-or `error`, and errors carrying
 * JSON-RPC's *numeric* codes. Implemented against Model Context Protocol
 * revision {@link PROTOCOL_VERSION}
 * (https://modelcontextprotocol.io/specification/2025-06-18).
 *
 * ── Two code spaces, deliberately, and both of them travel ──────────────
 *
 * JSON-RPC requires a small fixed set of integers. This surface already had a
 * vocabulary of its own — `method_not_found`, `tool_not_found`,
 * `malformed_call`, `unexpected_failure` — and those distinctions are
 * load-bearing rather than decorative: `SCHEMA.md` and two build checks read
 * them by name, and the paragraph on {@link ProtocolError} explains why a
 * caller must be able to tell a typo from a capacity refusal.
 *
 * Collapsing the vocabulary into five integers would have thrown that away to
 * satisfy a transport. So **both travel**: {@link ProtocolError.code} keeps
 * the name, and {@link toJsonRpcCode} maps it onto the integer the transport
 * requires. A generic client reads the integer and behaves correctly; a
 * caller who knows this service reads the name and keeps every distinction it
 * had before. The mapping is the only thing that is new, and it is one
 * function rather than a rewrite.
 *
 * ── Framing: one JSON object per line ───────────────────────────────────
 *
 * A line is a message. That is the whole framing rule, and it is chosen over
 * a length-prefixed header for a reason worth keeping: a line-delimited
 * stream is readable by a person watching it, debuggable with ordinary text
 * tools, and has exactly one failure mode — a message containing a raw
 * newline. {@link encodeMessage} is where that is prevented, by serialising
 * without pretty-printing, and {@link decodeMessage} refuses a line it cannot
 * parse rather than skipping it silently.
 */

/** The JSON-RPC version string every message on this surface carries. */
export const JSONRPC_VERSION = '2.0';

/**
 * The Model Context Protocol revision this surface implements.
 *
 * Named as a constant because it is answered to a client during negotiation
 * and asserted by a test; a version that lived only in a string literal
 * inside a handler would drift from the one the documentation claims.
 */
export const PROTOCOL_VERSION = '2025-06-18';

/**
 * The revisions this surface will agree to speak.
 *
 * Ordered newest first, which is what makes {@link negotiateProtocolVersion}
 * able to answer "the newest thing we both know" without a second list. A
 * revision is added here only when this surface has actually been made to
 * speak it — the point of the list is that it is a claim, not a wish.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION, '2025-03-26'];

/** What correlates a response with the request that caused it. */
export type MessageId = number | string;

/** A request from the caller. */
export interface ProtocolRequest {
  readonly id: MessageId;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * A notification from the caller: a method with **no identifier**.
 *
 * The absence of the identifier is the entire meaning of the type. JSON-RPC
 * says a notification draws no response, and a strict client that receives
 * one anyway is entitled to treat the stream as broken — so this is kept a
 * distinct type from {@link ProtocolRequest} rather than a request whose
 * identifier happens to be missing, because the thing that must never happen
 * is answering it, and a type that cannot carry an identifier cannot be
 * answered by accident.
 */
export interface ProtocolNotification {
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * A response the surface writes back.
 *
 * `id` accepts `null` on top of {@link MessageId} for one reason only: a
 * request whose id key was present but not a number or a string (`null`,
 * `true`, an object) has no usable identifier to echo back, and JSON-RPC
 * 2.0 answers exactly that case with `id: null` rather than staying silent.
 * Every response that answers a genuine request still carries the caller's
 * own id, unchanged.
 */
export interface ProtocolResponse {
  readonly id: MessageId | null;
  readonly result?: unknown;
  readonly error?: ProtocolError;
}

/**
 * A protocol-level failure — malformed message, unknown method, unknown tool.
 *
 * **This is not how a refusal is reported**, and the distinction is the most
 * important one in this file. A rule refusing an operation is the service
 * working (`SCHEMA.md` §5.6), and it comes back as a *successful* response
 * whose result carries the refusal — the same way the command line exits with
 * its own distinct code rather than with the code for a malformed command. A
 * caller that could not tell those apart would retry a typo and give up on a
 * capacity refusal, which is exactly backwards.
 */
export interface ProtocolError {
  readonly code: string;
  readonly message: string;
}

/**
 * JSON-RPC's own error codes, which are integers and are not negotiable.
 *
 * These are the transport's, not this service's. They exist so a client that
 * has never heard of this service still behaves correctly — retry, report,
 * give up — and the names above are what a caller that *has* heard of it
 * reads instead. See {@link toJsonRpcCode} for why both travel.
 */
export const JSONRPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/**
 * This surface's refusal vocabulary, mapped onto the transport's integers.
 *
 * **The mapping is many-to-one and that is the point.** `tool_not_found` and
 * `method_not_found` are genuinely different facts — one means the caller
 * mistyped a tool, the other that it spoke a method this surface does not
 * implement — and JSON-RPC has one integer for both. Rather than pick a
 * winner, the name survives on {@link ProtocolError.code} and the integer is
 * derived here. Nothing reading the name loses a distinction; nothing reading
 * the integer sees a code it does not recognise.
 *
 * An unrecognised name maps to `internalError`, which is the honest answer:
 * a code this function has not been taught about is, from the transport's
 * point of view, this surface failing to describe itself.
 */
export function toJsonRpcCode(code: string): number {
  switch (code) {
    case 'method_not_found':
    case 'tool_not_found':
      return JSONRPC_ERROR_CODES.methodNotFound;
    case 'malformed_message':
      return JSONRPC_ERROR_CODES.invalidRequest;
    case 'malformed_call':
    case 'unsupported_protocol_version':
      return JSONRPC_ERROR_CODES.invalidParams;
    default:
      return JSONRPC_ERROR_CODES.internalError;
  }
}

/**
 * Agree a revision with the caller.
 *
 * The rule the specification gives is short: answer with the caller's own
 * revision when this surface speaks it, and otherwise answer with the newest
 * one it does speak. **The second branch is not a failure** — a client asking
 * for something newer than this surface knows is told what is on offer and
 * decides for itself whether to continue, which is the difference between a
 * negotiation and a rejection. So this returns a version in every case and
 * never throws: a handshake that crashed on an unfamiliar version string
 * would break on the next revision of the specification rather than on
 * anything wrong with the caller.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return PROTOCOL_VERSION;
}

/** The methods this surface answers. Anything else is `method_not_found`. */
export const METHODS = {
  /** Open the session: negotiate a revision and describe the server. */
  initialize: 'initialize',
  /** Enumerate the tools, with their descriptions and argument schemas. */
  listTools: 'tools/list',
  /** Call one tool by name. */
  callTool: 'tools/call',
} as const;

/**
 * The notifications this surface accepts — and answers with silence.
 *
 * `notifications/initialized` is the client saying the handshake is complete.
 * There is nothing to do with it and nothing to send back; accepting it
 * without replying is the whole of the requirement.
 *
 * `notifications/cancelled` is listed because a client may send it at any
 * time and a surface that treated it as an unknown *method* would try to
 * answer a notification — the one thing a notification must never draw. This
 * surface answers a call when it finishes, so there is no work to interrupt;
 * ignoring it is both correct and complete.
 */
export const NOTIFICATIONS = {
  initialized: 'notifications/initialized',
  cancelled: 'notifications/cancelled',
} as const;

/**
 * Serialise a message to one line.
 *
 * `JSON.stringify` without an indent argument emits no newline of its own,
 * and every newline inside a string value is escaped as `\n` by the
 * serialiser, so the result is guaranteed to be a single line. That guarantee
 * is the framing, so it is asserted by a test rather than assumed here.
 */
export function encodeMessage(message: ProtocolRequest | ProtocolResponse): string {
  return JSON.stringify(withEnvelope(message));
}

/**
 * Put the JSON-RPC envelope on a message on its way out.
 *
 * Two properties are enforced here rather than trusted to every call site,
 * because both are the kind of thing that is right nine times and wrong once:
 *
 * **`jsonrpc: "2.0"` leads.** Key order is not semantically meaningful, but
 * this stream is read by people as well as programs — that is the stated
 * reason the framing is lines rather than length prefixes — and a message
 * whose first field names the protocol is one a reader can identify at a
 * glance.
 *
 * **`result` and `error` are exclusive.** JSON-RPC requires exactly one, and
 * a response carrying both is the ambiguity a client cannot resolve. So an
 * error wins and `result` is dropped, rather than both being written and the
 * contradiction shipped; and an error is rewritten to carry the transport's
 * integer in `code` with this surface's own name preserved beside it, which
 * is the whole of the two-code-spaces bargain in {@link toJsonRpcCode}.
 */
function withEnvelope(
  message: ProtocolRequest | ProtocolResponse,
): Readonly<Record<string, unknown>> {
  if ('method' in message) {
    return { jsonrpc: JSONRPC_VERSION, ...message };
  }

  if (message.error !== undefined) {
    return {
      jsonrpc: JSONRPC_VERSION,
      id: message.id,
      error: {
        code: toJsonRpcCode(message.error.code),
        message: message.error.message,
        // The name is kept, in the place JSON-RPC reserves for exactly this.
        // A caller reading `error.code` gets the integer it expects; one that
        // knows this service reads the name and keeps the distinction the
        // integer cannot carry.
        data: { code: message.error.code },
      },
    };
  }

  return { jsonrpc: JSONRPC_VERSION, id: message.id, result: message.result };
}

/**
 * What a line turned out to be.
 *
 * A `malformed` id is `MessageId | null | undefined`: `undefined` means the
 * id key was absent from the message and there is nobody to answer;
 * `null` means the key was present but carried something other than a
 * number or a string, and JSON-RPC 2.0 answers that case with `id: null`
 * rather than silence. See the id-key note in {@link decodeMessage}.
 */
export type DecodedMessage =
  | { readonly kind: 'request'; readonly request: ProtocolRequest }
  | { readonly kind: 'notification'; readonly notification: ProtocolNotification }
  | { readonly kind: 'malformed'; readonly id: MessageId | null | undefined; readonly why: string };

/**
 * Read one line as a request.
 *
 * **A malformed line is reported, never skipped.** A surface that ignored
 * what it could not parse would leave a caller waiting forever for a response
 * to a message the surface decided not to mention — and from the caller's
 * side that is indistinguishable from a hang. So this returns a description
 * of the problem, and the loop above answers with it where there is an
 * identifier to answer to.
 *
 * ── Why the id KEY's presence is checked separately from its value ───────
 *
 * `record['id']` on an object with no `id` property and `record['id']` on
 * one with `id: null` are both `undefined` in JavaScript, so a check that
 * reads only the value cannot tell "there is no id to answer to" from "there
 * is an id, and it is unusable". Those are different situations: the first
 * is a notification-shaped line with genuinely nobody to answer; the second
 * is a request-shaped line whose id this surface cannot echo back, but can
 * still answer with `id: null` — JSON-RPC's own way of saying "I received
 * this, and could not identify it". Losing that distinction is what let a
 * caller sending `id: null` or `id: true` — a malformed request, not a
 * notification — be read as a notification and dropped, indistinguishable
 * from a hang.
 */
export function decodeMessage(line: string): DecodedMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'malformed', id: undefined, why: 'the line is not JSON' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'malformed', id: undefined, why: 'a message is a JSON object' };
  }

  const record = parsed as Record<string, unknown>;
  const hasIdKey = 'id' in record;
  const rawId: unknown = record['id'];
  const id = typeof rawId === 'number' || typeof rawId === 'string' ? rawId : undefined;
  const method: unknown = record['method'];
  const params: unknown = record['params'];
  const paramsAreWrong = params !== undefined && (params === null || typeof params !== 'object');

  // **A message with no id KEY at all but a method is a NOTIFICATION, not a
  // malformed message**, and reading it as the latter is how a surface ends
  // up either answering one or refusing the handshake that follows it. The
  // key's absence — not merely an unusable value — is the signal, so it is
  // tested before anything is concluded from it.
  if (!hasIdKey && typeof method === 'string') {
    if (paramsAreWrong) {
      // Nobody to answer — a notification has no identifier by construction —
      // so the loop above logs this rather than replying to it.
      return { kind: 'malformed', id: undefined, why: 'params, when present, is an object' };
    }
    return {
      kind: 'notification',
      notification: {
        method,
        ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
      },
    };
  }

  if (id === undefined) {
    // The id key is present (checked above) but its value is neither a
    // number nor a string — `null`, `true`, an object, an array. There is an
    // id to answer to; this surface simply cannot echo the caller's own
    // value back, so it answers with `id: null` rather than staying silent.
    // Absent the id key entirely, this line would have taken the
    // notification branch above and never reached here.
    return {
      kind: 'malformed',
      id: hasIdKey ? null : undefined,
      why: 'a message carries an id, which is a number or a string',
    };
  }

  if (typeof method !== 'string') {
    return { kind: 'malformed', id, why: 'a message carries a method, which is a string' };
  }

  if (paramsAreWrong) {
    return { kind: 'malformed', id, why: 'params, when present, is an object' };
  }

  return {
    kind: 'request',
    request: {
      id,
      method,
      ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
    },
  };
}
