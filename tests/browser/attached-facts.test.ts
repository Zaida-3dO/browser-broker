import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium, type Browser, type Page } from 'playwright-core';

import { decide } from '../../src/attach/gate.ts';
import {
  SECRET_FIELD_SELECTOR,
  controlFacts,
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
