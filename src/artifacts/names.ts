/**
 * Turning things a caller supplies into things that are safe to be a file
 * name — and nothing else. No filesystem call happens in this file.
 *
 * ── Why the rules are strict here rather than at the point of writing ───
 *
 * `SCHEMA.md` §1.7a states the reasoning and it is the reason this module is
 * separate from the one that writes files: **a file name travels further
 * than a database column does.** A column is read by things that were
 * written to read it. A name ends up in log lines, in terminal output
 * somebody screenshots, in error messages, in a shell history, in the title
 * bar of whatever opened the image. It leaks by default, and it leaks to
 * places nobody enumerated.
 *
 * Four rules follow from that, and §1.7a puts them in an order that matters:
 *
 * 1. **Query strings are stripped entirely, before anything else.** A query
 *    string is where identifiers, tokens, search terms and session material
 *    live — the part of an address most likely to carry something that should
 *    never have been written down, and the part least likely to help anybody
 *    tell two files apart. It is stripped first so that no later rule can be
 *    the thing that happened to remove it: a collapse rule that turned `?` and
 *    `=` into hyphens would leave the token in the name, spelled differently.
 * 2. **Safe characters only**, so the name is the same on every filesystem and
 *    survives being pasted anywhere.
 * 3. **Truncated to a bounded length**, so a deep path does not produce a name
 *    that is unusable or unprintable. What truncation loses is recoverable
 *    from `captures.url` (§1.7); nothing depends on the name being complete.
 * 4. **Never interpreted as a path.** The derivation produces **one path
 *    segment**, and the separators that would make it more than one are not in
 *    the safe set.
 *
 * **A label a caller supplies is subject to rules two, three and four as
 * well** (§1.7a). It is a label, not a location.
 *
 * ── What this module structurally guarantees, and what it does not ──────
 *
 * **Structural.** Everything returned by {@link slugFromUrl} and
 * {@link sanitiseLabel} is drawn from {@link SAFE_CHARACTERS} — the functions
 * build their output by testing each character against that set rather than by
 * removing a list of bad ones, so a character nobody thought of is excluded by
 * default rather than included by default. Neither separator, `.` and `:` are
 * outside the set, so no return value can be a traversal, an absolute path, a
 * drive-qualified path, or more than one segment.
 *
 * **Not structural, and worth saying rather than implying.** Nothing here can
 * stop a caller putting a secret in the *path* of an address, and the path is
 * kept: only the query string is dropped. §1.7a's rule is about where secrets
 * overwhelmingly live, not a claim that an address is safe once it is stripped.
 * A service that wanted that guarantee would have to drop the address
 * entirely, which would defeat what the slug is for.
 */

/**
 * The characters a derived name may contain. Lower-case letters, digits, and
 * the hyphen — nothing else, and in particular neither separator, no dot, no
 * colon and no tilde.
 *
 * An allowlist rather than a denylist, because a denylist has to be right
 * about every filesystem's rules on every platform forever, and this has to be
 * right once.
 */
const SAFE_CHARACTERS = /^[a-z0-9-]$/;

/**
 * How long a derived part may be.
 *
 * A bound rather than a limit anybody has to remember: §1.7a asks for
 * truncation so a deep path cannot produce an unprintable name, and the
 * number matters less than there being one. Chosen so that the five parts
 * §1.7a's shape assembles — slug, label, width, when, identifier — stay well
 * inside the shortest path-component limit in common use.
 */
export const MAXIMUM_PART_LENGTH = 48;

/** What a name is when every character in it was unsafe. */
const EMPTY_PART = 'unnamed';

/**
 * Reduce a string to the safe set, collapse runs, and truncate.
 *
 * **Runs collapse to one hyphen and the ends are trimmed**, so the result
 * never begins or ends with a separator-looking character and never contains a
 * run of them. That is presentation rather than safety — the safety is that
 * nothing outside {@link SAFE_CHARACTERS} survives at all — but a name of
 * forty hyphens is a name that tells a reader nothing, and truncating it would
 * spend the whole budget on nothing.
 *
 * **Never empty.** A string that reduces to nothing returns {@link EMPTY_PART}
 * rather than an empty string, because an empty part would collapse the shape
 * §1.7a describes into one with a doubled separator and make two different
 * captures produce the same name.
 */
