/**
 * Browser-side videos client (issue 08-videos-tile).
 *
 * The page never holds a Supabase key and never sees a token. It posts to our
 * own route handler; that reads the teacher's access token out of the httpOnly
 * session cookie and lets Postgres RLS decide.
 *
 * `add` sends the RAW pasted link, not an id. The route runs
 * `parseYouTubeId`, so there is exactly one parser in the app and the server
 * never trusts a client-side parse. The page still parses too, but only to
 * show "That is not a YouTube link" without a round trip.
 *
 * Security: the thrown message is the HTTP status only, so a Postgres policy
 * name is never echoed back into the page.
 */
import type { BrowserVideosClient } from './types';

export const TEACHER_VIDEOS_PATH = '/api/teacher/videos';

async function post(doFetch: typeof fetch, body: unknown): Promise<void> {
  const res = await doFetch(TEACHER_VIDEOS_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Request failed with status ' + res.status);
}

export function createBrowserVideosClient(fetchImpl?: typeof fetch): BrowserVideosClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);
  return {
    add(url: string) {
      return post(doFetch, { action: 'add', url });
    },
    remove(id: string) {
      return post(doFetch, { action: 'remove', id });
    },
    setVisible(visible: boolean) {
      return post(doFetch, { action: 'visible', visible });
    },
  };
}
