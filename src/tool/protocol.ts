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
 * subset this service uses — listing the tools and calling one — and nothing
 * else. A caller sending a method outside that set gets an explicit
 * `method_not_found` rather than silence, which is the part that makes the
 * subset honest instead of merely small.
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

/** What correlates a response with the request that caused it. */
export type MessageId = number | string;

/** A request from the caller. */
export interface ProtocolRequest {
  readonly id: MessageId;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** A response the surface writes back. */
export interface ProtocolResponse {
  readonly id: MessageId;
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

/** The methods this surface answers. Anything else is `method_not_found`. */
export const METHODS = {
  /** Enumerate the tools, with their descriptions and argument schemas. */
  listTools: 'tools/list',
  /** Call one tool by name. */
  callTool: 'tools/call',
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
  return JSON.stringify(message);
}

/** What a line turned out to be. */
export type DecodedMessage =
  | { readonly kind: 'request'; readonly request: ProtocolRequest }
  | { readonly kind: 'malformed'; readonly id: MessageId | undefined; readonly why: string };

/**
 * Read one line as a request.
 *
 * **A malformed line is reported, never skipped.** A surface that ignored
 * what it could not parse would leave a caller waiting forever for a response
 * to a message the surface decided not to mention — and from the caller's
 * side that is indistinguishable from a hang. So this returns a description
 * of the problem, and the loop above answers with it where there is an
 * identifier to answer to.
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
  const rawId: unknown = record['id'];
  const id = typeof rawId === 'number' || typeof rawId === 'string' ? rawId : undefined;

  if (id === undefined) {
    return {
      kind: 'malformed',
      id: undefined,
      why: 'a message carries an id, which is a number or a string',
    };
  }

  const method: unknown = record['method'];
  if (typeof method !== 'string') {
    return { kind: 'malformed', id, why: 'a message carries a method, which is a string' };
  }

  const params: unknown = record['params'];
  if (params !== undefined && (params === null || typeof params !== 'object')) {
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
