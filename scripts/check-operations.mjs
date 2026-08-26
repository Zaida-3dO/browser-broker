#!/usr/bin/env node
/**
 * The operations check: prove the **shipped executables** reach the service.
 *
 * ── The gap this exists to close, stated as the thing that happened ─────
 *
 * Every operation was built, tested and reviewed. The service was complete,
 * its rules were enforced, the conformance matrix was green across both
 * routes, and more than a thousand tests passed. And the executable a person
 * runs answered `refused (service.not_built)` to all nine arbitration
 * operations, because nothing constructed a service and passed it in.
 *
 * Nothing in the suite was wrong. Every one of those tests injected a service
 * — correctly, because that injection is the seam that lets the dispatcher be
 * driven in process at all. The one claim none of them could make is the one
 * a user depends on: **that the binary builds a real service by itself**. A
 * test that hands the service in cannot notice that nobody else does.
 *
 * So this check refuses to hand anything in. It spawns the executables named
 * by the package manifest, speaks to them the way a caller speaks to them,
 * and asserts on what comes back.
 *
 * ── Why the assertions name rules rather than counting successes ────────
 *
 * A stand-in service can return `accepted`. What it cannot do is produce the
 * *specific* refusals of the arbitration core, because those come from
 * hashing a key, looking for a claim and finding none — from a store. So the
 * checks below turn on identifiers only a real service can produce, and on
 * state that survives between two separate processes.
 *
 * That last one is the strongest claim here and the reason the lifecycle is
 * driven across a pipe rather than in one call: **a lease granted by one
 * process is observable by the next**. Nothing that fakes a service can do
 * that, because there is nowhere for the lease to have been written.
 *
 * Usage:
 *   node scripts/check-operations.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The two executables the package manifest ships. */
export const COMMAND_LINE = path.join(repositoryRoot, 'src', 'bin', 'broker.ts');
export const TOOL_SHIM = path.join(repositoryRoot, 'src', 'bin', 'broker-tool.ts');

/** A hang is the failure being tested for, so waiting forever reports nothing. */
export const SPAWN_TIMEOUT_MS = 120_000;

const PASSTHROUGH_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP'];

/** Either spelling of a line ending, since the record is written by the browser. */
const LINE_BREAK = /\r?\n/u;

/**
 * The variables a child needs to start, and nothing that configures this
 * service. Inheriting the whole environment would let a variable set on the
 * machine running this check decide the outcome.
 */
export function ambientEnvironment(source = process.env) {
  const ambient = {};
  for (const key of PASSTHROUGH_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      ambient[key] = value;
    }
  }
  return ambient;
}

/**
 * How many images a capture actually wrote, counted on disk.
 *
 * ── Why the files and not the `captures` table ──────────────────────────
 *
 * The row and the file are written together and the row is the record *that
 * the file exists*, so either would answer the question. The file is used
 * because it needs nothing this script does not already have: counting rows
 * means opening the store, which means this script depending on the database
 * driver — and the gates that run it do so **with nothing installed**, on
 * purpose, so that a tree with no dependencies can still be checked.
 *
 * It is also the more literal claim. `pageDriven: true` from a capture says a
 * picture was taken, and a picture that exists is a file.
 */
function countCapturedImages(artifactsRoot) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // Absent is zero: a capture that never happened creates no tree.
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.png')) {
        found.push(full);
      }
    }
  };
  walk(artifactsRoot);
  return found.length;
}

/**
 * Run one of the executables as a real child process, optionally writing to
 * its input, and collect what it did.
 */
