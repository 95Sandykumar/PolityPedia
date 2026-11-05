/**
 * The YouTube link parser (issue 08-videos-tile).
 *
 * V6 and PRD F-C1: YOUTUBE LINKS ONLY. This file is that rule, written once.
 * Pure string work: no network call, no key, nothing lazy to read, so both the
 * route handler and the teacher's page can use the same function and can never
 * disagree about what a valid link is.
 *
 * Four forms, which is what a teacher actually copies out of YouTube:
 *
 *   https://www.youtube.com/watch?v=<id>
 *   https://youtu.be/<id>
 *   https://www.youtube.com/shorts/<id>
 *   https://www.youtube.com/embed/<id>
 *
 * Anything else returns null, and the caller shows "That is not a YouTube
 * link". A bare id is refused too: the teacher is asked for a link, so taking
 * loose text would make the error message a lie.
 *
 * SECURITY. The host is compared against a fixed list, never with
 * `endsWith('youtube.com')`, so `youtube.com.evil.test` does not pass. The id
 * is then checked against the exact 11-character YouTube shape, which is what
 * keeps a crafted value out of an `<img src>` and out of a REST URL.
 */

/** The exact shape of a YouTube video id. The DB check constraint matches it. */
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Hosts we accept. Whole-string comparison, never a suffix test. */
const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
]);

/** Path prefixes that carry the id in the next segment. */
const PATH_FORMS = ['shorts', 'embed'];

function isYouTubeId(value: unknown): value is string {
  return typeof value === 'string' && YOUTUBE_ID_RE.test(value);
}

/**
 * The 11-character video id, or null when this is not a YouTube video link.
 *
 * Never throws: a teacher pastes anything, and anything is a null here.
 */
export function parseYouTubeId(input: string): string | null {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Not a URL at all. V6 asks for a link, so this is a no.
    return null;
  }

  // http and https only. Blocks javascript: and data: before anything else.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  // `?v=` wins when it is there: that is the canonical watch link, and
  // YouTube itself ignores the path when `v` is present.
  const v = url.searchParams.get('v');
  if (isYouTubeId(v)) return v;

  // Everything else carries the id in the path. `youtu.be/<id>` has it first;
  // `/shorts/<id>` and `/embed/<id>` have it second.
  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  if (segments.length === 1 && isYouTubeId(segments[0])) return segments[0];
  if (segments.length === 2 && PATH_FORMS.includes(segments[0]) && isYouTubeId(segments[1])) {
    return segments[1];
  }

  return null;
}

/** True for a value this module would have produced. Guards the URL builders. */
export function isValidYouTubeId(value: unknown): value is string {
  return isYouTubeId(value);
}

function checked(youtubeId: string): string {
  if (!isYouTubeId(youtubeId)) throw new Error('not a YouTube video id');
  return youtubeId;
}

/**
 * The thumbnail the issue names. `hqdefault.jpg` exists for every video, so
 * there is no 404 state to design for, and it is 480 x 360 which covers a
 * phone tile at 2x.
 *
 * Throws for an id it would not have parsed, so a bad value can never reach
 * an `<img src>`.
 */
export function youTubeThumbUrl(youtubeId: string): string {
  return `https://i.ytimg.com/vi/${checked(youtubeId)}/hqdefault.jpg`;
}

/** Where a tile sends the student. V6: we link out, we do not embed. */
export function youTubeWatchUrl(youtubeId: string): string {
  return `https://www.youtube.com/watch?v=${checked(youtubeId)}`;
}