function reduce(value: string): string {
  const characters: string[] = [];
  for (const character of value.toLowerCase()) {
    if (SAFE_CHARACTERS.test(character)) {
      characters.push(character);
      continue;
    }
    // Anything outside the set becomes a separator rather than disappearing,
    // so two distinguishable inputs do not collapse into one name.
    if (characters.length > 0 && characters[characters.length - 1] !== '-') {
      characters.push('-');
    }
  }
  const collapsed = characters.join('').replace(/^-+|-+$/g, '');
  if (collapsed === '') return EMPTY_PART;
  return collapsed.slice(0, MAXIMUM_PART_LENGTH).replace(/-+$/g, '') || EMPTY_PART;
}

/**
 * Strip a query string, and a fragment, from an address — textually, before
 * anything parses it.
 *
 * **Textual and first, on purpose.** Doing it by parsing would mean handing
 * the whole address including its query to a parser, and the value of the rule
 * is that the query is gone before anything else touches it. `?` opens a query
 * and `#` opens a fragment; whichever comes first ends the part that is kept.
 *
 * A fragment is stripped alongside the query although §1.7a names only the
 * query. It is the same class of material — client-side state a caller chose,
 * frequently carrying identifiers — and keeping it would put it in a file
 * name for no benefit, since it never distinguishes two pages the server
 * served.
 */
function withoutQuery(address: string): string {
  const end = Math.min(
    ...['?', '#'].map((mark) => {
      const at = address.indexOf(mark);
      return at === -1 ? address.length : at;
    }),
  );
  return address.slice(0, end);
}

/**
 * The page slug: host and path, query stripped first, reduced to one safe
 * segment.
 *
 * **Derived, never supplied** (§1.7a). A caller's own label describes what it
 * was *doing*; the address describes what it was *looking at*, and only the
 * second is reliably distinct between two pieces of work that happen to be
 * described the same way.
 *
 * **An address this cannot parse still produces a name.** A capture is never
 * refused for the sake of its file name — the whole shape of §3.11 is that the
 * only refusals are argument mistakes — so an unparseable address falls back to
 * reducing the stripped text directly. It is a worse name and it is still a
 * name.
 */
export function slugFromUrl(address: string | undefined): string {
  if (address === undefined || address.trim() === '') return EMPTY_PART;
  const stripped = withoutQuery(address);
  try {
    const parsed = new URL(stripped);
    // Host and path only. Not the scheme, not any credentials the address
    // carries in front of the host, and not the port — none of which help
    // anybody tell two pictures apart, and the first of which is the single
    // most sensitive thing an address can hold.
    return reduce(`${parsed.hostname}${parsed.pathname}`);
  } catch {
    return reduce(stripped);
  }
}

/**
 * A caller's own label, made safe.
 *
 * Rules two, three and four of §1.7a apply here as they do to the slug: safe
 * characters, bounded, and never a path. Rule one does not, because a label is
 * not an address and has no query string to strip — but note that a label
 * containing `?` is reduced by the same safe-character pass, so a caller that
 * pasted an address into the label field does not smuggle one through.
 */
export function sanitiseLabel(label: string | undefined): string {
  if (label === undefined || label.trim() === '') return EMPTY_PART;
  return reduce(label);
}

/**
 * A sortable stamp for the moment a capture was taken.
 *
 * Digits only, most significant first, so a directory listing sorts into time
 * order within a page and a view — which is the fourth of the five sorting
 * levels §1.7a's shape is chosen for. Derived from the instant's own text
 * rather than formatted by hand so that it is the same on every platform.
 */
export function stampFromInstant(when: Date): string {
  return when.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

/**
 * Assemble the five parts §1.7a specifies, in the order it specifies them:
 * `<page-slug>-<view-label>-<width>-<when>-<id>.png`.
 *
 * That order is what makes a directory listing readable: all the pictures of
 * one page together, then within a page all the pictures of one view, then the
 * widths, then the sequence in time, then an identifier that guarantees
 * uniqueness without anybody coordinating.
 *
 * **Every variable part goes through the rules above**, including the
 * identifier — which is generated rather than supplied and would pass anyway,
 * but passing it through means there is no part of this name that a future
 * change could make caller-controlled without also making it safe.
 */
export function captureFileName(parts: {
  readonly url: string | undefined;
  readonly label: string | undefined;
  readonly viewportWidth: number;
  readonly takenAt: Date;
  readonly id: string;
}): string {
  const width = reduce(String(Math.trunc(parts.viewportWidth)));
  return [
    slugFromUrl(parts.url),
    sanitiseLabel(parts.label),
    width,
    stampFromInstant(parts.takenAt),
    reduce(parts.id),
  ].join('-') + '.png';
}
