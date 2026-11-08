/**
 * The three exam routes (issue 18-exam-mode).
 *
 *   GET  /api/tests/<id>/load?mode=exam  -> the questions, WITHOUT the key
 *   POST /api/tests/<id>/answer          -> one answer, with no verdict
 *   POST /api/tests/<id>/submit          -> the SERVER marks and closes it
 *
 * THE KEY TEST OF THIS SLICE IS HERE: the exam load payload contains no
 * `correct_idx` and no `teacher_explanation` (F-E5). It is checked by walking
 * the whole reply, and it is checked AGAIN against a reader that wrongly hands
 * the route an unstripped payload, because the guard in the route is the thing
 * standing between a bug upstream and a leaked answer key.
 *
 * The reader and the client are injected, so nothing here makes a network call
 * or holds a key (web/CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { handleExamAnswer, handleExamLoad, handleExamSubmit } from '../exam-route';
import {
  carriesAnswerKey,
  stripAnswerKey,
  type ExamAnswer,
  type ExamClient,
  type ExamLoad,
} from '../types';
import type { AuthSession } from '@/lib/auth/types';
import type { Attempt } from '@/lib/attempts/types';
import { DEFAULT_MARKING } from '@/lib/practice/types';
import type { Question, QuestionOptions } from '@/lib/questions/types';

const STUDENT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const TEST = '33333333-3333-4333-8333-333333333333';
const TOPIC = '44444444-4444-4444-8444-444444444444';
const ATTEMPT = '55555555-5555-4555-8555-555555555555';
const QUESTION = '66666666-6666-4666-8666-666666666666';

const SESSION: AuthSession = {
  userId: STUDENT,
  accessToken: 'token',
  refreshToken: 'refresh',
  role: 'student',
};

const OPTIONS: QuestionOptions = ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'];

function question(): Question {
  return {
    id: QUESTION,
    teacherId: TEACHER,
    paperId: null,
    testId: TEST,
    number: 1,
    stem: 'Which house is the Council of States?',
    options: OPTIONS,
    correctIdx: 1,
    teacherExplanation: 'Article 80 names it.',
    topicId: TOPIC,
    lang: 'en',
    imagePath: null,
    checked: true,
    status: 'live',
  };
}

function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    id: ATTEMPT,
    userId: STUDENT,
    paperId: null,
    testId: TEST,
    mode: 'exam',
    topicId: null,
    deadlineAt: '2026-11-05T11:30:00.000Z',
    submittedAt: null,
    score: null,
    ...over,
  };
}

/** A reader that hands back a properly stripped payload. */
function reader(over: Partial<ExamLoad> = {}) {
  const load = vi.fn(
    async (): Promise<ExamLoad> => ({
      questions: [stripAnswerKey(question())],
      attempt: attempt(),
      answers: [],
      marking: { marksCorrect: 4, marksWrong: -1 },
      heading: 'CUET PG · Test 1',
      durationMin: 90,
      revealed: false,
      ...over,
    }),
  );
  return load;
}

function fakeClient(over: Partial<ExamClient> = {}) {
  const saved: ExamAnswer[] = [];
  const scored: string[] = [];
  const client: ExamClient = {
    isConfigured: () => true,
    openOrStartExam: async () => attempt(),
    saveExamAnswer: async (one) => {
      saved.push(one);
    },
    scoreAttempt: async (id) => {
      scored.push(id);
      return 10;
    },
    ...over,
  };
  return { client, saved, scored };
}

