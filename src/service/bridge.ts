import type { Database } from 'better-sqlite3';

import type { BrokerService, OperationOutcome, OperationRequest } from '../adapter/service-seam.ts';
import type { OperationName } from '../adapter/operations.ts';
import { BrokerError } from '../errors.ts';
import {
  recordFeedback,
  refuseSubmission,
  isFeedbackCategory,
  type FeedbackSubmission,
} from '../feedback/record.ts';
import { hashKey } from './keys.ts';
import { CallRefusal } from './refusals.ts';
import type { Broker } from './broker.ts';

/**
 * The join between the service and the routes: a {@link Broker} presented as
 * the one-method {@link BrokerService} every adapter calls.
 *
 * ── Why this file has to exist at all ───────────────────────────────────
 *
 * The two shapes are deliberately different and neither is wrong.
 * {@link Broker} is ten typed methods because an internal caller should not be
 * able to pass a claim's arguments to a release. {@link BrokerService} is one
 * method over an opaque record because a *route* must not be able to compose
 * two service calls and present the result as one operation — the seam the
 * `service-seam.ts` header describes as "the seam through which a route grows
 * its own rules". Bridging them is therefore translation work with a home of
 * its own, rather than a cast either side could have avoided.
 *
 * ── What this file may decide, which is nothing ─────────────────────────
 *
 * `CLAUDE.md`: **every adapter is a thin shell over a service call**, and no
 * adapter may reach the database or a guard directly. This sits below the
 * adapters and above the service, and it holds to the same rule: it shapes
 * arguments and it names one operation. Every question of whether an
 * operation is *allowed* — is the key real, is the lease live, is the tab
 * this lease's, is there capacity — is decided inside the arbitration
 * transaction, after this function has handed off, and this file re-checks
 * none of it.
 *
 * The one place that claim needs defending is {@link tabForKey}; its own
 * comment does the defending.
 */

