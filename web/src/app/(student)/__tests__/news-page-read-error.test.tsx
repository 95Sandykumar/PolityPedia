/**
 * The teacher news screen: a FAILED read reaches it as an error state
 * (issue 54c-read-errors-saved-practice-media).
 *
 * Definition of done: "When a read fails (HTTP error or thrown error) the
 * screen shows the shared error state and never the empty-state text. A read
 * that succeeds with zero rows still shows the empty-state text."
 *
 * `PostList` already renders the right state for a given `failed`, because
 * Home needed it in 54b. This proves the news PAGE hands it the right one,
 * which is the half that was broken: the reader already knew, and the page
 * threw the answer away.
 *
 * The readers are faked, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md).
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionary } from '@/lib/i18n';
import type { TeacherPost } from '@/lib/posts/types';
import type { TeacherCard } from '@/lib/teachers/types';

const readStudentContext = vi.fn();
const readPortfolio = vi.fn();
const readTeacherPostsResult = vi.fn();

vi.mock('@/lib/follows/student-page', () => ({
  readStudentContext: () => readStudentContext(),
  readPortfolio: (...args: unknown[]) => readPortfolio(...args),
}));

vi.mock('@/lib/posts/server-posts', () => ({
  readTeacherPostsResult: (...args: unknown[]) => readTeacherPostsResult(...args),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { default: TeacherNewsPage } = await import('@/app/(student)/t/[teacherId]/news/page');

const en = dictionary.en;

const TEACHER_ID = '44444444-4444-4444-8444-444444444444';
const params = Promise.resolve({ teacherId: TEACHER_ID });

const SESSION = {
  userId: '11111111-1111-4111-8111-111111111111',
  accessToken: 'student.access.token',
  refreshToken: 'student.refresh.token',
  expiresAt: 4_000_000_000,
};

const TEACHER: TeacherCard = {
  userId: TEACHER_ID,
  identityMode: 'alias',
  displayName: 'Polity Guru',
  avatarPath: null,
  bioEn: null,
  bioHi: null,
  videosVisible: true,
  hasFreeSample: false,
};

const POST: TeacherPost = {
  id: '33333333-3333-4333-8333-333333333333',
  teacherId: TEACHER_ID,
  priority: 2,
  heading: 'Form date moved to 20 June',
  link: null,
  createdAt: '2026-06-01T00:00:00Z',
};

beforeEach(() => {
  readStudentContext.mockReset().mockResolvedValue({
    session: SESSION,
    configured: true,
    mode: 'en',
    examIds: [],
  });
  readPortfolio.mockReset().mockResolvedValue({ teacher: TEACHER, following: false });
  readTeacherPostsResult.mockReset().mockResolvedValue({ ok: true, data: [] });
});

describe('the news screen when the read succeeded with zero rows', () => {
  it('keeps the friendly empty state', async () => {
    render(await TeacherNewsPage({ params }));

    expect(screen.getByText(en['posts.none'])).toBeInTheDocument();
  });
});

describe('the news screen when the read FAILED', () => {
  beforeEach(() => {
    readTeacherPostsResult.mockResolvedValue({ ok: false });
  });

  it('shows the shared error state', async () => {
    render(await TeacherNewsPage({ params }));

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
  });

  it('never shows the empty-state text', async () => {
    render(await TeacherNewsPage({ params }));

    expect(screen.queryByText(en['posts.none'])).not.toBeInTheDocument();
  });

  it('offers Retry', async () => {
    render(await TeacherNewsPage({ params }));

    expect(screen.getByRole('button', { name: en['read.retry'] })).toBeInTheDocument();
  });

  it('shows the error state in Hindi too', async () => {
    readStudentContext.mockResolvedValue({
      session: SESSION,
      configured: true,
      mode: 'hi',
      examIds: [],
    });
    render(await TeacherNewsPage({ params }));

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.hi['read.failed']);
  });

  it('names no table, column, key or status', async () => {
    render(await TeacherNewsPage({ params }));

    const text = screen.getByRole('status').textContent ?? '';
    for (const leak of ['teacher_posts', 'priority', 'column', '400', '500']) {
      expect(text).not.toContain(leak);
    }
  });
});

describe('the news screen on an OK read', () => {
  it('still lists the notices', async () => {
    readTeacherPostsResult.mockResolvedValue({ ok: true, data: [POST] });
    render(await TeacherNewsPage({ params }));

    expect(screen.getByText('Form date moved to 20 June')).toBeInTheDocument();
    expect(screen.queryByText(en['read.failed'])).not.toBeInTheDocument();
  });
});
