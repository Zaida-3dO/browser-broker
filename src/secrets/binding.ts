import type { SecretFieldKind } from './resolver.ts';

/**
 * Which kind of field an element is, for the rule that a secret only goes
 * into a field of a kind it was declared for.
 *
 * Pure, over facts the driver reads off the element, so the heuristic is
 * testable without a browser and stated in one place.
 *
 * ── The heuristic, stated so it can be argued with ──────────────────────
 *
 * - **password** — an `<input>` whose `type` is `password`. Nothing else.
 * - **otp** — an `<input>` whose `autocomplete` tokens include
 *   `one-time-code`. That token is the standard's own name for the thing, so
 *   no guessing from names is done.
 * - **username** — an `<input>` that is not a password field and either
 *   declares `autocomplete` `username` or `email`, or has `type=email`, or has
 *   `type=text` (or no type) **and** a `name` or `id` containing one of
 *   `user`, `login`, `email`, `account` or `identifier`.
 *
 * One element can be more than one kind (a text input named `login` with
 * `autocomplete=one-time-code`); every kind it matches is returned and the
 * binding passes if any of them was declared. Anything that is not an
 * `<input>` — a `<textarea>`, a content-editable region — matches nothing.
 */

/** What the driver reads off the target element. All lower-cased by the reader. */
export interface ElementFacts {
  readonly tag: string;
  /** The `type` attribute as written, or empty. */
  readonly type: string;
  readonly autocomplete: string;
  readonly name: string;
  readonly id: string;
}

const USERNAME_HINT = /user|login|email|account|identifier/u;

/** Every field kind this element counts as. Empty when it is none of them. */
export function fieldKindsOf(facts: ElementFacts): SecretFieldKind[] {
  if (facts.tag !== 'input') return [];
  const type = facts.type.trim().toLowerCase() || 'text';
  const tokens = facts.autocomplete.toLowerCase().split(/\s+/u).filter(Boolean);
  const kinds: SecretFieldKind[] = [];

  if (type === 'password') {
    kinds.push('password');
  }
  if (tokens.includes('one-time-code')) {
    kinds.push('otp');
  }
  if (type !== 'password') {
    const declared = tokens.includes('username') || tokens.includes('email');
    const emailType = type === 'email';
    const named =
      type === 'text' &&
      (USERNAME_HINT.test(facts.name.toLowerCase()) || USERNAME_HINT.test(facts.id.toLowerCase()));
    if (declared || emailType || named) {
      kinds.push('username');
    }
  }
  return kinds;
}

/** The first declared kind this element matches, or `undefined` when none. */
export function boundFieldKind(
  facts: ElementFacts,
  allowed: readonly SecretFieldKind[],
): SecretFieldKind | undefined {
  return fieldKindsOf(facts).find((kind) => allowed.includes(kind));
}

/**
 * The origin of a frame's address, or `undefined` when it has none a secret
 * could be bound to.
 *
 * `about:blank`, `data:` and `srcdoc` frames report the opaque origin `null`
 * here, and are refused: what they inherit is not visible from the address,
 * and a binding is only as good as the fact it is checked against.
 */
export function originOfAddress(address: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  return parsed.origin;
}
