#!/usr/bin/env node
import { serviceUnavailable } from '../cli/index.ts';
import { BrokerError } from '../errors.ts';
import { createRuntime } from '../service/runtime.ts';
import { linesFrom, serveSession } from '../tool/session.ts';

/**
 * The executable shim for the tool surface: **the process a caller spawns.**
 *
 * `MILESTONES.md` #27: the service is spawned by its caller, serves that
 * session, and exits with it. There is no port to bind, no daemon to start
 * and nothing to leave running — this file reads standard input until it
 * ends, and then the process has nothing left to do.
 *
 * ── Why the loop is not in this file ────────────────────────────────────
 *
 * Everything above the streams lives in `session.ts` and is importable, so
 * the parity matrix drives the real handler in process rather than by
 * spawning something per case. `MILESTONES.md` reserves spawning for the case
 * where the process boundary is itself the thing under test — which is what
 * this file's own smoke test does, and it is the only thing that does.
 *
 * ── The service it serves ───────────────────────────────────────────────
 *
 * The real one, built the same way the command line builds its own
 * (`service/runtime.ts`), differing only in the adapter it records — §1.6
 * keeps one row per decision and one column saying which door it came in
 * through, and this door is `tool-stdio`.
 *
 * {@link serviceUnavailable} covers the one case where a service cannot be
 * built at all: opening the store is what can fail, and it fails with a rule
 * attached. Refusing every operation by name is the right answer there — a
 * caller that spawned this gets an honest refusal and the whole wire path
 * stays real — and it is reached only in that case, because a surface that
 * refused everything unconditionally would be unusable rather than degraded.
 *
 * **Human text never goes to standard output**, because standard output is
 * the protocol stream and one stray line would corrupt the framing for every
 * message after it. The startup refusal below therefore goes to the error
 * stream, and the session still serves — a caller mid-conversation gets
 * refusals it can read rather than a process that vanished.
 */

let runtime;
try {
  runtime = await createRuntime({ adapter: 'tool-stdio' });
} catch (error) {
  if (!(error instanceof BrokerError)) {
    throw error;
  }
  process.stderr.write(`refused (${error.rule}): ${error.message}\n`);
}

try {
  await serveSession(linesFrom(process.stdin), {
    service: runtime?.service ?? serviceUnavailable(),
    streams: {
      write: (line) => process.stdout.write(`${line}\n`),
      log: (line) => process.stderr.write(`${line}\n`),
    },
  });
} finally {
  runtime?.close();
}
