import type { BrowserId, BrowserSession, TabHandle } from '../browser/driver.ts';

/**
 * Where each leased tab actually is, asked of the browsers at generation time
 * (`MILESTONES.md` #70, `SCHEMA.md` §4.2a).
 *
 * ── Why this is a live read and why no column caches it ─────────────────
 *
 * §1.4: **there is no column recording where a tab is**, and its absence is
 * "the single largest privacy improvement in this design". A table of
 * addresses kept over months is a browsing history — with a retention setting
 * to get wrong and a clear-history command to build. §4.2a completes the
 * argument from the other side: the process generating this document **is
 * attached to both browsers**, so the one moment anybody wants the answer is
 * a moment when the source is right there. Asking is strictly better than
 * storing, and it leaves nothing behind.
 *
 * **Do not reintroduce a stored address column.** Nothing in this module
 * writes, and there is no store handle in scope to write with.
 *
 * ── The two rules, and neither is optional ──────────────────────────────
 *
 * §4.2a states them as requirements rather than suggestions:
 *
 * 1. **Every read carries a timeout.** A browser can hang — it accepts the
 *    request and never answers (§2.4b) — and a generator that inherits that
 *    hang produces nothing at all, which is worse than an incomplete
 *    document. The timeout is **per tab**, so one wedged page costs one entry
 *    rather than the whole run.
 * 2. **A browser that does not answer renders as an explicit word.** Not
 *    blank, not omitted, not a placeholder address. "A missing address and an
 *    unanswered one are different facts, and the second is the one that
 *    indicates something wrong."
 *
 * The timeout is **not defaultable to absent**: {@link readAddresses} takes
 * it as a required field on a required options object, so a caller cannot
 * omit it and get an unbounded read. That is as far as a type can carry the
 * rule; what it cannot prevent is somebody passing a number so large it is a
 * timeout in name only, and saying so is better than implying otherwise.
 *
 * ── This is outside every transaction, and that is structural here ──────
 *
 * §2.4b: browser work never happens inside the arbitration transaction. This
 * module is reachable only from the document generator, which runs it after
 * the status read has returned and closed. Nothing in this file imports a
 * store handle or a transaction, so there is no transaction in scope to be
 * inside of.
 */

/**
 * The word an unanswered read renders as (§4.2a).
 *
 * A constant rather than a literal at each use, so the document, the tests
 * and any later reader all name the same string — and so the mutation that
 * removes it has exactly one place to be removed from and is caught.
 */
export const UNREACHABLE = 'unreachable';

/**
 * What was learned about one tab's address.
 *
 * A discriminated union rather than `string | null`, because the three
 * outcomes §4.2a distinguishes are genuinely three: an address was read, the
 * browser did not answer in time, or the tab is not one this process can ask
 * about. Collapsing the last two into a null is precisely the flattening the
 * rule forbids.
 */
export type TabAddress =
  | { readonly kind: 'address'; readonly url: string; readonly title: string }
  /** The read did not answer within the timeout, or answered with a failure. */
  | { readonly kind: 'unreachable'; readonly reason: string }
  /**
   * There is no live tab to ask about — a queued lease, or a lease whose tab
   * row has not been created yet.
   *
   * **Distinct from `unreachable` on purpose.** A queued caller has no page,
   * which is normal and says nothing about a browser's health; an unanswered
   * read says something is wrong. Rendering both as one word would bury the
   * signal §4.2a exists to surface under the ordinary case.
   */
  | { readonly kind: 'none' };

export interface AddressReadOptions {
  /**
   * How long one tab's read may take, in milliseconds. **Required.**
   *
   * No default is offered, and the omission is the point: a default is how a
   * mandatory bound quietly becomes optional. A caller that has not thought
   * about the number cannot get past the type.
   */
  readonly timeoutMs: number;
  /**
   * The clock, injected so a test can drive a timeout without waiting for
   * one. Defaults to the real timer.
   */
  readonly setTimer?: (fn: () => void, ms: number) => { readonly cancel: () => void };
}

/**
 * What this module needs a browser to be able to do.
 *
 * Deliberately **narrower than {@link BrowserSession}**: one method, and it
 * reads. A document generator handed a full session could navigate, act,
 * capture or close tabs, and nothing in this file's tests would notice. The
 * narrow type is what makes "this only reads" a property of the signature
 * rather than a claim in a comment.
 *
 * A full {@link BrowserSession} satisfies it structurally, so the join needs
 * no adapter — pass the session.
 */
export interface AddressSource {
  /**
   * Ask where a tab is.
   *
   * The seam declares no `currentAddress` operation of its own, so this is
   * expressed through the operation the seam does have — an evaluation
   * against the page (`SCHEMA.md` §3.10). The generator supplies the function;
   * this module supplies the bound and the vocabulary.
   */
  readonly addressOf: (tab: TabHandle) => Promise<{ url: string; title: string }>;
}

