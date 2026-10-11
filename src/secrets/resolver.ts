import { spawn } from 'node:child_process';

import { BrokerError } from '../errors.ts';

/**
 * Turning a secret's name into its value, by asking a command the operator
 * configured.
 *
 * ── The contract, which is the whole of this file ───────────────────────
 *
 * `BROKER_SECRET_RESOLVER` names a command. To resolve `NAME`, the service
 * spawns it — **directly, never through a shell** — with two more arguments,
 * `resolve NAME`, and reads **one JSON object** from its standard output:
 *
 * ```json
 * { "value": "…", "origins": ["https://app.example.com"], "fields": ["password"] }
 * ```
 *
 * - `value` — the secret, a non-empty string.
 * - `origins` — every origin the secret may be typed into, as exact
 *   `scheme://host[:port]` strings. At least one; nothing is inferred.
 * - `fields` — optional; which kinds of field it may go into, from
 *   {@link SECRET_FIELD_KINDS}. Absent means `["password"]`.
 *
 * A non-zero exit, a run longer than {@link RESOLVER_TIMEOUT_MS}, output
 * larger than {@link RESOLVER_MAX_OUTPUT_BYTES}, or output that is not that
 * object, is a refusal that names the secret and nothing else. **The
 * command's own output is never repeated** — not its standard error, not a
 * fragment of malformed standard output — because either may contain the
 * value, and a refusal is text that reaches the caller.
 *
 * ── No cache ────────────────────────────────────────────────────────────
 *
 * Every resolution spawns the command. Nothing is held between operations:
 * the service is spawned per caller and exits with it, so a cache would live
 * exactly as long as one session's process anyway, and a value that is not
 * held cannot be read out of a process that is holding it. The cost is one
 * short-lived process per secret per operation on a tab that has received one.
 */

/** The kinds of field a secret may be bound to. */
export type SecretFieldKind = 'password' | 'username' | 'otp';

/** Every field kind, in the order a refusal lists them. */
export const SECRET_FIELD_KINDS: readonly SecretFieldKind[] = ['password', 'username', 'otp'];

/** What a resolver answered for one name. */
export interface ResolvedSecret {
  readonly value: string;
  /** Exact origins, already normalised to `URL.origin` form. */
  readonly origins: readonly string[];
  readonly fields: readonly SecretFieldKind[];
}

/** Resolve one name. Rejects with a {@link BrokerError} that never carries the value. */
export type SecretResolver = (name: string) => Promise<ResolvedSecret>;

/** How long one resolution may take before it is abandoned and refused. */
export const RESOLVER_TIMEOUT_MS = 5_000;

/** The most standard output a resolver may produce. A secret is not large. */
export const RESOLVER_MAX_OUTPUT_BYTES = 64 * 1024;

/** The rule every resolution failure refuses with. */
export const RESOLVE_RULE = 'act.secret_resolved';

/**
 * Split a configured command into an argument vector, without a shell.
 *
 * Whitespace separates arguments; a double-quoted run is one argument, so a
 * program whose path has a space in it can be named. There is no escaping,
 * no variable expansion and no globbing — this is a list of words, not a
 * script. Returns `undefined` for an unterminated quote or an empty command.
 */
export function parseCommandLine(text: string): string[] | undefined {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let quoted = false;
  for (const character of text) {
    if (character === '"') {
      quoted = !quoted;
      inWord = true;
      continue;
    }
    if (!quoted && /\s/u.test(character)) {
      if (inWord) {
        words.push(current);
        current = '';
        inWord = false;
      }
      continue;
    }
    current += character;
    inWord = true;
  }
  if (quoted) return undefined;
  if (inWord) words.push(current);
  return words.length === 0 ? undefined : words;
}

function refuse(name: string, why: string): BrokerError {
  return new BrokerError(
    RESOLVE_RULE,
    `The secret "${name}" could not be resolved: ${why}. Nothing was typed. The resolver's own output is not repeated here, because it may contain the value.`,
  );
}

