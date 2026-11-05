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
 * Security: nothing here is logged, and the reply carries no token.
 */
import { SIGN_IN_PATH } from './guard';
import type { AuthSession } from './session';
import type { ServerAuthClient } from './types';

export interface SignOutReply {
  /** 303: the browser follows it with a GET, so Back does not re-post. */
  status: 303;
  location: string;
  clearCookie: true;
}

export async function handleSignOut({
  session,
  client,
}: {
  session: AuthSession | null;
  client: ServerAuthClient;
}): Promise<SignOutReply> {
  if (session && client.isConfigured()) {
    try {
      await client.signOut(session.accessToken);
    } catch {
      // Swallowed on purpose: the cookie still goes.
    }
  }
  return { status: 303, location: SIGN_IN_PATH, clearCookie: true };
}
