// What an attached session learns about the page before it acts — the real
// readers behind the gate's inputs, kept apart from the session so each one
// can be run against a real page on its own.
//
// ── Why this is its own module ──────────────────────────────────────────
//
// The gate is a pure function of the facts it is handed, and the session's
// rows inject those facts through probes, because the fake relay cannot
// complete a page evaluate. That leaves one gap a table of injected facts can
// never close: **the reader that produces them**. A gate that reads
// `inputType` is only as good as the code that fills `inputType` in, and a
// reader that forgot to ask (the focused-control read once returned a tag and
// a name and nothing else) looks exactly like a clean control. So the readers
// live here, take a `Page` or a `Locator`, and are exercised against a real
// browser; the session only decides what to do with their answers.
//
// Every in-page function below is **self-contained**: it is serialised and
// run in the page, so it may reference nothing from this module, and it
// returns plain data — the decision stays on this side of the bridge.
import type { Locator, Page } from 'playwright-core';

import type { ActTarget } from '../attach/gate.ts';

/** The page's host as the gate wants it, or empty when the url has none. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ── The in-page control read ───────────────────────────────────────────────

/** What the in-page read returns for one element, as plain data. */
export interface RawControl {
  readonly tag: string;
  readonly inputType?: string;
  readonly autocomplete?: string;
  readonly editable: boolean;
  readonly inFrame: boolean;
  readonly frameUrl: string;
  readonly hasShadowRoot: boolean;
  /** Every name the element answers to: its own, its descendants', and the element under its click point's. */
  readonly names: readonly string[];
  /** `name`, `id`, `placeholder` and `aria-label` — how a site names a field. */
  readonly attrNames: readonly string[];
  readonly ariaLabel?: string;
  readonly placeholder?: string;
  /** The element's visible text, short, when it is not a field holding someone's text. */
  readonly text?: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

interface PageNode {
  tagName: string;
  type?: unknown;
  value?: unknown;
  isContentEditable?: boolean;
  innerText?: string;
  shadowRoot?: unknown;
  ownerDocument: PageDocument;
  options?: ArrayLike<{ value: string; label?: string; text?: string }>;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  querySelectorAll(selector: string): ArrayLike<PageNode>;
  closest(selector: string): PageNode | null;
}

interface PageDocument {
  location: { href: string };
  defaultView: { top: unknown } | null;
  elementFromPoint(x: number, y: number): PageNode | null;
}

/**
 * The one in-page read of a control. `type` is read as the **property**
 * (the browser's own normalised answer, so `type=" PASSWORD"` is whatever the
 * browser really treats it as) and `autocomplete` as the attribute, verbatim;
 * names are gathered from the element, everything under it, and the element
 * that sits at its click point — a click lands on the pixel, not on the ref.
 */
export const READ_CONTROL = (element: unknown): RawControl => {
  const node = element as PageNode;
  const doc = node.ownerDocument;
  const tag = node.tagName.toLowerCase();
  const inputType = typeof node.type === 'string' ? node.type.toLowerCase() : undefined;
  const textTypes = ['text', 'search', 'email', 'url', 'tel', 'number'];
  const editable =
    node.isContentEditable === true ||
    tag === 'textarea' ||
    (tag === 'input' && textTypes.includes(inputType ?? ''));

  const names: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || names.length >= 80) return;
    const trimmed = value.trim();
    if (trimmed !== '') names.push(trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed);
  };
  const own = (n: PageNode): void => {
    add(n.getAttribute('aria-label'));
    add(n.getAttribute('title'));
    add(n.getAttribute('alt'));
    if (n.tagName.toLowerCase() === 'input') {
      const kind = typeof n.type === 'string' ? n.type.toLowerCase() : '';
      if (kind === 'submit' || kind === 'button' || kind === 'reset' || kind === 'image') {
        add(n.value);
      }
    }
  };

  // A `<select>`'s text is every option it offers, not what the control is
  // called: its options are read separately, and the one chosen is what the
  // `select` verb is judged on.
  own(node);
  if (!editable && tag !== 'select') add(node.innerText);
  const below = node.querySelectorAll('*');
  for (let i = 0; i < below.length && i < 300; i += 1) {
    const child = below[i];
    if (child !== undefined) own(child);
  }

  // The element a click at this one's centre would land on. A wrapper with
  // no name of its own is clicked at its middle, which is the button inside
  // it — or an overlay laid over it, or a frame.
  let covered = false;
  const box = node.getBoundingClientRect();
  if (box.width > 0 && box.height > 0) {
    const hit = doc.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (hit !== null && hit !== node) {
      const hitTag = hit.tagName.toLowerCase();
      if (hitTag === 'iframe' || hitTag === 'frame') covered = true;
      own(hit);
      if (hitTag !== 'input' && hitTag !== 'textarea') add(hit.innerText);
      const holder = hit.closest(
        'button, a, [role="button"], [role="link"], [role="menuitem"], input[type="submit"], input[type="button"]',
      );
      if (holder !== null && holder !== hit) {
        own(holder);
        add(holder.innerText);
      }
    }
  }

  const attrNames: string[] = [];
  for (const attribute of ['name', 'id', 'placeholder', 'aria-label']) {
    const value = node.getAttribute(attribute);
    if (value !== null && value.trim() !== '') attrNames.push(value.trim().slice(0, 200));
  }

  let options: { value: string; label: string }[] | undefined;
  if (tag === 'select' && node.options !== undefined) {
    options = [];
    for (let i = 0; i < node.options.length && i < 200; i += 1) {
      const option = node.options[i];
      if (option !== undefined) {
        options.push({
          value: option.value,
          label: (option.label ?? option.text ?? '').trim().slice(0, 200),
        });
      }
    }
  }

  const view = doc.defaultView;
  const text =
    !editable && tag !== 'select' && typeof node.innerText === 'string'
      ? node.innerText.trim()
      : '';
  const ariaLabel = node.getAttribute('aria-label');
  const placeholder = node.getAttribute('placeholder');
  return {
    tag: covered ? 'iframe' : tag,
    ...(inputType === undefined ? {} : { inputType }),
    ...(node.getAttribute('autocomplete') === null
      ? {}
      : { autocomplete: node.getAttribute('autocomplete') as string }),
    editable,
    inFrame: view !== null && view !== view.top,
    frameUrl: doc.location.href,
    hasShadowRoot: node.shadowRoot !== null && node.shadowRoot !== undefined,
    names,
    attrNames,
    ...(ariaLabel === null ? {} : { ariaLabel }),
    ...(placeholder === null ? {} : { placeholder }),
    ...(text === '' ? {} : { text: text.slice(0, 80) }),
    ...(options === undefined ? {} : { options }),
  };
};

