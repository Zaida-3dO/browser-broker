/**
 * The tab-budget agreement, asserted **through the shipped executable**.
 *
 * ── Why this file exists beside `tests/store/budget.test.ts` ────────────
 *
 * That suite drives `prepareStore` directly and proves the agreement's logic:
 * who records, who compares, what the refusal says, that neither number is
 * adopted. It is thorough and it is not sufficient, because every assertion in
 * it begins by calling the function under test. **A suite that calls the
 * mechanism can only tell you the mechanism works — never that anything ships
 * with it wired in.** The failure it is blind to is the one where a binary
 * assembles its own open-and-step sequence and never reaches the agreement at
 * all: `tab_budget` stays empty, `broker doctor` reports that no budget has
 * been recorded, and two processes configured for different budgets both start
 * cleanly, while that unit suite stays green throughout.
 *
 * So these assertions run `broker` as a child process with a real environment
 * and read the store back with a separate connection. Nothing here imports the
 * store layer to make its point. What is proved is the property the product
 * owes: **that a spawn of this executable records and enforces the bound.**
 *
 * ── The control that keeps this honest ──────────────────────────────────
 *
 * A refusal that fires on every second spawn is not an agreement, it is a
 * broken installation — and a test that only asserted the refusal would pass
 * just as well against one. `a second spawn whose budget agrees starts
 * normally` below is that control, and it fails if the comparison is ever
 * inverted or widened into "anything already recorded refuses".
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ambientEnvironment, spawnBroker } from '../../scripts/check-install.mjs';

const directories = [];

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A store location nothing has touched, plus the environment a spawn reads.
 *
 * The paths are computed from the platform's temporary directory rather than
 * written down: a literal path names one machine, and the hygiene gate refuses
 * one in a tracked file.
 */
function freshInstallation() {
  const directory = mkdtempSync(path.join(tmpdir(), 'broker-budget-binary-'));
  directories.push(directory);
  const databasePath = path.join(directory, 'broker.db');
  return {
    databasePath,
    environmentFor: (budget) => ({
      ...ambientEnvironment(),
      BROKER_DB: databasePath,
      BROKER_ARTIFACTS_ROOT: path.join(directory, 'artefacts'),
      BROKER_PROFILE_ROOT: path.join(directory, 'profiles'),
      BROKER_TAB_BUDGET: String(budget),
    }),
  };
}

/**
 * Read the recorded budget with a connection of this test's own.
 *
 * Deliberately raw SQL on a separate handle rather than the application's own
 * reader: the question is what is *in the file* after a real process exited,
 * and asking the application would mean trusting the layer under test to
 * report on itself.
 */
function recordedBudget(databasePath) {
  if (!existsSync(databasePath)) {
    return { rows: [], value: null };
  }
  const db = new Database(databasePath, { readonly: true });
  try {
    const rows = db.prepare('SELECT only_row, tabs FROM tab_budget').all();
    return { rows, value: rows.length === 1 ? rows[0].tabs : null };
  } finally {
    db.close();
  }
}

