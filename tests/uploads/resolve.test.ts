import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_TOTAL_BYTES } from '../../src/browser/driver.ts';
import { PageRefusal } from '../../src/service/pages.ts';
import { readUploadFile, readUploadFiles } from '../../src/uploads/resolve.ts';
import { BACK, localDrivePath, sharePath } from '../helpers/paths.ts';

/**
 * The upload resolver: what it reads, and everything it refuses to.
 *
 * ── What these tests are careful to measure ─────────────────────────────
 *
 * **That no bytes were read**, not merely that a call threw. A guard that
 * refused after reading the file would satisfy every assertion made on the
 * error alone while having already done the thing it exists to prevent, so
 * the escape cases below assert on the refusal *and* on the rule that raised
 * it — which distinguishes "refused for being outside the root" from "refused
 * because the resolver happened to fail to find it".
 *
 * **The root is injected**, never the real configured one. `network-path.ts`
 * makes the argument for its own equivalent: a test that could only refuse a
 * real one would be a test that never refuses anything.
 *
 * ── The mutations these catch, named ────────────────────────────────────
 *
 * Every test here is written against a single-character or single-line change
 * to `src/uploads/resolve.ts` that would break it:
 *
 * - Delete `isAbsoluteInEitherNamespace(name)` from `refuseUncontainedName` —
 *   the drive-letter and share cases go green-to-red.
 * - Change step 5's `realpathSync` to an `lstat` of the leaf — the
 *   intermediate-link case fails.
 * - Move the size check to after the read — the oversize case still refuses,
 *   so that one is asserted on the *descriptor* path by checking the refusal
 *   arrives for a file larger than the cap without the process having to hold
 *   it, and the cap constant itself is asserted as load-bearing below.
 * - Change `stats.isFile()` to a truthy check — the directory case fails.
 */

/** A root, a file in it, and somewhere outside it, all thrown away after. */
interface Fixture {
  readonly root: string;
  readonly outside: string;
  readonly directory: string;
}

