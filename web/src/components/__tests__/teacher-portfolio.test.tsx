/**
 * Issue 06-portfolio-follow: the teacher portfolio a student sees.
 *
 * Definition of done: "opens one, sees the portfolio (avatar, name, 4 tiles:
 * Videos, Past papers, Mock tests, Notifications) and taps Follow. The button
 * then reads 'Following'."
 *
 * The follow client is a prop, so the test injects a fake: no real network
 * call and no real key (web/CLAUDE.md).
 *
 * The privacy test is the alias one: an alias teacher shows the alias, and the
 * component has no real-name field to show even by accident (`PublicTeacher`).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherPortfolio } from '../teacher-portfolio';
import { dictionary } from '@/lib/i18n';
import type { BrowserFollowsClient } from '@/lib/follows/types';
import type { PublicTeacher } from '@/lib/teachers/types';

const ALIAS_TEACHER: PublicTeacher = {
  userId: '44444444-4444-4444-8444-444444444444',
  identityMode: 'alias',
  displayName: 'Polity Guru',
  avatarPath: null,
  bioEn: null,
  bioHi: null,
  videosVisible: true,
};

const PUBLIC_TEACHER: PublicTeacher = {
  userId: '55555555-5555-4555-8555-555555555555',
  identityMode: 'public',
  displayName: 'Meera Das',
  avatarPath: 'https://cdn.test/meera.webp',
  bioEn: null,
  bioHi: null,
  videosVisible: true,
};

function fakeClient(overrides: Partial<BrowserFollowsClient> = {}): BrowserFollowsClient {
  return { setFollowing: vi.fn(async () => {}), ...overrides };
}

const followButton = () => screen.getByRole('button', { name: dictionary.en['follow.follow'] });
const followingButton = () =>
  screen.getByRole('button', { name: dictionary.en['follow.following'] });

describe('TeacherPortfolio', () => {
  it('shows the name and the four tiles, each linking to its own URL', () => {
    render(<TeacherPortfolio teacher={ALIAS_TEACHER} following={false} client={fakeClient()} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Polity Guru');

    const base = `/t/${ALIAS_TEACHER.userId}`;
    for (const [label, slug] of [
      ['tile.videos', 'videos'],
      ['tile.papers', 'papers'],
      ['tile.mocks', 'mocks'],
      ['tile.news', 'news'],
    ] as const) {
      const link = screen.getByRole('link', { name: dictionary.en[label] });
      expect(link).toHaveAttribute('href', `${base}/${slug}`);
    }
    expect(screen.getAllByRole('link')).toHaveLength(4);
  });

  it('shows the alias of an alias teacher and carries no real-name field', () => {
    render(<TeacherPortfolio teacher={ALIAS_TEACHER} following={false} client={fakeClient()} />);

    expect(screen.getByText('Polity Guru')).toBeInTheDocument();
    expect(screen.queryByText('Rahul Sharma')).toBeNull();
    // Nothing to fall back on: the view has no real_name column at all.
    expect(Object.keys(ALIAS_TEACHER)).not.toContain('realName');
  });

  it('falls back to a letter avatar when there is no photo', () => {
    render(<TeacherPortfolio teacher={ALIAS_TEACHER} following={false} client={fakeClient()} />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('P')).toBeInTheDocument();
  });

  it('shows the photo of a teacher who chose public identity', () => {
    render(<TeacherPortfolio teacher={PUBLIC_TEACHER} following={false} client={fakeClient()} />);

    expect(screen.getByRole('img', { name: 'Meera Das' })).toHaveAttribute(
      'src',
      'https://cdn.test/meera.webp',
    );
  });

  it('taps Follow, saves it, and the button then reads Following', async () => {
    const client = fakeClient();
    render(<TeacherPortfolio teacher={ALIAS_TEACHER} following={false} client={client} />);

    fireEvent.click(followButton());

    await waitFor(() =>
      expect(client.setFollowing).toHaveBeenCalledWith(ALIAS_TEACHER.userId, true),
    );
    expect(await screen.findByRole('button', { name: dictionary.en['follow.following'] }))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: dictionary.en['follow.follow'] })).toBeNull();
  });

  it('starts as Following when the student already follows, and taps to unfollow', async () => {
    const client = fakeClient();
    render(<TeacherPortfolio teacher={ALIAS_TEACHER} following client={client} />);

    fireEvent.click(followingButton());

    await waitFor(() =>
      expect(client.setFollowing).toHaveBeenCalledWith(ALIAS_TEACHER.userId, false),
    );
    expect(await screen.findByRole('button', { name: dictionary.en['follow.follow'] }))
      .toBeInTheDocument();
  });

  it('puts the button back and shows one fixed message when the save fails', async () => {
    const client = fakeClient({
      setFollowing: vi.fn(async () => {
        throw new Error('403 new row violates policy follows_insert_own');
      }),
    });
    render(<TeacherPortfolio teacher={ALIAS_TEACHER} following={false} client={client} />);

    fireEvent.click(followButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(dictionary.en['follow.failed']);
    expect(screen.getByRole('alert').textContent).not.toContain('follows_insert_own');
    expect(followButton()).toBeInTheDocument();
  });

  it('says so, and does not offer Follow, when Supabase is not set up', () => {
    render(
      <TeacherPortfolio
        teacher={ALIAS_TEACHER}
        following={false}
        client={fakeClient()}
        configured={false}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['follow.notConfigured']);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows both languages in both mode', () => {
    render(
      <TeacherPortfolio
        teacher={ALIAS_TEACHER}
        following={false}
        client={fakeClient()}
        mode="both"
      />,
    );

    const name = `${dictionary.en['follow.follow']} / ${dictionary.hi['follow.follow']}`;
    expect(screen.getByRole('button', { name })).toBeInTheDocument();
    expect(screen.getByText(dictionary.hi['tile.videos'])).toBeInTheDocument();
  });
});

/**
 * Issue 07-next-exam-date-teacher-shell: the next exam date pill.
 *
 * DESIGN.md section 8: "Header: photo or alias avatar, name, next exam date
 * pill." The page hands the pill in already resolved to the nearest future
 * date, so the component only has to draw it or leave it out.
 */
describe('TeacherPortfolio next exam pill', () => {
  const NEXT_EXAM = {
    label: 'NET',
    nameEn: 'UGC NET Political Science',
    nameHi: 'यूजीसी नेट राजनीति विज्ञान',
    date: '2026-12-18',
  };

  it('shows the pill the PRD sketch asks for', () => {
    render(
      <TeacherPortfolio
        teacher={ALIAS_TEACHER}
        following={false}
        client={fakeClient()}
        nextExam={NEXT_EXAM}
      />,
    );

    expect(screen.getByText('Next exam: NET 18 Dec')).toBeInTheDocument();
  });

  it('leaves the header clean when there is no future date', () => {
    render(<TeacherPortfolio teacher={ALIAS_TEACHER} following={false} client={fakeClient()} />);

    expect(screen.queryByText(/Next exam/)).toBeNull();
  });

  it('writes the pill in Hindi in hi mode', () => {
    render(
      <TeacherPortfolio
        teacher={ALIAS_TEACHER}
        following={false}
        client={fakeClient()}
        nextExam={NEXT_EXAM}
        mode="hi"
      />,
    );

    expect(screen.getByText('अगली परीक्षा: NET 18 दिस')).toBeInTheDocument();
  });
});
