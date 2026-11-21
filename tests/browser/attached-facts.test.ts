import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium, type Browser, type Locator, type Page } from 'playwright-core';

import { decide } from '../../src/attach/gate.ts';
import { releaseHeldModifiers } from '../../src/browser/attached.ts';
import {
  SECRET_FIELD_SELECTOR,
  controlFacts,
  holdsFocus,
  readControlFacts,
  readFocusedControl,
  readSnapshotControl,
  scanSecretField,
  type RawControl,
} from '../../src/browser/attached-facts.ts';
import { browserAvailable, skipReason } from '../helpers/browser.ts';

/**
 * The readers behind the gate's inputs, run against **real pages**.
 *
 * `attached.test.ts` proves the gate and the session's wiring through
 * injected facts, because the fake relay cannot complete a page evaluate.
 * That leaves the reader itself — the code that fills in `inputType`,
 * `autocomplete`, the names and the frame — untested by anything that can
 * see a page, and a reader that forgets to ask looks exactly like a clean
 * control. These rows are the other half: a real page, the real reader, and
 * then the gate's own verdict on what the reader returned.
 *
 * The snapshot parser is pure and runs everywhere; the page rows need a
 * browser and say so when they cannot run.
 */

const available = browserAvailable();
const SITES = ['example.com'] as const;

/** The gate's verdict on a control's facts, for one verb, as the session would ask it. */
function verdict(
  verb: 'click' | 'type' | 'press' | 'fill',
  target: ReturnType<typeof controlFacts>,
  value?: string,
): string {
  return decide({
    siteHost: 'example.com',
    verb,
    target,
    ...(value === undefined ? {} : { value }),
    pageHasSecretField: false,
    actSites: SITES,
  }).decision;
}

async function withPage(
  html: string,
  body: (page: Page, browser: Browser) => Promise<void>,
): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    await body(page, browser);
  } finally {
    await browser.close();
  }
}

/**
 * The two steps the session's performer takes before any key, mirrored
 * here because the fake relay cannot complete this read: focus, then one
 * in-page proof that the control **is** the deep active element. `false`
 * means no key is ever sent.
 */
async function focusTakes(locator: Locator): Promise<boolean> {
  try {
    await locator.focus();
    return await holdsFocus(locator);
  } catch {
    return false;
  }
}

async function refOf(page: Page, pattern: RegExp): Promise<{ ref: string; snapshot: string }> {
  const snapshot = await page.locator('html').ariaSnapshot({ mode: 'ai' });
  const line = snapshot.split('\n').find((l) => pattern.test(l));
  assert.ok(line, `no snapshot line matches ${String(pattern)} in:\n${snapshot}`);
  const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1];
  assert.ok(ref, `no ref on: ${line}`);
  return { ref, snapshot };
}

// ── the snapshot parser: pure ──────────────────────────────────────────────

const SNAPSHOT = [
  '- generic [active] [ref=e1]:',
  '  - button "Pay now" [ref=e2] [cursor=pointer]',
  '  - generic [ref=e3] [cursor=pointer]: Place order',
  '  - generic [ref=e4]:',
  '    - generic [ref=e5]:',
  '      - text: Complete purchase',
  '    - button "Go" [ref=e6]',
  '  - textbox "Message" [ref=e7]: please send it now',
  '  - generic [ref=e8] [cursor=pointer]: "Say \\"hi\\" and pay"',
  '  - paragraph [ref=e9]: the literal text [ref=e2] on the screen',
  '  - link "Next" [ref=e10]:',
  '    - /url: https://example.com/next',
  '    - img "Delete everything" [ref=e11]',
].join('\n');

test('the snapshot parser: a quoted name is the name', () => {
  assert.deepEqual(readSnapshotControl(SNAPSHOT, 'e2'), {
    role: 'button',
    name: 'Pay now',
    texts: ['Pay now'],
  });
});

test('the snapshot parser: a clickable div named only by its tail text is named by it (H2)', () => {
  const found = readSnapshotControl(SNAPSHOT, 'e3');
  assert.equal(found?.name, undefined);
  assert.equal(found?.ownText, 'Place order');
  assert.deepEqual(found?.texts, ['Place order']);
});

