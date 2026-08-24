import type { ConformanceCase, CaseObservation } from '../adapter/conformance/case.ts';
import type { ConformanceDriver, Observation } from '../adapter/conformance/driver.ts';
import type { BrokerService, OperationOutcome } from '../adapter/service-seam.ts';
import { cliAdapter, EXIT } from './adapter.ts';
import { OPERATION_COMMANDS } from './commands.ts';
import { run } from './index.ts';

/**
 * How the conformance suite drives the command line.
 *
 * ── It goes through the real entry point, and that is the whole point ────
 *
 * `MILESTONES.md`: "drive the command line through its entry point with an
 * argument vector". So this calls {@link run} — the same function
 * `src/bin/broker.ts` calls — with an argv it built, and reads the outcome
 * back out of the exit code and the streams.
 *
 * **The alternative is the hollow version, and it is worth naming so nobody
 * reinvents it.** A driver that called `cliAdapter.invoke` directly, or worse
 * called the service itself, would produce a green matrix while testing none
 * of the argument parsing, none of the exit-code mapping and none of the
 * never-printed rule — every part of this route that could hold a rule of its
 * own. That is the "tested a local copy of the logic so the shipped code was
 * never exercised" failure, and it passes.
 *
 * ── Why it reads the machine-readable mode ──────────────────────────────
 *
 * The suite compares codes and rule names, never sentences (`SCHEMA.md`
 * §3.14). The machine-readable mode is where this route puts a code and a
 * rule name as data rather than as prose, so parsing that document is reading
 * the route's own contract instead of matching English out of a message —
 * which would be brittle *and* would be asserting the one thing §3.14 says
 * never to compare across surfaces.
 */

/** Turn a neutral case input into this route's own vocabulary: an argv. */
export function argvFor(testCase: ConformanceCase): string[] {
  const command = OPERATION_COMMANDS.find((entry) => entry.operation === testCase.operation);
  if (command === undefined) {
    throw new Error(`the command line has no command for "${testCase.operation}"`);
  }

  const argv = [...command.words];
  for (const [key, value] of Object.entries(testCase.input)) {
    // The terminal spells keys with hyphens; the service names them with
    // underscores (§3). The adapter normalises on the way in, so the
    // translation is inverted here rather than being a second convention.
    const flag = `--${key.replaceAll('_', '-')}`;
    if (value === true) {
      argv.push(flag);
      continue;
    }
    if (value === false || value === undefined || value === null) {
      continue;
    }
    // A shell carries text. A case whose input is a structure has written
    // something this transport cannot express, and coercing it would put
    // `[object Object]` on the command line and then assert against whatever
    // came back — a comparison that runs, means nothing, and passes. Failing
    // here names the case instead.
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError(
        `case "${testCase.name}" gives ${flag} a value the command line cannot carry`,
      );
    }
    argv.push(flag, String(value));
  }
  argv.push('--json');
  return argv;
}

/**
 * Read the outcome back out of what a command wrote and the code it exited
 * with.
 *
 * Both are checked against each other rather than one being trusted: a
 * document saying `refused` alongside an exit code of zero is a real bug on
 * this route — a caller reading only the code would proceed as though the
 * operation had happened (§5.6) — so the mismatch is raised here instead of
 * being silently resolved in favour of whichever is read first.
 */
export function outcomeFrom(code: number, out: readonly string[]): OperationOutcome {
  const document: unknown = JSON.parse(out.join('\n'));
  if (document === null || typeof document !== 'object') {
    throw new Error('the machine-readable mode did not produce a document');
  }
  const record = document as Record<string, unknown>;

  if (record['outcome'] === 'accepted') {
    if (code !== EXIT.accepted) {
      throw new Error(`accepted document alongside exit code ${String(code)}`);
    }
    return { outcome: 'accepted', value: (record['value'] ?? {}) as Record<string, unknown> };
  }

  if (record['outcome'] === 'refused') {
    if (code !== EXIT.refused) {
      throw new Error(`refused document alongside exit code ${String(code)}`);
    }
    return {
      outcome: 'refused',
      code: String(record['code']),
      rule: String(record['rule']),
      // The sentence went to the error stream in this mode and is never
      // compared (§3.14), so it is not read back here.
      message: '',
      ...(record['details'] === undefined
        ? {}
        : { details: record['details'] as Record<string, unknown> }),
    };
  }

  throw new Error(`the document names no outcome: ${out.join('\n')}`);
}

/** The command line's conformance driver. */
export const cliConformanceDriver: ConformanceDriver = {
  adapter: cliAdapter,
  run: async (
    service: BrokerService,
    testCase: ConformanceCase,
    observe: Observation,
  ): Promise<CaseObservation> => {
    const out: string[] = [];
    const err: string[] = [];

    const code = await run(argvFor(testCase), {
      service,
      streams: { out: (line) => out.push(line), err: (line) => err.push(line) },
    });

    return {
      outcome: outcomeFrom(code, out),
      driverCalls: observe.driverCalls(),
      liveClaimCount: observe.liveClaimCount(),
    };
  },
};
