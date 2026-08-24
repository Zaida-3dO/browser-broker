import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DECLARED_DIFF_VARIABLES,
  DEFAULT_DIFF_SETTINGS,
  DIFF_DECLARATIONS,
  DiffSettingError,
  readDiffSettings,
} from '../../src/diff/settings.ts';
import { repositoryFile } from '../helpers/paths.ts';

/**
 * The five comparison settings (`SCHEMA.md` §6.2, §1.10; `MILESTONES.md` #43).
 *
 * **What a green run means:** every declared variable is documented, every one
 * is read from the environment, and a value that is set and unreadable refuses
 * with the variable named rather than falling back silently. **What it does not
 * mean:** that the defaults are the right numbers — that is
 * `tests/diff/thresholds.test.ts` for the tolerance, and an open question
 * against real captures for the rest.
 */

test('every declared variable is documented in the example file', () => {
  // The walk. Without it, adding a variable to the code and forgetting the
  // documentation produces a value nobody can discover — and §6.1 makes the
  // example file the whole of the configuration surface, so an undocumented
  // variable is an undocumented feature.
  const example = readFileSync(repositoryFile('.env.example'), 'utf8');

  for (const key of DECLARED_DIFF_VARIABLES) {
    assert.ok(
      example.includes(key),
      `${key} is declared in the code but absent from .env.example, so nothing tells anyone it exists`,
    );
  }
});

test('the declared list and the snapshot have the same five members', () => {
  // Names the count rather than iterating: deleting a declaration must fail
  // here rather than making the walk above trivially satisfied.
  assert.equal(DECLARED_DIFF_VARIABLES.length, 5);
  assert.deepEqual([...DECLARED_DIFF_VARIABLES].sort(), [
    'BROKER_DIFF_COLOUR_TOLERANCE',
    'BROKER_DIFF_CROP_PADDING',
    'BROKER_DIFF_MAXIMUM_REGIONS',
    'BROKER_DIFF_MINIMUM_REGION_AREA',
    'BROKER_DIFF_REGION_MERGE_DISTANCE',
  ]);
});

test('an empty environment gives the documented defaults', () => {
  // §6.2's numbers, named individually. A test comparing the result to
  // `DEFAULT_DIFF_SETTINGS` would pass however both moved together.
  const settings = readDiffSettings({});

  assert.equal(settings.colourTolerance, 0.1);
  assert.equal(settings.minimumRegionArea, 64);
  assert.equal(settings.maximumRegions, 12);
  assert.equal(settings.regionMergeDistance, 8);
  assert.equal(settings.cropPadding, 16);
  assert.deepEqual(settings, DEFAULT_DIFF_SETTINGS);
});

test('each variable is actually read, one at a time', () => {
  // One assertion per variable, each setting only that one. A test that set
  // all five at once would pass on an implementation that read one and copied
  // it — and a test that set none would pass on one that read nothing.
  assert.equal(readDiffSettings({ BROKER_DIFF_COLOUR_TOLERANCE: '0.35' }).colourTolerance, 0.35);
  assert.equal(readDiffSettings({ BROKER_DIFF_MINIMUM_REGION_AREA: '128' }).minimumRegionArea, 128);
  assert.equal(readDiffSettings({ BROKER_DIFF_MAXIMUM_REGIONS: '3' }).maximumRegions, 3);
  assert.equal(
    readDiffSettings({ BROKER_DIFF_REGION_MERGE_DISTANCE: '20' }).regionMergeDistance,
    20,
  );
  assert.equal(readDiffSettings({ BROKER_DIFF_CROP_PADDING: '0' }).cropPadding, 0);
});

test('setting one variable leaves the other four at their defaults', () => {
  // The other half of the test above: reading is scoped rather than global.
  const settings = readDiffSettings({ BROKER_DIFF_MAXIMUM_REGIONS: '3' });

  assert.equal(settings.maximumRegions, 3);
  assert.equal(settings.colourTolerance, 0.1);
  assert.equal(settings.minimumRegionArea, 64);
  assert.equal(settings.regionMergeDistance, 8);
  assert.equal(settings.cropPadding, 16);
});

test('a variable set to something unreadable refuses, and names the variable', () => {
  // §6.3: "set and unreadable refuses, naming the variable". Falling back to
  // the default would run a configuration nobody chose, with nothing to notice
  // it by — which is the failure the message exists to prevent.
  for (const value of ['', '   ', 'quite sensitive', 'NaN']) {
    assert.throws(
      () => readDiffSettings({ BROKER_DIFF_COLOUR_TOLERANCE: value }),
      (error: unknown) =>
        error instanceof DiffSettingError &&
        error.key === 'BROKER_DIFF_COLOUR_TOLERANCE' &&
        error.message.includes('BROKER_DIFF_COLOUR_TOLERANCE'),
      `a colour tolerance of ${JSON.stringify(value)} must refuse`,
    );
  }
});

test('a tolerance outside nought-to-one refuses', () => {
  // The bounds are the library's own domain. A value outside it is not a
  // stricter or looser setting, it is a value the comparison cannot use.
  assert.throws(() => readDiffSettings({ BROKER_DIFF_COLOUR_TOLERANCE: '1.5' }), DiffSettingError);
  assert.throws(() => readDiffSettings({ BROKER_DIFF_COLOUR_TOLERANCE: '-0.1' }), DiffSettingError);
  // The boundaries themselves are inside. Flipping either comparison to a
  // strict one fails here.
  assert.equal(readDiffSettings({ BROKER_DIFF_COLOUR_TOLERANCE: '0' }).colourTolerance, 0);
  assert.equal(readDiffSettings({ BROKER_DIFF_COLOUR_TOLERANCE: '1' }).colourTolerance, 1);
});

test('a whole-number variable refuses a fraction', () => {
  // A region cap of two and a half is a value somebody meant something by and
  // the service cannot honour. Truncating silently would give them a cap they
  // did not set.
  assert.throws(() => readDiffSettings({ BROKER_DIFF_MAXIMUM_REGIONS: '2.5' }), DiffSettingError);
});

test('a region cap of zero refuses, because it would silently return no regions', () => {
  // The one bound that is not obvious: zero is a number, it is not negative,
  // and it would make every diff report nothing changed while looking like it
  // worked. That is the failure #43 names as indistinguishable from success.
  assert.throws(() => readDiffSettings({ BROKER_DIFF_MAXIMUM_REGIONS: '0' }), DiffSettingError);
});

test('a minimum area of zero is allowed, because reporting everything is a real choice', () => {
  // The contrast with the case above, and the reason each bound is declared
  // per variable rather than shared: zero area means "report every region",
  // which is a legitimate setting for somebody tuning.
  assert.equal(readDiffSettings({ BROKER_DIFF_MINIMUM_REGION_AREA: '0' }).minimumRegionArea, 0);
});

test('the declarations carry a summary that reads as a phrase', () => {
  // The refusal message is assembled from these, so an empty or placeholder
  // summary produces a refusal that names a variable and explains nothing.
  for (const declaration of DIFF_DECLARATIONS) {
    assert.ok(
      declaration.summary.length > 20 && declaration.summary.includes(' '),
      `${declaration.key} has no usable summary, so its refusal would explain nothing`,
    );
  }
});