/** Read an argument under either the surface spelling or the service one. */
function argument(args: Readonly<Record<string, unknown>>, ...names: readonly string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * The lease key, as both surfaces spell it.
 *
 * The tool surface names it `lease_key` and the command line takes
 * `--lease-key`, which `parseArguments` normalises to the same word. `key` is
 * accepted too because it is the name the service's own inputs use, and a
 * caller driving the dispatcher in process writes the service's spelling.
 */
function keyFrom(args: Readonly<Record<string, unknown>>): string {
  const value = argument(args, 'lease_key', 'leaseKey', 'key', 'lease');
  if (typeof value !== 'string' || value.length === 0) {
    throw new CallRefusal(
      'key_missing',
      'This operation carries your lease key, written out on the call. It was returned once by the claim that granted the lease and is not recoverable from anywhere else.',
    );
  }
  return value;
}

/**
 * The tab this lease holds.
 *
 * ── Why the tab is looked up rather than taken from the caller ──────────
 *
 * `SCHEMA.md` §2.3: **a lease is one tab**, and §3.4 states the consequence
 * outright — "there is no `tabs` argument, and its absence is the model...
 * nothing that takes a list of tabs, not as a restriction but because there
 * was never more than one to list". So no surface offers a tab argument and
 * none should; the tab is a fact about the lease, and the caller naming it
 * again could only ever be a way to name a different one.
 *
 * The service's inputs still carry `tabId` because the service is addressed
 * by tab, so somebody has to turn the one into the other. That is this
 * function, and it is a **read taken to shape an input**, not a decision:
 *
 * - It authorises nothing. `resolveOwnedTabOrRefuse` re-resolves the tab inside the
 *   arbitration transaction and refuses with `tab.owned` if it does not
 *   belong to the lease the key names. A wrong answer here is caught there.
 * - It is not the read the reader rule (§2.4, §5.2) forbids. That rule exists
 *   because liveness is *derived* rather than stored, so a route printing
 *   `state` from a table would report leases that do not exist. Nothing
 *   derived is read here and nothing is reported to the caller from it — the
 *   value goes into the service call and the service decides.
 * - It cannot widen access. It selects only tabs whose `claim_id` is the
 *   claim the presented key hashes to, so a caller without the key resolves
 *   nothing.
 *
 * A key matching no claim resolves nothing, and the empty string is passed
 * through so that the transaction produces the ordinary `unrecognised_key`
 * refusal from `resolveLease` — refusing here would answer a different
 * question in a different order, and §3.14's ordering is a property callers
 * branch on.
 */
function tabForKey(db: Database, key: string): string {
  const row = db
    .prepare(
      `SELECT t.id AS tabId
         FROM tabs t
         JOIN claims c ON c.id = t.claim_id
        WHERE c.key_hash = @keyHash
          AND t.state IN ('opening', 'open')
        ORDER BY t.created_at DESC
        LIMIT 1`,
    )
    .get({ keyHash: hashKey(key) }) as { tabId: string } | undefined;

  return row?.tabId ?? '';
}

/**
 * Turn a thrown refusal into the outcome shape a route returns.
 *
 * Only {@link BrokerError} is caught. Anything else is a fault rather than a
 * decision, and swallowing it here would turn a broken build into a refusal
 * a caller would retry forever.
 */
function refusalFrom(error: BrokerError): OperationOutcome {
  const detail = error instanceof CallRefusal ? error.detail : undefined;
  return {
    outcome: 'refused',
    code: error instanceof CallRefusal ? error.code : error.rule,
    rule: error.rule,
    message: error.message,
    ...(detail === undefined || Object.keys(detail).length === 0 ? {} : { details: detail }),
  };
}

/** Everything a service call may reach, handed in rather than found. */
export interface BridgeOptions {
  readonly broker: Broker;
  /**
   * The store connection, for the two things a {@link Broker} does not offer:
   * resolving a lease's tab, and the feedback row.
   *
   * It is the *same* handle the broker was built on, deliberately. Two
   * connections would let this file read a snapshot the service is midway
   * through changing.
   */
  readonly db: Database;
}

/**
 * Present a {@link Broker} as the {@link BrokerService} the routes call.
 *
 * Every branch below is one broker method with its arguments shaped, and the
 * shaping is the whole of what happens between the route and the service.
 */
export function serviceFor(options: BridgeOptions): BrokerService {
  const { broker, db } = options;

  const perform = async (request: OperationRequest): Promise<OperationOutcome> => {
    try {
      const value = await dispatch(request);
      return { outcome: 'accepted', value };
    } catch (error) {
      if (error instanceof BrokerError) {
        return refusalFrom(error);
      }
      throw error;
    }
  };

  /** One request, one service call. The `switch` is exhaustive by type. */
  const dispatch = async (
    request: OperationRequest,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const args = request.arguments;
    const operation: OperationName = request.operation;

    switch (operation) {
      case 'claim': {
        // **Omitted, not empty.** `browser` is optional (§3.2): unstated
        // resolves to the first signed-in browser, which the tool description
        // promises is "what most work wants". Coercing an absent argument to
        // `''` turned that documented default into `claim.browser_known`
        // refusing a browser named `""` — on the very first call a new caller
        // makes, and for an argument they were told they could leave out.
        // Keeping absence absent is what makes the resolution the service
        // already implements reachable.
        const browser = asOptionalString(argument(args, 'browser'));
        const result = await broker.claim({
          sessionId: asString(argument(args, 'session_id', 'sessionId')),
          ...(browser === undefined ? {} : { browser }),
          purpose: asString(argument(args, 'purpose')),
          ...(argument(args, 'storage_seed', 'storageSeed') === undefined
            ? {}
            : { storageSeed: argument(args, 'storage_seed', 'storageSeed') }),
        });
        return { ...result };
      }

      case 'status':
        return { ...(await broker.status({ key: keyFrom(args) })) };

      case 'release':
        return { ...(await broker.release({ key: keyFrom(args) })) };

      case 'navigate': {
        const key = keyFrom(args);
        return {
          ...(await broker.navigate({
            key,
            tabId: tabForKey(db, key),
            url: argument(args, 'url'),
          })),
        };
      }

      case 'act': {
        const key = keyFrom(args);
        return {
          ...(await broker.act({ key, tabId: tabForKey(db, key), request: actionFrom(args) })),
        };
      }

      case 'read': {
        const key = keyFrom(args);
        return {
          ...(await broker.read({
            key,
            tabId: tabForKey(db, key),
            ...(argument(args, 'what', 'artifacts') === undefined
              ? {}
              : { artifacts: artifactsFrom(argument(args, 'what', 'artifacts')) }),
          })),
        };
      }

      case 'evaluate': {
        const key = keyFrom(args);
        return {
          ...(await broker.evaluate({
            key,
            tabId: tabForKey(db, key),
            expression: argument(args, 'expression'),
          })),
        };
      }

      case 'capture': {
        const key = keyFrom(args);
        const fullPage = argument(args, 'full_page', 'fullPage');
        const selector = argument(args, 'selector');
        // The tool surface spells it `compare_to` and the command line
        // `--compare-to`, which `parseArguments` normalises to `compare_to`
        // by turning dashes into underscores — so both surfaces arrive at
        // the same key and the command line needs no entry of its own. The
        // camel spelling is accepted too, for a caller driving the dispatcher
        // in process with the service's own vocabulary.
        // Read here, beside the two arguments that were already
        // being carried, because a surface that declares an argument and
        // drops it is worse than one that never offered it: the caller is
        // told the diff is available, passes it, and gets a capture with no
        // comparison and nothing saying why.
        const compareTo = argument(args, 'compare_to', 'compareTo');
        return {
          ...(await broker.capture({
            key,
            tabId: tabForKey(db, key),
            ...(fullPage === undefined ? {} : { fullPage: asBoolean(fullPage) }),
            ...(typeof selector === 'string' ? { selector } : {}),
            ...(typeof compareTo === 'string' && compareTo.length > 0 ? { compareTo } : {}),
          })),
        };
      }

      case 'tab_replace': {
        const key = keyFrom(args);
        return { ...(await broker.tab_replace({ key, tabId: tabForKey(db, key) })) };
      }

      case 'sign_in': {
        // **The tab is not an argument and must never become one.** A lease is
        // one tab (§2.3), so the operation resolves it from the lease itself —
        // the same rule `tabForKey` exists for, and the reason there is no
        // `tabForKey` call here: this operation reads its own tab inside the
        // transaction, where the answer is reconciled.
        return {
          ...(await broker.sign_in({
            key: keyFrom(args),
            what: asString(argument(args, 'what', 'signing_into', 'signingInto')),
            ...(argument(args, 'request_seconds', 'requestSeconds') === undefined
              ? {}
              : { requestSeconds: asSeconds(argument(args, 'request_seconds', 'requestSeconds')) }),
          })),
        };
      }

      case 'sign_in_done':
        return { ...(await broker.sign_in_done({ key: keyFrom(args) })) };

      case 'feedback':
        return await submitFeedback(db, args);
    }
  };

  return { perform };
}

/**
 * A required string argument.
 *
 * Left as loose as the service's own inputs are: `ClaimInput.browser` is
 * `string` rather than the two-literal union precisely so that an unknown
 * browser is refused by `claim.browser_known` inside the transaction, on the
 * ledger, rather than by a route quietly. So this checks that a string
 * arrived and nothing about what it says.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * An optional string argument: absent stays absent.
 *
 * The counterpart to {@link asString}, and the distinction is the whole
 * point. Coercing a missing optional argument to `''` does not produce "no
 * value" — it produces a value that happens to be empty, which every guard
 * downstream then has to treat as a real answer. `claim.browser_known`
 * correctly refused a browser named `""` for exactly that reason.
 *
 * An empty string from the caller is also read as absence. A shell cannot
 * easily express the difference between `--browser ''` and no flag at all, and
 * nothing in this service has a use for a browser whose name is empty, so
 * treating the two alike is what makes the default reachable from both
 * surfaces rather than only from the one that can omit a JSON key.
 */
function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') {
    return undefined;
  }
  return value;
}

