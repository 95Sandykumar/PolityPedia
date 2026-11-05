/**
 * The decision logic behind POST /api/teacher/exams
 * (issue 07-next-exam-date-teacher-shell).
 *
 * Kept out of the route file so the tests can drive it directly, the same
 * split as `follows-route.ts` / its route.
 *
 * Order of checks: session, role, config, then the body.
 *
 * WHO the rows belong to is never in the body. It comes from the session, so
 * there is no field a caller could set to write teacher B's dates. Any
 * `teacherId` in the body is ignored.
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `teacher_exams_insert_own`, `_update_own` and `_delete_own` policies inside
 * Postgres. Replies carry a fixed message, so a policy name never reaches the
 * browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import {
  isIsoDate,
  MAX_EXAM_LABEL_LENGTH,
  type TeacherExam,
  type TeacherExamsClient,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TeacherExamsInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: TeacherExamsClient;
}

export interface TeacherExamsReply {
  status: number;
  body: { ok: true; saved: number } | { error: string };
}

function fail(status: number, error: string): TeacherExamsReply {
  return { status, body: { error } };
}

/** One row, or null when any field is the wrong shape. */
function readItem(raw: unknown): TeacherExam | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { examId, nextExamDate, label } = raw as Record<string, unknown>;

  if (typeof examId !== 'string' || !UUID_RE.test(examId)) return null;

  // Null or a real calendar day. A string like '2026-02-30' is refused here,
  // not left for Postgres to reject with a message we would have to hide.
  if (nextExamDate !== null && !isIsoDate(nextExamDate)) return null;

  if (label !== null) {
    if (typeof label !== 'string') return null;
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_EXAM_LABEL_LENGTH) return null;
  }

  return { examId, nextExamDate, label: label as string | null };
}

function readItems(body: unknown): TeacherExam[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const { items } = body as Record<string, unknown>;
  if (!Array.isArray(items)) return null;

  const out: TeacherExam[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const item = readItem(raw);
    if (!item) return null;
    // The same exam twice would be one upsert fighting itself, and the last
    // row would win silently. Refuse instead.
    if (seen.has(item.examId)) return null;
    seen.add(item.examId);
    out.push(item);
  }
  return out;
}

export async function handleTeacherExams({
  body,
  session,
  client,
}: TeacherExamsInput): Promise<TeacherExamsReply> {
  if (!session) return fail(401, 'sign in');
  // A student has no exam dates of their own: `teacher_exams.teacher_id`
  // references `teachers.user_id`, so Postgres would refuse it anyway.
  if (session.role === 'student') return fail(403, 'teachers only');
  if (!client.isConfigured()) return fail(503, 'not configured');

  const items = readItems(body);
  if (!items) return fail(400, 'bad request');

  try {
    await client.saveMine(items);
  } catch {
    // Fixed message: the thrown error may quote Postgres.
    return fail(502, 'save failed');
  }

  return { status: 200, body: { ok: true, saved: items.length } };
}
