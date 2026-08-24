import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';

import { resolveArtifact } from '../../src/diff/artifact-path.ts';
import { type RasterImage, encodePng } from '../../src/diff/image.ts';
import type { CaptureRecord, CaptureSource } from '../../src/service/capture-seam.ts';

/**
 * Rows and files a comparison needs, written through the real store.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS WHERE THE STUBBED CAPTURE SEAM IS FILLED IN, AND IT IS DELIBERATE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The capture pipeline (#31) does not exist in this build, so nothing here
 * writes a `captures` row in production. `src/service/capture-seam.ts` records
 * that in full. What these helpers do is write those rows **the way the capture
 * pipeline will**, through the real schema, so the comparison code under test
 * is exercised against genuine foreign keys and genuine check constraints
 * rather than against an object somebody made up.
 *
 * That distinction is what makes these tests worth running: a comparison that
 * only ever saw a hand-built `CaptureRecord` would never discover that its row
 * violates a constraint, and the first thing to discover it would be the
 * capture row landing.
 */

/**
 * A second, read-only handle onto the same database file.
 *
 * **Use this when asserting what committed.** A read through the store's own
 * handle sees the writer's uncommitted work, so an assertion made through it
 * cannot distinguish "written and committed" from "written and about to roll
 * back". This repository has already shipped a test that made exactly that
 * mistake.
 */
export function readOnlyHandle(location: string): DatabaseHandle {
  return new Database(location, { readonly: true });
}

/** A live lease, which everything else hangs off. */
export function insertClaim(db: DatabaseHandle, options: { browserId?: string } = {}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO claims (id, key_hash, session_id, browser_id, state, purpose, expires_at, ttl_seconds, activated_at)
     VALUES (@id, @keyHash, @sessionId, @browserId, 'active', @purpose, @expiresAt, 600, @activatedAt)`,
  ).run({
    id,
    keyHash: randomUUID(),
    sessionId: `session-${id.slice(0, 8)}`,
    browserId: options.browserId ?? 'regular',
    purpose: 'a review of one page at one width',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    activatedAt: new Date().toISOString(),
  });
  return id;
}

/** An open tab on that lease. */
export function insertTab(db: DatabaseHandle, claimId: string, browserId = 'regular'): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tabs (id, claim_id, browser_id, driver_tab_id, state, opened_at)
     VALUES (@id, @claimId, @browserId, @driverTabId, 'open', @openedAt)`,
  ).run({
    id,
    claimId,
    browserId,
    driverTabId: `driver-${id.slice(0, 8)}`,
    openedAt: new Date().toISOString(),
  });
  return id;
}

export interface InsertCaptureOptions {
  readonly claimId: string;
  readonly tabId: string;
  readonly image: RasterImage;
  readonly kind?: CaptureRecord['kind'];
  readonly fileName?: string;
  readonly artifactsRoot: string;
}

/**
 * A capture: the row, and the file it names.
 *
 * Both, always. A row whose file is absent is a real situation the artifact
 * surface has a branch for, and it is not the situation a comparison test
 * means to be in — so the helper that makes a capture makes a whole one, and a
 * test wanting the broken case removes the file explicitly and says so.
 */
export async function insertCapture(
  db: DatabaseHandle,
  options: InsertCaptureOptions,
): Promise<CaptureRecord> {
  const id = randomUUID();
  const fileName =
    options.fileName ?? `page-view-${String(options.image.width)}-when-${id.slice(0, 8)}.png`;
  const storedPath = ['claims', options.claimId, 'images', fileName].join('/');
  const kind = options.kind ?? 'viewport';
  const bytes = encodePng(options.image);

  const absolute = resolveArtifact(options.artifactsRoot, storedPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, bytes);

  db.prepare(
    `INSERT INTO captures (id, claim_id, tab_id, kind, tier, source_width, source_height,
                           width, height, bytes, path, viewport_width, url)
     VALUES (@id, @claimId, @tabId, @kind, 'default', @width, @height,
             @width, @height, @bytes, @path, @viewportWidth, @url)`,
  ).run({
    id,
    claimId: options.claimId,
    tabId: options.tabId,
    kind,
    width: options.image.width,
    height: options.image.height,
    bytes: bytes.byteLength,
    path: storedPath,
    viewportWidth: options.image.width,
    url: 'https://example.com/a-page',
  });

  return {
    id,
    claimId: options.claimId,
    path: storedPath,
    kind,
    width: options.image.width,
    height: options.image.height,
  };
}

/**
 * A capture source backed by the real tables and the real artifact root.
 *
 * **This is the implementation the capture row will replace with its own, and
 * it is deliberately not a fake.** It reads the `captures` table with SQL and
 * the file from disk — exactly what a production implementation does. What
 * makes it a test helper rather than production code is only that the capture
 * pipeline, not this milestone, owns where it lives.
 */
export function storeBackedCaptureSource(db: DatabaseHandle, artifactsRoot: string): CaptureSource {
  return {
    find: (captureId) => {
      const row = db
        .prepare('SELECT id, claim_id, path, kind, width, height FROM captures WHERE id = @id')
        .get({ id: captureId }) as
        | {
            id: string;
            claim_id: string;
            path: string;
            kind: CaptureRecord['kind'];
            width: number;
            height: number;
          }
        | undefined;

      if (row === undefined) {
        return null;
      }
      return {
        id: row.id,
        claimId: row.claim_id,
        path: row.path,
        kind: row.kind,
        width: row.width,
        height: row.height,
      };
    },
    readBytes: async (capture) => {
      const bytes = await fs.readFile(resolveArtifact(artifactsRoot, capture.path));
      return new Uint8Array(bytes);
    },
  };
}

/** Does a stored path exist under the artifact root? */
export async function artifactExists(artifactsRoot: string, stored: string): Promise<boolean> {
  try {
    await fs.access(resolveArtifact(artifactsRoot, stored));
    return true;
  } catch {
    return false;
  }
}
