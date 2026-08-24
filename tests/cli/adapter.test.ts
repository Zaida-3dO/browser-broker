import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cliAdapter,
  EXIT,
  NEVER_PRINTED,
  parseArguments,
  withoutSecrets,
} from '../../src/cli/adapter.ts';
import { OPERATION_COMMANDS, STANDALONE_COMMANDS, parseCommand } from '../../src/cli/commands.ts';
import { OPERATION_NAMES } from '../../src/adapter/operations.ts';
import type { BrokerService, OperationRequest } from '../../src/adapter/service-seam.ts';
import { run } from '../../src/cli/index.ts';

/**
 * The command-line adapter: row #29.
 *
 * These test the route's own behaviour — parsing, exit codes, output shape,
 * and the fields it must never print. The parity assertions live in the
 * conformance suite; what is here is everything this route decides on its
 * own, which is precisely the surface that could hold a rule of its own if
 * nobody looked.
 */

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

/** Drive the command line in process, through its entry point (§5.2). */
async function drive(
  argv: string[],
  options: { service?: BrokerService; env?: NodeJS.ProcessEnv } = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    ...options,
    streams: { out: (line) => out.push(line), err: (line) => err.push(line) },
  });
  return { code, out, err };
}

/** A service that records what it was asked and answers as told. */
function serviceAnswering(
  answer: (request: OperationRequest) => ReturnType<BrokerService['perform']>,
): { service: BrokerService; requests: OperationRequest[] } {
  const requests: OperationRequest[] = [];
  return {
    requests,
    service: {
      perform: (request) => {
        requests.push(request);
        return answer(request);
      },
    },
  };
}

const accepts: BrokerService = {
  perform: () => Promise.resolve({ outcome: 'accepted', value: { state: 'active' } }),
};

// ── The command table ───────────────────────────────────────────────────

test('every operation has a command — §5.3, ten commands for ten tools', () => {
  // Named rather than counted, and asserted in both directions: a count would
  // stay green if a command were renamed, and one direction alone would stay
  // green if a command were invented.
  assert.deepEqual(
    OPERATION_COMMANDS.map((command) => command.operation).sort(),
    [...OPERATION_NAMES].sort(),
  );
});

test('the two-word command resolves to its verb rather than to an unknown noun', () => {
  // `tab` alone is not a command. A shortest-first match would resolve
  // `tab replace` to an unknown noun and never reach the verb.
  const parsed = parseCommand(['tab', 'replace', '--lease-key', 'k']);
  assert.equal(parsed.kind, 'operation');
  assert.equal(parsed.kind === 'operation' ? parsed.command.operation : undefined, 'tab_replace');
  assert.deepEqual(parsed.kind === 'operation' ? parsed.rest : [], ['--lease-key', 'k']);
});

test('the commands with no operation behind them are the four of §5.5, by name', () => {
  assert.deepEqual(STANDALONE_COMMANDS.map((command) => command.words.join(' ')).sort(), [
    'doctor',
    'init',
    'login',
    'snapshot',
  ]);
});

test('a command this build does not have is refused rather than guessed at', async () => {
  const result = await drive(['teleport']);
  assert.equal(result.code, EXIT.malformed);
  assert.match(result.err.join('\n'), /Unrecognised command/u);
});

// ── Argument parsing ────────────────────────────────────────────────────

test('both flag spellings parse, and a bare flag is a boolean', () => {
  assert.deepEqual(parseArguments(['--session-id', 'session-a', '--full-page']), {
    session_id: 'session-a',
    full_page: true,
  });
  assert.deepEqual(parseArguments(['--session-id=session-a']), { session_id: 'session-a' });
});

test('a flag followed by another flag is a boolean, not a value', () => {
  // The boundary that decides whether `--wait --json` means "wait for json".
  assert.deepEqual(parseArguments(['--wait', '--json']), { wait: true, json: true });
});

