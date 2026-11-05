/**
 * Supabase Storage FileStore (issue 10-papers-upload-browse).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build with no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: every call carries the SIGNED-IN USER'S own access token.
 * There is no service-role key here, so the bucket's own storage policies
 * decide, exactly like RLS does for a table.
 *
 * The bucket is PRIVATE. A student never gets a public URL; they get a signed
 * one that dies after `SIGNED_URL_SECONDS`, minted on the server for a paper
 * the `papers_select_live` policy already let them read.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import { PAPERS_BUCKET, SIGNED_URL_SECONDS, type FileStore } from './types';

export interface SupabaseFileStoreOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** `papers/2024.pdf` -> `papers%2F2024.pdf` would break Storage: it wants the
 * slashes. Each SEGMENT is encoded instead. */
function encodePath(path: string): string {
  return path
    .split('/')
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
    .join('/');
}

export function createSupabaseFileStore(options: SupabaseFileStoreOptions): FileStore {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async upload({ path, contentType, bytes }) {
      const { url, anonKey } = required();
      const res = await doFetch(
        `${url}/storage/v1/object/${PAPERS_BUCKET}/${encodePath(path)}`,
        {
          method: 'POST',
          headers: {
            apikey: anonKey,
            authorization: 'Bearer ' + options.accessToken,
            'content-type': contentType,
            // Never overwrite. A path carries a fresh id, so a collision means
            // something is wrong and silently replacing a PDF would be worse.
            'x-upsert': 'false',
          },
          // A fresh copy, so the caller's buffer cannot be a shared view.
          body: new Uint8Array(bytes) as unknown as BodyInit,
          cache: 'no-store',
        },
      );
      // The status only: the body quotes the storage policy by name.
      if (!res.ok) throw new Error('Supabase paper upload failed with status ' + res.status);
    },

    async signedUrl(path: string, expiresInSeconds = SIGNED_URL_SECONDS) {
      const found = env();
      if (!found) return null;

      const res = await doFetch(
        `${found.url}/storage/v1/object/sign/${PAPERS_BUCKET}/${encodePath(path)}`,
        {
          method: 'POST',
          headers: {
            apikey: found.anonKey,
            authorization: 'Bearer ' + options.accessToken,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ expiresIn: expiresInSeconds }),
          cache: 'no-store',
        },
      );
      // No URL is a 404 for the caller, never a 500: the row may point at a
      // file that was removed.
      if (!res.ok) return null;

      const body = (await res.json()) as { signedURL?: unknown };
      if (typeof body?.signedURL !== 'string' || body.signedURL.length === 0) return null;

      // Supabase answers with a path like `/object/sign/papers/...`, relative
      // to `/storage/v1`.
      const signed = body.signedURL.startsWith('/') ? body.signedURL : '/' + body.signedURL;
      return `${found.url}/storage/v1${signed}`;
    },

    /**
     * The whole object as bytes (issue 12-pdf-split-worker).
     *
     * Only the split worker calls this, and it runs on the laptop, so the
     * 30 MB cap from `MAX_PDF_BYTES` is the real bound on what lands in
     * memory. A page never calls it: a student gets a signed URL instead, so
     * their download never passes through our server.
     */
    async download(path: string) {
      const found = env();
      if (!found) return null;

      const res = await doFetch(
        `${found.url}/storage/v1/object/${PAPERS_BUCKET}/${encodePath(path)}`,
        {
          method: 'GET',
          headers: {
            apikey: found.anonKey,
            authorization: 'Bearer ' + options.accessToken,
          },
          cache: 'no-store',
        },
      );
      // A missing object is null, never an error: the row can point at a file
      // somebody removed, and the worker turns that into a `no-pdf` job error.
      if (!res.ok) return null;

      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
