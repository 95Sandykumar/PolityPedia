'use client';

/**
 * Teacher portfolio, student view (issue 06-portfolio-follow).
 *
 * DESIGN.md section 8: header with the photo or alias avatar and the name, a
 * 2 x 2 tile grid (Videos, Past papers, Mock tests, Notifications: icon plus
 * one word, 96 px tall), then a full-width Follow button under the tiles.
 * Primary while not following, outline "Following" with a check once followed.
 *
 * PRD F-A2: Follow is FREE. The v0 name "Subscribe" is gone.
 *
 * PRIVACY (PRD F-A5): the input is a `PublicTeacher`, the shape of the
 * `teachers_public` view, which has no real-name field. An alias teacher shows
 * their alias here because that is the only name the database handed over.
 *
 * The tiles are links to placeholder pages for now; their content is issues 07
 * to 09. A client component because of the Follow button only, and the client
 * is a prop so the test can inject a fake: no real network call and no real
 * key (web/CLAUDE.md).
 */
import { Bell, Check, FileText, ListChecks, Video, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { TeacherAvatar } from '@/components/teacher-avatar';
import { createBrowserFollowsClient } from '@/lib/follows/browser-follows-client';
import { tilePath, type BrowserFollowsClient, type TileSlug } from '@/lib/follows/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import type { PublicTeacher } from '@/lib/teachers/types';
import { cn } from '@/lib/utils';

interface Tile {
  slug: TileSlug;
  key: MessageKey;
  Icon: LucideIcon;
}

/** The four tiles of PRD F-A3, in the order DESIGN.md draws them. */
export const TILES: readonly Tile[] = [
  { slug: 'videos', key: 'tile.videos', Icon: Video },
  { slug: 'papers', key: 'tile.papers', Icon: FileText },
  { slug: 'mocks', key: 'tile.mocks', Icon: ListChecks },
  { slug: 'news', key: 'tile.news', Icon: Bell },
];

export function TeacherPortfolio({
  teacher,
  following: initial,
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  teacher: PublicTeacher;
  /** Read on the server from `follows`, so the button is right on first paint. */
  following: boolean;
  client?: BrowserFollowsClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserFollowsClient(), []);
  const follows = client ?? fallback;

  const [following, setFollowing] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function toggle() {
    if (busy) return;
    const wanted = !following;
    setBusy(true);
    setFailed(false);
    try {
      await follows.setFollowing(teacher.userId, wanted);
      setFollowing(wanted);
    } catch {
      // Fixed message only, and the button stays where it was: nothing in the
      // database changed, so the old state is still the true one.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const buttonKey: MessageKey = busy
    ? 'follow.saving'
    : following
      ? 'follow.following'
      : 'follow.follow';

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center gap-3">
        <TeacherAvatar displayName={teacher.displayName} avatarPath={teacher.avatarPath} />
        <h1 className="text-[22px] leading-7 font-bold">{teacher.displayName}</h1>
      </header>

      {/* 2 x 2, 96 px tall, icon over one word (DESIGN.md section 8). */}
      <ul className="grid grid-cols-2 gap-3">
        {TILES.map(({ slug, key, Icon }) => (
          <li key={slug}>
            <Link
              href={tilePath(teacher.userId, slug)}
              prefetch={false}
              aria-label={plain(key, mode)}
              className="flex h-24 flex-col items-center justify-center gap-1 rounded-[10px] border border-border bg-card text-center text-sm font-medium transition-colors duration-100"
            >
              <Icon size={24} strokeWidth={2} aria-hidden="true" />
              {labels(key, mode).map((line, index) => (
                <span key={line} className={index === 0 ? undefined : 'text-xs'}>
                  {line}
                </span>
              ))}
            </Link>
          </li>
        ))}
      </ul>

      {failed ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain('follow.failed', mode)}
        </p>
      ) : null}

      {configured ? (
        <button
          type="button"
          disabled={busy}
          aria-pressed={following}
          onClick={() => void toggle()}
          aria-label={plain(buttonKey, mode)}
          className={cn(
            'flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] px-3 text-base font-medium transition-colors duration-100 disabled:opacity-60',
            following
              ? 'border border-border bg-card text-foreground'
              : 'bg-primary text-primary-foreground',
          )}
        >
          {following && !busy ? <Check size={20} strokeWidth={2} aria-hidden="true" /> : null}
          <span>{plain(buttonKey, mode)}</span>
        </button>
      ) : (
        <p role="status" className="text-muted-foreground">
          {plain('follow.notConfigured', mode)}
        </p>
      )}
    </section>
  );
}
