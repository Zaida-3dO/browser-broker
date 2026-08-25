import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { run } from '../../src/cli/index.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * `broker init` and `broker diffs`, driven through the dispatcher.
 *
 * Both existed as complete, tested implementations that **nothing dispatched
 * to**: the setup handshake had no caller anywhere, and `diffs` was left
 * unregistered rather than half-registered. These tests are about the join,
 * so every one of them goes in through `run` with an argument vector — the
 * same entry point the executable calls — rather than importing the
 * implementation and calling it directly. Calling it directly is what a
 * symbol check does, and a symbol check is exactly what missed this.
 */

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function drive(argv: string[], env: NodeJS.ProcessEnv): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    env,
    streams: { out: (line) => out.push(line), err: (line) => err.push(line) },
  });
  return { code, out, err };
}

/** The environment a command needs, pointed at a store of its own. */
function environmentFor(temp: ReturnType<typeof makeTempStore>): NodeJS.ProcessEnv {
  return {
    BROKER_DB: temp.environment.databasePath,
    BROKER_PROFILE_ROOT: temp.environment.profileRoot,
    BROKER_ARTIFACTS_ROOT: temp.environment.artifactsRoot,
  };
}

test('broker init runs the handshake: the schema, the two browsers, and a profile each', async () => {
  const temp = makeTempStore();
  try {
    const result = await drive(['init'], environmentFor(temp));

    assert.equal(result.code, 0, result.err.join('\n'));

    const output = result.out.join('\n');
    // Named, not counted. Both browsers by name, because "two lines appeared"
    // is satisfied by any two lines.
    assert.match(output, /regular/u, 'the regular browser is missing from the report');
    assert.match(output, /private/u, 'the private browser is missing from the report');
    // The version the store was actually stepped to, read back off the file
    // rather than compared against the build's own constant. Asserting against
    // the imported constant would be the tautology it always is: the number
    // would agree with itself whether or not a single step ran.
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(temp.environment.databasePath, { readonly: true });
    const stepped = db.pragma('user_version', { simple: true }) as number;
    db.close();
    assert.ok(stepped > 0, 'the store was never stepped, so the handshake read nothing');
    assert.match(
      output,
      new RegExp(String.raw`schema: version ${String(stepped)}` + '$', 'mu'),
      'the reported version is not the one the store is actually at',
    );

    // The directories genuinely exist on disk. The report saying so is not
    // the same claim as it having happened.
    for (const browser of ['regular', 'private']) {
      assert.ok(
        fs.existsSync(path.join(temp.environment.profileRoot, browser)),
        `no profile directory was created for ${browser}`,
      );
    }
  } finally {
    temp.remove();
  }
});

test('a profile that is already there is USED, never recreated', async () => {
  const temp = makeTempStore();
  try {
    // A file standing in for the sign-in a person established by hand. If the
    // handshake ever recreates or clears the directory, this disappears — and
    // in the real case what disappears is somebody's logged-in session, with
    // no way to get it back.
    const profile = path.join(temp.environment.profileRoot, 'regular');
    fs.mkdirSync(profile, { recursive: true });
    const evidence = path.join(profile, 'signed-in-state');
    fs.writeFileSync(evidence, 'a login established by hand');

    const result = await drive(['init'], environmentFor(temp));
    assert.equal(result.code, 0, result.err.join('\n'));

    assert.ok(fs.existsSync(evidence), 'the handshake destroyed an existing profile');
    assert.equal(
      fs.readFileSync(evidence, 'utf8'),
      'a login established by hand',
      'the profile survived in name only — its contents were replaced',
    );

    // And it says which of the two it did, per browser, because that is the
    // question somebody runs this command to have answered.
    const output = result.out.join('\n');
    assert.match(
      output,
      /regular: profile found/u,
      'a profile that was present was not reported found',
    );
    assert.match(
      output,
      /private: profile created/u,
      'a profile that was absent was not reported created',
    );
  } finally {
    temp.remove();
  }
});

test('broker init refuses a store it does not understand rather than stepping around it', async () => {
  const temp = makeTempStore();
  try {
    // Step the store first, then claim it is from a later build.
    await drive(['init'], environmentFor(temp));

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(temp.environment.databasePath);
    db.pragma('user_version = 99');
    db.close();

    const result = await drive(['init'], environmentFor(temp));
    assert.notEqual(result.code, 0, 'a store from a newer build was accepted');
    assert.match(result.err.join('\n'), /refused \(/u, 'the refusal did not name its rule');
  } finally {
    temp.remove();
  }
});

test('broker diffs reaches the comparison listing rather than reporting it unbuilt', async () => {
  const temp = makeTempStore();
  try {
    const result = await drive(['diffs'], environmentFor(temp));

    assert.equal(result.code, 0, result.err.join('\n'));

    const everything = [...result.out, ...result.err].join('\n');
    // The specific thing this test exists to prevent coming back.
    assert.doesNotMatch(
      everything,
      /not built yet/u,
      'diffs is registered in the table but still falls through to the unbuilt branch',
    );
    assert.doesNotMatch(
      everything,
      /Unrecognised command/u,
      'diffs is not registered in the command table at all',
    );
    // And it is the listing that answered, rather than something that merely
    // exited zero.
    assert.match(everything, /comparison/iu, 'nothing that looks like the comparison listing ran');
  } finally {
    temp.remove();
  }
});

test('broker diffs refuses a malformed filter with the malformed exit code', async () => {
  const temp = makeTempStore();
  try {
    const result = await drive(['diffs', '--nonsense'], environmentFor(temp));
    assert.equal(result.code, 2, 'a bad argument to diffs did not exit malformed');
  } finally {
    temp.remove();
  }
});

test('login refuses without a service rather than opening a browser anyway', async () => {
  const temp = makeTempStore();
  try {
    // **The counterweight to every assertion above**, and the reason it is
    // still here after `login` was built: wiring commands up must not turn an
    // honest refusal into a blanket success.
    //
    // What it guards has sharpened rather than gone away. This route is driven
    // without a service, and `login`'s first act is to claim the browser
    // through one — which is what stops a person being handed a window that a
    // caller is already driving (SCHEMA.md 5.5.1, step 1). So a `login` that
    // exited zero here would mean a command that opened a browser without
    // having claimed it, which is precisely the failure that step exists to
    // prevent.
    const result = await drive(['login'], environmentFor(temp));
    assert.notEqual(result.code, 0);
    assert.match(result.err.join('\n'), /service\.not_built/u);
  } finally {
    temp.remove();
  }
});
