'use client';

/**
 * The exam player, wired to the network (issue 18-exam-mode).
 *
 * `ExamPlayer` is the screen and takes a `BrowserExamClient`, so its tests
 * drive it with a fake and never touch `fetch`. This file is the one place
 * that builds the real client over the real routes, which keeps the component
 * free of transport and keeps this file free of UI. The same split as
 * `practice-player.tsx` in issue 17.
 *
 * The page above is a SERVER component and holds the access token. It passes
 * stripped questions down; nothing here holds a key, and nothing here can
 * invent one.
 *
 * `useMemo` on the client, so a re-render does not build a second one mid-tap.
 */
import { useMemo } from 'react';
import { ExamPlayer } from '@/components/exam-player';
import type { AttemptAnswer } from '@/lib/attempts/types';
import { createBrowserExamClient } from '@/lib/exam/browser-exam-client';
import type { ExamQuestion } from '@/lib/exam/types';
import type { LangMode } from '@/lib/i18n';
import type { Marking } from '@/lib/practice/types';
import type { Question } from '@/lib/questions/types';

export function MockExamPlayer({
  questions,
  attemptId,
  testId,
  topicId = null,
  deadlineAt,
  mode,
  examName,
  marking,
  startedAnswers,
  revealed,
  score,
}: {
  questions: readonly (Question | ExamQuestion)[];
  attemptId: string;
  /** The client posts to `/api/tests/<testId>/...`, so it needs the id. */
  testId: string;
  /** Carried so the review re-read asks for the same question list. */
  topicId?: string | null;
  deadlineAt: string | null;
  mode: LangMode;
  examName?: string;
  marking?: Marking;
  /** Pairs, not a Map: a plain array crosses the server boundary unchanged. */
  startedAnswers?: readonly (readonly [string, AttemptAnswer])[];
  revealed?: boolean;
  score?: number | null;
}) {
  const client = useMemo(
    () => createBrowserExamClient({ testId, topicId }),
    [testId, topicId],
  );

  return (
    <ExamPlayer
      questions={questions}
      attemptId={attemptId}
      deadlineAt={deadlineAt}
      mode={mode}
      examName={examName}
      marking={marking}
      startedAnswers={startedAnswers}
      revealed={revealed}
      score={score}
      client={client}
    />
  );
}
