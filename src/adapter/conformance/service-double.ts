import type {
  BrokerService,
  OperationOutcome,
  OperationRequest,
  RuleRegistry,
} from '../service-seam.ts';
import type { ConformanceSubject } from './run.ts';

/**
 * A service double that enforces the rules the case table names.
 *
 * ── Read this before trusting anything built on it ──────────────────────
 *
 * **This is not the service, and it is not a preview of the service.** The
 * service layer is row #10 onward and is not on `main`. This double exists so
 * that rows #25 and #29 have something behind their seam that *refuses*, and
 * so the suite they ship can be run and watched to fail rather than being a
 * harness nobody has ever seen do its job.
 *
 * **What the suite therefore proves right now, stated exactly:** that each
 * route carries an outcome faithfully — the code and rule name the service
 * produced arrive at the caller unchanged, and a refusal leaves the browser
 * untouched and the claim count unmoved. It does **not** prove that the rules
 * are correct, because the rules here are this file's, not the service's.
 *
 * When the real service lands, this file is replaced by it as the suite's
 * subject. The cases do not change, the drivers do not change, and the
 * assertions do not change — that substitution is what this seam is for, and
 * it is also the honest measure of how much of the parity claim this row
 * makes real. A reader who assumed otherwise would be over-reading a green run,
 * which is precisely the thing this repository's own gate says a green run
 * does not discharge.
 *
 * ── Why the rules live in it rather than in the adapters ────────────────
 *
 * Because that is the property under test. If this double let the adapters
 * decide anything, the suite would be comparing two routes' private rules and
 * calling their agreement parity. Every refusal below is produced here, once,
 * and both halves of the assertion — the outcome and the physical effect —
 * are read from this one place.
 */

/** The rules this double can refuse with. Every one is named by a case. */
export const DOUBLE_RULE_REGISTRY: RuleRegistry = {
  names: [
    'key.present',
    'key.valid',
    'claim.browser_known',
    'navigate.scheme_allowed',
    'act.verb_known',
    'evaluate.expression_bounded',
    'capture.exclusive_mode',
    'feedback.rating_in_scale',
  ],
};

/** §3.8's fixed list, as far as this double needs it. */
const KNOWN_ACTIONS = new Set([
  'click',
  'type',
  'fill',
  'press',
  'select',
  'hover',
  'check',
  'scroll',
  'resize',
  'emulate',
  'dialog',
]);

const KNOWN_BROWSERS = new Set(['regular', 'private']);
const EXPRESSION_CAP = 4096;
const VALID_KEYS = new Set(['lease-key-placeholder']);

function refuse(code: string, rule: string, message: string): OperationOutcome {
  return { outcome: 'refused', code, rule, message };
}

/**
 * Read an argument as a string, or as nothing.
 *
 * Arguments arrive as `unknown` because the envelope is deliberately untyped
 * at this seam (`service-seam.ts`), and coercing one with `String()` would
 * turn an object into `[object Object]` and then compare *that* against a
 * rule's allowed values. The comparison would still be a comparison, so
 * nothing would fail — it would simply be checking a value nobody sent. A
 * narrowing read makes a non-string argument absent rather than plausible.
 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * One service double, with the two physical readings the suite compares.
 *
 * The browser call log and the live claim count are this double's own,
 * because the point of the assertion is that **a refusal never reaches
 * either**. An accepted operation touches both; a refused one must touch
 * neither, and the runner reads both before and after.
 */
