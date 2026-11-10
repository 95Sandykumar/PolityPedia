/**
 * The Home and Teachers lists when the read FAILED
 * (issue 54b-read-errors-home-teachers).
 *
 * Definition of done: "When a read fails (HTTP error or thrown error) the
 * screen shows the shared error state and never the empty-state text. A read
 * that succeeds with zero rows still shows the empty-state text. The message
 * names no table, column or key."
 *
 * Both lists are used in two places each, so `failed` is checked in both
 * shapes: the Teachers tab cards (`variant="list"`) and the Home avatar strip
 * (`variant="strip"`).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PostList } from '../post-list';
import { TeachersList } from '../teachers-list';
import { dictionary } from '@/lib/i18n';
import type { TeacherPost } from '@/lib/posts/types';
import type { PublicTeacher } from '@/lib/teachers/types';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const en = dictionary.en;

const TEACHER: PublicTeacher = {
  userId: '44444444-4444-4444-8444-444444444444',
  identityMode: 'alias',
  displayName: 'Polity Guru',
  avatarPath: null,
  bioEn: null,
  bioHi: null,
  videosVisible: true,
};

const POST: TeacherPost = {
  id: '66666666-6666-4666-8666-666666666666',
  teacherId: TEACHER.userId,
  priority: 0,
  heading: 'Class moved to Monday',
  link: null,
  createdAt: '2026-11-08T10:00:00.000Z',
};

describe('TeachersList: a read that succeeded with zero rows', () => {
  it('still shows the friendly empty state on the Teachers tab', () => {
    render(<TeachersList teachers={[]} titleKey="teachers.title" emptyKey="teachers.none" />);

    expect(screen.getByRole('status')).toHaveTextContent(en['teachers.none']);
  });

  it('still shows the friendly empty state on the Home strip', () => {
    render(
      <TeachersList
        teachers={[]}
        titleKey="sui.yourTeachers"
        emptyKey="home.followingNone"
        variant="strip"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(en['home.followingNone']);
  });
});

describe('TeachersList: a read that FAILED', () => {
  it('shows the error state instead', () => {
    render(
      <TeachersList teachers={[]} titleKey="teachers.title" emptyKey="teachers.none" failed />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
  });

  it('never shows the empty-state text', () => {
    render(
      <TeachersList teachers={[]} titleKey="teachers.title" emptyKey="teachers.none" failed />,
    );

    expect(screen.queryByText(en['teachers.none'])).not.toBeInTheDocument();
  });

  it('names no table, column, key or status code', () => {
    render(
      <TeachersList teachers={[]} titleKey="teachers.title" emptyKey="teachers.none" failed />,
    );

    const said = document.body.textContent ?? '';
    for (const leak of ['teachers_public', 'supabase', 'select', '400', 'teacher_id', 'anon']) {
      expect(said.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it('offers Retry, and Retry re-runs the server read', () => {
    refresh.mockClear();
    render(
      <TeachersList teachers={[]} titleKey="teachers.title" emptyKey="teachers.none" failed />,
    );

    fireEvent.click(screen.getByRole('button', { name: en['read.retry'] }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the error state in Hindi too', () => {
    render(
      <TeachersList
        teachers={[]}
        titleKey="teachers.title"
        emptyKey="teachers.none"
        failed
        mode="hi"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.hi['read.failed']);
  });

  it('beats the rows: a part-read strip is never shown as if it were whole', () => {
    render(
      <TeachersList
        teachers={[TEACHER]}
        titleKey="sui.yourTeachers"
        emptyKey="home.followingNone"
        variant="strip"
        failed
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
    expect(screen.queryByText('Polity Guru')).not.toBeInTheDocument();
  });
});

describe('PostList: a read that succeeded with zero rows', () => {
  it('still shows the friendly empty state', () => {
    render(<PostList posts={[]} titleKey="posts.homeTitle" emptyKey="posts.homeNone" />);

    expect(screen.getByRole('status')).toHaveTextContent(en['posts.homeNone']);
  });
});

describe('PostList: a read that FAILED', () => {
  it('shows the error state instead', () => {
    render(<PostList posts={[]} titleKey="posts.homeTitle" emptyKey="posts.homeNone" failed />);

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
  });

  it('never shows the empty-state text', () => {
    render(<PostList posts={[]} titleKey="posts.homeTitle" emptyKey="posts.homeNone" failed />);

    expect(screen.queryByText(en['posts.homeNone'])).not.toBeInTheDocument();
  });

  it('offers Retry, and Retry re-runs the server read', () => {
    refresh.mockClear();
    render(<PostList posts={[]} titleKey="posts.homeTitle" emptyKey="posts.homeNone" failed />);

    fireEvent.click(screen.getByRole('button', { name: en['read.retry'] }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('beats the rows: a part-read feed is never shown as if it were whole', () => {
    render(
      <PostList posts={[POST]} titleKey="posts.homeTitle" emptyKey="posts.homeNone" failed />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
    expect(screen.queryByText('Class moved to Monday')).not.toBeInTheDocument();
  });
});
