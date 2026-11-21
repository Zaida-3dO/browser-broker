import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ArtifactStore } from '../../src/artifacts/store.ts';
import {
  type ArtifactResult,
  type BrowserSession,
  type ReadArtifact,
  type SnapshotFilter,
  type TabHandle,
} from '../../src/browser/driver.ts';
import { parseArguments } from '../../src/cli/adapter.ts';
import { createBroker } from '../../src/service/broker.ts';
import { serviceFor } from '../../src/service/bridge.ts';
import { prepareStore } from '../../src/store/open.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * **The inline window reaches the caller, and a malformed one leaves nothing
 * behind.**
 *
 * ── What the pure halves are, and what only this file can see ────────────
 *
 * `snapshot-window.test.ts` pins the window's arithmetic and the guard in
 * `pages.ts` refuses the malformed spellings. Neither can see the failure
 * mode this file exists for — the one `check-argument-reachability.mjs`
 * states in its own header and cannot itself catch: an argument read at the
 * bridge and **dropped at the call site below it** (the `tier` defect).
 * `inline`, `offset` and `limit` are conditionally spread at the bridge
 * exactly as `tier` was, so the static check passes whether or not they
 * arrive; only a run that reads the answer back — and the fake session's
 * call log — can tell.
 *
 * ── The session here writes real files, and why that is deliberate ───────
 *
 * The stock fake driver answers a read with paths to files it never wrote,
 * which is right for the fake's purpose and useless here: an inline read
 * returns the text of the artefact **file**, so the only session that can
 * answer one honestly is one that writes files. This session writes them
 * under the fixture's artifact root, the way `real.ts`'s `#write` does, and
 * every assertion about the text is an assertion about bytes on disk.
 *
 * ── The mutations these kill ────────────────────────────────────────────
 *
 * - Deleting the bridge's `inline`/`offset`/`limit` spreads — the first test
 *   fails on a missing `inlined` and the refusal tests fail because nothing
 *   refuses.
 * - Passing `offset` through without `asInteger` — the CLI-spelling test
 *   fails: the string `"10"` meets the guard's integer check and refuses a
 *   correctly typed call.
 * - Reading `inlined` eagerly into the result instead of through a getter —
 *   the first test fails on `undefined`, which is the point of the getter.
 * - Honouring `inline` without an artifact store — the no-store test fails:
 *   the caller must be *told*, `pageDriven: false` with a reason, not quietly
 *   handed the path answer it did not ask for.
 * - Returning the whole file regardless of `find` — the composition test
 *   fails, because the window must be cut from the file as **written**, and
 *   with a filter that file is the filtered one.
 */

/** The full snapshot the fixture's page "has": header, links, footer. */
const FULL_SNAPSHOT = [
  '- page "Catalogue" [ref=e0]:',
  ...Array.from({ length: 60 }, (_, i) => `  - link "Item ${String(i)}" [ref=e${String(i + 1)}]`),
  '- status [ref=e61]: 60 items listed',
].join('\n');

/** What the session writes per artefact when no filter was asked for. */
const WHOLE: Record<ReadArtifact, string> = {
  snapshot: FULL_SNAPSHOT,
  console: 'hello\nworld',
  network: 'No requests were observed on this tab.',
  cookies: '[]',
};

/** The session's own stand-in for `filterSnapshot`: the whole point here is
 *  that the file the window slices **changes** when a filter ran, so the
 *  composition claim is about the written bytes, not about the driver's
 *  filtering (which `snapshot-find.test.ts` already pins). */
function filterFor(whole: string, filter: SnapshotFilter | undefined): string {
  if (filter === undefined || filter.kind !== 'text') return whole;
  return whole
    .split('\n')
    .filter((line) => line.toLowerCase().includes(filter.text.toLowerCase()))
    .join('\n');
}

interface ReadCall {
  readonly artifacts: readonly ReadArtifact[];
  readonly snapshotFind: SnapshotFilter | undefined;
}

