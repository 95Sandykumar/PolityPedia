'use client';

/**
 * Teacher portfolio, student view (issue 06-portfolio-follow).
 *
 * DESIGN.md section 8: header with the photo or alias avatar and the name, a
 * 2 x 2 tile grid (Videos, Past papers, Mock tests, Notifications: icon plus
 * one word), and a full-width Follow button. Primary while not following,
 * outline "Following" with a check once followed.
 *
 * Student-ui pass (2026-11-06): the header is now a hero card (avatar, name,
 * bio, the exams taught, the next exam pill and the Follow button together),
 * and each tile shows what is behind it with a count. The Follow button moved
 * from under the tiles into the hero on the owner's brief; logged in
 * DECISIONS.md. Tiles are 128 px tall instead of 96 so the caption and the
 * count fit.
 *
 * PRD F-A2: Follow is FREE. The v0 name "Subscribe" is gone.
 *
 * PRIVACY (PRD F-A5): the input is a `PublicTeacher`, the shape of the
 * `teachers_public` view, which has no real-name field. An alias teacher shows
 * their alias here because that is the only name the database handed over.
 *
 * The tiles are links to the teacher's pages (issues 07 to 09). A client
 * component because of the Follow button only, and the client is a prop so the
 * test can inject a fake: no real network call and no real key (web/CLAUDE.md).
 *
 * A tile link keeps `aria-label` = its one word, so its name stays stable; the
 * count is tied to it with `aria-describedby`.
 */
