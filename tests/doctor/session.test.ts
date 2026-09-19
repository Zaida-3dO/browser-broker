import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkSignInSession } from '../../src/doctor/checks.ts';
import {
  COOKIE_STORE_CANDIDATES,
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

/** The modern (M96+) and legacy layouts, named so the tests read as the layouts they are. */
const MODERN_LAYOUT = COOKIE_STORE_CANDIDATES[0] ?? [];
const LEGACY_LAYOUT = COOKIE_STORE_CANDIDATES[1] ?? [];

/** Put a cookie store file at one specific candidate layout. */
function writeStoreAt(directory: string, relative: readonly string[]): string {
  const file = path.join(directory, ...relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

/** A reader that answers per file, so the ordering tests can tell the two stores apart. */
function readerByFile(counts: ReadonlyMap<string, number>): CookieStoreReader {
  return {
    countCookies: (file) => {
      const count = counts.get(file);
      assert.notEqual(count, undefined, `the reader was pointed at an unexpected file: ${file}`);
      return { count: count ?? 0 };
    },
  };
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

test('A PROFILE WITH NO COOKIE STORE CONCLUDES NOTHING, AND CLAIMS NOTHING ABOUT THE WORLD', () => {
  const profile = temporaryProfile('regular');
  try {
    // Deliberately no store file written, at either candidate layout.
    const probe = inspectProfileSession(profile.root, 'regular', {
      reader: readerReturning({ count: 99 }),
    });

    // **The defect this branch shipped.** It used to answer `no-session-found`
    // with a reason saying the browser had never written a store and no
    // browser had run against the profile — a claim about the world drawn
    // from one path being absent. It was wrong on a real machine whose
    // profile kept the pre-M96 layout, and it would be wrong again for any
    // layout neither candidate names.
    assert.equal(probe.evidence, 'undetermined');

    // A count from a file that was never opened is not a measurement. The
    // field must be absent, not zero — `0` reads as *we counted and found
    // none*, which is the same overstatement in numeric form.
    assert.equal(probe.cookieCount, undefined, 'a count was reported from a file never opened');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(probe, 'cookieCount'),
      'cookieCount is present as a key, so a JSON consumer still sees a fabricated count',
    );

    // **The tone is the deliverable**, so it is asserted on directly. Each of
    // these phrases is a statement about what has happened on the machine,
    // and none of them is supported by a file not being at a path.
    for (const forbidden of [/has never run/iu, /no browser has/iu, /never written/iu]) {
      assert.doesNotMatch(
        probe.reason ?? '',
        forbidden,
        `the reason still claims more than it can see: ${String(forbidden)}`,
      );
    }

    // And it says what it did look for, which is what lets somebody check the
    // answer against their own machine.
    assert.match(probe.reason ?? '', /Default\/Network\/Cookies/u);
    assert.match(probe.reason ?? '', /Default\/Cookies/u);

    const check = checkSignInSession('regular', probe);
    assert.equal(check.status, 'unknown');
    // An `undetermined` carrying a remedy would un-say its own uncertainty.
    assert.equal(check.remedy, undefined, 'a remedy was attached to a non-answer');
  } finally {
    profile.remove();
  }
});

test('THE PRE-M96 LAYOUT IS FOUND, AND IS A SESSION LIKE ANY OTHER', () => {
  const profile = temporaryProfile('regular');
  try {
    // Only `Default/Cookies`, the layout Chromium uses before M96. A check
    // that looks only under `Default/Network/` finds nothing here and calls a
    // signed-in profile unused.
    writeStoreAt(profile.directory, LEGACY_LAYOUT);

    const probe = inspectProfileSession(profile.root, 'regular', {
      reader: readerReturning({ count: 4 }),
      browserRunning: false,
    });

    assert.equal(probe.evidence, 'session-present');
    assert.equal(probe.cookieCount, 4);
    assert.equal(probe.storeRelativePath, 'Default/Cookies');

    const check = checkSignInSession('regular', probe);
    assert.equal(check.status, 'ok');
  } finally {
    profile.remove();
  }
});

test('the modern layout is found, and is named relative to the profile', () => {
  const profile = temporaryProfile('regular');
  try {
    writeStoreAt(profile.directory, MODERN_LAYOUT);

    const probe = inspectProfileSession(profile.root, 'regular', {
      reader: readerReturning({ count: 12 }),
      browserRunning: false,
    });

    assert.equal(probe.evidence, 'session-present');
    assert.equal(probe.storeRelativePath, 'Default/Network/Cookies');
    // §1.7a: never an absolute path. The profile root is a temporary
    // directory, so its appearance would be unmistakable.
    assert.ok(
      !(probe.storeRelativePath ?? '').includes(profile.root),
      'an absolute path was emitted',
    );
  } finally {
    profile.remove();
  }
});

test('WITH BOTH LAYOUTS PRESENT THE MODERN ONE WINS, AND THE OTHER IS NAMED NOT SUMMED', () => {
  const profile = temporaryProfile('regular');
  try {
    // A profile migrated across M96 holds both files. Summing them would
    // count one store twice.
    const modern = writeStoreAt(profile.directory, MODERN_LAYOUT);
    const legacy = writeStoreAt(profile.directory, LEGACY_LAYOUT);

    const probe = inspectProfileSession(profile.root, 'regular', {
      reader: readerByFile(
        new Map([
          [modern, 3],
          [legacy, 9],
        ]),
      ),
      browserRunning: false,
    });

    assert.equal(probe.evidence, 'session-present');
    assert.equal(probe.storeRelativePath, 'Default/Network/Cookies');
    // 3, not 9 and not 12: the modern store's count alone.
    assert.equal(probe.cookieCount, 3);
    // The other one is mentioned rather than silently ignored, because a
    // person debugging a count they do not recognise needs to know a second
    // store exists.
    assert.match(probe.reason ?? '', /Default\/Cookies/u);
  } finally {
    profile.remove();
  }
});

test('ORDERING IS PINNED: a modern store holding zero beats a legacy one holding rows', () => {
  const profile = temporaryProfile('regular');
  try {
    const modern = writeStoreAt(profile.directory, MODERN_LAYOUT);
    const legacy = writeStoreAt(profile.directory, LEGACY_LAYOUT);

    const probe = inspectProfileSession(profile.root, 'regular', {
      reader: readerByFile(
        new Map([
          [modern, 0],
          [legacy, 5],
        ]),
      ),
      browserRunning: false,
    });

    // **This is the assertion that pins the order rather than merely
    // exercising it.** Read `Default/Cookies` first, or sum the two, and this
    // reports `session-present` from five rows the browser in use has already
    // migrated away from. The store the browser writes to says zero, so the
    // answer is the negative.
    assert.equal(probe.evidence, 'no-session-found');
    assert.equal(probe.storeRelativePath, 'Default/Network/Cookies');
  } finally {
    profile.remove();
  }
});

test('A ZERO COUNT WITH NOBODY HAVING ASKED ABOUT THE BROWSER IS UNKNOWN, NOT THE NEGATIVE', () => {
  const profile = temporaryProfile('regular');
  try {
    writeCookieStore(profile.directory);

    // `browserRunning` deliberately not supplied — the state every shipped
    // build was permanently in, because no production caller passed a
    // discovery probe.
    const unasked = inspectProfileSession(profile.root, 'regular', {
      reader: readerReturning({ count: 0 }),
    });

    assert.equal(unasked.evidence, 'undetermined');

    // And its reason must not be the live-browser reason: they are different
    // situations and the one a person is in decides what they do next.
    const live = inspectProfileSession(profile.root, 'regular', {
      reader: readerReturning({ count: 0 }),
      browserRunning: true,
    });
    assert.equal(live.evidence, 'undetermined');
    assert.notEqual(
      unasked.reason,
      live.reason,
      'the unasked case was given the running-browser explanation, which asserts a browser is live',
    );
    // The unasked reason says the question was not settled; the live one
    // tells somebody to close their browser, which would be wrong advice here.
    assert.doesNotMatch(unasked.reason ?? '', /Close the browser/u);

    const check = checkSignInSession('regular', unasked);
    assert.equal(check.status, 'unknown');
    assert.equal(check.remedy, undefined, '`broker login` was offered on a non-answer');
  } finally {
    profile.remove();
  }
});

test('`broker login` is offered ONLY on a genuine no-session-found', () => {
  const profile = temporaryProfile('regular');
  try {
    writeCookieStore(profile.directory);

    // The one state that earns it: store found, opened, genuinely zero rows,
    // and a browser measured not to be running.
    const genuine = inspectProfileSession(profile.root, 'regular', {
      reader: readerReturning({ count: 0 }),
      browserRunning: false,
    });
    assert.equal(genuine.evidence, 'no-session-found');
    assert.match(checkSignInSession('regular', genuine).remedy ?? '', /broker login/u);

    // Every other probe shape must not carry it. A remedy asserts the
    // reader's system is in a particular state, so one attached to an
    // `unknown` tells somebody their sign-in failed on the strength of a
    // question nobody answered.
    const others = [
      inspectProfileSession(profile.root, 'regular', {
        reader: readerReturning({ count: 0 }),
        browserRunning: true,
      }),
      inspectProfileSession(profile.root, 'regular', {
        reader: readerReturning({ count: 0 }),
      }),
      inspectProfileSession(profile.root, 'regular', {
        reader: readerReturning({ error: 'database is locked' }),
      }),
      inspectProfileSession(profile.root, 'regular', {
        reader: readerReturning({ count: 3 }),
        browserRunning: false,
      }),
    ];
    for (const probe of others) {
      const check = checkSignInSession('regular', probe);
      assert.equal(
        check.remedy,
        undefined,
        `a remedy was attached to ${probe.evidence}, which has not earned it`,
      );
    }
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
