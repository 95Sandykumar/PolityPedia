/**
 * The one message a failed voice call is allowed to carry
 * (issue 43-h4-voice-providers).
 *
 * WHY A CONSTANT AND NOT A STRING PER PROVIDER. A voice provider's error body
 * is the worst thing in this app to pass on. ElevenLabs answers 422 with a
 * `detail` list, Google answers 403 with an `error.message`, and either can
 * quote the request, the account, or the key that was refused. So no
 * implementation of `Speech` ever puts a response body, a URL or a key into a
 * thrown message: it throws THIS plus the HTTP status, and nothing else.
 *
 * Same rule and same shape as `src/lib/ai/service-env.ts`, which already does
 * it for the Supabase service-role calls.
 *
 * The other half of the pair, `VOICE_NOT_CONFIGURED`, lives in
 * `unconfigured-speech.ts` and is reused by both real providers, so "the voice
 * is not set up" reads the same whether no provider is chosen at all or a
 * chosen one is missing a key.
 */
export const VOICE_CALL_FAILED = 'voice call failed';
