import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runLoginCommand, type SignInWindow } from '../../src/cli/login-command.ts';
import { SIGNABLE_BROWSER } from '../../src/service/operations/sign-in.ts';
import { CallRefusal } from '../../src/service/refusals.ts';
import { claimInput, withBroker } from '../helpers/broker.ts';

/**
 * `broker login`'s command half — the sequence, and what it guarantees.
 *
 * ── What the injected window buys, and what it does not ─────────────────
 *
 * The window is a seam so that the **sequence** is testable without a
 * display: the browser is claimed before a window appears, the profile handed
 * to it is the configured one, and the browser is given back on every path
 * out — including the failing ones.
 *
 * It cannot prove a real headed browser appears, and nothing here pretends
 * otherwise. What proves the real launch asserts its endpoint rather than
 * inferring it is `launch.ts`'s own suite, which drives a real browser.
 */

/** A window that records what it was asked for and never opens anything. */
function recordingWindow(
  overrides: Partial<SignInWindow> = {},
): SignInWindow & { readonly opened: { profileDirectory: string; browser: string }[] } {
  const opened: { profileDirectory: string; browser: string }[] = [];
  return {
    opened,
    open: (request) => {
      opened.push({ profileDirectory: request.profileDirectory, browser: request.browser });
      return Promise.resolve({ pid: 4242, startedIt: true });
    },
    // A person who closed the window immediately.
    waitForClose: () => Promise.resolve(),
    ...overrides,
  };
}

