import type { Database } from 'better-sqlite3';

import type { Step } from './steps.ts';

/**
 * Step one: the whole schema.
 *
 * **This step is history the moment it has run anywhere.** Every change after
 * it is a new step with an `ALTER`, never an edit to this file — a step that
 * has run somewhere means two installations reporting the same version with
 * different schemas, which nothing reports until something breaks far from the
 * cause (`SCHEMA.md` §1.2d, `MILESTONES.md` #7).
 *
 * ── Why this is raw SQL ─────────────────────────────────────────────────
 *
 * The schema is written in the language the database speaks rather than
 * generated from a model of it, so there are not two descriptions of one
 * schema to reconcile (`SCHEMA.md` §1.11). Two of the things below cannot be
 * expressed by most model layers at all: a **partial** unique index, and a
 * **composite** foreign key naming a two-column target.
 *
 * ── Conventions that hold on every table, so they are stated once ────────
 *
 * `SCHEMA.md` §1.1:
 *
 * - **Time is a timestamp and every process reads the same clock.** Stored in
 *   a single fixed textual form that sorts in chronological order, so a
 *   comparison is a comparison and needs no conversion inside a transaction
 *   every other caller is waiting behind. The default is read from the
 *   database's own clock, never from a value a caller computed — several
 *   processes are running by design (§1.0a) and two of them disagreeing by a
 *   second would make an expiry non-deterministic in a way nothing will ever
 *   reproduce.
 * - **`created_at` and `updated_at` are on every table.**
 * - **Identifiers are opaque text**, except `browsers.id`, which is one of two
 *   words because callers type it, and the two counter keys, which count
 *   upward because they double as a cursor.
 *
 * Enums are `CHECK` constraints rather than a lookup table: the value sets are
 * fixed by this design, and a join to read a word the row already spells is a
 * cost paid on every read to buy nothing.
 */

/**
 * The clock every default reads.
 *
 * Sub-second precision, because two leases created in the same second are
 * ordinary at this rate and the queue is ordered by `created_at` (§1.5). The
 * tie-break on `id` is what settles the remainder; a whole-second clock would
 * push far too much onto it.
 */
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * `browsers` — a fixed two-row table (§1.2).
 *
 * The two allowed values are enforced by the check and the primary key makes
 * each unique, so **at most** two rows can exist; the seed at the bottom of
 * this step creates both, so **at least** two do. There is no create or delete
 * operation for a browser on any surface (§3.13), so the pair is fixed.
 *
 * `UNIQUE (id, browser_id)`-style composite target: `claims` gets one below,
 * not this table.
 */
const BROWSERS = `
CREATE TABLE browsers (
  id            TEXT PRIMARY KEY
                CHECK (id IN ('regular', 'private')),
  state         TEXT NOT NULL DEFAULT 'stopped'
                CHECK (state IN ('stopped', 'starting', 'running', 'signing-in', 'failed')),
  -- The isolation fact: the service acts on the process recorded here and on
  -- nothing else, so a browser somebody else is running is never touched.
  pid           INTEGER,
  launched_at   TEXT,
  -- A claim, never a proof (1.2c). It survives the browser dying, so nothing
  -- may attach on the strength of this column without checking first.
  endpoint      TEXT,
  -- What makes the endpoint safe to trust once it has been checked: a port
  -- can be handed to something else entirely after the browser that had it
  -- exits, and matching the port alone would attach to a stranger.
  browser_uuid  TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0
                CHECK (restart_count >= 0),
  created_at    TEXT NOT NULL DEFAULT (${NOW}),
  updated_at    TEXT NOT NULL DEFAULT (${NOW}),
  -- A stopped browser has no process, and a running one has one. Stated as a
  -- constraint rather than as a convention because 'pid is null' is what the
  -- reclamation path branches on.
  CHECK ((state = 'stopped') = (pid IS NULL))
) STRICT
`;

/**
 * `claims` — the lease (§1.3). The entity the whole service is about.
 *
 * **The secret key is never stored.** `key_hash` is a one-way hash of it, and
 * every call that carries a key hashes what it was handed and looks the lease
 * up by this value.
 */
