/**
 * The review ROUTES: `/t/<teacherId>/mocks/<testId>/review` and
 * `/t/<teacherId>/papers/<paperId>/review` (ticket 57b).
 *
 * 57a wrote the read only reader and 57 drew the panel, and then NOTHING
 * opened either one: there was no route, so the whole slice was unreachable.
 * This file is the proof that the two pages exist and wire the reader to the
 * panel, and it is written against the things that can actually go wrong:
 *
 *  * THE PANEL GETS THE SITTING. A submitted sitting puts the real
 *    `AttemptReviewPanel` on screen with the questions of that sitting, not a
 *    stub: the page is the only thing under test, so the panel is left real.
 *  * NULL IS ONE ANSWER, ALWAYS THE SAME ONE. No sitting, every sitting still
 *    open, and another student's sitting all read as null in 57a, and the page
 *    must say the SAME sentence for each. A different message for one of them
 *    would be the privacy leak the reader took care to avoid.
 *  * A PAGE VIEW WRITES NOTHING (persona-1 gap 5). The start readers, which
 *    are the only code that creates an `attempts` row, are mocked here and
 *    asserted NEVER CALLED. That is the regression this slice exists to stop.
 *  * RETAKE IS THE PLAY PATH OF THE SAME PAPER, in the mode of the sitting
 *    being reviewed, because the only place a sitting is created is the start
 *    route.
 *
 * Every reader is faked, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md). The reader itself is proved against
 * real Postgres in `web/test/attempt-review.test.ts`.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptReview, ReviewQuestion } from '@/lib/attempts/types';
import { dictionary } from '@/lib/i18n';

const TEACHER = '44444444-4444-4444-8444-444444444444';
const PAPER = '55555555-5555-4555-8555-555555555555';
const TEST = '66666666-6666-4666-8666-666666666666';
const ATTEMPT = '11111111-1111-4111-8111-111111111111';

const readStudentContext = vi.fn();
const readAttemptReview = vi.fn();
const createSupabaseReviewSource = vi.fn();

/** The start readers. Mocked ONLY so the test can prove nothing calls them. */
const readPracticeData = vi.fn();
const readMockPracticeData = vi.fn();
const readExamLoad = vi.fn();

vi.mock('@/lib/follows/student-page', () => ({
  readStudentContext: () => readStudentContext(),
}));

vi.mock('@/lib/attempts/review', () => ({
  readAttemptReview: (...args: unknown[]) => readAttemptReview(...args),
  createSupabaseReviewSource: (...args: unknown[]) => createSupabaseReviewSource(...args),
}));

vi.mock('@/lib/attempts/student-page', () => ({
  readPracticeData: (...args: unknown[]) => readPracticeData(...args),
  examNameOf: () => 'CUET PG',
}));

vi.mock('@/lib/practice/student-page', () => ({
  readMockPracticeData: (...args: unknown[]) => readMockPracticeData(...args),
}));

vi.mock('@/lib/exam/student-page', () => ({
  readExamLoad: (...args: unknown[]) => readExamLoad(...args),
}));

const { default: MockReviewPage } = await import(
  '@/app/(student)/t/[teacherId]/mocks/[testId]/review/page'
);
const { default: PaperReviewPage } = await import(
  '@/app/(student)/t/[teacherId]/papers/[paperId]/review/page'
);

const SESSION = {
  userId: '22222222-2222-4222-8222-222222222222',
  accessToken: 'student.access.token',
  refreshToken: 'student.refresh.token',
  expiresAt: 4_000_000_000,
};

const OPTIONS = [
  { idx: 0, letter: 'A', text: 'Lok Sabha only' },
  { idx: 1, letter: 'B', text: 'Rajya Sabha only' },
  { idx: 2, letter: 'C', text: 'Both Houses and the Assemblies' },
  { idx: 3, letter: 'D', text: 'The Supreme Court' },
];

function question(number: number): ReviewQuestion {
  return {
    questionId: `aaaaaaaa-0000-4000-8000-00000000000${number}`,
    number,
    stem: `Question ${number}: who elects the President of India?`,
    options: OPTIONS,
    chosen: OPTIONS[2],
    right: OPTIONS[2],
    isCorrect: true,
    marked: false,
    explanation: null,
  };
}

function review(over: Partial<AttemptReview> = {}): AttemptReview {
  return {
    attemptId: ATTEMPT,
    mode: 'practice',
    score: 2,
    total: 2,
    percent: 100,
    right: 2,
    wrong: 0,
    skipped: 0,
    timeTakenSec: 754,
    autoSubmitted: false,
    questions: [question(1), question(2)],
    ...over,
  };
}

