/**
 * Browser-side archive client (issue 45-keep-money-and-scores).
 *
 * The teacher screens never hold a Supabase key. They call our own routes;
 * those read the teacher's access token out of the httpOnly session cookie and
 * let Postgres decide whether a row is deleted or archived.
 *
 * Security: the thrown message is a short CODE of ours or the HTTP status, so
 * a Postgres policy name is never echoed into the page.
 */
import {
  archivePath,
  isRemoveResult,
  restorePath,
  type ArchiveErrorCode,
  type ArchiveKind,
  type BrowserArchiveClient,
  type RemoveResult,
} from './types';

function refuse(code: ArchiveErrorCode): never {
  throw new Error(code);
}

export function createBrowserArchiveClient(fetchImpl?: typeof fetch): BrowserArchiveClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async remove(kind: ArchiveKind, id: string): Promise<RemoveResult> {
      const res = await doFetch(archivePath(kind, id), { method: 'DELETE' });

      if (res.status === 404) refuse('not-found');
      if (!res.ok) throw new Error('Request failed with status ' + res.status);

      const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
      // No result, no claim: the screen must not say "deleted" over a guess.
      if (!isRemoveResult(body?.result)) {
        throw new Error('Request failed with status ' + res.status);
      }
      return body.result;
    },

    async restore(kind: ArchiveKind, id: string): Promise<void> {
      const res = await doFetch(restorePath(kind, id), { method: 'POST' });

      if (res.status === 404) refuse('not-found');
      if (res.status === 409) refuse('window-over');
      if (!res.ok) throw new Error('Request failed with status ' + res.status);
    },
  };
}
