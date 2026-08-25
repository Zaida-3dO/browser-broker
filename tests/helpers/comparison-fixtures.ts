import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import Database from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';

import { ArtifactStore } from '../../src/artifacts/store.ts';
import { type RasterImage, encodePng } from '../../src/diff/image.ts';
import {
  type CaptureRecord,
  type CaptureSource,
  captureSource,
} from '../../src/service/capture-seam.ts';

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
  /** Where the file goes. The same store the comparison writes its crops with. */
  readonly artifacts: ArtifactStore;
}

/**
 * A capture: the row, and the file it names.
 *
 * Both, always. A row whose file is absent is a real situation the artifact
 * surface has a branch for, and it is not the situation a comparison test
 * means to be in — so the helper that makes a capture makes a whole one, and a
 * test wanting the broken case removes the file explicitly and says so.
 */
export function insertCapture(
  db: DatabaseHandle,
  options: InsertCaptureOptions,
): Promise<CaptureRecord> {
  // Returns a promise although nothing here awaits: the real capture pipeline
  // is asynchronous, so every call site reads the way it will when a capture
  // row writes one. A synchronous helper here would be a signature the
  // production path does not have.
  const id = randomUUID();
  const fileName =
    options.fileName ?? `page-view-${String(options.image.width)}-when-${id.slice(0, 8)}.png`;
  const kind = options.kind ?? 'viewport';
  const bytes = encodePng(options.image);

  // Written through the artifact store, exactly as the capture pipeline writes
  // one — so the stored path is produced by the same code that produces it in
  // production rather than assembled here and hoped to match.
  const storedPath = options.artifacts.write(
    options.claimId,
    'images',
    fileName,
    bytes,
  ).relativePath;

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

  return Promise.resolve({
    id,
    claimId: options.claimId,
    path: storedPath,
    kind,
    width: options.image.width,
    height: options.image.height,
  });
}

/**
 * The capture source the comparison tests run against.
 *
 * **A thin alias for the production one**, deliberately. An earlier version of
 * this helper reimplemented the lookup and the file read, which meant every
 * comparison test exercised the helper rather than the code that ships — the
 * hollow-test shape this repository has already been caught by once. Delegating
 * means a break in the real join fails these tests.
 */
export function storeBackedCaptureSource(
  db: DatabaseHandle,
  artifacts: ArtifactStore,
): CaptureSource {
  return captureSource(db, artifacts);
}

/** Does a stored path exist under the artifact root? */
export async function artifactExists(artifacts: ArtifactStore, stored: string): Promise<boolean> {
  try {
    await fs.access(artifacts.resolve(stored));
    return true;
  } catch {
    return false;
  }
}
