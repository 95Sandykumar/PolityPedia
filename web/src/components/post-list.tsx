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
 * Security: a `link` is rendered as an `href`, so only an http(s) one is drawn
 * at all. `normalizeLink` decides, the route and the client agree, and
 * Postgres has the same check in 0009. Four layers, because a `javascript:`
 * href is a script a student would tap.
 */
import { ExternalLink } from 'lucide-react';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import { normalizeLink, sortPosts, type FeedPost, type TeacherPost } from '@/lib/posts/types';
import { cn } from '@/lib/utils';

/** The badge key per priority. Normal gets none: minimum text (DESIGN.md 1). */
const PRIORITY_KEY: Record<number, MessageKey | null> = {
  0: null,
  1: 'posts.priority1',
  2: 'posts.priority2',
};

function isFeedPost(post: TeacherPost | FeedPost): post is FeedPost {
  return typeof (post as FeedPost).teacherName === 'string';
}

export function PostList({
  posts,
  titleKey,
  emptyKey,
  mode = DEFAULT_MODE,
  configured = true,
  showAuthor = false,
}: {
  posts: readonly TeacherPost[] | readonly FeedPost[];
  titleKey: MessageKey;
  emptyKey: MessageKey;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
  /** True on Home, where notices from several teachers are mixed together. */
  showAuthor?: boolean;
}) {
  // h2, not h1: both pages that use this already have their own page title.
  const title = (
    <h2 className="text-[18px] leading-6 font-bold">
      {labels(titleKey, mode).map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </h2>
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

  // `sortPosts` keeps the element type, so a FeedPost stays a FeedPost and the
  // author name is still on the row after the sort.
  const ordered = sortPosts(posts as readonly (TeacherPost | FeedPost)[]);

  return (
    <section className="flex flex-col gap-3">
      {title}

      {ordered.length === 0 ? (
        <p role="status" className="text-muted-foreground">
          {plain(emptyKey, mode)}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {ordered.map((post) => {
            const author = showAuthor && isFeedPost(post) ? post.teacherName : null;
            // Checked once more right before it becomes an href.
            const href = normalizeLink(post.link);
            const badgeKey = PRIORITY_KEY[post.priority] ?? null;

            return (
              <li
                key={post.id}
                className="flex flex-col gap-1 rounded-[10px] border border-border bg-card p-3"
              >
                {badgeKey || author ? (
                  <div className="flex items-center gap-2">
                    {badgeKey ? (
                      // Colour never works alone (DESIGN.md section 3): the
                      // badge says the word too.
                      <span
                        className={cn(
                          'rounded-full border px-2 text-xs font-medium',
                          post.priority >= 2
                            ? 'border-marked text-marked'
                            : 'border-primary text-primary',
                        )}
                      >
                        {plain(badgeKey, mode)}
                      </span>
                    ) : null}
                    {author ? (
                      <span className="text-sm text-muted-foreground">{author}</span>
                    ) : null}
                  </div>
                ) : null}

                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    // An outside page must never get a handle on our tab.
                    rel="noopener noreferrer"
                    className="flex min-h-12 items-center gap-2 text-base font-medium text-primary"
                  >
                    <span>{post.heading}</span>
                    <ExternalLink size={20} strokeWidth={2} aria-hidden="true" />
                  </a>
                ) : (
                  <span className="text-base font-medium">{post.heading}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
