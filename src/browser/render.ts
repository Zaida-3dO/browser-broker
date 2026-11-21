/**
 * The renderers every driver shares: the accumulated network log's line and
 * header format, and the PNG header reader that reports what a capture
 * produced.
 *
 * ── Why one copy ─────────────────────────────────────────────────────────
 *
 * Both artefacts are **caller-facing text**, and every driver that reads a
 * page writes them. Two copies of the same format is the drift the service
 * layer exists to prevent wearing a smaller hat: a caller that reads a
 * network log learns one line shape, and if the next browser it is served
 * by spells the same fact differently, the caller is parsing per-driver
 * without anything telling it to. So each driver calls **one** copy for
 * what it renders rather than keeping its own: the same fact gets one
 * spelling whichever browser served it.
 *
 * ── Why these live here, and not in the capture or service layer ─────────
 *
 * Same rule `readPngDimensions`'s comment gives: **the browser module owns
 * driving a browser and describing what came back from it**; the capture
 * pipeline owns decoding. These functions decode nothing — the network log
 * renders what the driver already recorded, and the PNG reader lifts two
 * integers off a fixed-offset header. Neither decodes a pixel, and neither
 * reaches above this module.
 */

/** How a request settled — a status it was answered with, or a failure. */
export type NetworkOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly elapsedMs: number }
  | { readonly kind: 'failed'; readonly reason: string; readonly elapsedMs: number };

/**
 * What is known about one request, so far.
 *
 * ── Why outcome is a field and not a second line ────────────────────────
 *
 * The obvious cheaper change is a second listener that pushes
 * `"<- 404 <url>"` when a response arrives. It is rejected: a caller then has
 * to pair lines up by address, and a page that requests one address twice —
 * which is ordinary — makes that pairing ambiguous with no way to resolve it.
 * Keying on the automation library's own request object is unambiguous by
 * construction, because that object *is* the identity of the request.
 *
 * ── Why `outcome` distinguishes three states and not two ────────────────
 *
 * A request with no `outcome` yet is **in flight**, which is a real state and
 * not an absence — a read can legitimately happen mid-load. Reporting it as
 * though it had completed is the misleading-evidence failure this work exists
 * to remove, and dropping it silently is the same failure wearing a different
 * hat. So the three states a caller must be able to tell apart — succeeded,
 * failed, and not-answered-yet — are three shapes here, and the formatter
 * writes a visibly different line for each.
 *
 * ── Timings: deliberately one number, not a waterfall ───────────────────
 *
 * The item asks for timings to be considered. **Included: one elapsed
 * milliseconds figure, and only on a settled request.** The reason to include
 * anything is that "the API call is slow" and "the API call is broken" are
 * different answers to the reviewer's question, and a status alone cannot
 * separate them. The reason not to include more is that the library's full
 * timing breakdown (DNS, connect, TLS, TTFB) is seven numbers per request
 * that answer a profiling question nobody asked this surface, on a log that is
 * already one line per request on a page that makes hundreds. One number is
 * measured from this process's own clock at the two events it already has, so
 * it costs no extra call into the browser.
 */
export interface NetworkEntry {
  readonly method: string;
  readonly url: string;
  /** This process's clock when the request was seen, for the elapsed figure. */
  readonly startedAt: number;
  outcome?: NetworkOutcome;
}

/**
 * One request as a line of the network log.
 *
 * The shape is `[n] STATUS METHOD URL (elapsed)`, with the outcome **first
 * among the things that describe the request**, because that is the column a
 * caller scans: a log whose status is at the end of a line of arbitrary length
 * is one a reader has to parse rather than scan.
 *
 * `FAILED` and `PENDING` occupy the same column as a status code for the same
 * reason, and neither can be mistaken for one — a caller looking for "did this
 * work" reads one token per line whatever happened.
 *
 * ── Why the index goes before the status and not after it ───────────────
 *
 * The index has to sit **outside** the scanned column rather than inside it.
 * Putting it after the outcome (`404 [7] GET …`) would place a variable-width
 * number between the status and the request, which costs the method and
 * address their predictable offset and costs the outcome its place as the
 * token a reader's eye lands on first. Putting it before, in brackets, keeps
 * the one-token-per-line property the paragraph above exists to protect: the
 * bracket is visibly not a status, and the outcome remains the first thing
 * said *about the request*.
 *
 * ── Why an index at all, when nothing yet spends it ─────────────────────
 *
 * It is a **stable handle**, and that is the whole of the claim being made
 * for it. The entries are held in insertion order and an entry is mutated in
 * place as its outcome arrives, so entry *n* is the same request across two
 * reads of the same tab — which is what makes it usable for referring to a
 * line at all, in a later message, in a bug report, or by a detail call that
 * does not exist yet.
 *
 * A detail call (`browser_network_request {lease_key, index}`) is
 * **deliberately out of scope**: it would require buffering every response
 * body on every page, against the "the cost of not asking is zero" rule the
 * artefact collection keeps, and it would be the first path writing
 * third-party response bodies to disk under a credential scanner that exists
 * as prose rather than as code. The index stands on its own because it costs
 * one token per line and because the thing it is most often needed for —
 * *"the third request, the one that 404s"* — is a sentence a caller has reason
 * to write. What it does not do is promise that a call taking it exists.
 */
