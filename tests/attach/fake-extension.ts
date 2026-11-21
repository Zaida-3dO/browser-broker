// A fake Playwright Extension, driving the relay's extension side from Node.
//
// It speaks the same message shapes as the extension's background script —
// numbered requests answered, events sent bare — and keeps a call log so the
// rejection tests can assert what the browser side was **never** asked, not
// just what the caller was told.
//
// `respond` answers CDP methods inside `chrome.debugger.sendCommand` from a
// table; `unknownPolicy` decides what happens to a method the table does not
// name, which is how the harmless-noise rows (the extension answering "Not
// allowed") are exercised.

import { connectWebSocket } from '../../src/attach/ws.ts';
import type { WebSocketConnection } from '../../src/attach/ws.ts';

export interface FakeExtensionOptions {
  /** The Origin the upgrade carries; the relay only admits the extension's own. */
  origin?: string;
  /** What it reports as its protocol version on the handshake. */
  protocolVersion?: number;
  /** Answer for CDP methods not named in `respondTo`. */
  unknownPolicy?: 'empty' | 'not-allowed';
  /** CDP method → canned result (the result field of the reply). */
  respondTo?: Record<string, unknown>;
}

interface RecordedCall {
  method: string;
  params: unknown[];
}

let nextTargetSerial = 0;

export class FakeExtension {
  readonly calls: RecordedCall[] = [];
  /** The id of the most recently created tab, for tests that address it. */
  lastCreatedTabId = 0;
  /** Called for every request it receives, for wait-until assertions. */
  onCall: (() => void) | undefined;

  private readonly _ws: WebSocketConnection;
  private _requestId = 0;
  private _nextTabId = 100;
  // Chromium gives a page's main frame the *same* id as its CDP target, and a
  // real client keys its frame sessions by that; the fake keeps the pairing
  // per tab so the two answers never drift apart.
  private readonly _targetByTab = new Map<number, string>();
  private readonly _opts: FakeExtensionOptions;
  private readonly _pending = new Map<number, (result: unknown) => void>();

  private constructor(ws: WebSocketConnection, opts: FakeExtensionOptions) {
    this._ws = ws;
    this._opts = opts;
    this._ws.onMessage = (text) => this._onMessage(text);
  }

  static async connect(endpoint: string, opts: FakeExtensionOptions = {}): Promise<FakeExtension> {
    const ws = await connectWebSocket(endpoint, opts.origin ? { Origin: opts.origin } : {});
    const ext = new FakeExtension(ws, opts);
    return ext;
  }

  onceClosed(): Promise<string> {
    return this._ws.onceClosed();
  }

  /** The handshake the extension sends first; resolves when the relay is ready. */
  async initialize(): Promise<void> {
    this.sendEvent('extension.initialized', [{ protocolVersion: this._opts.protocolVersion ?? 2 }]);
    await Promise.resolve();
  }

  sendEvent(method: string, params: unknown[]): void {
    this._ws.send(JSON.stringify({ method, params }));
  }

  /** A request **from** the extension (none in the current protocol; kept for probes). */
  request(method: string, params: unknown[]): Promise<unknown> {
    const id = ++this._requestId;
    this._ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => {
      this._pending.set(id, resolve);
    });
  }

  close(reason = 'extension went away'): void {
    this._ws.close(1000, reason);
  }

  get socketClosed(): boolean {
    return this._ws.readyState === 'closed';
  }

  /** The CDP target id the fake gave a tab — which is also its main frame's id. */
  targetIdOf(tabId: number): string | undefined {
    return this._targetByTab.get(tabId);
  }

  sawCall(method: string): boolean {
    return this.calls.some((call) => call.method === method);
  }

  private _onMessage(text: string): void {
    const object = JSON.parse(text) as {
      id?: number;
      method?: string;
      params?: unknown[];
      result?: unknown;
      error?: unknown;
    };
    if (object.id !== undefined && object.method === undefined) {
      // A response to a request this fake made.
      this._pending.get(object.id)?.(object.result);
      this._pending.delete(object.id);
      return;
    }
    if (object.id === undefined) return; // relay-initiated events: none exist.
    const method = object.method as string;
    const params = object.params ?? [];
    this.calls.push({ method, params });
    this.onCall?.();
    void this._answer(object.id, method, params);
  }

  private async _answer(id: number, method: string, params: unknown[]): Promise<void> {
    try {
      const result = await this._handle(method, params);
      this._ws.send(JSON.stringify({ id, result }));
    } catch (error) {
      this._ws.send(JSON.stringify({ id, error: (error as Error).message }));
    }
  }

  private _handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'chrome.tabs.create': {
        const requested = (params[0] as { url?: string } | undefined) ?? {};
        const tab = {
          id: this._nextTabId++,
          url: requested.url ?? 'about:blank',
          title: 'Fake tab',
        };
        this.lastCreatedTabId = tab.id;
        // The extension reports its own creations exactly like user-visible ones.
        this.sendEvent('chrome.tabs.onCreated', [tab]);
        return tab;
      }
      case 'chrome.tabs.remove': {
        const tabId = params[0] as number;
        this.sendEvent('chrome.tabs.onRemoved', [tabId]);
        return null;
      }
      case 'chrome.debugger.attach':
        return null;
      case 'chrome.debugger.detach':
        return null;
      case 'chrome.debugger.sendCommand': {
        const cdpMethod = params[1] as string;
        return this._answerCdp(cdpMethod, params[0] as { tabId?: number } | undefined);
      }
      default:
        throw new Error(`'${method}' is not supported by the fake`);
    }
  }

  private _answerCdp(cdpMethod: string, source: { tabId?: number } | undefined): unknown {
    const tabId = typeof source?.tabId === 'number' ? source.tabId : undefined;
    if (cdpMethod === 'Target.getTargetInfo') {
      let targetId = tabId !== undefined ? this._targetByTab.get(tabId) : undefined;
      if (!targetId) {
        targetId = `target-${++nextTargetSerial}`;
        if (tabId !== undefined) this._targetByTab.set(tabId, targetId);
      }
      return {
        targetInfo: {
          targetId,
          type: 'page',
          title: 'Fake tab',
          url: 'https://example.com/fake',
          attached: true,
          // Real Chromium always carries one; a real Playwright client
          // asserts it, and falls back to its default context for a value
          // it has never seen.
          browserContextId: 'fake-default-context',
        },
      };
    }
    const canned = this._opts.respondTo?.[cdpMethod];
    if (canned !== undefined) return canned;
    if (cdpMethod === 'Page.getFrameTree') {
      // The main frame's id is the tab's target id, exactly as Chromium answers.
      const frameId =
        (tabId !== undefined ? this._targetByTab.get(tabId) : undefined) ?? 'frame-orphan';
      return {
        frameTree: {
          frame: {
            id: frameId,
            url: 'https://example.com/fake',
            securityOrigin: 'https://example.com',
            mimeType: 'text/html',
          },
        },
      };
    }
    if (this._opts.unknownPolicy === 'not-allowed') {
      throw new Error('Not allowed');
    }
    return {};
  }
}
