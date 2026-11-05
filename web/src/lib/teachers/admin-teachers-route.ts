/**
 * The decision logic behind POST /api/admin/teachers
 * (issue 05-teacher-invite-approval).
 *
 * Approving a teacher. Kept out of the route file so the tests can drive it
 * directly, the same split as `guard.ts` / `middleware.ts`.
 *
 * Order of checks: session, then role, then config, then the body. A caller
 * who is not an admin gets the same 403 whether or not Supabase is set up, so
 * this route cannot be used to probe the deployment.
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `teachers_admin_all` RLS policy plus the `teachers_block_admin_fields`
 * trigger inside Postgres (V19). Replies carry a fixed message, so a policy
 * name never reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import type { TeachersClient } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminTeachersInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: TeachersClient;
}

export interface AdminTeachersReply {
  status: number;
  body: { ok: true } | { error: string };
}

function fail(status: number, error: string): AdminTeachersReply {
  return { status, body: { error } };
}

function readUserId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { userId } = body as Record<string, unknown>;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) return null;
  return userId;
}

export async function handleAdminTeachers({
  body,
  session,
  client,
}: AdminTeachersInput): Promise<AdminTeachersReply> {
  if (!session) return fail(401, 'sign in');
  if (session.role !== 'admin') return fail(403, 'forbidden');
  if (!client.isConfigured()) return fail(503, 'not configured');

  const userId = readUserId(body);
  if (!userId) return fail(400, 'bad request');

  try {
    // The admin's own id goes into `approved_by`, so an approval is traceable.
    await client.approve({ userId, approvedBy: session.userId });
  } catch {
    // Fixed message: the thrown error may quote Postgres.
    return fail(502, 'save failed');
  }

  return { status: 200, body: { ok: true } };
}
