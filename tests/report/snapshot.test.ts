import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

// `UNREACHABLE` is deliberately NOT imported here — see the note in
// `document.test.ts`: the guard must not be written in terms of the thing it
// guards.
import type { AddressSource } from '../../src/operations/addresses.ts';
import { writeSnapshot } from '../../src/report/snapshot.ts';
import { seedClaim, seedTab } from '../helpers/seed.ts';
import { makeTempStore, withSteppedStore } from '../helpers/temp-store.ts';

/**
 * `broker snapshot` (`SCHEMA.md` §4.5, §5.5).
 *
 * **One command, one file.** It writes the document wherever it is told,
 * reports the path, and exits — it leaves nothing behind and holds nothing
 * open.
 */
describe('generating the snapshot', () => {
  const now = '2026-03-01T12:00:00.000Z';
  const soon = '2026-03-01T12:05:00.000Z';

  it('writes one self-contained file and reports where', async () => {
    await withSteppedStore(async (store) => {
      const temp = makeTempStore();
      try {
        const target = path.join(temp.directory, 'out', 'snapshot.html');

        const result = await writeSnapshot(store.db, { outputPath: target, now });

        assert.equal(fs.existsSync(target), true);
        assert.equal(result.path, path.resolve(target));
        assert.equal(result.at, now);

        const html = fs.readFileSync(target, 'utf8');
        assert.ok(html.startsWith('<!doctype html>'));
        assert.equal(result.bytes, Buffer.byteLength(html, 'utf8'));
      } finally {
        temp.remove();
      }
    });
  });

  it('writes nothing to the store', async () => {
    // Generating a report must not expire anybody's lease as a side effect,
    // and it must not record that it ran. Asserted through a **second,
    // read-only connection**, which cannot see anything this run did not
    // commit — reading back through the store's own handle would see
    // uncommitted writes and could report a change as absent.
    const temp = makeTempStore();
    try {
      const { prepareStore } = await import('../../src/store/open.ts');
      const store = await prepareStore(temp.environment);
      // A lapsed lease: the exact row a sweep would rewrite. If generating a
      // document swept, this row's state would change.
      const claimId = seedClaim(store.db, {
        state: 'active',
        expiresAt: '2026-03-01T11:00:00.000Z',
      });

      await writeSnapshot(store.db, {
        outputPath: path.join(temp.directory, 'snapshot.html'),
        now,
      });
      store.close();

      const readOnly = new Database(temp.environment.databasePath, { readonly: true });
      const claim = readOnly.prepare('SELECT state FROM claims WHERE id = ?').get(claimId) as {
        state: string;
      };
      const events = readOnly.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
      readOnly.close();

      // Still says `active` in the row — the document derived it as expired
      // without rewriting anything. That is the whole distinction between the
      // reader's derivation and the service's sweep.
      assert.equal(claim.state, 'active');
      assert.equal(events.n, 0);
    } finally {
      temp.remove();
    }
  });

  it('produces a document even with no browser connection at all', async () => {
    // §4.2a: a generator that produces nothing at all is a worse outcome than
    // an incomplete document.
    await withSteppedStore(async (store) => {
      const temp = makeTempStore();
      try {
        const claimId = seedClaim(store.db, { state: 'active', expiresAt: soon });
        seedTab(store.db, { claimId });
        const target = path.join(temp.directory, 'snapshot.html');

        const result = await writeSnapshot(store.db, { outputPath: target, now });
        const html = fs.readFileSync(target, 'utf8');

        // The rendered cell, not the whole file: the document explains the
        // word in prose too, so matching the file would be satisfied by the
        // explanation even when no cell carries it.
        assert.match(html, /<span class="unreachable"[^>]*>unreachable<\/span>/);
        assert.equal(result.tabsAsked, 0);
        assert.equal(result.tabsUnreachable, 1);
        // The note that says it was one cause rather than fifteen failures.
        assert.match(html, /No browser connection was available/);
      } finally {
        temp.remove();
      }
    });
  });

  it('asks the browsers for the addresses when it can', async () => {
    await withSteppedStore(async (store) => {
      const temp = makeTempStore();
      try {
        const claimId = seedClaim(store.db, { state: 'active', expiresAt: soon });
        const tabId = seedTab(store.db, { claimId });
        const target = path.join(temp.directory, 'snapshot.html');

        const asked: string[] = [];
        const source: AddressSource = {
          addressOf: (tab) => {
            asked.push(tab.driverTabId);
            return Promise.resolve({ url: 'https://example.com/page', title: 'A page' });
          },
        };

        const result = await writeSnapshot(store.db, {
          outputPath: target,
          now,
          addresses: {
            source,
            requests: [
              {
                tabId,
                browser: 'regular',
                handle: { browser: 'regular', driverTabId: `driver-${tabId}` },
              },
            ],
            timeoutMs: 50,
          },
        });

        const html = fs.readFileSync(target, 'utf8');
        assert.ok(html.includes('https://example.com/page'));
        assert.equal(result.tabsAsked, 1);
        assert.equal(result.tabsUnreachable, 0);
        assert.deepEqual(asked, [`driver-${tabId}`]);
      } finally {
        temp.remove();
      }
    });
  });

  it('does not ask about a tab held by a lease that has lapsed', async () => {
    // A read of a page no live lease holds is exactly the browsing-history
    // shape §1.4 deletes the stored column to avoid. Breaks if the request
    // list is used unfiltered.
    await withSteppedStore(async (store) => {
      const temp = makeTempStore();
      try {
        const lapsed = seedClaim(store.db, {
          state: 'active',
          expiresAt: '2026-03-01T11:00:00.000Z',
        });
        const tabId = seedTab(store.db, { claimId: lapsed });

        const asked: string[] = [];
        const source: AddressSource = {
          addressOf: (tab) => {
            asked.push(tab.driverTabId);
            return Promise.resolve({ url: 'https://example.com/private', title: 't' });
          },
        };

        const target = path.join(temp.directory, 'snapshot.html');
        await writeSnapshot(store.db, {
          outputPath: target,
          now,
          addresses: {
            source,
            requests: [
              {
                tabId,
                browser: 'regular',
                handle: { browser: 'regular', driverTabId: `driver-${tabId}` },
              },
            ],
            timeoutMs: 50,
          },
        });

        assert.deepEqual(asked, [], 'a lapsed lease’s tab was asked for its address');
        const html = fs.readFileSync(target, 'utf8');
        assert.ok(!html.includes('https://example.com/private'));
      } finally {
        temp.remove();
      }
    });
  });

  it('still writes a document when every browser hangs', async () => {
    // The timeout doing its job end to end. Breaks if the bound is dropped —
    // this test would hang rather than fail, which is itself the signal.
    await withSteppedStore(async (store) => {
      const temp = makeTempStore();
      try {
        const claimId = seedClaim(store.db, { state: 'active', expiresAt: soon });
        const tabId = seedTab(store.db, { claimId });
        const target = path.join(temp.directory, 'snapshot.html');

        const result = await writeSnapshot(store.db, {
          outputPath: target,
          now,
          addresses: {
            source: { addressOf: () => new Promise(() => {}) },
            requests: [
              { tabId, browser: 'regular', handle: { browser: 'regular', driverTabId: 'd' } },
            ],
            timeoutMs: 5,
          },
        });

        const html = fs.readFileSync(target, 'utf8');
        // The rendered cell, not the whole file: the document explains the
        // word in prose too, so matching the file would be satisfied by the
        // explanation even when no cell carries it.
        assert.match(html, /<span class="unreachable"[^>]*>unreachable<\/span>/);
        assert.equal(result.tabsUnreachable, 1);
      } finally {
        temp.remove();
      }
    });
  });

  it('creates the directory it was pointed at', async () => {
    await withSteppedStore(async (store) => {
      const temp = makeTempStore();
      try {
        const target = path.join(temp.directory, 'a', 'b', 'c', 'snapshot.html');
        await writeSnapshot(store.db, { outputPath: target, now });
        assert.equal(fs.existsSync(target), true);
      } finally {
        temp.remove();
      }
    });
  });
});
