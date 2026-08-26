import crypto from 'node:crypto';

import type { Database } from 'better-sqlite3';

/**
 * Seeding rows a reader is supposed to derive over.
 *
 * These write raw rows rather than going through a service operation, which
 * would be the wrong tool for a reader's test even if the service layer were
 * available: the whole point of the expiry derivation (`SCHEMA.md` §2.4) is
 * that a reader meets rows the sweep **has not** reconciled, and every path
 * that could produce one through the service reconciles it on the way.
 *
 * So a lapsed-but-unswept lease is only constructible by writing one, and a
 * test that could not construct one could not test the rule.
 */

/** A timestamp in the store's own textual form, offset from a base. */
export function at(base: Date, offsetSeconds: number): string {
  return new Date(base.getTime() + offsetSeconds * 1000).toISOString().replace(/Z$/, 'Z');
}

export interface SeedClaimOptions {
  readonly id?: string;
  readonly sessionId?: string;
  readonly browserId?: 'regular' | 'private';
  readonly state: 'queued' | 'active' | 'released' | 'expired' | 'revoked';
  readonly purpose?: string;
  readonly expiresAt: string;
  readonly createdAt?: string;
  readonly activatedAt?: string | null;
  readonly renewCount?: number;
  readonly endedAt?: string | null;
  readonly revokeReason?: string | null;
  readonly ttlSeconds?: number;
}

