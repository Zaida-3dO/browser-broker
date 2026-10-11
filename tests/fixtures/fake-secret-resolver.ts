/**
 * A stand-in secret resolver for tests (`SCHEMA.md` §3.8a).
 *
 * Invoked exactly as the service invokes a real one — `<this> [options]
 * resolve NAME` — and answers from a fixed table. Every value is an invented
 * marker string chosen to be searchable: a test proves a value did not reach
 * an output by searching that output for it, so the values must be strings
 * that occur nowhere else.
 *
 * Options, before `resolve`:
 *   --origins <a,b>   the origins every secret is bound to (default: none)
 *
 * Names:
 *   good       a password
 *   user       a username (fields: username)
 *   otp        a one-time code (fields: otp)
 *   special    a password full of characters that need escaping
 *   fail       exits 3, printing the value to standard error
 *   slow       never answers
 *   junk       prints text that is not JSON, containing the value
 *   huge       prints more output than a secret can be
 *   pathy      binds to an origin written with a path
 */

import { FAKE_VALUES } from './fake-secret-values.ts';

const argv = process.argv.slice(2);
let origins: string[] = [];
const at = argv.indexOf('--origins');
if (at !== -1) {
  origins = (argv[at + 1] ?? '').split(',').filter(Boolean);
}
const verb = argv.at(-2);
const name = argv.at(-1);

if (verb !== 'resolve') {
  process.stderr.write('usage: fake-secret-resolver [--origins a,b] resolve NAME\n');
  process.exit(2);
}

const answer = (body: unknown): void => {
  process.stdout.write(JSON.stringify(body));
};

switch (name) {
  case 'good':
    answer({ value: FAKE_VALUES.good, origins });
    break;
  case 'user':
    answer({ value: FAKE_VALUES.user, origins, fields: ['username'] });
    break;
  case 'otp':
    answer({ value: FAKE_VALUES.otp, origins, fields: ['otp'] });
    break;
  case 'special':
    answer({ value: FAKE_VALUES.special, origins });
    break;
  case 'fail':
    process.stderr.write(`could not unlock ${FAKE_VALUES.good}\n`);
    process.exit(3);
    break;
  case 'slow':
    setTimeout(() => answer({ value: FAKE_VALUES.good, origins }), 60_000);
    break;
  case 'junk':
    process.stdout.write(`value is ${FAKE_VALUES.good}, not json`);
    break;
  case 'huge':
    process.stdout.write(`${FAKE_VALUES.good}${'x'.repeat(100 * 1024)}`);
    break;
  case 'pathy':
    answer({ value: FAKE_VALUES.good, origins: ['https://app.example.com/login'] });
    break;
  default:
    process.stderr.write(`no such secret\n`);
    process.exit(1);
}
