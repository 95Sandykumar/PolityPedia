/**
 * The decision logic behind POST /api/teacher/signup
 * (issue 05-teacher-invite-approval).
 *
 * Kept out of the route file so the tests can drive it directly, the same
 * split as `guard.ts` / `middleware.ts`.
 *
 * Order of checks: session, then role, then config, then the body. A caller
 * who may not redeem gets the same answer whether or not Supabase is set up,
 * so this route cannot be used to probe the deployment.
 *
 * Security: this is defence in depth, not the gate. The gate is the SQL
 * function `redeem_teacher_invite()`, which owns single use and sets the
 * status to `pending`. The reply carries a fixed message, so "already used"
 * and "never existed" look the same from outside and codes cannot be probed.
 */
import type { AuthSession } from '@/lib/auth/types';
import { MAX_INVITE_CODE_LENGTH, type TeachersClient } from './types';

export interface TeacherSignupInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: TeachersClient;
}

export interface TeacherSignupReply {
  status: number;
  body: { ok: true; status: 'pending' } | { error: string };
}

function fail(status: number, error: string): TeacherSignupReply {
  return { status, body: { error } };
}

/** A code is a short, non-empty string. Trimmed, because it was pasted. */
function readCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { code } = body as Record<string, unknown>;
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (!trimmed || trimmed.length > MAX_INVITE_CODE_LENGTH) return null;
  return trimmed;
}

export async function handleTeacherSignup({
  body,
  session,
  client,
}: TeacherSignupInput): Promise<TeacherSignupReply> {
  if (!session) return fail(401, 'sign in');
  // Only a student redeems. A teacher already has a row (the SQL function
  // refuses a second code), and an admin has no business holding one.
  if (session.role !== 'student') return fail(403, 'forbidden');
  if (!client.isConfigured()) return fail(503, 'not configured');

  const code = readCode(body);
  if (!code) return fail(400, 'bad request');

  try {
    await client.redeemInvite(code);
  } catch {
    // One message for every reason: used, unknown, or already a teacher.
    return fail(400, 'invalid code');
  }

  // Pending on purpose: an admin approves next (F-A1).
  return { status: 200, body: { ok: true, status: 'pending' } };
}
