import assert from 'node:assert/strict';
import test from 'node:test';

import { BrokerError } from '../../src/errors.ts';
import { boundFieldKind, fieldKindsOf, originOfAddress } from '../../src/secrets/binding.ts';
import {
  commandSecretResolver,
  normaliseOrigin,
  parseCommandLine,
  parseResolverOutput,
} from '../../src/secrets/resolver.ts';
import { REDACTION_MARK, scrubberFor, spellingsOf } from '../../src/secrets/scrub.ts';
import { containsSentinel, sentinelName } from '../../src/secrets/sentinel.ts';
import { FAKE_VALUES } from '../fixtures/fake-secret-values.ts';
import { fakeResolverCommand } from '../helpers/secrets.ts';

/**
 * The pieces of §3.8a that need no browser: the sentinel, the resolver
 * contract, the field heuristic and the scrubber.
 *
 * Every refusal test here also asserts the refusal's text does **not**
 * contain the value — the property the whole feature rests on — because a
 * refusal that named the secret correctly while quoting its value would pass
 * an assertion on the rule alone.
 */

// ── The sentinel ──────────────────────────────────────────────────────────

test('a whole-value sentinel yields its name, and nothing else does', () => {
  assert.equal(sentinelName('{{secret:login/main}}'), 'login/main');
  assert.equal(sentinelName('{{secret:a.b_c-d}}'), 'a.b_c-d');
  // Embedded, malformed, empty, over-long, or carrying a disallowed character.
  assert.equal(sentinelName('x{{secret:login}}'), undefined);
  assert.equal(sentinelName('{{secret:login}} '), undefined);
  assert.equal(sentinelName('{{secret:}}'), undefined);
  assert.equal(sentinelName('{{secret:has space}}'), undefined);
  assert.equal(sentinelName(`{{secret:${'a'.repeat(129)}}}`), undefined);
  assert.equal(sentinelName(`{{secret:${'a'.repeat(128)}}}`), 'a'.repeat(128));
});

test('a sentinel is found anywhere inside a structure, including in keys', () => {
  assert.equal(containsSentinel({ a: [{ b: 'x {{secret:y}}' }] }), true);
  assert.equal(containsSentinel({ '{{secret:k}}': 'v' }), true);
  assert.equal(containsSentinel({ a: ['{{ secret:y}}', 'plain'] }), false);
});

// ── The resolver contract ─────────────────────────────────────────────────

test('a command line splits on spaces, with double quotes grouping a word', () => {
  assert.deepEqual(parseCommandLine('prog --flag value'), ['prog', '--flag', 'value']);
  assert.deepEqual(parseCommandLine('"a program" "two words" x'), ['a program', 'two words', 'x']);
  assert.equal(parseCommandLine('  '), undefined);
  assert.equal(parseCommandLine('"unterminated'), undefined);
});

