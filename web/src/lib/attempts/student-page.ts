/**
 * The server reads the player page needs (issue 13-question-player).
 *
 * Server only. Every read runs HERE, with the student's own access token out
 * of the httpOnly session cookie, so Postgres RLS decides the rows and the
 * browser never holds a key. A draft question cannot reach this page at all:
 * `questions_select_live` hands a student only `live` rows of an APPROVED
 * teacher (V9, Risk 1).
 *
 * ONE REQUEST FOR THE WHOLE PAPER (DESIGN.md section 10). Every question is
 * read here, once, and handed down as a prop, so the player never waits for a
 * network round trip between two questions.
 *
 * Supabase and env access is lazy: nothing is read at import time, so the
 * build works with no environment variables (web/CLAUDE.md).
 *
 * The question read fails SOFT (an empty paper, and the page says so). The
 * ATTEMPT read does not: with no attempt there is nowhere to put an answer,
 * and a player that silently drops answers would be worse than a page that
 * says it is not ready.
 */
import type { AuthSession } from '@/lib/auth/types';
import type { Exam } from '@/lib/exams/types';
import { readPaperQuestions } from '@/lib/questions/teacher-page';
import type { Question } from '@/lib/questions/types';
import type { Paper } from '@/lib/papers/types';
import { createSupabaseAttemptsClient } from './supabase-attempts-client';
import type { Attempt, AttemptAnswer, AttemptMode } from './types';

export function attemptsClient(session: AuthSession | null) {
  return createSupabaseAttemptsClient({
    accessToken: session?.accessToken ?? '',
    userId: session?.userId ?? '',
  });
}

export interface PracticeData {
  /** Every live question of the paper, in number order. */
  questions: Question[];
  /** Null when the sitting could not be started: the page then says so. */
  attempt: Attempt | null;
  /**
   * What is already answered in that sitting, as pairs. An array and not a
   * Map, so it crosses the server boundary unchanged.
   */
  answers: [string, AttemptAnswer][];
}

/**
 * The questions, the sitting and its answers so far.
 *
 * The attempt is RESUMED when one is open, so re-opening the player (or a
 * double render in dev) does not leave a trail of empty attempts and does not
 * lose what the student already answered.
 */
export async function readPracticeData(
  session: AuthSession | null,
  paperId: string,
  mode: AttemptMode = 'practice',
): Promise<PracticeData> {
  if (!session) return { questions: [], attempt: null, answers: [] };

  const questions = await readPaperQuestions(session, paperId);

  const client = attemptsClient(session);
  const attempt = await client
    .openOrStartForPaper({ paperId, mode })
    .catch(() => null);
  if (!attempt) return { questions, attempt: null, answers: [] };

  const answers = await client.listAnswers(attempt.id).catch(() => new Map());
  return { questions, attempt, answers: [...answers.entries()] };
}

/**
 * The exam name for the line above the progress bar (DESIGN.md section 8), or
 * undefined when the paper is not one this student may read.
 *
 * `both` shows the two names on one line here, because the header is a single
 * 14 px muted row and not a stacked label.
 */
export function examNameOf(
  paper: Paper | undefined,
  exams: readonly Exam[],
  mode: 'en' | 'hi' | 'both',
): string | undefined {
  if (!paper) return undefined;
  const exam = exams.find((one) => one.id === paper.examId);
  if (!exam) return paper.label;

  const name =
    mode === 'both'
      ? [exam.nameEn, exam.nameHi].filter((one) => one.length > 0).join(' / ')
      : mode === 'hi'
        ? exam.nameHi
        : exam.nameEn;

  return [name, paper.label].filter((one) => one.length > 0).join(' · ');
}