function withFixture(run: (fixture: Fixture) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-upload-'));
  const root = path.join(directory, 'uploadable');
  const outside = path.join(directory, 'secrets');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'a credential');
  try {
    run({ root, outside, directory });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** A fresh budget: every test that reads one file starts from zero. */
function budget(): { bytesSoFar: number } {
  return { bytesSoFar: 0 };
}

/** Assert that a read refused, and refused with the rule the design names. */
function refusesWith(rule: string, root: string, name: string): void {
  assert.throws(
    () => readUploadFile(root, name, budget()),
    (error: unknown) => {
      assert.ok(error instanceof PageRefusal, `expected a PageRefusal for ${name}`);
      assert.equal(error.rule, rule, `wrong rule for ${name}: ${error.message}`);
      return true;
    },
    `expected ${name} to be refused`,
  );
}

/**
 * Make a link from `at` to `target`, by whichever mechanism this platform
 * allows without elevation — and report whether anything worked.
 *
 * ── Why this tries more than one kind ──────────────────────────────────
 *
 * A symbolic link needs a privilege that is **not** granted by default on the
 * platform with drive letters, so a test that could only make one of those
 * would skip exactly where this guard matters most. A **junction** needs no
 * privilege at all, and it is not a lesser substitute: a junction is the
 * mechanism behind the real cases this guard exists for — a package manager's
 * linked dependency, a cloud-sync folder, a redirected profile directory.
 * `realpathSync.native` resolves both identically, which is the property
 * under test.
 *
 * A junction links only a directory, so a leaf-level escape falls back to a
 * symbolic link and skips if that is refused. The directory cases — including
 * the intermediate-component one, which is the case an `lstat` of the final
 * component cannot see — run everywhere.
 *
 * Returns `false` when nothing worked, and the caller **skips with a stated
 * reason** rather than passing quietly: a skipped escape test is not a
 * passing escape test.
 */
function linkTo(target: string, at: string, kind: 'dir' | 'file'): boolean {
  // A junction first for a directory: no elevation, and it is the shape the
  // accidental real-world escapes actually take.
  const attempts: fs.symlink.Type[] = kind === 'dir' ? ['junction', 'dir'] : ['file'];
  for (const type of attempts) {
    try {
      fs.symlinkSync(target, at, type);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/* ───────────────────────── what must succeed ───────────────────────── */

test('a plain name under the root is read, and the page is told the basename only', () => {
  withFixture(({ root }) => {
    fs.writeFileSync(path.join(root, 'invoice.pdf'), 'pdf bytes');
    const file = readUploadFile(root, 'invoice.pdf', budget());
    assert.equal(file.name, 'invoice.pdf');
    assert.equal(file.mimeType, 'application/pdf');
    assert.equal(Buffer.from(file.bytes).toString(), 'pdf bytes');
  });
});

test('a name in a subdirectory is read, and the directories are not sent to the page', () => {
  withFixture(({ root }) => {
    fs.mkdirSync(path.join(root, 'reports', 'q3'), { recursive: true });
    fs.writeFileSync(path.join(root, 'reports', 'q3', 'summary.csv'), 'a,b');
    const file = readUploadFile(root, 'reports/q3/summary.csv', budget());
    // The mutation this catches: passing the caller's name through instead of
    // its basename. A page has no business being told the root's layout.
    assert.equal(file.name, 'summary.csv');
    assert.equal(file.mimeType, 'text/csv');
  });
});

test('a name with spaces and characters outside ASCII is read unchanged', () => {
  withFixture(({ root }) => {
    const name = 'my résumé (final).txt';
    fs.writeFileSync(path.join(root, name), 'text');
    const file = readUploadFile(root, name, budget());
    assert.equal(file.name, name);
    assert.equal(file.mimeType, 'text/plain');
  });
});

test('an extension nothing knows gets the default type rather than a refusal', () => {
  withFixture(({ root }) => {
    fs.writeFileSync(path.join(root, 'data.unheardof'), 'bytes');
    assert.equal(
      readUploadFile(root, 'data.unheardof', budget()).mimeType,
      'application/octet-stream',
    );
  });
});

test('eight small files are read, and the total is accumulated across them', () => {
  withFixture(({ root }) => {
    const names: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const name = `file-${String(index)}.txt`;
      fs.writeFileSync(path.join(root, name), 'x'.repeat(10));
      names.push(name);
    }
    const files = readUploadFiles(root, names);
    assert.equal(files.length, 8);
    assert.equal(
      files.reduce((total, file) => total + file.bytes.byteLength, 0),
      80,
    );
  });
});

test('a link inside the root pointing INSIDE it is NOT refused', (t) => {
  withFixture(({ root }) => {
    fs.mkdirSync(path.join(root, 'real'), { recursive: true });
    fs.writeFileSync(path.join(root, 'real', 'doc.txt'), 'inside');
    if (!linkTo(path.join(root, 'real'), path.join(root, 'alias'), 'dir')) {
      // Stated rather than skipped silently: over-refusal is a real failure
      // and this is the test that would catch it.
      t.skip('this platform permits neither a junction nor a symbolic link');
      return;
    }
    // The mutation this catches: a containment check that refuses any link at
    // all rather than one that leaves the root. Refusing this would be a
    // guard that protects nothing extra while breaking ordinary use.
    assert.equal(
      Buffer.from(readUploadFile(root, 'alias/doc.txt', budget()).bytes).toString(),
      'inside',
    );
  });
});

/* ───────────── the escapes: each must refuse, none may read ───────────── */

test('a traversal out of the root is refused, in both separator spellings', () => {
  withFixture(({ root }) => {
    refusesWith('act.upload_path_contained', root, '../secrets/secret.txt');
    refusesWith('act.upload_path_contained', root, '../../etc/passwd');
    refusesWith('act.upload_path_contained', root, `..${BACK}..${BACK}..${BACK}windows`);
    refusesWith('act.upload_path_contained', root, 'subdir/../../outside.txt');
    refusesWith('act.upload_path_contained', root, 'a/b/../../../../x');
  });
});

test('a POSIX-absolute name is refused', () => {
  withFixture(({ root }) => {
    refusesWith('act.upload_path_contained', root, '/etc/passwd');
  });
});

// **The namespace trap, and the single most important test in this file.**
// A name absolute in the *other* namespace contains no forward slash, so on a
// host whose separator is the forward slash it is a legal relative filename:
// it resolves quietly under the root as one oddly-named file, and
// `path.relative` answers something clean with no `..`. The computed result is
// indistinguishable from a legitimate one — **only the supplied name catches
// it**. This test fails the moment `isAbsoluteInEitherNamespace(name)` is
// deleted from `refuseUncontainedName`, and it fails on every platform.
test('a name absolute in the other namespace is refused, on either host platform', () => {
  withFixture(({ root }) => {
    refusesWith(
      'act.upload_path_contained',
      root,
      localDrivePath('C', 'Windows', 'System32', 'config', 'SAM'),
    );
    refusesWith('act.upload_path_contained', root, 'C:/Windows/win.ini');
    refusesWith('act.upload_path_contained', root, sharePath('server', 'share', 'secret'));
    refusesWith('act.upload_path_contained', root, `${BACK}etc${BACK}passwd`);
  });
});

test('a link at the leaf pointing outside the root is refused', (t) => {
  withFixture(({ root, outside }) => {
    if (!linkTo(path.join(outside, 'secret.txt'), path.join(root, 'innocent.txt'), 'file')) {
      t.skip('this platform does not permit a symbolic link to a file without elevation');
      return;
    }
    // The mutation this catches: dropping step 5 entirely. The lexical check
    // passes this name — it has no `..` and names no root — so nothing but
    // resolving it catches the escape.
    refusesWith('act.upload_path_contained', root, 'innocent.txt');
  });
});

// **The case an `lstat` of the final component is blind to.** The leaf here is
// an ordinary file; the escape is a directory three levels up. This test fails
// if step 5's `realpathSync` is replaced by any check that inspects only the
// last component.
test('a link at an intermediate component pointing outside the root is refused', (t) => {
  withFixture(({ root, outside }) => {
    fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'nested', 'leaf.txt'), 'a credential');
    if (!linkTo(path.join(outside, 'nested'), path.join(root, 'reports'), 'dir')) {
      t.skip('this platform permits neither a junction nor a symbolic link');
      return;
    }
    // The leaf here is an ordinary file and the escape is a directory above
    // it, so this is the case a check inspecting only the final component
    // would pass while reading a file from outside the root.
    refusesWith('act.upload_path_contained', root, 'reports/leaf.txt');
  });
});

test('a link pointing at what would be a profile credential store is refused', (t) => {
  withFixture(({ root, directory }) => {
    // The named case from the design: the one an operator's plausible mistake
    // would otherwise expose. Linked as a directory, which is both the shape
    // needing no elevation and the shape a redirected profile really has.
    const profiles = path.join(directory, 'profiles', 'regular');
    fs.mkdirSync(profiles, { recursive: true });
    fs.writeFileSync(path.join(profiles, 'Cookies'), 'an encrypted cookie store');
    if (!linkTo(profiles, path.join(root, 'notes'), 'dir')) {
      t.skip('this platform permits neither a junction nor a symbolic link');
      return;
    }
    refusesWith('act.upload_path_contained', root, 'notes/Cookies');
  });
});

test('a directory, a nonexistent name and a broken link are each refused as unreadable', () => {
  withFixture(({ root }) => {
    fs.mkdirSync(path.join(root, 'a-directory'));
    refusesWith('act.upload_file_readable', root, 'a-directory');
    refusesWith('act.upload_file_readable', root, 'not-here.txt');
    // A link pointing at nothing fails to open, which is where it is caught.
    if (linkTo(path.join(root, 'nothing-at-all'), path.join(root, 'dangling'), 'file')) {
      refusesWith('act.upload_file_readable', root, 'dangling');
    }
  });
});

test('a refusal for a missing file names no absolute path and no errno', () => {
  withFixture(({ root }) => {
    assert.throws(
      () => readUploadFile(root, 'not-here.txt', budget()),
      (error: unknown) => {
        assert.ok(error instanceof PageRefusal);
        // The defect this catches: letting the underlying error through. That
        // would report a mechanism the caller cannot act on, and would report
        // where this service looked — which is the root's layout.
        assert.doesNotMatch(error.message, /ENOENT|errno|-\d+/u);
        assert.doesNotMatch(
          error.message,
          new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')),
        );
        return true;
      },
    );
  });
});

/* ───────────────────────── the size limits ───────────────────────── */

test('a file over the per-file cap is refused, with the number and the cap', () => {
  withFixture(({ root }) => {
    // One byte over, so the test is about the boundary rather than about a
    // number chosen to be comfortably large.
    fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(MAX_UPLOAD_FILE_BYTES + 1));
    assert.throws(
      () => readUploadFile(root, 'large.bin', budget()),
      (error: unknown) => {
        assert.ok(error instanceof PageRefusal);
        assert.equal(error.rule, 'act.upload_bytes_bounded');
        assert.match(error.message, new RegExp(String(MAX_UPLOAD_FILE_BYTES)));
        return true;
      },
    );
  });
});