test('an origin must be exactly an origin', () => {
  assert.equal(normaliseOrigin('https://example.com'), 'https://example.com');
  assert.equal(normaliseOrigin('https://example.com/'), 'https://example.com');
  assert.equal(normaliseOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(normaliseOrigin('https://example.com/login'), undefined);
  assert.equal(normaliseOrigin('https://example.com?x=1'), undefined);
  // external-ref-ok-next-line: an address carrying credentials is the input this line refuses
  assert.equal(normaliseOrigin('https://user:pw@example.com'), undefined);
  assert.equal(normaliseOrigin('file:///etc'), undefined);
  assert.equal(normaliseOrigin('not a url'), undefined);
  assert.equal(normaliseOrigin(7), undefined);
});

test('resolver output is read strictly, and a refusal never quotes it', () => {
  const ok = parseResolverOutput(
    'n',
    JSON.stringify({ value: 'v-1', origins: ['https://example.com'] }),
  );
  assert.deepEqual(ok, {
    value: 'v-1',
    origins: ['https://example.com'],
    fields: ['password'],
  });

  const cases: [string, string][] = [
    ['not json SECRETISH', 'JSON object'],
    [JSON.stringify(['SECRETISH']), 'JSON object'],
    [JSON.stringify({ value: '', origins: ['https://example.com'] }), '"value"'],
    [JSON.stringify({ value: 'SECRETISH' }), '"origins"'],
    [JSON.stringify({ value: 'SECRETISH', origins: [] }), '"origins"'],
    [JSON.stringify({ value: 'SECRETISH', origins: ['https://example.com/p'] }), 'exact origin'],
    [
      JSON.stringify({ value: 'SECRETISH', origins: ['https://example.com'], fields: ['card'] }),
      '"fields"',
    ],
    [
      JSON.stringify({ value: 'SECRETISH', origins: ['https://example.com'], fields: [] }),
      '"fields"',
    ],
  ];
  for (const [stdout, mentions] of cases) {
    assert.throws(
      () => parseResolverOutput('my/secret', stdout),
      (error: unknown) => {
        assert.ok(error instanceof BrokerError);
        assert.equal(error.rule, 'act.secret_resolved');
        assert.match(error.message, /"my\/secret"/u);
        assert.ok(error.message.includes(mentions), `${error.message} should mention ${mentions}`);
        assert.ok(
          !error.message.includes('SECRETISH'),
          `the refusal quoted the output: ${error.message}`,
        );
        return true;
      },
    );
  }
});

test('the command resolver spawns the configured program and reads its answer', async () => {
  const resolve = commandSecretResolver(fakeResolverCommand(['https://example.com']));
  const secret = await resolve('user');
  assert.equal(secret.value, FAKE_VALUES.user);
  assert.deepEqual(secret.origins, ['https://example.com']);
  assert.deepEqual(secret.fields, ['username']);
});

test('every way a resolver can fail is a refusal naming the secret and never the value', async () => {
  // Long enough that only `slow` reaches it, even on a loaded machine where a
  // spawned process takes seconds to answer; `slow` never answers at all.
  const resolve = commandSecretResolver(fakeResolverCommand(['https://example.com']), {
    timeoutMs: 8_000,
  });
  const expectations: [string, RegExp][] = [
    // Exits non-zero, having printed the value to standard error.
    ['fail', /exited with code 3/u],
    // Prints the value inside text that is not JSON.
    ['junk', /JSON object/u],
    // Prints the value followed by far more than a secret can be.
    ['huge', /more output/u],
    // Never answers.
    ['slow', /did not answer within 8000 ms/u],
    // Binds to something that is not an origin.
    ['pathy', /exact origin/u],
    // Not a name it knows.
    ['nobody', /exited with code 1/u],
  ];
  for (const [name, why] of expectations) {
    await assert.rejects(resolve(name), (error: unknown) => {
      assert.ok(error instanceof BrokerError, `${name}: not a refusal`);
      assert.equal(error.rule, 'act.secret_resolved');
      assert.match(error.message, new RegExp(`"${name}"`, 'u'));
      assert.match(error.message, why);
      assert.ok(
        !error.message.includes(FAKE_VALUES.good),
        `${name}: the refusal quoted the value: ${error.message}`,
      );
      return true;
    });
  }
});

test('a resolver program that does not exist is refused, not crashed on', async () => {
  const resolve = commandSecretResolver(['definitely-not-a-program-on-this-path-7731']);
  await assert.rejects(resolve('good'), /could not be started/u);
});

// ── The field heuristic ───────────────────────────────────────────────────

const input = (
  over: Partial<Parameters<typeof fieldKindsOf>[0]>,
): Parameters<typeof fieldKindsOf>[0] => ({
  tag: 'input',
  type: '',
  autocomplete: '',
  name: '',
  id: '',
  ...over,
});

test('field kinds follow the documented heuristic, and nothing else matches', () => {
  assert.deepEqual(fieldKindsOf(input({ type: 'password' })), ['password']);
  assert.deepEqual(fieldKindsOf(input({ type: 'PASSWORD' })), ['password']);
  assert.deepEqual(fieldKindsOf(input({ autocomplete: 'one-time-code' })), ['otp']);
  assert.deepEqual(fieldKindsOf(input({ autocomplete: 'section-a username' })), ['username']);
  assert.deepEqual(fieldKindsOf(input({ autocomplete: 'email' })), ['username']);
  assert.deepEqual(fieldKindsOf(input({ type: 'email' })), ['username']);
  assert.deepEqual(fieldKindsOf(input({ name: 'login_name' })), ['username']);
  assert.deepEqual(fieldKindsOf(input({ type: 'text', id: 'UserId' })), ['username']);
  // Not a username: a text field with no hint, a search box, a textarea, a
  // password field that happens to be called "username".
  assert.deepEqual(fieldKindsOf(input({ name: 'comment' })), []);
  assert.deepEqual(fieldKindsOf(input({ type: 'search', name: 'user' })), []);
  assert.deepEqual(fieldKindsOf(input({ tag: 'textarea', name: 'username' })), []);
  assert.deepEqual(fieldKindsOf(input({ type: 'password', name: 'username' })), ['password']);

  assert.equal(boundFieldKind(input({ type: 'password' }), ['username']), undefined);
  assert.equal(boundFieldKind(input({ name: 'user' }), ['password', 'username']), 'username');
});

test('only an http or https address has an origin a secret can be bound to', () => {
  assert.equal(originOfAddress('http://127.0.0.1:4000/login?x=1'), 'http://127.0.0.1:4000');
  assert.equal(originOfAddress('about:blank'), undefined);
  assert.equal(originOfAddress('data:text/html,hi'), undefined);
  assert.equal(originOfAddress(''), undefined);
});

// ── The scrubber ──────────────────────────────────────────────────────────

test('every spelling of a value the outputs use is removed', () => {
  const value = FAKE_VALUES.special;
  const scrub = scrubberFor([value]);
  for (const spelling of spellingsOf(value)) {
    const out = scrub(`before ${spelling} after`);
    assert.equal(out, `before ${REDACTION_MARK} after`, `spelling ${spelling} survived`);
  }
  // The specific spellings the outputs produce, written out rather than
  // derived, so a change to `spellingsOf` cannot quietly agree with itself.
  assert.ok(!scrub(`"${JSON.stringify(value)}"`).includes('fa\\"ke'));
  assert.ok(!scrub(`?pw=${encodeURIComponent(value)}`).includes('fa%22ke'));
  assert.ok(!scrub(`?${new URLSearchParams({ pw: value }).toString()}`).includes('fa%22ke'));
});

test('a value containing another is removed whole, and an empty value removes nothing', () => {
  const scrub = scrubberFor(['abc', 'abcdef', '']);
  assert.equal(scrub('xabcdefx abc'), `x${REDACTION_MARK}x ${REDACTION_MARK}`);
  assert.equal(scrubberFor([''])('unchanged'), 'unchanged');
});
