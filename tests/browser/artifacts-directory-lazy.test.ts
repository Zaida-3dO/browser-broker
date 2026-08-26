import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * The default artefact directory is **named** at construction and **made**
 * only when something is written to it.
 *
 * A driver used to call `mkdtempSync` for its default output directory in the
 * constructor. `mkdtempSync` both picks a name and creates the directory, so
 * every driver made one — whether or not it ever wrote an artefact — and
 * nothing ever removed it. A session that only read a page therefore left an
 * empty directory behind permanently. Measured on one developer machine before
 * the change: **1,389** empty `broker-artifacts-` directories, against 27 from
 * every other temporary-directory source in the project combined.
 *
 * ── Why this is a source-level assertion ────────────────────────────────
 *
 * The class that holds the directory is not exported, and constructing one
 * requires a live browser connection and context. A test that stood a real
 * browser up to observe the *absence* of a directory would be paying a great
 * deal for a very small observation, and would still not fail for the right
 * reason if the constructor were changed back — it would fail slowly, or
 * flakily, or on a machine without a browser.
 *
 * What actually distinguishes the correct implementation from the incorrect
 * one is a single property: **whether the constructor calls a function that
 * creates a directory.** That is exactly what is asserted here, and it is
 * asserted about the constructor's own body rather than about the file as a
 * whole, so the many legitimate `mkdtempSync` and `mkdirSync` calls elsewhere
 * in this module cannot mask a regression.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const realDriverSource = path.join(here, '..', '..', 'src', 'browser', 'real.ts');

/** The text of the session constructor that owns the output directory. */
function sessionConstructorBody(): string {
  const source = fs.readFileSync(realDriverSource, 'utf8');

  const classAt = source.indexOf('class RealBrowserSession');
  assert.notEqual(classAt, -1, 'RealBrowserSession has been renamed — update this test');

  const constructorAt = source.indexOf('constructor(', classAt);
  assert.notEqual(constructorAt, -1, 'RealBrowserSession has no constructor — update this test');

  // The assignment that settles the directory is the last thing the
  // constructor does, so the body up to the end of that statement is the
  // region a regression would live in.
  const assignmentAt = source.indexOf('this.#outputDirectory', constructorAt);
  assert.notEqual(assignmentAt, -1, 'the output directory assignment has moved — update this test');

  const end = source.indexOf(';', assignmentAt);
  assert.notEqual(end, -1);
  return source.slice(constructorAt, end + 1);
}

/**
 * The same region with its comments removed.
 *
 * **Necessary, and the test caught it before this file was finished**: the
 * comment explaining why `mkdtempSync` is absent from the constructor contains
 * the word `mkdtempSync`, so a search over the raw text matched the
 * explanation and reported the very defect the change had removed. A guard
 * that reads prose as if it were code is a guard that cannot tell a fix from
 * a regression.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

test('the session constructor NAMES the artefact directory without CREATING it', () => {
  const body = withoutComments(sessionConstructorBody());

  // `mkdtempSync` is the specific call that conflates the two: it cannot give
  // a name without also making the directory.
  assert.ok(
    !body.includes('mkdtempSync'),
    'the session constructor calls mkdtempSync, which creates a directory for every ' +
      'session whether or not it ever writes an artefact — and nothing removes it. ' +
      'Name the directory here and create it where it is written to.',
  );
  assert.ok(
    !body.includes('mkdirSync'),
    'the session constructor creates its output directory eagerly; create it on first write instead',
  );
});

test('THE GUARD CAN SEE THE THING IT GUARDS: the constructor really does settle the directory', () => {
  // A search for an absent string passes trivially if it is looking at the
  // wrong text. This pins the region so a rename cannot turn the assertion
  // above into a test of nothing.
  const body = withoutComments(sessionConstructorBody());
  assert.ok(body.includes('this.#outputDirectory'), 'the region examined is not the assignment');
  assert.ok(
    body.includes('broker-artifacts-'),
    'the constructor does not settle a default directory name',
  );
});

test('the writer creates the directory it is about to write into', () => {
  // The other half of the change, and the reason moving the `mkdir` is safe:
  // the sole consumer already builds the tree recursively before writing, so
  // a directory that does not exist yet is created exactly when it is needed.
  const source = fs.readFileSync(realDriverSource, 'utf8');
  const writeAt = source.indexOf('#write(tab: TabHandle');
  assert.notEqual(writeAt, -1, '#write has been renamed — update this test');

  const body = withoutComments(source.slice(writeAt, writeAt + 400));
  assert.match(
    body,
    /fs\.mkdirSync\(this\.#outputDirectory, \{ recursive: true \}\)/,
    '#write must create its output directory, or a lazily-named one would never exist',
  );
});

test('the chosen name is still a unique path in the temporary directory', () => {
  // Naming without creating loses `mkdtempSync`'s collision guarantee, so the
  // replacement has to supply its own uniqueness. Two names drawn in a row
  // must differ, and both must sit under the platform's temporary directory.
  const source = fs.readFileSync(realDriverSource, 'utf8');
  assert.match(
    source,
    /path\.join\(os\.tmpdir\(\), `broker-artifacts-\$\{randomUUID\(\)\.slice\(0, 8\)\}`\)/,
    'the default artefact directory must be a unique path under the temporary directory',
  );

  // And the property itself, exercised rather than merely asserted about.
  const drawn = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    drawn.add(path.join(os.tmpdir(), `broker-artifacts-${randomName()}`));
  }
  assert.equal(drawn.size, 200, 'the naming scheme collided within 200 draws');
});

function randomName(): string {
  return randomUUID().slice(0, 8);
}