export function formatNetworkEntry(entry: NetworkEntry, index: number): string {
  const request = `${entry.method} ${entry.url}`;
  // One-based, because the number is for a person or an agent to quote, and
  // "the first request" is entry 1 in every sentence anybody writes about a
  // log. A zero-based index here would be an internal detail leaking into a
  // caller-facing handle.
  const at = `[${String(index + 1)}]`;
  if (entry.outcome === undefined) {
    // No response and no failure yet. Said explicitly — the alternative is a
    // line that reads exactly like a request nobody ever asked the outcome of.
    return `${at} PENDING ${request} (in flight when this log was written)`;
  }
  if (entry.outcome.kind === 'failed') {
    return `${at} FAILED  ${request} (${entry.outcome.reason}, ${String(entry.outcome.elapsedMs)}ms)`;
  }
  return `${at} ${String(entry.outcome.status)}     ${request} (${String(entry.outcome.elapsedMs)}ms)`;
}

/**
 * The whole network log as it goes into the file, header and all.
 *
 * ── Why a header, and why it counts rather than describes ───────────────
 *
 * The item's third criterion: *if the full request set is not returned, the
 * response says what it is showing, so a caller does not read one line as the
 * whole picture.* **Everything accumulated is returned here** — nothing is
 * dropped, so the honest header is a count rather than an apology. It exists
 * because the reported defect was a caller unable to tell a one-line log from
 * a one-request page, and a count settles that in one line whichever it was.
 *
 * The pending tally is called out separately because it is the number that
 * changes what the rest of the log *means*: a read taken mid-load is a
 * partial picture of the page even though it is a complete picture of what
 * has been observed, and those are easy to confuse when nothing says so.
 *
 * ── What the index on each line is counting ─────────────────────────────
 *
 * Position in the driver's accumulated list, one-based, and **everything
 * accumulated is rendered** — so the indices are contiguous and the last one
 * equals the header's count. That correspondence is worth keeping: a caller
 * that sees `12 requests` and a line `[12]` can tell at a glance that it is
 * looking at the whole log rather than a window onto it. A future filter here
 * would have to say so in the header, because a gap in the numbering is
 * otherwise indistinguishable from a request that was dropped on the floor.
 *
 * **Nothing here truncates**, which matches each driver's neighbouring
 * artefacts and each driver's note that a cap is the service's decision and
 * not this module's. The growth this adds over the previous format is bounded
 * and small — one outcome per request on a log that already held one line per
 * request — so it introduces no cap that was not already owed, and it invents
 * no byte count nobody agreed to.
 */
export function renderNetworkLog(entries: readonly NetworkEntry[]): string {
  if (entries.length === 0) {
    // Distinguishable from a page whose requests all failed, which is the
    // third thing the item asks a caller to be able to tell apart: no request
    // was made, rather than one was made and went badly.
    return 'No requests were observed on this tab.';
  }

  const pending = entries.filter((entry) => entry.outcome === undefined).length;
  const counted = `${String(entries.length)} request${entries.length === 1 ? '' : 's'}`;
  const header =
    pending === 0
      ? `${counted}, all settled.`
      : `${counted}, ${String(pending)} still in flight when this was written.`;

  // `entries.entries()` rather than a counter, because the index IS the array
  // position: the two cannot drift apart, and a filter added here later would
  // renumber rather than silently lie about which request a number names.
  return [
    header,
    ...[...entries.entries()].map(([index, entry]) => formatNetworkEntry(entry, index)),
  ].join('\n');
}

/**
 * The pixel dimensions a PNG declares about itself.
 *
 * ── Why this reads eight bytes instead of importing a decoder ────────────
 *
 * `captures.source_*` is *what the browser produced*, and the only place that
 * is stated without inference is the image header. A full-page capture is
 * taller than the viewport by definition, so measuring the page instead would
 * be wrong in exactly the case those fields exist to describe.
 *
 * The repository already has a real decoder, and this deliberately does not
 * call it: **the capture pipeline owns decoding, and the browser module owns
 * driving a browser.** Reaching across for two integers would put a second
 * consumer on that module and make an isolation rule a matter of habit rather
 * than of imports. Reading a fixed-offset header is smaller than the import
 * it avoids, and it decodes nothing — the pixels are never touched here.
 *
 * Returns `undefined` rather than throwing on anything that is not a PNG: the
 * caller has a page-measured fallback, and a capture that succeeded should not
 * be turned into a failure by a header this function did not recognise.
 */
export function readPngDimensions(
  image: Uint8Array,
): { width: number; height: number } | undefined {
  // Signature, then a 4-byte length, then the type `IHDR`, then width and
  // height as big-endian 32-bit integers: 24 bytes before either is complete.
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (image.length < 24) {
    return undefined;
  }
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (image[index] !== SIGNATURE[index]) {
      return undefined;
    }
  }
  // The first chunk must actually be `IHDR` before offsets 16 and 20 are read
  // as width and height. A PNG may legally open with a different chunk, and
  // its data would be somebody else's integers — returned here as a size.
  // `undefined` costs the caller its page-measured fallback and nothing else.
  const IHDR = [0x49, 0x48, 0x44, 0x52];
  for (let index = 0; index < IHDR.length; index += 1) {
    if (image[12 + index] !== IHDR[index]) {
      return undefined;
    }
  }

  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
