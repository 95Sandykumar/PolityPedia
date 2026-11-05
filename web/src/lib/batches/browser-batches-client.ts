/**
 * Browser-side batch client (issue 19-batches).
 *
 * The batch screens never hold a Supabase key and never see a token. They post
 * to our own route handlers; those read the caller's access token out of the
 * httpOnly session cookie and let Postgres RLS decide.
 *
 * The BATCH ID goes in the URL PATH, never in the body. A body is editable in
 * a browser console; the path is what the route reads, and the route hands it
 * to a client that checks the uuid shape before building a URL.
 *
 * Security: the thrown message is a short CODE of ours or the HTTP status, so
 * a Postgres policy name is never echoed into the page. The screen turns each
 * code into one line of Hindi or English.
 */
import type { Batch, BatchEdit, BrowserBatchesClient } from './types';

export const TEACHER_BATCHES_PATH = '/api/teacher/batches';

/** Our own route a student posts a join code to. */
export const JOIN_BATCH_PATH = '/api/batches/join';

/** Our own route for the roll of one batch. */
export function batchMembersPath(batchId: string): string {
  return `${TEACHER_BATCHES_PATH}/${encodeURIComponent(batchId)}/members`;
}

/** Our own route for the free sets of one batch. */
export function batchSetsPath(batchId: string): string {
  return `${TEACHER_BATCHES_PATH}/${encodeURIComponent(batchId)}/sets`;
}

/** Codes the screens turn into one short line. Never a server message. */
export type BatchesErrorCode = 'bad-code';

function post(
  doFetch: typeof fetch,
  path: string,
  body: unknown,
): Promise<Response> {
  return doFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function createBrowserBatchesClient(
  fetchImpl?: typeof fetch,
): BrowserBatchesClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async saveBatch(edit: BatchEdit): Promise<Batch> {
      const res = await post(doFetch, TEACHER_BATCHES_PATH, edit);
      if (!res.ok) throw new Error('Request failed with status ' + res.status);

      const body = (await res.json()) as { batch?: Batch };
      // A 200 with no row means something went wrong upstream. Treated as a
      // failure, so the screen never shows "saved" over an unsaved batch.
      if (!body?.batch) throw new Error('Request failed with status ' + res.status);
      return body.batch;
    },

    async removeMember(batchId: string, userId: string): Promise<void> {
      const res = await post(doFetch, batchMembersPath(batchId), { userId });
      if (!res.ok) throw new Error('Request failed with status ' + res.status);
    },

    async setFree(batchId: string, setId: string, free: boolean): Promise<void> {
      const res = await post(doFetch, batchSetsPath(batchId), { setId, free });
      if (!res.ok) throw new Error('Request failed with status ' + res.status);
    },

    async join(code: string): Promise<string> {
      const res = await post(doFetch, JOIN_BATCH_PATH, { code });

      // 400 is "that cannot be a code", 404 is "nobody has that code". The
      // student reads the same line for both, because the difference is not
      // theirs to act on: check the code and try again.
      if (res.status === 400 || res.status === 404) {
        throw new Error('bad-code' satisfies BatchesErrorCode);
      }
      if (!res.ok) throw new Error('Request failed with status ' + res.status);

      const body = (await res.json()) as { batchId?: unknown };
      if (typeof body?.batchId !== 'string' || body.batchId.length === 0) {
        throw new Error('Request failed with status ' + res.status);
      }
      return body.batchId;
    },
  };
}
