import assert from 'node:assert/strict';
import test from 'node:test';

import { StartupRefusal } from '../../src/errors.ts';
import { agreeOnTabBudget } from '../../src/store/budget.ts';
import { prepareStore } from '../../src/store/open.ts';
import { makeTempStore } from '../helpers/temp-store.ts';

/**
 * `budget.agrees_with_store` (§7.2, §1.10).
 *
 * **The single-character change these are built to catch** is turning the
 * comparison into an adoption of the stored value — which is the change
 * somebody makes to be helpful, and which `MILESTONES.md` names outright.
 * Every test below fails if the refusal becomes an adoption, an overwrite, or
 * a warning.
 */

test('the first process to open the store records the value it believes', async () => {
  const temp = makeTempStore({ tabBudget: 15 });
  try {
    const store = await prepareStore(temp.environment);
    try {
      const row = store.db.prepare('SELECT tabs FROM tab_budget WHERE only_row = 1').get() as {
        tabs: number;
      };
      assert.equal(row.tabs, 15);
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
});

test('a later process whose environment agrees starts, and nothing happens at all', async () => {
  // The ordinary case: one machine, one environment.
  const temp = makeTempStore({ tabBudget: 15 });
  try {
    const first = await prepareStore(temp.environment);
    first.close();

    const second = await prepareStore(temp.environment);
    try {
      const row = second.db.prepare('SELECT tabs FROM tab_budget WHERE only_row = 1').get() as {
        tabs: number;
      };
      assert.equal(row.tabs, 15, 'the recorded value moved on an agreement');
    } finally {
      second.close();
    }
  } finally {
    temp.remove();
  }
});

test('a later process whose environment disagrees refuses to start, and names both numbers', async () => {
  const temp = makeTempStore({ tabBudget: 15 });
  try {
    const first = await prepareStore(temp.environment);
    first.close();

    await assert.rejects(
      () => prepareStore({ ...temp.environment, tabBudget: 30 }),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal);
        assert.equal(error.rule, 'budget.agrees_with_store');
        // Both numbers, because an operator has to decide which was meant and
        // cannot do that from a message naming one of them.
        assert.match(error.message, /\b15\b/);
        assert.match(error.message, /\b30\b/);
        return true;
      },
    );
  } finally {
    temp.remove();
  }
});

test('the refusal neither adopts the stored value nor overwrites it', async () => {
  // Adopting runs a process against a bound it was not configured for;
  // overwriting lets the most recent starter move a bound others are
  // mid-arbitration against. This is the test that dies when the comparison
  // becomes an assignment.
  const temp = makeTempStore({ tabBudget: 15 });
  try {
    const first = await prepareStore(temp.environment);
    first.close();

    await assert.rejects(() => prepareStore({ ...temp.environment, tabBudget: 30 }));

    // Read on a fresh handle: the store must still hold the first value.
    const reopened = await prepareStore(temp.environment);
    try {
      const row = reopened.db.prepare('SELECT tabs FROM tab_budget WHERE only_row = 1').get() as {
        tabs: number;
      };
      assert.equal(row.tabs, 15, 'the disagreeing process overwrote the recorded bound');
    } finally {
      reopened.close();
    }
  } finally {
    temp.remove();
  }
});

test('a disagreement in the other direction refuses too, so this is not a ceiling check', async () => {
  // A smaller environment value against a larger stored one is the same
  // broken invariant, and a check that only refused increases would let the
  // machine run over budget in exactly the direction that costs memory.
  const temp = makeTempStore({ tabBudget: 30 });
  try {
    const first = await prepareStore(temp.environment);
    first.close();

    await assert.rejects(
      () => prepareStore({ ...temp.environment, tabBudget: 4 }),
      (error: unknown) => {
        assert.ok(error instanceof StartupRefusal);
        assert.equal(error.rule, 'budget.agrees_with_store');
        return true;
      },
    );
  } finally {
    temp.remove();
  }
});

test('the recording is reported, so a caller can tell which process wrote the row', async () => {
  const temp = makeTempStore({ tabBudget: 7 });
  try {
    const store = await prepareStore(temp.environment);
    try {
      // The spawn above already recorded it, so this call is the later one.
      const agreement = agreeOnTabBudget(store.db, 7);
      assert.equal(agreement.tabs, 7);
      assert.equal(agreement.recorded, false);
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
});

test('the store refuses a second budget row, so the check cannot become a settings table', async () => {
  const temp = makeTempStore({ tabBudget: 15 });
  try {
    const store = await prepareStore(temp.environment);
    try {
      assert.throws(() => {
        store.db.prepare('INSERT INTO tab_budget (only_row, tabs) VALUES (2, 30)').run();
      });
    } finally {
      store.close();
    }
  } finally {
    temp.remove();
  }
});
