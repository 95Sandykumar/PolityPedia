/**
 * Supabase Storage FileStore for explanation audio
 * (issue 25-revision-audio).
 *
 * The same `FileStore` interface issue 10 wrote for paper PDFs, pointed at
 * the `explanation-audio` bucket instead of `papers`. A separate bucket, not
 * a flag on the papers one: a paper PDF is read by one teacher's students, an
 * explanation audio by everybody, so the two want different storage policies.
 *
 * Plain `fetch`, env read lazily inside every call, no SDK, no service-role
 * key: every call carries the SIGNED-IN STUDENT'S own access token, so the
 * bucket's storage policies decide, exactly like RLS does for a table
 * (web/CLAUDE.md).
 *
 * The bucket is PRIVATE. A student never gets a public URL; they get a signed
 * one from GET /api/revision/audio, for a row RLS already let them read.
 *
 * `x-upsert: true`, unlike the papers store. The path is DERIVED from
 * (question, language), so a retry after a half-finished upload writes the
 * same object on purpose. Refusing the overwrite would leave an explanation
 * permanently silent.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import type { FileStore } from '@/lib/papers/types';
import { AUDIO_BUCKET, AUDIO_URL_SECONDS } from './audio';

export interface SupabaseAudioStoreOptions {
  /** The caller's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** Storage wants the slashes, so each SEGMENT is encoded, not the path. */
function encodePath(path: string): string {
  return path
    .split('/')
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
    .join('/');
}

export function createSupabaseAudioStore(options: SupabaseAudioStoreOptions): FileStore {
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
      const res = await doFetch(`${url}/storage/v1/object/${AUDIO_BUCKET}/${encodePath(path)}`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          authorization: 'Bearer ' + options.accessToken,
          'content-type': contentType,
          // See the note at the top: the path is derived, so an overwrite is
          // the retry working, not a collision.
          'x-upsert': 'true',
        },
        // A fresh copy, so the caller's buffer cannot be a shared view.
        body: new Uint8Array(bytes) as unknown as BodyInit,
        cache: 'no-store',
      });
      // The status only: the body quotes the storage policy by name.
      if (!res.ok) throw new Error('Supabase audio upload failed with status ' + res.status);
    },

    async signedUrl(path: string, expiresInSeconds = AUDIO_URL_SECONDS) {
      const found = env();
      if (!found) return null;

      const res = await doFetch(
        `${found.url}/storage/v1/object/sign/${AUDIO_BUCKET}/${encodePath(path)}`,
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

      // Supabase answers with a path relative to `/storage/v1`.
      const signed = body.signedURL.startsWith('/') ? body.signedURL : '/' + body.signedURL;
      return `${found.url}/storage/v1${signed}`;
    },

    /**
     * The whole object as bytes.
     *
     * Part of the `FileStore` interface, and nothing in this slice calls it:
     * a student plays the audio from a signed URL, so the bytes never pass
     * through our own server. Implemented rather than thrown so the
     * interface stays honest for the next caller.
     */
    async download(path: string) {
      const found = env();
      if (!found) return null;

      const res = await doFetch(
        `${found.url}/storage/v1/object/${AUDIO_BUCKET}/${encodePath(path)}`,
        {
          method: 'GET',
          headers: {
            apikey: found.anonKey,
            authorization: 'Bearer ' + options.accessToken,
          },
          cache: 'no-store',
        },
      );
      if (!res.ok) return null;

      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
