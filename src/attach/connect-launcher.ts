// Opening the extension's connect page in the configured browser binary.
//
// The connect page is where he approves a connection — or, once a token is
// configured, the page the token lets the extension skip. Running a browser
// binary on a URL is the only outward act this module makes, and it is
// deliberately the only place in the attach layer that spawns anything.
//
// The binary path is always a parameter (configuration's job); nothing here
// searches for a browser or defaults a path, for the same reason §7.2
// `launch.explicit_profile_dir` refuses a default profile location — a
// defaulted path names one machine and silently picks a browser nobody chose.

import { spawn } from 'node:child_process';
import { AttachedError } from './errors.ts';

export interface ConnectPageRequest {
  /** The browser binary to run, from configuration. Never defaulted here. */
  browserPath: string;
  /** The extension's connect URL, built by the relay. */
  connectUrl: string;
  /** Passed through as `--profile-directory` when given. */
  profileDirectory?: string;
  /** Ask for a background tab — only meaningful together with a token. */
  background?: boolean;
  /**
   * The extension's connection token, carried on the URL. Never logged; pass
   * it only through this field.
   */
  token?: string;
  /**
   * Notified when the configured path names no process. A spawn that fails
   * does so **asynchronously** — after `openConnectPage` has already
   * returned — by emitting `error` on the child, so nothing between here and
   * the caller can see it in a `catch`. Without a listener that event is an
   * uncaught exception; see the comment in {@link openConnectPage}.
   */
  onSpawnError?: (error: Error) => void;
}

/**
 * The connect URL for an extension: its `connect.html` page with the relay
 * endpoint, the client's name (shown in the tab group's title), the protocol
 * version it should report, and the token when one is configured.
 */
export function buildConnectUrl(request: {
  extensionId: string;
  extensionEndpoint: string;
  clientName: string;
  protocolVersion: number;
  tabGroup?: boolean;
  background?: boolean;
  token?: string;
}): string {
  const url = new URL(`chrome-extension://${request.extensionId}/connect.html`);
  url.searchParams.set('mcpRelayUrl', request.extensionEndpoint);
  url.searchParams.set('client', JSON.stringify({ name: request.clientName }));
  url.searchParams.set('protocolVersion', String(request.protocolVersion));
  if (request.tabGroup === false) url.searchParams.set('tabGroup', 'false');
  if (request.background) url.searchParams.set('background', 'true');
  if (request.token) url.searchParams.set('token', request.token);
  return url.toString();
}

/** The argv for a connect-page launch, in order, URL last. */
export function buildConnectArgs(request: ConnectPageRequest): string[] {
  const args: string[] = [];
  if (request.profileDirectory) args.push(`--profile-directory=${request.profileDirectory}`);
  if (request.background && request.token) args.push('--open-in-background');
  args.push(request.connectUrl);
  return args;
}

/**
 * The one refusal shape both spawn-failure timings take — the synchronous
 * throw and the asynchronous event are the same fact reported at different
 * moments: the configured path names no process. The reason is the error's
 * code; the configured path itself is a machine fact and never travels.
 */
function spawnRefusal(error: unknown): AttachedError {
  const maybeCode =
    error instanceof Error ? (error as unknown as { code?: unknown }).code : undefined;
  const code = typeof maybeCode === 'string' ? maybeCode : 'unknown reason';
  return new AttachedError(
    'attached.no_binary',
    `the configured binary could not be started for the connect page (${code}). Nothing launched and waiting changes nothing: check its configured path.`,
    { cause: error },
  );
}

/**
 * Run the browser on the connect URL. A browser already running on that
 * profile just gains a tab — which is the ordinary case, not a fallback.
 * The child is detached on purpose: this process is not its parent and must
 * not take his browser down when the lease ends.
 */
export function openConnectPage(request: ConnectPageRequest): void {
  if (!request.browserPath?.trim()) {
    throw new AttachedError(
      'attached.no_binary',
      'no browser binary is configured for the connect page — set the configured path for this attached browser',
    );
  }
  const args = buildConnectArgs(request);
  // Platforms disagree on *when* an unusable path reports: some fail a
  // wrong-type file **here**, synchronously, while the same path on another
  // platform — and a missing path everywhere — reports as the event below.
  // Either way it is the same family of fact: the configured path names no
  // process, and the refusal is `attached.no_binary` either way. The reason
  // stays the error's **code**; the configured path never travels.
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(request.browserPath, args, {
      windowsHide: true,
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
  } catch (error) {
    throw spawnRefusal(error);
  }
  // ── A spawn that fails does so ASYNCHRONOUSLY, and unhandled it is fatal ──
  //
  // Spawning a path that cannot start — deleted, non-executable, the wrong
  // type — **still returns a child and still assigns a process identifier**,
  // and reports the failure moments later by emitting `error` on it. With
  // nothing listening that is an unhandled error event, which escapes every
  // `catch` between here and the caller and **ends the process**: at this
  // call site the whole service would go down, every lease in it, for one
  // claim against one stale configured path. `launch.ts` measured this and
  // its own detached launch handles it the same way; so does the secret
  // resolver. The listener attaches before anything else. Here it does one
  // thing: hand the reason back to the caller, which owns the bounded wait
  // that is supposed to report it.
  child.once('error', (error: Error) => {
    request.onSpawnError?.(error);
  });
  child.unref();
}