// ── The snapshot's view of the same control ────────────────────────────────

/** What the page snapshot says about one ref: its role, its name, and every text under it. */
export interface SnapshotControl {
  readonly role?: string;
  readonly name?: string;
  /** The `: text` tail of the control's own line — the whole name of a clickable `div`. */
  readonly ownText?: string;
  /** The names and texts of the control and everything beneath it, in order. */
  readonly texts: readonly string[];
}

interface ParsedLine {
  readonly indent: number;
  readonly role?: string;
  readonly name?: string;
  readonly tail?: string;
  readonly refs: readonly string[];
}

// Roles whose `: tail` is the value someone typed, not a name: a message box
// that reads "please send" is not a control called Send.
const VALUE_ROLES: readonly string[] = ['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'];

function unquote(text: string): string {
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length > 1 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function parseSnapshotLine(line: string): ParsedLine | undefined {
  const lead = /^(\s*)-\s+(.*)$/.exec(line);
  if (lead === null) return undefined;
  const indent = (lead[1] ?? '').length;
  const rest = lead[2] ?? '';
  const roleMatch = /^([A-Za-z][\w-]*)/.exec(rest);
  if (roleMatch === null) return { indent, refs: [] };
  let cursor = roleMatch[0].length;
  const role = (roleMatch[1] ?? '').toLowerCase();

  let name: string | undefined;
  const quoted = /^\s*"((?:[^"\\]|\\.)*)"/.exec(rest.slice(cursor));
  if (quoted !== null) {
    name = unquote(`"${quoted[1] ?? ''}"`);
    cursor += quoted[0].length;
  }
  const attributes = /^(?:\s*\[[^\]]*\])*/.exec(rest.slice(cursor));
  const attributeText = attributes?.[0] ?? '';
  cursor += attributeText.length;
  const refs = [...attributeText.matchAll(/\[ref=([^\]]+)\]/g)].map((m) => m[1] ?? '');

  let tail: string | undefined;
  const colon = /^\s*:(?:\s(.*))?$/.exec(rest.slice(cursor));
  if (colon !== null && colon[1] !== undefined && colon[1].trim() !== '') {
    tail = unquote(colon[1].trim());
  }
  return {
    indent,
    role,
    refs,
    ...(name === undefined ? {} : { name }),
    ...(tail === undefined ? {} : { tail }),
  };
}

