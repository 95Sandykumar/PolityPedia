/**
 * The server reads the review screen needs (issue 11-ingest-job-review-publish).
 *
 * Server only. Every read runs HERE, with the teacher's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides the rows and the
 * browser never holds a key.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * Every read fails SOFT. A Supabase hiccup gives an empty list or a null job
 * and a page that still renders, never a 500 in the middle of a review.
 */
import type { AuthSession } from '@/lib/auth/types';
import {
  createSupabaseIngestJobsClient,
  createSupabaseQuestionsClient,
} from './supabase-questions-client';
import type { IngestJob, Question } from './types';

function clientOptions(session: AuthSession | null) {
  return {
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  };
}

export function questionsClient(session: AuthSession | null) {
  return createSupabaseQuestionsClient(clientOptions(session));
}

export function ingestJobsClient(session: AuthSession | null) {
  return createSupabaseIngestJobsClient(clientOptions(session));
}

/**
 * One paper's questions, in number order. Drafts included, for the owner.
 *
 * WITH THE KEY. This is the review screen: the teacher has to see which
 * option the splitter marked correct in order to check it (F-D3). The key is
 * a second read through `question_keys()` since `0030_exam_key_lock.sql` took
 * the column privilege away, and that function always hands a teacher their
 * own questions' keys, exam sitting or not (issue 30-exam-key-lock).
 */
export async function readPaperQuestions(
  session: AuthSession | null,
  paperId: string,
): Promise<Question[]> {
  if (!session) return [];
  return questionsClient(session)
    .listForPaper(paperId, { keys: true })
    .catch(() => []);
}

/**
 * The newest split job for one paper, or null.
 *
 * Null is a normal answer, not an error: a paper uploaded with only a
 * solutions PDF was never queued, and nor was one whose queue insert failed.
 * The screen then simply shows no job line.
 */
export async function readPaperJob(
  session: AuthSession | null,
  paperId: string,
): Promise<IngestJob | null> {
  if (!session) return null;
  return ingestJobsClient(session)
    .readLatestForPaper(paperId)
    .catch(() => null);
}

export interface ReviewData {
  questions: Question[];
  job: IngestJob | null;
}

/** Both reads at once: the review page needs them together. */
export async function readReviewData(
  session: AuthSession | null,
  paperId: string,
): Promise<ReviewData> {
  const [questions, job] = await Promise.all([
    readPaperQuestions(session, paperId),
    readPaperJob(session, paperId),
  ]);
  return { questions, job };
}
