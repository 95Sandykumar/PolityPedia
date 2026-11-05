/**
 * The decision logic behind PATCH /api/teacher/explanations
 * (issue 24-revision-teacher-edit).
 *
 * Kept out of the route file so the tests can drive it directly, the same
 * split as `posts-route.ts` / its route.
 *
 * Order of checks: session, then role, then config, then the body.
 *
 * WHO is editing is never in the body. It comes from the httpOnly session
 * cookie, so there is no field a caller could set to correct another
 * teacher's explanation.
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `ai_explanations_update_owner` policy and the `ai_explanations_teacher_edit`
 * trigger inside Postgres (`0024_teacher_edit.sql`). Replies carry a fixed
 * message, so a policy name never reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import {
  readEditRequest,
  type TeacherExplanation,
  type TeacherExplanationsClient,
} from './teacher-edit';

export interface EditExplanationRouteInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: TeacherExplanationsClient;
}

export interface EditExplanationReply {
  status: number;
  body: { ok: true; explanation: TeacherExplanation } | { error: string };
}

function fail(status: number, error: string): EditExplanationReply {
  return { status, body: { error } };
}

/**
 * Only an APPROVED teacher may correct AI text. Fails closed: a missing
 * status is read as pending, so an old cookie cannot edit. Same rule as the
 * middleware guard for `/teacher/*` (issue 05), repeated here because a route
 * is reachable without ever loading a page.
 */
function mayEdit(session: AuthSession): boolean {
  return session.role === 'teacher' && session.teacherStatus === 'approved';
}

export async function handleEditExplanation({
  body,
  session,
  client,
}: EditExplanationRouteInput): Promise<EditExplanationReply> {
  if (!session) return fail(401, 'sign in');
  if (!mayEdit(session)) return fail(403, 'forbidden');
  if (!client.isConfigured()) return fail(503, 'not configured');

  const wanted = readEditRequest(body);
  if (!wanted) return fail(400, 'bad request');

  let saved: TeacherExplanation | null;
  try {
    saved = await client.edit(wanted);
  } catch {
    // Fixed message: the thrown error may quote Postgres.
    return fail(502, 'save failed');
  }

  // No row came back, so the policy matched nothing: the question is not this
  // teacher's, or the explanation has been deleted. 404 either way, because
  // "not yours" and "not there" must look the same from outside. Telling the
  // two apart would turn this route into a way to probe other teachers' rows.
  if (!saved) return fail(404, 'not found');

  return { status: 200, body: { ok: true, explanation: saved } };
}
