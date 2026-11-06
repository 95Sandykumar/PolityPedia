/**
 * Server-side ExplanationAudioClient over the Supabase REST API
 * (issue 25-revision-audio).
 *
 * Plain `fetch`, so there is no SDK to ship to the browser and `fetch` can be
 * injected in tests. The env is read lazily inside every call, so importing
 * this file can never break a build that has no environment variables
 * (web/CLAUDE.md).
 *
 * Authorisation: TWO KEYS, split the same way as `supabase-ai-client.ts`
 * (issue 41-ai-finish-server-only).
 *
 *  * `claimAudio` carries the SIGNED-IN STUDENT'S OWN access token.
 *    `claim_explanation_audio()` reads `auth.uid()` from it, so the question
 *    visibility rule, the exam lock and the race are decided by Postgres for
 *    the right person.
 *  * `finishAudio` and `failAudio` carry the SERVER-ONLY key, through
 *    `createAiServiceRpc()`. Both are granted to `service_role` alone since
 *    `0040_ai_finish_server_only.sql`: a student holding their own voice
 *    claim secret could otherwise cancel a voice call that was still running,
 *    and the next read would start, and bill, a second one for the same
 *    words. There is NO fallback to the student's token: with no key set,
 *    both throw.
 *
 * Security: tokens and keys are secrets. No console call lives in this file,
 * and the errors it throws carry a fixed message plus the HTTP status, never
 * a response body.
 */
import { readSupabaseEnv, type SupabaseEnv } from '@/lib/auth/env';
import { createAiServiceRpc } from './service-env';
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

  // The server-only caller for `finishAudio` and `failAudio` (issue 41). It
  // reads its own env inside every call, so this line costs nothing at import
  // time.
  const serviceRpc = createAiServiceRpc({ env: options.env, fetchImpl: options.fetchImpl });

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
      // THE SERVER-ONLY KEY, never the student's token (issue 41). With no
      // key set this throws, and `makeExplanationAudio` treats the throw the
      // way it treats any other failure: it releases the slot and the
      // explanation simply has no narration yet.
      const saved = await serviceRpc('finish_explanation_audio', {
        question_id: request.questionId,
        lang: request.lang,
        audio_path: path,
        // The claim's own secret (issue 37-ai-claim-secret).
        claim_secret: secret,
      });
      return saved === true;
    },

    async failAudio(request: RevisionRequest, secret: string | null): Promise<void> {
      // The server-only key again (issue 41): releasing a voice call we are
      // still paying for is our decision, not the student's browser's.
      await serviceRpc('fail_explanation_audio', {
        question_id: request.questionId,
        lang: request.lang,
        // No secret, no release: the claimant's browser must not be able to
        // cancel a voice call we are still paying for.
        claim_secret: secret,
      });
    },
  };
}
