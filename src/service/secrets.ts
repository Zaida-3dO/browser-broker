import type { Database } from 'better-sqlite3';

import type { SecretScope, ValidatedAction } from '../browser/driver.ts';
import type { SecretResolver } from '../secrets/resolver.ts';
import { containsSentinel, looksLikeSentinel, sentinelName } from '../secrets/sentinel.ts';
import { append, type EventAdapter } from './events.ts';
import { PageRefusal } from './pages.ts';

/**
 * The service's half of secrets (`SCHEMA.md` §3.8a): where a sentinel may be
 * written, whether one can be resolved at all, which tabs have received one,
 * and the ledger row for each use.
 *
 * The browser's half — resolving at the sink, the origin and field binding,
 * scrubbing — is in the real driver, because every one of those needs the
 * page. Every rule that can be decided **without** the page is decided here,
 * before anything is written, so it is a refusal like any other: no lease
 * renewed, no event appended, no tab reached.
 */

/** The message every misplaced sentinel is refused with, completed per position. */
function misplaced(rule: string, where: string): PageRefusal {
  return new PageRefusal(
    rule,
    `A secret sentinel ({{secret:NAME}}) was found in ${where}. Secrets are only resolved as the whole value of a type or fill action, or of a fill_form field — anywhere else the sentinel would be used as literal text, so the call is refused instead. NAME is 1 to 128 letters, digits, or . _ / -.`,
  );
}

/**
 * Refuse an action that puts a sentinel anywhere it is not resolved, and
 * return the names it asks for.
 *
 * Permitted: the whole `value` of `type` or `fill`, and the whole `value` of a
 * `fill_form` field — each exactly one well-formed sentinel. Anything else that
 * contains `{{secret:` is refused: a key press, an option to select, a
 * dialog's prompt text, an element reference, an upload's name, a sentinel
 * embedded in other text, or a malformed one.
 */
export function requestedSecretNames(action: ValidatedAction): string[] {
  const names: string[] = [];
  const permitted = (value: string, where: string): void => {
    if (!looksLikeSentinel(value)) return;
    const name = sentinelName(value);
    if (name === undefined) {
      throw misplaced(
        'act.secret_placement',
        `${where}, but not as one well-formed sentinel making up the whole value`,
      );
    }
    names.push(name);
  };

  switch (action.action) {
    case 'type':
    case 'fill': {
      permitted(action.value, `the value of a ${action.action}`);
      const { value: _value, ...rest } = action;
      void _value;
      if (containsSentinel(rest)) throw misplaced('act.secret_placement', 'an element reference');
      return names;
    }
    case 'fill_form': {
      action.fields.forEach((field, index) => {
        permitted(field.value, `field ${String(index)} of a fill_form`);
        if (looksLikeSentinel(field.ref)) {
          throw misplaced('act.secret_placement', 'an element reference');
        }
      });
      return names;
    }
    default:
      if (containsSentinel(action)) {
        throw misplaced('act.secret_placement', `a ${action.action} action`);
      }
      return names;
  }
}

/** Refuse a sentinel in an operation that never resolves one. */
export function refuseSentinelIn(value: unknown, rule: string, where: string): void {
  if (containsSentinel(value)) throw misplaced(rule, where);
}

/** Refuse a sentinel-carrying action when no resolver is configured. */
export function refuseUnresolvable(names: readonly string[], resolver: unknown): void {
  if (names.length > 0 && resolver === undefined) {
    throw new PageRefusal(
      'act.secret_resolver_configured',
      'This service has no secret resolver configured, so a secret sentinel cannot be resolved and nothing was typed. An operator sets BROKER_SECRET_RESOLVER to a command that answers "resolve NAME" with the secret as JSON; until then, secrets are off.',
    );
  }
}

/** The secret names a tab has received in its lease, in the order first received. */
export function receivedSecretNames(db: Database, tabId: string): string[] {
  const rows = db
    .prepare('SELECT name FROM tab_secrets WHERE tab_id = ? ORDER BY first_at, name')
    .all(tabId) as { name: string }[];
  return rows.map((row) => row.name);
}

/** Record that a tab is about to receive these secrets. Idempotent per name. */
export function recordSecretsRequested(
  db: Database,
  tabId: string,
  names: readonly string[],
): void {
  const insert = db.prepare('INSERT OR IGNORE INTO tab_secrets (tab_id, name) VALUES (?, ?)');
  for (const name of names) insert.run(tabId, name);
}

/** Refuse `evaluate` on a tab that has received a secret. */
export function refuseEvaluateOnSecretTab(db: Database, tabId: string): void {
  if (receivedSecretNames(db, tabId).length > 0) {
    throw new PageRefusal(
      'evaluate.secret_tab',
      'This tab has received a secret in this lease, so evaluate is refused on it for the rest of the lease: an expression can read any field on the page, and its result comes straight back to you. Read the page with browser_read, or capture it — both are scrubbed. To evaluate freely again, release this lease and claim a fresh tab.',
    );
  }
}

/** Where a secret's use is recorded. */
export interface SecretLedgerContext {
  readonly db: Database;
  readonly adapter: EventAdapter;
  readonly claimId: string;
  readonly tabId: string;
  readonly sessionId: string;
  readonly browserId: string;
}

/**
 * The scope a driver is handed, or `undefined` when nothing about this call
 * involves a secret — no sentinel requested, and none received before.
 *
 * A tab that has received a secret but whose installation has since lost its
 * resolver gets a scope whose every resolution refuses: an output that cannot
 * be scrubbed is not produced, rather than produced unscrubbed.
 */
export function secretScopeFor(
  resolver: SecretResolver | undefined,
  received: readonly string[],
  requested: readonly string[],
  ledger: SecretLedgerContext,
): SecretScope | undefined {
  if (received.length === 0 && requested.length === 0) return undefined;
  return {
    resolve:
      resolver ??
      ((name: string) =>
        Promise.reject(
          new PageRefusal(
            'act.secret_resolver_configured',
            `This tab has received the secret "${name}", and no secret resolver is configured to resolve it again for scrubbing, so nothing was read from the page. Set BROKER_SECRET_RESOLVER, or release this lease.`,
          ),
        )),
    received,
    record: (use) => {
      const detail = {
        name: use.name,
        ...(use.origin === undefined ? {} : { origin: use.origin }),
        ...(use.field === undefined ? {} : { field: use.field }),
      };
      append(ledger.db, {
        kind: 'secret_filled',
        adapter: ledger.adapter,
        claimId: ledger.claimId,
        tabId: ledger.tabId,
        sessionId: ledger.sessionId,
        browserId: ledger.browserId,
        detail,
        ...(use.outcome === 'allow'
          ? { outcome: 'allow' as const }
          : { outcome: 'deny' as const, guard: use.rule ?? 'act.secret_typed' }),
      });
    },
  };
}