const CLAIMS = `
CREATE TABLE claims (
  id            TEXT PRIMARY KEY,
  key_hash      TEXT NOT NULL UNIQUE,
  -- Not a foreign key, and there is no table of sessions: session identity is
  -- a shared key this service does not own, so a constraint here would mean
  -- inventing a registry for something another system mints.
  session_id    TEXT NOT NULL,
  browser_id    TEXT NOT NULL REFERENCES browsers (id),
  state         TEXT NOT NULL
                CHECK (state IN ('queued', 'active', 'released', 'expired', 'revoked')),
  -- Mandatory, and its justification is revoking: an operator taking capacity
  -- off a caller decides which caller, and session_id is a key another system
  -- minted. Three to two hundred characters (1.3).
  purpose       TEXT NOT NULL
                CHECK (length(purpose) BETWEEN 3 AND 200),
  -- One column for both live states: queued and active leases expire by the
  -- same mechanism and only the duration differs.
  expires_at    TEXT NOT NULL,
  -- The duration in force for this lease, fixed when it entered its current
  -- state. A renewal has to extend by the duration the caller was told.
  ttl_seconds   INTEGER NOT NULL
                CHECK (ttl_seconds > 0),
  activated_at  TEXT,
  renew_count   INTEGER NOT NULL DEFAULT 0
                CHECK (renew_count >= 0),
  -- When the lease actually lapsed, which is not when a sweep noticed (2.4a).
  expired_at    TEXT,
  ended_at      TEXT,
  revoke_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (${NOW}),
  updated_at    TEXT NOT NULL DEFAULT (${NOW}),
  -- An operator taking capacity off a caller owes a sentence, and the
  -- caller's next call is refused with it. Required only when revoked, and
  -- meaningless otherwise, so both halves are said.
  CHECK ((state = 'revoked') = (revoke_reason IS NOT NULL)),
  -- Final is final, and a final lease has an end (2.1). One column rather
  -- than three, because state already says which.
  CHECK ((state IN ('released', 'expired', 'revoked')) = (ended_at IS NOT NULL)),
  -- Null forever on a lease that expired while waiting, and set at the moment
  -- a lease stops waiting. A queued lease has never had a tab.
  CHECK (state <> 'queued' OR activated_at IS NULL)
) STRICT
`;

/**
 * `tabs` — the unit of capacity and the unit of ownership (§1.4).
 *
 * **There is no column recording where a tab is**, and that deliberate absence
 * is the single largest privacy improvement in this design. A table of
 * addresses kept over months is a browsing history; there is no such table, so
 * there is no retention setting to get wrong and no clear-history command to
 * build. `captures.url` is a different column and survives — it records what
 * one picture was of, which a tab's later address is not.
 *
 * **The composite foreign key is the reason `foreign_keys` is set explicitly
 * in `open.ts`.** `claim_id` alone would let a tab name a browser its own
 * lease did not; naming the pair makes the database refuse it. That target
 * needs `claims (id, browser_id)` to be unique, which is what the index below
 * provides — free, given `id` is already unique.
 */
const TABS = `
CREATE TABLE tabs (
  id             TEXT PRIMARY KEY,
  -- The ownership fact. Set once, never null, never changed — which is why
  -- "one live lease per tab" is structural rather than an index (1.11).
  claim_id       TEXT NOT NULL,
  -- A copy of the lease's browser, kept because a uniqueness rule can only be
  -- written over columns on one row. It cannot drift: the composite key below
  -- refuses a tab whose browser disagrees with its lease's.
  browser_id     TEXT NOT NULL,
  -- Whatever the automation tool calls this tab. Never returned to a caller
  -- on any surface — it is the tool's namespace, and exposing it hands
  -- callers a second, non-opaque way to name a tab.
  driver_tab_id  TEXT,
  -- 'closing' is not ceremony: it is the honest representation of "the tool
  -- was asked and has not answered", and it is what stops a page that may
  -- still exist being counted as free.
  state          TEXT NOT NULL
                 CHECK (state IN ('opening', 'open', 'closing', 'closed', 'failed')),
  opened_at      TEXT,
  closed_at      TEXT,
  -- A leaked tab, not a leaked lease (2.4b): the budget is not affected, a
  -- page is. This is the flag the clear-a-leaked-tab operation selects on.
  close_failed   INTEGER NOT NULL DEFAULT 0
                 CHECK (close_failed IN (0, 1)),
  close_attempts INTEGER NOT NULL DEFAULT 0
                 CHECK (close_attempts >= 0),
  created_at     TEXT NOT NULL DEFAULT (${NOW}),
  updated_at     TEXT NOT NULL DEFAULT (${NOW}),
  FOREIGN KEY (claim_id, browser_id) REFERENCES claims (id, browser_id),
  -- A tab that has not opened has no driver name to be unique against, and
  -- one that has opened does. Without this the partial unique index below
  -- would be satisfied by any number of live rows holding null.
  CHECK ((state = 'opening') = (driver_tab_id IS NULL))
) STRICT
`;

