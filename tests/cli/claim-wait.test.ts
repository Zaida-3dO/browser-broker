import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  BrokerService,
  OperationOutcome,
  OperationRequest,
} from '../../src/adapter/service-seam.ts';
import { run } from '../../src/cli/index.ts';

/**
 * `broker claim --wait` (§5.3) — the command line's answer to the
 * keep-calling-in protocol.
 *
 * ── What is under test, and what deliberately is not ────────────────────
 *
 * §5.3: it "polls at just under the lease lifetime until the lease becomes
 * active or the place is lost", and "calls the same operation on every poll
 * and adds none of its own". Those are the two properties asserted here, plus
 * the one §2.5 adds: **polling is renewing**, and there is no renew verb — so
 * a loop that reached for one would be inventing what the design removed.
 *
 * ── Why the interval is asserted rather than the elapsed time ───────────
 *
 * Against the default queue lifetime the poll interval is nine minutes. A
 * test that actually waited would not be run, and one that shortened the wait
 * by reaching into the clock would be exercising a different mechanism than
 * the one that ships. So the *sleeping* is injected and the *number it is
 * asked to sleep for* is the assertion — that the loop honours the number the
 * service handed it, rather than one of its own. This is the
 * measure-the-mechanism rule: the property is the schedule, not the delay.
 */

