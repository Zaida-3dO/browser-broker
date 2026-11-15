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
  const child = spawn(request.browserPath, args, {
    windowsHide: true,
    detached: true,
    shell: false,
    stdio: 'ignore',
  });
  child.unref();
}