/**
 * `events` — one row per decision, kept in order (§1.6).
 *
 * **Every decision, allowed and refused alike.** A record containing only
 * refusals cannot answer "was this rule ever actually reached", which is the
 * first question anybody asks the day something behaves oddly.
 *
 * The kind list is fixed rather than free text, because a typo in free text
 * creates a phantom category every count then silently misses. It is added to
 * only when the code that writes a new kind exists — which is why this list is
 * exactly the one §1.6 names and not one entry more.
 */
const EVENTS = `
CREATE TABLE events (
  -- Counts upward because it doubles as an "everything since here" cursor.
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- For an expiry this is not when the lease lapsed; that is claims.expired_at
  -- and 2.4a says why it is recorded separately.
  at         TEXT NOT NULL DEFAULT (${NOW}),
  kind       TEXT NOT NULL
             CHECK (kind IN (
               'claim_requested', 'claim_granted', 'claim_queued', 'claim_promoted',
               'claim_renewed', 'claim_released', 'claim_expired', 'claim_revoked',
               'tab_opening', 'tab_open_failed', 'tab_closing',
               'navigate', 'act', 'read', 'evaluate', 'capture', 'compare',
               'browser_launched', 'browser_adopted', 'browser_exited',
               'launch_race_lost', 'sweep'
             )),
  -- Separate from kind so "how often is this refused" is one question rather
  -- than a set of parallel event names that have to be kept in step.
  outcome    TEXT NOT NULL
             CHECK (outcome IN ('allow', 'deny')),
  -- Which rule refused, named from section 7's list.
  guard      TEXT,
  claim_id   TEXT REFERENCES claims (id),
  tab_id     TEXT REFERENCES tabs (id),
  -- The one denormalisation in the schema that earns its place outright: a
  -- refused request never becomes a lease, so without this column every
  -- refusal on the busiest rule in the service is anonymous.
  session_id TEXT,
  -- Which door the call came in through. The last value is work the service
  -- did on its own behalf inside somebody else's call — not a background job,
  -- because with no long-lived process there is nothing running in the
  -- background, so a sweep is attributed to the call that performed it.
  adapter    TEXT NOT NULL
             CHECK (adapter IN ('tool-stdio', 'tool-http', 'cli', 'internal')),
  -- A record, not a restriction: nothing refuses anything on the strength of
  -- this column.
  browser_id TEXT REFERENCES browsers (id),
  -- The rest, shaped per kind. One queryable stream: a column per kind would
  -- be a wide, mostly-empty table, and a table per kind would turn every read
  -- of the ledger into a fifteen-way union.
  detail     TEXT,
  -- A guard names the rule that refused, so it belongs on a denial and means
  -- nothing on an allow.
  CHECK ((outcome = 'deny') = (guard IS NOT NULL))
) STRICT
`;

/**
 * `captures` — what a picture cost (§1.7).
 *
 * `path` is **relative to the artifact root, never absolute** (§1.7a). The
 * root can move, and an absolute path pins every row to one machine's layout
 * the moment it is written.
 */
