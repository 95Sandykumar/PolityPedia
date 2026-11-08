/**
 * The decision logic behind the archive routes (issue 45-keep-money-and-scores):
 *
 *   DELETE /api/teacher/mock-sets/<id>            -> { result: 'deleted' | 'archived' }
 *   DELETE /api/teacher/mock-tests/<id>           -> the same
 *   DELETE /api/teacher/papers/<id>               -> the same
 *   DELETE /api/teacher/batches/<id>              -> the same
 *   POST   .../<id>/restore                       -> { ok: true }
 *
 * Kept out of the route files so the tests drive it directly.
 *
 * Order of checks: session, role, config, then the id. Whether a row is hard
 * deleted or archived is decided by Postgres (`remove_*()`), never here: the
 * route cannot be talked into erasing a payment because it has no way to ask
 * for a hard delete at all.
 *
 * Security: defence in depth, not the gate. The gate is the function's own
 * `auth.uid()` ownership check. Replies carry a fixed short word, so a
 * constraint name or a Postgres message never reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import type { ArchiveClient, ArchiveKind, RemoveResult } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ArchiveInput {
  kind: ArchiveKind;
  id: string;
  session: AuthSession | null;
  client: ArchiveClient;
}

export interface RemoveReply {
  status: number;
  body: { ok: true; result: RemoveResult } | { error: string };
}

export interface RestoreReply {
  status: number;
  body: { ok: true } | { error: string };
}

/** Null when the caller may go on, or the reply that turns them away. */
function refuseCaller(
  session: AuthSession | null,
  client: ArchiveClient,
  id: string,
): { status: number; body: { error: string } } | null {
  if (!session) return { status: 401, body: { error: 'sign in' } };
  // A student owns nothing here. An admin outranks a teacher and is let in;
  // the function still checks the row is theirs.
  if (session.role === 'student') return { status: 403, body: { error: 'teachers only' } };
  if (!client.isConfigured()) return { status: 503, body: { error: 'not configured' } };
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return { status: 400, body: { error: 'bad request' } };
  }
  return null;
}

export async function handleRemove({
  kind,
  id,
  session,
  client,
}: ArchiveInput): Promise<RemoveReply> {
  const refused = refuseCaller(session, client, id);
  if (refused) return refused;

  try {
    const result = await client.remove(kind, id);
    return { status: 200, body: { ok: true, result } };
  } catch (cause) {
    // 404, not 403: "that exists but is not yours" is nobody's business.
    if ((cause as Error)?.name === 'ArchiveNotFound') {
      return { status: 404, body: { error: 'not found' } };
    }
    return { status: 502, body: { error: 'remove failed' } };
  }
}

export async function handleRestore({
  kind,
  id,
  session,
  client,
}: ArchiveInput): Promise<RestoreReply> {
  const refused = refuseCaller(session, client, id);
  if (refused) return refused;

  try {
    await client.restore(kind, id);
    return { status: 200, body: { ok: true } };
  } catch (cause) {
    switch ((cause as Error)?.name) {
      case 'ArchiveNotFound':
        return { status: 404, body: { error: 'not found' } };
      // 30 days are over. A conflict with the row's state, not a bad request.
      case 'RestoreWindowOver':
        return { status: 409, body: { error: 'window over' } };
      default:
        return { status: 502, body: { error: 'restore failed' } };
    }
  }
}
