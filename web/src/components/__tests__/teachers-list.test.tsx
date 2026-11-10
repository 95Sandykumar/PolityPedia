/**
 * Issue 06-portfolio-follow: the Teachers tab list, and the followed-teacher
 * list on Home. One component, two titles.
 *
 * The rows come from `teachers_public`, so an alias teacher is listed by their
 * alias and there is no real-name field to leak.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeachersList } from '../teachers-list';
import { dictionary } from '@/lib/i18n';
import type { PublicTeacher, TeacherCard } from '@/lib/teachers/types';

// The shared read-error state offers Retry, which calls `router.refresh()`.
// There is no App Router in a component test, so the hook is faked.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const ALIAS: PublicTeacher = {
  userId: '44444444-4444-4444-8444-444444444444',
  identityMode: 'alias',
  displayName: 'Polity Guru',
  avatarPath: null,
  bioEn: null,
  bioHi: null,
  videosVisible: true,
};

const SHOWN: PublicTeacher = {
  userId: '55555555-5555-4555-8555-555555555555',
  identityMode: 'public',
  displayName: 'Meera Das',
  avatarPath: 'https://cdn.test/meera.webp',
  bioEn: null,
  bioHi: null,
  videosVisible: true,
};

describe('TeachersList', () => {
  it('lists every teacher and links each row to their portfolio', () => {
    render(
      <TeachersList
        teachers={[ALIAS, SHOWN]}
        titleKey="teachers.title"
        emptyKey="teachers.none"
      />,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      dictionary.en['teachers.title'],
    );
    expect(screen.getByRole('link', { name: 'Polity Guru' })).toHaveAttribute(
      'href',
      `/t/${ALIAS.userId}`,
    );
    expect(screen.getByRole('link', { name: 'Meera Das' })).toHaveAttribute(
      'href',
      `/t/${SHOWN.userId}`,
    );
  });

  it('shows one empty line when nobody is there', () => {
    render(<TeachersList teachers={[]} titleKey="home.following" emptyKey="home.followingNone" />);

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['home.followingNone']);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('says so when Supabase is not set up', () => {
    render(
      <TeachersList
        teachers={[]}
        titleKey="teachers.title"
        emptyKey="teachers.none"
        configured={false}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['teachers.notConfigured']);
  });

  it('shows the Hindi title too in both mode', () => {
    render(
      <TeachersList
        teachers={[ALIAS]}
        titleKey="teachers.title"
        emptyKey="teachers.none"
        mode="both"
      />,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      dictionary.hi['teachers.title'],
    );
  });
});

/**
 * Issue 67-teachers-filter-and-free-badge: the exam filter switch and the
 * free-sample badge.
 *
 * The switch is TWO LINKS, not a button and not a form: the list is server
 * rendered, so the filter has to live in the URL. A link also means back
 * works and the filtered list can be shared.
 *
 * The badge is only ever drawn from `hasFreeSample`, which the
 * `teacher_cards` view decides in SQL (0050). The component never looks at a
 * set or a test, so a draft set cannot light it.
 */
const FREE: TeacherCard = { ...SHOWN, hasFreeSample: true };
const PAID: TeacherCard = { ...ALIAS, hasFreeSample: false };

const en = dictionary.en;

describe('TeachersList exam filter switch', () => {
  it('is two links: My exams and Show all', () => {
    render(
      <TeachersList
        teachers={[PAID]}
        titleKey="teachers.title"
        emptyKey="teachers.none"
        examFilter="mine"
      />,
    );

    expect(screen.getByRole('link', { name: en['teachers.myExams'] })).toHaveAttribute(
      'href',
      '/teachers',
    );
    expect(screen.getByRole('link', { name: en['teachers.showAll'] })).toHaveAttribute(
      'href',
      '/teachers?all=1',
    );
  });

  it('marks the exam-filtered view as the current one by default', () => {
    render(
      <TeachersList
        teachers={[PAID]}
        titleKey="teachers.title"
        emptyKey="teachers.none"
        examFilter="mine"
      />,
    );

    expect(screen.getByRole('link', { name: en['teachers.myExams'] })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: en['teachers.showAll'] })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks Show all as the current one when everybody is listed', () => {
    render(
      <TeachersList
        teachers={[PAID]}
        titleKey="teachers.title"
        emptyKey="teachers.none"
        examFilter="all"
      />,
    );

    expect(screen.getByRole('link', { name: en['teachers.showAll'] })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps the switch on screen when the filtered list is EMPTY, so Show all is reachable', () => {
    render(
      <TeachersList
        teachers={[]}
        titleKey="teachers.title"
        emptyKey="teachers.noneForExams"
        examFilter="mine"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(en['teachers.noneForExams']);
    expect(screen.getByRole('link', { name: en['teachers.showAll'] })).toBeInTheDocument();
  });

  it('keeps the switch on screen when the read FAILED', () => {
    render(
      <TeachersList
        teachers={[]}
        titleKey="teachers.title"
        emptyKey="teachers.none"
        examFilter="mine"
        failed
      />,
    );

    expect(screen.getByRole('link', { name: en['teachers.showAll'] })).toBeInTheDocument();
  });

  it('draws no switch where there is no filter, which is the Home strip', () => {
    render(
      <TeachersList teachers={[PAID]} titleKey="home.following" emptyKey="home.followingNone" />,
    );

    expect(screen.queryByRole('link', { name: en['teachers.showAll'] })).not.toBeInTheDocument();
  });
});

describe('TeachersList free-sample badge', () => {
  it('shows the badge on a card whose teacher has a free sample', () => {
    render(
      <TeachersList teachers={[FREE]} titleKey="teachers.title" emptyKey="teachers.none" />,
    );

    expect(screen.getByText(en['teachers.freeSample'])).toBeInTheDocument();
  });

  it('shows NO badge when the flag is false', () => {
    render(
      <TeachersList teachers={[PAID]} titleKey="teachers.title" emptyKey="teachers.none" />,
    );

    expect(screen.queryByText(en['teachers.freeSample'])).not.toBeInTheDocument();
  });

  it('shows NO badge for a plain teacher row with no flag at all', () => {
    render(
      <TeachersList teachers={[SHOWN]} titleKey="teachers.title" emptyKey="teachers.none" />,
    );

    expect(screen.queryByText(en['teachers.freeSample'])).not.toBeInTheDocument();
  });

  it('says it in Hindi too', () => {
    render(
      <TeachersList
        teachers={[FREE]}
        titleKey="teachers.title"
        emptyKey="teachers.none"
        mode="hi"
      />,
    );

    expect(screen.getByText(dictionary.hi['teachers.freeSample'])).toBeInTheDocument();
  });
});