export function makeServiceDouble(): ConformanceSubject {
  const calls: { readonly name: string }[] = [];
  let liveClaims = 0;

  const perform = (request: OperationRequest): Promise<OperationOutcome> => {
    const args = request.arguments;
    const key = typeof args['lease_key'] === 'string' ? args['lease_key'] : undefined;

    // Every operation except requesting a lease carries a key (§7.1
    // `key.present`), and every keyed call extends the lease (§3.1).
    if (request.operation !== 'claim' && request.operation !== 'feedback') {
      if (key === undefined) {
        return Promise.resolve(
          refuse(
            'key_missing',
            'key.present',
            'This operation needs the lease key. Pass --lease-key.',
          ),
        );
      }
      if (!VALID_KEYS.has(key)) {
        return Promise.resolve(
          refuse('unrecognised_key', 'key.valid', 'That key matches no lease. Claim one first.'),
        );
      }
    }

    switch (request.operation) {
      case 'claim': {
        const browser = readString(args['browser']) ?? '';
        if (!KNOWN_BROWSERS.has(browser)) {
          return Promise.resolve(
            refuse(
              'unknown_browser',
              'claim.browser_known',
              'There are two browsers: regular and private. Pick one deliberately.',
            ),
          );
        }
        // Accepted: the physical effect happens, and both readings move.
        calls.push({ name: 'openTab' });
        liveClaims += 1;
        return Promise.resolve({ outcome: 'accepted', value: { state: 'active', browser } });
      }

      case 'navigate': {
        const url = readString(args['url']) ?? '';
        if (!/^https?:\/\//u.test(url) && url !== 'about:blank') {
          return Promise.resolve(
            refuse(
              'invalid_address',
              'navigate.scheme_allowed',
              'Ordinary web traffic or a blank page. A local-file address is refused.',
            ),
          );
        }
        calls.push({ name: 'navigate' });
        return Promise.resolve({ outcome: 'accepted', value: { url } });
      }

      case 'act': {
        const action = readString(args['action']) ?? '';
        if (!KNOWN_ACTIONS.has(action)) {
          return Promise.resolve(
            refuse(
              'unknown_action',
              'act.verb_known',
              `Not an action. The actions are: ${[...KNOWN_ACTIONS].join(', ')}.`,
            ),
          );
        }
        calls.push({ name: 'act' });
        return Promise.resolve({ outcome: 'accepted', value: { action } });
      }

      case 'evaluate': {
        const expression = readString(args['expression']) ?? '';
        if (expression.length > EXPRESSION_CAP) {
          return Promise.resolve(
            refuse(
              'expression_too_long',
              'evaluate.expression_bounded',
              `That expression is over the ${String(EXPRESSION_CAP)}-character cap.`,
            ),
          );
        }
        calls.push({ name: 'evaluate' });
        return Promise.resolve({ outcome: 'accepted', value: { value: '2' } });
      }

      case 'capture': {
        if (args['selector'] !== undefined && args['full_page'] !== undefined) {
          return Promise.resolve(
            refuse(
              'cannot_do_both',
              'capture.exclusive_mode',
              'A selector and a full page cannot both be asked for. Pick one.',
            ),
          );
        }
        calls.push({ name: 'read' });
        return Promise.resolve({ outcome: 'accepted', value: { path: 'a-capture.png' } });
      }

      case 'feedback': {
        const rating = Number(args['rating']);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
          return Promise.resolve(
            refuse(
              'rating_out_of_range',
              'feedback.rating_in_scale',
              'The scale is 1 to 5, where 1 got in the way and 5 helped.',
            ),
          );
        }
        return Promise.resolve({ outcome: 'accepted', value: { recorded: true } });
      }

      case 'release': {
        liveClaims = Math.max(0, liveClaims - 1);
        calls.push({ name: 'closeTab' });
        return Promise.resolve({ outcome: 'accepted', value: { state: 'released' } });
      }

      case 'tab_replace': {
        calls.push({ name: 'closeTab' });
        calls.push({ name: 'openTab' });
        return Promise.resolve({ outcome: 'accepted', value: { state: 'active' } });
      }

      case 'status': {
        return Promise.resolve({ outcome: 'accepted', value: { state: 'active' } });
      }

      case 'read': {
        calls.push({ name: 'read' });
        return Promise.resolve({ outcome: 'accepted', value: { snapshot: 'a-snapshot.txt' } });
      }
    }
  };

  const service: BrokerService = { perform };

  return {
    service,
    driverCalls: () => [...calls],
    liveClaimCount: () => liveClaims,
  };
}
