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
import { mkdtempSync, rmSync } from 'node:fs';
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

    // §5.6, asserted against the real path rather than against a stub: the
    // key is absent rather than masked, in the machine-readable mode.
    check(
      'the command line does not print the lease key it just issued',
      granted?.value !== undefined && !('key' in granted.value),
      `the grant carried ${JSON.stringify(Object.keys(granted?.value ?? {}))}`,
    );

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
      // The value is asserted `=== false` rather than merely present:
      // this build attaches no session source, so `false` is the true
      // answer, and a check satisfied by either value would pass just as
      // happily against a field wired to a constant.
      check(
        'a page verb tells the caller no browser was driven',
        navigate?.value?.pageDriven === false,
        `navigate answered ${JSON.stringify(navigate?.value)}`,
      );
      check(
        'tab replace tells the caller no browser was driven',
        replace?.value?.pageDriven === false,
        `tab replace answered ${JSON.stringify(replace?.value)}`,
      );

      // The two the defect was reported against, asserted together with the
      // thing that made them a lie: `read` still names the artifacts it
      // *would* collect and `capture` still reports the mode it *would* use,
      // because both are true statements about what was decided. What they
      // must not do any more is let a caller read that as a page having been
      // touched.
      check(
        'read still names its artifacts and now says none were collected',
        read?.outcome === 'accepted' &&
          Array.isArray(read.value?.artifacts) &&
          read.value.artifacts.includes('snapshot') &&
          read.value.pageDriven === false,
        `read answered ${JSON.stringify(read?.value)}`,
      );
      check(
        'capture reports acceptance and says no image was taken',
        capture?.outcome === 'accepted' && capture.value?.pageDriven === false,
        `capture answered ${JSON.stringify(capture?.value)}`,
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
      check(
        'the command line tells a person in words that no page was driven',
        humanCapture.code === 0 &&
          humanCapture.stdout.includes('no browser is attached') &&
          humanCapture.stdout.includes('was not driven'),
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
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  return { failures, notes };
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
