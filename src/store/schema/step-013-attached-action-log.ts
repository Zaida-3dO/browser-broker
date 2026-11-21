import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step thirteen: the attached lease's action log, and the last address a tab
 * actually reached (§3.5 of the attach safety plan).
 *
 * ── The log: what §3.5 promises on "Visible" ──────────────────────────────
 *
 * The attached kind's visibility story is that an acting lease leaves a trail
 * a person can read: the debugger bar, the titled tab group, and **an action
 * log per lease in the store**. Every acting call that **reaches the
 * session** — performed, or refused by the session's own gate — lands one
 * row here: the lease, the verb, the reference it named, the accessible
 * name the page reported for that reference, the host, and the outcome.
 * A refusal at the service door never reaches the session and leaves only
 * the events `deny` row: the ledger across both tables answers "was this
 * call allowed or refused", and this table answers *"what was it trying to
 * do, to what, and why did it not happen"* — including the grant verdicts, whose rows
 * name the **verdict** (forged, expired, replayed) and never a token: the
 * grant travels through the service and is written nowhere, the same
 * carried-never-echoed rule the attach token and the secret live by.
 *
 * **No foreign key on `claim_id`, deliberately.** A lease is reclaimed, its
 * claims row swept, and the audit outlives both — an audit table whose rows
 * vanish when the thing audited ends audits nothing. Every existing
 * reference in the schema is `ON DELETE`-surviving only by never being
 * deleted; this one is simply not a reference, and the comment is here so
 * the next reader does not "fix" it.
 *
 * `outcome` is `acted`, or the §7.1 rule that refused. The `substr` check is
 * not a taxonomy duplicate worth keeping in lockstep with `gate.ts`'s union;
 * it is a shape check — a row whose outcome is neither the success word nor
 * a rule name is a write path that has drifted, and this catches the drift
 * without requiring every new refusal name to edit the schema.
 *
 * ── The column: where a tab *is*, as opposed to where it was asked to go ─
 *
 * The acting site fence is a **service-layer** rule — an off-list act must
 * refuse on the wire, with no `allow` row and no after-commit closure, so no
 * tab opens on the way to the refusal (§13n's two-door finding: a refusal
 * that arrives after the browser was reached is a refusal that did not
 * happen). Asked at the service layer, it needs the page's host **before any
 * browser call**, and the only honest source is where the tab actually
 * arrived: the *requested* address is not it — a cross-origin redirect lands
 * the tab on another site entirely, and `decideNavigate`'s own header records
 * what reporting the request instead of the arrival once cost. So the
 * navigation records its arrival here, on the same after-commit path that
 * already carries the driver name, and the site fence reads it.
 *
 * Absent means no navigation has committed for that tab — the honest answer
 * for a tab still at the blank page, which the fence reads as *not on any
 * list* and refuses an act on.
 */
const STATEMENTS: readonly string[] = [
  `
ALTER TABLE tabs ADD COLUMN last_url TEXT
`,
  `
CREATE TABLE attached_actions (
  id             INTEGER PRIMARY KEY,
  -- The lease, not a caller: the audit question §3.5 asks is per lease.
  claim_id       TEXT NOT NULL,
  -- The driver's name for the tab. Not the opaque tab id — the session
  -- writes this row inside the after-commit half, and the driver's name is
  -- what it knows. Deliberately not a foreign key: see the header.
  driver_tab_id  TEXT,
  verb           TEXT NOT NULL,
  -- The reference the call named, as the call named it. Meaningless for the
  -- verbs that address no element (dialog, fill_form's own per-field rows),
  -- and absent for them rather than empty.
  ref            TEXT,
  -- The accessible name the **page** reported for that reference at act
  -- time — this is what a reader greps for to see which button was refused,
  -- and why the row is worth more than the verb alone.
  accessible_name TEXT,
  -- The host as the navigation's arrival reported it — the same fact the
  -- site fence is enforced against, so the row and the rule cannot tell
  -- different stories about the same act.
  host           TEXT,
  outcome        TEXT NOT NULL
                 CHECK (outcome = 'acted' OR substr(outcome, 1, 9) = 'attached.'),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT
`,
];

/** Every statement this step runs, in order. */
export const STEP_THIRTEEN_SQL: readonly string[] = STATEMENTS;

export const stepThirteen: Step = {
  version: 13,
  summary:
    'The attached action log per lease, and `tabs.last_url` — where a tab actually arrived, which is what the site fence is asked against.',
  apply: (db: Database) => {
    for (const statement of STEP_THIRTEEN_SQL) {
      db.exec(statement);
    }
  },
};