const CAPTURES = `
CREATE TABLE captures (
  id             TEXT PRIMARY KEY,
  -- Who took it. Survives the lease ending, which is the point.
  claim_id       TEXT NOT NULL REFERENCES claims (id),
  tab_id         TEXT NOT NULL REFERENCES tabs (id),
  taken_at       TEXT NOT NULL DEFAULT (${NOW}),
  kind           TEXT NOT NULL
                 CHECK (kind IN ('viewport', 'element', 'full_page')),
  -- Which resolution rung was asked for. Stored rather than inferred from the
  -- dimensions, because the rungs are configuration and can move between
  -- installations.
  tier           TEXT NOT NULL
                 CHECK (tier IN ('default', 'detail', 'max')),
  -- Free text, and required only on the top tier. The entire mechanism by
  -- which anyone learns why callers escalate; an enum could only report which
  -- of the author's guesses somebody picked.
  reason         TEXT,
  source_width   INTEGER NOT NULL CHECK (source_width > 0),
  source_height  INTEGER NOT NULL CHECK (source_height > 0),
  -- Equal to the pair above when nothing was shrunk, which is how "was this
  -- downscaled" is answered without a flag that could disagree with the
  -- numbers beside it.
  width          INTEGER NOT NULL CHECK (width > 0),
  height         INTEGER NOT NULL CHECK (height > 0),
  bytes          INTEGER NOT NULL CHECK (bytes >= 0),
  path           TEXT NOT NULL,
  selector       TEXT,
  -- The breakpoint, stored as a number rather than a name because a named set
  -- of breakpoints is a vocabulary the service would have to own.
  viewport_width INTEGER NOT NULL CHECK (viewport_width > 0),
  -- What page this was a picture of. Nothing else records it, and it is a
  -- different fact from where a tab is — for which there is no column at all.
  url            TEXT,
  warned         INTEGER NOT NULL DEFAULT 0
                 CHECK (warned IN (0, 1)),
  created_at     TEXT NOT NULL DEFAULT (${NOW}),
  updated_at     TEXT NOT NULL DEFAULT (${NOW}),
  -- A written reason is owed on the top tier (3.11).
  CHECK (tier <> 'max' OR reason IS NOT NULL),
  -- An element capture is the one that names an element.
  CHECK ((kind = 'element') = (selector IS NOT NULL)),
  -- Never absolute (1.7a). Both spellings of a root, because the check has to
  -- hold whichever platform wrote the row.
  CHECK (path NOT LIKE '/%' AND path NOT LIKE '_:%' AND path NOT LIKE '\\%')
) STRICT
`;

/**
 * `comparisons` — what one diff did, under the numbers in force at the time
 * (§1.9).
 *
 * A table rather than a ledger entry for three reasons, and the third is the
 * one that settles it: the ledger is the one thing in this design that may be
 * trimmed (§1.1), so folding this in would let a future decision to trim it
 * silently destroy the tuning history. The other two: a rerun answers a
 * different question once any of the three settings has moved, and the
 * references to a capture, a target and a lease are real foreign keys here and
 * unenforceable inside a blob on a ledger row.
 *
 * **All three settings are copied rather than referenced**, because all three
 * are mutable and all three determined the output — snapshotting one and
 * referencing the others would be a record that is half-true.
 */
const COMPARISONS = `
CREATE TABLE comparisons (
  id                   TEXT PRIMARY KEY,
  source_capture_id    TEXT NOT NULL REFERENCES captures (id),
  -- The capture the caller named. A missing target returns the picture with
  -- an explanation rather than a refusal (1.9), so a row is only written when
  -- a diff actually ran and the target was found.
  target_capture_id    TEXT NOT NULL REFERENCES captures (id),
  claim_id             TEXT NOT NULL REFERENCES claims (id),
  at                   TEXT NOT NULL DEFAULT (${NOW}),
  -- The three settings actually applied.
  colour_tolerance     REAL NOT NULL CHECK (colour_tolerance >= 0),
  minimum_region_area  INTEGER NOT NULL CHECK (minimum_region_area >= 0),
  maximum_regions      INTEGER NOT NULL CHECK (maximum_regions > 0),
  -- The raw count and its share, before regions are worked out. What
  -- distinguishes "nothing moved" from "the threshold ate it".
  changed_pixels       INTEGER NOT NULL CHECK (changed_pixels >= 0),
  changed_ratio        REAL NOT NULL CHECK (changed_ratio BETWEEN 0 AND 1),
  -- True when at least one region survives filtering, not when any pixel
  -- differs. Stored rather than derived from the region list because the
  -- definition is the thing every caller branches on and it has to have one
  -- answer.
  changed              INTEGER NOT NULL
                       CHECK (changed IN (0, 1)),
  -- One entry per changed area with its position, size and two crop paths.
  -- No separate region count: it is the length of this list.
  regions              TEXT NOT NULL,
  overlay_path         TEXT NOT NULL,
  -- A truncated result that does not say so is a lie about completeness.
  truncated            INTEGER NOT NULL DEFAULT 0
                       CHECK (truncated IN (0, 1)),
  created_at           TEXT NOT NULL DEFAULT (${NOW}),
  updated_at           TEXT NOT NULL DEFAULT (${NOW}),
  CHECK (overlay_path NOT LIKE '/%' AND overlay_path NOT LIKE '_:%'
         AND overlay_path NOT LIKE '\\%')
) STRICT
`;

