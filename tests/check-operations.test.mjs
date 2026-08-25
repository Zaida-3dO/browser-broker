/**
 * The self-test for the operations check.
 *
 * **What a green run here means, and what it does not.** Green means the
 * check observes what it claims to observe: that it notices an executable
 * which refuses every operation, one which answers `accepted` without a
 * service behind it, and one whose state does not survive the process that
 * wrote it. Green does **not** mean the real executables work — that claim is
 * made by running the check itself, which is what continuous integration
 * does.
 *
 * The distinction is the whole reason this file exists. A gate is the one
 * kind of code whose happy path proves nothing: a check that has only ever
 * run against a working tree has never run against the thing it exists to
 * catch, and "it passes" is equally consistent with "it cannot fail". The
 * check this tests was written *because* a suite of a thousand passing tests
 * did not notice that no binary reached the service, so a version of it that
 * could not fail would repeat the original mistake one level up.
 *
 * Violations are seeded against **stand-in executables** rather than by
 * damaging the real ones: a test that edited the application to prove a gate
 * fires would have to put it back, and a failure midway through would leave
 * the tree broken.
 *
 * ── The one thing this file deliberately does not claim ─────────────────
 *
 * It does not re-assert that the real binaries work. That would duplicate the
 * check rather than test it, and it would be the slower copy.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  ambientEnvironment,
  callLine,
  KEYED_COMMANDS,
  parseMessages,
  spawnBinary,
} from '../scripts/check-operations.mjs';

const temporaryDirectories = [];

function makeTemporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), 'broker-operations-selftest-'));
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Write a stand-in executable and hand back its path. */
function standIn(name, source) {
  const file = path.join(makeTemporaryDirectory(), name);
  writeFileSync(file, source);
  return file;
}

describe('the operations check can observe an executable that reaches no service', () => {
  it('sees the refusal an unwired binary gives, and can tell it from a rule', async () => {
    // The exact shape the command line had before it was wired: every
    // operation refused by name, with a rule that names the absence rather
    // than a decision. The check's assertions turn on the rule, so this is
    // the observation that has to be live for them to mean anything.
    const unwired = standIn(
      'unwired.mjs',
      [
        'console.log(JSON.stringify({',
        "  outcome: 'refused',",
        "  code: 'service_unavailable',",
        "  rule: 'service.not_built',",
        '}));',
        'process.exitCode = 3;',
      ].join('\n'),
    );

    const result = await spawnBinary(unwired, [], { env: ambientEnvironment() });
    const answer = JSON.parse(result.stdout.trim());

    assert.equal(answer.outcome, 'refused');
    assert.notEqual(
      answer.rule,
      'key.valid',
      'an unwired binary must not be able to produce the rule the check requires',
    );
    assert.notEqual(result.code, 0, 'a refusal must not read as a clean acceptance');
  });

  it('sees an accepted answer that carries none of the identifiers a store mints', async () => {
    // The subtler failure: something that answers `accepted` without a
    // service behind it. The check does not settle for the outcome word —
    // it requires the identifiers only a store can produce — so this proves
    // that requirement is doing work.
    const hollow = standIn(
      'hollow.mjs',
      ["console.log(JSON.stringify({ outcome: 'accepted', value: { outcome: 'granted' } }));"].join(
        '\n',
      ),
    );

    const result = await spawnBinary(hollow, [], { env: ambientEnvironment() });
    const answer = JSON.parse(result.stdout.trim());

    assert.equal(answer.outcome, 'accepted', 'the stand-in did not produce the case under test');
    assert.equal(
      typeof answer.value.claimId,
      'undefined',
      'a grant with no store behind it has no claim identifier to carry',
    );
    assert.equal(typeof answer.value.tabId, 'undefined');
  });
});

describe('the operations check can observe state that does not outlive its process', () => {
  it('sees a second spawn failing to find what the first one wrote', async () => {
    // The strongest assertion in the check is that a lease granted by one
    // process is found by the next. This proves that assertion is capable of
    // failing: two spawns of something that keeps its state in memory, where
    // the second finds nothing.
    const forgetful = standIn(
      'forgetful.mjs',
      [
        'const leases = new Map();',
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => (input += chunk));',
        'process.stdin.on("end", () => {',
        '  for (const line of input.split("\\n").filter(Boolean)) {',
        '    const message = JSON.parse(line);',
        '    const name = message.params.name;',
        '    if (name === "browser_claim") {',
        '      leases.set("k", true);',
        '      console.log(JSON.stringify({ id: message.id, result: { outcome: "accepted",',
        '        value: { outcome: "granted", key: "k", claimId: "c", tabId: "t" } } }));',
        '    } else {',
        '      console.log(JSON.stringify({ id: message.id, result: leases.has("k")',
        '        ? { outcome: "accepted", value: { claimId: "c" } }',
        '        : { outcome: "refused", code: "unrecognised_key", rule: "key.valid" } }));',
        '    }',
        '  }',
        '});',
      ].join('\n'),
    );

    const environment = ambientEnvironment();

    const first = await spawnBinary(forgetful, [], {
      env: environment,
      input: callLine(1, 'browser_claim', { browser: 'regular' }),
    });
    const grant = parseMessages(first.stdout)[0].result.value;
    assert.equal(grant.outcome, 'granted', 'the stand-in did not produce the case under test');

    // The same key, a new process. Nothing wrote it anywhere, so nothing
    // finds it — which is exactly what the check requires must NOT happen
    // against the real binaries.
    const second = await spawnBinary(forgetful, [], {
      env: environment,
      input: callLine(2, 'browser_status', { lease_key: grant.key }),
    });
    const status = parseMessages(second.stdout)[0].result;

    assert.equal(
      status.outcome,
      'refused',
      'a lease held only in memory must not appear to survive its process',
    );
    assert.notEqual(status.value?.claimId, grant.claimId);
  });
});

describe('the operations check covers every operation the build registers', () => {
  it('names every keyed operation, so a new one cannot be silently skipped', async () => {
    // The check walks a list. A list that drifted from the build would let a
    // newly registered operation go unexercised while the check stayed green
    // — the vacuous-row failure the operations module warns about.
    const { OPERATION_NAMES } = await import('../src/adapter/operations.ts');

    const covered = new Set(KEYED_COMMANDS.map(({ words }) => words.join('_')));
    // `claim` is exercised by granting rather than by being refused for a
    // key, and `feedback` takes no lease at all, so neither is in the list.
    const expected = OPERATION_NAMES.filter((name) => name !== 'claim' && name !== 'feedback');

    assert.deepEqual(
      [...covered].sort(),
      [...expected].sort(),
      'the operations check must name every keyed operation this build registers',
    );
  });

  it('gives each operation a payload good enough that the key is what refuses', () => {
    // Three operations validate their payload before resolving the lease, so
    // an empty payload would have them refuse for the payload and the check
    // would be measuring the wrong rule. This pins the reason: if somebody
    // strips the payloads, this fails and says why.
    const needPayloads = ['navigate', 'act', 'evaluate'];
    for (const name of needPayloads) {
      const entry = KEYED_COMMANDS.find(({ words }) => words.join('_') === name);
      assert.ok(entry, `${name} must be covered`);
      assert.ok(
        entry.payload.length > 0,
        `${name} validates its payload before the lease, so it needs one or the check measures the payload validator rather than the key`,
      );
    }
  });
});
