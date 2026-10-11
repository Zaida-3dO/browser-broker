/**
 * Removing known secret values from text before it leaves the service.
 *
 * ── What this can and cannot do ─────────────────────────────────────────
 *
 * It removes **exact occurrences** of values it is told about, in each of the
 * spellings the service's own outputs put text into: as typed, escaped the
 * way a JSON or YAML string escapes it (the accessibility snapshot is YAML),
 * and percent-encoded the way a URL or a submitted form carries it (the
 * network log is addresses).
 *
 * **It cannot remove a value a page has transformed.** A page that reverses,
 * base64-encodes or splits the password before displaying or logging it
 * produces text no exact match describes. That is a stated limit, not an
 * oversight: the service prevents the value it typed from reaching the caller
 * through the service's own outputs; it does not and cannot police what a
 * page's scripts do with a field's contents, including sending it over the
 * network. `browser_evaluate` is refused outright on a tab that has received
 * a secret for exactly this reason — it is the one output whose shape the
 * caller controls.
 */

/** What replaces a secret in any text the service hands back. */
export const REDACTION_MARK = '[secret redacted]';

/** Every spelling of one value this service's outputs might contain. */
export function spellingsOf(value: string): string[] {
  if (value === '') return [];
  const spellings = new Set<string>([value]);
  // JSON and double-quoted YAML escape backslashes, quotes and control
  // characters; the inner part of the JSON form is what appears in the text.
  spellings.add(JSON.stringify(value).slice(1, -1));
  // Single-quoted YAML doubles single quotes.
  spellings.add(value.replace(/'/gu, "''"));
  // A URL component, and a form body or query string (spaces as `+`, and the
  // stricter set `URLSearchParams` encodes).
  spellings.add(encodeURIComponent(value));
  spellings.add(new URLSearchParams({ v: value }).toString().slice(2));
  spellings.add(encodeURIComponent(value).replace(/%20/gu, '+'));
  return [...spellings].filter((spelling) => spelling !== '');
}

/**
 * A function that removes every spelling of every value from a text.
 *
 * Longest spellings are replaced first, so a value that contains another
 * value is removed whole rather than leaving its remainder behind.
 */
export function scrubberFor(values: readonly string[]): (text: string) => string {
  const spellings = [...new Set(values.flatMap(spellingsOf))].sort((a, b) => b.length - a.length);
  if (spellings.length === 0) return (text) => text;
  return (text: string) => {
    let out = text;
    for (const spelling of spellings) {
      if (out.includes(spelling)) {
        out = out.split(spelling).join(REDACTION_MARK);
      }
    }
    return out;
  };
}
