/**
 * Browser-side saved client (issue 14-saved-list).
 *
 * The player and the Saved tab never hold a Supabase key and never see a
 * token. They post to our own route handler; that reads the student's access
 * token out of the httpOnly session cookie and lets Postgres RLS decide.
 *
 * It THROWS on failure, on purpose. The Saved tab puts the row back and says
 * "Could not remove", and it can only do that if it is told.
 *
 * Security: the thrown message is the HTTP status only, so a Postgres policy
 * name is never echoed back into the page.
 */
import { SAVED_PATH, type BrowserSavedClient, type SavedTag } from './types';

export function createBrowserSavedClient(fetchImpl?: typeof fetch): BrowserSavedClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async setSaved(questionId: string, tag: SavedTag, saved: boolean) {
      const res = await doFetch(SAVED_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questionId, tag, saved }),
        // The cookie is httpOnly and same-origin, so nothing is attached here.
      });
      if (!res.ok) throw new Error('Request failed with status ' + res.status);
    },
  };
}