test('the terminal spells keys with hyphens and the service receives underscores', async () => {
  const recorder = serviceAnswering(() =>
    Promise.resolve({ outcome: 'accepted' as const, value: {} }),
  );
  await drive(['claim', '--session-id', 'session-a', '--browser', 'regular'], {
    service: recorder.service,
  });

  assert.equal(recorder.requests.length, 1);
  assert.deepEqual(recorder.requests[0]?.arguments, {
    session_id: 'session-a',
    browser: 'regular',
  });
});

// ── One operation, one service call ─────────────────────────────────────

test('a command makes exactly ONE service call, and names the route it came in on', async () => {
  // An adapter that composed two calls and reported the pair as one operation
  // is how a route grows rules of its own (`CLAUDE.md`, §8).
  const recorder = serviceAnswering(() =>
    Promise.resolve({ outcome: 'accepted' as const, value: {} }),
  );
  await drive(['navigate', '--lease-key', 'k', '--url', 'https://example.com/'], {
    service: recorder.service,
  });

  assert.equal(recorder.requests.length, 1, 'the route did not make exactly one call');
  assert.equal(recorder.requests[0]?.operation, 'navigate');
  assert.equal(recorder.requests[0]?.adapter, 'cli');
});

test('the adapter refuses input that is not an argument vector', async () => {
  // A shell only ever produces an array of strings. Anything else is a caller
  // reaching past the transport, so it is refused rather than coerced.
  await assert.rejects(
    () => cliAdapter.invoke(accepts, 'status', { lease_key: 'k' }),
    /argument vector/u,
  );
});

// ── Exit codes (§5.6) ───────────────────────────────────────────────────

test('an accepted operation exits zero', async () => {
  const result = await drive(['status', '--lease-key', 'k'], { service: accepts });
  assert.equal(result.code, EXIT.accepted);
});

test('QUEUED is accepted, not a failure — the distinction §5.6 makes explicitly', async () => {
  // "Exit codes are chosen so situations wanting opposite responses are
  // distinguishable without parsing anything: accepted (**including
  // queued**)". A caller that treated a queue place as an error would abandon
  // exactly the wait the queue exists to make orderly.
  const queued: BrokerService = {
    perform: () =>
      Promise.resolve({ outcome: 'accepted', value: { state: 'queued', position: 3 } }),
  };
  const result = await drive(['claim', '--browser', 'regular'], { service: queued });

  assert.equal(result.code, EXIT.accepted);
  assert.match(result.out.join('\n'), /queued/u);
});

test('a refusal exits with its OWN code, distinct from a malformed command', async () => {
  // The distinction is the point: "a refusal is the service working". A
  // caller can retry a refusal intelligently; it cannot retry a typo.
  const refuses: BrokerService = {
    perform: () =>
      Promise.resolve({
        outcome: 'refused',
        code: 'unknown_browser',
        rule: 'claim.browser_known',
        message: 'There are two browsers.',
      }),
  };

  const refused = await drive(['claim', '--browser', 'third'], { service: refuses });
  const malformed = await drive(['teleport']);

  assert.equal(refused.code, EXIT.refused);
  assert.equal(malformed.code, EXIT.malformed);
  assert.notEqual(refused.code, malformed.code, 'a refusal is indistinguishable from a typo');
  assert.notEqual(refused.code, EXIT.accepted);
});

test('a refusal names the rule on the error stream', async () => {
  const refuses: BrokerService = {
    perform: () =>
      Promise.resolve({
        outcome: 'refused',
        code: 'invalid_address',
        rule: 'navigate.scheme_allowed',
        message: 'A local-file address is refused.',
      }),
  };
  const result = await drive(['navigate', '--lease-key', 'k', '--url', 'file:///etc/passwd'], {
    service: refuses,
  });

  assert.match(result.err.join('\n'), /navigate\.scheme_allowed/u);
});

// ── Output (§5.6) ───────────────────────────────────────────────────────

