/**
 * Escaping, on its own, because a document assembled by concatenation has
 * exactly one way to go wrong and this is it.
 *
 * Everything in the operations document comes from somewhere this service
 * does not control: a session identity another system minted (`SCHEMA.md`
 * §1.3), a free-text purpose a caller wrote, a free-text feedback note
 * (§3.16), an error message from a browser, and — via §4.2a — **a page
 * address read live from a browser**. Any of those can contain the characters
 * that end an attribute or open a tag.
 *
 * The document is also **shared**: §4's whole argument for a file is that it
 * "can be sent to somebody, kept beside a report, or opened on a machine that
 * has never run this service". So the person who opens it is frequently not
 * the person who generated it, and markup that came in from a page address is
 * markup that runs in their browser.
 *
 * There is no templating engine here and there will not be one — the binding
 * is no runtime dependencies, and a self-contained file with a build step
 * behind it would contradict the reason it is self-contained. So escaping is
 * a function that is called, and the check is that everything which
 * interpolates calls it.
 */

/**
 * Escape text for HTML, covering both element content and attribute values.
 *
 * Five characters rather than three: the two quote forms are included so one
 * function is correct in both positions. A separate attribute escaper is a
 * second function to remember to call, and the one anybody forgets is
 * whichever they use less.
 *
 * The ampersand is replaced first, and the order is load-bearing rather than
 * stylistic: doing it later would re-escape the ampersands the other
 * replacements have just introduced, turning `<` into `&amp;lt;`.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a value of unknown type for HTML.
 *
 * Null and undefined become an em dash rather than the words "null" or
 * "undefined", because the document is read by a person and those two words
 * are this language's, not this service's. **This is not the `unreachable`
 * case** — that is a different fact with its own explicit word (§4.2a), and
 * it is decided in `addresses.ts` before anything reaches here.
 *
 * **Only the four primitive shapes a cell can honestly hold are rendered**,
 * and anything else becomes the em dash too. That is not defensiveness: a
 * value that reached a table cell as an object or an array is a mistake in
 * the caller, and stringifying it would print the language's own placeholder
 * for "I could not do this" into a document a person reads as a fact. An
 * em dash says the cell has nothing in it, which is at least true.
 */
export function escapeValue(value: unknown): string {
  if (typeof value === 'string') {
    return escapeHtml(value);
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return escapeHtml(value.toString());
  }
  return '—';
}
