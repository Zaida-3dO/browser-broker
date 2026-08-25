import path from 'node:path';

import { profileDirectory } from '../browser/discovery.ts';
import type { BrowserId } from '../browser/driver.ts';
import { SIGNABLE_BROWSER } from '../service/operations/sign-in.ts';

/**
 * `broker login` — the words a person reads while they are signing in.
 *
 * ── Why the prose is a module and not a template literal in the handler ──
 *
 * This is the **one command whose output is the product**. Every other
 * command reports what happened; this one asks a person to do something, and
 * if they do the wrong thing there is no error to read — a sign-in performed
 * against the wrong profile succeeds, looks identical, and is discarded. So
 * the text is here, in one place, where it can be asserted by a test rather
 * than reviewed by eye.
 *
 * What each line has to carry, and why each is load-bearing:
 *
 * - **Which window is theirs.** A person with several browser windows open
 *   needs to know which one this opened, and the answer is "the one that just
 *   appeared" only for as long as they are looking at the screen.
 * - **That closing it ends the step.** Otherwise they leave it open, and the
 *   command that would confirm the sign-in refuses because a browser is still
 *   running against the profile.
 * - **That it is a real sign-in against a real site.** Nothing here is a
 *   sandbox: what they type goes to whoever they are signing in to, exactly as
 *   it would in their own browser.
 * - **That nothing here records what they type.** Said plainly because the
 *   opposite is a reasonable assumption about a tool that opened the window,
 *   and a person who assumes it might reasonably decline to use it.
 */

/** The heading, so the window and the terminal are unambiguously paired. */
export const SIGN_IN_HEADING = 'A browser window is open for you to sign in.';

/**
 * What a person does, in order.
 *
 * Numbered rather than prose because it is a procedure someone follows while
 * looking at something else.
 */
export function signInInstructions(browser: BrowserId, profileRelativePath: string): string[] {
  return [
    SIGN_IN_HEADING,
    '',
    `  1. Switch to the browser window that just opened. It is the ${browser} browser,`,
    `     running against the profile at ${profileRelativePath} under the configured`,
    '     profile root — which is the profile every caller will share.',
    '  2. Go to whichever site you want this service to be signed in to, and sign in',
    '     normally. This is a real browser and a real sign-in: what you type goes to',
    '     that site exactly as it would in your own browser.',
    '  3. Close the window when you are done. Closing it is what ends this step.',
    '',
    'While this is happening the browser is not serving callers. Anything that asks',
    'for it is told a person is signing in and to try again shortly; anything already',
    'waiting in the queue keeps its place and its timer.',
    '',
    'Nothing here records what you type. The sign-in is written into the browser’s',
    'own profile directory by the browser itself — this service never sees a',
    'credential, and stores nothing about one anywhere.',
  ];
}

/** What a person is told once the window has closed and the browser is back. */
export function signInCompletion(browser: BrowserId, queueDepth: number): string[] {
  const lines = [
    `The window has closed and the ${browser} browser is serving again.`,
    '',
    'Confirm the sign-in took with:',
    '',
    '    broker doctor',
    '',
    'It reports whether the profile carries a session, without opening a browser.',
  ];
  if (queueDepth > 0) {
    lines.push(
      '',
      `${String(queueDepth)} caller(s) were queued while you signed in and kept their places.`,
    );
  }
  return lines;
}

/**
 * The absolute profile directory the browser is launched against.
 *
 * ── Never the default profile, and never a temporary one ────────────────
 *
 * `launch.explicit_profile_dir` (§7.2) is a launch-time refusal, but by the
 * time it fires the caller has already decided which directory it meant. This
 * is where that decision is made, and it is made **from the configured
 * profile root by the same function the setup handshake uses**
 * (`profileDirectory`) rather than by joining a path here.
 *
 * That matters more than it looks: a sign-in against a directory that is one
 * character different from the one callers use is the failure this command
 * exists to prevent, and it is undetectable afterwards — the person signs in
 * successfully, the browser writes a real session to a real directory, and
 * every caller attaches to a different one and sees a signed-out browser. So
 * there is deliberately no second spelling of where a profile lives.
 */
export function signInProfileDirectory(profileRoot: string, browser: BrowserId): string {
  return profileDirectory(profileRoot, browser);
}

/**
 * What to say when no browser is running to hand over.
 *
 * ── The honest seam, stated rather than papered over ────────────────────
 *
 * §5.5.1 says *"nothing is stopped and nothing is relaunched"*, and that is
 * written for the arrangement where the signed-in browser is already up:
 * *"the window is already there"*. This command therefore claims the browser
 * and hands over the window that exists.
 *
 * When none exists, it starts one — and that is the whole of what this
 * command launches. It is a cold start of the browser a person is about to
 * sign into, which is the case §5.5.1's own step 3 describes as *"hands the
 * person the window"*: there has to be a window. What it does **not** do is
 * take a lease, open a tab, or drive anything, because none of those is a
 * person signing in.
 */
export const NO_BROWSER_NOTE =
  'No browser was running against this profile, so one was started for you to sign into.';

/**
 * A hint for the collision case, which is the one that fails least legibly.
 *
 * Measured, and the reason `coldStartDetached` asserts rather than infers: a
 * second browser started against a profile already in use **hands its address
 * to the first and exits zero**, opening no endpoint of its own. The launch
 * refuses on that, and this is what the refusal is worth saying alongside it —
 * because the thing a person should do about it is not obvious from a message
 * about endpoints.
 */
export const COLLISION_HINT =
  'A browser is already running against this profile. That may be a window you or ' +
  'something else opened earlier — find it and use it to sign in, or close it and ' +
  'run this again. Two browsers cannot share one profile directory: the second ' +
  'silently hands its address to the first and opens nothing.';

/** Where the profile is, relative to the root, for a message (§1.7a). */
export function relativeProfilePath(profileRoot: string, browser: BrowserId): string {
  return path.relative(profileRoot, profileDirectory(profileRoot, browser)) || browser;
}

/** The browser this command signs into when none is named. */
export const DEFAULT_SIGN_IN_BROWSER: BrowserId = SIGNABLE_BROWSER;
