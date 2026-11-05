/**
 * Issue 09-teacher-notifications: the teacher screen that adds and deletes
 * notices.
 *
 * Definition of done, teacher half: "A teacher posts a notice (priority,
 * heading, link)." plus "Teacher page to add and delete posts."
 *
 * The client is a prop, so the test injects a fake: no real network call and
 * no real key (web/CLAUDE.md).
 *
 * Permission is NOT this screen's job. The gate is the
 * `teacher_posts_insert_own` and `teacher_posts_delete_own` policies inside
 * Postgres, proved in `test/teacher-posts.test.ts`.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherPostsManager } from '../teacher-posts-manager';
import { dictionary } from '@/lib/i18n';
import type { BrowserTeacherPostsClient, TeacherPost } from '@/lib/posts/types';

const TEACHER = '44444444-4444-4444-8444-444444444444';

function post(partial: Partial<TeacherPost> & { heading: string }): TeacherPost {
  return {
    id: partial.id ?? partial.heading,
    teacherId: TEACHER,
    priority: partial.priority ?? 0,
    heading: partial.heading,
    link: partial.link ?? null,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00Z',
  };
}

const SAVED = post({
  id: '99999999-9999-4999-8999-999999999999',
  heading: 'NET form is out',
  priority: 1,
  link: 'https://ugcnet.nta.ac.in',
  createdAt: '2026-11-05T10:00:00Z',
});

function fakeClient(overrides: Partial<BrowserTeacherPostsClient> = {}): BrowserTeacherPostsClient {
  return {
    create: vi.fn(async () => SAVED),
    remove: vi.fn(async () => {}),
    ...overrides,
  };
}

const headingBox = () => screen.getByLabelText(dictionary.en['posts.heading']);
const linkBox = () => screen.getByLabelText(dictionary.en['posts.link']);
const priorityBox = () => screen.getByLabelText(dictionary.en['posts.priority']);
const addButton = () => screen.getByRole('button', { name: dictionary.en['posts.add'] });

describe('TeacherPostsManager', () => {
  it('adds a post and puts it straight into the list', async () => {
    const client = fakeClient();
    render(<TeacherPostsManager posts={[]} client={client} />);

    fireEvent.change(headingBox(), { target: { value: '  NET form is out  ' } });
    fireEvent.change(priorityBox(), { target: { value: '1' } });
    fireEvent.change(linkBox(), { target: { value: 'https://ugcnet.nta.ac.in' } });
    fireEvent.click(addButton());

    await waitFor(() => {
      expect(client.create).toHaveBeenCalledWith({
        heading: 'NET form is out',
        priority: 1,
        link: 'https://ugcnet.nta.ac.in',
      });
    });

    expect(await screen.findByText('NET form is out')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['posts.added']);
    // The form is clear, ready for the next notice.
    expect(headingBox()).toHaveValue('');
    expect(linkBox()).toHaveValue('');
  });

  it('will not send a blank heading, and never calls the client', async () => {
    const client = fakeClient();
    render(<TeacherPostsManager posts={[]} client={client} />);

    fireEvent.change(headingBox(), { target: { value: '   ' } });
    fireEvent.click(addButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(dictionary.en['posts.needHeading']);
    });
    expect(client.create).not.toHaveBeenCalled();
  });

  it('will not send a link with another scheme', async () => {
    const client = fakeClient();
    render(<TeacherPostsManager posts={[]} client={client} />);

    fireEvent.change(headingBox(), { target: { value: 'Trap' } });
    fireEvent.change(linkBox(), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(addButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(dictionary.en['posts.badLink']);
    });
    expect(client.create).not.toHaveBeenCalled();
  });

  it('keeps the typed text and says so when the save fails', async () => {
    const client = fakeClient({
      create: vi.fn(async () => {
        throw new Error('Request failed with status 502');
      }),
    });
    render(<TeacherPostsManager posts={[]} client={client} />);

    fireEvent.change(headingBox(), { target: { value: 'Class at 6' } });
    fireEvent.click(addButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(dictionary.en['posts.failed']);
    });
    // Nothing was saved, so the teacher does not have to type it again.
    expect(headingBox()).toHaveValue('Class at 6');
  });

  it('deletes a post and drops it out of the list', async () => {
    const client = fakeClient();
    const mine = post({ id: '99999999-9999-4999-8999-999999999999', heading: 'Old notice' });
    render(<TeacherPostsManager posts={[mine]} client={client} />);

    fireEvent.click(screen.getByRole('button', { name: dictionary.en['posts.delete'] }));

    await waitFor(() => expect(client.remove).toHaveBeenCalledWith(mine.id));
    await waitFor(() => expect(screen.queryByText('Old notice')).not.toBeInTheDocument());
  });

  it('keeps the row when the delete fails, because nothing changed', async () => {
    const client = fakeClient({
      remove: vi.fn(async () => {
        throw new Error('Request failed with status 502');
      }),
    });
    const mine = post({ id: '99999999-9999-4999-8999-999999999999', heading: 'Old notice' });
    render(<TeacherPostsManager posts={[mine]} client={client} />);

    fireEvent.click(screen.getByRole('button', { name: dictionary.en['posts.delete'] }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(dictionary.en['posts.failed']);
    });
    expect(screen.getByText('Old notice')).toBeInTheDocument();
  });

  it('lists what is already there, highest priority and newest first', () => {
    render(
      <TeacherPostsManager
        posts={[
          post({ heading: 'old normal', priority: 0, createdAt: '2026-01-01T00:00:00Z' }),
          post({ heading: 'urgent', priority: 2, createdAt: '2025-01-01T00:00:00Z' }),
          post({ heading: 'new normal', priority: 0, createdAt: '2026-03-01T00:00:00Z' }),
        ]}
        client={fakeClient()}
      />,
    );

    const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rows[0]).toContain('urgent');
    expect(rows[1]).toContain('new normal');
    expect(rows[2]).toContain('old normal');
  });

  it('says so when Supabase is not set up, and shows no form', () => {
    render(<TeacherPostsManager posts={[]} client={fakeClient()} configured={false} />);

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['posts.notConfigured']);
    expect(screen.queryByRole('button', { name: dictionary.en['posts.add'] })).toBeNull();
  });
});
