import { renderAddress, type TabAddress } from '../operations/addresses.ts';
import { secondsBetween } from '../operations/derive.ts';
import type { LeaseView, OperationsStatus, QueueEntryView } from '../operations/status.ts';
import { escapeHtml, escapeValue } from './escape.ts';

/**
 * The operations document: one self-contained HTML file (`MILESTONES.md` #35,
 * `SCHEMA.md` §4).
 *
 * ── What this file is, stated as the constraints it is under ────────────
 *
 * **Nothing is served.** There is no port, no bind address, no request path
 * and no process left running (§4). A command produces this string, writes it
 * to a path, reports the path and exits. Do not add a server, a refresh loop
 * or a live indicator to this module; every one of those was considered and
 * ruled out for the same reason, which is that there is no process to host
 * one.
 *
 * **Everything is inlined.** No separate stylesheet, no separate script, no
 * fonts to fetch, nothing loaded from anywhere. That is not asceticism: it is
 * what makes the file still render correctly when it is moved, sent to
 * somebody, or opened on a machine that has nothing installed (§4.5). It is
 * also why there is no templating engine and no build step — a self-contained
 * file assembled by a toolchain is a self-contained file with a dependency.
 *
 * **It is a photograph and it says so.** §4.1 makes this "the single most
 * important property": the moment it describes is **in the document,
 * prominently** — not in the file name, which can be renamed, and not only in
 * a footer. Nothing redraws itself. A page showing leases, expiries and a
 * queue *looks* like an operations console, and a console is a thing people
 * read as current; a stale page that admits it is stale is useful, and one
 * that does not is misleading in the direction of confident wrong
 * conclusions.
 *
 * **It renders derived state.** Every lease in it came through the expiry
 * derivation (§2.4, `derive.ts`). This module never sees a stored `state`
 * column: {@link OperationsStatus} does not carry one, which is how the rule
 * is enforced here rather than merely observed.
 *
 * **Read-only. No controls, no sign-in, no forms.** Revoking is deliberately
 * absent even though the operation exists (§4.5): "a button in a photograph
 * would act on state that has moved on since the shutter, and the person
 * clicking it would be acting on what they can see rather than on what is
 * true". Revoking is a command, run against the service as it is at that
 * moment.
 *
 * **No settings section and no health verdict** (§4.2). The first would
 * duplicate `.env.example`, which is the registry and sits beside the code;
 * the second is `broker doctor`'s job in a better shape (§4.4).
 *
 * ── What it contains that is sensitive ──────────────────────────────────
 *
 * §4.1a: the document carries purposes, session identities and page addresses
 * read live from the browsers, so **it is as sensitive as what it describes**
 * and it is an ordinary file. It contains **no lease key** — §5.6's rule, and
 * {@link OperationsStatus} does not carry one to leak.
 */

/** Everything the document is assembled from. */
export interface DocumentInput {
  readonly status: OperationsStatus;
  /**
   * Where each live tab is, keyed by the opaque tab identifier (§4.2a).
   *
   * A missing entry is **not** a blank: {@link renderAddress} turns it into
   * the explicit word, because an address that was never obtained is exactly
   * the omitted case §4.2a forbids.
   */
  readonly addresses: ReadonlyMap<string, TabAddress>;
  /**
   * A note about how the addresses were obtained, shown beside them.
   *
   * Present when the generator could not reach the browsers at all — in which
   * case every address is `unreachable` and the reader deserves to know it
   * was one cause rather than fifteen.
   */
  readonly addressNote?: string;
  /** The version of this build, for the footer. */
  readonly version?: string;
}

/**
 * The styling, inlined.
 *
 * Plain CSS with no custom fonts and no imports, so the file needs nothing
 * from a network to render. The colour choices carry meaning that is also
 * carried in words — an expired lease says "expired" as well as being
 * coloured — because a document sent to somebody may be read by a person who
 * does not see the colours, or printed.
 */
