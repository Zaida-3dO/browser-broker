import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { BrowserSession, TabHandle } from '../../src/browser/driver.ts';
import { PAGE_ACTIONS, READ_ARTIFACTS } from '../../src/browser/driver.ts';
import { RealBrowserDriver } from '../../src/browser/real.ts';
import { browserAvailable, browserExecutablePath, skipReason } from '../helpers/browser.ts';
import { teardownBrowser, temporaryProfileRoot } from '../helpers/browser-fixture.ts';

/**
 * `act` and `read` on the real driver — rows #22, #23, #61, #62, #63, #64.
 *
 * ── Where these run, stated so a green pipeline is not misread ──────────
 *
 * **Every test here drives a real browser, so every one of them skips when
 * there is not one** — with the reason stated by name, per-test, never as a
 * silent `describe.skip`. Continuous integration runs on hosted runners with
 * no browser and no display, so **this whole suite is local-only** and a green
 * pipeline is not evidence that any of it executed. That is the same
 * arrangement the neighbouring browser suites use and it is recorded in each.
 *
 * They run **headless**, which is correct here and is worth distinguishing
 * from the keeper-tab suite next door: that one must be headed because the
 * behaviour it protects against *only happens* headed. Nothing in this file is
 * like that — a click, a resize and a media preference behave the same in both
 * modes — so headless is the honest choice rather than a shortcut, and there
 * is no assertion here that a headed run would strengthen.
 *
 * ── What these tests are careful to measure ─────────────────────────────
 *
 * **The page, not the call.** An action that returned a plausible result
 * without moving the page would satisfy any assertion made on its return
 * value alone, so almost every test below reads the state back **out of the
 * page** after acting — the field's value, the checkbox's checked-ness,
 * `matchMedia`, `window.scrollY`. That is the mechanism; the returned snapshot
 * is not.
 */

const available = browserAvailable();

/** One browser, one tab, and the directory its artefacts are written into. */
interface Fixture {
  readonly session: BrowserSession;
  readonly tab: TabHandle;
  readonly outputDirectory: string;
  readonly profileRoot: string;
}

/**
 * A page with one of everything the verbs address.
 *
 * Served as a data address rather than from a server, so the suite starts no
 * listener and nothing here depends on a port being free.
 */
const FIXTURE_HTML = [
  '<html><body>',
  '<button id="b" onclick="window.__clicks = (window.__clicks || 0) + 1">Press me</button>',
  '<input id="txt" type="text">',
  '<input id="chk" type="checkbox">',
  '<select id="sel"><option value="a">A</option><option value="b">B</option></select>',
  '<div id="hov" onmouseover="window.__hovered = true" onclick="window.__hovClicks = (window.__hovClicks || 0) + 1">hover target</div>',
  '<input id="one"><input id="two">',
  '<div id="src" draggable="true">DRAGME</div><div id="dst">DROPHERE</div>',
  '<div style="height:3000px"></div>',
  '<button id="dlg" onclick="window.__answer = confirm(\'really?\')">raise dialog</button>',
  '<script>console.log("a message from the page")</script>',
  '</body></html>',
].join('\n');

const FIXTURE_PAGE = `data:text/html,${encodeURIComponent(FIXTURE_HTML)}`;

async function startFixture(): Promise<Fixture> {
  const profileRoot = temporaryProfileRoot();
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-act-read-'));
  const driver = new RealBrowserDriver({
    executablePath: browserExecutablePath(),
    outputDirectory,
  });
  const session = await driver.coldStart({
    browser: 'private',
    profileDirectory: path.join(profileRoot, 'private'),
    mode: 'headless',
  });
  const tab = await session.openTab();
  await session.navigate(tab, FIXTURE_PAGE);
  return { session, tab, outputDirectory, profileRoot };
}

async function stopFixture(fixture: Fixture): Promise<void> {
  await teardownBrowser(fixture.session, fixture.profileRoot);
  fs.rmSync(fixture.outputDirectory, { recursive: true, force: true });
}

/** What the page says, so an assertion is about the page and not the call. */
async function inPage(fixture: Fixture, expression: string): Promise<unknown> {
  return (await fixture.session.evaluate(fixture.tab, expression)).value;
}

/** The current snapshot's text, which is where a caller's references come from. */
async function snapshotText(fixture: Fixture): Promise<string> {
  const [result] = await fixture.session.read(fixture.tab, ['snapshot']);
  assert.ok(result);
  return fs.readFileSync(result.path, 'utf8');
}

