#!/usr/bin/env node
import { run } from '../cli/index.ts';
import { createRuntime } from '../service/runtime.ts';
import { BrokerError } from '../errors.ts';

/**
 * The executable entry point. Argument vector in, exit code out.
 *
 * ── What this file adds, and why it is the only thing it adds ───────────
 *
 * The dispatcher stays importable and stays free of any decision, so the
 * command line can be driven in process (`MILESTONES.md`). What it does not
 * do is build itself a service — `RunOptions.service` is injected precisely
 * so that a conformance driver can hand it one, and a dispatcher that
 * constructed its own could only be tested by spawning.
 *
 * That leaves somebody to build the real one, and this is that somebody: the
 * shipped executable, which is the only caller whose service should be the
 * real one by default.
 *
 * ── The fallback is kept, and narrowed to what it was for ───────────────
 *
 * `serviceUnavailable()` remains the answer when a service genuinely cannot
 * be built, and it is now reached by the path that name describes rather than
 * by every path. Building one means opening a store, and a store can
 * legitimately refuse to open — a location on a network filesystem, a
 * malformed configuration variable, a directory nothing may write to. Those
 * refusals are the service *declining*, and they already have their own
 * sentences naming the rule that refused, so they are reported as themselves
 * rather than flattened into "not built".
 */

const argv = process.argv.slice(2);

/**
 * Commands that must answer without a service, and therefore without a store.
 *
 * `doctor` is the one that matters most and the reason this list is not
 * empty: a store that does not exist yet is the state it is most useful in,
 * and `cli/index.ts` goes to some length not to create one while answering. A
 * binary that built a runtime first would create the store *before* the
 * command ran and hand `doctor` a fault it had itself caused — the exact
 * failure that file's comment describes, reintroduced one layer up.
 *
 * **The bare spawn is here for a subtler reason, and it is the one this list
 * exists to get right.** With no arguments the dispatcher opens the store,
 * steps it and reports what stepping did — that report is the whole of what
 * the command does. Building a runtime first would step the schema, so by the
 * time the command ran there would be nothing left to step, and a spawn
 * against a store that did not exist a moment ago would truthfully say
 * "already at version 5, nothing to do". The command would still be honest;
 * it would simply have been robbed of the thing it reports. Stepping is done
 * once per spawn, by whoever is going to speak about it.
 *
 * `--help` and `--version` are here for the ordinary reason: neither reads
 * anything, and opening a database to print a version string would make the
 * two commands most likely to be run on a broken installation the two most
 * likely to fail on one.
 */
function needsNoService(words: readonly string[]): boolean {
  if (words.includes('--help') || words.includes('-h')) return true;
  if (words.includes('--version') || words.includes('-v')) return true;
  // Only `--json` can accompany a bare spawn; anything else is a command.
  if (words.every((word) => word.startsWith('-'))) return true;
  return words[0] === 'doctor';
}

if (needsNoService(argv)) {
  process.exitCode = await run(argv);
} else {
  let runtime;
  try {
    runtime = await createRuntime({ adapter: 'cli' });
  } catch (error) {
    if (error instanceof BrokerError) {
      // The store declined to open. Reported with the rule that refused it,
      // in the same shape every other refusal takes, rather than as a stack
      // trace or as a claim that the service was never built.
      process.stderr.write(`refused (${error.rule}): ${error.message}\n`);
      process.exitCode = 4;
    } else {
      throw error;
    }
  }

  if (runtime !== undefined) {
    try {
      process.exitCode = await run(argv, {
        service: runtime.service,
        // `broker login` is performed by a person and is not one of the ten
        // operations the flat seam carries, so it reaches the service through
        // the typed interface. Supplied here rather than constructed in the
        // dispatcher for the reason `RunOptions.service` gives: a dispatcher
        // that built its own service could only be tested by spawning.
        broker: runtime.broker,
        store: runtime.store,
        environment: runtime.environment,
        // `broker reconcile` asks a live browser what it has open (§2.6,
        // §4.3). It is the runtime's own provider rather than one built in
        // the dispatcher, so this process decides adoption once — and it is
        // passed here, from the shipped executable, because a command reached
        // only by a test is a command that does not exist.
        session: runtime.session,
      });
    } finally {
      runtime.close();
    }
  }
}
