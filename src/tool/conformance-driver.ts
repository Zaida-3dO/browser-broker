import type { CaseObservation, ConformanceCase } from '../adapter/conformance/case.ts';
import type { ConformanceDriver, Observation } from '../adapter/conformance/driver.ts';
import type { BrokerService, OperationOutcome } from '../adapter/service-seam.ts';
import { toolStdioAdapter } from './adapter.ts';
import { encodeMessage, METHODS, decodeMessage } from './protocol.ts';
import { serveSession } from './session.ts';
import { TOOL_DEFINITIONS } from './tools.ts';

/**
 * How the conformance suite drives the tool surface.
 *
 * ── It goes through the real session loop, and that is the whole point ───
 *
 * The command line's driver builds an argv and calls the real entry point.
 * This one builds a **line on the wire** and runs the real
 * {@link serveSession}, then reads the outcome back out of the line that came
 * off it. So every part of this route that could hold a rule of its own is
 * exercised: the framing, the decode, the method dispatch, the tool lookup,
 * the argument shaping, and the never-returned rule.
 *
 * **The hollow version is worth naming so nobody reinvents it.** A driver
 * that called `toolStdioAdapter.invoke` directly — or worse, called the
 * service — would produce a green matrix while testing none of that, and it
 * would pass. That is the "tested a local copy of the logic so the shipped
 * code was never exercised" failure this repository has caught before.
 *
 * ── One session per case, because that is the deployment ────────────────
 *
 * `MILESTONES.md` #27: the service is spawned by its caller, serves that
 * session and exits with it. A driver that kept one long-lived session across
 * the whole matrix would be measuring an arrangement this design does not
 * have, and it would hide any state accidentally held between calls — the one
 * bug this lifecycle is chosen to make impossible. So each case gets its own
 * session, opened and ended around the single call.
 *
 * The process boundary is deliberately **not** crossed here: the matrix runs
 * in process, and a smaller spawned smoke subset proves the wiring
 * separately.
 */

/** Turn a neutral case input into this route's own vocabulary: a tool call. */
export function toolCallFor(testCase: ConformanceCase): {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
} {
  const tool = TOOL_DEFINITIONS.find((entry) => entry.operation === testCase.operation);
  if (tool === undefined) {
    throw new Error(`the tool surface has no tool for "${testCase.operation}"`);
  }

  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(testCase.input)) {
    if (value === undefined || value === null) {
      continue;
    }
    // This transport carries JSON, so unlike the command line it can express
    // a structure. What it cannot express is a value with no JSON
    // representation, and coercing one would put something meaningless on the
    // wire and then assert against whatever came back — a comparison that
    // runs, means nothing, and passes.
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new TypeError(
        `case "${testCase.name}" gives ${key} a value the tool surface cannot carry`,
      );
    }
    // The case table is authored in the service's own spelling, and the
    // arguments the tool takes are the same names (§3), so this is a copy
    // rather than a translation. Where a route's spelling differs — the
    // command line's hyphens — the translation lives in that route's driver.
    args[key] = value;
  }

  return { name: tool.name, arguments: args };
}

/**
 * Read the outcome back out of the line the session wrote.
 *
 * A refusal arrives as a **successful response carrying a refusal**, never as
 * a protocol error (`session.ts`), so a protocol error here is a real failure
 * of this route rather than something to reinterpret as a refusal. Raising it
 * is what keeps the two apart in the matrix: a route that reported refusals
 * as protocol errors would be a route with its own rules, which is the exact
 * thing #30 asserts against.
 */
export function outcomeFrom(line: string | undefined): OperationOutcome {
  if (line === undefined) {
    throw new Error('the session wrote no response');
  }

  const decoded: unknown = JSON.parse(line);
  if (decoded === null || typeof decoded !== 'object') {
    throw new Error('the session wrote something that is not a message');
  }
  const message = decoded as Record<string, unknown>;

  if (message['error'] !== undefined) {
    const error = message['error'] as { code?: unknown; message?: unknown };
    throw new Error(
      `the tool surface answered with a protocol error (${String(error.code)}): ${String(error.message)}`,
    );
  }

  const result = message['result'];
  if (result === null || typeof result !== 'object') {
    throw new Error('the response carries no result');
  }
  const record = result as Record<string, unknown>;

  if (record['outcome'] === 'accepted') {
    return { outcome: 'accepted', value: (record['value'] ?? {}) as Record<string, unknown> };
  }

  if (record['outcome'] === 'refused') {
    return {
      outcome: 'refused',
      code: String(record['code']),
      rule: String(record['rule']),
      // The sentence is worded for this transport and is never compared
      // across routes (§3.14), so it is carried but not read back for the
      // comparison.
      message: typeof record['message'] === 'string' ? record['message'] : '',
      ...(record['details'] === undefined
        ? {}
        : { details: record['details'] as Record<string, unknown> }),
    };
  }

  throw new Error(`the result names no outcome: ${line}`);
}

/**
 * One line in, as an async iterable, because that is what the loop reads.
 *
 * The loop's input is asynchronous because a real standard input is; a
 * driver supplying one line has nothing to wait for, so this adapts a value
 * to the shape rather than pretending to be asynchronous.
 */
function oneLine(line: string): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]: () => {
      let sent = false;
      return {
        next: () => {
          if (sent) {
            return Promise.resolve({ done: true as const, value: undefined });
          }
          sent = true;
          return Promise.resolve({ done: false as const, value: line });
        },
      };
    },
  };
}

/** The tool surface's conformance driver. */
export const toolStdioConformanceDriver: ConformanceDriver = {
  adapter: toolStdioAdapter,
  run: async (
    service: BrokerService,
    testCase: ConformanceCase,
    observe: Observation,
  ): Promise<CaseObservation> => {
    const written: string[] = [];

    // Built through the surface's own encoder rather than by hand, because
    // the framing is the thing under test as much as the dispatch is.
    const request = encodeMessage({
      id: 1,
      method: METHODS.callTool,
      params: toolCallFor(testCase),
    });

    // Confirm the line this driver built is one the surface's own decoder
    // accepts. Without this a malformed request would be answered with a
    // protocol error, `outcomeFrom` would raise, and the case would fail with
    // a message about the surface rather than about the driver.
    const decoded = decodeMessage(request);
    if (decoded.kind !== 'request') {
      // Every line this driver builds carries an identifier and a method, so
      // neither of the other two readings is reachable from here. The reason
      // is named anyway rather than reported as a bare kind, because the
      // whole point of the check is that a driver defect should say so.
      const why = decoded.kind === 'malformed' ? decoded.why : 'it decoded as a notification';
      throw new Error(`the driver built a line the surface rejects: ${why}`);
    }

    await serveSession(oneLine(request), {
      service,
      streams: { write: (line) => written.push(line) },
    });

    return {
      outcome: outcomeFrom(written[0]),
      driverCalls: observe.driverCalls(),
      liveClaimCount: observe.liveClaimCount(),
    };
  },
};
