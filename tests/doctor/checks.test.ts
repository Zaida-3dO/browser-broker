import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  checkAutomation,
  checkCaptureSurface,
  checkDiscoveryRecord,
  checkKeeperTab,
  checkRootWritable,
  checkSchemaVersion,
  checkStoreLocation,
  checkStorePresent,
  checkTabBudget,
  DOCTOR_EXIT,
  exitCodeFor,
  type GroupedCheck,
} from '../../src/doctor/checks.ts';
import { EXPECTED_VERSION } from '../../src/store/schema/steps.ts';
import { checksReporting, localDrivePath, sharePath } from '../helpers/paths.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * `broker doctor`'s preconditions (`MILESTONES.md` #71, `SCHEMA.md` §5.5).
 *
 * Every check here is a pure function of what it was told, so each one is
 * exercised against **both** its passing and its failing input. §5.5's whole
 * claim is that this command is more informative than a health verdict
 * because it names the precondition that failed — a check only ever proven to
 * pass names nothing.
 */

describe('the store’s location', () => {
  it('passes a local path', () => {
    const local = localDrivePath('C', 'somewhere', 'broker.db');
    const check = checkStoreLocation(
      {
        databasePath: local,
        configuredDatabasePath: local,
        artifactsRoot: local,
        profileRoot: local,
        // The declared defaults (SCHEMA 6.2). These checks are about path
        // resolution; the numbers are here to complete the shape.
        tabBudget: 15,
        leaseSeconds: 600,
        queueSeconds: 600,
      },
      checksReporting({}),
    );
    assert.equal(check.status, 'ok');
  });

  it('fails a network share, and reports rather than throwing', () => {
    // §1.0 refuses this at startup. The doctor's contract is to *report* it,
    // so a person can find out what state the installation is in without
    // running the thing that refuses.
    //
    // Breaks if the check stops calling the real refusal, or if it lets the
    // refusal escape instead of turning it into a line.
    const share = sharePath('fileserver', 'store', 'broker.db');
    const check = checkStoreLocation(
      {
        databasePath: share,
        configuredDatabasePath: share,
        artifactsRoot: share,
        profileRoot: share,
        // The declared defaults (SCHEMA 6.2). These checks are about path
        // resolution; the numbers are here to complete the shape.
        tabBudget: 15,
        leaseSeconds: 600,
        queueSeconds: 600,
      },
      checksReporting({}),
    );

    assert.equal(check.status, 'failed');
    assert.equal(check.id, 'store.not_on_network_filesystem');
    assert.ok(check.remedy !== undefined, 'a failing check owes a remedy');
  });

  it('fails a local-looking path that resolves onto a share', () => {
    // The mapped-drive case, which is why one check is not enough. A doctor
    // that only tested the written form would pass this and the service would
    // then refuse to start.
    const mapped = localDrivePath('Z', 'store', 'broker.db');
    const check = checkStoreLocation(
      {
        databasePath: mapped,
        configuredDatabasePath: mapped,
        artifactsRoot: mapped,
        profileRoot: mapped,
        // The declared defaults (SCHEMA 6.2). These checks are about path
        // resolution; the numbers are here to complete the shape.
        tabBudget: 15,
        leaseSeconds: 600,
        queueSeconds: 600,
      },
      checksReporting({
        mappings: { [mapped]: sharePath('fileserver', 'store', 'broker.db') },
      }),
    );

    assert.equal(check.status, 'failed');
  });

  it('does not echo the path back into the report', () => {
    // The report is a thing people paste into messages. §4.1a's reasoning
    // about the document applies to a terminal transcript too.
    const share = sharePath('fileserver', 'store', 'broker.db');
    const check = checkStoreLocation(
      {
        databasePath: share,
        configuredDatabasePath: share,
        artifactsRoot: share,
        profileRoot: share,
        // The declared defaults (SCHEMA 6.2). These checks are about path
        // resolution; the numbers are here to complete the shape.
        tabBudget: 15,
        leaseSeconds: 600,
        queueSeconds: 600,
      },
      checksReporting({}),
    );

    assert.ok(!check.detail.includes('fileserver'));
  });
});

describe('the store file', () => {
  it('reports a store that does not exist as unevaluable, not as broken', () => {
    // A fresh install has no store. Failing here would make every new
    // installation look faulty, and the person acting on it would go looking
    // for a fault that is not there.
    const temp = makeTempStore();
    try {
      const check = checkStorePresent(temp.environment);
      assert.equal(check.status, 'unknown');
    } finally {
      temp.remove();
    }
  });

  it('reports a present, readable store as ok', () => {
    const temp = makeTempStore();
    try {
      fs.mkdirSync(path.dirname(temp.environment.databasePath), { recursive: true });
      fs.writeFileSync(temp.environment.databasePath, '');
      const check = checkStorePresent(temp.environment);
      assert.equal(check.status, 'ok');
    } finally {
      temp.remove();
    }
  });
});

describe('the schema version', () => {
  it('passes when the store is at the version this build expects', () => {
    assert.equal(checkSchemaVersion(EXPECTED_VERSION).status, 'ok');
  });

  it('fails when the store is behind, and points at a spawn rather than stepping', () => {
    // The doctor reports and changes nothing. A doctor that stepped would
    // make the store's version depend on having been asked about it.
    const check = checkSchemaVersion(EXPECTED_VERSION - 1);
    assert.equal(check.status, 'failed');
    assert.match(check.remedy ?? '', /reports and does not step/);
  });

  it('fails differently when the store is ahead of the build', () => {
    // The dangerous direction: the running code does not know what the newer
    // schema means. A check that reported both directions identically would
    // send somebody to the wrong remedy.
    const check = checkSchemaVersion(EXPECTED_VERSION + 1);
    assert.equal(check.status, 'failed');
    assert.match(check.detail, /written by a newer build/);
    assert.match(check.remedy ?? '', /newer build/);
  });

  it('reports no store as unevaluable', () => {
    assert.equal(checkSchemaVersion(null).status, 'unknown');
  });
});

describe('the roots', () => {
  it('proves a root is writable by writing, and removes what it wrote', () => {
    // `fs.access` consults permission bits a filesystem, a mount or an
    // access-control list can override. The write is the only answer that is
    // not a guess.
    const temp = makeTempStore();
    try {
      fs.mkdirSync(temp.environment.artifactsRoot, { recursive: true });
      const before = fs.readdirSync(temp.environment.artifactsRoot);

      const check = checkRootWritable(
        'roots.artifacts_writable',
        'x',
        temp.environment.artifactsRoot,
      );

      assert.equal(check.status, 'ok');
      // The probe is gone. Breaks if the cleanup is removed.
      assert.deepEqual(fs.readdirSync(temp.environment.artifactsRoot), before);
    } finally {
      temp.remove();
    }
  });

  it('reports an absent root as unevaluable and does not create it', () => {
    // Creating it is the setup handshake's job. A doctor that created what it
    // was asked to check would report on a state it had just produced.
    const temp = makeTempStore();
    try {
      const check = checkRootWritable(
        'roots.artifacts_writable',
        'x',
        temp.environment.artifactsRoot,
      );

      assert.equal(check.status, 'unknown');
      assert.equal(fs.existsSync(temp.environment.artifactsRoot), false);
    } finally {
      temp.remove();
    }
  });
});

describe('a browser’s discovery record', () => {
  it('reports no record as unevaluable — nothing has been launched', () => {
    const check = checkDiscoveryRecord('regular', { recorded: false });
    assert.equal(check.status, 'unknown');
  });

  it('fails a record whose endpoint does not answer', () => {
    // §1.2c, verified: "the file was still there, still readable and still
    // naming a port, while the endpoint behind it was dead". A file is not a
    // process.
    const check = checkDiscoveryRecord('regular', { recorded: true, answered: false });
    assert.equal(check.status, 'failed');
    assert.match(check.detail, /did not answer/);
  });

  it('fails a record whose endpoint answers as a different browser', () => {
    // The identity half, and the reason it exists: ports are reused, so a
    // check comparing only the number "will connect to it and report
    // success". This is the case a port-only check passes.
    //
    // Breaks if the uuid comparison is deleted — the check would return ok.
    const check = checkDiscoveryRecord('regular', {
      recorded: true,
      answered: true,
      expectedUuid: 'uuid-recorded',
      reportedUuid: 'uuid-of-something-else',
    });

    assert.equal(check.status, 'failed');
    assert.match(check.detail, /port has been reused/);
  });

  it('fails a record that answers but cannot be identified at all', () => {
    // Answering is not enough. "Attaching to a stranger is worse than failing
    // to attach, because it succeeds."
    const check = checkDiscoveryRecord('regular', { recorded: true, answered: true });
    assert.equal(check.status, 'failed');
  });

  it('passes only when both conditions hold', () => {
    const check = checkDiscoveryRecord('regular', {
      recorded: true,
      answered: true,
      expectedUuid: 'uuid-a',
      reportedUuid: 'uuid-a',
    });
    assert.equal(check.status, 'ok');
  });
});

describe('the keeper tab', () => {
  it('fails when a reachable browser has none', () => {
    // §3.15: without it "the last caller to release its lease destroys the
    // shared authenticated session by doing the single most ordinary thing a
    // caller ever does".
    const check = checkKeeperTab('regular', false);
    assert.equal(check.status, 'failed');
    assert.match(check.remedy ?? '', /does not create one/);
  });

  it('passes when it is there', () => {
    assert.equal(checkKeeperTab('regular', true).status, 'ok');
  });

  it('reports an unreachable browser as unevaluable', () => {
    assert.equal(checkKeeperTab('regular', undefined).status, 'unknown');
  });
});

describe('the tab budget', () => {
  it('fails when the store and this process disagree, naming both numbers', () => {
    // §1.10: each process is internally consistent and "the ceiling silently
    // stops being a ceiling. Nothing reports this." This check is the
    // reporting.
    //
    // Breaks if the comparison is removed or inverted.
    const check = checkTabBudget(15, 30);

    assert.equal(check.status, 'failed');
    assert.match(check.detail, /15/);
    assert.match(check.detail, /30/);
  });

  it('does not adopt either value', () => {
    // "It does not adopt the stored value... It does not overwrite the stored
    // value either." A remedy that told somebody the service would sort it
    // out would be describing a different design.
    const check = checkTabBudget(15, 30);
    assert.match(check.remedy ?? '', /neither value is adopted/i);
  });

  it('passes when they agree', () => {
    assert.equal(checkTabBudget(15, 15).status, 'ok');
  });

  it('reports an unrecorded budget as unevaluable', () => {
    assert.equal(checkTabBudget(null, 15).status, 'unknown');
  });
});

describe('the checks that have nothing to check yet', () => {
  it('says the automation tool is unevaluable rather than inventing a pass', () => {
    // A check that always passes is worse than one saying it has nothing to
    // check: the first is a no-op with a green tick beside it.
    const check = checkAutomation({ present: false });
    assert.equal(check.status, 'unknown');
  });

  it('passes once an automation tool is reported present', () => {
    const check = checkAutomation({ present: true, version: '1.2.3' });
    assert.equal(check.status, 'ok');
    assert.match(check.detail, /1\.2\.3/);
  });

  it('says the capture surface is unevaluable rather than inventing a pass', () => {
    assert.equal(checkCaptureSurface(undefined).status, 'unknown');
  });
});

describe('the exit code', () => {
  function check(group: GroupedCheck['group'], status: GroupedCheck['status']): GroupedCheck {
    return { group, id: `${group}.x`, title: 'x', status, detail: 'x' };
  }

  it('is zero when everything passes', () => {
    assert.equal(exitCodeFor([check('store', 'ok'), check('budget', 'ok')]), DOCTOR_EXIT.ok);
  });

  it('is zero when a check could not be evaluated', () => {
    // An unknown is not a failure. A readiness check that refused a fresh
    // install would be unusable on the machine it is most needed on.
    assert.equal(exitCodeFor([check('browsers', 'unknown')]), DOCTOR_EXIT.ok);
  });

  it('is distinct per failing precondition group', () => {
    // §5.5: "exiting with a distinct code on any failure", so a caller can
    // branch on what is wrong. Each is named individually rather than
    // iterated, so removing one is caught.
    assert.equal(exitCodeFor([check('store', 'failed')]), DOCTOR_EXIT.store);
    assert.equal(exitCodeFor([check('automation', 'failed')]), DOCTOR_EXIT.automation);
    assert.equal(exitCodeFor([check('roots', 'failed')]), DOCTOR_EXIT.roots);
    assert.equal(exitCodeFor([check('browsers', 'failed')]), DOCTOR_EXIT.browsers);
    assert.equal(exitCodeFor([check('capture', 'failed')]), DOCTOR_EXIT.capture);
    assert.equal(exitCodeFor([check('keeper', 'failed')]), DOCTOR_EXIT.keeper);
    assert.equal(exitCodeFor([check('budget', 'failed')]), DOCTOR_EXIT.budget);
  });

  it('no two groups share a code', () => {
    // A code that collided with another would tell a caller the wrong thing
    // was wrong, which is worse than a single verdict because it looks
    // specific.
    const codes = Object.values(DOCTOR_EXIT);
    assert.equal(new Set(codes).size, codes.length);
  });

  it('reports the lowest failing code, so it does not depend on check order', () => {
    const forwards = exitCodeFor([check('budget', 'failed'), check('store', 'failed')]);
    const backwards = exitCodeFor([check('store', 'failed'), check('budget', 'failed')]);
    assert.equal(forwards, backwards);
    assert.equal(forwards, DOCTOR_EXIT.store);
  });

  it('is never zero when something failed', () => {
    // The property a readiness check depends on. Breaks if a failing status
    // stops contributing.
    for (const group of [
      'store',
      'automation',
      'roots',
      'browsers',
      'capture',
      'keeper',
      'budget',
    ] as const) {
      assert.notEqual(exitCodeFor([check(group, 'failed')]), 0);
    }
  });
});