test('the snapshot parser: a wrapper carries the names of everything beneath it, and stops at its sibling', () => {
  const found = readSnapshotControl(SNAPSHOT, 'e4');
  assert.deepEqual(found?.texts, ['Complete purchase', 'Go']);
  assert.ok(!found?.texts.includes('Pay now'), 'a sibling is not a descendant');
});

test('the snapshot parser: the tail of a text box is what someone typed, never its name', () => {
  const found = readSnapshotControl(SNAPSHOT, 'e7');
  assert.equal(found?.name, 'Message');
  assert.equal(found?.ownText, undefined);
  assert.deepEqual(found?.texts, ['Message']);
});

test('the snapshot parser: a name with quotes inside reads whole, not as the fragment between them', () => {
  const found = readSnapshotControl(SNAPSHOT, 'e8');
  assert.equal(found?.ownText, 'Say "hi" and pay');
});

test('the snapshot parser: text on the screen that spells a ref does not name that ref', () => {
  // `e9`'s line prints "[ref=e2]" as its text; only an attribute is a ref.
  assert.equal(readSnapshotControl(SNAPSHOT, 'e2')?.name, 'Pay now');
});

test('the snapshot parser: a link reads its children but not its url line, and an unknown ref reads nothing', () => {
  assert.deepEqual(readSnapshotControl(SNAPSHOT, 'e10')?.texts, ['Next', 'Delete everything']);
  assert.equal(readSnapshotControl(SNAPSHOT, 'e99'), undefined);
});

test('controlFacts: the same raw read decides differently with and without its snapshot line', () => {
  const raw: RawControl = {
    tag: 'div',
    editable: false,
    inFrame: false,
    frameUrl: 'https://example.com/',
    hasShadowRoot: false,
    names: [],
    attrNames: [],
  };
  assert.equal(verdict('click', controlFacts(raw)), 'allow');
  assert.equal(
    verdict('click', controlFacts(raw, readSnapshotControl(SNAPSHOT, 'e3'))),
    'attached.needs_owner',
  );
});

// ── the readers, against real pages ────────────────────────────────────────

test(
  'B1: the focused-control read carries type and autocomplete, so a password box holding the cursor is a password box',
  { skip: available ? false : skipReason() },
  async () => {
    await withPage(
      `<input id="u" type="text" autocomplete="username">
       <input id="p" type="password" autocomplete="current-password">
       <input id="o" type="text" autocomplete="one-time-code">
       <input id="c" type="text" autocomplete="billing cc-number">`,
      async (page) => {
        for (const [id, kind] of [
          ['p', 'password'],
          ['o', 'one-time-code'],
          ['c', 'card'],
        ] as const) {
          await page.locator(`#${id}`).focus();
          const facts = await readFocusedControl(page);
          assert.ok(facts !== null, `${id} is readable`);
          assert.ok(facts.inputType !== undefined, 'the type was read');
          for (const key of ['h', 'Enter']) {
            const answer = decide({
              siteHost: 'example.com',
              verb: 'press',
              value: key,
              focusedControl: facts,
              pageHasSecretField: false,
              actSites: SITES,
            });
            if (answer.decision === 'allow') assert.fail(`${key} into ${kind} was allowed`);
            assert.equal(answer.decision, 'attached.field_forbidden', `${key} into ${kind}`);
            assert.ok(answer.message.includes(kind), 'the refusal names the kind');
          }
        }
        await page.locator('#u').focus();
        const text = await readFocusedControl(page);
        assert.equal(text?.inputType, 'text');
        assert.equal(text?.autocomplete, 'username');
        assert.equal(text?.editable, true);
      },
    );
  },
);

test(
  'B1: nothing focused, a frame focused and an open shadow host each answer as the focus read always has',
  { skip: available ? false : skipReason() },
  async () => {
    await withPage(
      `<iframe id="f" srcdoc="<input id=i>"></iframe><div id="h"></div>
       <script>document.getElementById('h').attachShadow({mode:'open'}).innerHTML='<input id=s>'</script>`,
      async (page) => {
        assert.deepEqual(await readFocusedControl(page), { tag: 'body' });
        await page.locator('#f').focus();
        assert.equal(await readFocusedControl(page), null, 'a frame hides what it holds');
        await page.evaluate(() => {
          const scope = globalThis as unknown as {
            document: {
              getElementById(id: string): {
                shadowRoot: { getElementById(i: string): { focus(): void } };
              };
            };
          };
          scope.document.getElementById('h').shadowRoot.getElementById('s').focus();
        });
        assert.equal(await readFocusedControl(page), null, 'a shadow host hides what it holds');
      },
    );
  },
);

