import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { readEnvironment } from '../../src/config/environment.ts';
import { StartupRefusal } from '../../src/errors.ts';

/**
 * The four browser variables, and the refusals that are the specification.
 *
 * ── What this suite is for ──────────────────────────────────────────────
 *
 * `DECISIONS.md` §13i makes the configured browsers a bounded list per kind,
 * and the bound is the entire reason that is a different object from the
 * on-demand escape hatch §6 rejected. **So the cap and the refusals
 * are the load-bearing part, not the happy path** — a build that read the
 * lists correctly and enforced nothing would have reversed §6 by accident,
 * which is the specific outcome §6 names.
 *
 * ── Why every refusal assertion names the offending entry ───────────────
 *
 * §6.3: *"refuse to start, naming the variable and what was expected."* For a
 * list, the useful half of "what was expected" is **which token failed** — a
 * caller told only that `BROKER_REGULAR_BROWSERS` is wrong has to work out
 * which of three names it meant. Each assertion below therefore matches the
 * offending name in the message, not merely that a refusal happened: a
 * refusal that fires with an unhelpful sentence would pass a bare
 * `assert.throws` and fail the requirement.
 */

const home = (): string => path.join(path.sep, 'home', 'someone');

const read = (env: Record<string, string>): ReturnType<typeof readEnvironment> =>
  readEnvironment({ env, homedir: home, platform: 'linux' });

/** The refusal, so its message can be read rather than merely its existence. */
function refusalFrom(env: Record<string, string>): StartupRefusal {
  try {
    read(env);
  } catch (error) {
    assert.ok(error instanceof StartupRefusal, 'a bad configuration refuses the spawn');
    return error;
  }
  assert.fail('the configuration was accepted and should have been refused');
}

// ── Defaults (§13i, §6.1: a fresh install runs with nothing set) ─────────

test('with nothing set there is one browser of each kind, named after its kind', () => {
  const environment = read({});
  assert.deepEqual([...environment.regularBrowsers], ['regular']);
  assert.deepEqual([...environment.privateBrowsers], ['private']);
});

test('with nothing set both engines are msedge', () => {
  // The changed default §6.3 puts in release notes: present on every Windows
  // machine, so a fresh install runs with no browser download step.
  const environment = read({});
  assert.equal(environment.regularBrowserEngine, 'msedge');
  assert.equal(environment.privateBrowserEngine, 'msedge');
});

// ── The lists ───────────────────────────────────────────────────────────

test('a list of names is read in the order it was written', () => {
  // Order is load-bearing: the FIRST entry is what an unstated `browser`
  // resolves to (§3.2), so a reader that sorted or de-ordered the list would
  // silently change which browser a defaulting caller gets.
  const environment = read({ BROKER_REGULAR_BROWSERS: 'checkout,admin,regular' });
  assert.deepEqual([...environment.regularBrowsers], ['checkout', 'admin', 'regular']);
});

test('surrounding whitespace is trimmed, so a readable list is a legal one', () => {
  const environment = read({ BROKER_PRIVATE_BROWSERS: ' private , scratch ' });
  assert.deepEqual([...environment.privateBrowsers], ['private', 'scratch']);
});

test('the two lists are independent — configuring one leaves the other at its default', () => {
  const environment = read({ BROKER_REGULAR_BROWSERS: 'a,b' });
  assert.deepEqual([...environment.regularBrowsers], ['a', 'b']);
  assert.deepEqual([...environment.privateBrowsers], ['private']);
});

// ── The refusals, each naming the offending entry ────────────────────────

test('a duplicate within one list is refused, naming the repeated entry', () => {
  // Two entries naming one browser is one browser, so a list that reads as
  // three and launches two is a configuration whose count nobody can trust.
  const refusal = refusalFrom({ BROKER_REGULAR_BROWSERS: 'alpha,beta,beta' });
  assert.match(refusal.message, /beta/);
  assert.match(refusal.message, /BROKER_REGULAR_BROWSERS/);
});

test('the same name in both lists is refused, naming the name', () => {
  // The name is the lease-time key (§3.2), so a name in both kinds has no
  // single answer to *which browser is this*.
  const refusal = refusalFrom({
    BROKER_REGULAR_BROWSERS: 'shared,alpha',
    BROKER_PRIVATE_BROWSERS: 'shared',
  });
  assert.match(refusal.message, /shared/);
  assert.match(refusal.message, /BROKER_REGULAR_BROWSERS/);
  assert.match(refusal.message, /BROKER_PRIVATE_BROWSERS/);
});