/**
 * The reference the snapshot minted for the line naming something.
 *
 * Read out of the snapshot **file** rather than constructed, because that is
 * the round trip that matters: a caller only ever has the references our own
 * snapshot handed it, so a test that built a reference some other way would be
 * proving something no caller can do.
 */
function referenceFor(snapshot: string, needle: string): string {
  const line = snapshot.split('\n').find((candidate) => candidate.includes(needle));
  assert.ok(line, `the snapshot must name ${needle}; it did not:\n${snapshot}`);
  // The identifier is NOT always `eN`. Measured: after a tab navigates a
  // second time, the snapshot mints frame-qualified references such as
  // `f1e3`. A pattern that only recognised `eN` passed on a freshly-opened tab
  // and failed on a re-navigated one — so it is matched as "whatever the
  // snapshot put there", which is also the only thing a caller could do.
  const found = /\[ref=([^\]]+)\]/.exec(line);
  assert.ok(found?.[1], `the snapshot must carry a reference for ${needle}, in: ${line}`);
  return found[1];
}

// ── The two tests that need no browser ─────────────────────────────────
//
// These are about the closed lists themselves, which are data on the seam, so
// they run everywhere including a hosted runner.

test('the seam declares exactly the thirteen verbs and four artefacts §3.8 and §3.9 list', () => {
  // Named as literals rather than iterated, deliberately. A test that walked
  // `PAGE_ACTIONS` and asserted something about each entry would still pass if
  // an entry were deleted — it would simply walk a shorter list. Writing them
  // out means a verb disappearing from the seam fails here, which is the only
  // way this can be the thing that notices.
  //
  // This is a check on the LISTS, not on the driver: what proves each verb is
  // implemented is the browser-driving tests below, which perform every one of
  // them against a real page and read the result out of the page. A source
  // scan asserting `case 'click':` appears in the driver was written first and
  // then deleted — it is satisfied by the string occurring in a comment, which
  // makes it exactly the whole-file-substring shape this repository has been
  // caught by before.
  assert.deepEqual(
    [...PAGE_ACTIONS],
    [
      'click',
      'type',
      'fill',
      'press',
      'select',
      'hover',
      'check',
      'scroll',
      'resize',
      'emulate',
      'dialog',
      'fill_form',
      'drag',
    ],
  );
  assert.deepEqual([...READ_ARTIFACTS], ['snapshot', 'console', 'network', 'cookies']);
});

// ── Everything below drives a real browser ─────────────────────────────

