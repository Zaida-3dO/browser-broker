/*
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// The attached-browser relay.
//
// Adapted from Playwright's `cdpRelay.ts` — `CDPRelayServer` (Apache-2.0,
// Microsoft) — see NOTICE. The protocol halves (the extension connection, the
// CDP plumbing, the command routing) are kept close to that source because the
// other end of the socket is the released extension. What this version changes
// are the parts that were Playwright's context rather than the protocol's:
//
//   - the transport is `./ws.ts` instead of Playwright's internal WSServer,
//     because this package keeps `ws` out of its dependency set;
//   - Host is checked against the loopback address the relay bound, the
//     extension's upgrade is accepted only from its own chrome-extension
//     Origin, and a requested subprotocol is refused — checks the source
//     leaves to its delegate;
//   - the browser binary is always configuration (`openConnectPage`'s
//     parameter), never a registry lookup;
//   - the token is an option, not an environment variable the source reads,
//     and it never reaches the log;
//   - once the extension has disconnected, the bridge is over: further
//     extension connections are refused, and a fresh lease needs a fresh
//     `connect()`. "Not connected" must be a refusal the service can hear,
//     not a half-open socket it has to discover by trying.

import http from 'node:http';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketConnection, completeServerHandshake, rejectUpgrade } from './ws.ts';
import { ExtensionProtocolV2, Deferred, RELAY_PROTOCOL_VERSION } from './cdp-relay-v2.ts';
import { AttachedError } from './errors.ts';
import { buildConnectUrl, openConnectPage } from './connect-launcher.ts';
import type { ExtensionTab } from './browser-model.ts';

export interface RelayOptions {
  /** The extension's id; also the Origin its connection must carry. */
  extensionId: string;
  /** Shown in the extension's tab group title. */
  clientName: string;
  /** From configuration; passed to the extension, never logged. */
  token?: string;
  tabGroup?: boolean;
  background?: boolean;
  /** A log line sink. Nothing passed to it ever contains the token. */
  log?: (message: string) => void;
}

/** What the bridge emits; the session layer subscribes to these. */
export interface RelayEventListeners {
  extensionConnected: () => void;
  extensionDisconnected: (reason: string) => void;
  tabsChanged: (tabs: readonly ExtensionTab[]) => void;
  debuggerDetached: (detail: DebuggerDetachedDetail) => void;
}

export interface DebuggerDetachedDetail {
  tabId: number;
  reason: string;
}

type RelayListener = (...args: unknown[]) => void;

/**
 * CDP methods that **change browsing state the person owns**, refused by name
 * at the relay (§7.1 `attached.no_cookie_write`, §13n).
 *
 * The relay forwards every method it is not told otherwise about, and the
 * session-layer read-only rule sits above it — so the one door closing these
 * is this one, and it closes them for **every** client of the port, whatever
 * it framed. A cookie jar is browsing state in the strongest sense: it is
 * who he is signed in as, on pages this service was pointed at to *look* at.
 * Reads — `Network.getCookies` and friends — are not on this list: the read
 * promise was never a promise not to see.
 *
 * Matched as this fixed set, never as a denylist grown from anything real;
 * the names are Chrome's own protocol, not anybody's site.
 */
const STATE_WRITING_METHODS: ReadonlySet<string> = new Set([
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Storage.setCookies',
  'Storage.clearCookies',
  'Storage.clearDataForOrigin',
]);

/**
 * One live attached session's listener: a loopback port that exists only for
 * the life of the bridge, speaking CDP on one uuid path and the extension's
 * protocol on another.
 */
export class AttachedRelay {
  readonly cdpPath: string;
  readonly extensionPath: string;

  private readonly _extensionId: string;
  private readonly _clientName: string;
  private readonly _token: string | undefined;
  private readonly _tabGroup: boolean;
  private readonly _background: boolean;
  private readonly _log: (message: string) => void;
  private readonly _listeners = new Map<keyof RelayEventListeners, Set<RelayListener>>();

  private _server: http.Server | null = null;
  private _host = '';
  private _allowedHosts = new Set<string>();
  private _cdpConnection: WebSocketConnection | null = null;
  private _extensionConnection: ExtensionConnection | null = null;
  private _extensionConnectionPromise = new Deferred<void>();
  private _extensionClosed = false;
  private _closed = false;
  private readonly _handler: ExtensionProtocolV2;

