/**
 * The server reads the batch screens need (issue 19-batches).
 *
 * Server only. Every read runs HERE, with the caller's own access token out of
 * the httpOnly session cookie, so Postgres RLS decides the rows and the
 * browser never holds a key.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * Every read fails SOFT. A Supabase hiccup gives an empty list or a null
 * batch, and a page that still renders, never a 500 on a teacher's dashboard.
 */
import { headers } from 'next/headers';
import type { AuthSession } from '@/lib/auth/types';
import { createSupabaseBatchesClient } from './supabase-batches-client';
import {
  countMembers,
  setsOfBatch,
  type Batch,
  type BatchMember,
  type BatchRow,
} from './types';

export function batchesClient(session: AuthSession | null) {
  return createSupabaseBatchesClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  });
}

/**
 * Where this app is served from, for the join link a teacher copies.
 *
 * Read off the request rather than an env var, so the link is right on
 * localhost, on a Vercel preview and in production without three settings to
 * keep in step. An empty string when there is no host header at all, which
 * gives a relative link instead of one reading "undefined/join/ABC234".
 */
export async function readOrigin(): Promise<string> {
  try {
    const head = await headers();
    const host = head.get('host');
    if (!host) return '';
    // Vercel terminates TLS, so the proto header is the only honest source.
    // Default https: a join link is shared, and http would be downgraded.
    const proto = head.get('x-forwarded-proto') ?? 'https';
    return `${proto}://${host}`;
  } catch {
    // Called outside a request (a unit test, a build-time render).
    return '';
  }
}

/**
 * The teacher's own batches with their student counts.
 *
 * The counts come from ONE extra read over every batch id, not one read per
 * batch: a teacher with twelve batches should cost two requests, not thirteen.
 * `batch_members_select_own_or_teacher` is what makes the roll readable, so
 * the count is as true as the policy.
 */
export async function readMyBatches(session: AuthSession | null): Promise<BatchRow[]> {
  if (!session) return [];

  const client = batchesClient(session);
  const batches = await client.listMine().catch(() => []);
  if (batches.length === 0) return [];

  const members = await client
    .listMembers(batches.map((one) => one.id))
    .catch(() => [] as BatchMember[]);
  const counts = countMembers(members);

  return batches.map((one) => ({ ...one, studentCount: counts.get(one.id) ?? 0 }));
}

export interface BatchPageData {
  /** Null when RLS hid the row: somebody else's batch, or none at all. */
  batch: Batch | null;
  members: BatchMember[];
  /** The set ids this batch gives away free (V3). */
  freeSetIds: string[];
}

/**
 * One batch with its roll and its free sets.
 *
 * The batch is read FIRST and on its own. A null there means RLS hid the row,
 * and the two reads that follow would come back empty anyway, so they are
 * skipped: a page that says "Batch not found" should not have asked three
 * questions about it.
 */
export async function readBatchPage(
  session: AuthSession | null,
  batchId: string,
): Promise<BatchPageData> {
  const empty: BatchPageData = { batch: null, members: [], freeSetIds: [] };
  if (!session) return empty;

  const client = batchesClient(session);
  const batch = await client.readOne(batchId).catch(() => null);
  if (!batch) return empty;

  const [members, links] = await Promise.all([
    client.listMembers([batch.id]).catch(() => [] as BatchMember[]),
    client.listSets(batch.id).catch(() => []),
  ]);

  return { batch, members, freeSetIds: setsOfBatch(links, batch.id) };
}