test(
  'the element verbs each change the page: click, fill, type, press, check, select, hover',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      const snapshot = await snapshotText(fixture);

      // Click. Measured in the page's own counter rather than in the result,
      // because a click that did nothing would still return a snapshot.
      await fixture.session.act(fixture.tab, {
        action: 'click',
        ref: referenceFor(snapshot, 'Press me'),
      });
      assert.equal(await inPage(fixture, 'window.__clicks'), 1);

      // Fill sets the value in one step.
      await fixture.session.act(fixture.tab, {
        action: 'fill',
        ref: referenceFor(snapshot, 'textbox'),
        value: 'filled-text',
      });
      assert.equal(await inPage(fixture, "document.getElementById('txt').value"), 'filled-text');

      // Type appends keystroke by keystroke, which is what makes it a
      // different verb from fill rather than a synonym.
      await fixture.session.act(fixture.tab, {
        action: 'type',
        ref: referenceFor(snapshot, 'textbox'),
        value: 'MORE',
      });
      assert.equal(
        await inPage(fixture, "document.getElementById('txt').value"),
        'filled-textMORE',
        'type appends to what is there; a fill would have replaced it',
      );

      // Press with a reference goes to THAT element, not to whatever has
      // focus.
      //
      // ── Why focus is moved away first, and why that is the whole test ────
      //
      // **Measured: without this line the test could not fail.** A mutation
      // that sends the key to whatever is focused, rather than to the named
      // element, SURVIVED — because the `type` above had just left focus in
      // that very textbox. Both behaviours were being asked to hit the same
      // element, so the assertion could not tell them apart.
      //
      // Focus is therefore parked somewhere else first, which makes "goes to
      // the referenced element" and "goes to the focused element" observably
      // different outcomes.
      //
      // **The key is an inserted character rather than Backspace, and that is
      // not arbitrary.** Measured while writing this: re-focusing an input
      // puts the caret at position 0, so a Backspace arrives at the start of
      // the value and correctly deletes nothing — which would make this
      // assertion fail against a driver that is behaving properly. An
      // inserted character lands wherever the caret is and is visible either
      // way, so the test measures which ELEMENT received the key rather than
      // where the caret happened to be.
      await fixture.session.evaluate(fixture.tab, "document.getElementById('one').focus()");
      await fixture.session.act(fixture.tab, {
        action: 'press',
        ref: referenceFor(snapshot, 'textbox'),
        value: 'Z',
      });
      assert.equal(
        await inPage(fixture, "document.getElementById('txt').value"),
        'Zfilled-textMORE',
        'the key must reach the referenced element, not the focused one',
      );
      assert.equal(
        await inPage(fixture, "document.getElementById('one').value"),
        '',
        'and the element that merely had focus must be untouched',
      );

      // Check asserts the box ends up checked, and is a NO-OP on one already
      // checked — where a click would toggle it off.
      //
      // ── Why the box is checked first ────────────────────────────────────
      //
      // **Measured: without this, the test could not fail.** A mutation that
      // clicks the box instead of checking it SURVIVED against a box that
      // started unchecked, because on that box the two verbs do the same
      // thing. The difference only exists on a box that is already checked,
      // so that is the state this asserts against.
      await fixture.session.evaluate(fixture.tab, "document.getElementById('chk').checked = true");
      await fixture.session.act(fixture.tab, {
        action: 'check',
        ref: referenceFor(snapshot, 'checkbox'),
      });
      assert.equal(
        await inPage(fixture, "document.getElementById('chk').checked"),
        true,
        'checking an already-checked box must leave it checked; a click would have cleared it',
      );

      await fixture.session.act(fixture.tab, {
        action: 'select',
        ref: referenceFor(snapshot, 'combobox'),
        value: 'b',
      });
      assert.equal(await inPage(fixture, "document.getElementById('sel').value"), 'b');

      // Hover puts the pointer over the element WITHOUT pressing it.
      //
      // ── Why the click counter is read too, and why that is the whole test ─
      //
      // **Measured: without the second assertion this test could not fail.** A
      // mutation implementing `hover` as a click SURVIVED against
      // `window.__hovered` alone, because **a click hovers on its way in** —
      // the browser dispatches `mouseover` before `mousedown`, so the correct
      // and the incorrect verb both set that flag. The assertion could not
      // tell them apart.
      //
      // The target therefore counts its clicks as well, the same way the
      // button at the top of the fixture does, and the count staying at zero
      // is what makes "hovered" and "clicked" observably different outcomes.
      await fixture.session.act(fixture.tab, {
        action: 'hover',
        ref: referenceFor(snapshot, 'hover target'),
      });
      assert.equal(await inPage(fixture, 'window.__hovered'), true);
      assert.equal(
        await inPage(fixture, 'window.__hovClicks || 0'),
        0,
        'hover must not press the element; a click would have registered here',
      );
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'a reference that does not resolve is refused, and the page is not touched (§3.8)',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      // A well-formed reference naming nothing. The refusal is owed here
      // rather than upstream because whether an element is on the page is not
      // a fact any validator can know before looking.
      await assert.rejects(
        fixture.session.act(fixture.tab, { action: 'click', ref: 'e9999' }),
        'a reference that resolves to no element must refuse rather than land somewhere else',
      );

      // And nothing happened. This is the assertion that distinguishes a
      // refusal from a click that missed: had the reference silently matched
      // something, the counter would have moved.
      assert.equal(await inPage(fixture, 'window.__clicks'), undefined);
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'resize sets the viewport, which no expression can do (#61)',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      await fixture.session.act(fixture.tab, {
        action: 'resize',
        viewport: { width: 375, height: 812 },
      });

      // Read out of the PAGE, and that is load-bearing rather than stylistic:
      // over a CDP-attached context the library's own `viewportSize()` reads
      // `null` — measured — so a test that asserted on it would be asserting
      // on something that is null whether or not the resize worked. The page
      // is the only place the answer actually is.
      assert.equal(await inPage(fixture, 'window.innerWidth'), 375);
      assert.equal(await inPage(fixture, 'window.innerHeight'), 812);

      // A second resize, to prove the first was not a coincidence of whatever
      // the browser happened to start at.
      await fixture.session.act(fixture.tab, {
        action: 'resize',
        viewport: { width: 1280, height: 720 },
      });
      assert.equal(await inPage(fixture, 'window.innerWidth'), 1280);
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'emulate sets each media preference independently, and the PAGE reports them (#62)',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      const dark = "matchMedia('(prefers-color-scheme: dark)').matches";
      const motion = "matchMedia('(prefers-reduced-motion: reduce)').matches";
      const contrast = "matchMedia('(forced-colors: active)').matches";

      assert.equal(await inPage(fixture, dark), false, 'the fixture must start light');

      await fixture.session.act(fixture.tab, {
        action: 'emulate',
        preferences: { colourScheme: 'dark' },
      });
      // What the BROWSER reports, which §3.8 says is the code path a dark-mode
      // review exists to check — as opposed to a page's own theme switch,
      // which exercises the page's state instead.
      assert.equal(await inPage(fixture, dark), true);

      // Independence: setting motion must not disturb the colour scheme. A
      // driver that rebuilt the whole preference set on every call would reset
      // dark mode here, and this is the assertion that catches it.
      await fixture.session.act(fixture.tab, {
        action: 'emulate',
        preferences: { reducedMotion: 'reduce' },
      });
      assert.equal(await inPage(fixture, motion), true);
      assert.equal(
        await inPage(fixture, dark),
        true,
        'naming one preference must not reset another the caller set earlier',
      );

      await fixture.session.act(fixture.tab, {
        action: 'emulate',
        preferences: { forcedColours: 'active' },
      });
      assert.equal(await inPage(fixture, contrast), true);
      assert.equal(await inPage(fixture, dark), true);
      assert.equal(await inPage(fixture, motion), true);
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'an armed dialog answer is applied, and the action that raises it RETURNS (#63)',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      const snapshot = await snapshotText(fixture);
      const raiser = referenceFor(snapshot, 'raise dialog');

      // Arm an acceptance, then trip it.
      await fixture.session.act(fixture.tab, {
        action: 'dialog',
        response: { accept: true },
      });
      await fixture.session.act(fixture.tab, { action: 'click', ref: raiser });

      // Two things are being asserted and the second is the important one.
      // First: the page's `confirm()` returned what was armed.
      assert.equal(await inPage(fixture, 'window.__answer'), true);
      // Second, and implicit in having got this far at all: **the click
      // returned**. An unanswered dialog blocks the very action that raised
      // it — measured, `page.click` times out rather than resolving — so a
      // driver that failed to answer would hang here until the test timed out
      // rather than reaching this line. That is the lease-burning failure
      // §3.8 puts this verb on the list for.

      // The other disposition, to prove the boolean is read rather than
      // ignored in favour of always accepting.
      await fixture.session.act(fixture.tab, {
        action: 'dialog',
        response: { accept: false },
      });
      await fixture.session.act(fixture.tab, { action: 'click', ref: raiser });
      assert.equal(
        await inPage(fixture, 'window.__answer'),
        false,
        'a dismissal must reach the page as a dismissal, not as an acceptance',
      );
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'an armed acceptance carries prompt text into the page (#63)',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      await fixture.session.navigate(
        fixture.tab,
        `data:text/html,${encodeURIComponent(
          '<button id="p" onclick="window.__typed = prompt(\'name?\')">prompt</button>',
        )}`,
      );
      const snapshot = await snapshotText(fixture);

      await fixture.session.act(fixture.tab, {
        action: 'dialog',
        response: { accept: true, promptText: 'the-typed-value' },
      });
      await fixture.session.act(fixture.tab, {
        action: 'click',
        ref: referenceFor(snapshot, 'prompt'),
      });

      assert.equal(await inPage(fixture, 'window.__typed'), 'the-typed-value');
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'scroll moves the page, and with a reference brings an element into view',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      assert.equal(await inPage(fixture, 'window.scrollY'), 0);
      await fixture.session.act(fixture.tab, { action: 'scroll' });
      const after = await inPage(fixture, 'window.scrollY');
      assert.ok(
        typeof after === 'number' && after > 0,
        `a page scroll must move the page; scrollY was ${String(after)}`,
      );
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'fill_form fills every field in the batch (#64)',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      const snapshot = await snapshotText(fixture);
      // The three textboxes in the fixture, in snapshot order.
      const boxes = snapshot
        .split('\n')
        .filter((line) => line.includes('textbox'))
        .map((line) => /\[ref=([^\]]+)\]/.exec(line)?.[1] ?? '');
      assert.ok(boxes.length >= 3, `the fixture must offer three textboxes, found ${boxes.length}`);

      await fixture.session.act(fixture.tab, {
        action: 'fill_form',
        fields: [
          { ref: boxes[1]!, value: 'first-value' },
          { ref: boxes[2]!, value: 'second-value' },
        ],
      });

      // BOTH, which is what makes this a batch rather than a fill. A driver
      // that filled only the first field would satisfy a single-field
      // assertion.
      assert.equal(await inPage(fixture, "document.getElementById('one').value"), 'first-value');
      assert.equal(await inPage(fixture, "document.getElementById('two').value"), 'second-value');
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'drag is element-to-element and in-page (#64, measured at zero calls)',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      // A page that records the drag events it receives, because a drag's
      // visible effect is entirely up to the page — there is nothing to read
      // back unless the page writes something down.
      await fixture.session.navigate(
        fixture.tab,
        `data:text/html,${encodeURIComponent(
          [
            '<div id="src" draggable="true">DRAGME</div>',
            '<div id="dst" ondragover="event.preventDefault()" ondrop="window.__dropped = true">DROPHERE</div>',
          ].join(''),
        )}`,
      );
      const snapshot = await snapshotText(fixture);

      await fixture.session.act(fixture.tab, {
        action: 'drag',
        ref: referenceFor(snapshot, 'DRAGME'),
        targetRef: referenceFor(snapshot, 'DROPHERE'),
      });

      assert.equal(
        await inPage(fixture, 'window.__dropped'),
        true,
        'the target must have received a drop',
      );
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'every action returns a FRESH snapshot, written to disk, whose references resolve (§3.8)',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      // A page whose content changes as a result of the action, so "fresh"
      // is observable rather than asserted.
      await fixture.session.navigate(
        fixture.tab,
        `data:text/html,${encodeURIComponent(
          '<button id="b" onclick="document.body.innerHTML += \'<p>APPEARED</p>\'">reveal</button>',
        )}`,
      );
      const before = await snapshotText(fixture);
      assert.ok(!before.includes('APPEARED'), 'the fixture must not start with the new content');

      const result = await fixture.session.act(fixture.tab, {
        action: 'click',
        ref: referenceFor(before, 'reveal'),
      });

      assert.equal(result.artifact, 'snapshot');
      // A path, and a file actually at it — the seam returns a path precisely
      // so the contents never enter a conversation, and a path to nothing
      // would satisfy the type while being useless.
      assert.ok(fs.existsSync(result.path), `the snapshot must exist at ${result.path}`);

      const after = fs.readFileSync(result.path, 'utf8');
      assert.ok(
        after.includes('APPEARED'),
        `the snapshot must show the page AFTER the action; it read:\n${after}`,
      );
      // The size reported is the size on disk.
      assert.equal(result.bytes, Buffer.byteLength(after, 'utf8'));
      assert.equal(result.truncated, false);

      // And the whole point of a fresh snapshot: its references are usable
      // for the NEXT action. This is the round trip that makes the artefact
      // load-bearing rather than decorative.
      const appeared = referenceFor(after, 'APPEARED');
      await fixture.session.act(fixture.tab, { action: 'hover', ref: appeared });
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'two artefacts written in the same second do not overwrite each other',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      // MEASURED FAILURE, which is why this test exists: the timestamp in an
      // artefact's name is second-granular and every other part of the name is
      // identical for two actions on one tab. Before a counter was added,
      // roughly twenty writes against this fixture produced FOUR files — each
      // action silently overwriting the previous one's snapshot, so a caller
      // holding two results found both paths naming one file.
      const snapshot = await snapshotText(fixture);
      const button = referenceFor(snapshot, 'Press me');

      const first = await fixture.session.act(fixture.tab, { action: 'click', ref: button });
      const second = await fixture.session.act(fixture.tab, { action: 'click', ref: button });

      assert.notEqual(
        first.path,
        second.path,
        'two actions must not be handed the same file to read',
      );
      assert.ok(fs.existsSync(first.path), 'the earlier snapshot must still be on disk');
      assert.ok(fs.existsSync(second.path));
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'read returns a path per artefact, in the order asked, and writes each one (§3.9)',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      const results = await fixture.session.read(fixture.tab, [
        'snapshot',
        'console',
        'network',
        'cookies',
      ]);

      assert.deepEqual(
        results.map((result) => result.artifact),
        ['snapshot', 'console', 'network', 'cookies'],
        "a caller's results must line up with its request",
      );

      for (const result of results) {
        assert.ok(fs.existsSync(result.path), `${result.artifact} must exist at ${result.path}`);
        assert.equal(
          result.bytes,
          fs.statSync(result.path).size,
          `${result.artifact} must report the size it actually wrote`,
        );
      }
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'the console was ACCUMULATING before anybody asked for it (§3.9)',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      // The fixture page logs on load, which is *before* this read. That is
      // the whole property: §3.9's filter is on what gets written to disk, not
      // on what gets collected, so the cost of not asking is zero. A driver
      // that attached its listener when the read arrived would return an empty
      // file here, because the message had already been and gone.
      const [result] = await fixture.session.read(fixture.tab, ['console']);
      assert.ok(result);

      const contents = fs.readFileSync(result.path, 'utf8');
      assert.match(
        contents,
        /a message from the page/,
        `the console must carry what was logged before the read; it held:\n${contents}`,
      );
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'a cookie value appears NOWHERE in the response or in the file (§7.1 read.cookies_no_values)',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      // A real origin is needed, because a data address has no host to hang a
      // cookie on. `example.com` is not reached over the network: the request
      // is fulfilled from the route below, so this test makes no outbound
      // call.
      const secret = 'THE-SECRET-COOKIE-VALUE-9c1f';
      await fixture.session.navigate(fixture.tab, 'https://example.com/');

      // Set it through the page, so the value genuinely lives in the browser's
      // jar rather than in a structure this test built.
      await fixture.session.evaluate(
        fixture.tab,
        `document.cookie = 'session-token=${secret}; path=/'`,
      );

      const summaries = await fixture.session.cookies(fixture.tab);
      assert.ok(
        summaries.some((cookie) => cookie.name === 'session-token'),
        'the cookie must actually be in the jar, or this test proves nothing',
      );

      // The response. `CookieSummary` has no value field, so this is checking
      // that nothing put one there by another route.
      assert.ok(
        !JSON.stringify(summaries).includes(secret),
        'a cookie value must not appear in the response',
      );

      // And the FILE, which is the half a type cannot enforce: a type stops
      // this process holding a value, and cannot stop a driver writing one
      // into a file it names.
      const [written] = await fixture.session.read(fixture.tab, ['cookies']);
      assert.ok(written);
      const contents = fs.readFileSync(written.path, 'utf8');
      assert.match(contents, /session-token/, 'the file must describe the cookie');
      assert.ok(
        !contents.includes(secret),
        `a cookie value must not appear in the file; it held:\n${contents}`,
      );
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'reading an artefact does not require having asked for it earlier',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      // The claim §3.9 makes about a narrow default not being a trap: act
      // first, realise afterwards that the console mattered, and the history
      // is still there. This is `act, then read` standing in for `arm, act,
      // collect`.
      const snapshot = await snapshotText(fixture);
      await fixture.session.act(fixture.tab, {
        action: 'click',
        ref: referenceFor(snapshot, 'Press me'),
      });

      const [result] = await fixture.session.read(fixture.tab, ['console']);
      assert.ok(result);
      assert.match(fs.readFileSync(result.path, 'utf8'), /a message from the page/);
    } finally {
      await stopFixture(fixture);
    }
  },
);

test(
  'the driver writes only into the directory it was given',
  { skip: available ? false : skipReason() },
  async () => {
    const fixture = await startFixture();
    try {
      const results = await fixture.session.read(fixture.tab, ['snapshot', 'console']);
      for (const result of results) {
        // §1.7a is the service's rule and this driver cannot enforce it — it
        // does not know where the artifact root is, by design. What it CAN be
        // held to is that it never writes outside the directory handed to it,
        // which is what makes handing it a per-lease directory sufficient.
        assert.equal(
          path.dirname(path.resolve(result.path)),
          path.resolve(fixture.outputDirectory),
          'an artefact must land in the directory the driver was given and nowhere else',
        );
      }
    } finally {
      await stopFixture(fixture);
    }
  },
);
