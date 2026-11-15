// The contract every consumer of the attached layer codes against.
//
// `README.md` in this directory is that contract in prose; this file is it in
// TypeScript. The session layer (`src/browser/attached.ts`) sees nothing below
// here — not the relay, not the model, not the wire.

import { AttachedRelay } from './cdp-relay.ts';
import type { DebuggerDetachedDetail } from './cdp-relay.ts';
import { AttachedError } from './errors.ts';
import type { ExtensionTab } from './browser-model.ts';

export type OwnedTab = ExtensionTab;
export type { DebuggerDetachedDetail };

/** An extension id is 32 lowercase letters a–p; anything else is a config typo. */
const EXTENSION_ID_SHAPE = /^[a-p]{32}$/;

export interface ConnectOptions {
  /** Shown in the extension's tab group title (the claim's purpose). */
  clientName: string;
  /** The extension's store id — also the Origin its upgrade must carry. */
  extensionId: string;
  /** From `BROKER_ATTACHED_TOKEN`; passed through, never logged. */
  token?: string;
  /** Coloured tab group for the connection (default true). */
  tabGroup?: boolean;
  /** Never foreground his tabs (default true). */
  background?: boolean;
  /** Log sink. Nothing written here contains the token. */
  log?: (message: string) => void;
}

export interface BridgeEventListeners {
  extensionConnected: () => void;
  extensionDisconnected: (reason: string) => void;
  tabsChanged: (tabs: readonly OwnedTab[]) => void;
  debuggerDetached: (detail: DebuggerDetachedDetail) => void;
}

/**
 * One attached session's bridge. See README for what each member means and
 * for the rules behind it — in short: loopback only, alive only while the
 * lease is, extension-verified on one path and uuid-verified on the other.
 */
export interface AttachedBridge {
  readonly cdpEndpoint: string;
  readonly extensionEndpoint: string;
  /** The extension's connect URL for this bridge; token included when set. */
  connectUrl(): string;
  extensionConnected(): boolean;
  extensionProtocolVersion(): number | undefined;
  waitForExtension(timeoutMs?: number): Promise<void>;
  openConnectPage(request: { browserPath: string; profileDirectory?: string }): void;
  tabs(): readonly OwnedTab[];
  isOurs(tabId: number): boolean;
  isOursByTargetId(targetId: string): boolean;
  on<K extends keyof BridgeEventListeners>(event: K, listener: BridgeEventListeners[K]): () => void;
  close(reason?: string): void;
}

/**
 * Open a bridge: bind the loopback listener and return. **Does not wait for
 * the extension** — `waitForExtension` does, and refuses rather than hangs.
 * Nothing is listening before this call and nothing after `close()`.
 */
export async function connect(options: ConnectOptions): Promise<AttachedBridge> {
  if (!EXTENSION_ID_SHAPE.test(options.extensionId)) {
    throw new AttachedError(
      'attached.bad_extension_id',
      `the configured extension id is not shaped like one: expected 32 characters a-p`,
    );
  }
  if (!options.clientName.trim()) {
    throw new AttachedError(
      'attached.no_client_name',
      'a connected client needs a name for the tab group title',
    );
  }
  const relay = new AttachedRelay({
    extensionId: options.extensionId,
    clientName: options.clientName,
    token: options.token,
    tabGroup: options.tabGroup,
    background: options.background,
    log: options.log,
  });
  await relay.start();
  return relay;
}