export function spawnBinary(script, argv, { env, input, timeoutMs = SPAWN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...argv], {
      cwd: repositoryRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

/** Every non-empty line of the protocol stream, parsed. */
export function parseMessages(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** One tool call, as a protocol line. */
export function callLine(id, name, args) {
  return `${JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } })}\n`;
}

const failures = [];
const notes = [];

function check(description, condition, detail) {
  if (condition) {
    notes.push(`  ok   ${description}`);
  } else {
    failures.push(`  FAIL ${description}${detail === undefined ? '' : `\n         ${detail}`}`);
  }
}

/**
 * The nine arbitration operations, as the command line spells them, each
 * with a payload good enough that the key is the only thing left to refuse.
 *
 * Read as a list so that a build which registers a new operation and forgets
 * to wire it fails here rather than passing on the eight it remembered.
 * `feedback` is the tenth and is exercised separately: it is the one
 * operation that takes no lease, so it has no key to be refused for.
 *
 * ── Why the payloads have to be valid, which this check learned ─────────
 *
 * Three of these validate their payload **before** resolving the lease, and
 * that ordering is deliberate: `decideNavigate` checks the scheme first so
 * that "a refused scheme leaves no trace but the refusal row". Called with an
 * empty payload they answer `navigate.scheme_allowed`, `act.action_known` and
 * `evaluate.expression_bounded` — real rules from the real service, so the
 * executable had reached it, but not the rule this check means to name.
 *
 * Supplying a valid payload is therefore not a workaround. It is what makes
 * the assertion measure the thing it claims to: with nothing else left to
 * object to, a `key.valid` refusal can only have come from hashing the key
 * and finding no claim.
 */
export const KEYED_COMMANDS = [
  { words: ['status'], payload: [] },
  { words: ['release'], payload: [] },
  { words: ['tab', 'replace'], payload: [] },
  { words: ['navigate'], payload: ['--url', 'https://example.com/'] },
  { words: ['act'], payload: ['--action', 'click', '--target', 'e1'] },
  { words: ['read'], payload: [] },
  { words: ['evaluate'], payload: ['--expression', '1 + 1'] },
  { words: ['capture'], payload: [] },
];

export async function runOperationsCheck() {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'broker-operations-check-'));
  const environment = {
    ...ambientEnvironment(),
    BROKER_DB: path.join(temporaryRoot, 'state', 'broker.db'),
    BROKER_ARTIFACTS_ROOT: path.join(temporaryRoot, 'artefacts'),
    BROKER_PROFILE_ROOT: path.join(temporaryRoot, 'profiles'),
  };

  try {
    // ── The command line reaches the service ─────────────────────────────
    //
    // A claim with everything it needs. An executable that built no service
    // refuses here, which is what the next assertion rules out.
    const claim = await spawnBinary(
      COMMAND_LINE,
      [
        'claim',
        '--session-id',
        'operations-check',
        '--browser',
        'regular',
        '--purpose',
        'proving the shipped executable reaches the service',
        '--json',
      ],
      { env: environment },
    );

    check(
      'the command line exits zero on a granted claim',
      claim.code === 0,
      `exit ${String(claim.code)}\n         stdout: ${claim.stdout.trim()}\n         stderr: ${claim.stderr.trim()}`,
    );

    let granted;
    try {
      granted = JSON.parse(claim.stdout.trim());
    } catch {
      granted = undefined;
    }

    check(
      'the command line grants a real lease rather than refusing',
      granted?.outcome === 'accepted' && granted.value?.outcome === 'granted',
      `it answered: ${claim.stdout.trim()} ${claim.stderr.trim()}`,
    );
    check(
      'the granted lease carries the identifiers only the store can mint',
      typeof granted?.value?.claimId === 'string' &&
        typeof granted.value.tabId === 'string' &&
        typeof granted.value.expiresAt === 'string',
      `the grant was ${JSON.stringify(granted?.value)}`,
    );

    // §5.6, asserted against the real path rather than against a stub.
    //
    // The grant is the one named exception to "the lease key is never
    // printed": without it this command spent real tab budget on a lease
    // nobody could then address, because §2.2 returns a key once and makes it
    // unrecoverable. So the assertion here is that the key **is** returned,
    // and the assertions further down are that it is returned by nothing
    // else — a hole this narrow is only worth having if its edges are pinned.
    check(
      'the command line returns the key for the lease it just granted',
      typeof granted?.value?.key === 'string' && granted.value.key.length > 0,
      `the grant carried ${JSON.stringify(Object.keys(granted?.value ?? {}))}`,
    );

    // ── The lease the command line granted can actually be driven ────────
    //
    // This is the point of the exception above, and it is asserted rather
    // than argued: the key the grant returned is carried back to two other
    // commands, in two further processes, and the lease is ended through the
    // same surface that started it. Before the exception, `claim` succeeded
    // here and the lease was unreachable from every one of these — it held a
    // tab against the capacity budget until its lifetime elapsed.
    if (typeof granted?.value?.key === 'string') {
      const cliKey = granted.value.key;

      const cliStatus = await spawnBinary(
        COMMAND_LINE,
        ['status', '--lease-key', cliKey, '--json'],
        { env: environment },
      );
      let statusAnswer;
      try {
        statusAnswer = JSON.parse(cliStatus.stdout.trim());
      } catch {
        statusAnswer = undefined;
      }
      check(
        'the key the command line issued addresses the lease it granted',
        statusAnswer?.outcome === 'accepted' &&
          statusAnswer.value?.claimId === granted.value.claimId &&
          statusAnswer.value.state === 'active',
        `status answered ${cliStatus.stdout.trim()} ${cliStatus.stderr.trim()}`,
      );

      // The narrowness of the hole, asserted on a command that is *not* the
      // grant but does carry a key in. A surface that stripped on the way out
      // by operation name rather than by field would leak here.
      check(
        'no command other than the grant prints a key back',
        statusAnswer?.value !== undefined && !('key' in statusAnswer.value),
        `status carried ${JSON.stringify(Object.keys(statusAnswer?.value ?? {}))}`,
      );

      const cliRelease = await spawnBinary(
        COMMAND_LINE,
        ['release', '--lease-key', cliKey, '--json'],
        { env: environment },
      );
      let releaseAnswer;
      try {
        releaseAnswer = JSON.parse(cliRelease.stdout.trim());
      } catch {
        releaseAnswer = undefined;
      }
      check(
        'the command line can give back the tab budget its own claim spent',
        releaseAnswer?.outcome === 'accepted' &&
          releaseAnswer.value?.released === 'tab' &&
          releaseAnswer.value.alreadyEnded === false,
        `release answered ${cliRelease.stdout.trim()} ${cliRelease.stderr.trim()}`,
      );
    }

    // ── Every keyed operation reaches a rule, not a missing service ───────
    //
    // Each is given a key that names no lease. The refusal that comes back
    // has to be `key.valid` — the rule the arbitration core produces after
    // hashing the key and finding no claim. An executable serving a stand-in
    // would also refuse, and would refuse by a different name.
    for (const { words, payload } of KEYED_COMMANDS) {
      const result = await spawnBinary(
        COMMAND_LINE,
        [...words, '--lease-key', 'a-key-naming-no-lease', ...payload, '--json'],
        { env: environment },
      );
      let answer;
      try {
        answer = JSON.parse(result.stdout.trim());
      } catch {
        answer = undefined;
      }
      check(
        `broker ${words.join(' ')} reaches the arbitration core`,
        answer?.outcome === 'refused' && answer.rule === 'key.valid',
        `it answered rule ${String(answer?.rule)} (code ${String(answer?.code)}); stdout: ${result.stdout.trim()} stderr: ${result.stderr.trim()}`,
      );
    }

    // `feedback` takes no lease, so it is exercised by writing one.
    const feedback = await spawnBinary(
      COMMAND_LINE,
      [
        'feedback',
        '--rating',
        '4',
        '--category',
        'worked-well',
        '--note',
        'the operations check drove this through the shipped executable',
        '--json',
      ],
      { env: environment },
    );
    let recorded;
    try {
      recorded = JSON.parse(feedback.stdout.trim());
    } catch {
      recorded = undefined;
    }
    check(
      'broker feedback records a row through the shipped executable',
      feedback.code === 0 && recorded?.outcome === 'accepted',
      `exit ${String(feedback.code)}; stdout: ${feedback.stdout.trim()} stderr: ${feedback.stderr.trim()}`,
    );

    // ── A feedback row carries the lease it was written about ────────────
    //
    // Submitting with a lease key attaches `leaseKeyHash`, which resolves to
    // the granting lease's `claim_id`. Nothing pinned that: dropping the
    // attachment entirely left the whole suite and this check green, because
    // the only assertion on feedback was that a row was written at all, and
    // a row is still written without it.
    //
    // Both halves are asserted, and the pair is the point. A check that only
    // looked for a lease on the keyed row would pass against a build that
    // stamped every row with something, and a check that only looked for its
    // absence on the unkeyed row would pass against a build that attached
    // nothing at all — which is exactly the mutation that survived. Together
    // they say the attachment tracks the key.
    //
    // Read back through the *other* binary, which prints the resolved lease
    // rather than the hash — so this measures the thing the column is for
    // (a row bound to the lease it describes) rather than that a field is
    // non-null.
    const keyedFeedback = await spawnBinary(
      COMMAND_LINE,
      [
        'feedback',
        '--rating',
        '5',
        '--category',
        'worked-well',
        '--note',
        'submitted while holding the lease this check granted',
        '--lease-key',
        granted?.value?.key ?? 'no-key-was-granted',
        '--json',
      ],
      { env: environment },
    );
    check(
      'broker feedback accepts a submission carrying a lease key',
      keyedFeedback.code === 0,
      `exit ${String(keyedFeedback.code)}; stdout: ${keyedFeedback.stdout.trim()} stderr: ${keyedFeedback.stderr.trim()}`,
    );

    const feedbackRows = await spawnBinary(COMMAND_LINE, ['feedback'], { env: environment });
    const keyedLine = feedbackRows.stdout
      .split('\n')
      .findIndex((line) => line.includes('submitted while holding the lease this check granted'));
    const unkeyedLine = feedbackRows.stdout
      .split('\n')
      .findIndex((line) =>
        line.includes('the operations check drove this through the shipped executable'),
      );
    const lines = feedbackRows.stdout.split('\n');

    // The context line sits directly above the note in each entry.
    const keyedContext = keyedLine > 0 ? (lines[keyedLine - 1] ?? '') : '';
    const unkeyedContext = unkeyedLine > 0 ? (lines[unkeyedLine - 1] ?? '') : '';

    check(
      'a feedback row submitted with a lease resolves to the lease that granted it',
      typeof granted?.value?.claimId === 'string' && keyedContext.includes(granted.value.claimId),
      `the entry read back as ${JSON.stringify(keyedContext)}, expecting lease ${String(granted?.value?.claimId)}`,
    );
    check(
      'a feedback row submitted without a lease is bound to none',
      unkeyedContext.includes('no context was captured'),
      `the entry read back as ${JSON.stringify(unkeyedContext)}`,
    );

    // ── The tool shim drives a whole lease, in one session ────────────────
    //
    // The stdio surface is the route a calling agent uses, and it is the one
    // that can carry a lease through its whole life: `browser_claim` returns
    // the key it issued, which is the single named exception to the rule
    // above. So the lifecycle is asserted here and not on the command line.
    const first = await spawnBinary(TOOL_SHIM, [], {
      env: environment,
      input: callLine(1, 'browser_claim', {
        session_id: 'operations-check',
        browser: 'regular',
        purpose: 'driving a whole lease through the tool shim',
      }),
    });

    const grantMessages = parseMessages(first.stdout);
    const grant = grantMessages[0]?.result?.value;

    check(
      'the tool shim grants a lease and exits when its input ends',
      first.code === 0 && grant?.outcome === 'granted' && typeof grant.key === 'string',
      `exit ${String(first.code)}; stdout: ${first.stdout.trim()} stderr: ${first.stderr.trim()}`,
    );

    if (typeof grant?.key === 'string') {
      // ── The claim outlived the process that made it ────────────────────
      //
      // A *second* spawn, with the key the first one issued. This is the
      // assertion no injected service can satisfy: the lease was written to
      // a store by a process that has since exited, and this process finds
      // it there. It also proves the two spawns agree about where the store
      // is, which is the other half of "installation is the whole of
      // deployment".
      const second = await spawnBinary(TOOL_SHIM, [], {
        env: environment,
        input:
          callLine(2, 'browser_status', { lease_key: grant.key }) +
          callLine(3, 'browser_navigate', {
            lease_key: grant.key,
            url: 'https://example.com/',
          }) +
          // `read` and `capture` are the two verbs the silent-acceptance
          // defect was actually measured on — `read` named an artifact and
          // `capture` reported an image while the `captures` table stayed
          // empty — so they are driven here rather than assumed to behave
          // like `navigate`.
          callLine(4, 'browser_read', { lease_key: grant.key }) +
          callLine(5, 'browser_capture', { lease_key: grant.key }) +
          callLine(6, 'browser_tab_replace', { lease_key: grant.key }),
      });

      const messages = parseMessages(second.stdout);
      const [status, navigate, read, capture, replace] = messages.map((message) => message.result);

      check(
        'a lease granted by one process is found by the next',
        status?.outcome === 'accepted' && status.value?.claimId === grant.claimId,
        `status answered ${JSON.stringify(status)}`,
      );
      check(
        'the lease is active and holds the tab the grant named',
        status?.value?.state === 'active' && status.value.tabId === grant.tabId,
        `status answered ${JSON.stringify(status?.value)}`,
      );

      // Every keyed call extends the lease (§3.3). Two calls in the same
      // session must therefore report expiries in order — this asserts the
      // renewal happened, rather than that a field is present.
      check(
        'a keyed call renews the lease it names',
        typeof status?.value?.expiresAt === 'string' &&
          typeof navigate?.value?.expiresAt === 'string' &&
          Date.parse(navigate.value.expiresAt) >= Date.parse(status.value.expiresAt),
        `status expired at ${String(status?.value?.expiresAt)}, navigate at ${String(navigate?.value?.expiresAt)}`,
      );

      check(
        'a page verb reaches the tab the lease holds',
        navigate?.outcome === 'accepted' && navigate.value?.tabId === grant.tabId,
        `navigate answered ${JSON.stringify(navigate)}`,
      );

      // ── The response says whether a page was actually driven ──────────
      //
      // The defect this pins was measured exactly here, through exactly this
      // route: `browser_read` answered `accepted` naming `artifacts:
      // ["snapshot"]` and `browser_capture` answered `accepted`, while the
      // `captures` table held zero rows. Both were true statements about the
      // arbitration half and silent about the half that did not happen, and
      // `accepted` reads as success.
      //
      // This has to be asserted **here** rather than in the suite. Every test
      // that drives a page verb supplies its own session — correctly, since
      // that is the seam — and a caller that hands the browser in cannot
      // notice what a caller who does not hand one in is told. This check
      // injects nothing and speaks to the binary over a pipe, so it sees the
      // build a person actually gets.
      //
      // ── Why this asserts a RELATIONSHIP and not a constant ─────────────
      //
      // An earlier version asserted `pageDriven === false` outright, on the
      // stated premise that the build attached no session source. That premise
      // is gone: the binaries now reach a browser whenever one can be reached,
      // so the honest answer here depends on the machine — `true` where one is
      // installed, `false` on a runner with none, and `false` on a machine
      // where the launch failed.
      //
      // Asserting either constant would therefore be wrong somewhere, and
      // asserting neither would accept a field wired to anything at all. So
      // what is asserted is the thing that must hold **on every machine**:
      // that the field and the world agree. `capture` is the verb that makes
      // this checkable, because its claim leaves a file — a capture reporting
      // `pageDriven: true` must have written one, and one reporting `false`
      // must not have. A field wired to a constant fails this on one machine
      // or the other: `false` wherever a browser exists, `true` wherever none
      // does.
      const capturesTaken = countCapturedImages(environment.BROKER_ARTIFACTS_ROOT);
      const drovePage = capture?.value?.pageDriven === true;

      check(
        'what capture reports about driving a page matches what it actually wrote',
        capture?.outcome === 'accepted' &&
          typeof capture.value?.pageDriven === 'boolean' &&
          capturesTaken === (drovePage ? 1 : 0),
        `capture answered ${JSON.stringify(capture?.value)} while ${String(capturesTaken)} image(s) were written`,
      );

      // The other three answer the same way as `capture` did, because they ran
      // against the same browser in the same session. A build honest on one
      // verb and silent on another is the failure the shared field exists to
      // prevent, and it is only observable by comparing them.
      check(
        'every page verb gives the same answer about the same browser',
        navigate?.value?.pageDriven === drovePage &&
          read?.value?.pageDriven === drovePage &&
          replace?.value?.pageDriven === drovePage,
        `navigate=${String(navigate?.value?.pageDriven)} read=${String(read?.value?.pageDriven)} replace=${String(replace?.value?.pageDriven)} capture=${String(drovePage)}`,
      );

      // `read` still names the artifacts it decided on and `capture` still
      // reports the mode it decided on, whether or not a page moved, because
      // both are true statements about what was decided. What they must not do
      // is let a caller read that as a page having been touched.
      check(
        'read still names the artifacts it decided on',
        read?.outcome === 'accepted' &&
          Array.isArray(read.value?.artifacts) &&
          read.value.artifacts.includes('snapshot'),
        `read answered ${JSON.stringify(read?.value)}`,
      );

      // The tab is genuinely exchanged: the replacement is a different
      // identifier, and the one given up is the one the lease held.
      check(
        'tab replace exchanges the tab rather than reporting the same one',
        replace?.outcome === 'accepted' &&
          replace.value?.previousTabId === grant.tabId &&
          typeof replace.value.tabId === 'string' &&
          replace.value.tabId !== grant.tabId,
        `tab replace answered ${JSON.stringify(replace)}`,
      );

      // ── The person-facing surface says it in words ────────────────────
      //
      // The boolean is what a program branches on; the default command-line
      // mode is for a person, and a bare `pageDriven: false` among four
      // identifiers asks the reader to already know what the field means.
      // This drives the *other* binary, in its *default* mode, and asserts
      // the prose — so the two surfaces cannot end up honest on one and
      // cryptic on the other.
      const humanCapture = await spawnBinary(COMMAND_LINE, ['capture', '--lease-key', grant.key], {
        env: environment,
      });
      // Asserted the same way as the boolean above: **the prose and the field
      // agree**, on whichever machine this runs. A verb that drove a page says
      // nothing about not driving one, and a verb that did not says it in
      // words rather than leaving `pageDriven: false` among four identifiers
      // for the reader to interpret.
      const humanSaysNotDriven =
        humanCapture.stdout.includes('no browser was reached') &&
        humanCapture.stdout.includes('was not driven');
      check(
        'the command line and the field tell a person the same story',
        humanCapture.code === 0 &&
          humanSaysNotDriven === humanCapture.stdout.includes('pageDriven: false'),
        `exit ${String(humanCapture.code)}; stdout: ${humanCapture.stdout.trim()} stderr: ${humanCapture.stderr.trim()}`,
      );

      // Released last, in its own exchange, because everything above needs
      // the lease to still be live — the check caught this itself the first
      // time it was written the other way round, refusing with `claim.live`.
      const third = await spawnBinary(TOOL_SHIM, [], {
        env: environment,
        input: callLine(8, 'browser_release', { lease_key: grant.key }),
      });
      const release = parseMessages(third.stdout)[0]?.result;

      check(
        'release gives the tab back',
        release?.outcome === 'accepted' &&
          release.value?.released === 'tab' &&
          release.value.alreadyEnded === false,
        `release answered ${JSON.stringify(release)}`,
      );

      // ── Reconciliation is reachable from the shipped executable ──────
      //
      // **This is the assertion this check exists for, applied to the one
      // command most likely to fail it.** The whole rationale at the head of
      // this file is that a service handed in by a test cannot notice that
      // nobody else hands it in; `broker reconcile` has the same exposure one
      // layer along, because it needs a *browser session provider* and the
      // only thing that supplies one is `src/bin/broker.ts`. A dispatcher
      // wired correctly and a binary that forgot to pass `session` produces a
      // command that every in-process test passes and every real invocation
      // refuses.
      //
      // So the assertion is specifically that it does **not** answer
      // `browser.unreachable` — the refusal the command gives when it was
      // handed no way to ask a browser anything.
      //
      // What this deliberately does not assert is that a browser was reached.
      // This check runs where no browser may be installed, so requiring a
      // successful attach would make it fail for a reason that is not about
      // the wiring. The refusal above is produced *before* any browser is
      // contacted, which is exactly what makes it the right thing to look
      // for: its absence proves the provider arrived.
      const reconcile = await spawnBinary(COMMAND_LINE, ['reconcile', 'regular', '--json'], {
        env: environment,
      });

      check(
        'the shipped command line hands reconciliation a way to ask a browser',
        !reconcile.stderr.includes('browser.unreachable'),
        `\`broker reconcile\` was not given a browser session by the executable.\n         exit ${String(reconcile.code)}\n         stdout: ${reconcile.stdout.trim()}\n         stderr: ${reconcile.stderr.trim()}`,
      );

      // And the command is one a person can find. A command wired into the
      // dispatcher but missing from the table works and is undiscoverable,
      // which §5.4 names as the failure of a command absent from the help.
      const help = await spawnBinary(COMMAND_LINE, ['--help'], { env: environment });
      check(
        'the shipped command line lists reconcile among its commands',
        help.code === 0 && help.stdout.includes('reconcile'),
        `\`broker --help\` did not name reconcile; stdout: ${help.stdout.trim()}`,
      );

      // ── The decisions were written down ──────────────────────────────
      //
      // §1.6 keeps one row per decision and records which door it came in
      // through. Reading the ledger back through the *command line* closes
      // the loop across both executables: operations performed by the shim
      // are visible to the other binary, attributed to the surface that
      // performed them.
      const events = await spawnBinary(COMMAND_LINE, ['events'], { env: environment });
      check(
        'the ledger records the tool surface as the door these came in through',
        events.code === 0 && events.stdout.includes('via=tool-stdio'),
        `the ledger read back as: ${events.stdout.trim()}`,
      );
      check(
        'the ledger records the command line separately',
        events.stdout.includes('via=cli'),
        `no command-line decision was recorded; ledger: ${events.stdout.trim()}`,
      );
    }
  } finally {
    // ── End the browsers this check started ──────────────────────────────
    //
    // A cold start is **detached on purpose**, so a browser this check caused
    // outlives it — which is right for the product and wrong for a check that
    // is about to delete the profile directory that browser is holding open.
    // Without this the removal below fails with a permission error on any
    // machine that has a browser installed, and it fails *after* every
    // assertion has passed, which is the most misleading way for a check to go
    // red.
    //
    // This is a **test fixture ending its own fixture**, not the service
    // ending a browser: the service never does that, which is why there is no
    // operation for it and why this reads the identifier out of the store
    // rather than asking the service to help.
    await endBrowsersStartedBy(temporaryRoot);
    await removeWhenReleased(temporaryRoot);
  }

  return { failures, notes };
}

/**
 * End any browser running against a profile under this check's own root.
 *
 * ── Only ever this check's own browsers ─────────────────────────────────
 *
 * The address comes from the record the browser wrote **inside a profile
 * directory this check created**, under a temporary root of its own. A browser
 * somebody else is running lives somewhere else and is never read, never
 * addressed and never ended. That scoping is the whole safety argument, and it
 * is why this walks the root rather than looking for browsers by name.
 *
 * Asked to close rather than signalled, which is both gentler and simpler:
 * the record carries an address, not a process identifier, and a browser told
 * to close releases the directory it is holding — which is the thing standing
 * between this and a clean removal.
 *
 * Every failure is ignored. On the ordinary path — a machine with no browser
 * installed — nothing was started, no record exists, and this does nothing at
 * all.
 */
async function endBrowsersStartedBy(temporaryRoot) {
  const profiles = path.join(temporaryRoot, 'profiles');
  let entries;
  try {
    entries = readdirSync(profiles, { withFileTypes: true });
  } catch {
    // No profile root means nothing was ever started.
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    let port;
    try {
      const contents = readFileSync(path.join(profiles, entry.name, 'DevToolsActivePort'), 'utf8');
      const firstLine = contents.split(LINE_BREAK)[0];
      port = Number.parseInt(firstLine ?? '', 10);
    } catch {
      // No record: this profile never had a browser, which is the state on
      // any machine without one installed.
      continue;
    }
    if (!Number.isInteger(port) || port <= 0) continue;

    try {
      const { chromium } = await import('playwright-core');
      const connection = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
      await connection.close();
    } catch {
      // Already gone, never there, or the package is not installed — all of
      // which mean there is nothing here to end.
    }
  }
}

/**
 * Remove a directory once whatever was holding it has let go.
 *
 * ── Why this retries rather than removing once ──────────────────────────
 *
 * A browser holds its profile directory open, and the operating system
 * releases those handles when the process **finishes** exiting — which is a
 * moment after the close call returns, not at the same instant. Removing
 * immediately fails with a permission error on a machine where a browser was
 * actually started, and it fails *after* every assertion has already passed,
 * which is the most misleading possible way for a check to go red.
 *
 * **Gives up quietly rather than throwing.** A temporary directory that
 * outlives one run is litter in the platform's own temporary location;
 * reporting it as a failure would make a green check depend on the operating
 * system's timing rather than on anything this script is testing.
 */
async function removeWhenReleased(directory) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const result = await runOperationsCheck();
  for (const note of result.notes) {
    console.log(note);
  }
  if (result.failures.length > 0) {
    console.error('\nThe operations check failed:\n');
    for (const failure of result.failures) {
      console.error(failure);
    }
    console.error(
      '\nThe shipped executables must build a real service and reach it. A suite that injects\none cannot notice that nothing else does.',
    );
    process.exitCode = 1;
  } else {
    console.log(
      '\nOperations check passed: the shipped executables build a real service, drive a lease\nthrough its whole life across separate processes, and record every decision.',
    );
  }
}