/**
 * Normalise an origin string, or `undefined` if it is not one.
 *
 * Exact: the string must already *be* an origin (`URL.origin` round-trips
 * it). `https://example.com/login` is refused rather than trimmed, because a
 * resolver that wrote a path meant something an origin cannot express, and
 * guessing which part it meant is how a binding gets wider than intended.
 */
export function normaliseOrigin(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  if (
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    // `URL` reports `/` for both "https://h" and "https://h/", and also for
    // "https://h/?" and "https://h/#"; anything after the authority but a
    // single slash is something other than an origin.
    /^[a-z]+:\/\/[^/]*\/./iu.test(candidate)
  ) {
    return undefined;
  }
  return parsed.origin;
}

/** Read a resolver's standard output into a {@link ResolvedSecret}, or refuse. */
export function parseResolverOutput(name: string, stdout: string): ResolvedSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw refuse(name, 'the resolver did not print a JSON object');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw refuse(name, 'the resolver did not print a JSON object');
  }
  const record = parsed as Record<string, unknown>;

  const value = record['value'];
  if (typeof value !== 'string' || value === '') {
    throw refuse(name, 'the resolver printed no "value" string');
  }

  const rawOrigins = record['origins'];
  if (!Array.isArray(rawOrigins) || rawOrigins.length === 0) {
    throw refuse(name, 'the resolver printed no "origins" list; a secret must say where it may go');
  }
  const origins: string[] = [];
  for (const candidate of rawOrigins) {
    const origin = normaliseOrigin(candidate);
    if (origin === undefined) {
      throw refuse(
        name,
        'an entry in "origins" is not an exact origin (scheme://host[:port], no path)',
      );
    }
    origins.push(origin);
  }

  const rawFields = record['fields'];
  let fields: SecretFieldKind[];
  if (rawFields === undefined) {
    fields = ['password'];
  } else if (Array.isArray(rawFields) && rawFields.length > 0) {
    fields = [];
    for (const kind of rawFields) {
      if (!SECRET_FIELD_KINDS.includes(kind as SecretFieldKind)) {
        throw refuse(name, `"fields" may only name ${SECRET_FIELD_KINDS.join(', ')}`);
      }
      fields.push(kind as SecretFieldKind);
    }
  } else {
    throw refuse(name, '"fields", when present, must be a non-empty list');
  }

  return { value, origins, fields };
}

/**
 * A resolver that spawns the configured command.
 *
 * `timeoutMs` is injectable so a test of the timeout path does not wait five
 * seconds; every shipped caller uses the default.
 */
export function commandSecretResolver(
  argv: readonly string[],
  options: { readonly timeoutMs?: number } = {},
): SecretResolver {
  const [program, ...baseArguments] = argv;
  if (program === undefined) {
    throw new Error('a secret resolver needs a command to run');
  }
  const timeoutMs = options.timeoutMs ?? RESOLVER_TIMEOUT_MS;

  return (name: string) =>
    new Promise<ResolvedSecret>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outcome();
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(program, [...baseArguments, 'resolve', name], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        reject(refuse(name, 'the resolver command could not be started'));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > RESOLVER_MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish(() => {
            reject(refuse(name, 'the resolver printed more output than a secret can be'));
          });
          return;
        }
        chunks.push(chunk);
      });
      // Drained and discarded. Standard error is diagnostic text for the
      // operator's terminal, and it may hold the value; it is never read.
      child.stderr?.resume();

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => {
          reject(refuse(name, `the resolver did not answer within ${String(timeoutMs)} ms`));
        });
      }, timeoutMs);

      child.on('error', () => {
        finish(() => {
          reject(refuse(name, 'the resolver command could not be started'));
        });
      });
      child.on('close', (code) => {
        finish(() => {
          if (code !== 0) {
            reject(refuse(name, `the resolver exited with code ${String(code)}`));
            return;
          }
          try {
            resolve(parseResolverOutput(name, Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(
              error instanceof Error ? error : refuse(name, 'the resolver output was unreadable'),
            );
          }
        });
      });
    });
}