/**
 * A duration in seconds, as each surface spells one.
 *
 * The command line has no types, so `--request-seconds=60` arrives as the two
 * characters. **A value that is not a number becomes `NaN` rather than being
 * refused here**, deliberately: the operation owns what a legal duration is,
 * and a route that refused first would answer a different question in a
 * different order than the other route does — the exact drift §8's parity
 * assertion exists to catch.
 */
function asSeconds(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * A flag, as each surface spells one.
 *
 * The command line has no types: `--full-page` with no value parses to `true`
 * and `--full-page=true` parses to the four-character string. Both mean the
 * flag was set, and a route that treated the string as truthy-by-default
 * would also treat `--full-page=false` as set.
 */
function asBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * The action, assembled from the three arguments the tool surface takes.
 *
 * `browser_act` takes `action`, `target` and `value` separately (§3.8) while
 * the service takes one request object, so the assembly happens somewhere.
 * It happens here rather than in either adapter, so both surfaces assemble it
 * identically — and it is assembly only: which action names are legal, and
 * which of them require an element reference, is validated inside the
 * operation.
 *
 * ── `target` on the surface is `ref` in the service, and it must be renamed ──
 *
 * The surface argument is described as "the element reference, from a
 * snapshot, where the action needs one", and every member of `ActionRequest`
 * that addresses an element spells that field `ref`. They are the same value
 * under two names, so one of them has to be translated into the other, and a
 * bridge that passed `target` through unchanged would build a request with
 * no `ref` at all — `act.ref_required` on every click, type, fill, select,
 * check and hover a caller ever sent, on both surfaces.
 *
 * `drag` is the one action addressing a second element, and it spells that
 * one `targetRef`; it is carried under its own name because it is a distinct
 * field rather than another spelling of this one.
 *
 * A request passed whole is passed through, which is what an in-process
 * caller writing the service's own spelling sends.
 */
function actionFrom(args: Readonly<Record<string, unknown>>): unknown {
  const whole = argument(args, 'request');
  if (whole !== undefined) {
    return whole;
  }

  const action = argument(args, 'action');
  if (action === undefined) {
    return undefined;
  }

  const ref = argument(args, 'ref', 'target');
  const value = argument(args, 'value');
  const targetRef = argument(args, 'target_ref', 'targetRef');
  const viewport = viewportFrom(args);
  const preferences = preferencesFrom(args);
  const response = argument(args, 'response');
  const fields = argument(args, 'fields');

  return {
    action,
    ...(ref === undefined ? {} : { ref }),
    ...(value === undefined ? {} : { value }),
    ...(targetRef === undefined ? {} : { targetRef }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(preferences === undefined ? {} : { preferences }),
    ...(response === undefined ? {} : { response }),
    ...(fields === undefined ? {} : { fields }),
  };
}

/**
 * The viewport a `resize` sets, assembled from whatever the caller could
 * express.
 *
 * ── Why this exists: the refusal was unsatisfiable ──────────────────────
 *
 * `validateAction` wants `viewport: { width, height }` — an object of two
 * integers. The command line produces flat strings and nothing else, so there
 * was **no argument a command-line caller could type that would ever parse**.
 * A field session tried `--value 390x844`, `390,844`, `"390 844"`, the JSON
 * object, and `--width 390 --height 844`, and got the identical refusal every
 * time:
 *
 * > A resize sets the tab's viewport, so it needs a width and a height in
 * > pixels.
 *
 * Every one of those *is* a width and a height in pixels. The message
 * describes the semantics and never the syntax, so it reads as though the
 * caller supplied the wrong kind of thing when they supplied the wrong shape
 * of thing — and there was no shape that worked. Adding the syntax to the
 * message would have been a fix for a different bug: the verb was
 * **unreachable**, not merely undocumented, and mobile-breakpoint review was
 * impossible on the only working client.
 *
 * ── What is accepted, and why more than one form ────────────────────────
 *
 * `--width 390 --height 844` is the documented pair, and `--value 390x844` is
 * accepted because it is what a person reaches for first and because a
 * viewport is conventionally written that way. Both arrive here as strings,
 * so both are coerced to integers; the tool surface's own object is passed
 * straight through, since a JSON caller can already say what it means.
 *
 * **Coercion only, never validation.** Whether a side is positive, whole and
 * within the bound is `requireViewportSide`'s decision, inside the operation,
 * on the ledger. A `NaN` from an unparseable word is handed on deliberately —
 * it fails that guard and produces the refusal a caller should get, rather
 * than a different one invented here.
 */
function viewportFrom(args: Readonly<Record<string, unknown>>): unknown {
  const given = argument(args, 'viewport');
  if (given !== undefined) {
    return given;
  }

  const width = argument(args, 'width');
  const height = argument(args, 'height');
  if (width !== undefined || height !== undefined) {
    return { width: asInteger(width), height: asInteger(height) };
  }

  // `--value 390x844`, and the two other separators a person reaches for.
  const value = argument(args, 'value');
  if (typeof value === 'string') {
    const sides = value.split(/[x×,\s]+/u).filter((part) => part !== '');
    if (sides.length === 2) {
      return { width: asInteger(sides[0]), height: asInteger(sides[1]) };
    }
  }

  return undefined;
}

/**
 * The media preferences an `emulate` sets, assembled from flat flags.
 *
 * The same unreachability as {@link viewportFrom}, and it went unreported for
 * longer because the refusal is otherwise a model of the kind this service is
 * proud of — it names its three options exactly the way `claim.browser_known`
 * names the browsers:
 *
 * > An emulate sets media preferences, so it names at least one of:
 * > colourScheme, reducedMotion, forcedColours.
 *
 * A caller reading that types `--colour-scheme dark` and is refused
 * identically, because the service wants them nested under `preferences` and
 * `parseArguments` cannot nest. So a good message pointed at a door that was
 * not there, and dark-mode review was as unreachable as the mobile breakpoint.
 *
 * The hyphenated spellings are what a terminal reads; `parseArguments`
 * normalises `--colour-scheme` to `colour_scheme`, and the service's own
 * camel-case names are accepted too so an in-process caller writing
 * `colourScheme` is understood. **Which values are legal is not decided
 * here** — the operation checks them against its table and refuses by name.
 */
function preferencesFrom(args: Readonly<Record<string, unknown>>): unknown {
  const given = argument(args, 'preferences');
  if (given !== undefined) {
    return given;
  }

  const named: Record<string, unknown> = {};
  for (const preference of MEDIA_PREFERENCE_SPELLINGS) {
    const value = argument(args, ...preference.spellings);
    if (value !== undefined) {
      named[preference.name] = value;
    }
  }

  return Object.keys(named).length === 0 ? undefined : named;
}

/**
 * Each media preference, and every spelling a caller might arrive with.
 *
 * The service's name first, then the terminal's — `parseArguments` turns
 * `--colour-scheme` into `colour_scheme`, so that is the spelling this file
 * actually receives from the command line. Both British and American
 * spellings of "colour" are read, because a caller who types the one this
 * service does not use should get a dark theme rather than a refusal that
 * looks like they named nothing at all.
 */
const MEDIA_PREFERENCE_SPELLINGS: readonly {
  readonly name: string;
  readonly spellings: readonly string[];
}[] = [
  {
    name: 'colourScheme',
    spellings: ['colourScheme', 'colour_scheme', 'colorScheme', 'color_scheme'],
  },
  { name: 'reducedMotion', spellings: ['reducedMotion', 'reduced_motion'] },
  {
    name: 'forcedColours',
    spellings: ['forcedColours', 'forced_colours', 'forcedColors', 'forced_colors'],
  },
];

/**
 * A whole number, from whatever a surface could carry.
 *
 * The command line has only strings, so `--width 390` arrives as `"390"` and
 * has to become `390` before the operation's guard can judge it. An
 * unparseable word becomes `NaN`, which that guard refuses by name — which is
 * the right refusal, and the reason nothing is validated here.
 */
function asInteger(value: unknown): unknown {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return value;
}

/**
 * The artefacts asked for, as a list.
 *
 * The tool surface takes an array; the command line can only produce a
 * string, so a comma-separated one is split. Which names are legal is the
 * operation's decision and is not checked here — an unknown name has to reach
 * the transaction to be refused there, on the ledger, rather than dropped.
 */
function artifactsFrom(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((word) => word.trim())
      .filter((word) => word.length > 0);
  }
  return value;
}

/**
 * `feedback` — the tenth operation, and the one with no arbitration handler.
 *
 * It takes no lease and touches no tab (§3.16), so there is nothing for the
 * arbitration runner to arbitrate; it validates and appends a row. That is
 * why it is not a {@link Broker} method and why this is the one branch above
 * that does not call one.
 *
 * The validation is `refuseSubmission`, which is the module that owns it —
 * the same function the surfaces would otherwise each have had to call, which
 * is exactly the duplication that puts a rule on one route and not another.
 */
async function submitFeedback(
  db: Database,
  args: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const rawRating = argument(args, 'rating');
  const rating =
    typeof rawRating === 'string' && /^\d+$/u.test(rawRating) ? Number(rawRating) : rawRating;
  const category = argument(args, 'category');
  const note = argument(args, 'note');

  const refusal = refuseSubmission({ rating, category, note });
  if (refusal !== undefined) {
    throw new BrokerError(refusal.rule, refusal.message);
  }

  // `refuseSubmission` has just established all three, but it returns a
  // refusal rather than a narrowed type, so the compiler does not know it.
  // These re-check rather than assert: a cast would be this file claiming a
  // fact, and if `refuseSubmission` ever stopped checking one of the three
  // the cast would carry the gap into the database while this throws.
  if (
    typeof rating !== 'number' ||
    typeof category !== 'string' ||
    !isFeedbackCategory(category) ||
    typeof note !== 'string'
  ) {
    throw new BrokerError(
      'feedback.validated',
      'The submission passed validation but is not the shape validation promises. This is a fault in this build rather than anything the caller did.',
    );
  }

  const sessionId = argument(args, 'session_id', 'sessionId');
  const leaseKey = argument(args, 'lease_key', 'leaseKey', 'key');

  // `leaseKeyHash` and not the key itself. `record.ts` states the rule and
  // states that the hashing "belongs to the service layer (row #10) and is
  // not built here" — so this is the layer that owes it, and supplying it is
  // what attaches a feedback row to the lease it was written about. Until
  // now the column was null on every row, which was the documented no-lease
  // path standing in for a capability that had nowhere to live.
  //
  // A key is hashed and discarded in the same expression; nothing downstream
  // of here holds the secret.
  const submission: FeedbackSubmission = {
    rating,
    category,
    note,
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof leaseKey === 'string' && leaseKey.length > 0
      ? { leaseKeyHash: hashKey(leaseKey) }
      : {}),
  };

  const recorded = await recordFeedback(db, submission);
  return { id: recorded.id, recorded: true };
}
