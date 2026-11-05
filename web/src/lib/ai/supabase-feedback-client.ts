/**
 * Server-side FeedbackClient over the Supabase REST API
 * (issue 23-revision-screen).
 *
 * Plain `fetch`, so there is no SDK to ship and `fetch` can be injected in
 * tests. The env is read lazily inside every call, so importing this file can
 * never break a build that has no environment variables (web/CLAUDE.md).
 *
 * Authorisation: the client carries the SIGNED-IN STUDENT'S OWN access token,
 * and `ai_feedback.user_id` defaults to `auth.uid()`, so the row is stamped by
 * Postgres and this file never sends a user id at all. There is no
 * service-role key here.
 *
 * The upsert is `resolution=merge-duplicates` on the primary key
 * `(user_id, question_id, lang)`, so tapping the other thumb REPLACES the
 * vote: a student has one opinion, not a history of taps.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * error it throws carries only a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv } from '@/lib/auth/env';
import type { FeedbackClient, FeedbackRequest } from './feedback';

const TABLE = '/rest/v1/ai_feedback';

export interface SupabaseFeedbackClientOptions {
  /** The student's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function createSupabaseFeedbackClient(
  options: SupabaseFeedbackClientOptions,
): FeedbackClient {
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  return {
    isConfigured() {
      return env() !== null;
    },

    async save(request: FeedbackRequest): Promise<void> {
      const found = env();
      if (!found) throw new Error('Supabase is not configured');

      const res = await doFetch(`${found.url}${TABLE}`, {
        method: 'POST',
        headers: {
          apikey: found.anonKey,
          authorization: `Bearer ${options.accessToken}`,
          'content-type': 'application/json',
          // The row already exists when the student changes their mind.
          prefer: 'resolution=merge-duplicates,return=minimal',
        },
        // No `user_id`: the column defaults to `auth.uid()`.
        body: JSON.stringify({
          question_id: request.questionId,
          lang: request.lang,
          vote: request.vote,
        }),
      });

      // The status only. A body can quote a policy name or the token.
      if (!res.ok) throw new Error('Request failed with status ' + res.status);
    },
  };
}