/** A tab to ask about, and which lease it belongs to. */
export interface AddressRequest {
  readonly tabId: string;
  readonly browser: BrowserId;
  readonly handle: TabHandle;
}

/** The default timer, wrapped so the injected one and the real one are one shape. */
function realTimer(fn: () => void, ms: number): { cancel: () => void } {
  const handle = setTimeout(fn, ms);
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
}

/**
 * Race one read against the bound.
 *
 * `Promise.race` rather than an abort signal, because the seam's operations
 * do not take one and inventing a parallel cancellation protocol here would
 * be a change to somebody else's interface made from the outside. **The
 * consequence is stated rather than hidden:** the underlying read is not
 * cancelled, it is abandoned. A hung browser keeps whatever it was doing;
 * this process stops waiting for it, which is the property the rule actually
 * asks for — the generator must not inherit the hang. The abandoned promise's
 * eventual rejection is swallowed so it cannot surface as an unhandled
 * rejection long after the document was written.
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  setTimer: (fn: () => void, ms: number) => { readonly cancel: () => void },
): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }
> {
  let timer: { readonly cancel: () => void } | undefined;

  const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
    timer = setTimer(() => {
      resolve({ ok: false, reason: `no answer within ${String(timeoutMs)}ms` });
    }, timeoutMs);
  });

  const answered = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      reason: error instanceof Error ? error.message : 'the read failed',
    }),
  );

  try {
    return await Promise.race([answered, timeout]);
  } finally {
    timer?.cancel();
  }
}

/**
 * Read every requested tab's address, each under its own timeout.
 *
 * **Sequential rather than concurrent**, and the reason is the bound: run in
 * parallel, one wedged tab still costs only its own timeout, but so does a
 * browser that is merely slow for all of them at once, and the document's
 * total generation time stops being predictable from the number of tabs. At a
 * tab budget of fifteen (§6.2) the worst case is fifteen timeouts, which is a
 * bounded and explainable wait. If that ever becomes the wrong trade, it is a
 * change here and nowhere else.
 *
 * **Never throws.** Every failure becomes an `unreachable` entry, because the
 * one outcome §4.2a rules out is producing nothing at all.
 */
export async function readAddresses(
  source: AddressSource,
  requests: readonly AddressRequest[],
  options: AddressReadOptions,
): Promise<ReadonlyMap<string, TabAddress>> {
  const setTimer = options.setTimer ?? realTimer;
  const addresses = new Map<string, TabAddress>();

  for (const request of requests) {
    const result = await withTimeout(
      // Invoked inside a promise rather than called directly, because a
      // source that throws **synchronously** — before any promise exists —
      // would otherwise escape this loop entirely and the run would produce
      // no document at all. That is the one outcome §4.2a rules out, and a
      // synchronous throw is an ordinary way for a driver to report a handle
      // it does not recognise.
      (async () => source.addressOf(request.handle))(),
      options.timeoutMs,
      setTimer,
    );
    addresses.set(
      request.tabId,
      result.ok
        ? { kind: 'address', url: result.value.url, title: result.value.title }
        : { kind: 'unreachable', reason: result.reason },
    );
  }

  return addresses;
}

/**
 * What the document prints for one tab.
 *
 * The single place the three outcomes become text, so the rule "never blank,
 * never omitted, never a placeholder" is enforced at one point rather than at
 * each use. A tab with no entry at all — which is what happens when the
 * generator could not reach a browser to ask in the first place — renders as
 * `unreachable` too: an address that was never obtained is not an address,
 * and the absence of an entry is exactly the "omitted" case §4.2a forbids.
 */
export function renderAddress(address: TabAddress | undefined): string {
  if (address === undefined) {
    return UNREACHABLE;
  }
  switch (address.kind) {
    case 'address':
      return address.url;
    case 'unreachable':
      return UNREACHABLE;
    case 'none':
      // A lease with no tab. Not an address and not a failure — the word is
      // about the lease's state, and the document's queue section already
      // says why there is no page.
      return 'no tab';
  }
}

/**
 * Turn a browser session into an {@link AddressSource}.
 *
 * Kept here rather than in the generator so that the one expression evaluated
 * against a page in order to build this document lives beside the rule that
 * bounds it. It reads two properties and nothing else.
 */
export function addressSourceFromSession(session: BrowserSession): AddressSource {
  return {
    addressOf: async (tab) => {
      const result = await session.evaluate(
        tab,
        '({ url: document.location.href, title: document.title })',
      );
      const value = result.value;
      if (value === null || typeof value !== 'object') {
        throw new Error('the page did not report an address');
      }
      const record = value as { url?: unknown; title?: unknown };
      return {
        url: typeof record.url === 'string' ? record.url : '',
        title: typeof record.title === 'string' ? record.title : '',
      };
    },
  };
}
