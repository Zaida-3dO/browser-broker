#!/usr/bin/env node
import { serviceUnavailable } from '../cli/index.ts';
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
 * The service layer is row #10 onward and is not built. Rather than pretend,
 * this shim serves {@link serviceUnavailable}, which refuses every operation
 * by name — so a caller that spawns this gets an honest refusal with a rule
 * attached, and the whole wire path is real. When the service lands,
 * this line is the substitution and nothing else here changes.
 *
 * **Human text never goes to standard output**, because standard output is
 * the protocol stream and one stray line would corrupt the framing for every
 * message after it.
 */
await serveSession(linesFrom(process.stdin), {
  service: serviceUnavailable(),
  streams: {
    write: (line) => process.stdout.write(`${line}\n`),
    log: (line) => process.stderr.write(`${line}\n`),
  },
});