import { Bell, Check, FileText, ListChecks, Plus, Video, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { TeacherAvatar } from '@/components/teacher-avatar';
import { CARD, IconChip } from '@/components/student-ui';
import { createBrowserFollowsClient } from '@/lib/follows/browser-follows-client';
import { examLabels, type Exam } from '@/lib/exams/types';
import { tilePath, type BrowserFollowsClient, type TileSlug } from '@/lib/follows/types';
import { nextExamLines, type NextExam } from '@/lib/teacher-exams/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import type { PublicTeacher } from '@/lib/teachers/types';
import { cn } from '@/lib/utils';

interface Tile {
  slug: TileSlug;
  key: MessageKey;
  hintKey: MessageKey;
  Icon: LucideIcon;
}

/** How many things sit behind each tile. `null` means it could not be read. */
export interface TileCounts {
  videos: number | null;
  papers: number | null;
  mocks: number | null;
  news: number | null;
}

/** The four tiles of PRD F-A3, in the order DESIGN.md draws them. */
export const TILES: readonly Tile[] = [
  { slug: 'videos', key: 'tile.videos', hintKey: 'sui.tileVideosHint', Icon: Video },
  { slug: 'papers', key: 'tile.papers', hintKey: 'sui.tilePapersHint', Icon: FileText },
  { slug: 'mocks', key: 'tile.mocks', hintKey: 'sui.tileMocksHint', Icon: ListChecks },
  { slug: 'news', key: 'tile.news', hintKey: 'sui.tileNewsHint', Icon: Bell },
];

export function TeacherPortfolio({
  teacher,
  following: initial,
  client,
  nextExam = null,
  counts,
  exams = [],
  mode = DEFAULT_MODE,
  configured = true,
}: {
  teacher: PublicTeacher;
  /** Read on the server from `follows`, so the button is right on first paint. */
  following: boolean;
  client?: BrowserFollowsClient;
  /**
   * The nearest future exam date, already picked on the server
   * (issue 07-next-exam-date-teacher-shell). Null hides the pill, which is
   * what a past date or no date at all comes out as.
   */
  nextExam?: NextExam | null;
  /** Item counts for the four tiles (student-ui). Missing hides the pills. */
  counts?: TileCounts;
  /** The exams this teacher teaches, for the chips in the hero. */
  exams?: readonly Exam[];
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserFollowsClient(), []);
  const follows = client ?? fallback;

  // V6: comes straight off `teachers_public`, so the teacher's own switch
  // decides whether the Videos tile opens (issue 08-videos-tile).
  const videosVisible = teacher.videosVisible;

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

  const bioSource =
    mode === 'hi'
      ? [teacher.bioHi ?? teacher.bioEn]
      : mode === 'both'
        ? [teacher.bioEn, teacher.bioHi]
        : [teacher.bioEn ?? teacher.bioHi];
  const bioLines = bioSource.filter(
    (line): line is string => typeof line === 'string' && line.length > 0,
  );

  return (
    <section className="flex flex-col gap-4">
      {/* The hero: who this teacher is, what they teach and the one action. */}
      <header className={`${CARD} flex flex-col gap-4 p-4`}>
        <div className="flex items-center gap-4">
          <TeacherAvatar
            displayName={teacher.displayName}
            avatarPath={teacher.avatarPath}
            size={72}
          />
          <div className="flex min-w-0 flex-col items-start gap-2">
            <h1 className="text-[22px] leading-8 font-bold">{teacher.displayName}</h1>
            {/* 999 px radius: a pill, not a card (DESIGN.md section 0). */}
            {nextExam ? (
              <p className="rounded-full bg-primary/10 px-3 py-0.5 text-sm leading-6 font-medium text-primary">
                {nextExamLines(nextExam, mode).map((line, index) => (
                  <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
                    {line}
                  </span>
                ))}
              </p>
            ) : null}
          </div>
        </div>

        {bioLines.length > 0 ? (
          <div className="flex flex-col gap-1 text-base leading-6 text-muted-foreground">
            {bioLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ) : null}

        {exams.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm leading-5 font-medium text-muted-foreground">
              {plain('sui.examsTaught', mode)}
            </p>
            <ul className="flex flex-wrap gap-2">
              {exams.map((exam) => (
                <li
                  key={exam.id}
                  className="rounded-full border border-border px-3 py-1 text-sm leading-5 font-medium"
                >
                  {examLabels(exam, mode).map((line, index) => (
                    <span key={line} className={index === 0 ? 'block' : 'block text-xs'}>
                      {line}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {failed ? (
          <p
            role="alert"
            className="rounded-[10px] border border-wrong-icon bg-wrong-soft p-3 text-wrong"
          >
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
                ? 'border border-primary bg-card text-primary'
                : 'bg-primary text-primary-foreground',
            )}
          >
            {following && !busy ? (
              <Check size={20} strokeWidth={2} aria-hidden="true" />
            ) : !busy ? (
              <Plus size={20} strokeWidth={2} aria-hidden="true" />
            ) : null}
            <span>{plain(buttonKey, mode)}</span>
          </button>
        ) : (
          <p role="status" className="text-muted-foreground">
            {plain('follow.notConfigured', mode)}
          </p>
        )}
      </header>

      {/* 2 x 2 tile grid (DESIGN.md section 8): icon, one word, what is inside. */}
      <ul className="grid grid-cols-2 gap-3">
        {TILES.map(({ slug, key, hintKey, Icon }) => {
          const count = counts ? counts[slug] : null;
          const hasCount = count !== null && count !== undefined;
          const face = (
            <>
              <span className="flex w-full items-start justify-between">
                <IconChip Icon={Icon} />
                {hasCount ? (
                  <span
                    id={`tile-count-${slug}`}
                    className="rounded-full border border-border px-2 text-sm leading-6 font-bold tabular-nums"
                  >
                    {count}
                  </span>
                ) : null}
              </span>
              <span className="flex flex-col items-start">
                {labels(key, mode).map((line, index) => (
                  <span
                    key={line}
                    className={index === 0 ? 'text-base leading-6 font-bold' : 'text-xs leading-4'}
                  >
                    {line}
                  </span>
                ))}
                <span className="text-sm leading-5 font-normal text-muted-foreground">
                  {plain(hintKey, mode)}
                </span>
              </span>
            </>
          );

          // V6 / PRD F-C2 and DESIGN.md section 8: the Videos tile in "No
          // show" reads "Coming soon", is muted, and DOES NOT OPEN. A plain
          // div, not a disabled link: there is then no href to tap, to
          // middle-click or to reach with the keyboard.
          if (slug === 'videos' && !videosVisible) {
            return (
              <li key={slug}>
                <div
                  aria-disabled="true"
                  className="flex min-h-32 flex-col justify-between gap-3 rounded-[10px] border border-border bg-background p-3 text-muted-foreground"
                >
                  {face}
                  <span className="text-xs">{plain('placeholder.soon', mode)}</span>
                </div>
              </li>
            );
          }

          return (
            <li key={slug}>
              <Link
                href={tilePath(teacher.userId, slug)}
                prefetch={false}
                aria-label={plain(key, mode)}
                aria-describedby={hasCount ? `tile-count-${slug}` : undefined}
                className="flex min-h-32 flex-col justify-between gap-3 rounded-[10px] border border-border bg-card p-3 transition-colors duration-100 hover:border-primary"
              >
                {face}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
