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
 * A FAILED read is no longer an empty one (issue 54a-read-error-core).
 * `readMockListResult` is the honest read: it says `{ ok: false }` when any
 * request answered a non-ok status or threw, so the page shows the shared
 * error state with Retry instead of "No mock tests yet. Your teacher adds them
 * soon." A read that really did come back with zero rows is still
 * `{ ok: true, data: [] }` and still gets the friendly empty state.
 *
 * The Supabase clients are untouched: they still turn a 400 into `[]` inside
 * themselves. What makes the failure visible is a probe handed to them in
 * place of `fetch`, which remembers the status on the way past.
 *
 * `readMockList` is the old plain-list shape, kept for the Home counts, which
 * ticket 54 handles.
 *
 * Four reads, in this order, because each one needs the one before it:
 *
 *   live sets -> their tests -> my set_access rows -> my scores per test
 */
import type { AuthSession } from '@/lib/auth/types';
import { createSupabaseMocksClient } from '@/lib/mocks/supabase-mocks-client';
import type { MockTest } from '@/lib/mocks/types';
import { readOk, readWithProbe, type ReadResult } from '@/lib/read-result';
import { createSupabaseSetAccessClient } from './supabase-set-access-client';
import { buildMockRows, type MockSetRow } from './types';

/** A portfolio page shows a teacher's sets, not a catalogue. */
const MAX_SETS = 20;

/** Injected in tests only. Production passes nothing and the env is read lazily. */
export interface MockListOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

function mocksClient(session: AuthSession | null, options: MockListOptions, fetchImpl: typeof fetch) {
  return createSupabaseMocksClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
    ...(options.env ? { env: options.env } : {}),
    fetchImpl,
  });
}

function accessClient(
  session: AuthSession | null,
  options: MockListOptions,
  fetchImpl: typeof fetch,
) {
  return createSupabaseSetAccessClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
    ...(options.env ? { env: options.env } : {}),
    fetchImpl,
  });
}

/**
 * One teacher's LIVE mock sets with this student's own locks, ticks and
 * scores, and whether the read actually worked.
 *
 * The tests are read one set at a time and in parallel: a teacher has a
 * handful of live sets, so this is a handful of small requests, and it reuses
 * `listTests` from issue 15 rather than inventing a second way to read the
 * same table.
 */
export async function readMockListResult(
  session: AuthSession | null,
  teacherId: string,
  options: MockListOptions = {},
): Promise<ReadResult<MockSetRow[]>> {
  // Signed out is not broken: there is simply nothing of this student's to
  // read, so it is an OK empty read and the page keeps its empty state.
  if (!session) return readOk<MockSetRow[]>([]);

  return readWithProbe(async (fetchImpl) => {
    const mocks = mocksClient(session, options, fetchImpl);
    const sets = (await mocks.listLiveForTeacher(teacherId).catch(() => [])).slice(0, MAX_SETS);
    if (sets.length === 0) return [];

    const perSet = await Promise.all(
      sets.map((set) => mocks.listTests(set.id).catch(() => [] as MockTest[])),
    );
    const tests = perSet.flat();

    const access = accessClient(session, options, fetchImpl);
    const [mine, scores] = await Promise.all([
      access.listMine().catch(() => []),
      access.listScores(tests.map((test) => test.id)).catch(() => []),
    ]);

    return buildMockRows({ sets, tests, access: mine, scores });
  }, options.fetchImpl);
}

/**
 * The same read as a plain list, the pre-54a fail-soft shape.
 *
 * Still used by the Home counts, which only ever show a number and have no
 * room for an error state. Ticket 54 gives those screens the honest read.
 */
export async function readMockList(
  session: AuthSession | null,
  teacherId: string,
  options: MockListOptions = {},
): Promise<MockSetRow[]> {
  const result = await readMockListResult(session, teacherId, options);
  return result.ok ? result.data : [];
}
