import fs from 'node:fs/promises';
import type { Database } from 'better-sqlite3';

import type { ArtifactStore } from '../artifacts/store.ts';
import { fetchArtifact, type ArtifactRequest, type CaptureLookup } from '../service/artifacts.ts';
import { hashKey } from '../service/keys.ts';

/**
 * `broker image` — delivering the bytes (`MILESTONES.md` #49, `SCHEMA.md` §1.9).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ONE ENDPOINT, ONE RETURN SHAPE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §1.9: "**An image request always returns an image, the same way, every
 * time.** Whether the bytes are a full capture or a crop from a diff depends on
 * nothing except whether the caller passed a diff target. One endpoint, one
 * shape, no branching."
 *
 * That is why there is one command with one output shape rather than a command
 * per kind of image. What varies between `--capture`, `--overlay` and
 * `--region` is **which row is named**, and nothing else: the same bytes are
 * written the same way to the same place, and the same line is printed about
 * them. A caller that changes which flag it passes changes what it gets a
 * picture *of*, never how the picture arrives.
 *
 * **The inline-crop option is rejected and this command must not reintroduce
 * it** (§1.9, and #49's own note). The tempting answer was to return small
 * crops inline and paths for large ones, on the reasoning that a crop is the
 * size of the thing that changed and is therefore cheap.
 *
 * > **The flaw is specific: you cannot know a diff is small.** A change to a
 * > component that appears on every page changes every page — a header, a font,
 * > a spacing token, a colour — and the diff that follows is not a small crop
 * > but a dozen of them, collectively as expensive as the screenshot the design
 * > spends most of its effort avoiding.
 *
 * So there is **no size threshold anywhere in this file**, and no branch that
 * inspects how big the bytes turned out to be. Adding one would be
 * reintroducing the rejected design rather than optimising this one.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A COMMAND AND NOT AN ELEVENTH TOOL
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §3.1 fixes the agent-facing surface at **ten tools**, and opens by saying why:
 * "every description sits in a connected session's context on every turn
 * whether or not anything calls it, so surface area is a standing tax and the
 * list is short on purpose". None of the ten is an image-bytes tool, and that
 * is consistent rather than an omission — `browser_capture` and `browser_read`
 * both return **paths** precisely so that a caller "pay[s] for the part you
 * open rather than for all of it".
 *
 * An agent that wants the picture already has the path. What has been missing
 * is a way to get the **bytes** for a recorded row without handing anybody a
 * filesystem path to read, which is what §7.3 forbids. That is a person's
 * command, so it sits beside `diffs`, `events` and `snapshot` on the standalone
 * surface: it takes no tab budget, drives no browser and decides nothing.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IT NAMES ROWS, NEVER PATHS — AND THAT IS THE MECHANISM
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §7.3 `artifact.no_request_path`: "**No path that serves bytes accepts a
 * filesystem path from a caller.** It resolves a recorded path under the
 * artifact root or it serves nothing, so traversal has no input to arrive
 * through."
 *
 * Every flag below that selects an artifact is an **identifier of a row**. The
 * path is looked up, never supplied, and the one join of a stored path to a
 * location happens inside `service/artifacts.ts` through the artifact store's
 * own resolver. There is no traversal defence in this file because there is
 * nothing to traverse *with*.
 *
 * **`--out` is the one path on this command, and it is an output.** It is where
 * the bytes are written, not where they are read from, so it cannot select
 * which artifact is served and cannot reach one the lease does not own. The
 * distinction is the whole of §7.3: the rule is about the *input* that chooses
 * a file, and this is a destination the caller already controls by virtue of
 * running the command at all.
 *
 * ── Only this lease's artifacts ─────────────────────────────────────────
 *
 * §1.9: it "serves only artifacts belonging to the asking lease, checked the
 * same way every other tab-addressed operation is checked, and refusing with
 * the same non-disclosing wording as an unknown tab (§7.1) **so probing cannot
 * discover another lease's files**".
 *
 * The lease is identified the same way every keyed call identifies one — the
 * key is hashed and the claim is looked up by the hash, so the key itself is
 * never compared, logged or printed (§5.6). The ownership check itself lives in
 * `service/artifacts.ts` rather than here, which is what stops this command
 * being a second place the rule could be spelled differently.
 */