const mocksPage = () =>
  MockReviewPage({ params: Promise.resolve({ teacherId: TEACHER, testId: TEST }) });

const papersPage = () =>
  PaperReviewPage({ params: Promise.resolve({ teacherId: TEACHER, paperId: PAPER }) });

/** The one sentence a null read is allowed to produce. */
const NOTHING = dictionary.en['recap.none'];

beforeEach(() => {
  readStudentContext
    .mockReset()
    .mockResolvedValue({ session: SESSION, configured: true, mode: 'en' });
  readAttemptReview.mockReset().mockResolvedValue(review());
  createSupabaseReviewSource.mockReset().mockReturnValue({ source: true });
  readPracticeData.mockReset();
  readMockPracticeData.mockReset();
  readExamLoad.mockReset();
});

describe('the mock test review page', () => {
  it('draws the panel with the questions of the submitted sitting', async () => {
    render(await mocksPage());

    expect(screen.getByTestId('attempt-review')).toBeInTheDocument();
    expect(screen.getAllByTestId('attempt-review-question')).toHaveLength(2);
    expect(screen.getByTestId('attempt-review-summary')).toHaveTextContent('2 / 2');
  });

  it('asks the reader for THIS test with the student own token', async () => {
    await mocksPage();

    expect(createSupabaseReviewSource).toHaveBeenCalledWith({
      accessToken: SESSION.accessToken,
    });
    expect(readAttemptReview).toHaveBeenCalledWith({ source: true }, { testId: TEST });
  });

  it('sends Retake to the play route of the same test, in the mode of the sitting', async () => {
    render(await mocksPage());

    expect(screen.getByTestId('attempt-review-retake')).toHaveAttribute(
      'href',
      `/t/${TEACHER}/mocks/${TEST}/play?mode=practice`,
    );
  });

  it('retakes an exam sitting as an exam', async () => {
    readAttemptReview.mockResolvedValue(review({ mode: 'exam' }));
    render(await mocksPage());

    expect(screen.getByTestId('attempt-review-retake')).toHaveAttribute(
      'href',
      `/t/${TEACHER}/mocks/${TEST}/play?mode=exam`,
    );
  });

  it('says the same thing for no sitting as for somebody elses', async () => {
    // 57a collapses "no sitting", "still open" and "not yours" into one null,
    // and the page must not take them apart again.
    readAttemptReview.mockResolvedValue(null);
    render(await mocksPage());

    expect(screen.queryByTestId('attempt-review')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(NOTHING);
  });

  it('says the same thing when there is no session at all', async () => {
    readStudentContext.mockResolvedValue({ session: null, configured: true, mode: 'en' });
    render(await mocksPage());

    expect(screen.getByRole('status')).toHaveTextContent(NOTHING);
    // No session is no token, so the reader is never even asked.
    expect(readAttemptReview).not.toHaveBeenCalled();
  });

  it('creates NO sitting: not one start reader is called', async () => {
    await mocksPage();

    expect(readMockPracticeData).not.toHaveBeenCalled();
    expect(readExamLoad).not.toHaveBeenCalled();
    expect(readPracticeData).not.toHaveBeenCalled();
  });
});

describe('the past paper review page', () => {
  it('draws the panel with the questions of the submitted sitting', async () => {
    render(await papersPage());

    expect(screen.getByTestId('attempt-review')).toBeInTheDocument();
    expect(screen.getAllByTestId('attempt-review-question')).toHaveLength(2);
  });

  it('asks the reader for THIS paper with the student own token', async () => {
    await papersPage();

    expect(createSupabaseReviewSource).toHaveBeenCalledWith({
      accessToken: SESSION.accessToken,
    });
    expect(readAttemptReview).toHaveBeenCalledWith({ source: true }, { paperId: PAPER });
  });

  it('sends Retake to the play route of the same paper', async () => {
    render(await papersPage());

    expect(screen.getByTestId('attempt-review-retake')).toHaveAttribute(
      'href',
      `/t/${TEACHER}/papers/${PAPER}/play`,
    );
  });

  it('shows the same nothing-to-review line on null', async () => {
    readAttemptReview.mockResolvedValue(null);
    render(await papersPage());

    expect(screen.queryByTestId('attempt-review')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(NOTHING);
  });

  it('creates NO sitting: not one start reader is called', async () => {
    await papersPage();

    expect(readPracticeData).not.toHaveBeenCalled();
    expect(readMockPracticeData).not.toHaveBeenCalled();
    expect(readExamLoad).not.toHaveBeenCalled();
  });
});
