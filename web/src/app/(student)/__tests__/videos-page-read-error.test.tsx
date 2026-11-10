/**
 * The student videos screen: a FAILED read reaches it as an error state
 * (issue 54c-read-errors-saved-practice-media).
 *
 * Definition of done: "When a read fails (HTTP error or thrown error) the
 * screen shows the shared error state and never the empty-state text. A read
 * that succeeds with zero rows still shows the empty-state text."
 *
 * The page reads the teacher AND their videos in one probe, so one error state
 * covers both. A teacher who is simply not there keeps the not-found line: not
 * approved and not readable are different answers.
 *
 * The readers are faked, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md).
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionary } from '@/lib/i18n';
import type { PublicTeacher } from '@/lib/teachers/types';
import type { TeacherVideo } from '@/lib/videos/types';

const readStudentContext = vi.fn();
const readStudentVideosResult = vi.fn();

vi.mock('@/lib/follows/student-page', () => ({
  readStudentContext: () => readStudentContext(),
}));

vi.mock('@/lib/videos/page-data', () => ({
  readStudentVideosResult: (...args: unknown[]) => readStudentVideosResult(...args),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { default: TeacherVideosPage } = await import(
  '@/app/(student)/t/[teacherId]/videos/page'
);

const en = dictionary.en;

const TEACHER_ID = '44444444-4444-4444-8444-444444444444';
const params = Promise.resolve({ teacherId: TEACHER_ID });

const SESSION = {
  userId: '11111111-1111-4111-8111-111111111111',
  accessToken: 'student.access.token',
  refreshToken: 'student.refresh.token',
  expiresAt: 4_000_000_000,
};

const TEACHER: PublicTeacher = {
  userId: TEACHER_ID,
  identityMode: 'alias',
  displayName: 'Polity Guru',
  avatarPath: null,
  bioEn: null,
  bioHi: null,
  videosVisible: true,
};

const VIDEO: TeacherVideo = {
  id: '33333333-3333-4333-8333-333333333333',
  teacherId: TEACHER_ID,
  youtubeId: 'dQw4w9WgXcQ',
  title: 'Preamble in 10 minutes',
  thumbUrl: null,
  position: 1,
};

beforeEach(() => {
  readStudentContext.mockReset().mockResolvedValue({
    session: SESSION,
    configured: true,
    mode: 'en',
    examIds: [],
  });
  readStudentVideosResult
    .mockReset()
    .mockResolvedValue({ ok: true, data: { teacher: TEACHER, videos: [] } });
});

describe('the videos screen when the read succeeded with zero rows', () => {
  it('keeps the friendly empty state', async () => {
    render(await TeacherVideosPage({ params }));

    expect(screen.getByText(en['videos.none'])).toBeInTheDocument();
  });
});

describe('the videos screen when the read FAILED', () => {
  beforeEach(() => {
    readStudentVideosResult.mockResolvedValue({ ok: false });
  });

  it('shows the shared error state', async () => {
    render(await TeacherVideosPage({ params }));

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
  });

  it('never shows the empty-state text', async () => {
    render(await TeacherVideosPage({ params }));

    expect(screen.queryByText(en['videos.none'])).not.toBeInTheDocument();
  });

  it('never shows the not-found line: unreadable is not "no such teacher"', async () => {
    render(await TeacherVideosPage({ params }));

    for (const line of en['portfolio.notFound'].split('\n')) {
      expect(screen.queryByText(line)).not.toBeInTheDocument();
    }
  });

  it('offers Retry', async () => {
    render(await TeacherVideosPage({ params }));

    expect(screen.getByRole('button', { name: en['read.retry'] })).toBeInTheDocument();
  });

  it('shows the error state in Hindi too', async () => {
    readStudentContext.mockResolvedValue({
      session: SESSION,
      configured: true,
      mode: 'hi',
      examIds: [],
    });
    render(await TeacherVideosPage({ params }));

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.hi['read.failed']);
  });

  it('names no table, column, key or status', async () => {
    render(await TeacherVideosPage({ params }));

    const text = screen.getByRole('status').textContent ?? '';
    for (const leak of ['teacher_videos', 'teachers_public', 'column', '400', '500']) {
      expect(text).not.toContain(leak);
    }
  });
});

describe('the videos screen on an OK read', () => {
  it('still lists the videos', async () => {
    readStudentVideosResult.mockResolvedValue({
      ok: true,
      data: { teacher: TEACHER, videos: [VIDEO] },
    });
    render(await TeacherVideosPage({ params }));

    expect(screen.getByText('Preamble in 10 minutes')).toBeInTheDocument();
    expect(screen.queryByText(en['read.failed'])).not.toBeInTheDocument();
  });

  it('keeps the not-found line when there is no such teacher', async () => {
    readStudentVideosResult.mockResolvedValue({
      ok: true,
      data: { teacher: null, videos: [] },
    });
    render(await TeacherVideosPage({ params }));

    expect(screen.getByRole('status')).toHaveTextContent(
      en['portfolio.notFound'].split('\n')[0] ?? '',
    );
  });
});