test('a fourth name in one list is refused, and the cap is stated', () => {
  // **The bound is what keeps §6's fear away**, so this is the assertion that
  // stands between a bounded list and "as many as are asked for".
  const refusal = refusalFrom({ BROKER_REGULAR_BROWSERS: 'a,b,c,d' });
  assert.match(refusal.message, /3/);
  assert.match(refusal.message, /BROKER_REGULAR_BROWSERS/);
});

test('exactly three is accepted, so the cap is three rather than two', () => {
  // The boundary in the passing direction. Without it, an off-by-one that
  // refused at three would be invisible to the test above.
  const environment = read({ BROKER_REGULAR_BROWSERS: 'a,b,c' });
  assert.equal(environment.regularBrowsers.length, 3);
});

test('the cap is per list, not a shared total — three and three is accepted', () => {
  // Per-list deliberately: one shared total could be spent entirely on
  // signed-in browsers, leaving no clean-room browser at all, and clean-room
  // is the kind that cannot be substituted for.
  const environment = read({
    BROKER_REGULAR_BROWSERS: 'a,b,c',
    BROKER_PRIVATE_BROWSERS: 'd,e,f',
  });
  assert.equal(environment.regularBrowsers.length, 3);
  assert.equal(environment.privateBrowsers.length, 3);
});

test('an unknown engine is refused, naming the value and listing the accepted words', () => {
  const refusal = refusalFrom({ BROKER_REGULAR_BROWSER_ENGINE: 'firefox' });
  assert.match(refusal.message, /firefox/);
  assert.match(refusal.message, /chrome/);
  assert.match(refusal.message, /brave/);
  assert.match(refusal.message, /msedge/);
});

test('the two engines are independent, and may differ', () => {
  const environment = read({
    BROKER_REGULAR_BROWSER_ENGINE: 'chrome',
    BROKER_PRIVATE_BROWSER_ENGINE: 'brave',
  });
  assert.equal(environment.regularBrowserEngine, 'chrome');
  assert.equal(environment.privateBrowserEngine, 'brave');
});

test('an empty entry is refused rather than read as a shorter list', () => {
  // `a,,b` is a typo rather than a two-entry list, and reading it as one
  // would silently run a configuration nobody wrote.
  const refusal = refusalFrom({ BROKER_REGULAR_BROWSERS: 'a,,b' });
  assert.match(refusal.message, /BROKER_REGULAR_BROWSERS/);
});

test('a set-but-empty list is refused rather than falling back to the default', () => {
  // §6.3: somebody set the variable and meant something by it, and no browser
  // is the one thing it cannot mean.
  const refusal = refusalFrom({ BROKER_REGULAR_BROWSERS: '   ' });
  assert.match(refusal.message, /BROKER_REGULAR_BROWSERS/);
});

test('a name longer than 32 characters is refused, naming the entry', () => {
  // The name is also a profile DIRECTORY name (§ above), so an unbounded
  // name is an unbounded path component. 33 characters is the boundary in
  // the refusing direction — one past the cap.
  const tooLong = 'a'.repeat(33);
  const refusal = refusalFrom({ BROKER_REGULAR_BROWSERS: tooLong });
  assert.match(refusal.message, new RegExp(tooLong));
  assert.match(refusal.message, /32/);
});

test('a name that is not a usable word is refused, naming it', () => {
  // The name is a store key, a profile DIRECTORY name and the word a caller
  // types, so it has to be legal in all three. Refusing here, once, is the
  // only place the refusal can name what was wrong — elsewhere it surfaces as
  // a filesystem error naming neither the variable nor the value.
  for (const bad of ['Regular', 'has space', '1st', 'with/slash', '..']) {
    const refusal = refusalFrom({ BROKER_REGULAR_BROWSERS: bad });
    assert.match(
      refusal.message,
      new RegExp(bad.replace(/[.*+?^${}()|[\]\\/]/gu, String.raw`\$&`)),
      `the refusal for ${JSON.stringify(bad)} names the entry`,
    );
  }
});

test('a path separator in a name is refused, so a name cannot escape the profile root', () => {
  // The consequence worth stating on its own: a profile directory is the
  // configured root plus the browser's name, so a name carrying a separator
  // would place a profile outside the root.
  refusalFrom({ BROKER_PRIVATE_BROWSERS: '../elsewhere' });
});
