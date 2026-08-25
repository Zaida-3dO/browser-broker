import type { StorageSeedEntry } from '../browser/driver.ts';
import { BrokerError } from '../errors.ts';

/**
 * `storage_seed` on `browser_claim` (row #65, `SCHEMA.md` §3.2) — the
 * validation, and the shape the driver is handed.
 *
 * ── What this argument is for ───────────────────────────────────────────
 *
 * **Measured: 40 calls across 25 sessions, all one shape** — fetch a token
 * from an interface, write it into storage before the page loads, then
 * navigate. Every one of them reached for an execute-arbitrary-code verb this
 * design does not implement, because *seeding storage before the first load is
 * not something a page can do to itself*: the page that would run the code
 * does not exist until the load that needs the value already in place.
 *
 * That verb was not merely reached for. **Sampled, it was found being used to
 * enumerate other callers' tabs, to read local credential files and to make
 * authenticated outbound requests** (§9.4). This argument covers the narrow,
 * legitimate need in that measurement — a token in storage before first load —
 * and grants none of the rest of that reach, deliberately.
 *
 * ── The safety property is structural, and that is the whole claim ──────
 *
 * **Nothing in this argument is ever passed to an evaluator.** A validated
 * entry is a storage area, an origin, a key and a **string**, and the service
 * hands those to the automation layer's own storage-writing interface, which
 * takes a key and a string. **There is no position in that call in which a
 * caller's bytes could be read as a program** — not because the values are
 * inspected for anything program-shaped, which would be a filter and would
 * eventually be wrong, but because the only sink they reach does not have an
 * interpreting position in it.
 *
 * **What that does and does not amount to, stated honestly.** It means this
 * argument cannot be turned into a channel for running caller-supplied code.
 * It does **not** mean a seeded value is harmless: a token written into an
 * origin's storage is a credential in a browser, and on the signed-in browser
 * that browser is shared (§1.2). What bounds that is the refusal list below
 * and the ledger row, not this paragraph.
 *
 * ── The one thing the type system does not carry ────────────────────────
 *
 * {@link validateStorageSeed} takes `unknown`, because the value arrives from
 * a caller across a surface and a cast at that boundary would make every
 * declaration in this file decorative. Downstream of it the entries are
 * {@link StorageSeedEntry}, and the driver seam declares that type — so the
 * validation is not something a later caller can route around by constructing
 * the object itself.
 */

/**
 * A refusal from this argument.
 *
 * **Deliberately not the service layer's `CallRefusal`**, for the reason
 * `pages.ts` gives at length about its own refusals: that taxonomy is a closed
 * table of codes whose discipline is "add the row with the guard, never
 * before it", and these guards are wired to a surface by the row that owns
 * that table. What is carried now is the part that must not be lost in the
 * meantime — the §7 rule name, which is what the ledger is grepped by and what
 * §8's parity assertion counts over.
 */
export class StorageSeedRefusal extends BrokerError {
  /** §3.14's "any details" — the numbers a caller branches on after the rule. */
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(rule: string, message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(rule, message);
    this.name = 'StorageSeedRefusal';
    this.detail = detail;
  }
}

/**
 * The storage areas on offer.
 *
 * **An allowlist, and cookies are refused by not being on it** — the same
 * shape `pages.ts` uses for navigation schemes and for the same reason: a
 * denylist would permit every area nobody thought of. Both of these are
 * per-origin key-value stores of strings, which is what makes them expressible
 * through an interface that has no interpreting position.
 */
export const SEED_AREAS: readonly string[] = ['local', 'session'];

/**
 * The origin schemes a seed entry may name.
 *
 * Ordinary web traffic only, and **the same rule and the same reason as
 * navigation** (§3.2, §3.7). A local-file origin turns a lease into
 * filesystem reach — which is one of the three things the sampled
 * arbitrary-code usage was actually doing, so it is refused here rather than
 * being left to the navigation that happens afterwards.
 *
 * Note there is no `about:blank` here although navigation permits it: a blank
 * page has no origin to write storage into, so an entry naming one is not a
 * narrower request but an incoherent one.
 */
export const SEED_ORIGIN_SCHEMES: readonly string[] = ['http:', 'https:'];

/**
 * At most this many entries.
 *
 * **A bound is what makes this a seeding argument rather than a payload
 * channel.** The measured shape is one or two tokens; sixteen is generous
 * against that measurement rather than derived from a limit anything imposes.
 */
export const MAX_SEED_ENTRIES = 16;

