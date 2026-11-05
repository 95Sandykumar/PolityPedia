/**
 * Lazy Supabase env reader (issue 03-sign-in).
 *
 * Read inside a function, never at import time, so `npm run build` and
 * `npm test` both work with no environment variables set (web/CLAUDE.md).
 * Missing keys return null and pages render a "not configured" state.
 */

export interface SupabaseEnv {
  /** Project URL with no trailing slash. */
  url: string;
  /** The publishable (anon) key. Safe for the browser; still never logged. */
  anonKey: string;
}

type EnvBag = Record<string, string | undefined>;

export function readSupabaseEnv(env: EnvBag = process.env): SupabaseEnv | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  return { url: url.replace(/\/+$/, ''), anonKey };
}
