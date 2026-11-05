/**
 * Issue 06-portfolio-follow: the Teachers tab list, and the followed-teacher
 * list on Home. One component, two titles.
 *
 * The rows come from `teachers_public`, so an alias teacher is listed by their
 * alias and there is no real-name field to leak.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TeachersList } from '../teachers-list';
import { dictionary } from '@/lib/i18n';
import type { PublicTeacher } from '@/lib/teachers/types';

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
