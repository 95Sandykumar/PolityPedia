/**
 * The Teachers tab wiring: a FAILED read reaches the screen as an error state
 * (issue 54b-read-errors-home-teachers).
 *
 * The component tests prove `TeachersList` renders the right state for a given
 * `failed`. This proves the PAGE hands it the right `failed`, which is the half
 * that was broken: the reader already knew, and the page threw the answer away.
 *
 * The readers are faked, so nothing here touches the network and no real key
 * exists in the suite (web/CLAUDE.md).
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionary } from '@/lib/i18n';
import type { TeacherCard } from '@/lib/teachers/types';

const readStudentContext = vi.fn();
const readTeacherCardsResult = vi.fn();
const readFollowedTeachersResult = vi.fn();

vi.mock('@/lib/follows/student-page', () => ({
  readStudentContext: () => readStudentContext(),
  readTeacherCardsResult: (...args: unknown[]) => readTeacherCardsResult(...args),
  readFollowedTeachersResult: (...args: unknown[]) => readFollowedTeachersResult(...args),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { default: TeachersPage } = await import('@/app/(student)/teachers/page');

const en = dictionary.en;

const SESSION = {
  userId: '11111111-1111-4111-8111-111111111111',
  accessToken: 'student.access.token',
  refreshToken: 'student.refresh.token',
  expiresAt: 4_000_000_000,
};

const TEACHER: TeacherCard = {
  userId: '44444444-4444-4444-8444-444444444444',
  identityMode: 'alias',
  displayName: 'Polity Guru',
  avatarPath: null,
  bioEn: null,
  bioHi: null,
  videosVisible: true,
  hasFreeSample: false,
};

beforeEach(() => {
  readStudentContext
    .mockReset()
    // No exam picked, so the page shows every teacher: this file is about the
    // read ERROR, not about the exam filter (issue 67 covers that).
    .mockResolvedValue({ session: SESSION, configured: true, mode: 'en', examIds: [] });
  readTeacherCardsResult.mockReset().mockResolvedValue({ ok: true, data: [] });
  readFollowedTeachersResult.mockReset().mockResolvedValue({ ok: true, data: [] });
});

describe('/teachers when the read succeeded with zero rows', () => {
  it('keeps the friendly empty state', async () => {
    render(await TeachersPage({}));

    expect(screen.getByRole('status')).toHaveTextContent(en['teachers.none']);
  });
});

describe('/teachers when the read FAILED', () => {
  it('shows the shared error state', async () => {
    readTeacherCardsResult.mockResolvedValue({ ok: false });
    render(await TeachersPage({}));

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
  });

  it('never shows the empty-state text', async () => {
    readTeacherCardsResult.mockResolvedValue({ ok: false });
    render(await TeachersPage({}));

    expect(screen.queryByText(en['teachers.none'])).not.toBeInTheDocument();
  });

  it('offers Retry', async () => {
    readTeacherCardsResult.mockResolvedValue({ ok: false });
    render(await TeachersPage({}));

    expect(screen.getByRole('button', { name: en['read.retry'] })).toBeInTheDocument();
  });
});

describe('/teachers when only the FOLLOWED read failed', () => {
  it('still lists the teachers: the follow read only draws a pill', async () => {
    readTeacherCardsResult.mockResolvedValue({ ok: true, data: [TEACHER] });
    readFollowedTeachersResult.mockResolvedValue({ ok: false });
    render(await TeachersPage({}));

    expect(screen.getByText('Polity Guru')).toBeInTheDocument();
    expect(screen.queryByText(en['read.failed'])).not.toBeInTheDocument();
  });

  it('leaves the Following pill off rather than guessing', async () => {
    readTeacherCardsResult.mockResolvedValue({ ok: true, data: [TEACHER] });
    readFollowedTeachersResult.mockResolvedValue({ ok: false });
    render(await TeachersPage({}));

    expect(screen.queryByText(en['follow.following'])).not.toBeInTheDocument();
  });
});