describe('the tab-budget agreement, through the shipped executable', () => {
  it('a spawn records the budget it was configured with', async () => {
    const install = freshInstallation();

    const spawned = await spawnBroker(['init'], { env: install.environmentFor(9) });

    assert.equal(spawned.code, 0, `init did not succeed: ${spawned.stderr}`);

    const recorded = recordedBudget(install.databasePath);
    // Asserted as "one row holding nine" rather than "not empty": an empty
    // table is the shape this fails as, and a row holding some other number is
    // a different defect that deserves to be told apart from it.
    assert.deepEqual(
      recorded.rows,
      [{ only_row: 1, tabs: 9 }],
      'a spawn left the tab budget unrecorded, so nothing downstream can compare against it',
    );
  });

  it('a second spawn whose budget agrees starts normally', async () => {
    // ── The control ───────────────────────────────────────────────────────
    //
    // Without this, a comparison that refused every second spawn — or one that
    // refused whenever a row existed at all — would satisfy the refusal test
    // below while making the product unusable. This is the assertion that
    // separates "agreement" from "breakage".
    const install = freshInstallation();

    const first = await spawnBroker(['init'], { env: install.environmentFor(9) });
    assert.equal(first.code, 0, `the first spawn failed: ${first.stderr}`);

    const second = await spawnBroker(['init'], { env: install.environmentFor(9) });

    assert.equal(
      second.code,
      0,
      `a second spawn configured with the same budget was refused: ${second.stderr}`,
    );
    assert.doesNotMatch(
      second.stderr,
      /budget\.agrees_with_store/,
      'an agreeing spawn was told its budget disagreed',
    );
    assert.equal(recordedBudget(install.databasePath).value, 9);
  });

  it('a second spawn whose budget disagrees refuses to start, and names both numbers', async () => {
    const install = freshInstallation();

    const first = await spawnBroker(['init'], { env: install.environmentFor(9) });
    assert.equal(first.code, 0, `the first spawn failed: ${first.stderr}`);

    const second = await spawnBroker(['init'], { env: install.environmentFor(30) });

    assert.notEqual(
      second.code,
      0,
      'a process believing a different tab budget was allowed to start; the ceiling is not a ceiling',
    );
    assert.match(second.stderr, /budget\.agrees_with_store/);
    // Both numbers, because the operator has to decide which was meant and
    // cannot do that from a message naming one of them.
    assert.match(second.stderr, /\b9\b/);
    assert.match(second.stderr, /\b30\b/);
  });

  it('the refusing spawn neither adopts the stored budget nor overwrites it', async () => {
    const install = freshInstallation();

    await spawnBroker(['init'], { env: install.environmentFor(9) });
    await spawnBroker(['init'], { env: install.environmentFor(30) });

    assert.equal(
      recordedBudget(install.databasePath).value,
      9,
      'the disagreeing spawn moved a bound that other processes are mid-arbitration against',
    );
  });

  it('the refusal reaches commands other than init, because it is on the spawn path', async () => {
    // The agreement belongs to opening the store, not to one command. Wired
    // into `init` alone, every other entry point would still start against a
    // bound it disagreed with.
    const install = freshInstallation();
    await spawnBroker(['init'], { env: install.environmentFor(9) });

    const events = await spawnBroker(['events'], { env: install.environmentFor(30) });

    assert.notEqual(events.code, 0, 'broker events started against a disagreeing budget');
    assert.match(events.stderr, /budget\.agrees_with_store/);
  });

  it('doctor reports the recorded budget rather than saying none was recorded', async () => {
    const install = freshInstallation();
    await spawnBroker(['init'], { env: install.environmentFor(9) });

    const doctor = await spawnBroker(['doctor'], { env: install.environmentFor(9) });

    assert.match(
      doctor.stdout,
      /Both say 9/,
      `doctor did not report the recorded budget. Output was:\n${doctor.stdout}`,
    );
    assert.doesNotMatch(
      doctor.stdout,
      /No budget has been recorded/,
      'doctor reported no recorded budget against a store that has one',
    );
  });

  it('doctor reports a disagreement instead of refusing to run', async () => {
    // ── Why doctor must not take the spawn path ───────────────────────────
    //
    // A budget disagreement is one of the states `doctor` exists to describe.
    // Diagnosing it through a path that refuses on it would hand the operator a
    // refusal where the report naming both numbers is the whole point of
    // asking. So this asserts the report, and — when the automation check
    // does not itself fail first — asserts the exit code is the budget code
    // rather than a startup refusal.
    //
    // The automation check can legitimately fail first here: this spawns the
    // real `broker` binary as a child process, which resolves automation for
    // real (`src/browser/automation-probe.ts`) with no seam this test can
    // inject through, and §5.6's "lowest code wins" rule means a machine with
    // no resolvable browser binary reports 11 (automation) ahead of 16
    // (budget) — correct doctor behaviour, not a fault in the disagreement
    // this test exists to prove. The report naming both numbers without
    // refusing is what is asserted unconditionally either way.
    const install = freshInstallation();
    await spawnBroker(['init'], { env: install.environmentFor(9) });

    const doctor = await spawnBroker(['doctor'], { env: install.environmentFor(30) });

    assert.match(doctor.stdout, /The store records 9 and this process/);
    assert.match(doctor.stdout, /says 30/);
    assert.ok(
      doctor.code === 16 || doctor.code === 11,
      `expected the budget code (16) or, if no browser binary is resolvable, the automation code (11) — got ${String(doctor.code)}`,
    );
    assert.doesNotMatch(
      doctor.stderr,
      /refused \(budget\.agrees_with_store\)/,
      'doctor refused to run instead of reporting the disagreement it exists to report',
    );
  });
});
