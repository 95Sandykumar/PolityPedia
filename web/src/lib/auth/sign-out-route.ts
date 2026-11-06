/**
 * The decision logic behind POST /api/auth/sign-out (issue 33-session-refresh).
 *
 * The cookie used to be set and never cleared, so on a shared phone the next
 * person had the student's session for up to 7 days. Signing out does two
 * things, in this order:
 *  1. Revoke the session at Supabase, so the refresh token is dead everywhere.
 *  2. Clear our cookie, so this browser forgets it.
 *
 * Step 2 happens even when step 1 fails. A student who taps Sign out must end
 * up signed out of this phone whatever the network did.
 *
 * ONLY OUR OWN PAGES MAY ASK (issue 38-session-and-alerts-fixes). This is a
 * plain form POST with a `lax` cookie, so any page anywhere could post a form
 * at it and end somebody's session: not a data leak, but a student thrown out
 * of a mock test by a stranger's page. The `Origin` header decides, and the
 * cookie is not even looked at when the answer is no.
 *
 * Security: nothing here is logged, and the reply carries no token.
 */
import { SIGN_IN_PATH } from './guard';
import type { AuthSession } from './session';
import type { ServerAuthClient } from './types';

export interface SignOutReply {
  /**
   * 303 normally: the browser follows it with a GET, so Back does not
   * re-post. 403 when the POST came from another site
   * (issue 38-session-and-alerts-fixes).
   */
  status: 303 | 403;
  /** Where the browser goes. Not used on a 403: nothing is redirected. */
  location: string;
  /** False on a 403. A foreign page does not get to clear our cookie. */
  clearCookie: boolean;
}

export interface SignOutInput {
  session: AuthSession | null;
  client: ServerAuthClient;
  /** The `Origin` request header, or null when the browser sent none. */
  origin?: string | null;
  /** The `Sec-Fetch-Site` request header, or null. */
  secFetchSite?: string | null;
  /** Our own origin, from the request URL. */
  siteOrigin?: string | null;
}

/**
 * True when this POST really came from one of our own pages.
 *
 * Two headers, in this order:
 *
 *  1. `Origin`. Every browser sends it on a cross-origin POST, and a page on
 *     another site cannot forge it. If it is there and it is not ours, no.
 *  2. No `Origin` at all is the old-browser case, and also what a same-origin
 *     form POST used to look like. `Sec-Fetch-Site` breaks the tie: the
 *     browser sets it and the page cannot, so only `same-origin` is accepted
 *     and `cross-site`, `same-site` and `none` are refusals. A browser too old
 *     to send EITHER header is let through: refusing it would lock the sign-out
 *     button on exactly the cheap phone this app is for, and the worst a forged
 *     sign-out can do is cost one sign-in.
 */
function sameSite({ origin, secFetchSite, siteOrigin }: SignOutInput): boolean {
  if (typeof origin === 'string' && origin.length > 0) {
    // A sandboxed iframe sends the literal text `null`, which equals no
    // origin of ours and is refused right here.
    return typeof siteOrigin === 'string' && origin === siteOrigin;
  }
  if (typeof secFetchSite === 'string' && secFetchSite.length > 0) {
    return secFetchSite === 'same-origin';
  }
  return true;
}

export async function handleSignOut(input: SignOutInput): Promise<SignOutReply> {
  const { session, client } = input;

  // FIRST, before the token is touched: a refusal must revoke nothing and
  // clear nothing, or the attack worked anyway.
  if (!sameSite(input)) {
    return { status: 403, location: SIGN_IN_PATH, clearCookie: false };
  }

  if (session && client.isConfigured()) {
    try {
      await client.signOut(session.accessToken);
    } catch {
      // Swallowed on purpose: the cookie still goes.
    }
  }
  return { status: 303, location: SIGN_IN_PATH, clearCookie: true };
}
