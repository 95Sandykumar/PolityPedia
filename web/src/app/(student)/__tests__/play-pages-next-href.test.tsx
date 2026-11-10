/**
 * The play pages hand the result page somewhere to go next (ticket 56b).
 *
 * `AttemptResultPanel` only draws "Next test" when the page above gives it an
 * href, and ticket 56 gave it none, so the link never showed anywhere. The
 * component tests prove the panel and the players render a given `nextHref`.
 * This proves the PAGES pass one, which is the half that was missing:
 *
 *  * the past paper play page sends the student to that teacher's PAPERS list
 *  * the mock play page sends them to that teacher's MOCKS list, in exam mode
 *    and in practice mode alike
 *
 * The players are stubs, so this test is about the prop and not about the
 * player, and every reader is faked, so nothing here touches the network and
 * no real key exists in the suite (web/CLAUDE.md).
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markingOf } from '@/lib/practice/types';
import type { Question, QuestionOptions } from '@/lib/questions/types';

const TEACHER = '44444444-4444-4444-8444-444444444444';
const PAPER = '55555555-5555-4555-8555-555555555555';
const TEST = '66666666-6666-4666-8666-666666666666';
const ATTEMPT = '11111111-1111-4111-8111-111111111111';

const readStudentContext = vi.fn();
const readPracticeData = vi.fn();
const readLivePapers = vi.fn();
const readExamCatalogue = vi.fn();
const readMockPracticeData = vi.fn();
const readExamLoad = vi.fn();

vi.mock('@/lib/follows/student-page', () => ({
  readStudentContext: () => readStudentContext(),
}));

vi.mock('@/lib/attempts/student-page', () => ({
  readPracticeData: (...args: unknown[]) => readPracticeData(...args),
  examNameOf: () => 'CUET PG',
}));

vi.mock('@/lib/papers/teacher-page', () => ({
  readLivePapers: (...args: unknown[]) => readLivePapers(...args),
}));

vi.mock('@/lib/teacher-exams/teacher-page', () => ({
  readExamCatalogue: (...args: unknown[]) => readExamCatalogue(...args),
}));

vi.mock('@/lib/practice/student-page', () => ({
  readMockPracticeData: (...args: unknown[]) => readMockPracticeData(...args),
}));

vi.mock('@/lib/exam/student-page', () => ({
  readExamLoad: (...args: unknown[]) => readExamLoad(...args),
}));

/**
 * The players, as stubs that say nothing but where they were told to go next.
 * A stub, not the real player: what is under test is the PROP the page passes.
 */
vi.mock('@/components/practice-player', () => ({
  PracticePlayer: ({ nextHref }: { nextHref?: string | null }) => (
    <p data-testid="practice-next">{nextHref ?? 'none'}</p>
  ),
}));

vi.mock('@/components/mock-exam-player', () => ({
  MockExamPlayer: ({ nextHref }: { nextHref?: string | null }) => (
    <p data-testid="exam-next">{nextHref ?? 'none'}</p>
  ),
}));

const { default: PaperPlayPage } = await import(
  '@/app/(student)/t/[teacherId]/papers/[paperId]/play/page'
);
const { default: MockPlayerPage } = await import(
  '@/app/(student)/t/[teacherId]/mocks/[testId]/play/page'
);

const SESSION = {
  userId: '22222222-2222-4222-8222-222222222222',
  accessToken: 'student.access.token',
  refreshToken: 'student.refresh.token',
  expiresAt: 4_000_000_000,
};

const OPTIONS: QuestionOptions = ['A one', 'B two', 'C three', 'D four'];

const QUESTION: Question = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  teacherId: TEACHER,
  paperId: PAPER,
  testId: null,
  number: 1,
  stem: 'Question 1',
  options: OPTIONS,
  correctIdx: 0,
  teacherExplanation: null,
  topicId: null,
  lang: 'en',
  imagePath: null,
  checked: true,
  status: 'live',
};

/** A sitting that is open and writable, which is what puts a player on screen. */
function attempt(mode: 'practice' | 'exam') {
  return {
    id: ATTEMPT,
    userId: SESSION.userId,
    paperId: mode === 'practice' ? PAPER : null,
    testId: mode === 'practice' ? null : TEST,
    mode,
    topicId: null,
    deadlineAt: null,
    submittedAt: null,
    score: null,
  };
}

beforeEach(() => {
  readStudentContext
    .mockReset()
    .mockResolvedValue({ session: SESSION, configured: true, mode: 'en' });
  readPracticeData
    .mockReset()
    .mockResolvedValue({ questions: [QUESTION], attempt: attempt('practice'), answers: [] });
  readLivePapers.mockReset().mockResolvedValue([]);
  readExamCatalogue.mockReset().mockResolvedValue([]);
  readMockPracticeData.mockReset().mockResolvedValue({
    questions: [QUESTION],
    attempt: attempt('practice'),
    answers: [],
    marking: markingOf({ marksCorrect: 4, marksWrong: -1 }),
    heading: 'Mock 1',
    examOpen: false,
  });
  readExamLoad.mockReset().mockResolvedValue({
    questions: [QUESTION],
    attempt: attempt('exam'),
    answers: [],
    marking: markingOf({ marksCorrect: 4, marksWrong: -1 }),
    heading: 'Mock 1',
    durationMin: 90,
    revealed: false,
  });
});

describe('the past paper play page', () => {
  it('sends "Next test" to that teacher\'s papers list', async () => {
    render(
      await PaperPlayPage({ params: Promise.resolve({ teacherId: TEACHER, paperId: PAPER }) }),
    );

    expect(screen.getByTestId('practice-next')).toHaveTextContent(`/t/${TEACHER}/papers`);
  });
});

describe('the mock play page', () => {
  it('sends "Next test" to that teacher\'s mocks list in exam mode', async () => {
    render(
      await MockPlayerPage({
        params: Promise.resolve({ teacherId: TEACHER, testId: TEST }),
        searchParams: Promise.resolve({ mode: 'exam' }),
      }),
    );

    expect(screen.getByTestId('exam-next')).toHaveTextContent(`/t/${TEACHER}/mocks`);
  });

  it('sends "Next test" to the same list in practice mode', async () => {
    render(
      await MockPlayerPage({
        params: Promise.resolve({ teacherId: TEACHER, testId: TEST }),
        searchParams: Promise.resolve({ mode: 'practice' }),
      }),
    );

    expect(screen.getByTestId('practice-next')).toHaveTextContent(`/t/${TEACHER}/mocks`);
  });
});