/**
 * One ref's line and everything nested under it, out of a whole-page
 * snapshot. **One snapshot serves every ref of a call**: the library
 * resolves a ref against the *last* snapshot taken in that frame, and a
 * snapshot of one element becomes that frame's whole ref map, holding only the element's subtree, so
 * reading the second ref of a drag or a form after the first would find it
 * gone. The ref is matched in the line's **attribute** position only — text
 * a page puts on the screen that happens to read `[ref=e7]` names nothing.
 */
export function readSnapshotControl(snapshot: string, ref: string): SnapshotControl | undefined {
  const lines = snapshot.split('\n');
  let start = -1;
  let head: ParsedLine | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseSnapshotLine(lines[i] ?? '');
    if (parsed?.refs.includes(ref)) {
      start = i;
      head = parsed;
      break;
    }
  }
  if (head === undefined) return undefined;

  const valueRole = head.role !== undefined && VALUE_ROLES.includes(head.role);
  const texts: string[] = [];
  const take = (parsed: ParsedLine, ownValue: boolean): void => {
    if (parsed.name !== undefined) texts.push(parsed.name);
    if (parsed.tail !== undefined && !ownValue) texts.push(parsed.tail);
  };
  take(head, valueRole);
  // A list box or combo box holds options, which are what it offers rather
  // than what it is called; the `select` verb is judged on the option chosen.
  const holdsOptions = head.role === 'combobox' || head.role === 'listbox';
  for (let i = start + 1; !holdsOptions && i < lines.length; i += 1) {
    const parsed = parseSnapshotLine(lines[i] ?? '');
    if (parsed === undefined) continue;
    if (parsed.indent <= head.indent) break;
    take(parsed, parsed.role !== undefined && VALUE_ROLES.includes(parsed.role));
  }
  return {
    ...(head.role === undefined ? {} : { role: head.role }),
    ...(head.name === undefined ? {} : { name: head.name }),
    ...(head.tail === undefined || valueRole ? {} : { ownText: head.tail }),
    texts,
  };
}

// ── Facts for the gate ─────────────────────────────────────────────────────

/** The gate's view of one control: the in-page read, joined with what the snapshot says. */
export function controlFacts(raw: RawControl, snap?: SnapshotControl): ActTarget {
  const accessibleName =
    snap?.name ?? snap?.ownText ?? raw.ariaLabel ?? raw.placeholder ?? raw.text;
  const names = [...new Set([...raw.names, ...(snap?.texts ?? [])])].slice(0, 60);
  const role =
    snap?.role ??
    (raw.editable && raw.tag !== 'input' && raw.tag !== 'textarea' ? 'textbox' : undefined);
  return {
    tag: raw.tag,
    ...(accessibleName === undefined || accessibleName === '' ? {} : { accessibleName }),
    ...(role === undefined ? {} : { role }),
    ...(raw.autocomplete === undefined || raw.autocomplete === ''
      ? {}
      : { autocomplete: raw.autocomplete }),
    ...(raw.inputType === undefined ? {} : { inputType: raw.inputType }),
    ...(raw.editable ? { editable: true } : {}),
    ...(names.length === 0 ? {} : { names }),
    ...(raw.attrNames.length === 0 ? {} : { attrNames: raw.attrNames }),
    ...(raw.inFrame ? { frameHost: hostOf(raw.frameUrl) } : {}),
    ...(raw.options === undefined ? {} : { options: raw.options }),
  };
}