// --------------------------------------------------------------------------
// GET /api/tests/<id>/load?mode=exam  -- THE KEY TEST
// --------------------------------------------------------------------------
describe('handleExamLoad', () => {
  it('replies with no correct_idx and no teacher_explanation (F-E5)', async () => {
    const reply = await handleExamLoad({
      testId: TEST,
      query: { mode: 'exam' },
      session: SESSION,
      langMode: 'en',
      load: reader(),
    });

    expect(reply.status).toBe(200);
    const wire = JSON.stringify(reply.body);
    expect(wire).not.toContain('correct_idx');
    expect(wire).not.toContain('correctIdx');
    expect(wire).not.toContain('teacher_explanation');
    expect(wire).not.toContain('teacherExplanation');
    expect(wire).not.toContain('Article 80');
    expect(carriesAnswerKey(reply.body)).toBe(false);
  });

  it('still strips the key when the reader wrongly hands one over', async () => {
    // A bug upstream: the reader forgot to strip. The route is the last gate.
    const reply = await handleExamLoad({
      testId: TEST,
      query: { mode: 'exam' },
      session: SESSION,
      langMode: 'en',
      load: reader({ questions: [question()], revealed: false }),
    });

    expect(reply.status).toBe(200);
    expect(carriesAnswerKey(reply.body)).toBe(false);
    expect(JSON.stringify(reply.body)).not.toContain('Article 80');
  });

  it('still carries the questions the student needs to answer', async () => {
    const reply = await handleExamLoad({
      testId: TEST,
      query: { mode: 'exam' },
      session: SESSION,
      langMode: 'en',
      load: reader(),
    });

    const body = reply.body as ExamLoad;
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0].stem).toContain('Council of States');
    expect(body.questions[0].options).toEqual(OPTIONS);
    expect(body.attempt?.deadlineAt).toBe('2026-11-05T11:30:00.000Z');
    expect(body.marking).toEqual({ marksCorrect: 4, marksWrong: -1 });
    expect(body.durationMin).toBe(90);
  });

  it('hands the key over ONCE the sitting is submitted, for the review', async () => {
    const reply = await handleExamLoad({
      testId: TEST,
      query: { mode: 'exam' },
      session: SESSION,
      langMode: 'en',
      load: reader({
        questions: [question()],
        attempt: attempt({ submittedAt: '2026-11-05T11:00:00.000Z', score: 10 }),
        revealed: true,
      }),
    });

    const body = reply.body as ExamLoad;
    expect(body.revealed).toBe(true);
    expect((body.questions[0] as Question).correctIdx).toBe(1);
    expect((body.questions[0] as Question).teacherExplanation).toBe('Article 80 names it.');
  });

  it('passes the topic filter through, and leaves Full paper unfiltered', async () => {
    const withTopic = reader();
    await handleExamLoad({
      testId: TEST,
      query: { mode: 'exam', topic: TOPIC },
      session: SESSION,
      langMode: 'en',
      load: withTopic,
    });
    expect(withTopic).toHaveBeenCalledWith(
      TEST,
      expect.objectContaining({ topicId: TOPIC }),
    );

    const fullPaper = reader();
    await handleExamLoad({
      testId: TEST,
      query: { mode: 'exam', topic: 'all' },
      session: SESSION,
      langMode: 'en',
      load: fullPaper,
    });
    expect(fullPaper).toHaveBeenCalledWith(
      TEST,
      expect.objectContaining({ topicId: null }),
    );
  });

  it('turns away a caller who is not signed in, before it reads anything', async () => {
    const load = reader();
    const reply = await handleExamLoad({
      testId: TEST,
      query: { mode: 'exam' },
      session: null,
      langMode: 'en',
      load,
    });

    expect(reply.status).toBe(401);
    expect(load).not.toHaveBeenCalled();
  });

  it('refuses any mode but exam, so practice data never leaves this route', async () => {
    const load = reader();
    for (const mode of ['practice', '', undefined, 'EXAM ']) {
      const reply = await handleExamLoad({
        testId: TEST,
        query: { mode },
        session: SESSION,
        langMode: 'en',
        load,
      });
      expect(reply.status).toBe(400);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('refuses a test id that is not a uuid, because it goes into a URL', async () => {
    const load = reader();
    const reply = await handleExamLoad({
      testId: '../../secrets',
      query: { mode: 'exam' },
      session: SESSION,
      langMode: 'en',
      load,
    });

    expect(reply.status).toBe(400);
    expect(load).not.toHaveBeenCalled();
  });

  it('answers 502 with a fixed word when the read throws', async () => {
    const reply = await handleExamLoad({
      testId: TEST,
      query: { mode: 'exam' },
      session: SESSION,
      langMode: 'en',
      load: async () => {
        throw new Error('policy "attempts_mock_needs_access" was violated');
      },
    });

    expect(reply.status).toBe(502);
    expect(JSON.stringify(reply.body)).not.toContain('policy');
  });

  // Issue 45-keep-money-and-scores: the teacher archived the test.
  it('refuses a NEW attempt on an archived test with a clear message', async () => {
    const reply = await handleExamLoad({
      testId: TEST,
      query: { mode: 'exam' },
      session: SESSION,
      langMode: 'en',
      load: async () => {
        throw Object.assign(new Error('test archived'), { name: 'TestArchived' });
      },
    });

    expect(reply.status).toBe(409);
    expect((reply.body as { error: string }).error).toMatch(/archived/i);
    expect((reply.body as { error: string }).error).toMatch(/no new attempts/i);
  });
});

// --------------------------------------------------------------------------
// POST /api/tests/<id>/answer
// --------------------------------------------------------------------------
describe('handleExamAnswer', () => {
  it('stores a chosen option with no verdict', async () => {
    const { client, saved } = fakeClient();

    const reply = await handleExamAnswer({
      body: { attemptId: ATTEMPT, questionId: QUESTION, chosenIdx: 2 },
      session: SESSION,
      client,
    });

    expect(reply).toEqual({ status: 200, body: { ok: true } });
    expect(saved).toEqual([
      { attemptId: ATTEMPT, questionId: QUESTION, chosenIdx: 2, marked: false },
    ]);
  });

  it('drops an isCorrect a caller sends, so a phone cannot mark its own paper', async () => {
    const { client, saved } = fakeClient();

    await handleExamAnswer({
      body: { attemptId: ATTEMPT, questionId: QUESTION, chosenIdx: 2, isCorrect: true },
      session: SESSION,
      client,
    });

    expect(saved[0]).not.toHaveProperty('isCorrect');
  });

  it('turns away a caller who is not signed in', async () => {
    const { client, saved } = fakeClient();

    const reply = await handleExamAnswer({
      body: { attemptId: ATTEMPT, questionId: QUESTION, chosenIdx: 2 },
      session: null,
      client,
    });

    expect(reply.status).toBe(401);
    expect(saved).toHaveLength(0);
  });

  it('says 503 when Supabase is not configured', async () => {
    const { client } = fakeClient({ isConfigured: () => false });

    const reply = await handleExamAnswer({
      body: { attemptId: ATTEMPT, questionId: QUESTION, chosenIdx: 2 },
      session: SESSION,
      client,
    });

    expect(reply.status).toBe(503);
  });

  it('says 400 for a body it cannot read', async () => {
    const { client } = fakeClient();

    expect((await handleExamAnswer({ body: null, session: SESSION, client })).status).toBe(
      400,
    );
    expect(
      (
        await handleExamAnswer({
          body: { attemptId: 'nope', questionId: QUESTION, chosenIdx: 1 },
          session: SESSION,
          client,
        })
      ).status,
    ).toBe(400);
  });

  it('says 502 with a fixed word when the write is refused after the deadline', async () => {
    const { client } = fakeClient({
      saveExamAnswer: async () => {
        throw new Error('new row violates policy "attempt_answers_insert_open"');
      },
    });

    const reply = await handleExamAnswer({
      body: { attemptId: ATTEMPT, questionId: QUESTION, chosenIdx: 2 },
      session: SESSION,
      client,
    });

    expect(reply.status).toBe(502);
    expect(JSON.stringify(reply.body)).not.toContain('attempt_answers_insert_open');
  });
});

// --------------------------------------------------------------------------
// POST /api/tests/<id>/submit
// --------------------------------------------------------------------------
describe('handleExamSubmit', () => {
  it('hands back the score the SERVER worked out', async () => {
    const { client, scored } = fakeClient();

    const reply = await handleExamSubmit({
      body: { attemptId: ATTEMPT },
      session: SESSION,
      client,
    });

    expect(reply).toEqual({ status: 200, body: { ok: true, score: 10 } });
    expect(scored).toEqual([ATTEMPT]);
  });

  it('ignores a score in the body, because the browser does not get a vote', async () => {
    const { client } = fakeClient();

    const reply = await handleExamSubmit({
      body: { attemptId: ATTEMPT, score: 800 },
      session: SESSION,
      client,
    });

    expect(reply.body).toEqual({ ok: true, score: 10 });
  });

  it('is the same reply when it is called twice', async () => {
    const { client } = fakeClient();
    const input = { body: { attemptId: ATTEMPT }, session: SESSION, client };

    const first = await handleExamSubmit(input);
    const second = await handleExamSubmit(input);

    expect(second).toEqual(first);
  });

  it('turns away a caller who is not signed in', async () => {
    const { client, scored } = fakeClient();

    const reply = await handleExamSubmit({ body: { attemptId: ATTEMPT }, session: null, client });

    expect(reply.status).toBe(401);
    expect(scored).toHaveLength(0);
  });

  it('says 400 for a body with no attempt id', async () => {
    const { client } = fakeClient();

    expect((await handleExamSubmit({ body: {}, session: SESSION, client })).status).toBe(400);
  });

  it('says 502 with a fixed word when the marking run is refused', async () => {
    const { client } = fakeClient({
      scoreAttempt: async () => {
        throw new Error('attempt belongs to another student');
      },
    });

    const reply = await handleExamSubmit({
      body: { attemptId: ATTEMPT },
      session: SESSION,
      client,
    });

    expect(reply.status).toBe(502);
    expect(JSON.stringify(reply.body)).not.toContain('another student');
  });
});

describe('the default marking', () => {
  it('is what a load falls back to, so a score always has numbers', async () => {
    const reply = await handleExamLoad({
      testId: TEST,
      query: { mode: 'exam' },
      session: SESSION,
      langMode: 'en',
      load: reader({ marking: DEFAULT_MARKING }),
    });

    expect((reply.body as ExamLoad).marking).toEqual({ marksCorrect: 1, marksWrong: 0 });
  });
});
