/**
 * The secret sentinel: how a caller names a credential without holding it.
 *
 * A caller that needs a password typed into a sign-in form writes
 * `{{secret:NAME}}` as the value of a `type`, `fill` or `fill_form` field. The
 * service resolves the name **at the sink** — inside the after-commit browser
 * work, after the ledger row has been written — so everything that records or
 * echoes the request (the ledger, a refusal, a result, a log line) only ever
 * sees the sentinel. See `SCHEMA.md` §3.8a for the whole contract.
 *
 * ── Why a value must be exactly one sentinel ────────────────────────────
 *
 * A sentinel embedded in other text (`prefix{{secret:x}}`) is refused rather
 * than resolved. The binding rules — which origin, which kind of field — are
 * about *the field receiving the secret*, and a value that is part secret and
 * part caller text has no single answer to "what went into this field". The
 * scrubbing rules work on exact values, and a field holding a caller-chosen
 * prefix glued to a secret is a field whose contents no exact match describes.
 * A whole-value sentinel keeps both rules simple enough to be true.
 *
 * ── Why anything that merely looks like one is refused ──────────────────
 *
 * `{{secret:` anywhere it is not a well-formed, whole-value sentinel in a
 * permitted position is refused, not passed through as literal text. A caller
 * that wrote a sentinel into a key press, a URL or an expression meant a
 * secret to go there, and typing the literal text instead would report success
 * for an action that did not do what was asked.
 */

/** The opening every sentinel shares, and what the shape check looks for. */
export const SENTINEL_OPENING = '{{secret:';

/** The characters a secret's name may use, and its length bounds. */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9_./-]{1,128}$/u;

/** A whole value that is exactly one sentinel, capturing the name. */
const WHOLE_SENTINEL = /^\{\{secret:([A-Za-z0-9_./-]{1,128})\}\}$/u;

/**
 * The name a value refers to, when the value is exactly one well-formed
 * sentinel; otherwise `undefined`.
 */
export function sentinelName(value: string): string | undefined {
  return WHOLE_SENTINEL.exec(value)?.[1];
}

/** Whether a string carries anything that looks like a sentinel at all. */
export function looksLikeSentinel(value: string): boolean {
  return value.includes(SENTINEL_OPENING);
}

/**
 * Every string anywhere inside an arbitrary value, for the check that a
 * sentinel has not been put somewhere it is not resolved.
 *
 * Walks arrays and plain objects. Bounded by depth so a hostile structure
 * cannot make the walk itself the problem; a structure deeper than this is
 * refused elsewhere long before it could be acted on.
 */
export function stringsWithin(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (depth > 8 || value === null || typeof value !== 'object') return [];
  const out: string[] = [];
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    out.push(...stringsWithin(child, depth + 1));
  }
  // Object keys too: a sentinel used as a key is still a sentinel somewhere
  // it is not resolved.
  if (!Array.isArray(value)) {
    out.push(...Object.keys(value));
  }
  return out;
}

/** Whether a sentinel shape appears anywhere inside an arbitrary value. */
export function containsSentinel(value: unknown): boolean {
  return stringsWithin(value).some(looksLikeSentinel);
}
