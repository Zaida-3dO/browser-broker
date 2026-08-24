import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { StartupRefusal } from '../../src/errors.ts';
import { BUSY_TIMEOUT_MS, openStore, prepareStore } from '../../src/store/open.ts';
import { EXPECTED_VERSION } from '../../src/store/schema/steps.ts';
import { readStoreVersion } from '../../src/store/schema/step.ts';
import { makeTempStore } from '../helpers/temp-store.ts';
import { checksReporting, sharePath } from '../helpers/paths.ts';

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
        { checks: checksReporting({}) },
      ),
    (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.equal(error.rule, 'store.not_on_network_filesystem');
      return true;
    },
  );
});

/**
 * ── Every spawn opens, steps, and is ready ───────────────────────────────
 */

test('preparing the store steps it to the version this build expects', async () => {
  const temp = makeTempStore();
  try {
    const store = await prepareStore(temp.environment);
    try {
      assert.equal(readStoreVersion(store.db), EXPECTED_VERSION);
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
});

test('a second spawn against the same file steps nothing and finds the schema', async () => {
  // A store already at the right version is left untouched, which is what
  // makes running this on every spawn cost a version read.
  const temp = makeTempStore();
  try {
    const first = await prepareStore(temp.environment);
    first.db.prepare("UPDATE browsers SET restart_count = 7 WHERE id = 'regular'").run();
    first.close();

    const second = await prepareStore(temp.environment);
    try {
      assert.equal(readStoreVersion(second.db), EXPECTED_VERSION);
      const row = second.db
        .prepare("SELECT restart_count FROM browsers WHERE id = 'regular'")
        .get() as { restart_count: number };
      // Untouched: a step that re-ran would have recreated the table.
      assert.equal(row.restart_count, 7);
    } finally {
      second.close();
    }
  } finally {
    temp.remove();
  }
});

test('a store newer than the build refuses the spawn and holds no handle open', async () => {
  const temp = makeTempStore();
  try {
    const seed = openStore(temp.environment);
    seed.db.pragma('user_version = 99');
    seed.close();

    await assert.rejects(prepareStore(temp.environment), (error: unknown) => {
      assert.ok(error instanceof StartupRefusal);
      assert.equal(error.rule, 'startup.schema_stepped');
      return true;
    });
  } finally {
    temp.remove();
  }
});
