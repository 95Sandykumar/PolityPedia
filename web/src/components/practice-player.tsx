'use client';

/**
 * The player, wired to the network (issue 13-question-player).
 *
 * `QuestionPlayer` is the screen and takes an `AnswerQueue`, so its tests
 * drive it with a fake and never touch `fetch`. This file is the one place
 * that builds the real queue over the real route, which keeps the component
 * free of transport and keeps this file free of UI.
 *
 * The page above is a SERVER component and holds the access token. It passes
 * data down; nothing here holds a key.
 *
 * `useMemo` with no dependencies on purpose: the queue holds the answers that
 * are still waiting to be sent, so rebuilding it on a re-render would throw
 * them away.
 */
import { useMemo } from 'react';
import { QuestionPlayer } from '@/components/question-player';
import { createAnswerQueue } from '@/lib/attempts/answer-queue';
import { createBrowserAttemptsClient } from '@/lib/attempts/browser-attempts-client';
import type { AttemptAnswer } from '@/lib/attempts/types';
import type { LangMode } from '@/lib/i18n';
import type { Question } from '@/lib/questions/types';
import { createBrowserSavedClient } from '@/lib/saved/browser-saved-client';
import type { SavedTag } from '@/lib/saved/types';

export function PracticePlayer({
  questions,
  attemptId,
  mode,
  examName,
  startedAnswers,
}: {
  questions: readonly Question[];
  attemptId: string;
  mode: LangMode;
  examName?: string;
  /** Pairs, not a Map: a plain array crosses the server boundary unchanged. */
  startedAnswers?: readonly (readonly [string, AttemptAnswer])[];
}) {
  const client = useMemo(() => createBrowserAttemptsClient(), []);
  /** The Saved list writer (issue 14-saved-list). Holds no key either. */
  const savedClient = useMemo(() => createBrowserSavedClient(), []);

  const queue = useMemo(
    () =>
      createAnswerQueue({
        save: (answer) => client.saveAnswer(answer),
        // `navigator.onLine` false is a certainty; true is only a hope, so a
        // failed send is still queued by the queue itself.
        isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
      }),
    [client],
  );

  const answers = useMemo(
    () => new Map<string, AttemptAnswer>(startedAnswers ?? []),
    [startedAnswers],
  );

  return (
    <QuestionPlayer
      questions={questions}
      attemptId={attemptId}
      queue={queue}
      mode={mode}
      examName={examName}
      startedAnswers={answers}
      onTag={(questionId: string, tag: SavedTag, saved: boolean) => {
        // Never awaited and never thrown: the Saved list is a side effect of
        // answering, so a failure here must not stop the paper. The save is
        // keyed (user_id, question_id, tag), so the student's next tap on the
        // same question writes the same row again and nothing is lost.
        void savedClient.setSaved(questionId, tag, saved).catch(() => {});
      }}
      onFinish={(score) =>
        client.submit({ attemptId, score }).catch(() => {
          // The score is on screen either way. Re-opening the paper resumes
          // the same attempt, so nothing is lost by a failed submit.
        })
      }
    />
  );
}