test('the machine-readable mode puts ALL human text on the error stream', async () => {
  // "a caller that did not ask for prose gets none" — so the document on the
  // output stream must parse, with nothing else beside it.
  const refuses: BrokerService = {
    perform: () =>
      Promise.resolve({
        outcome: 'refused',
        code: 'key_missing',
        rule: 'key.present',
        message: 'This operation needs the lease key.',
      }),
  };
  const result = await drive(['status', '--json'], { service: refuses });

  const document: unknown = JSON.parse(result.out.join('\n'));
  assert.deepEqual(document, { outcome: 'refused', code: 'key_missing', rule: 'key.present' });
  assert.match(result.err.join('\n'), /needs the lease key/u);
  assert.equal(
    result.out.join('\n').includes('needs the lease key'),
    false,
    'prose leaked into the machine-readable document',
  );
});

test('the machine-readable mode produces ONE document per call', async () => {
  const result = await drive(['status', '--lease-key', 'k', '--json'], { service: accepts });
  const lines = result.out.filter((line) => line.trim() !== '');
  assert.equal(lines.length, 1, 'a call produced more than one document');
});

// ── The lease key is never printed (§5.6) ───────────────────────────────

test('the lease key is NEVER printed — absent rather than masked', async () => {
  // §5.6: "The lease key is never printed by any command, including in error
  // output and in the machine-readable mode, where the field is absent rather
  // than masked."
  const leaks: BrokerService = {
    perform: () =>
      Promise.resolve({
        outcome: 'accepted',
        value: { state: 'active', lease_key: 'the-secret-key', browser: 'regular' },
      }),
  };

  const json = await drive(['claim', '--browser', 'regular', '--json'], { service: leaks });
  const human = await drive(['claim', '--browser', 'regular'], { service: leaks });

  for (const stream of [json.out, json.err, human.out, human.err]) {
    assert.equal(
      stream.join('\n').includes('the-secret-key'),
      false,
      'the lease key reached a stream',
    );
  }

  // Absent, not masked: no placeholder either.
  const document = JSON.parse(json.out.join('\n')) as { value: Record<string, unknown> };
  assert.equal('lease_key' in document.value, false, 'the field was masked rather than removed');
  assert.equal(document.value['state'], 'active', 'the rest of the result was lost');
});

test('the lease key is stripped at every depth, and from refusal details too', () => {
  const stripped = withoutSecrets({
    outer: { leaseKey: 'a', list: [{ key: 'b' }, { safe: 'c' }] },
    safe: 'd',
  }) as Record<string, Record<string, unknown>>;

  assert.equal(JSON.stringify(stripped).includes('"a"'), false);
  assert.equal(JSON.stringify(stripped).includes('"b"'), false);
  assert.equal(stripped['safe'], 'd');
  assert.deepEqual((stripped['outer']?.['list'] as unknown[])[1], { safe: 'c' });
});

test('every spelling of the key is on the never-printed list, by name', () => {
  // Named entries rather than a count, for the reason `MILESTONES.md` gives
  // about a hollow test that iterated a list instead of naming it.
  assert.deepEqual([...NEVER_PRINTED].sort(), ['key', 'leaseKey', 'lease_key']);
});

// ── The unbuilt commands say so honestly ────────────────────────────────

test('a command with no operation behind it says it is not built rather than pretending', async () => {
  // `login` rather than `doctor`: SCHEMA.md 5.5 lists four commands with no
  // operation behind them, and the two that report on an installation are
  // built. The example has to be one that genuinely is not, or this
  // asserts nothing.
  const result = await drive(['login']);
  assert.notEqual(result.code, EXIT.accepted, 'an unbuilt command reported success');
  assert.match(result.err.join('\n'), /not built yet/u);
});

test('an operation command with no service says so rather than reporting success', async () => {
  // The failure this guards against is the one `DECISIONS.md` §5 is about, in
  // the other direction: a route reporting an operation that did not happen.
  const result = await drive(['claim', '--browser', 'regular']);
  assert.equal(result.code, EXIT.refused);
  assert.match(result.err.join('\n'), /service\.not_built/u);
});

// ── Usage ───────────────────────────────────────────────────────────────

test('usage lists every command, so the table and the help cannot drift', async () => {
  const result = await drive(['--help']);
  const text = result.out.join('\n');
  for (const command of [...OPERATION_COMMANDS, ...STANDALONE_COMMANDS]) {
    assert.match(text, new RegExp(`broker ${command.words.join(' ')}`, 'u'));
  }
});
