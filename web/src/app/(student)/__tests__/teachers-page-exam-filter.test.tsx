/**
 * The Teachers tab wiring for issue 67-teachers-filter-and-free-badge: the
 * list is cut to the student's own exams by default, and `?all=1` lifts the
 * cut.
 *
 * The component tests prove `TeachersList` draws the switch and the badge for
 * a given prop. This proves the PAGE asks the reader for the right rows, which
 * is the half the component cannot see: the filter is a query parameter, so a
 * page that forgets it would look perfect and list the wrong teachers.
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

const MY_EXAMS = ['22222222-2222-4222-8222-222222222222'];

const FREE: TeacherCard = {
  userId: '44444444-4444-4444-8444-444444444444',
  identityMode: 'alias',
  displayName: 'Polity Guru',
  avatarPath: null,
  bioEn: null,
  bioHi: null,
  videosVisible: true,
  hasFreeSample: true,
};

const PAID: TeacherCard = { ...FREE, userId: '55555555-5555-4555-8555-555555555555', displayName: 'Meera Das', hasFreeSample: false };

/** The reader input the page used, which is the whole point of these tests. */
const filterArg = () => readTeacherCardsResult.mock.calls[0]?.[1];

beforeEach(() => {
  readStudentContext
    .mockReset()
    .mockResolvedValue({ session: SESSION, configured: true, mode: 'en', examIds: MY_EXAMS });
  readTeacherCardsResult.mockReset().mockResolvedValue({ ok: true, data: [] });
  readFollowedTeachersResult.mockReset().mockResolvedValue({ ok: true, data: [] });
});

describe('/teachers with no query', () => {
  it("asks for the student's own exams only", async () => {
    render(await TeachersPage({ searchParams: Promise.resolve({}) }));

    expect(filterArg()).toEqual({ examIds: MY_EXAMS });
  });

  it('marks My exams as the current view', async () => {
    render(await TeachersPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('link', { name: en['teachers.myExams'] })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('says "no teachers for your exams", not the flat empty line', async () => {
    render(await TeachersPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('status')).toHaveTextContent(en['teachers.noneForExams']);
  });
});

describe('/teachers?all=1', () => {
  it('asks for every approved teacher', async () => {
    render(await TeachersPage({ searchParams: Promise.resolve({ all: '1' }) }));

    expect(filterArg()).toEqual({});
  });

  it('marks Show all as the current view', async () => {
    render(await TeachersPage({ searchParams: Promise.resolve({ all: '1' }) }));

    expect(screen.getByRole('link', { name: en['teachers.showAll'] })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps the flat empty line, because no exam was asked about', async () => {
    render(await TeachersPage({ searchParams: Promise.resolve({ all: '1' }) }));

    expect(screen.getByRole('status')).toHaveTextContent(en['teachers.none']);
  });
});

/**
 * The student layout sends a student with no exams to onboarding, so this
 * should not happen. If it ever does, the reader fails CLOSED on an empty
 * list of ids, which would hide EVERY teacher and give no reason. Listing
 * everybody is the honest answer to "teachers for your exams" when there is
 * no exam.
 */
describe('/teachers for a student who picked no exam', () => {
  it('lists everybody instead of nobody', async () => {
    readStudentContext.mockResolvedValue({
      session: SESSION,
      configured: true,
      mode: 'en',
      examIds: [],
    });
    render(await TeachersPage({ searchParams: Promise.resolve({}) }));

    expect(filterArg()).toEqual({});
  });
});

describe('/teachers badges', () => {
  it('shows the badge only on the teacher whose flag is true', async () => {
    readTeacherCardsResult.mockResolvedValue({ ok: true, data: [FREE, PAID] });
    render(await TeachersPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getAllByText(en['teachers.freeSample'])).toHaveLength(1);
  });
});

describe('/teachers when the card read FAILED', () => {
  it('shows the shared error state and still offers Show all', async () => {
    readTeacherCardsResult.mockResolvedValue({ ok: false });
    render(await TeachersPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
    expect(screen.getByRole('link', { name: en['teachers.showAll'] })).toBeInTheDocument();
  });
});