/**
 * At most this many bytes in one value, measured as bytes rather than as
 * characters.
 *
 * Characters would be the wrong unit for a bound whose purpose is to cap what
 * can be carried: a string of astral-plane characters is twice the bytes of a
 * string of the same length in Latin letters, so a character bound is a byte
 * bound that varies by alphabet.
 */
export const MAX_SEED_VALUE_BYTES = 4096;

/**
 * Re-exported so a caller validating a seed and a caller declaring one import
 * from the same place. **Declared on the driver seam** (`driver.ts`) because
 * the seam may not depend on this layer — see that declaration for why.
 */
export type { StorageSeedEntry };

/**
 * What the ledger is told about a seed: **origins and keys, never values**
 * (§3.2, and the same reasoning §3.9 gives about cookie values).
 *
 * A type with no value field, for exactly the reason
 * {@link import('../browser/driver.ts').CookieSummary} is one: the way to make
 * a redaction true is for the value to have nowhere to live. A function that
 * took the entries and promised to omit the values could be edited to stop
 * omitting them and nothing would fail; this cannot be, because there is no
 * field to put one in.
 */
export interface StorageSeedRecord {
  readonly origin: string;
  readonly area: 'local' | 'session';
  readonly key: string;
}

/**
 * The ledger's view of a seed. **Structurally cannot carry a value.**
 *
 * Deliberately not `entries.map((entry) => ({ ...entry }))` with a delete —
 * the point is that the returned objects are built field by field from the
 * three fields that may be recorded, so a value cannot arrive by being
 * carried along.
 */
export function seedRecord(entries: readonly StorageSeedEntry[]): readonly StorageSeedRecord[] {
  return entries.map((entry) => ({ origin: entry.origin, area: entry.area, key: entry.key }));
}

/**
 * Validate the argument, or refuse it.
 *
 * Returns the entries the driver will write. **An absent argument is not an
 * error** — it is the ordinary case, and it returns an empty list rather than
 * undefined so every caller downstream has one shape to handle.
 *
 * ── Why this runs before the claim row is written ───────────────────────
 *
 * A refused seed must leave no lease behind. It is an argument on the claim,
 * so a claim whose seed is refused is a claim that did not happen — and the
 * caller is not charged capacity for it, does not hold a key, and has nothing
 * to release. `decideClaim` therefore calls this before its first insert,
 * which is the same position the unknown-browser refusal occupies and for the
 * same reason (§2.2).
 */
export function validateStorageSeed(seed: unknown): readonly StorageSeedEntry[] {
  if (seed === undefined || seed === null) {
    return [];
  }

  if (!Array.isArray(seed)) {
    throw new StorageSeedRefusal(
      'claim.seed_shape',
      'A storage seed is a list of entries, each naming an origin, an area, a key and a string value.',
      { received: typeof seed },
    );
  }

  if (seed.length > MAX_SEED_ENTRIES) {
    throw new StorageSeedRefusal(
      'claim.seed_bounded',
      `A storage seed carries at most ${String(MAX_SEED_ENTRIES)} entries and this one carries ${String(seed.length)}. The bound is what keeps this a way to seed a token rather than a way to move a payload.`,
      { entries: seed.length, maximum: MAX_SEED_ENTRIES },
    );
  }

  return seed.map((entry, index) => validateEntry(entry, index));
}

/** One entry, with the position named so a refusal says which one. */
function validateEntry(entry: unknown, index: number): StorageSeedEntry {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new StorageSeedRefusal(
      'claim.seed_shape',
      `Storage seed entry ${String(index)} is not an entry. Each names an origin, an area, a key and a string value.`,
      { index },
    );
  }

  const candidate = entry as Record<string, unknown>;

  return {
    origin: validateOrigin(candidate.origin, index),
    area: validateArea(candidate.area, index),
    key: validateKey(candidate.key, index),
    value: validateValue(candidate.value, index),
  };
}

/**
 * The origin refusal — **ordinary web traffic, and nothing else.**
 *
 * The local-file case is named in the sentence rather than matched in the
 * condition, exactly as `pages.ts` does it: matching it would suggest the
 * other schemes are fine, and the allowlist is what actually decides.
 */
