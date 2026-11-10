/**
 * The two routes a first visitor lands on (issue 63-public-landing).
 *
 * persona-1 gap 3: logged out, `/` and a shared `/t/<id>` both showed
 * "Teachers are not set up yet", which reads as "the app is broken". These
 * tests render both route components in both states, so the fix cannot be
 * undone silently:
 *
 * | route     | logged out                           | signed in |
 * |-----------|--------------------------------------|-----------|
 * | `/`       | landing: pitch, 2 buttons, how it works | no change |
 * | `/t/<id>` | public profile + "Sign in to follow"    | no change |
 *
 * Every data read is mocked, so there is no network call, no key and no
 * cookie store in this file. The route components are async server
 * components: awaiting one gives the element tree, which is then rendered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { dictionary } from '@/lib/i18n';
import type { PublicTeacher } from '@/lib/teachers/types';

const TEACHER_ID = '44444444-4444-4444-8444-444444444444';

const TEACHER: PublicTeacher = {
  userId: TEACHER_ID,
  identityMode: 'alias',
  displayName: 'Polity Guru',
  avatarPath: null,
  bioEn: 'Teaches polity',
  bioHi: 'राजनीति पढ़ाते हैं',
  videosVisible: true,
};

const SESSION = {
  userId: '11111111-1111-4111-8111-111111111111',
  accessToken: 'student.access.token',
  refreshToken: 'student.refresh.token',
  expiresAt: 4_000_000_000,
};

const readStudentContext = vi.fn();
const readFollowedTeachers = vi.fn();
const readPortfolio = vi.fn();
const readPortfolioResult = vi.fn();
const readPublicTeacher = vi.fn();

vi.mock('@/lib/follows/student-page', () => ({
  readStudentContext: () => readStudentContext(),
  readFollowedTeachers: (...args: unknown[]) => readFollowedTeachers(...args),
  // Home reads the RESULT flavour since 54b-read-errors-home-teachers. Both
  // names go through the same spy, so "reads nothing when logged out" still
  // watches the one read that matters.
  readFollowedTeachersResult: async (...args: unknown[]) => ({
    ok: true,
    data: await readFollowedTeachers(...args),
  }),
  // `/t/<id>` reads the RESULT flavour since 54-visible-read-errors, for the
  // same reason Home does: a failed teacher read must not draw as a teacher
  // who does not exist. The default wraps the `readPortfolio` spy, so every
  // case below still drives the page through that one name.
  readPortfolio: (...args: unknown[]) => readPortfolio(...args),
  readPortfolioResult: (...args: unknown[]) => readPortfolioResult(...args),
}));

// `ReadError` is a client component with a Retry button, so it asks for the
// router. Nothing navigates in these tests.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

vi.mock('@/lib/teachers/public-teacher', () => ({
  readPublicTeacher: (...args: unknown[]) => readPublicTeacher(...args),
}));

vi.mock('@/lib/posts/server-posts', () => ({
  readHomePosts: async () => [],
  readHomePostsResult: async () => ({ ok: true, data: [] }),
}));

vi.mock('@/lib/teacher-exams/teacher-page', () => ({
  readExamCatalogue: async () => [],
}));

vi.mock('@/app/(student)/_data/student-ui-data', () => ({
  readHomeExam: async () => null,
  readPortfolioCounts: async () => ({ videos: 0, papers: 0, mocks: 0, news: 0 }),
  readTeacherExamNames: async () => [],
}));

const { default: HomePage } = await import('@/app/(student)/page');
const { default: TeacherPage } = await import('@/app/(student)/t/[teacherId]/page');

function loggedOut() {
  readStudentContext.mockResolvedValue({ session: null, configured: false, mode: 'en' });
}

function signedIn() {
  readStudentContext.mockResolvedValue({ session: SESSION, configured: true, mode: 'en' });
}

beforeEach(() => {
  readStudentContext.mockReset();
  readFollowedTeachers.mockReset().mockResolvedValue([]);
  readPortfolio.mockReset().mockResolvedValue({ teacher: null, following: false, nextExam: null });
  readPortfolioResult.mockReset().mockImplementation(async (...args: unknown[]) => ({
    ok: true,
    data: await readPortfolio(...args),
  }));
  readPublicTeacher.mockReset().mockResolvedValue(null);
});

describe('/ logged out', () => {
  it('shows the landing pitch instead of a dead Home', async () => {
    loggedOut();
    render(await HomePage());

    expect(screen.getByText(dictionary.en['land.pitch'])).toBeTruthy();
    expect(document.body.textContent).not.toContain(dictionary.en['teachers.notConfigured']);
  });

  it('shows both buttons, so the way in is one tap', async () => {
    loggedOut();
    render(await HomePage());

    expect(screen.getByRole('link', { name: dictionary.en['land.tryFree'] })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(screen.getByRole('link', { name: dictionary.en['land.signIn'] })).toHaveAttribute(
      'href',
      '/sign-in',
    );
  });

  it('reads nothing that belongs to a signed-in student', async () => {
    loggedOut();
    render(await HomePage());
    expect(readFollowedTeachers).not.toHaveBeenCalled();
  });
});

describe('/ signed in', () => {
  it('still shows Home, not the landing', async () => {
    signedIn();
    readFollowedTeachers.mockResolvedValue([TEACHER]);
    render(await HomePage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(dictionary.en['nav.home']);
    expect(screen.queryByText(dictionary.en['land.pitch'])).toBeNull();
    expect(screen.getByText('Polity Guru')).toBeTruthy();
  });
});

describe('/t/<id> logged out', () => {
  it('shows the public profile from the public fields', async () => {
    loggedOut();
    readPublicTeacher.mockResolvedValue(TEACHER);
    render(await TeacherPage({ params: Promise.resolve({ teacherId: TEACHER_ID }) }));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Polity Guru');
    expect(screen.getByText('Teaches polity')).toBeTruthy();
    expect(document.body.textContent).not.toContain(dictionary.en['teachers.notConfigured']);
  });

  it('offers "Sign in to follow", not the Follow button', async () => {
    loggedOut();
    readPublicTeacher.mockResolvedValue(TEACHER);
    render(await TeacherPage({ params: Promise.resolve({ teacherId: TEACHER_ID }) }));

    expect(screen.getByRole('link', { name: dictionary.en['land.signInToFollow'] })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(screen.queryByRole('button', { name: dictionary.en['follow.follow'] })).toBeNull();
  });

  it('reads the teacher anonymously and never the signed-in portfolio', async () => {
    loggedOut();
    readPublicTeacher.mockResolvedValue(TEACHER);
    await TeacherPage({ params: Promise.resolve({ teacherId: TEACHER_ID }) });

    expect(readPublicTeacher).toHaveBeenCalledWith(TEACHER_ID);
    expect(readPortfolio).not.toHaveBeenCalled();
  });

  it('falls back to the landing pitch when there is no such public teacher', async () => {
    loggedOut();
    readPublicTeacher.mockResolvedValue(null);
    render(await TeacherPage({ params: Promise.resolve({ teacherId: TEACHER_ID }) }));

    expect(screen.getByText(dictionary.en['land.pitch'])).toBeTruthy();
    expect(screen.getByRole('link', { name: dictionary.en['land.signIn'] })).toBeTruthy();
  });
});

describe('/t/<id> signed in', () => {
  it('still shows the normal portfolio with the Follow button', async () => {
    signedIn();
    readPortfolio.mockResolvedValue({ teacher: TEACHER, following: false, nextExam: null });
    render(await TeacherPage({ params: Promise.resolve({ teacherId: TEACHER_ID }) }));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Polity Guru');
    expect(screen.getByRole('button', { name: dictionary.en['follow.follow'] })).toBeTruthy();
    expect(screen.queryByText(dictionary.en['land.pitch'])).toBeNull();
    expect(readPublicTeacher).not.toHaveBeenCalled();
  });

  it('keeps the old "not found" line for a signed-in student', async () => {
    signedIn();
    readPortfolio.mockResolvedValue({ teacher: null, following: false, nextExam: null });
    render(await TeacherPage({ params: Promise.resolve({ teacherId: TEACHER_ID }) }));

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['portfolio.notFound']);
  });

  it('shows the error state, never "not found", when the read FAILED', async () => {
    // 0 rows and a broken read used to arrive here as the same `teacher: null`
    // (issue 54-visible-read-errors). Only one of them is a missing teacher.
    signedIn();
    readPortfolioResult.mockResolvedValue({ ok: false });
    render(await TeacherPage({ params: Promise.resolve({ teacherId: TEACHER_ID }) }));

    expect(screen.getByText(dictionary.en['read.failed'])).toBeTruthy();
    expect(screen.getByRole('button', { name: dictionary.en['read.retry'] })).toBeTruthy();
    expect(screen.queryByText(dictionary.en['portfolio.notFound'])).toBeNull();
  });
});
