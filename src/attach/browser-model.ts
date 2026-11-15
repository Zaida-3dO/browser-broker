// The tab/target model behind the extension protocol.
//
// Adapted from Playwright's `browserModel.ts` (Apache-2.0, Microsoft) — see
// NOTICE. It is the book half of the bridge: the extension reports *tabs and
// the debugger*, Playwright speaks *targets and sessions*, and this class is
// the mapping between them. Kept close to its source on purpose — the protocol
// it speaks is the released extension's, and every deliberate difference from
// it is a compatibility break nobody tested.

/** The `chrome.debugger` event source the extension sends with each event. */
export interface DebuggerSource {
  tabId?: number;
  sessionId?: string;
}

/** A `chrome.tabs.Tab`, as far as the relay cares. */
export interface ExtensionTab {
  id?: number;
  url?: string;
  title?: string;
}

interface TabSession {
  tabId: number;
  sessionId: string;
  targetInfo: Record<string, unknown> | undefined;
  childSessions: Set<string>;
}

export class BrowserModel {
  // Set only while a Playwright CDP connection is attached (see
  // `connectOverCDP`). Before that, any attempt to emit to Playwright is a
  // no-op — the model is observation-only during the extension handshake.
  private _sendToCDPClient: ((message: Record<string, unknown>) => void) | null = null;
  // Tabs observed via chrome.tabs.onCreated, whether or not the debugger is
  // attached yet. This map is also the ownership mirror: it only ever grows
  // from what the extension itself reported, and the extension only reports
  // its own group — so a foreign tab is not merely hidden here, it is absent.
  private readonly _knownTabs = new Map<number, ExtensionTab>();
  // Subset of _knownTabs the debugger has been attached to, with a sessionId.
  private readonly _tabSessions = new Map<number, TabSession>();
  // Attaches in flight, keyed by tab. `createTarget` and the extension's
  // `onCreated` event for the same tab can both ask to attach before either
  // has registered a session; without this, the tab is attached — and reported
  // to the client — twice, and a real Playwright client refuses the duplicate.
  private readonly _attaching = new Map<number, Promise<TabSession>>();
  private _autoAttach = false;
  private _nextSessionId = 1;
  private readonly _sendToExtension: (method: string, params: unknown[]) => Promise<unknown>;

  /** Fired whenever _knownTabs changed, for the bridge's tabsChanged event. */
  onTabsChanged: (() => void) | undefined;
  /** Fired when Chrome detaches the debugger from a tab (his Cancel). */
  onDebuggerDetached: ((tabId: number, reason: string) => void) | undefined;

  constructor(sendToExtension: (method: string, params: unknown[]) => Promise<unknown>) {
    this._sendToExtension = sendToExtension;
  }

  /** Every tab this connection owns, in the order the extension reported them. */
  knownTabs(): readonly ExtensionTab[] {
    return [...this._knownTabs.values()];
  }

  isKnownTab(tabId: number): boolean {
    return this._knownTabs.has(tabId);
  }

  /**
   * Whether a CDP target id belongs to this connection. Target ids only exist
   * once the debugger has attached, so an unattached known tab — listed, but
   * never yet debugged — answers false, which is the honest answer: nothing
   * can hold a handle to a target that does not exist.
   */
  isKnownTarget(targetId: string): boolean {
    for (const session of this._tabSessions.values()) {
      if ((session.targetInfo as { targetId?: string } | undefined)?.targetId === targetId) {
        return true;
      }
    }
    return false;
  }

  // Wires the model's CDP output sink. Called by the handler once the
  // extension handshake is done and a Playwright CDP client is ready to
  // receive events. Before this call the model is observation-only —
  // `Target.attachedToTarget` etc. would be answered into a black hole.
  connectOverCDP(sendToCDPClient: (message: Record<string, unknown>) => void): void {
    this._sendToCDPClient = sendToCDPClient;
  }

  private _emit(message: Record<string, unknown>): void {
    this._sendToCDPClient?.(message);
  }

  // ─── Extension → model inputs ─────────────────────────────────────────

  onTabCreated(tab: ExtensionTab): void {
    if (tab.id === undefined) return;
    this._knownTabs.set(tab.id, tab);
    this.onTabsChanged?.();
    if (this._autoAttach) {
      void this._attachTab(tab.id).catch(() => {
        // An attach failure leaves the tab listed but undebuggable; Playwright
        // will report it as an error on the target, which is the honest answer.
      });
    }
  }

  onTabRemoved(tabId: number): void {
    this._knownTabs.delete(tabId);
    this.onTabsChanged?.();
    this._detachTab(tabId);
  }

  onDebuggerEvent(
    source: DebuggerSource,
    method: string,
    params: Record<string, unknown> | undefined,
  ): void {
    if (source.tabId === undefined) return;
    const tabSession = this._tabSessions.get(source.tabId);
    if (!tabSession) return;
    const childSessionId = params?.sessionId as string | undefined;
    if (method === 'Target.attachedToTarget' && childSessionId) {
      tabSession.childSessions.add(childSessionId);
    } else if (method === 'Target.detachedFromTarget' && childSessionId) {
      tabSession.childSessions.delete(childSessionId);
    }
    const sessionId = source.sessionId || tabSession.sessionId;
    this._emit({ sessionId, method, params });
  }

  onDebuggerDetach(source: DebuggerSource, reason = 'detached'): void {
    if (source.tabId !== undefined) {
      this._detachTab(source.tabId);
      this.onDebuggerDetached?.(source.tabId, reason);
    }
  }

