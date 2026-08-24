import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { StartupRefusal } from '../../src/errors.ts';
import { BUSY_TIMEOUT_MS, openStore } from '../../src/store/open.ts';
import { hasNetworkShareRoot } from '../../src/store/network-path.ts';
import { makeTempStore } from '../helpers/temp-store.ts';
import { sharePath } from '../helpers/paths.ts';

test('opening creates the file and its directory', () => {
  const temp = makeTempStore();
  try {
    const store = openStore(temp.environment);
    try {
      assert.equal(store.location, temp.environment.databasePath);
      assert.ok(fs.existsSync(temp.environment.databasePath));
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
});

test('the store opens in write-ahead-log mode', () => {
  // Read back rather than assumed. This is the mode that lets several
  // processes read while one writes, which is the whole basis of the
  // concurrency model.
  const temp = makeTempStore();
  try {
    const store = openStore(temp.environment);
    try {
      assert.equal(store.pragma('journal_mode'), 'wal');
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
});

test('the busy timeout is set', () => {
  const temp = makeTempStore();
  try {
    const store = openStore(temp.environment);
    try {
      assert.equal(store.pragma('busy_timeout'), BUSY_TIMEOUT_MS);
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
});

test('foreign keys are enforced', () => {
  // Set explicitly so the guarantee does not rest on a dependency's
  // compile-time flag. This test reads the pragma back, so it holds whether
  // or not the driver happens to default it on.
  const temp = makeTempStore();
  try {
    const store = openStore(temp.environment);
    try {
      assert.equal(store.pragma('foreign_keys'), 1);
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
});

test('a foreign key is actually refused, not merely reported as on', () => {
  // The pragma reading 1 is a claim; a refused insert is the behaviour.
  const temp = makeTempStore();
  try {
    const store = openStore(temp.environment);
    try {
      store.db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
      store.db.exec(
        'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))',
      );
      assert.throws(() => {
        store.db.prepare('INSERT INTO child (id, parent_id) VALUES (1, 999)').run();
      }, /FOREIGN KEY/i);
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
});

test('opening a store on a network location refuses before the file is created', () => {
  const location = sharePath('host', 'share', 'broker.db');
  assert.throws(
    () =>
      openStore(
        {
          databasePath: location,
          configuredDatabasePath: location,
          artifactsRoot: location,
          profileRoot: location,
        },
        { checks: { resolveRealPath: (target) => target, hasNetworkShareRoot } },
      ),
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.equal(error.rule, 'store.not_on_network_filesystem');
      return true;
    },
  );
});