/** Where output goes, injected so a test reads it instead of the terminal. */
export interface ImageStreams {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const IMAGE_USAGE = [
  'broker image — write the bytes of one recorded image to a file.',
  '',
  'Usage:',
  '  broker image --lease-key <key> --capture <id> --out <file>',
  '  broker image --lease-key <key> --overlay <comparison-id> --out <file>',
  '  broker image --lease-key <key> --region <comparison-id> --index <n> --side before|after --out <file>',
  '',
  'Exactly one artifact is named, always by the identifier of a row:',
  '  --capture <id>     a capture, by its own identifier',
  '  --overlay <id>     a comparison’s full-frame image with the changed regions outlined',
  '  --region <id>      one changed region from a comparison, cut from either side',
  '  --index <n>        which region, from the ordered list; defaults to 0, the largest',
  '  --side before|after  which capture the crop comes from; defaults to after',
  '',
  '  --out <file>       where to write the bytes. Required.',
  '  --json             one JSON document, for something reading rather than someone',
  '',
  'Whether the bytes are a whole capture or a crop, they arrive the same way.',
].join('\n');

/**
 * What the arguments parsed to, or the complaint about why they did not.
 *
 * A result rather than a throw, so the caller decides the exit code and the
 * parse stays testable without catching.
 */
export type ParsedImageArguments =
  | {
      readonly ok: true;
      readonly leaseKey: string;
      readonly request: ArtifactRequest;
      readonly out: string;
      readonly json: boolean;
    }
  | { readonly ok: false; readonly message: string };

/** The three ways to name an artifact, and the request each builds. */
const SELECTORS = ['--capture', '--overlay', '--region'] as const;

function needsValue(flag: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message: `${flag} needs an identifier after it.` };
}

/**
 * Parse the arguments after `image`.
 *
 * **An unrecognised flag refuses rather than being ignored**, matching `diffs`:
 * ignoring one would serve an artifact nobody asked for and print a result that
 * looks like an answer.
 *
 * **Exactly one selector is required.** Two would make the command choose, and
 * a command that silently prefers one flag over another when given both is one
 * whose behaviour has to be learned rather than read.
 */
export function parseImageArguments(argv: readonly string[]): ParsedImageArguments {
  let leaseKey: string | undefined;
  let out: string | undefined;
  let json = false;
  let index: number | undefined;
  let side: 'before' | 'after' | undefined;
  const selected: { flag: string; id: string }[] = [];

  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at] ?? '';

    if (argument === '--json') {
      json = true;
      continue;
    }

    if (argument === '--lease-key' || argument === '--out') {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith('--')) {
        return {
          ok: false,
          message:
            argument === '--out'
              ? '--out needs a file to write to.'
              : '--lease-key needs your lease key after it.',
        };
      }
      if (argument === '--out') {
        out = value;
      } else {
        leaseKey = value;
      }
      at += 1;
      continue;
    }

    if (argument === '--index') {
      const raw = argv[at + 1];
      if (raw === undefined) {
        return { ok: false, message: '--index needs a number after it.' };
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        return {
          ok: false,
          message: `--index takes a whole number of at least zero; got ${JSON.stringify(raw)}.`,
        };
      }
      index = value;
      at += 1;
      continue;
    }

    if (argument === '--side') {
      const raw = argv[at + 1];
      if (raw !== 'before' && raw !== 'after') {
        return {
          ok: false,
          message: `--side takes "before" or "after"; got ${JSON.stringify(raw ?? '')}. A crop is cut from one capture or the other.`,
        };
      }
      side = raw;
      at += 1;
      continue;
    }

    const selector = SELECTORS.find((each) => each === argument);
    if (selector !== undefined) {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith('--')) {
        return needsValue(selector);
      }
      selected.push({ flag: selector, id: value });
      at += 1;
      continue;
    }

    return {
      ok: false,
      message: `Unrecognised option: ${argument}`,
    };
  }

  if (leaseKey === undefined) {
    return {
      ok: false,
      message:
        '--lease-key is required. An image belongs to the lease that took it, so there is no way to ask for one without saying which lease is asking.',
    };
  }

  if (selected.length === 0) {
    return {
      ok: false,
      message: `Name one artifact: ${SELECTORS.join(', ')}. Each takes the identifier of a row.`,
    };
  }

  if (selected.length > 1) {
    return {
      ok: false,
      message: `Name exactly one artifact; got ${selected.map((each) => each.flag).join(' and ')}.`,
    };
  }

  if (out === undefined) {
    return {
      ok: false,
      message:
        '--out is required: this command writes the bytes to a file rather than to the terminal, because an image on a terminal is not an image.',
    };
  }

  const chosen = selected[0] as { flag: string; id: string };

  // `--index` and `--side` describe a region and mean nothing otherwise.
  // Refused rather than ignored, for the same reason an unrecognised flag is:
  // a caller who passed them expects them to have done something.
  if (chosen.flag !== '--region' && (index !== undefined || side !== undefined)) {
    return {
      ok: false,
      message: `--index and --side describe which region to cut, so they only apply to --region; got ${chosen.flag}.`,
    };
  }

  if (chosen.flag === '--capture') {
    return { ok: true, leaseKey, request: { kind: 'capture', captureId: chosen.id }, out, json };
  }

  if (chosen.flag === '--overlay') {
    return {
      ok: true,
      leaseKey,
      request: { kind: 'overlay', comparisonId: chosen.id },
      out,
      json,
    };
  }

  return {
    ok: true,
    leaseKey,
    request: {
      kind: 'region',
      comparisonId: chosen.id,
      // The list is ordered largest first (§1.9), so the first region is the
      // one a person almost always wants and is the only defensible default.
      index: index ?? 0,
      side: side ?? 'after',
    },
    out,
    json,
  };
}

