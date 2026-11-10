/**
 * The Practice hub when the read FAILED
 * (issue 54c-read-errors-saved-practice-media).
 *
 * Definition of done: "When a read fails (HTTP error or thrown error) the
 * screen shows the shared error state and never the empty-state text. A read
 * that succeeds with zero rows still shows the empty-state text."
 *
 * The hub reads the FOLLOWED teachers, with the same
 * `readFollowedTeachersResult` Home uses (built in 54b). The two reads below
 * are real reads through an injected `fetch`, so this proves the whole path:
 * a 400 ends as the error state, a 200 with `[]` ends as the empty state.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PracticeHub } from '../practice-hub';
import { readFollowedTeachersResult } from '@/lib/follows/student-page';
import type { AuthSession } from '@/lib/auth/types';
import { dictionary } from '@/lib/i18n';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const en = dictionary.en;

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

const STUDENT = '11111111-1111-4111-8111-111111111111';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const SESSION = { userId: STUDENT, accessToken: 'student.token' } as AuthSession;

function always(body: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

/** What the page does: read, then hand `ok` and `data` down separately. */
async function hubProps(fetchImpl: typeof fetch) {
  const read = await readFollowedTeachersResult(SESSION, { env: ENV, fetchImpl });
  return { teachers: read.ok ? read.data : [], failed: !read.ok };
}

describe('a read that succeeded with zero rows', () => {
  it('still shows the friendly empty state', async () => {
    const props = await hubProps(always([]));

    expect(props).toEqual({ teachers: [], failed: false });
    render(<PracticeHub {...props} />);

    expect(screen.getByRole('status')).toHaveTextContent(en['sui.practiceNone']);
  });
});

describe('a read that FAILED with a 400', () => {
  it('shows the error state', async () => {
    const props = await hubProps(always({ message: 'bad request' }, 400));

    expect(props).toEqual({ teachers: [], failed: true });
    render(<PracticeHub {...props} />);

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
  });

  it('never shows the empty-state text', async () => {
    render(<PracticeHub {...(await hubProps(always({ message: 'bad' }, 400)))} />);

    expect(screen.queryByText(en['sui.practiceNone'])).not.toBeInTheDocument();
  });

  it('names no table, column, key or status', async () => {
    const props = await hubProps(
      always({ message: 'column follows.archived_at does not exist' }, 400),
    );
    render(<PracticeHub {...props} />);

    const text = screen.getByRole('status').textContent ?? '';
    for (const leak of ['follows', 'archived_at', 'column', '400']) {
      expect(text).not.toContain(leak);
    }
  });
});

describe('the hub on a failed read, rendered directly', () => {
  it('offers Retry, and Retry re-runs the server read', async () => {
    const { fireEvent } = await import('@testing-library/react');
    refresh.mockClear();
    render(<PracticeHub teachers={[]} failed />);

    fireEvent.click(screen.getByRole('button', { name: en['read.retry'] }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the error state in Hindi too', () => {
    render(<PracticeHub teachers={[]} failed mode="hi" />);

    expect(screen.getByRole('status')).toHaveTextContent(dictionary.hi['read.failed']);
  });

  it('beats the cards: a part-read list is never shown as if it were whole', () => {
    render(
      <PracticeHub
        teachers={[
          {
            userId: TEACHER,
            identityMode: 'public',
            displayName: 'Dr Meena Rao',
            avatarPath: null,
            bioEn: null,
            bioHi: null,
            videosVisible: true,
          },
        ]}
        failed
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(en['read.failed']);
    expect(screen.queryByText('Dr Meena Rao')).not.toBeInTheDocument();
  });

  it('leaves the "not set up" line alone: no keys is not a failed read', () => {
    render(<PracticeHub teachers={[]} configured={false} />);

    expect(screen.getByRole('status')).toHaveTextContent(en['player.notConfigured']);
  });
});