function validateOrigin(origin: unknown, index: number): string {
  if (typeof origin !== 'string' || origin.trim() === '') {
    throw new StorageSeedRefusal(
      'claim.seed_origin_allowed',
      `Storage seed entry ${String(index)} needs an origin: ordinary web traffic, as a scheme and host.`,
      { index, allowedSchemes: [...SEED_ORIGIN_SCHEMES] },
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(origin.trim());
  } catch {
    throw new StorageSeedRefusal(
      'claim.seed_origin_allowed',
      `Storage seed entry ${String(index)} does not name an origin this service can write into. Use ordinary web traffic (${SEED_ORIGIN_SCHEMES.join(', ')}).`,
      { index, origin: origin.trim(), allowedSchemes: [...SEED_ORIGIN_SCHEMES] },
    );
  }

  if (!SEED_ORIGIN_SCHEMES.includes(parsed.protocol)) {
    throw new StorageSeedRefusal(
      'claim.seed_origin_allowed',
      `Storage seed entry ${String(index)} names an origin using "${parsed.protocol}", which this service does not write storage into. Ordinary web traffic (${SEED_ORIGIN_SCHEMES.join(', ')}) only — a local-file origin in particular would turn a browser lease into reach into this machine's filesystem.`,
      { index, scheme: parsed.protocol, allowedSchemes: [...SEED_ORIGIN_SCHEMES] },
    );
  }

  // The origin, not the address: a path, a query or a fragment is not part of
  // what a storage area is keyed by, and keeping one would record a
  // distinction the browser does not make.
  return parsed.origin;
}

/**
 * The area refusal — **and this is where cookies are refused, by name.**
 *
 * §3.2 is explicit that a cookie is not an area on offer: *a cookie is a
 * credential the browser sends automatically to everything matching its
 * domain, and the read side is already limited to names and flags (§3.9), so
 * seeding one is credential injection on a shared profile*, which §3.13
 * refuses by name.
 *
 * **It is refused by not being on the allowlist**, in the same shape as every
 * other allowlist here. It is nevertheless named in the sentence, because a
 * caller that asked for cookies asked for something specific and being told
 * *why* it is not on offer is what stops the next attempt being an ingenious
 * workaround rather than a different approach.
 */
function validateArea(area: unknown, index: number): 'local' | 'session' {
  if (typeof area === 'string' && SEED_AREAS.includes(area)) {
    return area as 'local' | 'session';
  }

  const named = typeof area === 'string' ? JSON.stringify(area) : 'nothing';
  const cookieNote =
    typeof area === 'string' && area.toLowerCase().startsWith('cookie')
      ? ' Cookies in particular are not on offer and this is deliberate: a cookie is a credential the browser sends automatically to everything matching its domain, so seeding one is credential injection on a profile other callers share.'
      : '';

  throw new StorageSeedRefusal(
    'claim.seed_area_allowed',
    `Storage seed entry ${String(index)} names ${named} as its storage area. The areas on offer are ${SEED_AREAS.join(' and ')}.${cookieNote}`,
    { index, area: typeof area === 'string' ? area : null, allowedAreas: [...SEED_AREAS] },
  );
}

function validateKey(key: unknown, index: number): string {
  if (typeof key !== 'string' || key === '') {
    throw new StorageSeedRefusal(
      'claim.seed_shape',
      `Storage seed entry ${String(index)} needs a key, and a key is a non-empty string.`,
      { index },
    );
  }
  return key;
}

/**
 * The value refusal — **a string, and the size bound.**
 *
 * The string rule is the one whose reason is worth keeping in front of
 * whoever relaxes it: *the only thing that could carry a structure is
 * something that gets interpreted, and interpretation is the thing being
 * refused.* A caller that wants to seed an object serialises it itself, and
 * what arrives here is text either way — the difference is that the service
 * never does the deserialising, so there is no step of this operation that
 * takes a caller's bytes and builds something out of them.
 */
function validateValue(value: unknown, index: number): string {
  if (typeof value !== 'string') {
    throw new StorageSeedRefusal(
      'claim.seed_value_string',
      `Storage seed entry ${String(index)} has a ${typeof value} value. A seeded value is a string and is stored verbatim — the only thing that could carry a structure is something that gets interpreted, and interpretation is what this argument exists to avoid. Serialise it yourself and seed the text.`,
      { index, received: typeof value },
    );
  }

  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_SEED_VALUE_BYTES) {
    throw new StorageSeedRefusal(
      'claim.seed_bounded',
      `Storage seed entry ${String(index)} carries ${String(bytes)} bytes and the limit is ${String(MAX_SEED_VALUE_BYTES)}. The bound is what keeps this a way to seed a token rather than a way to move a payload.`,
      { index, bytes, maximum: MAX_SEED_VALUE_BYTES },
    );
  }

  return value;
}
