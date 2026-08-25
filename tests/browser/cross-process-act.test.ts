import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { BrowserSession, TabHandle } from '../../src/browser/driver.ts';
import { BrokerError } from '../../src/errors.ts';
import { RealBrowserDriver, REFERENCE_RESOLUTION_MS } from '../../src/browser/real.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { teardownBrowser, temporaryProfileRoot } from '../helpers/browser-fixture.ts';

/**
 * **An element reference minted by one connection is acted on by another.**
 *
 * ── The state this rules out, stated as a caller experiences it ─────────
 *
 * This service is daemonless: it is spawned by its caller, serves that session
 * and exits with it. So a command line running one command per process reads
 * the page in one process and acts in the next — and the reference it carries
 * across was minted by a snapshot the *previous* connection took.
 *
 * The automation library's reference engine is populated **per connection**. A
 * connection that has taken no snapshot knows no references, so the lookup
 * matched nothing. It did not fail: it waited out the default action timeout —
 * measured at 30.5 seconds — and then reported an element that never appeared.
 * The call came back `accepted` with `pageDriven: false`, and the page had not
 * moved. Every `act` through the command line was in that state.
 *
 * ── Why these tests force the connection boundary ───────────────────────
 *
 * **A test in which the reference happens to resolve anyway proves nothing.**
 * If the acting connection is the same one that took the snapshot, the
 * reference resolves whether or not any of the code under test is present, and
 * the suite would pass just as green with the fix deleted. That is the shape
 * this repository has been caught by before — a fixture in which the correct
 * and the incorrect behaviour coincide.
 *
 * So every test below acts through **a second, independently attached
 * session** that has taken no snapshot of the page. That is not a simulation
 * of the cross-process case; it is the same mechanism, because a second
 * process is exactly a second connection.
 *
 * ── Where these run ─────────────────────────────────────────────────────
 *
 * They drive a real browser, so each skips by name when there is not one.
 * Continuous integration runs on hosted runners with no browser installed, so
 * this suite is local-only and **a green pipeline is not evidence it
 * executed**. Headless: nothing here is about a window being drawn.
 */

const available = browserAvailable();

/**
 * A page whose heading changes when the button is pressed.
 *
 * The heading is the mechanism: an `act` that returned a plausible result
 * without pressing anything satisfies any assertion made on its return value,
 * so what is asserted is **the page's own text afterwards**. `BEFORE` becoming
 * `CLICKED` cannot happen unless a real click reached a real element.
 */
const FIXTURE_HTML = [
  '<html><body>',
  '<h1 id="h">BEFORE</h1>',
  '<button id="go" onclick="document.getElementById(\'h\').textContent = \'CLICKED\'">go</button>',
  '<input id="txt" type="text">',
  '</body></html>',
].join('\n');

const FIXTURE_PAGE = `data:text/html,${encodeURIComponent(FIXTURE_HTML)}`;

interface Fixture {
  readonly driver: RealBrowserDriver;
  readonly first: BrowserSession;
  readonly tab: TabHandle;
  readonly outputDirectory: string;
  readonly profileRoot: string;
}

async function startFixture(): Promise<Fixture> {
  const profileRoot = temporaryProfileRoot();
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-cross-act-'));
  const driver = new RealBrowserDriver({
    executablePath: browserExecutablePath(),
    outputDirectory,
  });
  const first = await driver.coldStart({
    browser: 'private',
    profileDirectory: path.join(profileRoot, 'private'),
    mode: 'headless',
  });
  const tab = await first.openTab();
  await first.navigate(tab, FIXTURE_PAGE);
  return { driver, first, tab, outputDirectory, profileRoot };
}

async function stopFixture(fixture: Fixture): Promise<void> {
  await teardownBrowser(fixture.first, fixture.profileRoot);
  fs.rmSync(fixture.outputDirectory, { recursive: true, force: true });
}

/**
 * The reference the snapshot minted for the line naming something.
 *
 * Read out of the snapshot **file**, because that is the only place a caller's
 * references ever come from — a reference built any other way would prove
 * something no caller can do.
 */
function referenceFor(snapshot: string, needle: string): string {
  const line = snapshot.split('\n').find((candidate) => candidate.includes(needle));
  assert.ok(line, `the snapshot must name ${needle}; it did not:\n${snapshot}`);
  const found = /\[ref=([^\]]+)\]/.exec(line);
  assert.ok(found?.[1], `the snapshot must carry a reference for ${needle}, in: ${line}`);
  return found[1];
}

async function snapshotTextFrom(session: BrowserSession, tab: TabHandle): Promise<string> {
  const [result] = await session.read(tab, ['snapshot']);
  assert.ok(result);
  return fs.readFileSync(result.path, 'utf8');
}