/**
 * `feedback` — the tenth tool's table, and the one built to be removed
 * (§3.16).
 *
 * Its own table rather than an event kind, on three arguments: the ledger
 * records what the service *did* and this records what a caller *thought*, so
 * folding it in would make every count over `events` start by excluding a kind
 * that is not an event; the planned removal has to stay a deletion rather than
 * becoming a migration over a retired kind other rows still use; and the two
 * have opposite lifecycles — the ledger is written on every call by every
 * process and trimmed, this is written rarely and read by hand.
 *
 * **No lease is required, and that is the point rather than a convenience.** A
 * caller whose claim was refused is the caller most likely to have something
 * worth recording, so requiring a lease would silence exactly the population
 * the tool exists to hear from.
 */
const FEEDBACK = `
CREATE TABLE feedback (
  -- Borrows the ledger's cursor discipline: a counter key, so reading
  -- "everything since I last looked" is the same one query it is everywhere.
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL DEFAULT (${NOW}),
  session_id    TEXT,
  claim_id      TEXT REFERENCES claims (id),
  -- The caller's last operation, read from the ledger, so it names what was
  -- actually attempted rather than what the caller remembers attempting.
  last_event_id INTEGER REFERENCES events (id),
  -- The refusal that was hit, if the caller's last event was a denial.
  last_guard    TEXT,
  -- The axis is not satisfaction: it is whether the service moved the
  -- caller's actual work forward or got in its way (3.16).
  rating        INTEGER NOT NULL
                CHECK (rating BETWEEN 1 AND 5),
  -- A small fixed set, chosen to be greppable. 'worked-well' is in it
  -- deliberately: a list with no positive value collects only complaints.
  category      TEXT NOT NULL
                CHECK (category IN (
                  'refusal-unclear', 'no-path', 'worked-around',
                  'surprised-me', 'worked-well'
                )),
  -- The floor is deliberate: twenty characters is roughly the shortest useful
  -- sentence, and it stops a reflexive one-word row.
  note          TEXT NOT NULL
                CHECK (length(note) BETWEEN 20 AND 2000),
  created_at    TEXT NOT NULL DEFAULT (${NOW}),
  updated_at    TEXT NOT NULL DEFAULT (${NOW})
) STRICT
`;

/**
 * The two partial indexes, and they are two rather than three.
 *
 * **A change in a count, stated rather than corrected quietly** (`SCHEMA.md`
 * §1.11, §9.2). Three partial indexes were built and exercised on the SQLite
 * version this design targets, and that measurement stands — it covered one
 * index more than the design contains. The third enforced one canonical
 * picture per view, browser, kind and breakpoint, and it went with the concept
 * it enforced. A reader who remembers "three, verified" and finds two with no
 * explanation has to work out whether a measurement failed, whether an index
 * was dropped for being wrong, or whether somebody miscounted; none of those
 * happened.
 *
 * **Two rules a reader may look for and will not find.** "One live lease per
 * tab" is structural — a tab's lease reference is set when the row is created,
 * is never null and never changes, so there is nothing for an index to refuse.
 * And **"one live lease per session" is gone entirely**, not enforced
 * differently: a lease is one tab, so a session that wants three tabs holds
 * three leases, and the rule is incompatible with that model. What it would
 * have caught as a side effect — two callers accidentally sharing one session
 * identity — is not caught anywhere, and that is named as lost rather than
 * quietly dropped.
 */
