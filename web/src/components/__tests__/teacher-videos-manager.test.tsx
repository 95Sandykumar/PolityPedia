/**
 * Issue 08-videos-tile, teacher side.
 *
 * Definition of done, first line: "A teacher pastes YouTube links." Plus the
 * list, delete, and the Show / No show switch of V6 and PRD F-C2.
 *
 * The client is a prop, so the test injects a fake: no real network call and
 * no real key (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherVideosManager } from '../teacher-videos-manager';
import { dictionary } from '@/lib/i18n';
import type { BrowserVideosClient, TeacherVideo } from '@/lib/videos/types';

const TEACHER_ID = '11111111-1111-4111-8111-111111111111';
const YT = 'dQw4w9WgXcQ';

const ONE: TeacherVideo = {
  id: '22222222-2222-4222-8222-222222222222',
  teacherId: TEACHER_ID,
  youtubeId: YT,
  title: 'Indian Constitution in 10 minutes',
  thumbUrl: `https://i.ytimg.com/vi/${YT}/hqdefault.jpg`,
  position: 0,
};

const TWO: TeacherVideo = {
  id: '33333333-3333-4333-8333-333333333333',
  teacherId: TEACHER_ID,
  youtubeId: 'aaaaaaaaaaa',
  title: 'Fundamental Rights',
  thumbUrl: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg',
  position: 1,
};

function fakeClient(overrides: Partial<BrowserVideosClient> = {}): BrowserVideosClient {
  return {
    add: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    setVisible: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Decorative `alt=""` thumbnails, so collect them by tag, not by role. */
const thumbs = (root: HTMLElement) => Array.from(root.querySelectorAll('img'));

const linkBox = () => screen.getByLabelText(dictionary.en['videos.link']);
const addButton = () => screen.getByRole('button', { name: dictionary.en['videos.add'] });
const deleteButtons = () => screen.getAllByRole('button', { name: dictionary.en['videos.delete'] });
const switchButton = () => screen.getByRole('button', { name: /Show|No show/ });

describe('TeacherVideosManager: paste a link', () => {
  it('sends the pasted link to the client', async () => {
    const client = fakeClient();
    render(<TeacherVideosManager videos={[]} visible client={client} />);

    fireEvent.change(linkBox(), { target: { value: `https://youtu.be/${YT}` } });
    fireEvent.click(addButton());

    await waitFor(() => expect(client.add).toHaveBeenCalledWith(`https://youtu.be/${YT}`));
  });

  it('clears the box after a link is accepted', async () => {
    render(<TeacherVideosManager videos={[]} visible client={fakeClient()} />);

    fireEvent.change(linkBox(), { target: { value: `https://www.youtube.com/watch?v=${YT}` } });
    fireEvent.click(addButton());

    await waitFor(() => expect(linkBox()).toHaveValue(''));
  });

  it('refuses a link that is not YouTube without calling out (V6)', async () => {
    const client = fakeClient();
    render(<TeacherVideosManager videos={[]} visible client={client} />);

    fireEvent.change(linkBox(), { target: { value: 'https://vimeo.com/76979871' } });
    fireEvent.click(addButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(dictionary.en['videos.badLink']);
    expect(client.add).not.toHaveBeenCalled();
  });

  it('shows one fixed message when the write fails', async () => {
    const client = fakeClient({
      add: vi.fn(async () => {
        throw new Error('403 row-level security policy teacher_videos_insert_own');
      }),
    });
    render(<TeacherVideosManager videos={[]} visible client={client} />);

    fireEvent.change(linkBox(), { target: { value: `https://youtu.be/${YT}` } });
    fireEvent.click(addButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(dictionary.en['videos.failed']);
    // The Postgres policy name must never reach the page.
    expect(screen.getByRole('alert').textContent).not.toContain('row-level security');
  });
});

describe('TeacherVideosManager: the list', () => {
  it('lists every video with its thumbnail and title', () => {
    const { container } = render(
      <TeacherVideosManager videos={[ONE, TWO]} visible client={fakeClient()} />,
    );

    expect(screen.getByText('Indian Constitution in 10 minutes')).toBeInTheDocument();
    expect(screen.getByText('Fundamental Rights')).toBeInTheDocument();

    const images = thumbs(container);
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('loading', 'lazy');
    expect(images[0]).toHaveAttribute('width');
    expect(images[0]).toHaveAttribute('height');
  });

  it('says so when there is no video yet', () => {
    render(<TeacherVideosManager videos={[]} visible client={fakeClient()} />);
    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['videos.none']);
  });

  it('deletes the chosen row and takes it off the list', async () => {
    const client = fakeClient();
    render(<TeacherVideosManager videos={[ONE, TWO]} visible client={client} />);

    fireEvent.click(deleteButtons()[0]);

    await waitFor(() => expect(client.remove).toHaveBeenCalledWith(ONE.id));
    await waitFor(() =>
      expect(screen.queryByText('Indian Constitution in 10 minutes')).toBeNull(),
    );
    expect(screen.getByText('Fundamental Rights')).toBeInTheDocument();
  });

  it('keeps the row when the delete fails', async () => {
    const client = fakeClient({
      remove: vi.fn(async () => {
        throw new Error('502');
      }),
    });
    render(<TeacherVideosManager videos={[ONE]} visible client={client} />);

    fireEvent.click(deleteButtons()[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent(dictionary.en['videos.failed']);
    expect(screen.getByText('Indian Constitution in 10 minutes')).toBeInTheDocument();
  });
});

describe('TeacherVideosManager: Show / No show (V6, F-C2)', () => {
  it('reads Show and is pressed while the videos are visible', () => {
    render(<TeacherVideosManager videos={[ONE]} visible client={fakeClient()} />);

    const button = switchButton();
    expect(button).toHaveAccessibleName(dictionary.en['videos.show']);
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches to No show and tells the teacher what a student now sees', async () => {
    const client = fakeClient();
    render(<TeacherVideosManager videos={[ONE]} visible client={client} />);

    fireEvent.click(switchButton());

    await waitFor(() => expect(client.setVisible).toHaveBeenCalledWith(false));
    await waitFor(() =>
      expect(switchButton()).toHaveAccessibleName(dictionary.en['videos.noShow']),
    );
    expect(screen.getByRole('status')).toHaveTextContent(dictionary.en['placeholder.soon']);
  });

  it('switches back to Show', async () => {
    const client = fakeClient();
    render(<TeacherVideosManager videos={[ONE]} visible={false} client={client} />);

    expect(switchButton()).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(switchButton());

    await waitFor(() => expect(client.setVisible).toHaveBeenCalledWith(true));
    await waitFor(() => expect(switchButton()).toHaveAttribute('aria-pressed', 'true'));
  });

  it('leaves the switch where it was when the write fails', async () => {
    const client = fakeClient({
      setVisible: vi.fn(async () => {
        throw new Error('502');
      }),
    });
    render(<TeacherVideosManager videos={[ONE]} visible client={client} />);

    fireEvent.click(switchButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(dictionary.en['videos.failed']);
    expect(switchButton()).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('TeacherVideosManager with no Supabase keys', () => {
  it('says so and offers no box and no switch', () => {
    render(<TeacherVideosManager videos={[]} visible client={fakeClient()} configured={false} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      dictionary.en['videos.notConfigured'],
    );
    expect(screen.queryByLabelText(dictionary.en['videos.link'])).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
