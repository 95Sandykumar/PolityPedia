/**
 * Issue 09-teacher-notifications: the list of notices a student reads.
 *
 * Definition of done, student half: "Students see the teacher's posts on the
 * Notifications tile, highest priority and newest first." and "Home shows the
 * latest posts from followed teachers."
 *
 * The component sorts the rows itself, so a response that arrives in another
 * order still paints the right way round.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PostList } from '../post-list';
import { dictionary } from '@/lib/i18n';
import type { FeedPost, TeacherPost } from '@/lib/posts/types';

const TEACHER = '44444444-4444-4444-8444-444444444444';

function post(partial: Partial<TeacherPost> & { heading: string }): TeacherPost {
  return {
    id: partial.heading,
    teacherId: partial.teacherId ?? TEACHER,
    priority: partial.priority ?? 0,
    heading: partial.heading,
    link: partial.link ?? null,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00Z',
  };
}

function renderList(posts: readonly TeacherPost[] | readonly FeedPost[], extra = {}) {
  return render(
    <PostList posts={posts} titleKey="tile.news" emptyKey="posts.none" {...extra} />,
  );
}

describe('PostList', () => {
  it('shows the highest priority first, then the newest first', () => {
    renderList([
      post({ heading: 'old normal', priority: 0, createdAt: '2026-01-01T00:00:00Z' }),
      post({ heading: 'new normal', priority: 0, createdAt: '2026-03-01T00:00:00Z' }),
      post({ heading: 'old urgent', priority: 2, createdAt: '2026-01-01T00:00:00Z' }),
      post({ heading: 'new important', priority: 1, createdAt: '2026-04-01T00:00:00Z' }),
    ]);

    const headings = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(headings[0]).toContain('old urgent');
    expect(headings[1]).toContain('new important');
    expect(headings[2]).toContain('new normal');
    expect(headings[3]).toContain('old normal');
  });

  it('names the priority in words, never colour alone', () => {
    renderList([
      post({ heading: 'loud', priority: 2 }),
      post({ heading: 'medium', priority: 1 }),
      post({ heading: 'quiet', priority: 0 }),
    ]);

    expect(screen.getByText(dictionary.en['posts.priority2'])).toBeInTheDocument();
    expect(screen.getByText(dictionary.en['posts.priority1'])).toBeInTheDocument();
    // Normal is the default, so it carries no badge at all: minimum text.
    expect(screen.queryByText(dictionary.en['posts.priority0'])).not.toBeInTheDocument();
  });

  it('turns a link into a real anchor that opens safely', () => {
    renderList([post({ heading: 'NET form is out', link: 'https://ugcnet.nta.ac.in' })]);

    const link = screen.getByRole('link', { name: /NET form is out/ });
    expect(link).toHaveAttribute('href', 'https://ugcnet.nta.ac.in');
    expect(link).toHaveAttribute('target', '_blank');
    // An outside page must not get a handle on our tab.
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('refuses to render a link that could run code in the page', () => {
    renderList([post({ heading: 'Trap', link: 'javascript:alert(1)' })]);

    expect(screen.getByText('Trap')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows the author on Home, where several teachers mix', () => {
    const feed: FeedPost[] = [
      { ...post({ heading: 'one' }), teacherName: 'Polity Guru' },
      { ...post({ heading: 'two', teacherId: 'x' }), teacherName: 'Second Guru' },
    ];
    renderList(feed, { showAuthor: true });

    expect(screen.getByText('Polity Guru')).toBeInTheDocument();
    expect(screen.getByText('Second Guru')).toBeInTheDocument();
  });

  it('hides the author on a single teachers own page', () => {
    const feed: FeedPost[] = [{ ...post({ heading: 'one' }), teacherName: 'Polity Guru' }];
    renderList(feed);

    expect(screen.queryByText('Polity Guru')).not.toBeInTheDocument();
  });

  it('says one line when there is nothing yet', () => {
    renderList([]);
    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['posts.none']);
  });

  it('says so when Supabase is not set up, instead of looking empty', () => {
    renderList([], { configured: false });
    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['posts.notConfigured']);
  });

  it('shows both languages in both mode', () => {
    renderList([], { mode: 'both' });

    const title = screen.getByRole('heading', { level: 2 });
    expect(title).toHaveTextContent(dictionary.en['tile.news']);
    expect(title).toHaveTextContent(dictionary.hi['tile.news']);
  });
});
