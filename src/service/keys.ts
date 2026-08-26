import { createHash, randomBytes } from 'node:crypto';

/**
 * The lease key: minted once, returned once, and never stored.
 *
 * §1.3 states the property this module exists to keep: **the secret key is
 * never stored** — the claims table holds a one-way hash of it, and every
 * call that carries a key hashes what it was handed and looks the lease up by
 * that value.
 *
 * ── The consequence, which is a price rather than an oversight ──────────
 *
 * §2.2: **a caller that loses the response to its own request cannot get that
 * lease back.** It waits the lease out, or asks an operator to revoke it.
 * There is no recovery path and there is deliberately no second copy to build
 * one from — a stored key would be a credential this service holds on a
 * caller's behalf, and the whole reason it does not is that it then cannot
 * leak one.
 *
 * ── Why a plain hash and not a password-hashing function ────────────────
 *
 * The usual reason to make hashing slow is that the input is a human-chosen
 * password with little entropy, so an attacker who takes the table can guess
 * candidates faster than they can be checked. **Neither half applies here.**
 * The input is {@link KEY_BYTES} bytes from the platform's own random source,
 * so there is no candidate list to work through; and the hash is read inside
 * the arbitration transaction, with every other caller on the machine
 * serialised behind it (§1.0a), so a deliberately slow function would be a
 * deliberately slow lock.
 *
 * **What that trade rests on is the entropy**, which is why it is a constant
 * with a comment rather than a number somebody can lower to make a key
 * prettier.
 */

/**
 * How many random bytes a key carries.
 *
 * Thirty-two bytes from the platform's cryptographic source. This is the
 * assumption the fast hash above rests on: lower it far enough and guessing
 * becomes possible, at which point the reasoning for a plain hash stops
 * holding and the change that broke it is one number in this file.
 */
export const KEY_BYTES = 32;

/**
 * Mint a key. The only place one is created.
 *
 * The value is a base64url string so it survives every transport this service
 * has — a command line argument, an environment variable, a field in a
 * structured message — without escaping, and so a caller copying one out of a
 * terminal cannot pick up a character that was really formatting.
 */
export function mintKey(): string {
  return randomBytes(KEY_BYTES).toString('base64url');
}

/**
 * Hash a key for storage and for lookup.
 *
 * Unsalted, deliberately, and this is the one place that word should appear
 * in this service. A salt exists to stop one precomputed table covering every
 * row at once, which is a defence against low-entropy inputs; with a
 * {@link KEY_BYTES}-byte random input there is nothing to precompute. And a
 * per-row salt would make lookup impossible: finding the lease for a key
 * means hashing the key and matching a column, and a salted scheme would have
 * to read every row and hash against each one — inside the transaction every
 * other caller is waiting behind.
 */
export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
