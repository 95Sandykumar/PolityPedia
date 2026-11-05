/**
 * Issue 08-videos-tile, student side.
 *
 * Definition of done: "Students see each video's thumbnail and title. If the
 * teacher switches Videos to No show, students see a muted 'Coming soon' tile
 * that does not open."
 *
 * Two places show that state, and both are tested here:
 *  1. `StudentVideos`, the page at `/t/<id>/videos`.
 *  2. the Videos tile on the portfolio, which must not be tappable on No show
 *     (DESIGN.md section 8).
 *
 * B4: every thumbnail is a plain `<img loading="lazy">` with width and height
 * set, so the list does not jump while it loads.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StudentVideos } from '../student-videos';
import { TeacherPortfolio } from '../teacher-portfolio';
import { dictionary } from '@/lib/i18n';
import type { TeacherVideo } from '@/lib/videos/types';
import type { PublicTeacher } from '@/lib/teachers/types';

const TEACHER_ID = '11111111-1111-4111-8111-111111111111';

const TEACHER: PublicTeacher = {
  userId: TEACHER_ID,
  identityMode: 'alias',
  displayName: 'Polity Guru',
  avatarPath: null,
  bioEn: null,
  bioHi: null,
  videosVisible: true,
};

const VIDEOS: TeacherVideo[] = [
  {
    id: '22222222-2222-4222-8222-222222222222',
    teacherId: TEACHER_ID,
    youtubeId: 'dQw4w9WgXcQ',
    title: 'Indian Constitution in 10 minutes',
    thumbUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    position: 0,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    teacherId: TEACHER_ID,
    youtubeId: 'aaaaaaaaaaa',
    title: null,
    thumbUrl: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg',
    position: 1,
  },
];

const COMING_SOON = dictionary.en['placeholder.soon'];

/**
 * The thumbnails are DECORATIVE: `alt=""`, because the title sits next to the
 * image as real text and a screen reader must not read it twice. That means
 * their ARIA role is `presentation`, not `img`, so they are collected by tag.
 */
const thumbs = (root: HTMLElement) => Array.from(root.querySelectorAll('img'));

describe('StudentVideos on Show', () => {
  it('shows a thumbnail and a title for each video', () => {
    const { container } = render(<StudentVideos teacher={TEACHER} videos={VIDEOS} />);

    expect(screen.getByText('Indian Constitution in 10 minutes')).toBeInTheDocument();

    const images = thumbs(container);
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('src', VIDEOS[0].thumbUrl);
    expect(images[1]).toHaveAttribute('src', VIDEOS[1].thumbUrl);
  });

  it('loads every thumbnail lazily with width and height set (B4)', () => {
    const { container } = render(<StudentVideos teacher={TEACHER} videos={VIDEOS} />);

    for (const img of thumbs(container)) {
      expect(img).toHaveAttribute('loading', 'lazy');
      expect(img).toHaveAttribute('width');
      expect(img).toHaveAttribute('height');
    }
  });

  it('opens the video on YouTube, because V6 allows YouTube links only', () => {
    render(<StudentVideos teacher={TEACHER} videos={VIDEOS} />);

    const link = screen.getAllByRole('link')[0];
    expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    // A new tab, and never a window that can reach back into our page.
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('falls back to the teacher name when a video has no title', () => {
    render(<StudentVideos teacher={TEACHER} videos={[VIDEOS[1]]} />);
    expect(screen.getAllByText('Polity Guru').length).toBeGreaterThan(0);
  });

  it('says so when the teacher has not added a video yet', () => {
    const { container } = render(<StudentVideos teacher={TEACHER} videos={[]} />);

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['videos.none']);
    expect(thumbs(container)).toHaveLength(0);
  });

  it('shows the Hindi labels in Hindi mode', () => {
    render(<StudentVideos teacher={TEACHER} videos={[]} mode="hi" />);
    expect(screen.getByRole('status')).toHaveTextContent(dictionary.hi['videos.none']);
  });
});

describe('StudentVideos on No show', () => {
  const quiet: PublicTeacher = { ...TEACHER, videosVisible: false };

  it('shows one Coming soon panel and no video at all', () => {
    const { container } = render(<StudentVideos teacher={quiet} videos={VIDEOS} />);

    expect(screen.getByRole('status')).toHaveTextContent(COMING_SOON);
    expect(thumbs(container)).toHaveLength(0);
    expect(screen.queryByText('Indian Constitution in 10 minutes')).toBeNull();
  });

  it('offers nothing to tap', () => {
    render(<StudentVideos teacher={quiet} videos={VIDEOS} />);

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('the Videos tile on the portfolio', () => {
  it('is a link while the teacher is on Show', () => {
    render(<TeacherPortfolio teacher={TEACHER} following={false} />);

    expect(screen.getByRole('link', { name: dictionary.en['tile.videos'] })).toHaveAttribute(
      'href',
      `/t/${TEACHER_ID}/videos`,
    );
  });

  it('reads Coming soon and does not open on No show', () => {
    render(
      <TeacherPortfolio teacher={{ ...TEACHER, videosVisible: false }} following={false} />,
    );

    // No link for Videos, so there is nothing to tap (DESIGN.md section 8).
    expect(screen.queryByRole('link', { name: dictionary.en['tile.videos'] })).toBeNull();
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).not.toContain(`/t/${TEACHER_ID}/videos`);

    // The tile is still there, with its word and Coming soon under it.
    expect(screen.getByText(dictionary.en['tile.videos'])).toBeInTheDocument();
    expect(screen.getByText(COMING_SOON)).toBeInTheDocument();

    // The other three tiles keep working.
    expect(links).toContain(`/t/${TEACHER_ID}/papers`);
    expect(links).toContain(`/t/${TEACHER_ID}/mocks`);
    expect(links).toContain(`/t/${TEACHER_ID}/news`);
  });
});
