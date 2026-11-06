/**
 * The SERVER-ONLY Supabase caller for the AI claim's finish and fail
 * (issue 41-ai-finish-server-only).
 *
 * WHY THIS EXISTS. `0040_ai_finish_server_only.sql` revoked EXECUTE on
 * `finish_ai_explanation`, `fail_ai_explanation`, `finish_explanation_audio`
 * and `fail_explanation_audio` from `authenticated`, and granted it to
 * `service_role` alone. Before that a student on the AI plan could claim from
 * the browser, be handed their own secret, and then post
 * `rpc/finish_ai_explanation` with text THEY wrote. Every student who opened
 * that question read it afterwards.
 *
 * So the four calls need a different key from the ones around them. The two
 * CLAIM calls still carry the student's own access token, because the plan
 * gate, the mock paywall, the exam lock and the 30-a-day cap all read
 * `auth.uid()` and must keep reading the student's own.
 *
 * Security.
 *  * `SUPABASE_SERVICE_ROLE_KEY` bypasses every RLS policy in the database.
 *    It has NO `NEXT_PUBLIC_` prefix, so Next.js cannot inline it into a
 *    browser bundle, and nothing under a client component imports this file.
 *  * The env is read lazily inside a function (web/CLAUDE.md), so importing
 *    this file can never break `npm run build` or `npm test` with no
 *    environment variables set.
 *  * THERE IS NO FALLBACK TO THE STUDENT'S TOKEN. A missing key THROWS. That
 *    is the safe direction: the route turns the throw into the normal failure
 *    path, the student is told to try again, and the stale-claim rule in
 *    `claim_ai_explanation()` gives the 1 of 30 back when the next reader
 *    takes the claim over. Falling back would mean a 403 from Postgres that
 *    looked like "saved nothing", or worse, a key the browser could hold.
 *  * No console call lives in this file. The errors it throws carry a fixed
 *    message plus the HTTP status, NEVER a response body and never the key:
 *    a PostgREST body quotes constraint names and a 401 body can echo a
 *    token.
 */

const RPC = '/rest/v1/rpc/';

export interface AiServiceEnv {
  /** Project URL with no trailing slash. */
  url: string;
  /** The service-role key. Bypasses RLS. Never logged, never sent onward. */
  serviceRoleKey: string;
}

type EnvBag = Record<string, string | undefined>;

/**
 * Supabase as OUR OWN SERVER reads it, or null when the key is not set.
 *
 * It reuses `NEXT_PUBLIC_SUPABASE_URL` (a URL is not a secret) and its own
 * key, the same three lines as `readWebhookServiceEnv` in
 * `src/lib/purchases/supabase-webhook-store.ts`. Separate readers on purpose:
 * each one documents which key its own callers hold, and a shared reader
 * would make it one edit to widen all of them at once.
 */
export function readAiServiceEnv(env: EnvBag = process.env): AiServiceEnv | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return { url: url.replace(/\/+$/, ''), serviceRoleKey };
}

export interface AiServiceRpcOptions {
  env?: EnvBag;
  fetchImpl?: typeof fetch;
}

/** Posts one SQL function call as `service_role`. */
export type AiServiceRpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * The server-only RPC caller.
 *
 * The returned function reads the env on EVERY call, so a module that is
 * imported at build time never touches `process.env` at import time.
 */
export function createAiServiceRpc(options: AiServiceRpcOptions = {}): AiServiceRpc {
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  return async function rpc(name, args) {
    const found = readAiServiceEnv(options.env ?? process.env);
    // A clear message, with no key and no hint of one, that the route turns
    // into "try again" for the student.
    if (!found) {
      throw new Error(
        'Supabase ' + name + ' needs SUPABASE_SERVICE_ROLE_KEY on the server',
      );
    }

    const { url, serviceRoleKey } = found;
    const res = await doFetch(url + RPC + name, {
      method: 'POST',
      headers: {
        // The key goes in BOTH headers, which is what PostgREST wants:
        // `apikey` for the gateway and `authorization` for the role.
        apikey: serviceRoleKey,
        authorization: 'Bearer ' + serviceRoleKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('Supabase ' + name + ' failed with status ' + res.status);
    return (await res.json()) as unknown;
  };
}
