/**
 * Server-side ExplanationAudioClient over the Supabase REST API
 * (issue 25-revision-audio).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build that has no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: the client carries the SIGNED-IN STUDENT'S OWN access token.
 * The three functions in `0025_revision_audio.sql` read `auth.uid()` from
 * that token, so the question visibility rule and the race are decided by
 * Postgres for the right person. There is no service-role key here.
 *
 * Security: tokens are secrets. No console call lives in this file, and the
 * errors it throws carry a fixed message plus the HTTP status, never a
 * response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import {
  readAudioClaimOutcome,
  type AudioClaimOutcome,
  type ExplanationAudioClient,
} from './audio';
import type { RevisionRequest } from './types';

const RPC = '/rest/v1/rpc/';

export interface SupabaseAudioClientOptions {
  /** The student's Supabase access token, from the session cookie. */
  accessToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function createSupabaseAudioClient(
  options: SupabaseAudioClientOptions,
): ExplanationAudioClient {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readSupabaseEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): SupabaseEnv {
    const found = env();
    if (!found) throw new Error('Supabase is not configured');
    return found;
  }

  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { url, anonKey } = required();
    const res = await doFetch(url + RPC + name, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: 'Bearer ' + options.accessToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('Supabase ' + name + ' failed with status ' + res.status);
    return (await res.json()) as unknown;
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    async claimAudio(request: RevisionRequest): Promise<AudioClaimOutcome> {
      // Returns `{code, secret}` since issue 37-ai-claim-secret. The secret
      // is the only copy there will ever be: the database keeps a sha256 of
      // it and nothing else. It stays in the background step's local
      // variable and never reaches a reply or a log.
      return readAudioClaimOutcome(
        await rpc('claim_explanation_audio', {
          question_id: request.questionId,
          lang: request.lang,
        }),
      );
    },

    async finishAudio(
      request: RevisionRequest,
      path: string,
      secret: string | null,
    ): Promise<boolean> {
      const saved = await rpc('finish_explanation_audio', {
        question_id: request.questionId,
        lang: request.lang,
        audio_path: path,
        // The claim's own secret (issue 37-ai-claim-secret).
        claim_secret: secret,
      });
      return saved === true;
    },

    async failAudio(request: RevisionRequest, secret: string | null): Promise<void> {
      await rpc('fail_explanation_audio', {
        question_id: request.questionId,
        lang: request.lang,
        // No secret, no release: the claimant's browser must not be able to
        // cancel a voice call we are still paying for.
        claim_secret: secret,
      });
    },
  };
}
