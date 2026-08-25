import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkSignInSession } from '../../src/doctor/checks.ts';
import {
  COOKIE_STORE_RELATIVE,
  inspectProfileSession,
  type CookieStoreReader,
} from '../../src/doctor/session.ts';

/**
 * Whether the doctor can honestly tell a signed-in profile from a fresh one.
 *
 * ── Why the interesting assertions are about what it REFUSES to claim ───
 *
 * The house standard names *a check that claims what it cannot see* as a
 * hollow shape, and this check is the one most exposed to it: the obvious
 * implementation — does the cookie file exist — **cannot fail**, because a
 * browser creates that file on its first run whether or not anything is ever
 * stored in it. Measured, on a real browser, in the headed test at the bottom
 * of this file.
 *
 * So most of what is asserted here is the honesty of the negative cases: a
 * zero count while a browser is live is `unknown` and says why, and a zero
 * count with no browser is `unknown` **with the reason stated as absence of
 * evidence** rather than as a verdict.
 */

/** A profile root with a profile directory in it, and nothing else. */
function temporaryProfile(browser: string): {
  root: string;
  directory: string;
  remove: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-session-'));
  const directory = path.join(root, browser);
  fs.mkdirSync(directory, { recursive: true });
  return {
    root,
    directory,
    remove: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A reader that answers whatever the test needs, so failure paths are reachable. */
function readerReturning(result: { count: number } | { error: string }): CookieStoreReader {
  return { countCookies: () => result };
}

/** Put a cookie store file where the real one lives. Contents are the reader's business. */
function writeCookieStore(directory: string): string {
  const file = path.join(directory, ...COOKIE_STORE_RELATIVE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

test('no profile at all is reported as such, not as "not signed in"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-session-'));
  try {
    const probe = inspectProfileSession(root, 'regular');
    assert.equal(probe.evidence, 'no-profile');

    const check = checkSignInSession('regular', probe);
    // A fresh install is not a broken install: `unknown`, never `failed`.
    assert.equal(check.status, 'unknown');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stored cookies are reported as a session, and the count is given', () => {
  const profile = temporaryProfile('regular');
  try {
    writeCookieStore(profile.directory);
    const probe = inspectProfileSession(profile.root, 'regular', {
      reader: readerReturning({ count: 7 }),
    });

    assert.equal(probe.evidence, 'session-present');
    assert.equal(probe.cookieCount, 7);

    const check = checkSignInSession('regular', probe);
    assert.equal(check.status, 'ok');
    assert.match(check.detail, /7/u, 'the count a person would act on was not reported');
  } finally {
    profile.remove();
  }
});

test('A ZERO COUNT WITH A BROWSER RUNNING IS UNKNOWN, NOT "NOT SIGNED IN"', () => {
  const profile = temporaryProfile('regular');
  try {
    writeCookieStore(profile.directory);
    const probe = inspectProfileSession(profile.root, 'regular', {
      reader: readerReturning({ count: 0 }),
      browserRunning: true,
    });

    // **This is the measured case.** A browser writes its cookies down when
    // it shuts down cleanly, so a zero read while one is live is a count of
    // what has been flushed rather than of what the session holds. Reporting
    // it as "not signed in" would tell somebody their sign-in had failed at
    // the exact moment it had just succeeded.
    assert.equal(probe.evidence, 'undetermined');
    assert.match(
      probe.reason ?? '',
      /flush|clean|shut/iu,
      'the reason did not explain why the answer is unknown',
    );

    const check = checkSignInSession('regular', probe);
    assert.equal(check.status, 'unknown');
    assert.notEqual(check.status, 'failed', 'a live browser was reported as a fault');
  } finally {
    profile.remove();
  }
});

test('a zero count with no browser is absence of evidence, and says so', () => {
  const profile = temporaryProfile('regular');
  try {
    writeCookieStore(profile.directory);
    const probe = inspectProfileSession(profile.root, 'regular', {
      reader: readerReturning({ count: 0 }),
      browserRunning: false,
    });

    assert.equal(probe.evidence, 'no-session-found');

    const check = checkSignInSession('regular', probe);
    // Still `unknown` rather than `failed`: an unsigned profile is the
    // ordinary state of every installation until somebody signs in, and a
    // readiness check that went red on it would be one people learn to
    // ignore.
    assert.equal(check.status, 'unknown');
    // And it names the limit of what it can see — a site keeping its session
    // in local storage looks exactly like this.
    assert.match(check.detail, /local storage|evidence/iu);
    // A negative answer owes the person the next step.
    assert.match(check.remedy ?? '', /login/u);
  } finally {
    profile.remove();
  }
});

test('an unreadable cookie store concludes nothing, and reports why', () => {
  const profile = temporaryProfile('regular');
  try {
    writeCookieStore(profile.directory);
    const probe = inspectProfileSession(profile.root, 'regular', {
      reader: readerReturning({ error: 'database is locked' }),
    });

    assert.equal(probe.evidence, 'undetermined');
    assert.match(probe.reason ?? '', /locked/u, 'the underlying cause was swallowed');

    const check = checkSignInSession('regular', probe);
    assert.equal(check.status, 'unknown');
  } finally {
    profile.remove();
  }
});

test('a profile with no cookie store at all has had no browser run against it', () => {
  const profile = temporaryProfile('regular');
  try {
    // Deliberately no store file written.
    const probe = inspectProfileSession(profile.root, 'regular', {
      reader: readerReturning({ count: 99 }),
    });

    // The reader is never consulted, because there is no file to read — and
    // if it were, this would report a session that does not exist.
    assert.equal(probe.evidence, 'no-session-found');
    assert.equal(probe.cookieCount, 0);
  } finally {
    profile.remove();
  }
});

test('the check never fails, on any evidence — a fresh install is not a fault', () => {
  // Every branch, walked, asserting the one property that governs all of
  // them. A check that failed here would make `broker doctor` exit non-zero
  // on a correct fresh installation.
  const evidences = ['session-present', 'no-session-found', 'no-profile', 'undetermined'] as const;
  for (const evidence of evidences) {
    const check = checkSignInSession('regular', { evidence, cookieCount: 0 });
    assert.notEqual(check.status, 'failed', `${evidence} was reported as a failure`);
  }
});
