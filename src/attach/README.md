# `src/attach/` — the attached-browser bridge

This directory holds everything the `attached` browser kind needs below the driver
seam: a relay that speaks the Playwright Extension's protocol on loopback, the
ownership mirror of that extension's tabs, and the launcher that opens the
extension's connect page. The session that drives it (`src/browser/attached.ts`) is
written against **this file's contract** and nothing else here; if the two disagree,
this file is right until it is changed deliberately, in a pull request, with its
consumers moved in the same change.

```
session ──connect()──▶ bridge ──cdpEndpoint──▶ chromium.connectOverCDP (loopback)
                         ▲
                         └── WebSocket ── Playwright Extension ──chrome.debugger──▶ tabs in its group
```

## The contract

```ts
import { connect, type AttachedBridge } from '../attach/session.ts';

const bridge = await connect({
  // Shown in the tab group's title; comes from the claim's purpose.
  clientName: 'read the dashboard',
  // The extension's store id — checked as the Origin of its connection.
  extensionId: 'mmlmfjhmonkocbjadbfplnigmagldckm',
  // From BROKER_ATTACHED_TOKEN. Optional; skips the connect page once trusted.
  // Never logged, never echoed in an error.
  token: process.env.BROKER_ATTACHED_TOKEN,
  // Never foreground his tabs (default true).
  background: true,
});
```

`connect()` **starts the listener and resolves**; it does not wait for the
extension. That is deliberate: the service needs to be able to answer "is he
connected?" (`bridge.extensionConnected()`) without anything in flight, and a
claim that must reach him uses `waitForExtension()` and its refusal. **Nothing
listens before `connect()` and nothing listens after `close()`** — the port exists
only for the life of an attached lease.

| Member | Shape | Notes |
| --- | --- | --- |
| `cdpEndpoint` | `string` | `ws://127.0.0.1:<port>/cdp/<uuid>` — hand to `chromium.connectOverCDP`. One client at a time; a second is refused. |
| `extensionEndpoint` | `string` | the mirror of the above for the extension; also embedded in the connect URL. |
| `connectUrl()` | `string` | the extension's connect URL for this bridge, token included when one is set. The URL is never logged. |
| `extensionConnected()` | `boolean` | whether the extension's WebSocket is up **right now**; never does I/O. |
| `extensionProtocolVersion()` | `number \| undefined` | what the extension reported when it initialized, or `undefined` if it hasn't connected yet. The doctor names mismatches against {@link RELAY_PROTOCOL_VERSION}. |
| `waitForExtension(timeoutMs?)` | `Promise<void>` | resolves when the extension has connected **and** finished its handshake. Rejects with an `AttachedError` whose rule is `attached.not_connected` on timeout or if the socket drops mid-handshake. Default timeout 30 s. A caller that gets that rejection must **refuse, not queue** — the queue is for capacity, and an absent extension is not capacity. |
| `openConnectPage({ browserPath, profileDirectory? })` | `void` | runs the configured browser binary on the extension's connect URL so he can approve the connection. A browser already running just gains a tab. `browserPath` comes from configuration — **never a defaulted path** (§7.2, `launch.explicit_profile_dir` reasoning applies). Throws `attached.no_binary` when it is missing. Passes `token` on the URL when one is configured; the URL is never logged. |
| `tabs()` | `readonly OwnedTab[]` | the ownership mirror — tabs the extension has told us belong to this connection (created through us, picked by him on the connect page, or popups of those). **A tab the extension has not reported is simply never here**; the extension only ever reports its own group, and this mirror adds no other source. |
| `isOurs(tabId)` | `boolean` | the same mirror keyed by the extension's tab id. |
| `isOursByTargetId(targetId)` | `boolean` | the same keyed by the CDP target id, which is what a driver handle carries. |
| `on(event, listener)` | `() => void` | subscribes; returns an unsubscribe. Events below. |
| `close(reason?)` | `void` | ends both connections and **stops listening**. Idempotent. `reason` is what the extension's side is told and what the disconnect event carries. |

Events (`on`):

| Event | Listener | Meaning for the session layer |
| --- | --- | --- |
| `extensionConnected` | `()` | the extension's WebSocket is up (handshake completion still comes via `waitForExtension`). |
| `extensionDisconnected` | `(reason: string)` | his extension went away (browser closed, extension reloaded, his Cancel). A claim arriving after this must be **refused, not queued**, until a fresh connect succeeds. |
| `tabsChanged` | `(tabs: readonly OwnedTab[])` | the mirror moved — use it to invalidate any tab list the session is holding. |
| `debuggerDetached` | `({ tabId, reason })` | Chrome took the debugger off one tab — his **Cancel** on the debugger bar arrives here. It ends the tab's debuggability, not the whole bridge; the session decides whether that ends the lease. |

`OwnedTab` is `{ tabId: number; url?: string; title?: string }`.

Refusals from this directory are `AttachedError extends BrokerError` with rules:
`attached.bad_extension_id` (config), `attached.not_connected` (timeout or socket
drop during a wait), `attached.no_binary` (connect page without a configured
binary). Everything else this layer enforces is a **dropped upgrade**, not a
thrown error: a wrong `Host`, a wrong `Origin` on the extension path, an
**any-Origin** on the CDP path, an unknown path or a requested subprotocol is
answered at the HTTP layer (403/404/400) and the WebSocket never opens — so
nothing downstream can observe a half-connection.

## What the relay will and will not do

- Listens on `127.0.0.1` only, on a random port, for the life of the bridge.
- Accepts the extension only from its `chrome-extension://<id>` Origin, and CDP
  clients only on their own per-lease uuid path **and only from a client that
  carries no Origin header** — the extension path demands one exact Origin, the
  CDP path demands none, because its only client is a local automation process
  and a browser always reports one. A second CDP client is refused while one is
  connected. A CDP client is refused while no extension is connected.
- Answers `Browser.getVersion` and `Browser.setDownloadBehavior` itself; every
  other command goes to the extension. The extension refuses a handful of
  handshake commands ("Not allowed", `Browser.grantPermissions`); those come back
  as CDP errors and are **harmless noise** — the bridge must not treat them as a
  disconnect.
- `Target.createTarget` / `Target.closeTarget` / `Target.setAutoAttach` /
  `Target.getTargetInfo` are protocol-handled here (the extension exposes tabs and
  the debugger, not CDP targets); policy over them is the service layer's, not the
  relay's — the relay has no idea what a lease is.

## Files

| File | Role |
| --- | --- |
| `session.ts` | the contract above: `connect`, events, the ownership mirror surface. |
| `cdp-relay.ts` | the HTTP/WebSocket relay, adapted from Playwright's `CDPRelayServer` with Origin/Host checks added (see `NOTICE`). |
| `cdp-relay-v2.ts`, `browser-model.ts` | the extension protocol (V2) and its tab/target model, from the same source. |
| `ws.ts` | a minimal RFC 6455 WebSocket (server and test-side client) over a plain TCP socket, because the package keeps `ws` out of its dependency set. |
| `connect-launcher.ts` | opening the connect page in the configured browser binary. |
| `errors.ts` | `AttachedError` and the rule names. |