const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.5rem 4rem;
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: #fbfbfc; color: #1c1e21;
}
main { max-width: 76rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 2.25rem 0 .5rem; letter-spacing: .01em; }
p { margin: .35rem 0; }
.taken {
  margin: 1rem 0 1.75rem; padding: .85rem 1rem;
  border: 1px solid #d8b74a; border-left-width: 5px; border-radius: 4px;
  background: #fdf7e3;
}
.taken .moment { font-size: 1.15rem; font-weight: 650; }
.taken .warning { margin-top: .3rem; color: #6b5312; }
table { width: 100%; border-collapse: collapse; margin: .4rem 0 .5rem; font-size: 14px; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #e6e7ea; vertical-align: top; }
th { font-weight: 600; color: #4a4d52; background: #f2f3f5; border-bottom-color: #d9dadd; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.empty { color: #6b6e73; font-style: italic; }
.tag { display: inline-block; padding: .05rem .4rem; border-radius: 3px; font-size: 12px; font-weight: 600; }
.tag-ok { background: #dcf0dc; color: #1d4620; }
.tag-warn { background: #fbecd0; color: #6b4a06; }
.tag-bad { background: #f7dada; color: #6d1f1f; }
.tag-idle { background: #e6e7ea; color: #43464b; }
.unreachable { font-weight: 650; color: #8a2020; }
.counts { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: .5rem 0 0; padding: 0; list-style: none; }
.counts li { min-width: 7rem; }
.counts .label { display: block; font-size: 12px; color: #5c5f64; text-transform: uppercase; letter-spacing: .04em; }
.counts .value { font-size: 1.5rem; font-weight: 650; font-variant-numeric: tabular-nums; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e6e7ea; color: #5c5f64; font-size: 13px; }
@media (prefers-color-scheme: dark) {
  body { background: #17181b; color: #e6e7ea; }
  .taken { background: #2c2612; border-color: #7d6a24; }
  .taken .warning { color: #d9c684; }
  th { background: #212327; color: #b9bcc2; border-bottom-color: #33363b; }
  th, td { border-bottom-color: #26282c; }
  .empty, .counts .label, footer { color: #9c9fa5; }
  .tag-ok { background: #1d3a1f; color: #b9e2bb; }
  .tag-warn { background: #40320f; color: #eccf8e; }
  .tag-bad { background: #451c1c; color: #efb5b5; }
  .tag-idle { background: #2b2d31; color: #b9bcc2; }
  .unreachable { color: #f08b8b; }
  footer { border-top-color: #33363b; }
}
`.trim();

/**
 * The behaviour, inlined — and there is deliberately almost none.
 *
 * §4.1 forbids polling, a countdown and a live indicator, so what is left is
 * one thing that makes the document *more* honest rather than less: it reads
 * the moment already written into the page and says how long ago that was,
 * **once, at open time.** It never repeats, so nothing in the page changes
 * after it has been read — which is the property the rule protects.
 *
 * The value it computes is the reader's own clock against a moment from
 * another machine's, so it is rounded to a coarse unit and labelled
 * approximate. A precise figure would imply the two clocks agree.
 *
 * If it does not run — scripts disabled, or a viewer that strips them — the
 * document is unaffected: the timestamp is already in the markup, and this
 * only appends to it.
 */
const SCRIPT = `
(function () {
  var node = document.getElementById('age');
  if (!node) { return; }
  var taken = Date.parse(node.getAttribute('data-taken') || '');
  if (isNaN(taken)) { return; }
  var seconds = Math.max(0, Math.round((Date.now() - taken) / 1000));
  var text;
  if (seconds < 90) { text = 'moments ago'; }
  else if (seconds < 5400) { text = 'about ' + Math.round(seconds / 60) + ' minutes ago'; }
  else if (seconds < 172800) { text = 'about ' + Math.round(seconds / 3600) + ' hours ago'; }
  else { text = 'about ' + Math.round(seconds / 86400) + ' days ago'; }
  node.textContent = ' — taken ' + text + ' (approximate: your clock, not the store\\u2019s)';
})();
`.trim();

/** Seconds as something a person reads, e.g. `4m 12s`. */
export function humaniseSeconds(seconds: number): string {
  const negative = seconds < 0;
  const total = Math.abs(Math.round(seconds));
  const parts =
    total < 60
      ? `${String(total)}s`
      : total < 3600
        ? `${String(Math.floor(total / 60))}m ${String(total % 60)}s`
        : `${String(Math.floor(total / 3600))}h ${String(Math.floor((total % 3600) / 60))}m`;
  return negative ? `${parts} ago` : parts;
}

/** How an expiry is shown: the remaining time, or that it has passed. */
function expiryCell(secondsUntilExpiry: number): string {
  if (secondsUntilExpiry <= 0) {
    // Reachable only in the window between a lease lapsing and this document
    // deriving it — which the derivation closes. Kept because a lease with a
    // renewal in flight can land here, and because a cell that could only
    // ever be positive would be a claim this module cannot make.
    return `<span class="tag tag-bad">lapsed ${escapeHtml(humaniseSeconds(secondsUntilExpiry))}</span>`;
  }
  const urgent = secondsUntilExpiry < 60;
  return `<span class="tag ${urgent ? 'tag-warn' : 'tag-ok'}">${escapeHtml(humaniseSeconds(secondsUntilExpiry))}</span>`;
}

function browserStateTag(state: string): string {
  const className =
    state === 'running'
      ? 'tag-ok'
      : state === 'failed'
        ? 'tag-bad'
        : state === 'starting' || state === 'signing-in'
          ? 'tag-warn'
          : 'tag-idle';
  return `<span class="tag ${className}">${escapeHtml(state)}</span>`;
}

/** A table, or an italic sentence when there is nothing in it. */
function table(headers: readonly string[], rows: readonly string[], empty: string): string {
  if (rows.length === 0) {
    return `<p class="empty">${escapeHtml(empty)}</p>`;
  }
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

/**
 * The address cell (§4.2a).
 *
 * The **only** place a live-read address becomes markup, and it goes through
 * {@link renderAddress} so the three outcomes are decided in one place. The
 * `unreachable` word carries a class so it is visually distinct, but the word
 * itself is the signal — a reader who cannot see the colour still reads it.
 */
function addressCell(tabId: string | null, addresses: ReadonlyMap<string, TabAddress>): string {
  if (tabId === null) {
    return `<td class="empty">no tab</td>`;
  }
  const address = addresses.get(tabId);
  const text = renderAddress(address);
  const unreachable = address === undefined || address.kind === 'unreachable';
  const reason = address !== undefined && address.kind === 'unreachable' ? address.reason : '';
  return unreachable
    ? `<td><span class="unreachable" title="${escapeHtml(reason)}">${escapeHtml(text)}</span></td>`
    : `<td class="mono">${escapeHtml(text)}</td>`;
}

function leaseRow(
  lease: LeaseView,
  addresses: ReadonlyMap<string, TabAddress>,
  showSession: boolean,
): string {
  const session = showSession ? `<td class="mono">${escapeValue(lease.sessionId)}</td>` : '';
  return [
    '<tr>',
    session,
    `<td class="mono">${escapeValue(lease.claimId)}</td>`,
    `<td>${escapeValue(lease.browserId)}</td>`,
    `<td>${escapeValue(lease.purpose)}</td>`,
    // Derived, never stored. `LeaseView.state` is the output of
    // `deriveClaimState` and the type carries no stored column to print.
    `<td><span class="tag tag-ok">${escapeValue(lease.state)}</span></td>`,
    `<td>${expiryCell(lease.secondsUntilExpiry)}</td>`,
    `<td class="num">${escapeValue(lease.renewCount)}</td>`,
    addressCell(lease.tabId, addresses),
    '</tr>',
  ].join('');
}

function queueRow(entry: QueueEntryView): string {
  return [
    '<tr>',
    `<td class="num">${escapeValue(entry.position)}</td>`,
    `<td class="mono">${escapeValue(entry.sessionId)}</td>`,
    `<td>${escapeValue(entry.browserId)}</td>`,
    `<td>${escapeValue(entry.purpose)}</td>`,
    `<td>${escapeHtml(humaniseSeconds(entry.waitedSeconds))}</td>`,
    `<td>${expiryCell(entry.secondsUntilExpiry)}</td>`,
    '</tr>',
  ].join('');
}

/**
 * The moment, prominently and in the document (§4.1).
 *
 * Both halves are here on purpose. The timestamp answers *when*; the sentence
 * beside it answers *what that means* — that nothing on the page will change,
 * that the numbers are as they were at that instant, and that a queue may
 * have drained since. §4.1's rule is that the document must not pretend to be
 * a window, and a timestamp on its own does not say that.
 */
function takenBanner(at: string): string {
  return [
    '<div class="taken" role="note">',
    `<div class="moment">Snapshot taken at <span class="mono">${escapeHtml(at)}</span><span id="age" data-taken="${escapeHtml(at)}"></span></div>`,
    '<p class="warning">This is a photograph, not a window. <strong>Nothing on this page refreshes</strong> — every',
    'lease, expiry and queue position is as it was at the moment above, and may have changed since.',
    'Generate a new snapshot to see the current picture.</p>',
    '</div>',
  ].join('\n');
}

function browsersSection(status: OperationsStatus): string {
  const rows = status.browsers.map((browser) => {
    const record = browser.discoveryRecorded
      ? browser.identityRecorded
        ? '<span class="tag tag-idle">address and identity recorded</span>'
        : '<span class="tag tag-warn">address only</span>'
      : '<span class="tag tag-idle">none recorded</span>';
    return [
      '<tr>',
      `<td>${escapeValue(browser.id)}</td>`,
      `<td>${browserStateTag(browser.state)}</td>`,
      `<td class="num">${escapeValue(browser.restartCount)}</td>`,
      `<td class="num">${escapeValue(browser.pid)}</td>`,
      `<td class="mono">${escapeValue(browser.launchedAt)}</td>`,
      `<td>${record}</td>`,
      `<td class="num">${escapeValue(browser.liveTabs)}</td>`,
      '</tr>',
    ].join('');
  });

  return [
    '<h2>Browsers</h2>',
    table(
      ['Browser', 'State', 'Restarts', 'Process', 'Launched', 'Discovery record', 'Leased tabs'],
      rows,
      'No browsers are recorded, which should not happen — the schema seeds two.',
    ),
    // §1.2c: the record is a claim, not a proof. The document reports what the
    // store holds; only `broker doctor` reaches the endpoint and can say
    // whether it checks out. Saying so here is what stops a reader taking
    // "recorded" for "working".
    '<p class="empty">A discovery record is a claim, not a proof — it survives the browser it names.',
    'Whether one actually answers, and answers as the expected browser, is what <code>broker doctor</code> checks.</p>',
  ].join('\n');
}

function budgetSection(status: OperationsStatus): string {
  const { budget } = status;
  const limit = budget.limit === null ? 'not recorded' : String(budget.limit);
  return [
    '<h2>Budget</h2>',
    '<ul class="counts">',
    `<li><span class="label">Tab budget</span><span class="value">${escapeHtml(limit)}</span></li>`,
    `<li><span class="label">Live leases</span><span class="value">${escapeValue(budget.used)}</span></li>`,
    `<li><span class="label">Holding a tab</span><span class="value">${escapeValue(budget.active)}</span></li>`,
    `<li><span class="label">Queued</span><span class="value">${escapeValue(budget.queued)}</span></li>`,
    `<li><span class="label">Keeper tabs</span><span class="value">${escapeValue(budget.keeperTabsExpected)}</span></li>`,
    '</ul>',
    // §3.15: the keeper tab is not capacity and is not counted against the
    // budget, and it is "reported wherever pages are counted" precisely so a
    // person looking at a browser window can reconcile what they see.
    '<p class="empty">Keeper tabs are one blank page per browser. They are never leased and never counted against the',
    'budget, so a browser window shows one more tab than the budget accounts for. Counted here so the two reconcile.',
    budget.limit === null
      ? 'The budget has not been recorded in this store yet, so there is no bound to compare against.'
      : '',
    '</p>',
  ].join('\n');
}

function leasesSection(
  status: OperationsStatus,
  addresses: ReadonlyMap<string, TabAddress>,
): string {
  const headers = ['Lease', 'Browser', 'Purpose', 'State', 'Expires in', 'Renewals', 'Address'];
  const groups = status.sessions.map((session) => {
    const rows = session.leases.map((lease) => leaseRow(lease, addresses, false));
    return [
      `<h3 class="mono">${escapeValue(session.sessionId)} — ${String(session.leases.length)} lease(s)</h3>`,
      table(headers, rows, 'No live leases for this session.'),
    ].join('\n');
  });

  return [
    '<h2>Live leases</h2>',
    // §2.4's standing rule, said in the document rather than only in the code,
    // because a reader comparing this against a direct table read deserves to
    // know which one is right.
    '<p class="empty">Grouped by session, so one caller holding several tabs reads as one caller.',
    'Every lease here had the expiry derivation applied at the moment above — a lease that had lapsed but',
    'had not yet been swept is not shown as live.</p>',
    groups.length === 0 ? '<p class="empty">Nothing holds a tab.</p>' : groups.join('\n'),
  ].join('\n');
}

function queueSection(status: OperationsStatus): string {
  const front = status.queue[0];
  const depth = status.queue.length;
  return [
    '<h2>Queue</h2>',
    `<p>Depth <strong>${String(depth)}</strong>${
      front === undefined
        ? '. Nobody is waiting.'
        : `. The caller at the front has waited <strong>${escapeHtml(humaniseSeconds(front.waitedSeconds))}</strong>.`
    }</p>`,
    table(
      ['#', 'Session', 'Browser', 'Purpose', 'Waited', 'Place expires in'],
      status.queue.map((entry) => queueRow(entry)),
      'Nobody is waiting.',
    ),
  ].join('\n');
}

function leakedSection(status: OperationsStatus): string {
  const rows = status.leakedTabs.map((tab) =>
    [
      '<tr>',
      `<td class="mono">${escapeValue(tab.tabId)}</td>`,
      `<td>${escapeValue(tab.browserId)}</td>`,
      `<td class="mono">${escapeValue(tab.claimId)}</td>`,
      `<td>${escapeValue(tab.state)}</td>`,
      `<td class="num">${escapeValue(tab.closeAttempts)}</td>`,
      `<td class="mono">${escapeValue(tab.updatedAt)}</td>`,
      '</tr>',
    ].join(''),
  );

  return [
    '<h2>Leaked tabs</h2>',
    // §2.4b: a leaked tab is not a leaked lease. The capacity is already back;
    // what is left is a page nobody owns. Saying so stops a reader treating
    // this section as a capacity problem.
    '<p class="empty">A tab that would not close after its lease ended. The capacity came back when the lease did —',
    'what is left is a page nobody owns, which costs memory and not budget.</p>',
    table(
      ['Tab', 'Browser', 'Was leased by', 'State', 'Close attempts', 'Last seen'],
      rows,
      'No tabs have leaked.',
    ),
  ].join('\n');
}

function ledgerSection(status: OperationsStatus): string {
  const rows = status.recentEvents.map((entry) =>
    [
      '<tr>',
      `<td class="num">${escapeValue(entry.id)}</td>`,
      `<td class="mono">${escapeValue(entry.at)}</td>`,
      `<td>${escapeValue(entry.kind)}</td>`,
      `<td>${
        entry.outcome === 'deny'
          ? `<span class="tag tag-bad">deny</span>`
          : `<span class="tag tag-ok">allow</span>`
      }</td>`,
      `<td>${escapeValue(entry.guard)}</td>`,
      `<td>${escapeValue(entry.adapter)}</td>`,
      `<td class="mono">${escapeValue(entry.sessionId)}</td>`,
      '</tr>',
    ].join(''),
  );

  const refusals = status.refusalsByGuard.map((guard) =>
    [
      '<tr>',
      `<td class="mono">${escapeValue(guard.guard)}</td>`,
      `<td class="num">${escapeValue(guard.count)}</td>`,
      '</tr>',
    ].join(''),
  );

  const highest = status.recentEvents.reduce<number | null>(
    (best, entry) => (best === null || entry.id > best ? entry.id : best),
    null,
  );

  return [
    '<h2>Recent ledger entries</h2>',
    table(['#', 'At', 'Kind', 'Outcome', 'Rule', 'Route', 'Session'], rows, 'The ledger is empty.'),
    highest === null
      ? ''
      : `<p class="empty">Most recent entry is <code>#${String(highest)}</code>. Read on with <code>broker events --since ${String(highest)}</code>.</p>`,
    '<h2>Refusals by rule</h2>',
    // §1.6: an allowed row does not record which rules passed, so "has this
    // rule ever fired" is answered by the refusals and by nothing else.
    '<p class="empty">Only refusals name a rule, so this is the whole of what the ledger can say about which rules have fired.</p>',
    table(['Rule', 'Times refused'], refusals, 'Nothing has been refused.'),
  ].join('\n');
}

function feedbackSection(status: OperationsStatus): string {
  const rows = status.feedback.map((entry) =>
    [
      '<tr>',
      `<td class="mono">${escapeValue(entry.at)}</td>`,
      `<td class="num">${escapeValue(entry.rating)}</td>`,
      `<td>${escapeValue(entry.category)}</td>`,
      `<td class="mono">${escapeValue(entry.sessionId)}</td>`,
      `<td>${escapeValue(entry.lastGuard)}</td>`,
      `<td>${escapeValue(entry.note)}</td>`,
      '</tr>',
    ].join(''),
  );

  return [
    '<h2>What callers reported</h2>',
    // §3.16 and §4.2: the tool has a planned removal, and "this section
    // disappearing entirely is the signal that tool has done its job". An
    // empty section is therefore not a defect and the document says so.
    '<p class="empty">The rating is not satisfaction — it is whether this service moved the caller’s work forward',
    'or got in its way. This section emptying out permanently is the signal that the feedback tool has done its job.</p>',
    table(
      ['At', 'Rating', 'Category', 'Session', 'Rule hit', 'Note'],
      rows,
      'No caller has reported anything.',
    ),
  ].join('\n');
}

/**
 * Assemble the document.
 *
 * Returns the string rather than writing it, so the whole of it is assertable
 * from a test without a filesystem — and so the command that writes it has
 * one job, which is writing it.
 */
export function renderDocument(input: DocumentInput): string {
  const { status } = input;
  const addressNote =
    input.addressNote === undefined ? '' : `<p class="empty">${escapeHtml(input.addressNote)}</p>`;

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Not a refresh directive, and its absence is the point (§4.1). Nothing
    // in this head reloads, polls or redirects.
    `<title>Browser Broker — snapshot ${escapeHtml(status.at)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Browser Broker — operations snapshot</h1>',
    takenBanner(status.at),
    browsersSection(status),
    budgetSection(status),
    leasesSection(status, input.addresses),
    addressNote,
    // §4.2a, said where the addresses are: they were asked for, live, under a
    // per-tab timeout, and `unreachable` means the question went unanswered.
    '<p class="empty">Addresses were read from the browsers at the moment above, each under its own timeout.',
    `<strong>${escapeHtml('unreachable')}</strong> means the browser was asked and did not answer — which is a different fact from a lease having no tab.</p>`,
    queueSection(status),
    leakedSection(status),
    ledgerSection(status),
    feedbackSection(status),
    '<footer>',
    `<p>Generated by Browser Broker${input.version === undefined ? '' : ` ${escapeHtml(input.version)}`} at <span class="mono">${escapeHtml(status.at)}</span>.`,
    'Read-only: this document has no controls, and nothing here acts on the service.',
    'To act on the service as it is now, run a command against it.</p>',
    '</footer>',
    '</main>',
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The instant a lease has left, for a caller that wants the number without
 * the markup. Exported because the doctor report uses the same arithmetic and
 * two copies of it would drift.
 */
export { secondsBetween };