async function headingIn(session: BrowserSession, tab: TabHandle): Promise<unknown> {
  return (await session.evaluate(tab, "document.getElementById('h').textContent")).value;
}

/**
 * Assert that acting refused, **by the rule rather than by its English**.
 *
 * `assert.rejects` with a regular expression matches the *message*, which
 * would tie these tests to prose that is meant to be rewritten freely. The
 * rule is the half the design says a caller branches on, so that is the half
 * asserted here — and it is checked as a `BrokerError`, so an ordinary
 * `TypeError` escaping from this path cannot satisfy it.
 */
async function refusesWithRule(
  act: () => Promise<unknown>,
  rule: string,
  message: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await act();
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown !== undefined, `${message} — but nothing was thrown at all`);
  assert.ok(
    thrown instanceof BrokerError,
    // Described rather than stringified: an arbitrary thrown value has no
    // useful string form, and the point of this line is to say what arrived
    // instead of a refusal.
    `${message} — a refusal, not a programming mistake; got ${
      thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown
    }`,
  );
  assert.equal(thrown.rule, rule, message);
}

test(
  'a reference minted by one connection CLICKS through another, and the page moves',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();

    try {
      // The reference is minted here, by the first connection — exactly as the
      // `read` command mints one in the process before the `act` command.
      const reference = referenceFor(
        await snapshotTextFrom(fixture.first, fixture.tab),
        'button "go"',
      );

      assert.equal(
        await headingIn(fixture.first, fixture.tab),
        'BEFORE',
        'the fixture starts in the state the click changes, or the assertion below proves nothing',
      );

      // **A second connection, which has taken no snapshot of this page.**
      // This is the whole fixture: the reference engine is populated per
      // connection, so this one has no registration for the reference above.
      // Acting through the same session would resolve it for reasons that have
      // nothing to do with the code under test.
      const second = await fixture.driver.attach('private', fixture.first.describe().discovery);

      try {
        await second.act(fixture.tab, { action: 'click', ref: reference });

        // **Read back out of the page, through the connection that did NOT
        // act.** An act that reported success without pressing anything, or
        // one that pressed something else, cannot produce this.
        assert.equal(
          await headingIn(fixture.first, fixture.tab),
          'CLICKED',
          'the click landed on the element the other connection named',
        );
      } finally {
        await second.detach();
      }
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'the reference a second connection resolves is the SAME element, not merely some element',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();

    try {
      // ── Why this test exists next to the one above ────────────────────
      //
      // Re-registering references by taking a fresh snapshot would "work" in
      // the click test even if the names came out in a different order,
      // because that page has exactly one button and pressing anything else
      // would still have been visible only as the heading not changing.
      //
      // The claim being protected is stronger and is the reason the retry is
      // legitimate at all: **the names are derived from the element's place in
      // the accessibility tree, not from a per-connection counter**, so the
      // same element gets the same name in every connection. If that were
      // false, a re-snapshot would resolve the reference to *a* live element —
      // the wrong one — and an action would land somewhere nobody asked for.
      // That is a worse failure than the one being fixed, and it is silent.
      const fromFirst = await snapshotTextFrom(fixture.first, fixture.tab);

      const second = await fixture.driver.attach('private', fixture.first.describe().discovery);
      try {
        const fromSecond = await snapshotTextFrom(second, fixture.tab);

        for (const needle of ['button "go"', 'heading "BEFORE"', 'textbox']) {
          assert.equal(
            referenceFor(fromSecond, needle),
            referenceFor(fromFirst, needle),
            `${needle} has the same reference in both connections`,
          );
        }

        // And the references are not all one value, which would satisfy the
        // loop above while meaning nothing.
        assert.notEqual(
          referenceFor(fromFirst, 'button "go"'),
          referenceFor(fromFirst, 'heading "BEFORE"'),
        );
      } finally {
        await second.detach();
      }
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'a reference naming nothing is refused FAST, rather than waiting out the action timeout',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();

    try {
      const second = await fixture.driver.attach('private', fixture.first.describe().discovery);

      try {
        const started = Date.now();
        await refusesWithRule(
          async () => await second.act(fixture.tab, { action: 'click', ref: 'e99999' }),
          'act.ref_resolves',
          'the refusal names the rule, so a caller can branch on it without matching on English',
        );
        const elapsed = Date.now() - started;

        // ── The bound, and why it is asserted rather than assumed ─────────
        //
        // The defect was not only that this failed — it was that it took 30.5
        // seconds to say so, because the lookup fell through to the automation
        // library's default action timeout. An assertion on the *reason* alone
        // would pass just as green at 30 seconds, so the duration is the thing
        // measured.
        //
        // The ceiling is generous against the ~250ms x 2 plus one snapshot
        // this path actually costs, because a test that fails when a loaded
        // machine is briefly slow is a test that gets deleted. It is still an
        // order of magnitude below the timeout it protects against, which is
        // the distinction it exists to make.
        assert.ok(
          elapsed < 10_000,
          `an unresolvable reference must fail fast; this took ${String(elapsed)}ms`,
        );

        // The page was left alone by the failed lookup.
        assert.equal(await headingIn(fixture.first, fixture.tab), 'BEFORE');
      } finally {
        await second.detach();
      }
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'an element that is genuinely gone is REFUSED, not silently accepted',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();

    try {
      const second = await fixture.driver.attach('private', fixture.first.describe().discovery);

      try {
        // ── The failure this rules out ──────────────────────────────────
        //
        // The registration this fix establishes must not become a way of
        // *rehabilitating* a dead reference. A reference is minted, its
        // element is then removed, and the demand is that acting on it still
        // refuses — because an action that quietly resolved it to whatever now
        // holds that name would click the wrong element and report success,
        // and an action that returned a snapshot and reported the work done
        // would be the accepting-while-doing-nothing defect reintroduced by
        // its own remedy.
        //
        // ── Why the reference is read through the ACTING connection ──────
        //
        // This is the load-bearing detail of the fixture. References are
        // assigned afresh per connection from the tree's current shape, so a
        // reference minted *before* the removal by a connection that had never
        // snapshotted the page names a different element there: measured, the
        // textbox inherits the removed button's `e4`. Acting on it would then
        // land on the textbox — correctly, by that connection's own reckoning.
        //
        // That is not the stale-reference case; it is a reference that was
        // never valid in this connection. **The real case is a caller that
        // read the page and then had it change underneath it**, which is what
        // this sets up: the acting connection reads first, exactly as any
        // caller must in order to hold a reference at all, and only then is
        // the element removed.
        const reference = referenceFor(await snapshotTextFrom(second, fixture.tab), 'button "go"');

        await fixture.first.evaluate(fixture.tab, "document.getElementById('go').remove()");

        await refusesWithRule(
          async () => await second.act(fixture.tab, { action: 'click', ref: reference }),
          'act.ref_resolves',
          'a reference whose element has gone refuses rather than resolving to something else',
        );

        assert.equal(
          await headingIn(fixture.first, fixture.tab),
          'BEFORE',
          'and nothing on the page was pressed in the attempt',
        );

        // **The element that inherited the name was not touched either**,
        // which is the specific misdirection being ruled out rather than the
        // general one above.
        assert.equal(
          (await fixture.first.evaluate(fixture.tab, "document.getElementById('txt').value")).value,
          '',
          'the click did not land on whatever now answers to that reference',
        );
      } finally {
        await second.detach();
      }
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'a verb that CHANGES the page works across connections too, not only click',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();

    try {
      // ── Why a second verb, and why `fill` specifically ─────────────────
      //
      // The resolution path is shared by every verb that names an element, so
      // one of them working is weak evidence for the rest. `fill` is the one
      // worth adding because it is measured against a **non-empty** starting
      // value: this repository has been caught by a `fill` test on an empty
      // field, where "filled it" and "did nothing" produce the same page.
      await fixture.first.evaluate(
        fixture.tab,
        "document.getElementById('txt').value = 'ORIGINAL'",
      );

      const reference = referenceFor(await snapshotTextFrom(fixture.first, fixture.tab), 'textbox');

      const second = await fixture.driver.attach('private', fixture.first.describe().discovery);
      try {
        await second.act(fixture.tab, { action: 'fill', ref: reference, value: 'REPLACED' });

        assert.equal(
          (await fixture.first.evaluate(fixture.tab, "document.getElementById('txt').value")).value,
          'REPLACED',
          'the field the other connection named holds the value it was given',
        );
      } finally {
        await second.detach();
      }
    } finally {
      await stopFixture(fixture);
    }
  },
);

test('the resolution bound stays far below the default action timeout', () => {
  // ── A test with no browser, about the number itself ──────────────────
  //
  // The whole point of the bound is that it is not the automation library's
  // 30-second default. A value that drifted up to meet it would leave every
  // test above passing — they assert on a ceiling of ten seconds — while the
  // dead wait quietly came back. So the constant is pinned here, where it
  // costs nothing and runs everywhere including a hosted runner.
  assert.ok(REFERENCE_RESOLUTION_MS > 0, 'a non-positive bound would refuse everything instantly');
  assert.ok(
    REFERENCE_RESOLUTION_MS <= 1_000,
    'the bound must stay an order of magnitude below the 30s action timeout it exists to avoid',
  );
});
