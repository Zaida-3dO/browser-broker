// The extension protocol (version 2) the bridge speaks.
//
// Adapted from Playwright's `cdpRelayV2.ts` (Apache-2.0, Microsoft) — see
// NOTICE. One addition over it, deliberate and small: `extension.initialized`
// can carry the extension's `protocolVersion`, and it is kept so the doctor
// can name a mismatch instead of guessing one.

import { BrowserModel } from './browser-model.ts';
import type { DebuggerSource, ExtensionTab } from './browser-model.ts';

/** The protocol version this relay speaks, as the connect URL states it. */
export const RELAY_PROTOCOL_VERSION = 2;

/** A promise someone can resolve, reject and inspect from outside. */
export class Deferred<T> {
  private _promise: Promise<T>;
  private _resolve!: (value: T | PromiseLike<T>) => void;
  private _reject!: (reason?: Error) => void;
  private _done = false;

  constructor() {
    this._promise = new Promise<T>((resolve, reject) => {
      this._resolve = (value) => {
        this._done = true;
        resolve(value);
      };
      this._reject = (reason?: Error) => {
        this._done = true;
        reject(reason ?? new Error('rejected'));
      };
    });
  }

  get promise(): Promise<T> {
    return this._promise;
  }

  isDone(): boolean {
    return this._done;
  }

  resolve(value?: T): void {
    // `void`-typed deferrals are resolved with no argument.
    this._resolve(value as T);
  }

  /** A rejection always carries an Error — the refusal the waiter turns into words. */
  reject(reason?: Error): void {
    this._reject(reason);
  }
}

export class ExtensionProtocolV2 {
  // Resolved by `extension.initialized`. Purely a handshake signal for the
  // relay — the model itself is oblivious to this phase.
  private readonly _ready = new Deferred<void>();
  readonly model: BrowserModel;
  private readonly _background: boolean;
  private _extensionProtocolVersion: number | undefined;

  constructor(
    sendCommand: (method: string, params: unknown[]) => Promise<unknown>,
    background = false,
  ) {
    this.model = new BrowserModel(sendCommand);
    this._background = background;
    // A rejected `ready()` with nobody listening yet must not surface as an
    // unhandled rejection; establishExtensionConnection attaches its own catch.
    void this._ready.promise.catch(() => {
      /* observed later, or irrelevant */
    });
  }

  /** What the extension reported as its protocol version, if it connected. */
  get extensionProtocolVersion(): number | undefined {
    return this._extensionProtocolVersion;
  }

  // Resolves once the extension has completed its initial handshake and the
  // relay may start processing CDP commands from Playwright.
  ready(): Promise<void> {
    return this._ready.promise;
  }

  connectOverCDP(sendToCDPClient: (message: Record<string, unknown>) => void): void {
    this.model.connectOverCDP(sendToCDPClient);
  }

  // Called when the extension WebSocket closes. Rejects a pending `ready()`
  // promise so a blocked wait bails out instead of hanging forever.
  onExtensionDisconnect(reason: string): void {
    if (!this._ready.isDone()) {
      this._ready.reject(new Error(`Extension disconnected before initialization: ${reason}`));
    }
  }

  handleExtensionEvent(method: string, params: unknown[] | undefined): void {
    switch (method) {
      case 'chrome.debugger.onEvent': {
        const [source, cdpMethod, cdpParams] = (params ?? []) as [
          DebuggerSource,
          string,
          Record<string, unknown> | undefined,
        ];
        this.model.onDebuggerEvent(source, cdpMethod, cdpParams);
        break;
      }
      case 'chrome.debugger.onDetach': {
        const [source, details] = (params ?? []) as [
          DebuggerSource,
          { reason?: string } | undefined,
        ];
        this.model.onDebuggerDetach(source, details?.reason ?? 'detached');
        break;
      }
      case 'chrome.tabs.onCreated': {
        const [tab] = (params ?? []) as [ExtensionTab];
        this.model.onTabCreated(tab);
        break;
      }
      case 'chrome.tabs.onRemoved': {
        const [tabId] = (params ?? []) as [number];
        this.model.onTabRemoved(tabId);
        break;
      }
      case 'extension.initialized': {
        const reported = (params?.[0] as { protocolVersion?: unknown } | undefined)
          ?.protocolVersion;
        if (typeof reported === 'number') {
          this._extensionProtocolVersion = reported;
        }
        this._ready.resolve();
        break;
      }
    }
  }

  // Handles a protocol-specific CDP command. Returns { result } if handled,
  // undefined to fall through to forwarding to the extension.
  async handleCDPCommand(
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
  ): Promise<{ result: unknown } | undefined> {
    switch (method) {
      case 'Target.setAutoAttach': {
        if (sessionId) return undefined;
        await this.model.enableAutoAttach();
        return { result: {} };
      }
      case 'Target.createTarget': {
        return {
          result: await this.model.createTarget(
            params?.url as string | undefined,
            !this._background,
          ),
        };
      }
      case 'Page.bringToFront':
      case 'Target.activateTarget':
        if (this._background) return { result: {} };
        return undefined;
      case 'Target.closeTarget':
        return { result: await this.model.closeTarget(params?.targetId as string | undefined) };
      case 'Target.getTargetInfo':
        return { result: this.model.getTargetInfo(sessionId) };
    }
    return undefined;
  }

  async forwardToExtension(
    method: string,
    params: unknown,
    sessionId: string | undefined,
  ): Promise<unknown> {
    if (!sessionId) return await this.model.sendBrowserCommand(method, params);
    return await this.model.sendCommand(sessionId, method, params);
  }
}
