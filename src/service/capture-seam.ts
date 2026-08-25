/**
 * The seam between the comparison feature and the capture pipeline.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A SEAM AT ALL, NOW THAT THE CAPTURE PIPELINE EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The capture pipeline is built (`src/capture/pipeline.ts`), so this is no
 * longer standing in for something absent. It stays because **the direction of
 * the dependency is a rule the build enforces**, and an interface is what makes
 * the rule expressible.
 *
 * `capture.no_diff_dependency` (§7.3): "**no capture path reads anything
 * belonging to the diff feature.** This is what keeps the sequencing property
 * real rather than intended: diffing is built last, so a capture that consulted
 * it would make the earlier work depend on the later."
 *
 * That rule points one way, and this interface is the other way stated
 * explicitly: **the diff reads capture, capture never reads the diff.** A
 * capture path can hand a comparison what it needs without knowing a comparison
 * exists, and `scripts/check-capture-isolation.mjs` fails the build if that
 * ever inverts — this module is on its diff-owned list precisely so it does.
 *
 * ── What the comparison needs, and what it deliberately does not take ───
 *
 * Two operations: find a capture, read its bytes. **Not the pipeline itself**,
 * and not its result type. A diff runs against a capture that was taken at some
 * earlier moment, quite possibly by an earlier process — so what it needs is a
 * way to look one up, not a way to take one.
 *
 * ── Why this shape and not a direct query ───────────────────────────────
 *
 * The direction of the dependency is the whole point. §7.3 carries
 * `capture.no_diff_dependency`: "**no capture path reads anything belonging to
 * the diff feature**. This is what keeps the sequencing property real rather
 * than intended: diffing is built last, so a capture that consulted it would
 * make the earlier work depend on the later."
 *
 * That rule points one way, and this interface is what makes the other way
 * explicit: **the diff reads capture, capture never reads the diff.** A capture
 * row can hand this a source and get a diff back without capture knowing what a
 * comparison is.
 */

import fs from 'node:fs/promises';
import type { Database } from 'better-sqlite3';

import type { ArtifactStore } from '../artifacts/store.ts';
import type { CaptureKind } from '../diff/geometry.ts';

/** What the comparison needs to know about a capture. A subset of §1.7. */
export interface CaptureRecord {
  readonly id: string;
  /** Whose lease it belongs to. What §1.9's ownership check is made against. */
  readonly claimId: string;
  /** Relative to the artifact root, never absolute (§1.7a). */
  readonly path: string;
  readonly kind: CaptureKind;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the comparison gets its images.
 *
 * Two operations, deliberately separate. Looking a capture up is a store read
 * and answering "was it found" needs no file at all — which matters because
 * §1.9's missing-target path has to distinguish "no such row" from "the row is
 * there", and reading bytes to find out would be a wasted file read on the
 * ordinary path and a confusing error on the failure one.
 */
export interface CaptureSource {
  /**
   * Find a capture by identifier, or `null` if there is no such row.
   *
   * **`null` rather than a throw**, because "not found" is the ordinary case
   * §1.9 builds its entire failure mode around: "the ordinary reason it does
   * not [find it] is that the caller named the wrong thing". A throw would put
   * the expected case on the exceptional path.
   */
  readonly find: (captureId: string) => CaptureRecord | null;
  /** Read a capture's bytes from disk. */
  readonly readBytes: (capture: CaptureRecord) => Promise<Uint8Array>;
}

/** The columns a capture row carries that a comparison reads. */
interface CaptureColumns {
  readonly id: string;
  readonly claim_id: string;
  readonly path: string;
  readonly kind: CaptureKind;
  readonly width: number;
  readonly height: number;
}

const FIND_CAPTURE = `
SELECT id, claim_id, path, kind, width, height
  FROM captures
 WHERE id = @id
`;

/**
 * The capture source backed by the store the capture pipeline writes to.
 *
 * **This is the join, and it lives here rather than being left to a caller.**
 * The capture pipeline writes a `captures` row and a file through the artifact
 * store; this reads that row back and resolves that file. Both halves use the
 * same two facts — the table and the store — so there is no third place for
 * them to disagree.
 *
 * The bytes are read through {@link ArtifactStore.resolve}, which is the only
 * thing in this build that turns a recorded path into a location, and which
 * refuses a path that escapes the root in **either** namespace. Reading the
 * file directly would have meant a second resolver, and the second one is the
 * one that would be missing a case.
 */
export function captureSource(db: Database, artifacts: ArtifactStore): CaptureSource {
  return {
    find: (captureId) => {
      const row = db.prepare(FIND_CAPTURE).get({ id: captureId }) as CaptureColumns | undefined;
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
    readBytes: async (capture) =>
      new Uint8Array(await fs.readFile(artifacts.resolve(capture.path))),
  };
}
