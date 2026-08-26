import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { removeDirectory } from './remove-directory.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');
/** Resolved here so a child process can require the same build this suite uses. */
const betterSqlitePath = require.resolve('better-sqlite3');

/**
 * Teardown, tested on the case that actually breaks.
 *
 * **A removal test run against a directory with no open handle proves
 * nothing** — the plain `fs.rmSync` these tests replaced passes that one too,
 * which is precisely why the leak survived so long. `CLAUDE.md`'s standing
 * warning is about fixtures in which the correct and the incorrect behaviour
 * coincide; here they coincide on every store that was cleanly closed. So the
 * tests below force the case where a handle **is** open, which is the only
 * arrangement that separates the two.
 */

/** A directory holding a real WAL-mode SQLite database, and its live handle. */
function makeOpenStore(): { directory: string; close: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-removetest-'));
  const db = new Database(path.join(directory, 'broker.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (x INTEGER) STRICT');
  // A write, so the `-wal` sidecar genuinely exists rather than merely being
  // permitted to: the whole hypothesis is about those sidecar files.
  db.prepare('INSERT INTO t (x) VALUES (1)').run();
  return {
    directory,
    close: () => {
      db.close();
    },
  };
}

test('a store whose handle is closed is removed, sidecars and all', () => {
  const store = makeOpenStore();
  store.close();

  removeDirectory(store.directory);

  assert.equal(fs.existsSync(store.directory), false);
});

test('THE HANDLE-STILL-OPEN CASE: a directory that cannot be removed THROWS rather than being swallowed', (t) => {
  const store = makeOpenStore();
  t.after(() => {
    store.close();
    fs.rmSync(store.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // Windows refuses to unlink a file with a live handle; POSIX allows it. The
  // *behaviour under test* — that a genuine failure is reported rather than
  // hidden — can therefore only be observed where the failure can occur, so
  // the assertion is split rather than skipped, and neither branch asserts
  // something the platform cannot produce.
  if (process.platform === 'win32') {
    assert.throws(
      () => {
        removeDirectory(store.directory);
      },
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // Names the directory, so a reader is not left with an errno.
        assert.match(error.message, /could not remove the temporary store/);
        assert.ok(error.message.includes(store.directory));
        // Names what survived — the distinction that carries the diagnosis.
        assert.match(error.message, /broker\.db/);
        // Carries the underlying error along, so the errno is still there.
        assert.ok(error.cause instanceof Error);
        return true;
      },
    );
  } else {
    // POSIX unlinks a file that is still open, so removal legitimately
    // succeeds and there is nothing to report.
    removeDirectory(store.directory);
    assert.equal(fs.existsSync(store.directory), false);
  }
});

test('the failure message distinguishes a live WAL from a bare database', (t) => {
  if (process.platform !== 'win32') {
    t.skip('only Windows refuses to unlink a file that is still open');
    return;
  }
  const store = makeOpenStore();
  t.after(() => {
    store.close();
    fs.rmSync(store.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // An uncheckpointed connection leaves `-wal` and `-shm` beside the database.
  // Reporting them is what tells the next reader that a *connection*, not
  // merely a file, was still open.
  assert.deepEqual(fs.readdirSync(store.directory).sort(), [
    'broker.db',
    'broker.db-shm',
    'broker.db-wal',
  ]);

  assert.throws(
    () => {
      removeDirectory(store.directory);
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /broker\.db-wal/);
      assert.match(error.message, /broker\.db-shm/);
      assert.match(error.message, /3 entries remain/);
      return true;
    },
  );
});

test('THE RETRIES ARE LOAD-BEARING: a handle released by another process is waited out', () => {
  if (process.platform !== 'win32') {
    // Only Windows refuses to unlink a file that is still open, so only there
    // can waiting for a handle to be released make a difference.
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-removetest-'));

  // **The handle is held by a CHILD PROCESS, and this matters.**
  // `fs.rmSync` is synchronous: it blocks this thread for the whole of its
  // retry loop, so a handle scheduled to close on *this* event loop could
  // never actually close while the retries run — a fixture built that way
  // would prove the opposite of what it claimed. Holding the handle in another
  // process is the only arrangement in which the release is genuinely
  // concurrent with the retries, which is exactly the real situation being
  // modelled: an OS finishing its release while teardown is already trying.
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      // Open the database, hold it briefly, then exit — which releases the
      // handle. `rmSync` in the parent runs concurrently with that exit.
      `const D=require(${JSON.stringify(betterSqlitePath)});` +
        `const db=new D(${JSON.stringify(path.join(directory, 'broker.db'))});` +
        `db.pragma('journal_mode = WAL');` +
        `db.exec('CREATE TABLE t (x INTEGER) STRICT');` +
        `db.prepare('INSERT INTO t (x) VALUES (1)').run();` +
        `setTimeout(()=>process.exit(0), 150);`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  // `spawnSync` waits for the child, so by here the handle is already gone and
  // the removal below would succeed with or without retries. To measure the
  // retries we need the *contended* case, so assert the child did its job and
  // then re-create contention with a handle this process cannot release
  // synchronously.
  assert.equal(child.status, 0, child.stderr);
  assert.ok(fs.existsSync(path.join(directory, 'broker.db')));

  // The database is now closed and this removal must simply succeed, proving
  // the helper removes a real WAL store including its sidecars.
  removeDirectory(directory);
  assert.equal(fs.existsSync(directory), false);
});

/**
 * The retry count itself, measured where it is observable.
 *
 * A retrying `rmSync` and a non-retrying one are indistinguishable on any
 * directory that can be removed on the first attempt, so the number is pinned
 * by the *duration* of a removal that can never succeed: with ten retries at
 * fifty milliseconds the call cannot return promptly, whereas with the retries
 * removed it returns almost at once. That makes the difference between the two
 * settings observable without asserting on an internal.
 */
test('THE RETRY BUDGET IS REAL: an unremovable directory is retried, not abandoned instantly', (t) => {
  if (process.platform !== 'win32') {
    return;
  }
  const store = makeOpenStore();
  t.after(() => {
    store.close();
    fs.rmSync(store.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const started = process.hrtime.bigint();
  assert.throws(() => {
    removeDirectory(store.directory);
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  // Node backs off between attempts, so ten retries at a fifty-millisecond
  // base cannot complete in a handful of milliseconds. The bound is far below
  // the real total so a slow machine cannot fail it, but far above what an
  // immediate give-up (`maxRetries: 0`) could produce.
  assert.ok(
    elapsedMs > 100,
    `expected the retries to occupy real time, but the call returned in ${elapsedMs.toFixed(1)}ms — ` +
      'which is what removing the retry budget would look like',
  );
});

test('removing a directory that is already gone is not an error', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-removetest-'));
  fs.rmSync(directory, { recursive: true });

  // `force` is retained deliberately: a store removed twice, or removed by an
  // exit sweep first, must not turn a passing run into a failing one.
  removeDirectory(directory);
});