test(
  'B1/B2 (other door): a ref that cannot take focus is stopped before any key — the keys never reach the password box or the body',
  { skip: available ? false : skipReason() },
  async () => {
    // The gate judges the **named** control; `pressSequentially` and
    // `locator.press` only *try* to focus it, and an element that cannot
    // take focus takes no keys — they go to whatever holds focus. The
    // performer's answer is one focus call and one fixed read: was the
    // control the deep active element before the first key? The setups
    // below are the four bypass shapes probed against real Chromium; each
    // asserts the decision half **and** the physical half: the password
    // box's value and the body's key log stay empty.
    await withPage(
      `<form onsubmit="window.__submitted = (window.__submitted || 0) + 1">
         <p id="welcome">Welcome back</p>
         <input id="user" type="text" autocomplete="username">
         <input id="pass" type="password" autocomplete="current-password">
         <input id="search" type="text" aria-label="Search" disabled>
       </form>`,
      async (page) => {
        const snapshot = await page.locator('html').ariaSnapshot({ mode: 'ai' });
        const refLine = (pattern: RegExp): string => {
          const line = snapshot.split('\n').find((l) => pattern.test(l));
          const ref = /\[ref=([^\]]+)\]/.exec(line ?? '')?.[1];
          assert.ok(ref, `no ref matches ${String(pattern)}`);
          return ref;
        };

        await page.locator('#pass').focus();

        // 1. A paragraph ref typed into a focused password field: the gate
        //    refuses the type outright (a paragraph is not editable text),
        //    and the focus proof says it cold as well.
        const welcome = await readControlFacts(
          page.locator('#welcome'),
          snapshot,
          refLine(/Welcome back/),
        );
        assert.equal(verdict('type', welcome, 'hunter2'), 'attached.needs_owner');
        assert.equal(
          await focusTakes(page.locator('#welcome')),
          false,
          'a paragraph takes no focus',
        );
        assert.equal(
          await page.locator('#pass').inputValue(),
          '',
          'nothing typed into the password box',
        );

        // 2 and 3. A disabled text input: its read says editable text, so
        //    the gate allows — the physical proof is what stops it.
        const search = await readControlFacts(page.locator('#search'), snapshot, refLine(/Search/));
        assert.equal(verdict('type', search, 'abc'), 'allow', 'the gate reads it as a text box');
        assert.equal(verdict('press', search, 'h'), 'allow');
        assert.equal(
          await focusTakes(page.locator('#search')),
          false,
          'a disabled input never holds focus',
        );
        assert.equal(
          await page.locator('#pass').inputValue(),
          '',
          'no key reached the password box',
        );

        // The control that *can* take focus: the honest positive half.
        assert.equal(await focusTakes(page.locator('#user')), true);
        await page.locator('#user').pressSequentially('hi');
        assert.equal(await page.locator('#user').inputValue(), 'hi');
        assert.equal(
          await page.locator('#pass').inputValue(),
          '',
          'the password box stayed empty throughout',
        );
      },
    );

    // 4. Nothing focused on a page with body shortcuts: a type at a
    //    paragraph is the site's shortcut language, not typing.
    await withPage(
      `<p id="note">Inbox</p>
       <script>
         window.__keys = '';
         document.body.addEventListener('keydown', (event) => {
           window.__keys += event.key;
         });
       </script>`,
      async (page) => {
        const snapshot = await page.locator('html').ariaSnapshot({ mode: 'ai' });
        const ref = /\[ref=([^\]]+)\]/.exec(
          snapshot.split('\n').find((l) => /Inbox/.test(l)) ?? '',
        )?.[1];
        assert.ok(ref, 'the paragraph has a ref');
        const note = await readControlFacts(page.locator('#note'), snapshot, ref);
        assert.equal(verdict('type', note, '#e'), 'attached.needs_owner');
        assert.equal(
          await focusTakes(page.locator('#note')),
          false,
          'a paragraph takes no focus, so the shortcut never fires',
        );
        assert.equal(
          await page.evaluate(() => (globalThis as unknown as { __keys: string }).__keys),
          '',
        );
      },
    );
  },
);

