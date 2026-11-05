/**
 * Route guards plus token renewal (issue 03-sign-in, 33-session-refresh).
 *
 * Thin adapter. Every rule lives in `@/lib/auth/session-middleware`, which the
 * tests drive directly with a fake auth client.
 */
import { type NextRequest, type NextResponse } from 'next/server';
import { respondToRequest } from '@/lib/auth/session-middleware';
import { createSupabaseAuthClient } from '@/lib/auth/supabase-auth-client';

export function middleware(request: NextRequest): Promise<NextResponse> {
  return respondToRequest({ request, client: createSupabaseAuthClient() });
}

// B7: skip `_next/static`, `_next/image` and any path with a file extension.
// Next reads `config` at build time, so the matcher must be a literal string here,
// not an imported constant. A test keeps it equal to MIDDLEWARE_MATCHER in guard.ts.
export const config = { matcher: ['/((?!_next/static|_next/image|.*\\.[^/]+$).*)'] };