/** One named ref's facts: the control read in the page, and its line in the page snapshot. */
export async function readControlFacts(
  locator: Locator,
  snapshot?: string,
  ref?: string,
): Promise<ActTarget> {
  const raw = await locator.evaluate(READ_CONTROL);
  const snap =
    snapshot === undefined || ref === undefined ? undefined : readSnapshotControl(snapshot, ref);
  return controlFacts(raw, snap);
}

/**
 * What a `press` that names no ref reaches: the focused control's facts, or
 * `null` when the read cannot say. **The same read a named ref gets**, so
 * the focused control's type and `autocomplete` are known to the gate and a
 * password box with the cursor in it is a password box. A frame or an open
 * shadow host answers `null`: the control that matters is behind a boundary
 * this read cannot enter. Nothing focused, or the page itself, answers a
 * plain non-control.
 */
export async function readFocusedControl(page: Page): Promise<ActTarget | null> {
  const handle = await page.evaluateHandle(
    () =>
      (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement,
  );
  try {
    const element = handle.asElement();
    if (element === null) return { tag: 'body' };
    const raw = await element.evaluate(READ_CONTROL);
    if (raw.tag === 'iframe' || raw.tag === 'frame' || raw.hasShadowRoot) return null;
    if (raw.tag === 'body' || raw.tag === 'html') return { tag: 'body' };
    return controlFacts(raw);
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

// ── The page's secret fields ───────────────────────────────────────────────

/**
 * The page's own secret fields. **This token list mirrors `gate.fieldKind`'s**
 * — the field gate reads a control's own attributes, this scan reads the
 * page, and a token named in one and not the other is a page whose submit
 * passes the "any submit over a card page" rule while its expiry field sat
 * there unnamed. A test pins the mirror so it cannot drift quietly.
 *
 * `~=` matches a **whitespace-separated token**, because `autocomplete` is a
 * list (`billing cc-number`, `section-pay cc-csc`) and the gate reads it as
 * one; an exact-match selector would call those pages clean.
 */
export const SECRET_FIELD_SELECTOR =
  'input[type="password" i], input[autocomplete~="password" i], input[autocomplete~="current-password" i], ' +
  'input[autocomplete~="new-password" i], input[autocomplete~="one-time-code" i], ' +
  'input[autocomplete~="cc-number" i], input[autocomplete~="cc-exp" i], input[autocomplete~="cc-exp-month" i], ' +
  'input[autocomplete~="cc-exp-year" i], input[autocomplete~="cc-csc" i]';

interface ScanRoot {
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): ArrayLike<{
    tagName: string;
    shadowRoot?: ScanRoot | null;
    contentDocument?: ScanRoot | null;
  }>;
}

/**
 * Whether the page holds a secret field — through open shadow roots and
 * same-origin frames too. **A frame the scan cannot enter counts as holding
 * one**: a cross-origin frame is where a payment widget lives, and a page
 * that cannot rule a field out cannot be submitted through. A page that will
 * not answer at all counts the same way.
 */
export async function scanSecretField(page: Page): Promise<boolean> {
  try {
    return await page.evaluate((selector: string) => {
      const found = (root: ScanRoot): boolean => {
        if (root.querySelector(selector) !== null) return true;
        const all = root.querySelectorAll('*');
        for (let i = 0; i < all.length; i += 1) {
          const el = all[i];
          if (el === undefined) continue;
          if (el.shadowRoot !== null && el.shadowRoot !== undefined && found(el.shadowRoot)) {
            return true;
          }
          const kind = el.tagName.toLowerCase();
          if (kind === 'iframe' || kind === 'frame') {
            const inner = el.contentDocument;
            if (inner === null || inner === undefined) return true;
            if (found(inner)) return true;
          }
        }
        return false;
      };
      return found((globalThis as unknown as { document: ScanRoot }).document);
    }, SECRET_FIELD_SELECTOR);
  } catch {
    return true;
  }
}
