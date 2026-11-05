/**
 * The decision logic behind /api/admin/plans (issue 21-plans-entitlements).
 *
 * Kept out of the route file so the tests can drive it directly, the same
 * split as `guard.ts` / `middleware.ts`. The route file is a thin adapter.
 *
 * Order of checks matters: session, then role, then config, then the body.
 * A visitor who is not an admin gets the same 403 whether or not Supabase is
 * set up, so this route cannot be used to probe the deployment.
 *
 * Security: this is defence in depth, not the gate. The gate is the
 * `entitlements_admin_all` RLS policy inside Postgres, which checks the
 * admin's own access token. Replies carry a fixed message, never a thrown
 * error, so a policy name never reaches the browser.
 */
import type { AuthSession } from '@/lib/auth/types';
import { isPlan, type Plan, type PlansClient } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A hand-granted plan is for testing and support. A year and a bit is plenty. */
const MAX_DAYS_AHEAD = 400;
const DAY_MS = 86_400_000;

export interface AdminPlansInput {
  method: 'POST' | 'DELETE';
  /** The parsed JSON body, or anything at all: it is validated here. */
  body: unknown;
  /** Decoded session cookie, or null when nobody is signed in. */
  session: AuthSession | null;
  client: PlansClient;
}

export interface AdminPlansReply {
  status: number;
  body: { ok: true } | { error: string };
}

function fail(status: number, error: string): AdminPlansReply {
  return { status, body: { error } };
}

/** Read `userId` and `plan`, which both verbs need. */
function readTarget(body: unknown): { userId: string; plan: Plan } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { userId, plan } = body as Record<string, unknown>;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) return null;
  if (!isPlan(plan)) return null;
  return { userId, plan };
}

/** A grant also needs a `validUntil` that is in the future and not absurd. */
function readValidUntil(body: unknown, now: number): string | null {
  const { validUntil } = body as Record<string, unknown>;
  if (typeof validUntil !== 'string') return null;
  const at = Date.parse(validUntil);
  if (!Number.isFinite(at)) return null;
  // In the past is not a grant. Ending a plan is DELETE.
  if (at <= now) return null;
  if (at > now + MAX_DAYS_AHEAD * DAY_MS) return null;
  return validUntil;
}

export async function handleAdminPlans({
  method,
  body,
  session,
  client,
}: AdminPlansInput): Promise<AdminPlansReply> {
  if (!session) return fail(401, 'sign in');
  if (session.role !== 'admin') return fail(403, 'forbidden');
  if (!client.isConfigured()) return fail(503, 'not configured');

  const target = readTarget(body);
  if (!target) return fail(400, 'bad request');

  try {
    if (method === 'POST') {
      const validUntil = readValidUntil(body, Date.now());
      if (!validUntil) return fail(400, 'bad request');
      await client.grant({ ...target, validUntil });
    } else {
      await client.end(target);
    }
  } catch {
    // Fixed message: the thrown error may quote Postgres.
    return fail(502, 'save failed');
  }

  return { status: 200, body: { ok: true } };
}
