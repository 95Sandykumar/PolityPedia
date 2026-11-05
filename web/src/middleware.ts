/**
 * Route guards (issue 03-sign-in).
 *
 * Thin adapter: read the session cookie, ask the pure `guard()` for a verdict,
 * redirect or continue. All the rules live in `src/lib/auth/guard.ts`, which
 * the tests drive directly.
 *
 * This is a routing guard, not the security boundary. A forged cookie can
 * reach a page shell; it reads no data, because Postgres RLS checks the real
 * access-token JWT on every query.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { guard } from '@/lib/auth/guard';
import { SESSION_COOKIE, decodeSession } from '@/lib/auth/session';

export function middleware(request: NextRequest): NextResponse {
  const session = decodeSession(request.cookies.get(SESSION_COOKIE)?.value);
  const verdict = guard({ pathname: request.nextUrl.pathname, role: session?.role ?? null });

  if (verdict.allow) return NextResponse.next();

  const target = new URL(verdict.redirectTo, request.nextUrl.origin);
  return NextResponse.redirect(target);
}

// B7: skip `_next/static`, `_next/image` and any path with a file extension.
// Next reads `config` at build time, so the matcher must be a literal string here,
// not an imported constant. A test keeps it equal to MIDDLEWARE_MATCHER in guard.ts.
export const config = { matcher: ['/((?!_next/static|_next/image|.*\\.[^/]+$).*)'] };
