import assert from 'node:assert/strict';
import test from 'node:test';

import type { Environment } from '../../src/config/environment.ts';
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

/* ─────────── the rollback must not speak over the real error ─────────── */

test('a failure inside the budget transaction reaches the caller as its own cause, not as a rollback error', async () => {
  // ── What this test is defending, and why it asserts on the message ────
  //
  // `readAndRecord` issues a `COMMIT` on **both** of its success paths, so a
  // failure at or after that point leaves no transaction to roll back. An
  // unguarded `db.prepare('ROLLBACK').run()` in the catch therefore throws
  // `SQLITE_ERROR: cannot rollback - no transaction is active`, and **that**
  // is the error the caller receives: told the rollback failed, and never
  // told what actually went wrong.
  //
  // So this asserts on **which** error arrives rather than that one did.
  // `assert.rejects(...)` alone would pass against the masking bug, because
  // the masking bug also rejects; it is precisely the test that cannot fail
  // for the defect it is named after.
  //
  // The trigger: `tabBudget` absent binds as NULL against
  // `schema/step-002-tab-budget.ts`'s `CHECK (tabs > 0)`. That is a real
  // startup misconfiguration on a path **every spawn runs**, which is what
  // made this masking worth a row.
  const temp = makeTempStore();
  try {
    // `tabBudget` deliberately absent. Cast because the type system is what
    // normally prevents this, and the point is what happens when something
    // gets past it — a value arriving from outside a typed boundary.
    const environment = { ...temp.environment, tabBudget: undefined } as unknown as Environment;

    await assert.rejects(
      () => prepareStore(environment),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);

        assert.doesNotMatch(
          message,
          /cannot rollback/i,
          'the caller was handed the rollback failure instead of the error that caused it — the catch in readAndRecord must guard its rollback and rethrow the original',
        );

        // And the real cause is present rather than merely something else:
        // an assertion that only forbade the rollback text would be satisfied
        // by any unrelated error, including one that lost the cause a
        // different way.
        assert.match(
          message,
          /tabs/i,
          `the surviving error should name what actually refused the budget row. Got: ${message}`,
        );
        return true;
      },
    );
  } finally {
    temp.remove();
  }
});
