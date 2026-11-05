/**
 * Browser-side follow client (issue 06-portfolio-follow).
 *
 * The page never holds a Supabase key and never sees a token. It posts to our
 * own route handler; that reads the student's access token out of the httpOnly
 * session cookie and lets Postgres RLS decide.
 *
 * Security: the thrown message is the HTTP status only, so a Postgres policy
 * name is never echoed back into the page.
 */
import type { BrowserFollowsClient } from './types';

export const FOLLOWS_PATH = '/api/follows';

export function createBrowserFollowsClient(fetchImpl?: typeof fetch): BrowserFollowsClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);
  return {
    async setFollowing(teacherId: string, following: boolean) {
      const res = await doFetch(FOLLOWS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teacherId, following }),
      });
      if (!res.ok) throw new Error('Request failed with status ' + res.status);
    },
  };
}