test(
  'the focus proof: the deep active element answers true — plain and through an open shadow root — and false for a frame holder or an unfocused control',
  { skip: available ? false : skipReason() },
  async () => {
    await withPage(
      `<input id="plain" type="text">
       <div id="host"></div>
       <iframe id="f" srcdoc="<input id=inner>"></iframe>`,
      async (page) => {
        await page.evaluate(() => {
          const scope = globalThis as unknown as {
            document: {
              getElementById(id: string): {
                attachShadow(options: { mode: string }): { innerHTML: string };
              };
            };
          };
          scope.document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
            '<input id="deep" type="text">';
        });

        await page.locator('#plain').focus();
        assert.equal(await holdsFocus(page.locator('#plain')), true, 'plain focus answers true');
        assert.equal(
          await holdsFocus(page.locator('#host')),
          false,
          'an unfocused control answers false',
        );

        await page.evaluate(() => {
          const scope = globalThis as unknown as {
            document: {
              getElementById(id: string): {
                shadowRoot: { getElementById(id: string): { focus(): void } };
              };
            };
          };
          scope.document.getElementById('host').shadowRoot.getElementById('deep').focus();
        });
        assert.equal(
          await holdsFocus(page.locator('#host #deep')),
          true,
          'focus inside an open shadow root is still the deep active element',
        );
        assert.equal(await holdsFocus(page.locator('#plain')), false, 'the plain box lost it');

        // Focus inside the frame: a main-frame control is not the deep
        // active element, because the chain walked *into* the frame — and
        // the focused control inside the frame, read in its own frame,
        // answers true.
        await page.locator('#f').contentFrame().locator('#inner').focus();
        assert.equal(await holdsFocus(page.locator('#plain')), false);
        assert.equal(await holdsFocus(page.locator('#f').contentFrame().locator('#inner')), true);
      },
    );
  },
);

test(
  'H2: a clickable div, a wrapper, a button labelled one thing and drawn another — each reads as what it does',
  { skip: available ? false : skipReason() },
  async () => {
    await withPage(
      `<div id="d" style="cursor:pointer" onclick="0">Place order</div>
       <div id="w"><button>Pay now</button></div>
       <button id="l" aria-label="Continue">Pay £500</button>
       <button id="t" title="Delete everything">x</button>
       <button id="ok">Next</button>
       <div id="plain"><button>Read more</button></div>`,
      async (page) => {
        const { ref, snapshot } = await refOf(page, /Place order/);
        const div = await readControlFacts(page.locator('#d'), snapshot, ref);
        assert.equal(div.accessibleName, 'Place order', 'the unquoted tail is the name');
        assert.equal(verdict('click', div), 'attached.needs_owner');

        for (const id of ['w', 'l', 't']) {
          const facts = await readControlFacts(page.locator(`#${id}`));
          assert.equal(verdict('click', facts), 'attached.needs_owner', `#${id}`);
        }
        for (const id of ['ok', 'plain']) {
          const facts = await readControlFacts(page.locator(`#${id}`));
          assert.equal(verdict('click', facts), 'allow', `#${id} is ordinary`);
        }
      },
    );
  },
);

test(
  "M5: reading one ref's facts leaves the next ref resolvable — one page snapshot serves a drag or a form",
  { skip: available ? false : skipReason() },
  async () => {
    await withPage(
      `<button id="a">Alpha</button><button id="b">Beta</button><input id="c" aria-label="Gamma">`,
      async (page) => {
        const snapshot = await page.locator('html').ariaSnapshot({ mode: 'ai' });
        const refs = ['Alpha', 'Beta', 'Gamma'].map((name) => {
          const line = snapshot.split('\n').find((l) => l.includes(`"${name}"`));
          return /\[ref=([^\]]+)\]/.exec(line ?? '')?.[1] as string;
        });
        assert.ok(refs.every((r) => typeof r === 'string'));
        const names: (string | undefined)[] = [];
        for (const ref of refs) {
          const locator = page.locator(`aria-ref=${ref}`);
          assert.equal(await locator.count(), 1, `${ref} still resolves before its read`);
          names.push((await readControlFacts(locator, snapshot, ref)).accessibleName);
        }
        assert.deepEqual(names, ['Alpha', 'Beta', 'Gamma']);
      },
    );
  },
);