  constructor(options: RelayOptions) {
    this._extensionId = options.extensionId;
    this._clientName = options.clientName;
    this._token = options.token;
    this._tabGroup = options.tabGroup ?? true;
    this._background = options.background ?? true;
    this._log = options.log ?? (() => {});

    const sendCommand = (method: string, params: unknown[]): Promise<unknown> => {
      if (!this._extensionConnection) throw new Error('Extension not connected');
      return this._extensionConnection.send(method, params);
    };
    this._handler = new ExtensionProtocolV2(sendCommand, this._background);
    this._handler.model.onTabsChanged = () => {
      this._emit('tabsChanged', this.tabs());
    };
    this._handler.model.onDebuggerDetached = (tabId, reason) => {
      this._emit('debuggerDetached', { tabId, reason } satisfies DebuggerDetachedDetail);
    };

    const uuid = crypto.randomUUID();
    this.cdpPath = `/cdp/${uuid}`;
    this.extensionPath = `/extension/${uuid}`;
    // The rejection this carries may land with nobody waiting on it (the
    // extension never arrives, and nobody called waitForExtension).
    void this._extensionConnectionPromise.promise.catch(() => {
      /* observed by waitForExtension, or irrelevant */
    });
  }

  // ─── lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const server = http.createServer((request, response) => {
      if (!this._hostAllowed(request)) {
        response.statusCode = 403;
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    server.on('upgrade', (request, socket, head) => {
      this._onUpgrade(request, socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('relay could not bind its loopback socket');
    }
    this._server = server;
    this._host = `ws://127.0.0.1:${address.port}`;
    // Only the literal address we bound and its name-equivalent, with the
    // port: a Host header carrying anything else is a page at another origin
    // probing the port, which the loopback bind alone does not stop.
    this._allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
    this._log(`relay listening on ${this._host}`);
  }

  get cdpEndpoint(): string {
    return `${this._host}${this.cdpPath}`;
  }

  get extensionEndpoint(): string {
    return `${this._host}${this.extensionPath}`;
  }

  /** The extension's connect URL for this bridge, token included when set. */
  connectUrl(): string {
    return buildConnectUrl({
      extensionId: this._extensionId,
      extensionEndpoint: this.extensionEndpoint,
      clientName: this._clientName,
      protocolVersion: RELAY_PROTOCOL_VERSION,
      tabGroup: this._tabGroup,
      background: this._background,
      token: this._token,
    });
  }

  openConnectPage(request: { browserPath: string; profileDirectory?: string }): void {
    openConnectPage({
      browserPath: request.browserPath,
      connectUrl: this.connectUrl(),
      profileDirectory: request.profileDirectory,
      background: this._background,
      token: this._token,
    });
  }

  extensionConnected(): boolean {
    return this._extensionConnection !== null;
  }

  extensionProtocolVersion(): number | undefined {
    return this._handler.extensionProtocolVersion;
  }

  /**
   * Resolve once the extension has connected **and** finished its handshake.
   * Reject with `attached.not_connected` on timeout or if the socket drops
   * first — the refusal the service turns into "not connected, refused not
   * queued", never into a hang.
   */
  async waitForExtension(timeoutMs = 30_000): Promise<void> {
    if (this._closed) {
      throw new AttachedError('attached.not_connected', 'the bridge is closed');
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const connected = (async () => {
      await this._extensionConnectionPromise.promise;
      await this._handler.ready();
    })();
    try {
      const outcome = await Promise.race([connected, timedOut]);
      if (outcome === 'timeout') {
        throw new AttachedError(
          'attached.not_connected',
          `the extension did not connect within ${Math.round(timeoutMs / 1000)}s; open its connect page from the configured browser`,
        );
      }
    } catch (error) {
      if (error instanceof AttachedError) throw error;
      throw new AttachedError(
        'attached.not_connected',
        `the extension connection ended before its handshake: ${(error as Error).message}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  close(reason = 'closed'): void {
    if (this._closed) return;
    this._closed = true;
    this._closeConnections(reason);
    const server = this._server;
    this._server = null;
    if (server) {
      server.close();
    }
    this._log('relay closed');
  }

  get closed(): boolean {
    return this._closed;
  }

  // ─── events ───────────────────────────────────────────────────────────

  on<K extends keyof RelayEventListeners>(event: K, listener: RelayEventListeners[K]): () => void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener as RelayListener);
    return () => set?.delete(listener as RelayListener);
  }

  private _emit<K extends keyof RelayEventListeners>(
    event: K,
    ...args: Parameters<RelayEventListeners[K]>
  ): void {
    for (const listener of this._listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  // ─── ownership mirror ─────────────────────────────────────────────────

  tabs(): readonly ExtensionTab[] {
    return this._handler.model.knownTabs();
  }

  isOurs(tabId: number): boolean {
    return this._handler.model.isKnownTab(tabId);
  }

  isOursByTargetId(targetId: string): boolean {
    return this._handler.model.isKnownTarget(targetId);
  }

  // ─── the HTTP surface ─────────────────────────────────────────────────

  private _hostAllowed(request: IncomingMessage): boolean {
    const host = request.headers.host;
    return typeof host === 'string' && this._allowedHosts.has(host.toLowerCase());
  }

  private _onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this._hostAllowed(request)) {
      this._log('upgrade refused: Host');
      rejectUpgrade(socket, 403);
      return;
    }
    const pathname = new URL(`http://localhost${request.url ?? '/'}`).pathname;
    const isCdp = pathname === this.cdpPath;
    const isExtension = pathname === this.extensionPath;
    if (!isCdp && !isExtension) {
      this._log('upgrade refused: path');
      rejectUpgrade(socket, 404);
      return;
    }
    if (request.headers['sec-websocket-protocol'] !== undefined) {
      // This bridge speaks bare text frames; a requested subprotocol is
      // either a mistake or a probe, and answering it would create a
      // connection shape nothing downstream understands.
      this._log('upgrade refused: subprotocol');
      rejectUpgrade(socket, 400);
      return;
    }
    if (isExtension && request.headers.origin !== `chrome-extension://${this._extensionId}`) {
      // The extension is the only thing that may drive the debugger side, and
      // its browser tags its upgrades with exactly this origin. Anything else
      // — a web page, another extension, a local process guessing the uuid —
      // never gets a socket.
      this._log('upgrade refused: Origin');
      rejectUpgrade(socket, 403);
      return;
    }
    const connection = completeServerHandshake(request, socket, head);
    if (!connection) return;
    if (isCdp) this._handlePlaywrightConnection(connection);
    else this._handleExtensionConnection(connection);
  }

  // ─── CDP side (Playwright) ────────────────────────────────────────────

  private _handlePlaywrightConnection(ws: WebSocketConnection): void {
    if (!this._extensionConnection) {
      this._log('rejecting Playwright connection: extension not connected');
      ws.close(1000, 'Extension not connected');
      return;
    }
    if (this._cdpConnection) {
      this._log('rejecting second Playwright connection');
      ws.close(1000, 'Another CDP client already connected');
      return;
    }
    this._cdpConnection = ws;
    this._handler.connectOverCDP((message) => this._sendToCDPClient(message));
    ws.onMessage = (text) => {
      void this._handlePlaywrightMessage(text).catch((error: unknown) => {
        this._log(`error while handling Playwright message: ${(error as Error).message}`);
      });
    };
    ws.onClose = () => {
      this._closeExtensionConnection('Playwright client disconnected');
      this._log('Playwright WebSocket closed');
    };
    this._log('Playwright connected');
  }

  private async _handlePlaywrightMessage(text: string): Promise<void> {
    const message = JSON.parse(text) as {
      id?: number;
      sessionId?: string;
      method?: string;
      params?: Record<string, unknown>;
    };
    this._log(`← Playwright: ${message.method} (id=${message.id})`);
    const { id, sessionId, method, params } = message;
    try {
      const result = await this._handleCDPCommand(method ?? '', params, sessionId);
      this._sendToCDPClient({ id, sessionId, result });
    } catch (error) {
      this._log(`error in the extension: ${(error as Error).message}`);
      this._sendToCDPClient({ id, sessionId, error: { message: (error as Error).message } });
    }
  }

  private async _handleCDPCommand(
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
  ): Promise<unknown> {
    // Refused **before the switch and before any forwarding**: the answer is
    // a CDP error to the client and nothing ever crosses to the extension,
    // which is what the paired test asserts on — the fake's call log is the
    // proof, not just the error the caller got.
    if (STATE_WRITING_METHODS.has(method)) {
      this._log(`refused by name: ${method}`);
      throw new Error(
        `attached.no_cookie_write: ${method} is not forwarded to an attached browser — his browsing state is read through this connection, never written.`,
      );
    }
    switch (method) {
      case 'Browser.getVersion': {
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Extension-Bridge',
          userAgent: 'CDP-Bridge-Server/1.0.0',
        };
      }
      case 'Browser.setDownloadBehavior': {
        return {};
      }
    }
    const handled = await this._handler.handleCDPCommand(method, params, sessionId);
    if (handled) return handled.result;
    return await this._handler.forwardToExtension(method, params, sessionId);
  }

  private _sendToCDPClient(message: Record<string, unknown>): void {
    if (!this._cdpConnection) return;
    const summary = (message.method as string | undefined) ?? `response(id=${String(message.id)})`;
    this._log(`→ Playwright: ${summary}`);
    this._cdpConnection.send(JSON.stringify(message));
  }

  // ─── extension side ───────────────────────────────────────────────────

  private _handleExtensionConnection(ws: WebSocketConnection): void {
    if (this._extensionConnection) {
      ws.close(1000, 'Another extension connection already established');
      return;
    }
    if (this._extensionClosed) {
      // The bridge has already seen an extension come and go; "not connected"
      // stays a clean refusal until a whole new lease opens a whole new
      // listener, rather than this port quietly hosting a second session
      // with half a model.
      ws.close(1000, 'Bridge ended; open a new lease');
      return;
    }
    this._extensionConnection = new ExtensionConnection(ws, this._log);
    this._extensionConnection.onclose = (reason) => {
      this._log(`extension WebSocket closed: ${reason}`);
      this._extensionConnection = null;
      this._extensionClosed = true;
      this._handler.onExtensionDisconnect(reason);
      this._closeCDPConnection(`Extension disconnected: ${reason}`);
      this._emit('extensionDisconnected', reason);
    };
    this._extensionConnection.onmessage = (method, params) =>
      this._handler.handleExtensionEvent(method, params);
    this._extensionConnectionPromise.resolve();
    this._emit('extensionConnected');
    this._log('extension connected');
  }

  private _closeConnections(reason: string): void {
    this._closeCDPConnection(reason);
    this._closeExtensionConnection(reason);
  }

  private _closeExtensionConnection(reason: string): void {
    this._extensionConnection?.close(reason);
    if (!this._extensionConnectionPromise.isDone()) {
      this._extensionConnectionPromise.reject(new Error(reason));
    }
  }

  private _closeCDPConnection(reason: string): void {
    if (this._cdpConnection?.readyState === 'open') {
      this._cdpConnection.close(1000, reason);
    }
    this._cdpConnection = null;
  }
}

/**
 * The extension's half of the wire: a request/response channel with numbered
 * calls, exactly as the extension's background script speaks it.
 */
class ExtensionConnection {
  onmessage: ((method: string, params: unknown[] | undefined) => void) | undefined;
  onclose: ((reason: string) => void) | undefined;

  private readonly _callbacks = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      error: Error;
    }
  >();
  private _lastId = 0;
  private readonly _ws: WebSocketConnection;
  private readonly _log: (message: string) => void;

  constructor(ws: WebSocketConnection, log: (message: string) => void) {
    this._ws = ws;
    this._log = log;
    this._ws.onMessage = (text) => this._onMessage(text);
    this._ws.onClose = (reason) => {
      this._log(`extension socket closed: ${reason}`);
      this._dispose();
      this.onclose?.(reason);
    };
  }

  async send(method: string, params?: unknown[]): Promise<unknown> {
    if (this._ws.readyState !== 'open') {
      throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
    }
    const id = ++this._lastId;
    this._ws.send(JSON.stringify({ id, method, params }));
    const error = new Error(`Protocol error: ${method}`);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error });
    });
  }

  close(message: string): void {
    this._ws.close(1000, message);
  }

  private _onMessage(text: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this._ws.close(1000, 'malformed JSON');
      return;
    }
    try {
      this._handleParsedMessage(parsed);
    } catch (error) {
      this._log(`closing extension socket after handler error: ${(error as Error).message}`);
      this._ws.close(1000, 'handler error');
    }
  }

  private _handleParsedMessage(object: Record<string, unknown>): void {
    const id = object.id as number | undefined;
    if (id !== undefined && this._callbacks.has(id)) {
      const callback = this._callbacks.get(id) as {
        resolve: (value: unknown) => void;
        reject: (reason?: unknown) => void;
        error: Error;
      };
      this._callbacks.delete(id);
      if (object.error) {
        // The extension answers a failed call with the message as a string;
        // anything else is carried as its JSON form rather than object-string.
        const detail =
          typeof object.error === 'string' ? object.error : JSON.stringify(object.error);
        callback.error.message = detail;
        callback.reject(callback.error);
      } else {
        callback.resolve(object.result);
      }
    } else if (id !== undefined) {
      this._log('extension sent an unexpected response id');
    } else {
      this.onmessage?.(object.method as string, object.params as unknown[] | undefined);
    }
  }

  private _dispose(): void {
    for (const callback of this._callbacks.values()) {
      callback.reject(new Error('WebSocket closed'));
    }
    this._callbacks.clear();
  }
}