function writingSession(outputDirectory: string): { session: BrowserSession; reads: ReadCall[] } {
  const reads: ReadCall[] = [];
  const handle: TabHandle = { browser: 'regular', driverTabId: 'driver-tab' };
  mkdirSync(outputDirectory, { recursive: true });

  const session: BrowserSession = {
    describe: () => ({
      browser: 'regular' as const,
      mode: 'headless' as const,
      pid: 1,
      discovery: { endpoint: 'http://127.0.0.1:1' },
    }),
    isConnected: () => true,
    openTab: () => Promise.resolve(handle),
    listTabs: () => Promise.resolve([handle]),
    ensureKeeperTab: () => Promise.resolve(handle),
    detach: () => Promise.resolve(),
    closeTab: () => Promise.resolve('closed'),
    navigate: () =>
      Promise.resolve({ url: 'https://example.com/', title: 'Catalogue', status: 200 }),
    seedStorage: () => Promise.resolve(),
    act: () => {
      throw new Error('this test never acts');
    },
    read: (page, artifacts, options): Promise<readonly ArtifactResult[]> => {
      const snapshotFind = options?.snapshotFind;
      reads.push({ artifacts, snapshotFind });
      return Promise.resolve(
        artifacts.map((artifact) => {
          const contents =
            artifact === 'snapshot' ? filterFor(FULL_SNAPSHOT, snapshotFind) : WHOLE[artifact];
          const file = path.join(outputDirectory, `${artifact}.txt`);
          writeFileSync(file, contents, 'utf8');
          return {
            artifact,
            path: file,
            bytes: Buffer.byteLength(contents, 'utf8'),
            truncated: false,
          };
        }),
      );
    },
    cookies: () => Promise.resolve([]),
    evaluate: () => {
      throw new Error('this test never evaluates');
    },
    settlePage: () => Promise.resolve(),
    capture: () => {
      throw new Error('this test never captures');
    },
    download: () => {
      throw new Error('this test never downloads');
    },
  };
  return { session, reads };
}

/**
 * Run one read through the **real service surface**: CLI argv in, through
 * `parseArguments` and the bridge, so the coercion of the window arguments is
 * on the path rather than smuggled around it.
 */