test(
  "M1: a control inside a frame carries the frame's host, and a click that lands on the frame is read as a frame",
  { skip: available ? false : skipReason() },
  async () => {
    const browser = await chromium.launch({ headless: false });
    try {
      const page = await browser.newPage();
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        const body =
          url.hostname === '127.0.0.1'
            ? '<button id="b">Continue</button>'
            : '<button id="top">Top</button><iframe id="f" src="http://127.0.0.1:9/inner" width="300" height="100"></iframe>';
        return route.fulfill({ contentType: 'text/html', body });
      });
      await page.goto('https://example.com/page');
      await page.frameLocator('#f').locator('#b').waitFor();

      const inner = await readControlFacts(page.frameLocator('#f').locator('#b'));
      assert.equal(inner.frameHost, '127.0.0.1');
      assert.equal(verdict('click', inner), 'attached.act_site_off_list');

      const top = await readControlFacts(page.locator('#top'));
      assert.equal(top.frameHost, undefined);
      assert.equal(verdict('click', top), 'allow');

      const frameElement = await readControlFacts(page.locator('#f'));
      assert.equal(frameElement.tag, 'iframe');
      assert.equal(verdict('click', frameElement), 'attached.field_forbidden');
    } finally {
      await browser.close();
    }
  },
);

test(
  'H1/select: the options the control offers are read, so the one chosen can be named',
  { skip: available ? false : skipReason() },
  async () => {
    await withPage(
      `<select id="s" aria-label="Actions"><option value="a">Rename</option><option value="b">Delete account</option></select>`,
      async (page) => {
        const facts = await readControlFacts(page.locator('#s'));
        assert.equal(verdict('click', facts), 'allow');
        assert.equal(
          decide({
            siteHost: 'example.com',
            verb: 'select',
            target: facts,
            value: 'b',
            pageHasSecretField: false,
            actSites: SITES,
          }).decision,
          'attached.needs_owner',
          'the label of the option chosen by value',
        );
      },
    );
  },
);

test(
  'M3: the secret scan matches a token of a list, and looks through shadow roots and frames',
  { skip: available ? false : skipReason() },
  async () => {
    const pages: [string, boolean][] = [
      ['<input autocomplete="off"><button>Go</button>', false],
      ['<input type="password">', true],
      ['<input type="PASSWORD">', true],
      ['<input autocomplete="billing cc-number">', true],
      ['<input autocomplete="section-pay cc-csc">', true],
      ['<input autocomplete="username webauthn current-password">', true],
      [
        `<div id="h"></div><script>document.getElementById('h').attachShadow({mode:'open'}).innerHTML='<input type=password>'</script>`,
        true,
      ],
      [`<iframe srcdoc="<input type=password>"></iframe>`, true],
      [`<iframe srcdoc="<p>nothing</p>"></iframe>`, false],
      [`<iframe src="data:text/html,<p>x</p>"></iframe>`, true],
    ];
    for (const [html, expected] of pages) {
      await withPage(html, async (page) => {
        await page.waitForLoadState('load');
        assert.equal(await scanSecretField(page), expected, html);
      });
    }
  },
);

test('M3: the scan names every secret token with the list-token operator', () => {
  for (const token of [
    'password',
    'current-password',
    'new-password',
    'one-time-code',
    'cc-number',
    'cc-exp',
    'cc-exp-month',
    'cc-exp-year',
    'cc-csc',
  ]) {
    assert.ok(SECRET_FIELD_SELECTOR.includes(`autocomplete~="${token}"`), token);
  }
  assert.ok(
    !SECRET_FIELD_SELECTOR.includes('autocomplete="'),
    'an exact-match autocomplete selector misses every list',
  );
});

test(
  'F2: a press that fails part-way through the key string leaves no modifier held on the page',
  { skip: available ? false : skipReason() },
  async () => {
    await withPage(`<input id="i">`, async (page) => {
      const field = page.locator(`#i`);
      await field.click();
      // The library's press holds each modifier down before it tries the
      // next token, and releases nothing when the base fails: without the
      // session-side release, Shift and Control would stay held on the page
      // for every later key. This drives the release the session's catch
      // runs, against a real keyboard.
      await assert.rejects(page.keyboard.press('Shift+Control+é'));
      await releaseHeldModifiers(page, 'Shift+Control+é');
      await page.keyboard.press('d');
      // A held Shift would have typed `D`; a held Control would have made
      // the letter a chord. What crosses is the plain key, alone.
      assert.equal(await field.inputValue(), 'd');
    });
  },
);