const PARTIAL_INDEXES = `
-- One live tab row per physical driver tab. The rule lives at the write
-- because the staleness is in the read that came before it: two callers both
-- read "nothing there", both reads were true when made, and nothing re-checks
-- the second by the time its write lands. Across separate processes this is
-- not one option among several — there is no shared process to hold a lock in.
CREATE UNIQUE INDEX one_row_per_physical_tab
  ON tabs (browser_id, driver_tab_id) WHERE state IN ('opening', 'open', 'closing');

-- Not a uniqueness rule: this makes the capacity count an index-only scan.
-- The count of live claims is read inside the transaction every arbitration
-- call opens, with every other caller on the machine waiting behind it, so
-- the answer coming out of the index without touching the table is what keeps
-- the serialised section short.
CREATE INDEX live_claims
  ON claims (state) WHERE state IN ('queued', 'active');
`;

/**
 * The ordinary indexes (`MILESTONES.md` #7).
 *
 * At a tab budget of fifteen the live set is tens of rows, so most of these
 * change nothing measurable on live data. They exist for the historical rows,
 * which are the part that grows without bound — with one exception, the
 * sweep's scan, which is hot rather than historical.
 */
const INDEXES = `
-- Not a query index: the target of the composite foreign key on tabs that
-- stops a tab naming a browser its own lease did not. Free, given id is
-- already unique.
CREATE UNIQUE INDEX claims_id_browser ON claims (id, browser_id);

-- The sweep's scan: everything live and past its expiry, in one index range.
-- Read on every arbitration call.
CREATE INDEX claims_state_expires ON claims (state, expires_at);

-- Head of queue, first in first out. Separate from the sweep's index because
-- they order by different columns, and a scan that has to sort gets slower as
-- history accumulates.
CREATE INDEX claims_state_created ON claims (state, created_at);

-- A session's own history, and the query the admission transaction needs when
-- it reads a session's other live leases.
CREATE INDEX claims_session_created ON claims (session_id, created_at DESC);

-- The ownership check, and everything release and the sweep do.
CREATE INDEX tabs_claim ON tabs (claim_id);

-- A slice read; one lease's whole history; the capture and diff rollups; and
-- which rule refuses most, small because denials are rare.
CREATE INDEX events_at ON events (at);
CREATE INDEX events_claim_id ON events (claim_id, id);
CREATE INDEX events_kind_at ON events (kind, at);
CREATE INDEX events_guard ON events (guard) WHERE guard IS NOT NULL;

-- Listing, and the rollup.
CREATE INDEX captures_claim ON captures (claim_id);
CREATE INDEX captures_taken_at ON captures (taken_at);

-- The diffs run from one capture, and the diffs run against one — which is
-- what tuning reads.
CREATE INDEX comparisons_source ON comparisons (source_capture_id, at DESC);
CREATE INDEX comparisons_target ON comparisons (target_capture_id);

-- Reading it back, most recent first, filtered by kind.
CREATE INDEX feedback_at ON feedback (at DESC);
CREATE INDEX feedback_category_at ON feedback (category, at DESC);
`;

/**
 * The two browser rows, created by the first schema step (§1.2d).
 *
 * This is what makes "exactly two" hold from the bottom: the check constraint
 * and the primary key cap the table at two, and this seed floors it at two.
 */
const SEED_BROWSERS = `
INSERT INTO browsers (id, state) VALUES ('regular', 'stopped'), ('private', 'stopped');
`;

/** Every statement this step runs, in the order it runs them. */
export const STEP_ONE_SQL: readonly string[] = [
  BROWSERS,
  CLAIMS,
  TABS,
  EVENTS,
  CAPTURES,
  COMPARISONS,
  FEEDBACK,
  PARTIAL_INDEXES,
  INDEXES,
  SEED_BROWSERS,
];

export const stepOne: Step = {
  version: 1,
  summary: 'The whole schema: seven tables, the two partial indexes, and the two browser rows.',
  apply: (db: Database) => {
    for (const statement of STEP_ONE_SQL) {
      db.exec(statement);
    }
  },
};