const streamsCollecting = (): {
  streams: { out: (line: string) => void; err: (line: string) => void };
  out: string[];
  err: string[];
} => {
  const out: string[] = [];
  const err: string[] = [];
  return { streams: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
};

test('THE ORDER: the browser is claimed BEFORE a window is opened', async () => {
  await withBroker(async ({ broker, store, environment }) => {
    const seen: string[] = [];
    const collected = streamsCollecting();

    const code = await runLoginCommand({
      broker,
      store,
      environment,
      streams: collected.streams,
      json: false,
      window: {
        open: () => {
          // Read the committed state at the moment the window is asked for.
          // If the claim came second, this is not `signing-in` yet — and a
          // person would be looking at a window the service had not reserved.
          const [row] = store.db
            .prepare('SELECT state FROM browsers WHERE id = ?')
            .all(SIGNABLE_BROWSER) as { state: string }[];
          seen.push(row?.state ?? 'missing');
          return Promise.resolve({ pid: 1, startedIt: true });
        },
        waitForClose: () => Promise.resolve(),
      },
    });

    assert.equal(code, 0);
    assert.deepEqual(seen, ['signing-in'], 'the window was opened before the browser was claimed');
  });
});

test('the window is opened against the CONFIGURED profile, never a default or temporary one', async () => {
  await withBroker(async ({ broker, store, environment }) => {
    const window = recordingWindow();
    const collected = streamsCollecting();

    await runLoginCommand({
      broker,
      store,
      environment,
      streams: collected.streams,
      json: false,
      window,
    });

    assert.equal(window.opened.length, 1);
    // **The failure this prevents is undetectable afterwards**: a sign-in
    // against a directory one character different from the one callers use
    // succeeds, writes a real session, and leaves every caller attaching to a
    // signed-out browser.
    assert.equal(
      window.opened[0]?.profileDirectory,
      path.join(environment.profileRoot, SIGNABLE_BROWSER),
      'the window was opened against something other than the configured profile',
    );
  });
});

test('THE BROWSER IS GIVEN BACK EVEN WHEN OPENING THE WINDOW FAILS', async () => {
  await withBroker(async ({ broker, store, environment, readCommitted }) => {
    const collected = streamsCollecting();

    const failure = await runLoginCommand({
      broker,
      store,
      environment,
      streams: collected.streams,
      json: false,
      window: {
        open: () => Promise.reject(new Error('the browser did not open an endpoint of its own')),
        waitForClose: () => Promise.resolve(),
      },
    }).catch((error: unknown) => error);

    assert.ok(failure instanceof Error, 'a failed launch was reported as success');

    // **The state that would otherwise be permanent.** A browser left in
    // `signing-in` refuses every caller, forever, with a message about a
    // person who has walked away — a worse outcome than the failure that
    // caused it.
    const [row] = readCommitted<{ state: string }>('SELECT state FROM browsers WHERE id = @id', {
      id: SIGNABLE_BROWSER,
    });
    assert.notEqual(row?.state, 'signing-in', 'the browser was left claimed after a failed launch');
  });
});

test('a live lease refuses the command, and no window is opened', async () => {
  await withBroker(async ({ broker, store, environment }) => {
    await broker.claim(claimInput({ browser: SIGNABLE_BROWSER }));

    const window = recordingWindow();
    const collected = streamsCollecting();

    const refusal = await runLoginCommand({
      broker,
      store,
      environment,
      streams: collected.streams,
      json: false,
      window,
    }).catch((error: unknown) => error);

    assert.ok(refusal instanceof CallRefusal, 'the command did not refuse');
    // `CLAUDE.md`'s rule: a guard that returns "denied" after the window
    // already opened is worse than no guard, and asserting the response alone
    // cannot tell the two apart.
    assert.equal(window.opened.length, 0, 'a window was opened for a browser that was refused');
  });
});

test('the private browser is refused before anything is opened', async () => {
  await withBroker(async ({ broker, store, environment }) => {
    const window = recordingWindow();
    const collected = streamsCollecting();

    const refusal = await runLoginCommand({
      broker,
      store,
      environment,
      streams: collected.streams,
      json: false,
      browser: 'private',
      window,
    }).catch((error: unknown) => error);

    assert.ok(refusal instanceof CallRefusal);
    assert.equal(window.opened.length, 0, 'an ephemeral profile was opened for a sign-in');
  });
});

test('the instructions tell a person what to do and that closing ends the step', async () => {
  await withBroker(async ({ broker, store, environment }) => {
    const collected = streamsCollecting();

    await runLoginCommand({
      broker,
      store,
      environment,
      streams: collected.streams,
      json: false,
      window: recordingWindow(),
    });

    const text = collected.out.join('\n');
    // The three things a person cannot proceed without, each asserted
    // because the output IS the product for this command.
    assert.match(text, /sign in/iu, 'the instructions never say to sign in');
    assert.match(text, /clos(e|ing) (the )?window/iu, 'it never says closing the window ends it');
    assert.match(text, new RegExp(SIGNABLE_BROWSER, 'u'), 'it never says which browser');
    // And what it promises about privacy, which a person may reasonably want
    // before typing a password into a window something else opened.
    assert.match(text, /records? what you type|never sees a credential/iu);
  });
});

test('the profile is established but NEVER recreated when it already exists', async () => {
  await withBroker(async ({ broker, store, environment }) => {
    const directory = path.join(environment.profileRoot, SIGNABLE_BROWSER);
    fs.mkdirSync(directory, { recursive: true });
    // A file standing in for the sign-in a person put there by hand.
    const witness = path.join(directory, 'the-sign-in-somebody-established');
    fs.writeFileSync(witness, 'do not lose me');

    const collected = streamsCollecting();
    await runLoginCommand({
      broker,
      store,
      environment,
      streams: collected.streams,
      json: false,
      window: recordingWindow(),
    });

    // `setup.profile_never_destroyed`. There is no recovering a profile that
    // was cleared, and the person finds out at the least convenient moment.
    assert.ok(fs.existsSync(witness), 'the command destroyed an existing profile');
  });
});

test('the profile is CREATED when it is absent, so the browser has somewhere to write', async () => {
  await withBroker(async ({ broker, store, environment }) => {
    const directory = path.join(environment.profileRoot, SIGNABLE_BROWSER);
    assert.ok(!fs.existsSync(directory), 'the fixture already had a profile');

    const collected = streamsCollecting();
    await runLoginCommand({
      broker,
      store,
      environment,
      streams: collected.streams,
      json: false,
      window: recordingWindow(),
    });

    // **The other half of `setup.profile_never_destroyed`**, and the half a
    // test asserting only "an existing profile survives" cannot see: setup
    // *may create*. Without this, a first sign-in on a fresh install hands a
    // browser a directory that is not there — and the browser, not this
    // command, decides what to do about it.
    assert.ok(fs.existsSync(directory), 'the profile was never established');
  });
});

test('the machine-readable mode keeps human text off the output stream', async () => {
  await withBroker(async ({ broker, store, environment }) => {
    const collected = streamsCollecting();

    await runLoginCommand({
      broker,
      store,
      environment,
      streams: collected.streams,
      json: true,
      window: recordingWindow(),
    });

    // §5.6: one document per call, all human text on the error stream, "so a
    // caller that did not ask for prose gets none".
    for (const line of collected.out) {
      assert.doesNotThrow(() => JSON.parse(line) as unknown, `not a document: ${line}`);
    }
    const document = JSON.parse(collected.out[0] ?? '{}') as {
      value?: { profileRelativePath?: string };
    };
    // §1.7a: relative, because an absolute path names one machine.
    assert.equal(document.value?.profileRelativePath, SIGNABLE_BROWSER);
    assert.ok(
      !JSON.stringify(document).includes(environment.profileRoot),
      'an absolute path reached the machine-readable document',
    );
  });
});