/** Write one claim row exactly as given, bypassing every service rule. */
export function seedClaim(db: Database, options: SeedClaimOptions): string {
  const id = options.id ?? crypto.randomUUID();
  const state = options.state;
  const final = state === 'released' || state === 'expired' || state === 'revoked';

  db.prepare(
    `INSERT INTO claims
       (id, key_hash, session_id, browser_id, state, purpose, expires_at, ttl_seconds,
        activated_at, renew_count, ended_at, revoke_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    crypto.createHash('sha256').update(id).digest('hex'),
    options.sessionId ?? 'session-a',
    options.browserId ?? 'regular',
    state,
    options.purpose ?? 'a seeded lease for a reader test',
    options.expiresAt,
    options.ttlSeconds ?? 600,
    // The schema refuses a queued lease that has been activated.
    state === 'queued' ? null : (options.activatedAt ?? options.createdAt ?? options.expiresAt),
    options.renewCount ?? 0,
    final ? (options.endedAt ?? options.expiresAt) : null,
    state === 'revoked' ? (options.revokeReason ?? 'a seeded revocation') : null,
    options.createdAt ?? options.expiresAt,
    options.createdAt ?? options.expiresAt,
  );

  return id;
}

export interface SeedTabOptions {
  readonly id?: string;
  readonly claimId: string;
  readonly browserId?: 'regular' | 'private';
  readonly state?: 'opening' | 'open' | 'closing' | 'closed' | 'failed';
  readonly driverTabId?: string;
  readonly closeFailed?: boolean;
  readonly closeAttempts?: number;
}

export function seedTab(db: Database, options: SeedTabOptions): string {
  const id = options.id ?? crypto.randomUUID();
  const state = options.state ?? 'open';
  db.prepare(
    `INSERT INTO tabs
       (id, claim_id, browser_id, driver_tab_id, state, opened_at, close_failed, close_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    options.claimId,
    options.browserId ?? 'regular',
    // The schema constrains: exactly the `opening` rows carry no driver name.
    state === 'opening' ? null : (options.driverTabId ?? `driver-${id}`),
    state,
    '2026-01-01T00:00:00.000Z',
    options.closeFailed === true ? 1 : 0,
    options.closeAttempts ?? 0,
  );
  return id;
}

export interface SeedEventOptions {
  readonly kind: string;
  readonly outcome?: 'allow' | 'deny';
  readonly guard?: string | null;
  readonly adapter?: 'tool-stdio' | 'tool-http' | 'cli' | 'internal';
  readonly sessionId?: string | null;
  readonly claimId?: string | null;
  readonly at?: string;
}

export function seedEvent(db: Database, options: SeedEventOptions): number {
  const outcome = options.outcome ?? 'allow';
  const result = db
    .prepare(
      `INSERT INTO events (kind, outcome, guard, adapter, session_id, claim_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.kind,
      outcome,
      // The schema constrains the pair: a guard belongs on a denial and
      // means nothing on an allow.
      outcome === 'deny' ? (options.guard ?? 'some.rule') : null,
      options.adapter ?? 'cli',
      options.sessionId ?? null,
      options.claimId ?? null,
      options.at ?? '2026-01-01T00:00:00.000Z',
    );
  return Number(result.lastInsertRowid);
}

export function seedFeedback(
  db: Database,
  options: {
    readonly rating: number;
    readonly category: string;
    readonly note: string;
    readonly sessionId?: string | null;
    readonly at?: string;
  },
): void {
  db.prepare(
    `INSERT INTO feedback (rating, category, note, session_id, at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    options.rating,
    options.category,
    options.note,
    options.sessionId ?? null,
    options.at ?? '2026-01-01T00:00:00.000Z',
  );
}

export interface SeedCaptureOptions {
  readonly id?: string;
  readonly claimId: string;
  readonly tabId: string;
  readonly takenAt?: string;
  readonly kind?: 'viewport' | 'element' | 'full_page';
  readonly tier?: 'default' | 'detail' | 'max';
  readonly reason?: string | null;
  readonly width: number;
  readonly height: number;
  /** Defaults to the written dimensions, which is the not-downscaled case. */
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly bytes?: number;
  readonly warned?: boolean;
  readonly url?: string | null;
}

/**
 * Write one capture row exactly as given, with no file behind it.
 *
 * Deliberately row-only, unlike `comparison-fixtures.ts`'s `insertCapture`,
 * which writes a real PNG through the artifact store because a comparison
 * reads the bytes. **A rollup never opens a file** — it adds up columns — so
 * encoding an image per row would make these tests slower and would tie a
 * count to an image codec that has nothing to do with what is being counted.
 *
 * It also takes the tier, the kind, the moment and the source dimensions,
 * which that helper fixes: a rollup test whose rows are all `default`
 * viewports at one instant cannot tell a working grouping from a broken one.
 */
export function seedCapture(db: Database, options: SeedCaptureOptions): string {
  const id = options.id ?? crypto.randomUUID();
  const kind = options.kind ?? 'viewport';
  const tier = options.tier ?? 'default';

  db.prepare(
    `INSERT INTO captures
       (id, claim_id, tab_id, taken_at, kind, tier, reason, source_width, source_height,
        width, height, bytes, path, selector, viewport_width, url, warned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    options.claimId,
    options.tabId,
    options.takenAt ?? '2026-01-01T00:00:00.000Z',
    kind,
    tier,
    // The schema owes a written reason on the top rung and nowhere else.
    tier === 'max' ? (options.reason ?? 'a seeded escalation') : (options.reason ?? null),
    options.sourceWidth ?? options.width,
    options.sourceHeight ?? options.height,
    options.width,
    options.height,
    options.bytes ?? 1000,
    `claims/${options.claimId}/images/${id}.png`,
    // The schema constrains: exactly the element captures name an element.
    kind === 'element' ? '#seeded' : null,
    options.width,
    options.url === undefined ? 'https://example.com/a-page' : options.url,
    options.warned === true ? 1 : 0,
  );

  return id;
}

export interface SeedComparisonOptions {
  readonly id?: string;
  readonly sourceCaptureId: string;
  readonly targetCaptureId: string;
  readonly claimId: string;
  readonly at?: string;
  readonly colourTolerance?: number;
  readonly minimumRegionArea?: number;
  readonly maximumRegions?: number;
  readonly changed?: boolean;
  readonly truncated?: boolean;
}

/** Write one comparison row exactly as given, with no overlay behind it. */
export function seedComparison(db: Database, options: SeedComparisonOptions): string {
  const id = options.id ?? crypto.randomUUID();
  const changed = options.changed ?? true;

  db.prepare(
    `INSERT INTO comparisons
       (id, source_capture_id, target_capture_id, claim_id, at, colour_tolerance,
        minimum_region_area, maximum_regions, changed_pixels, changed_ratio, changed,
        regions, overlay_path, truncated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(
    id,
    options.sourceCaptureId,
    options.targetCaptureId,
    options.claimId,
    options.at ?? '2026-01-01T00:00:00.000Z',
    options.colourTolerance ?? 0.1,
    options.minimumRegionArea ?? 16,
    options.maximumRegions ?? 50,
    changed ? 100 : 0,
    changed ? 0.25 : 0,
    changed ? 1 : 0,
    `claims/${options.claimId}/images/${id}-overlay.png`,
    options.truncated === true ? 1 : 0,
  );

  return id;
}
