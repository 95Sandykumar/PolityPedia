/**
 * Lazy env for the split worker (issue 12-pdf-split-worker).
 *
 * Read inside a function, never at import time, so `npm run build` and
 * `npm test` both work with NO environment variables set (web/CLAUDE.md).
 * Missing keys return null and the worker stays idle instead of failing a
 * teacher's upload.
 *
 * THESE TWO KEYS ARE LAPTOP ONLY.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` bypasses every RLS policy in the database, and
 * `ANTHROPIC_API_KEY` spends money. Neither has the `NEXT_PUBLIC_` prefix, so
 * Next.js will not inline either one into a browser bundle, and nothing under
 * `src/app/` imports this file. The only reader is `web/jobs/pdf-split.ts`,
 * which PM2 runs on Boss's machine.
 */

export interface ServiceEnv {
  /** Project URL with no trailing slash. */
  url: string;
  /** The service-role key. Bypasses RLS. Never logged, never sent anywhere. */
  serviceRoleKey: string;
}

type EnvBag = Record<string, string | undefined>;

/**
 * Supabase as the WORKER reads it.
 *
 * It reuses `NEXT_PUBLIC_SUPABASE_URL` (a URL is not a secret) but needs its
 * own key, because the worker is not a signed-in user and has no access token
 * to carry.
 */
export function readServiceEnv(env: EnvBag = process.env): ServiceEnv | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return { url: url.replace(/\/+$/, ''), serviceRoleKey };
}

/** The Claude key, or null. */
export function readAnthropicKey(env: EnvBag = process.env): string | null {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}