/** How a capture row is found. The captures table is the pipeline's. */
export function captureLookup(db: Database): CaptureLookup {
  return {
    find: (captureId: string) => {
      const row = db
        .prepare('SELECT claim_id AS claimId, path FROM captures WHERE id = ?')
        .get(captureId) as { claimId: string; path: string } | undefined;
      return row === undefined ? null : { claimId: row.claimId, path: row.path };
    },
  };
}

/** Exit codes, matching the dispatcher's own (`cli/index.ts`). */
export const IMAGE_EXIT = { served: 0, malformed: 2, refused: 3 } as const;

export interface ImageOptions {
  readonly db: Database;
  readonly artifacts: ArtifactStore;
  readonly streams: ImageStreams;
  /** How the bytes reach the file, injected so a test does not need a disk. */
  readonly write?: (destination: string, bytes: Uint8Array) => Promise<void>;
}

/**
 * Run the command.
 *
 * **The lease is resolved by hashing the key**, exactly as every keyed call
 * does. A claim that cannot be found refuses with the *same* sentence as an
 * artifact that is not yours, and that is deliberate rather than lazy: §1.9
 * requires the non-disclosing wording "so probing cannot discover another
 * lease's files", and a distinguishable "no such lease" would let a caller
 * with a wrong key learn which identifiers exist.
 *
 * **This does not extend the lease**, and the difference from the ten
 * operations is the point. §3.1: "every tool except the first takes the lease
 * key, and every call carrying the key extends the lease" — that rule is about
 * the *agent* surface, where a call is evidence the caller is still working.
 * This is a person reading a file that has already been written; a lease is not
 * kept alive by somebody looking at a picture it took.
 */
export async function runImage(argv: readonly string[], options: ImageOptions): Promise<number> {
  const { db, streams } = options;
  const parsed = parseImageArguments(argv);

  if (!parsed.ok) {
    streams.err(parsed.message);
    streams.err('');
    streams.err(IMAGE_USAGE);
    return IMAGE_EXIT.malformed;
  }

  // Looked up by hash. The key itself is never compared or printed (§5.6).
  const claim = db
    .prepare('SELECT id FROM claims WHERE key_hash = ?')
    .get(hashKey(parsed.leaseKey)) as { id: string } | undefined;

  const outcome =
    claim === undefined
      ? null
      : await fetchArtifact({
          db,
          artifacts: options.artifacts,
          claimId: claim.id,
          captures: captureLookup(db),
          request: parsed.request,
        });

  if (outcome === null || !outcome.served) {
    // One sentence for "not yours" and for "not there", and for a key that
    // names no lease. Three distinguishable answers here would be three ways
    // to enumerate what exists.
    const refusal =
      outcome === null
        ? { reason: 'not_found' as const, message: NOT_FOUND_MESSAGE }
        : outcome.refusal;

    if (parsed.json) {
      streams.out(
        JSON.stringify({ outcome: 'refused', reason: refusal.reason, message: refusal.message }),
      );
    } else {
      streams.err(`refused (artifact.${refusal.reason}): ${refusal.message}`);
    }
    return IMAGE_EXIT.refused;
  }

  const write = options.write ?? ((destination, bytes) => fs.writeFile(destination, bytes));
  await write(parsed.out, outcome.artifact.bytes);

  // **The identical report for every kind.** A capture and a crop differ in
  // what they are a picture of and in nothing else a caller can observe here.
  if (parsed.json) {
    streams.out(
      JSON.stringify({
        outcome: 'served',
        value: {
          // The stored path, which is relative to the artifact root and is
          // therefore safe to report: §1.7a's rule is that no absolute path is
          // reported, because an absolute path names one machine.
          path: outcome.artifact.path,
          bytes: outcome.artifact.bytes.byteLength,
          writtenTo: parsed.out,
        },
      }),
    );
  } else {
    streams.out(
      `Wrote ${String(outcome.artifact.bytes.byteLength)} bytes to ${parsed.out} (from ${outcome.artifact.path}).`,
    );
  }

  return IMAGE_EXIT.served;
}

/**
 * The sentence used when the key names no lease.
 *
 * Imported rather than respelled would be better, but the artifacts module's
 * constant is about an artifact and this is about a key that matched nothing —
 * two different situations that must produce **one indistinguishable answer**.
 * A test asserts the two strings are byte-identical, so the requirement is
 * checked rather than trusted to whoever edits one of them next.
 */
export const NOT_FOUND_MESSAGE = 'No artifact with that identifier belongs to this lease.';
