import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

import {
  reapOwnedBrowsers,
  registerBrowserForReaping,
  temporaryProfileRoot,
} from './browser-fixture.ts';

/**
 * The interrupted-run reaper, and the one property it must never lose
 * (item 7befc327).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT IS BEING TESTED, AND WHY NOT WITH A REAL BROWSER
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The defect is that `teardownBrowser` runs in a per-test `finally`, which a
 * run killed mid-test never reaches — so each dead run leaked a Chromium, and
 * the leaks compound until the next run crosses Playwright's screenshot
 * timeout.
 *
 * The fix registers each browser this run starts and kills the registered pids
 * from `exit`/`SIGINT`/`SIGTERM`/`SIGHUP`. **What makes that correct is not
 * that it kills browsers — it is WHICH processes it is capable of killing.** A
 * sweeper that matched on an image name would take out Ope's own Chrome and
 * other agents' browsers; the item is explicit that such a sweeper "would be a
 * worse failure than the leak".
 *
 * So these tests use ordinary long-lived child processes rather than browsers.
 * The registry cannot tell the difference — it holds pids — and using a plain
 * process means the test proves the lifecycle property on every platform, in
 * milliseconds, without a browser to leak if it fails. A browser here would
 * test Chromium's startup, which is not the thing that was broken.
 */

/** A child that will outlive the test unless something kills it. */
function sleeper(): { pid: number; done: Promise<void> } {
  // `node -e` rather than a shell builtin: it exists on every platform this
  // repository runs on, and it is a direct child, so the pid observed here is
  // the pid that must be killed. A `sh -c sleep` would put a shell in between
  // and the test would prove something about shells.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
    stdio: 'ignore',
  });
  assert.ok(typeof child.pid === 'number', 'the child reported no pid');
  const done = new Promise<void>((resolve) => {
    child.on('exit', () => {
      resolve();
    });
  });
  return { pid: child.pid, done };
}

/** Is a pid still live? `signal 0` asks without sending anything. */
function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a registered browser is killed when the run exits without reaching teardown', async () => {
  // The whole defect in one shape: a run that never reaches its `finally`.
  // Reproduced by running the fixture in a REAL child process and killing that
  // process's own child through the exit handler — asserting in-process would
  // only prove that a function called directly does what it says, which is not
  // the question. The question is whether the handler is WIRED.
  const root = temporaryProfileRoot();

  const script = `
    import { registerBrowserForReaping } from ${JSON.stringify(
      new URL('./browser-fixture.ts', import.meta.url).href,
    )};
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    registerBrowserForReaping(child.pid, ${JSON.stringify(root)});
    // Report the pid, then end WITHOUT any teardown call at all.
    process.stdout.write(String(child.pid));
    process.exit(0);
  `;

  const runner = spawn(process.execPath, ['--experimental-strip-types', '-e', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  let out = '';
  runner.stdout.setEncoding('utf8');
  runner.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  await new Promise<void>((resolve) => {
    runner.on('exit', () => {
      resolve();
    });
  });

  const leaked = Number(out.trim());
  assert.ok(Number.isInteger(leaked) && leaked > 0, `the child never reported a pid (got ${out})`);

  // Give the OS a moment to finish tearing the killed process down: a kill
  // returns before the process object is gone, and asserting instantly is how
  // this repository has invented a phantom leak before.
  for (let attempt = 0; attempt < 40 && isLive(leaked); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(
    isLive(leaked),
    false,
    'a run that ended without teardown left its browser running — this is the leak itself',
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test('the reaper kills ONLY what this run registered, never a process it did not start', async () => {
  // ══════════════════════════════════════════════════════════════════════
  // THE SAFETY PROPERTY. If only one test in this file survives, this one.
  // ══════════════════════════════════════════════════════════════════════
  //
  // Bystanders: same executable, same machine, started by somebody else —
  // which is exactly what Ope's own Chrome and another agent's browser are
  // from this run's point of view. None is registered, so all must be
  // untouched. An image-name sweeper would kill every one of them, and that is
  // the outcome this test exists to make impossible to ship.
  //
  // **Several rather than one, and that is not belt-and-braces.** Windows pids
  // are not handed out sequentially — two consecutively spawned children here
  // measured 40,420 apart — so a single bystander leaves a sweep that widened
  // by *some* rule other than image name able to miss it by luck and pass. A
  // pool makes any broadening land on at least one of them: they share the
  // executable, the parent, the session and the creation moment, which are the
  // properties a careless sweeper actually keys on.
  const bystanders = [sleeper(), sleeper(), sleeper(), sleeper()];
  const registered = sleeper();
  const root = temporaryProfileRoot();

  try {
    registerBrowserForReaping(registered.pid, root);

    // ── Why the sweep is driven IN THIS PROCESS ──────────────────────────
    //
    // The first test runs the reaper in a child, because what it asks is
    // whether the exit handler is wired. This one asks something different —
    // what the sweep is *capable of killing* — and the answer only means
    // anything if the bystanders are inside its blast radius.
    //
    // Driving it in a child got that wrong, and measurably: a mutant that
    // swept every child of the reaping process SURVIVED, because the
    // bystanders are children of *this* process and the reaper was running one
    // level down where it could not see them. A test whose bystanders are out
    // of reach cannot fail for the reason it exists, however loudly it asserts.
    //
    // So the reaper is called directly, in the process that owns the
    // bystanders. That is the arrangement in which "it killed something it was
    // not given" is actually observable.
    reapOwnedBrowsers();

    for (let attempt = 0; attempt < 40 && isLive(registered.pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(
      isLive(registered.pid),
      false,
      'the registered process survived, so the reaper did not run at all and the test below proves nothing',
    );

    // The assertion the whole design is for.
    const casualties = bystanders.filter((one) => !isLive(one.pid)).length;
    assert.equal(
      casualties,
      0,
      `THE REAPER KILLED ${String(casualties)} PROCESS(ES) THIS RUN DID NOT START. On a ` +
        "developer machine that is Ope's own browser, or another agent's work. Nothing may " +
        'be killed but registered pids.',
    );
  } finally {
    for (const one of bystanders) {
      try {
        process.kill(one.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    try {
      process.kill(registered.pid, 'SIGKILL');
    } catch {
      // Already gone — the expected case.
    }
    await Promise.all([...bystanders.map((one) => one.done), registered.done]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