/** What a fake service was asked to do, in order. */
interface Recorded {
  readonly operation: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * A service that answers a scripted sequence and records every call.
 *
 * Scripted rather than stateful so a test can put the queue-then-grant
 * transition exactly where it wants it, and can script the *lost place* case,
 * which a real queue would take a lifetime to produce.
 *
 * ── Why the script is exhausted rather than repeated ────────────────────
 *
 * An earlier version of this helper repeated its last response forever, and
 * that made the suite **unable to fail honestly for the two mutations that
 * matter most**: a loop that never recognises the grant, and one that polls a
 * lease it was handed outright. Both spin, so the run hung and had to be
 * killed on a timer — and a killed run reports as a failure for the wrong
 * reason, which is indistinguishable from the mutation being caught. It is
 * the *measure the mechanism, not the assertion* rule applied to a fixture:
 * a hang is not a failing test.
 *
 * Running out is therefore an explicit error naming the cause. Every test
 * below scripts exactly the responses its own path consumes, so exhaustion
 * only happens when the loop asked for more than it should have.
 */
function scriptedService(responses: readonly OperationOutcome[]): {
  readonly service: BrokerService;
  readonly calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;
  return {
    calls,
    service: {
      perform: (request: OperationRequest): Promise<OperationOutcome> => {
        calls.push({ operation: request.operation, arguments: request.arguments });
        const response = responses[index];
        index += 1;
        if (response === undefined) {
          throw new Error(
            `the wait made ${String(index)} calls but only ${String(responses.length)} were scripted — it polled when it should have stopped`,
          );
        }
        return Promise.resolve(response);
      },
    },
  };
}

const QUEUED = (position: number, checkBackSeconds = 540): OperationOutcome => ({
  outcome: 'accepted',
  value: {
    outcome: 'queued',
    claimId: 'claim-1',
    key: 'the-key',
    browserId: 'regular',
    position,
    queueSeconds: 600,
    expiresAt: '2026-01-01T00:10:00.000Z',
    checkBackSeconds,
    checkBack: 'call in with this key',
  },
});

const STILL_QUEUED = (position: number, checkBackSeconds = 540): OperationOutcome => ({
  outcome: 'accepted',
  value: {
    claimId: 'claim-1',
    state: 'queued',
    browserId: 'regular',
    purpose: 'waiting',
    expiresAt: '2026-01-01T00:10:00.000Z',
    ttlSeconds: 600,
    checkBackSeconds,
    checkBack: 'call in with this key',
    position,
    queueDepth: 2,
  },
});

const NOW_ACTIVE: OperationOutcome = {
  outcome: 'accepted',
  value: {
    claimId: 'claim-1',
    state: 'active',
    browserId: 'regular',
    purpose: 'waiting',
    expiresAt: '2026-01-01T00:20:00.000Z',
    ttlSeconds: 600,
    checkBackSeconds: 540,
    checkBack: 'call in with this key',
    tabId: 'tab-9',
  },
};

const GRANTED_OUTRIGHT: OperationOutcome = {
  outcome: 'accepted',
  value: {
    outcome: 'granted',
    claimId: 'claim-0',
    key: 'the-key',
    browserId: 'regular',
    tabId: 'tab-1',
    expiresAt: '2026-01-01T00:10:00.000Z',
    leaseSeconds: 600,
  },
};

const CLAIM_ARGV = [
  'claim',
  '--session-id',
  'waiter',
  '--browser',
  'regular',
  '--purpose',
  'a purpose of a legal length',
];

interface Driven {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly slept: number[];
  readonly calls: Recorded[];
}

async function drive(argv: string[], responses: readonly OperationOutcome[]): Promise<Driven> {
  const out: string[] = [];
  const err: string[] = [];
  const slept: number[] = [];
  const { service, calls } = scriptedService(responses);
  const code = await run(argv, {
    service,
    streams: { out: (l) => out.push(l), err: (l) => err.push(l) },
    // Instant, and recording. The duration is never shortened — it is
    // captured, which is the thing being asserted.
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  return { code, out, err, slept, calls };
}

test('a queued claim is waited on until it is granted, and the grant is what is printed', async () => {
  const result = await drive(
    [...CLAIM_ARGV, '--wait', '--json'],
    [QUEUED(2), STILL_QUEUED(1), NOW_ACTIVE],
  );

  assert.equal(result.code, 0);

  const document = JSON.parse(result.out.join('')) as {
    outcome: string;
    value: Record<string, unknown>;
  };
  assert.equal(document.outcome, 'accepted');
  // The wait ended in a grant, not in the queued response it started with.
  assert.equal(document.value['outcome'], 'granted');
  // The tab is the point: it is what the caller waited for, and the queued
  // response it started from could not have carried it.
  assert.equal(document.value['tabId'], 'tab-9');
  // The key comes from the claim, which is the only response that ever
  // carries it (§2.2).
  assert.equal(document.value['key'], 'the-key');

  // **No queue vocabulary survives into the grant.** Assembling the response
  // by spreading the queued one is the tempting shortcut and it is wrong:
  // `position`, `queueSeconds` and the check-back sentence all describe how
  // to hold a *place*, and a granted lease occupies none. A grant carrying
  // queue advice reads as though the wait had not finished.
  assert.equal(document.value['position'], undefined);
  assert.equal(document.value['queueSeconds'], undefined);
  assert.equal(document.value['checkBack'], undefined);
  assert.equal(document.value['checkBackSeconds'], undefined);
});

/**
 * The schedule, which is the whole of §5.3's requirement.
 *
 * Asserted as the *numbers the loop asked to sleep for*, taken from what the
 * service said rather than from a constant in this file — 540 is nine parts
 * in ten of the 600-second place the scripted response describes, which is
 * what `checkBackSeconds()` computes and what the queued caller is told.
 */
test('it polls at just under the lifetime, using the number the service supplied', async () => {
  const result = await drive(
    [...CLAIM_ARGV, '--wait', '--json'],
    [QUEUED(2), STILL_QUEUED(1), NOW_ACTIVE],
  );

  assert.deepEqual(result.slept, [540_000, 540_000], 'both waits are the advertised check-back');

  // And it is *under* the lifetime rather than at it — the property the
  // number encodes, asserted as a property so a changed fraction still has to
  // keep it.
  for (const waited of result.slept) {
    assert.ok(waited < 600_000, 'a poll scheduled at the deadline races the reclamation');
  }
});

/**
 * The interval is re-read on every poll rather than captured once.
 *
 * A lifetime reconfigured mid-wait should move the schedule with it. Captured
 * once, the loop would keep polling on a number the service has stopped
 * offering — and would outlive a place that had become shorter.
 */
test('a changed check-back is followed rather than the first one being kept', async () => {
  const result = await drive(
    [...CLAIM_ARGV, '--wait', '--json'],
    [QUEUED(2, 540), STILL_QUEUED(1, 90), NOW_ACTIVE],
  );

  assert.deepEqual(result.slept, [540_000, 90_000], 'the second wait follows the second response');
});

/**
 * **Polling is renewing** (§2.5), and there is deliberately no renew verb.
 *
 * The assertion is over the *operations* the loop invoked: a claim, then
 * nothing but `status`. A loop that reached for a renewal would show up here
 * as a third operation name, and one that re-claimed instead of polling would
 * show up as a second `claim` — which would be worse than useless, since it
 * would queue a fresh place at the back and abandon the one being waited on.
 */
test('it holds the place by asking about it, and invents no renew verb', async () => {
  const result = await drive(
    [...CLAIM_ARGV, '--wait', '--json'],
    [QUEUED(3), STILL_QUEUED(2), STILL_QUEUED(1), NOW_ACTIVE],
  );

  assert.deepEqual(
    result.calls.map((call) => call.operation),
    ['claim', 'status', 'status', 'status'],
  );

  // Every poll carries the key, which is what makes it a renewal.
  for (const call of result.calls.slice(1)) {
    assert.equal(call.arguments['key'], 'the-key');
  }
});

/**
 * `--wait` is a behaviour of this route, not an argument to the operation.
 *
 * §3.2 has no `wait` field, and §5.3 calls this "the one place this route
 * does something the tool surface does not". If the flag were read through
 * `parseArguments` it would be normalised into the arguments record and sent
 * to the service, which would be a route inventing an argument the operation
 * does not have.
 */
test('the flag never reaches the service as an argument', async () => {
  const result = await drive([...CLAIM_ARGV, '--wait', '--json'], [GRANTED_OUTRIGHT]);

  const claim = result.calls[0];
  assert.ok(claim);
  assert.equal(claim.operation, 'claim');
  assert.equal(claim.arguments['wait'], undefined, '--wait is not a claim argument');
  // The real arguments did arrive, so this is not passing by sending nothing.
  assert.equal(claim.arguments['session_id'], 'waiter');
  assert.equal(claim.arguments['browser'], 'regular');
});

/**
 * A claim that was granted outright does not wait.
 *
 * The opposite failure to the one above and just as real: a loop that polled
 * once regardless would spend a check-back interval — nine minutes by
 * default — proving what the first response already said.
 */
test('a claim granted outright returns immediately and never sleeps', async () => {
  const result = await drive([...CLAIM_ARGV, '--wait', '--json'], [GRANTED_OUTRIGHT]);

  assert.equal(result.code, 0);
  assert.deepEqual(result.slept, [], 'nothing to wait for');
  assert.deepEqual(
    result.calls.map((call) => call.operation),
    ['claim'],
    'no poll was made',
  );
  const document = JSON.parse(result.out.join('')) as { value: Record<string, unknown> };
  assert.equal(document.value['outcome'], 'granted');
});

/**
 * Without the flag, a queued claim is still queued — the outcome §5.6 insists
 * is a success rather than a failure.
 *
 * This is the control that makes every assertion above about `--wait`
 * specifically, rather than about `claim`. Without it, a loop that ran
 * unconditionally would satisfy the grant test and nothing here would notice.
 */
test('without the flag a queued claim returns its place rather than waiting', async () => {
  const result = await drive([...CLAIM_ARGV, '--json'], [QUEUED(2), STILL_QUEUED(1), NOW_ACTIVE]);

  assert.equal(result.code, 0, 'queuing is an outcome, not a failure');
  assert.deepEqual(result.slept, []);
  assert.deepEqual(
    result.calls.map((call) => call.operation),
    ['claim'],
  );

  const document = JSON.parse(result.out.join('')) as { value: Record<string, unknown> };
  assert.equal(document.value['outcome'], 'queued');
});

/**
 * The place is lost, or the key stops being recognised.
 *
 * §5.3 names this as the other way the wait ends. The service's own refusal
 * is what is returned — reworded by nobody — so the caller sees the rule that
 * ended the wait, and the exit code is the refusal code rather than the
 * success one.
 */
test('a refusal during the wait ends it, and the service’s own rule is what is reported', async () => {
  const lost: OperationOutcome = {
    outcome: 'refused',
    code: 'unrecognised_key',
    rule: 'key.valid',
    message: 'that key is not one this service issued',
  };
  const result = await drive([...CLAIM_ARGV, '--wait', '--json'], [QUEUED(1), lost]);

  assert.equal(result.code, 3, 'refused, and distinguishable from both success and a crash');
  const document = JSON.parse(result.out.join('')) as Record<string, unknown>;
  assert.equal(document['outcome'], 'refused');
  assert.equal(document['rule'], 'key.valid');
});

/**
 * The wait says what it is doing, on the error stream.
 *
 * Two reasons it is not optional. A command that blocks silently for nine
 * minutes is indistinguishable from one that has hung — and §5.6 requires
 * `--json` to produce exactly one document, so the progress text has nowhere
 * to go but the error stream.
 */
test('it announces the schedule it is keeping, without disturbing the document', async () => {
  const result = await drive(
    [...CLAIM_ARGV, '--wait', '--json'],
    [QUEUED(2), STILL_QUEUED(1), NOW_ACTIVE],
  );

  const announced = result.err.join('\n');
  assert.match(announced, /queued at position 2/);
  // The interval and the lifetime are both said, because the useful thing to
  // a person reading it is *why* the number is not the lifetime.
  assert.match(announced, /540/);
  assert.match(announced, /600/);
  assert.match(announced, /granted/);

  // Exactly one document on the output stream, per §5.6.
  assert.equal(result.out.length, 1);
  JSON.parse(result.out[0] ?? '');
});
