/**
 * The decision logic behind the four batch routes (issue 19-batches):
 *
 *   POST /api/teacher/batches                        -> create or rename
 *   POST /api/teacher/batches/<batchId>/members      -> remove one student
 *   POST /api/teacher/batches/<batchId>/sets         -> a set is free, or not
 *   POST /api/batches/join                           -> a student joins
 *
 * Kept out of the route files so the tests can drive it directly, the same
 * split as `mocks-route.ts` / its routes.
 *
 * Order of checks: session, role, config, then the body. A body is never
 * looked at before we know who is asking.
 *
 * WHO the batch belongs to is never in the body. It comes from the session, so
 * there is no field a caller could set to make a batch under another teacher's
 * name. A `joinCode` in the body is dropped too: the column default owns it.
 *
 * THE JOIN IS NOT BEHIND THE TEACHER GATE. Joining is what a student does, so
 * `handleJoinBatch` asks for a session and nothing else. It is the one route
 * here a student is meant to reach.
 *
 * Security: this is defence in depth, not the gate. The gate is the `batch_*`
 * policies plus `join_batch()` inside Postgres, and the triggers that keep
 * `set_access` in step. Replies carry a fixed short word, so a policy name, a
 * constraint name or a Postgres message never reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import {
  isUuid,
  normalizeJoinCode,
  readBatchName,
  type Batch,
  type BatchesClient,
} from './types';

type Refusal = { status: number; body: { error: string } };

export interface SaveBatchInput {
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: BatchesClient;
}

export interface SaveBatchReply {
  status: number;
  body: { ok: true; batch: Batch } | { error: string };
}

export interface RemoveMemberInput {
  batchId: string;
  body: unknown;
  session: AuthSession | null;
  client: BatchesClient;
}

export interface SetBatchSetInput {
  batchId: string;
  body: unknown;
  session: AuthSession | null;
  client: BatchesClient;
}

export interface OkReply {
  status: number;
  body: { ok: true } | { error: string };
}

export interface JoinBatchInput {
  body: unknown;
  session: AuthSession | null;
  client: BatchesClient;
}

export interface JoinBatchReply {
  status: number;
  body: { ok: true; batchId: string } | { error: string };
}

/** Null when the caller may write a batch, or the reply that turns them away. */
function refuseTeacher(
  session: AuthSession | null,
  client: BatchesClient,
): Refusal | null {
  if (!session) return { status: 401, body: { error: 'sign in' } };
  // A student owns no batches: `batches.teacher_id` references
  // `teachers.user_id`, so Postgres would refuse it anyway. An admin outranks
  // a teacher and is let through.
  if (session.role === 'student') return { status: 403, body: { error: 'teachers only' } };
  if (!client.isConfigured()) return { status: 503, body: { error: 'not configured' } };
  return null;
}

export async function handleSaveBatch({
  body,
  session,
  client,
}: SaveBatchInput): Promise<SaveBatchReply> {
  const refused = refuseTeacher(session, client);
  if (refused) return refused;

  // Trims, and refuses a blank or over-long name the same way
  // `batches_name_check` would.
  const name = readBatchName(body);
  if (!name) return { status: 400, body: { error: 'bad request' } };

  // Null means "a new batch". Anything else must be a real uuid, because it
  // goes into a URL.
  let id: string | null = null;
  const raw = (body ?? {}) as Record<string, unknown>;
  if (raw.id !== null && raw.id !== undefined) {
    if (!isUuid(raw.id)) return { status: 400, body: { error: 'bad request' } };
    id = raw.id;
  }

  try {
    // Only the two fields a teacher may choose travel. A `teacherId` or a
    // `joinCode` in the body is dropped right here by not being read.
    const batch = await client.saveBatch({ id, name });
    return { status: 200, body: { ok: true, batch } };
  } catch {
    // Fixed message: the thrown error may quote a policy.
    return { status: 502, body: { error: 'save failed' } };
  }
}

export async function handleRemoveMember({
  batchId,
  body,
  session,
  client,
}: RemoveMemberInput): Promise<OkReply> {
  const refused = refuseTeacher(session, client);
  if (refused) return refused;

  if (!isUuid(batchId)) return { status: 400, body: { error: 'bad request' } };

  const userId = (body as Record<string, unknown> | null)?.userId;
  if (!isUuid(userId)) return { status: 400, body: { error: 'bad request' } };

  try {
    // The trigger in 0019 takes the batch's free sets off this student in the
    // same transaction, so there is nothing else for this route to undo.
    await client.removeMember(batchId, userId);
    return { status: 200, body: { ok: true } };
  } catch {
    return { status: 502, body: { error: 'remove failed' } };
  }
}

export async function handleSetBatchSet({
  batchId,
  body,
  session,
  client,
}: SetBatchSetInput): Promise<OkReply> {
  const refused = refuseTeacher(session, client);
  if (refused) return refused;

  if (!isUuid(batchId)) return { status: 400, body: { error: 'bad request' } };

  const raw = (body ?? {}) as Record<string, unknown>;
  if (!isUuid(raw.setId)) return { status: 400, body: { error: 'bad request' } };
  // A missing `free` is a 400 and never a guess. Guessing "true" gives a Rs
  // 399 set away; guessing "false" takes one back off a batch that paid for
  // it with their enrolment.
  if (typeof raw.free !== 'boolean') return { status: 400, body: { error: 'bad request' } };

  try {
    if (raw.free) await client.addSet(batchId, raw.setId);
    else await client.dropSet(batchId, raw.setId);
    return { status: 200, body: { ok: true } };
  } catch {
    return { status: 502, body: { error: 'save failed' } };
  }
}

export async function handleJoinBatch({
  body,
  session,
  client,
}: JoinBatchInput): Promise<JoinBatchReply> {
  // A STUDENT route. No role check: joining a batch is the whole point of the
  // code a teacher shared with them.
  if (!session) return { status: 401, body: { error: 'sign in' } };
  if (!client.isConfigured()) return { status: 503, body: { error: 'not configured' } };

  const code = normalizeJoinCode((body as Record<string, unknown> | null)?.code);
  // A string that cannot be a join code at all is answered here, with no
  // request: the ambiguous characters are not in the alphabet, so it was
  // mistyped.
  if (!code) return { status: 400, body: { error: 'bad code' } };

  try {
    const batchId = await client.join(code);
    return { status: 200, body: { ok: true, batchId } };
  } catch (cause) {
    // 404 and the SAME short word as the 400. A student does not need to be
    // told whether a code is badly shaped or simply unknown, and telling them
    // would turn this route into a code oracle.
    if ((cause as Error)?.name === 'JoinNotFound') {
      return { status: 404, body: { error: 'bad code' } };
    }
    return { status: 502, body: { error: 'join failed' } };
  }
}
