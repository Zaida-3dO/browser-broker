import fs from 'node:fs/promises';
import type { Database } from 'better-sqlite3';

import { resolveArtifact } from '../diff/artifact-path.ts';
import { findComparison } from './comparison-store.ts';

/**
 * Delivering the images — one endpoint, one return shape (`MILESTONES.md` #49,
 * `SCHEMA.md` §1.9).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ONE RETURN SHAPE, AND THE OPTION THAT WAS REJECTED
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §1.9: "**An image request always returns an image, the same way, every
 * time.** Whether the bytes are a full capture or a crop from a diff depends on
 * nothing except whether the caller passed a diff target. One endpoint, one
 * shape, no branching."
 *
 * That is enforced here structurally: `fetchArtifact` has **one** success
 * shape, `ArtifactBytes`, and it is the same object whether the bytes came from
 * a capture row or a crop path inside a comparison row. Nothing about the
 * response varies with what was asked for.
 *
 * **The rejected option, and the reasoning that binds this file** (§1.9 and
 * #49's own note): the tempting answer was to return small crops inline and
 * paths for large ones, on the reasoning that a crop is the size of the thing
 * that changed and is therefore cheap.
 *
 * > **The flaw is specific: you cannot know a diff is small.** A change to a
 * > component that appears on every page changes every page — a header, a font,
 * > a spacing token, a colour — and the diff that follows is not a small crop
 * > but a dozen of them, collectively as expensive as the screenshot the design
 * > spends most of its effort avoiding. A rule whose cost is bounded only when
 * > the change happens to be local is not a bounded rule; it is an unbounded
 * > one that behaves well in testing.
 *
 * So there is **no size cap in this file and no inline branch**, and adding one
 * would be reintroducing the rejected design rather than optimising this one.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IT NEVER ACCEPTS A PATH — WHICH IS THE MECHANISM, NOT A CHECK
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §7.3 `artifact.no_request_path`: "**No path that serves bytes accepts a
 * filesystem path from a caller.** It resolves a recorded path under the
 * artifact root or it serves nothing, so traversal has no input to arrive
 * through."
 *
 * Read the argument shapes below: every one of them is a **row identifier**,
 * and the path is looked up. There is no argument of type "path" anywhere on
 * this surface, which is why there is no traversal defence in it — the
 * defence is that there is nothing to traverse *with*. §1.9: "the only strings
 * it can be asked for are identifiers of rows, and the path is looked up rather
 * than supplied."
 *
 * `scripts/check-artifact-path.mjs` is what keeps that true as a build rule
 * rather than as an intention, and it ships with a seeded violation proving it
 * fires.
 */

/** The one success shape. Identical for a capture and for a crop. */
export interface ArtifactBytes {
  readonly bytes: Uint8Array;
  /** The stored path this came from, relative to the root. For the caller's log. */
  readonly path: string;
}

/**
 * Which artifact is wanted. **Every variant names a row, never a path.**
 *
 * A discriminated union rather than three functions, so the ownership check
 * below happens in one place. Three entry points would be three places for
 * somebody to add a fourth that forgot it.
 */
export type ArtifactRequest =
  | { readonly kind: 'capture'; readonly captureId: string }
  | { readonly kind: 'overlay'; readonly comparisonId: string }
  | {
      readonly kind: 'region';
      readonly comparisonId: string;
      /** Which region in the ordered list. */
      readonly index: number;
      readonly side: 'before' | 'after';
    };

/** Why an artifact was not served. */
export type ArtifactRefusalReason = 'not_found' | 'unreadable';

export interface ArtifactRefusal {
  readonly reason: ArtifactRefusalReason;
  readonly message: string;
}

export type ArtifactOutcome =
  | { readonly served: true; readonly artifact: ArtifactBytes }
  | { readonly served: false; readonly refusal: ArtifactRefusal };

/**
 * The one sentence a caller gets for anything it is not entitled to see.
 *
 * §1.9: artifacts belonging to another lease are refused "with the same
 * non-disclosing wording as an unknown tab (§7.1) **so probing cannot discover
 * another lease's files**". §7.1 makes the same collapse for `tab.owned` and
 * `tab.open` — two rules, one message — and the reason transfers exactly: a
 * caller able to tell "not yours" from "does not exist" is a caller able to
 * enumerate what exists.
 *
 * **So this string is used for both, and that is load-bearing rather than
 * lazy.** A test asserts the two are byte-identical.
 */
export const ARTIFACT_NOT_FOUND_MESSAGE = 'No artifact with that identifier belongs to this lease.';

/** How a capture row is looked up. The capture pipeline owns the table. */
export interface CaptureLookup {
  readonly find: (captureId: string) => { readonly claimId: string; readonly path: string } | null;
}

export interface FetchArtifactOptions {
  readonly db: Database;
  readonly artifactsRoot: string;
  /** The lease asking. Everything is checked against this. */
  readonly claimId: string;
  readonly captures: CaptureLookup;
  readonly request: ArtifactRequest;
}

function notFound(): ArtifactOutcome {
  return { served: false, refusal: { reason: 'not_found', message: ARTIFACT_NOT_FOUND_MESSAGE } };
}

/**
 * Resolve a request to the stored path it names, checking ownership.
 *
 * Split out from the read so the ownership check is a single expression per
 * variant and visibly precedes every filesystem call — the `browser_read`
 * shape §7.1 calls "the rejection asserts the physical side-effect": a path
 * that is never resolved cannot be read by accident further down.
 */
function resolveRequest(options: FetchArtifactOptions): string | null {
  const { db, claimId, request } = options;

  if (request.kind === 'capture') {
    const capture = options.captures.find(request.captureId);
    if (capture === null || capture.claimId !== claimId) {
      return null;
    }
    return capture.path;
  }

  const comparison = findComparison(db, request.comparisonId);
  if (comparison === null || comparison.claimId !== claimId) {
    return null;
  }

  if (request.kind === 'overlay') {
    return comparison.overlayPath;
  }

  const region = comparison.regions[request.index];
  if (region === undefined) {
    return null;
  }
  return request.side === 'before' ? region.beforePath : region.afterPath;
}

/**
 * Serve one artifact's bytes.
 *
 * Returns an outcome rather than throwing, because "you named something that
 * is not yours or is not there" is an ordinary answer on this surface and a
 * caller has to be able to branch on it without catching.
 */
export async function fetchArtifact(options: FetchArtifactOptions): Promise<ArtifactOutcome> {
  const stored = resolveRequest(options);
  if (stored === null) {
    return notFound();
  }

  // The one join of a stored path to the root in this file, and it goes
  // through the single resolver so the containment assertion cannot be
  // skipped. A throw from here is a constructed path that is wrong — our bug,
  // not a caller's — and it is deliberately not caught.
  const absolute = resolveArtifact(options.artifactsRoot, stored);

  try {
    const bytes = await fs.readFile(absolute);
    return { served: true, artifact: { bytes: new Uint8Array(bytes), path: stored } };
  } catch {
    // A row exists and its file does not. §6.2 says nothing sweeps an image,
    // so this is a tree somebody deleted by hand rather than an expiry — and
    // it is worth a different sentence from "not found", because the caller
    // named something real and there is nothing it can do differently.
    return {
      served: false,
      refusal: {
        reason: 'unreadable',
        message: `The artifact at ${stored} is recorded but could not be read from the artifact root.`,
      },
    };
  }
}