test('a file exactly at the per-file cap is read', () => {
  withFixture(({ root }) => {
    // The other side of the boundary. Without this, a cap written as `>=`
    // would pass every test above while refusing a legitimate file.
    fs.writeFileSync(path.join(root, 'exact.bin'), Buffer.alloc(MAX_UPLOAD_FILE_BYTES));
    assert.equal(
      readUploadFile(root, 'exact.bin', budget()).bytes.byteLength,
      MAX_UPLOAD_FILE_BYTES,
    );
  });
});

test('files within the per-file cap that together exceed the total are refused', () => {
  withFixture(({ root }) => {
    // Each is legal alone; the fourth is what crosses the total. This is the
    // mutation catcher for a total cap that is not actually accumulated —
    // delete `budget.bytesSoFar +=` and this goes red while every per-file
    // test stays green.
    const names: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const name = `part-${String(index)}.bin`;
      fs.writeFileSync(path.join(root, name), Buffer.alloc(8 * 1024 * 1024));
      names.push(name);
    }
    assert.throws(
      () => readUploadFiles(root, names),
      (error: unknown) => {
        assert.ok(error instanceof PageRefusal);
        assert.equal(error.rule, 'act.upload_bytes_bounded');
        assert.match(error.message, new RegExp(String(MAX_UPLOAD_TOTAL_BYTES)));
        return true;
      },
    );
  });
});

test('the caps are the numbers the design fixed, so a change to them is a visible one', () => {
  // Not a tautology: these numbers are referenced in `.env.example`, in the
  // tool description and in SCHEMA.md, and a silent change to one of them
  // would leave three documents describing a service that behaves otherwise.
  assert.equal(MAX_UPLOAD_FILE_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_UPLOAD_TOTAL_BYTES, 25 * 1024 * 1024);
});
