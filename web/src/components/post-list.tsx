/**
 * A read-only list of teacher notices (issue 09-teacher-notifications).
 *
 * One component, two places, because the row is identical in both:
 * - `/t/<id>/news`: one teacher's notices (the Notifications tile, PRD F-A3).
 * - the Home tab: the latest notices from the teachers this student follows,
 *   where `showAuthor` turns the teacher's name on because several mix.
 *
 * V17: these posts are the TOP of the Notifications tile. The nightly news
 * from v0 goes below them in a later slice, so this component is the whole
 * list for now.
 *
 * A server component on purpose: the rows are read on the server with the
 * student's own token, so no key and no list fetch reaches the browser.
 *
 * It sorts again itself (`sortPosts`), so a response that came back in another
 * order still paints loudest-and-newest first.
 *
 * `failed` is the read-error half (issue 54b-read-errors-home-teachers): a
 * broken read used to reach here as an empty list and be announced as "No
 * notices yet", so a student could miss a notice that was actually written.
 *
 * Security: a `link` is rendered as an `href`, so only an http(s) one is drawn
 * at all. `normalizeLink` decides, the route and the client agree, and
 * Postgres has the same check in 0009. Four layers, because a `javascript:`
 * href is a script a student would tap.
 */
import { AlertTriangle, Bell, ExternalLink, Info, Megaphone } from 'lucide-react';
import { ReadError } from '@/components/read-error';
import { CARD, EmptyState, SectionTitle } from '@/components/student-ui';
import { DEFAULT_MODE, plain, type Lang, type LangMode, type MessageKey } from '@/lib/i18n';
import { formatExamDate, isIsoDate } from '@/lib/teacher-exams/types';
import { normalizeLink, sortPosts, type FeedPost, type TeacherPost } from '@/lib/posts/types';
import { cn } from '@/lib/utils';

/** The badge key per priority. Normal gets none: minimum text (DESIGN.md 1). */
const PRIORITY_KEY: Record<number, MessageKey | null> = {
  0: null,
  1: 'posts.priority1',
  2: 'posts.priority2',
};

/**
 * Look per priority (student-ui pass). The colour is never alone: the badge
 * names the level in words and the icon differs (alert, info, megaphone).
 * Urgent uses the amber `--marked` token, important the primary, normal stays
 * a plain border.
 */
const LOOK: Record<
  number,
  { Icon: typeof Bell; bar: string; chip: string; badge: string }
> = {
  0: {
    Icon: Megaphone,
    bar: 'border-l-border',
    chip: 'bg-primary/10 text-primary',
    badge: '',
  },
  1: {
    Icon: Info,
    bar: 'border-l-primary',
    chip: 'bg-primary/10 text-primary',
    badge: 'border-primary text-primary',
  },
  2: {
    Icon: AlertTriangle,
    bar: 'border-l-marked',
    chip: 'bg-marked/10 text-marked',
    badge: 'border-marked text-marked',
  },
};

function isFeedPost(post: TeacherPost | FeedPost): post is FeedPost {
  return typeof (post as FeedPost).teacherName === 'string';
}

/** `2026-11-05T...` -> `5 Nov`, in Latin digits, or nothing if unreadable. */
function postDate(createdAt: string, lang: Lang): string {
  const day = createdAt.slice(0, 10);
  return isIsoDate(day) ? formatExamDate(day, lang) : '';
}

export function PostList({
  posts,
  titleKey,
  emptyKey,
  mode = DEFAULT_MODE,
  configured = true,
  showAuthor = false,
  failed = false,
}: {
  posts: readonly TeacherPost[] | readonly FeedPost[];
  titleKey: MessageKey;
  emptyKey: MessageKey;
  mode?: LangMode;
  configured?: boolean;
  showAuthor?: boolean;
  /**
   * True when the server read FAILED rather than came back empty
   * (issue 54b-read-errors-home-teachers). It wins over `posts`: a part-read
   * feed shown as if it were whole can hide the notice that mattered.
   */
  failed?: boolean;
}) {
  // h2, not h1: both pages that use this already have their own page title.
  const dateLang: Lang = mode === 'hi' ? 'hi' : 'en';
  const ordered = sortPosts(posts as readonly (TeacherPost | FeedPost)[]);
  const title = (
    <SectionTitle
      Icon={Bell}
      titleKey={titleKey}
      mode={mode}
      count={configured && ordered.length > 0 ? ordered.length : undefined}
    />
  );

  if (!configured) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        <p role="status" className="text-muted-foreground">
          {plain('posts.notConfigured', mode)}
        </p>
      </section>
    );
  }

  // Checked BEFORE the empty state, never after: a broken read must not say
  // "No notices yet".
  if (failed) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        <ReadError mode={mode} />
      </section>
    );
  }

  // `sortPosts` keeps the element type, so a FeedPost stays a FeedPost and the
  // author name is still on the row after the sort.
  return (
    <section className="flex flex-col gap-3">
      {title}

      {ordered.length === 0 ? (
        <EmptyState
          Icon={Bell}
          text={plain(emptyKey, mode)}
          action={
            showAuthor ? { href: '/teachers', label: plain('sui.findTeachers', mode) } : undefined
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {ordered.map((post) => {
            const author = showAuthor && isFeedPost(post) ? post.teacherName : null;
            // Checked once more right before it becomes an href.
            const href = normalizeLink(post.link);
            const badgeKey = PRIORITY_KEY[post.priority] ?? null;
            const look = LOOK[Math.min(Math.max(post.priority, 0), 2)] ?? LOOK[0];
            const date = postDate(post.createdAt, dateLang);

            return (
              <li
                key={post.id}
                className={cn(CARD, 'flex gap-3 border-l-4 p-3', look.bar)}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-[10px]',
                    look.chip,
                  )}
                >
                  <look.Icon className="size-5" strokeWidth={2} />
                </span>

                <div className="flex min-w-0 grow flex-col gap-1">
                  {badgeKey || author || date ? (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {badgeKey ? (
                        // Colour never works alone (DESIGN.md section 3): the
                        // badge says the word too.
                        <span
                          className={cn(
                            'rounded-full border px-2 text-xs leading-5 font-medium',
                            look.badge,
                          )}
                        >
                          {plain(badgeKey, mode)}
                        </span>
                      ) : null}
                      {author ? (
                        <span className="text-sm leading-5 font-medium text-muted-foreground">
                          {author}
                        </span>
                      ) : null}
                      {date ? (
                        <span className="text-sm leading-5 text-muted-foreground tabular-nums">
                          {date}
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      // An outside page must never get a handle on our tab.
                      rel="noopener noreferrer"
                      className="flex min-h-12 items-center gap-2 text-base leading-6 font-medium text-primary"
                    >
                      <span>{post.heading}</span>
                      <ExternalLink size={20} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                    </a>
                  ) : (
                    <span className="text-base leading-6 font-medium">{post.heading}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
