/**
 * The video title, read once from YouTube oEmbed (issue 08-videos-tile).
 *
 * This is the ONLY outside call in the slice, and it needs no key: the public
 * oEmbed endpoint answers for any public video. That is why V6 can show a real
 * title while "no YouTube Data API" stays true (issue notes).
 *
 * `fetch` is injected, so tests fake the answer and make no real network call
 * (web/CLAUDE.md).
 *
 * FAILS SOFT, always. A private video, a rate limit or a dead network returns
 * null, and the row is stored with no title; the page then shows the teacher
 * name instead. Adding a video must not depend on YouTube being up.
 *
 * Security: the title is foreign text. It is trimmed and cut to the stored
 * length here, and React escapes it when it is rendered. Nothing is logged.
 */
import { MAX_VIDEO_TITLE_LENGTH, type VideoMeta } from './types';
import { isValidYouTubeId, youTubeWatchUrl } from './youtube-url';

/** Keyless. `url=` plus `format=json` is the whole request. */
export const OEMBED_ENDPOINT = 'https://www.youtube.com/oembed';

/** YouTube is not on our critical path, so do not wait long for it. */
const TIMEOUT_MS = 4_000;

export interface OEmbedVideoMetaOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createOEmbedVideoMeta(options: OEmbedVideoMetaOptions = {}): VideoMeta {
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  return {
    async readTitle(youtubeId: string): Promise<string | null> {
      // Checked before it goes into a URL, and before any request is made.
      if (!isValidYouTubeId(youtubeId)) return null;

      const target =
        `${OEMBED_ENDPOINT}?url=${encodeURIComponent(youTubeWatchUrl(youtubeId))}` +
        '&format=json';

      try {
        const res = await doFetch(target, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        });
        if (!res.ok) return null;

        const body = (await res.json()) as unknown;
        if (typeof body !== 'object' || body === null) return null;

        const { title } = body as { title?: unknown };
        if (typeof title !== 'string') return null;

        const clean = title.trim().slice(0, MAX_VIDEO_TITLE_LENGTH);
        return clean.length > 0 ? clean : null;
      } catch {
        // A timeout, a DNS failure or malformed JSON. All the same answer:
        // no title, and the caller stores the row anyway.
        return null;
      }
    },
  };
}
