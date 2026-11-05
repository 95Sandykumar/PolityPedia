/**
 * The decision logic behind GET /api/revision/audio
 * (issue 25-revision-audio).
 *
 * Kept out of the route file so the tests drive it directly, the same split
 * as `revision-route.ts`. The route file is a thin adapter.
 *
 * WHY A ROUTE AND NOT A URL IN THE PAGE. The audio bucket is PRIVATE, like
 * the papers one, so the player needs a signed URL, and a signed URL dies
 * after an hour. Putting one in the server-rendered page would break a
 * student who left the tab open through a bus ride. This route mints a fresh
 * one per play instead, and redirects to it, so the `<audio src>` is a stable
 * path and the bytes still come straight from Supabase (never through us).
 *
 * The read goes through `AiClient.get()`, which carries the student's own
 * access token, so the `ai_explanations_select_visible` policy from 0022 is
 * the gate: no second copy of the visibility rule lives here.
 *
 * Security: replies carry a fixed code, never a thrown error, and the signed
 * URL is only ever a `Location` header. Nothing is logged.
 */
import type { FileStore } from '@/lib/papers/types';
import type { AuthSession } from '@/lib/auth/types';
import { AUDIO_URL_SECONDS, readAudioRequest } from './audio';
import type { AiClient } from './types';

export interface AudioUrlInput {
  /** The request's query string. Validated here. */
  params: URLSearchParams;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: AiClient;
  store: FileStore;
}

export type AudioUrlError = 'sign_in' | 'bad_request' | 'not_configured' | 'not_found';

/**
 * `kind` is the discriminant, not `status`. A refusal's status is a plain
 * number (401, 400, 503, 404), so a check on `status === 302` would not
 * narrow the union and the route file could not read `location`.
 */
export type AudioUrlReply =
  /** Play it from here. The bytes never pass through our server. */
  | { kind: 'play'; status: 302; location: string }
  | { kind: 'error'; status: number; error: AudioUrlError };

export async function handleAudioUrl({
  params,
  session,
  client,
  store,
}: AudioUrlInput): Promise<AudioUrlReply> {
  if (!session) return refuse(401, 'sign_in');
  if (!client.isConfigured()) return refuse(503, 'not_configured');

  const request = readAudioRequest(params);
  if (!request) return refuse(400, 'bad_request');

  try {
    const found = await client.get(request);
    // No row, or no audio yet. Both are a 404: the player asked for a file
    // that is not there, and "not yet" is not an error worth a 500.
    if (!found?.audioPath) return refuse(404, 'not_found');

    const url = await store.signedUrl(found.audioPath, AUDIO_URL_SECONDS);
    // The row can point at an object somebody removed.
    if (!url) return refuse(404, 'not_found');

    return { kind: 'play', status: 302, location: url };
  } catch {
    // A dead REST call is still just "no audio" for the player. The student
    // is reading the explanation; a 500 on an audio element would be noise.
    return refuse(404, 'not_found');
  }
}

function refuse(status: number, error: AudioUrlError): AudioUrlReply {
  return { kind: 'error', status, error };
}
