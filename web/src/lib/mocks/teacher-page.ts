/**
 * The server reads the mock set screens need (issue 15-mock-sets-authoring).
 *
 * Server only. Every read runs HERE, with the teacher's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides the rows and the
 * browser never holds a key.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * Every read fails SOFT. A Supabase hiccup gives an empty list, a null set or
 * the default revenue share, and a page that still renders, never a 500 in the
 * middle of pricing a product.
 */
import type { AuthSession } from '@/lib/auth/types';
import { questionsClient } from '@/lib/questions/teacher-page';
import type { Question } from '@/lib/questions/types';
import { createSupabaseMocksClient } from './supabase-mocks-client';
import {
  DEFAULT_SHARE_PCT,
  sortTests,
  type MockSet,
  type MockTest,
} from './types';

export function mocksClient(session: AuthSession | null) {
  return createSupabaseMocksClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  });
}

/** The caller's own sets, drafts included, for the teacher's screen. */
export async function readMyMockSets(session: AuthSession | null): Promise<MockSet[]> {
  if (!session) return [];
  return mocksClient(session)
    .listMine()
    .catch(() => []);
}

/** One teacher's LIVE sets, for a student. */
export async function readLiveMockSets(
  session: AuthSession | null,
  teacherId: string,
): Promise<MockSet[]> {
  if (!session) return [];
  return mocksClient(session)
    .listLiveForTeacher(teacherId)
    .catch(() => []);
}

/**
 * One set, or null.
 *
 * Null is what a stranger gets and what the owner gets for a set that is not
 * theirs, because RLS hid the row. The screen says "Mock set not found" for
 * both, so the page never tells anybody that a set exists but is somebody
 * else's.
 */
export async function readMockSet(
  session: AuthSession | null,
  setId: string,
): Promise<MockSet | null> {
  if (!session) return null;
  return mocksClient(session)
    .readOne(setId)
    .catch(() => null);
}

/**
 * The caller's own revenue share (X3).
 *
 * Falls back to 50, the column default, so the earning line always has a
 * number. A missing read must not blank a pricing screen.
 */
export async function readMyShare(session: AuthSession | null): Promise<number> {
  if (!session) return DEFAULT_SHARE_PCT;
  return mocksClient(session)
    .readMyShare()
    .catch(() => DEFAULT_SHARE_PCT);
}

export interface MockSetData {
  tests: MockTest[];
  /** Every question across the set's tests, for the publish gate. */
  questions: Question[];
}

/**
 * One set's tests and every question inside them.
 *
 * The questions are read PER TEST and flattened, because
 * `questions.test_id` points at a test and not at a set: there is no one
 * query for "this set's questions" without a join PostgREST would have to be
 * taught. A set has a handful of tests, so a handful of reads in parallel is
 * cheaper than teaching it.
 */
export async function readMockSetData(
  session: AuthSession | null,
  setId: string,
): Promise<MockSetData> {
  if (!session) return { tests: [], questions: [] };

  const tests = sortTests(
    await mocksClient(session)
      .listTests(setId)
      .catch(() => []),
  );
  if (tests.length === 0) return { tests, questions: [] };

  const client = questionsClient(session);
  const perTest = await Promise.all(
    tests.map((one) =>
      // `listForTest` is optional on the interface (issue 11's fakes do not
      // have it), so the call is guarded and a missing one reads as no
      // questions rather than a crash.
      //
      // WITH THE KEY: this is the teacher's own authoring screen, and
      // `question_keys()` always hands a teacher their own keys (issue
      // 30-exam-key-lock).
      (client.listForTest?.(one.id, null, { keys: true }) ?? Promise.resolve([])).catch(
        () => [],
      ),
    ),
  );

  return { tests, questions: perTest.flat() };
}