async function readThrough(
  argv: readonly string[],
  setup: { readonly withArtifacts: boolean; readonly withSession?: boolean },
): Promise<{
  outcome: string;
  value: Record<string, unknown>;
  refusal: Record<string, unknown>;
  reads: ReadCall[];
  dispose: () => void;
}> {
  const temp = makeTempStore({});
  const store = await prepareStore(temp.environment);
  let disposed = false;
  const dispose = (): void => {
    if (!disposed) {
      disposed = true;
      store.close();
      temp.remove();
    }
  };
  try {
    const { session, reads } = writingSession(
      path.join(temp.environment.artifactsRoot, 'snapshots'),
    );
    const broker = createBroker({
      store,
      environment: temp.environment,
      adapter: 'cli',
      ...(setup.withArtifacts
        ? { artifacts: new ArtifactStore(temp.environment.artifactsRoot) }
        : {}),
      session: () => session,
      closeTab: () => {},
    });
    const service = serviceFor({ broker, db: store.db });

    const claimed = await service.perform({
      operation: 'claim',
      adapter: 'cli',
      arguments: parseArguments([
        '--session-id',
        'read-window',
        '--purpose',
        'Proving the inline window reaches the caller that asked for it.',
      ]),
    });
    assert.equal(claimed.outcome, 'accepted', 'the lease this test needs was not granted');
    const key = String((claimed as { value: Record<string, unknown> }).value['key']);

    const performed = await service.perform({
      operation: 'read',
      adapter: 'cli',
      arguments: parseArguments([...argv, '--lease-key', key]),
    });
    return {
      outcome: performed.outcome,
      value: (performed as { value?: Record<string, unknown> }).value ?? {},
      refusal: performed as unknown as Record<string, unknown>,
      reads,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

function inlinedList(value: Record<string, unknown>): Record<string, unknown>[] {
  const list = value['inlined'];
  assert.ok(Array.isArray(list), `no inlined list on the result: ${JSON.stringify(value)}`);
  return list as Record<string, unknown>[];
}

function entryFor(list: Record<string, unknown>[], artifact: string): Record<string, unknown> {
  const entry = list.find((candidate) => candidate['artifact'] === artifact);
  assert.ok(entry !== undefined, `no inlined entry for ${artifact}`);
  return entry;
}

function collectedPathOf(value: Record<string, unknown>, artifact: string): string {
  const collected = value['collected'];
  assert.ok(Array.isArray(collected), 'no collected list on the result');
  const entry = (collected as Record<string, unknown>[]).find(
    (candidate) => candidate['artifact'] === artifact,
  );
  assert.ok(entry !== undefined, `no collected entry for ${artifact}`);
  return String(entry['path']);
}

test('inline returns the windowed text of the snapshot, beside its path', async () => {
  const run = await readThrough(['--inline'], { withArtifacts: true });
  try {
    assert.equal(
      run.outcome,
      'accepted',
      `an inline read was refused: ${JSON.stringify(run.refusal)}`,
    );

    const entry = entryFor(inlinedList(run.value), 'snapshot');
    assert.equal(typeof entry['text'], 'string');
    assert.equal(
      (entry['text'] as string).length,
      Math.min(4_000, FULL_SNAPSHOT.length),
      'the default window is 4,000 characters — and this fixture is under it, so the whole file fits',
    );
    assert.equal(entry['total'], FULL_SNAPSHOT.length);
    assert.equal(entry['hasMore'], FULL_SNAPSHOT.length > 4_000);

    // The text is the bytes of the file the read wrote, from offset 0.
    const onDisk = readFileSync(collectedPathOf(run.value, 'snapshot'), 'utf8');
    assert.equal(onDisk, FULL_SNAPSHOT, 'the driver wrote the file the window sliced');
    assert.equal(entry['text'], onDisk.slice(0, 4_000));

    // The path answer is still there: inline changes what enters the
    // conversation, not whether the artefact was written.
    assert.ok(Array.isArray(run.value['collected']));
  } finally {
    run.dispose();
  }
});

test('a second window pages from the reported nextOffset', async () => {
  // Sixty links of about 35 characters put the fixture past one default page
  // for a 40-character window: two windows must tile the file exactly.
  const first = await readThrough(['--inline', '--limit', '40'], { withArtifacts: true });
  try {
    const page1 = entryFor(inlinedList(first.value), 'snapshot');
    assert.equal(page1['hasMore'], true);
    assert.equal((page1['text'] as string).length, 40);

    const second = await readThrough(
      ['--inline', '--limit', '40', '--offset', String(page1['nextOffset'])],
      { withArtifacts: true },
    );
    try {
      const page2 = entryFor(inlinedList(second.value), 'snapshot');
      assert.equal(page2['start'], 40);
      assert.equal((page2['text'] as string).length, 40);
      assert.notEqual(page1['text'], page2['text'], 'the second window must be new text');

      const onDisk = readFileSync(collectedPathOf(second.value, 'snapshot'), 'utf8');
      assert.equal(String(page1['text']) + String(page2['text']), onDisk.slice(0, 80));
      assert.equal(page2['total'], onDisk.length);
    } finally {
      second.dispose();
    }
  } finally {
    first.dispose();
  }
});

test('the CLI spelling of the window is coerced and honoured end to end', async () => {
  const run = await readThrough(['--inline', '--offset', '10', '--limit', '5'], {
    withArtifacts: true,
  });
  try {
    assert.equal(
      run.outcome,
      'accepted',
      `a well-formed window was refused: ${JSON.stringify(run.refusal)}`,
    );
    const entry = entryFor(inlinedList(run.value), 'snapshot');
    assert.equal(
      entry['text'],
      FULL_SNAPSHOT.slice(10, 15),
      'the string "10" must reach the guard as the number 10 — the wait_ms rule, same split',
    );
    assert.equal(entry['start'], 10);
  } finally {
    run.dispose();
  }
});

test('inline covers every kind in one read, each windowed from its own file', async () => {
  const run = await readThrough(['--inline', '--what', 'snapshot,console,network,cookies'], {
    withArtifacts: true,
  });
  try {
    assert.equal(
      run.outcome,
      'accepted',
      `a multi-artefact inline read was refused: ${JSON.stringify(run.refusal)}`,
    );
    const list = inlinedList(run.value);
    assert.equal(list.length, 4, 'every artefact asked for must come back windowed');
    for (const artifact of ['snapshot', 'console', 'network', 'cookies'] as const) {
      const entry = entryFor(list, artifact);
      assert.equal(
        entry['text'],
        WHOLE[artifact].slice(0, 4_000),
        `${artifact} must be windowed from its own file, at the default page`,
      );
      assert.equal(entry['total'], WHOLE[artifact].length);
    }
  } finally {
    run.dispose();
  }
});

test('find and the window compose: the window slices the file as WRITTEN', async () => {
  const run = await readThrough(['--inline', '--limit', '40', '--offset', '40', '--find', 'Item'], {
    withArtifacts: true,
  });
  try {
    assert.equal(
      run.outcome,
      'accepted',
      `a find+inline read was refused: ${JSON.stringify(run.refusal)}`,
    );
    assert.equal(run.reads.length, 1);
    const onlyRead = run.reads[0];
    assert.ok(onlyRead !== undefined);
    assert.ok(
      onlyRead.snapshotFind !== undefined,
      'the filter must still reach the driver, as read-find-reaches-driver.test.ts proves generally',
    );

    const onDisk = readFileSync(collectedPathOf(run.value, 'snapshot'), 'utf8');
    assert.ok(onDisk.length < FULL_SNAPSHOT.length, 'the file must have been filtered');

    const entry = entryFor(inlinedList(run.value), 'snapshot');
    assert.equal(entry['total'], onDisk.length, 'the total must describe the filtered file');
    assert.equal(entry['text'], onDisk.slice(40, 80));
  } finally {
    run.dispose();
  }
});

test('an offset without inline is refused before anything is asked of the browser', async () => {
  const run = await readThrough(['--offset', '4000'], { withArtifacts: true });
  try {
    assert.equal(run.outcome, 'refused', 'an inert offset was accepted');
    assert.equal(run.refusal['rule'], 'read.window_shape');
    // The physical half: the session was never asked to read at all.
    assert.equal(run.reads.length, 0, 'the driver was asked to read despite the refusal');
  } finally {
    run.dispose();
  }
});

test('a limit past the ceiling is refused, naming the ceiling', async () => {
  const run = await readThrough(['--inline', '--limit', '16001'], { withArtifacts: true });
  try {
    assert.equal(run.outcome, 'refused');
    assert.equal(run.refusal['rule'], 'read.window_shape');
    const message = run.refusal['message'];
    assert.ok(typeof message === 'string', 'the refusal carried no message text');
    assert.match(message, /16000/);
    assert.match(message, /4000/);
    assert.equal(run.reads.length, 0, 'the driver was asked to read despite the refusal');
  } finally {
    run.dispose();
  }
});

test('inline with no artifact store reports honestly: told, not silently pathed', async () => {
  const run = await readThrough(['--inline'], { withArtifacts: false });
  try {
    // The decision half stands (the lease renewed, the read row written) and
    // the page half says what was missing — the arrangement `decideCapture`
    // keeps for the same reasons (§2.4b).
    assert.equal(run.outcome, 'accepted');
    assert.equal(run.value['pageDriven'], false);
    const reason = run.value['notDrivenReason'];
    assert.ok(typeof reason === 'string', 'the answer carried no reason text');
    assert.match(reason, /artifact store/i);
    assert.equal(run.value['inlined'], undefined, 'no text may be claimed without a store');
    // The driver was reached — the files were written — and then the answer
    // could not be read back. The reason field is what makes that visible.
    assert.equal(run.reads.length, 1);
  } finally {
    run.dispose();
  }
});