  // ─── Playwright → model commands ──────────────────────────────────────

  // Turn auto-attach on and attach to every tab we already know about.
  // Called in response to Playwright's `Target.setAutoAttach` on the root session.
  async enableAutoAttach(): Promise<void> {
    this._autoAttach = true;
    const tabIds = [...this._knownTabs.keys()];
    await Promise.all(
      tabIds.map((tabId) =>
        this._attachTab(tabId).catch(() => {
          // See onTabCreated: an unattachable tab stays listed, and Playwright
          // sees the error on its own attach attempt.
        }),
      ),
    );
  }

  async createTarget(
    url: string | undefined,
    active: boolean,
  ): Promise<{ targetId: string | undefined }> {
    const tab = (await this._sendToExtension('chrome.tabs.create', [{ url, active }])) as
      ExtensionTab | undefined;
    if (tab?.id === undefined) throw new Error('Failed to create tab');
    this._knownTabs.set(tab.id, tab);
    this.onTabsChanged?.();
    const tabSession = await this._attachTab(tab.id);
    return { targetId: tabSession.targetInfo?.targetId as string | undefined };
  }

  async closeTarget(targetId: string | undefined): Promise<{ success: boolean }> {
    const tabSession = targetId
      ? this._findTabSession(
          (s) => (s.targetInfo as { targetId?: string } | undefined)?.targetId === targetId,
        )
      : undefined;
    if (!tabSession) return { success: false };
    await this._sendToExtension('chrome.tabs.remove', [tabSession.tabId]);
    // The listing drops when the extension's chrome.tabs.onRemoved arrives,
    // as it does for any tab closed any other way — one removal path, so the
    // mirror cannot drift depending on who closed the tab.
    return { success: true };
  }

  getTargetInfo(sessionId: string | undefined): Record<string, unknown> | undefined {
    if (!sessionId) return undefined;
    return this._findTabSession((s) => s.sessionId === sessionId)?.targetInfo;
  }

  // Forward a browser-level CDP command (Storage.*, Browser.*, etc.) that is
  // not associated with a specific tab. chrome.debugger.sendCommand requires a
  // target, so route through any attached tab; the command itself is
  // browser-scoped and returns the same result regardless of which tab is used.
  async sendBrowserCommand(method: string, params: unknown): Promise<unknown> {
    const tabSession = this._tabSessions.values().next().value;
    if (!tabSession) throw new Error(`No attached tab to forward browser-level command: ${method}`);
    return await this._sendToExtension('chrome.debugger.sendCommand', [
      { tabId: tabSession.tabId },
      method,
      params,
    ]);
  }

  // Forward a CDP command from Playwright to the tab its sessionId resolves to.
  async sendCommand(sessionId: string, method: string, params: unknown): Promise<unknown> {
    let tabSession = this._findTabSession((s) => s.sessionId === sessionId);
    let cdpSessionId: string | undefined;
    if (!tabSession) {
      tabSession = this._findTabSession((s) => s.childSessions.has(sessionId));
      cdpSessionId = sessionId;
    }
    if (!tabSession) throw new Error(`No tab found for sessionId: ${sessionId}`);
    return await this._sendToExtension('chrome.debugger.sendCommand', [
      { tabId: tabSession.tabId, sessionId: cdpSessionId },
      method,
      params,
    ]);
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async _attachTab(tabId: number): Promise<TabSession> {
    const existing = this._tabSessions.get(tabId);
    if (existing) return existing;
    const inFlight = this._attaching.get(tabId);
    if (inFlight) return inFlight;
    const attaching = this._doAttachTab(tabId);
    this._attaching.set(tabId, attaching);
    try {
      return await attaching;
    } finally {
      // A failed attach must be retryable: drop only this attempt's promise.
      if (this._attaching.get(tabId) === attaching) this._attaching.delete(tabId);
    }
  }

  private async _doAttachTab(tabId: number): Promise<TabSession> {
    await this._sendToExtension('chrome.debugger.attach', [{ tabId }, '1.3']);
    const result = (await this._sendToExtension('chrome.debugger.sendCommand', [
      { tabId },
      'Target.getTargetInfo',
    ])) as { targetInfo?: Record<string, unknown> } | undefined;
    const targetInfo = result?.targetInfo;
    const sessionId = `pw-tab-${this._nextSessionId++}`;
    const tabSession: TabSession = { tabId, sessionId, targetInfo, childSessions: new Set() };
    this._tabSessions.set(tabId, tabSession);
    this._emit({
      method: 'Target.attachedToTarget',
      params: {
        sessionId,
        targetInfo: { ...(targetInfo as Record<string, unknown>), attached: true },
        waitingForDebugger: false,
      },
    });
    return tabSession;
  }

  private _detachTab(tabId: number): void {
    const tabSession = this._tabSessions.get(tabId);
    if (!tabSession) return;
    this._tabSessions.delete(tabId);
    this._emit({
      method: 'Target.detachedFromTarget',
      params: {
        sessionId: tabSession.sessionId,
        targetId: (tabSession.targetInfo as { targetId?: string } | undefined)?.targetId,
      },
    });
  }

  private _findTabSession(predicate: (session: TabSession) => boolean): TabSession | undefined {
    for (const session of this._tabSessions.values()) {
      if (predicate(session)) return session;
    }
    return undefined;
  }
}
