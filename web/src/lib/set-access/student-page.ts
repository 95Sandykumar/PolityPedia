/**
 * The server read behind the student's Mock tests page
 * (issue 16-set-access-mock-list).
 *
 * Server only. Every read runs HERE, with the student's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides the rows and the
 * browser never holds a key.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * Every read fails SOFT. A Supabase hiccup gives an empty list and a page that
 * still renders, never a 500 on a teacher's portfolio.
 *
 * Four reads, in this order, because each one needs the one before it:
 *
 *   live sets -> their tests -> my set_access rows -> my scores per test
 */
import type { AuthSession } from '@/lib/auth/types';
import { createSupabaseMocksClient } from '@/lib/mocks/supabase-mocks-client';
import type { MockTest } from '@/lib/mocks/types';
import { createSupabaseSetAccessClient } from './supabase-set-access-client';
import { buildMockRows, type MockSetRow } from './types';

/** A portfolio page shows a teacher's sets, not a catalogue. */
const MAX_SETS = 20;

function mocksClient(session: AuthSession | null) {
  return createSupabaseMocksClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  });
}

function accessClient(session: AuthSession | null) {
  return createSupabaseSetAccessClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  });
}

/**
 * One teacher's LIVE mock sets with this student's own locks, ticks and
 * scores.
 *
 * The tests are read one set at a time and in parallel: a teacher has a
 * handful of live sets, so this is a handful of small requests, and it reuses
 * `listTests` from issue 15 rather than inventing a second way to read the
 * same table.
 */
export async function readMockList(
  session: AuthSession | null,
  teacherId: string,
): Promise<MockSetRow[]> {
  if (!session) return [];

  const mocks = mocksClient(session);
  const sets = (
    await mocks.listLiveForTeacher(teacherId).catch(() => [])
  ).slice(0, MAX_SETS);
  if (sets.length === 0) return [];

  const perSet = await Promise.all(
    sets.map((set) => mocks.listTests(set.id).catch(() => [] as MockTest[])),
  );
  const tests = perSet.flat();

  const access = accessClient(session);
  const [mine, scores] = await Promise.all([
    access.listMine().catch(() => []),
    access
      .listScores(tests.map((test) => test.id))
      .catch(() => []),
  ]);

  return buildMockRows({ sets, tests, access: mine, scores });
}
