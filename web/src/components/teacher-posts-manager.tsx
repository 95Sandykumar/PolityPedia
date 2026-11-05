'use client';

/**
 * Teacher screen: post and delete notices (issue 09-teacher-notifications).
 *
 * Definition of done, teacher half: "A teacher posts a notice (priority,
 * heading, link)" plus "Teacher page to add and delete posts."
 *
 * The rows are read on the server and passed in, so this component holds no
 * key and makes no read of its own. The client is a prop so the test can
 * inject a fake: no real network call and no real key (web/CLAUDE.md).
 *
 * Permission is NOT this screen's job. The gate is the
 * `teacher_posts_insert_own` and `teacher_posts_delete_own` policies inside
 * Postgres, so another teacher's notice cannot be touched from here even with
 * a crafted id.
 *
 * A failed write leaves the typed text and the row exactly where they were,
 * because nothing changed in the database, so the old state is still the true
 * one.
 */
import { Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { createBrowserTeacherPostsClient } from '@/lib/posts/browser-posts-client';
import {
  DEFAULT_PRIORITY,
  MAX_HEADING_LENGTH,
  PRIORITIES,
  isPriority,
  normalizeHeading,
  normalizeLink,
  sortPosts,
  type BrowserTeacherPostsClient,
  type Priority,
  type TeacherPost,
} from '@/lib/posts/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const FIELD =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-base text-foreground';

const PRIORITY_KEY: Record<Priority, MessageKey> = {
  0: 'posts.priority0',
  1: 'posts.priority1',
  2: 'posts.priority2',
};

export function TeacherPostsManager({
  posts,
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  posts: readonly TeacherPost[];
  client?: BrowserTeacherPostsClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserTeacherPostsClient(), []);
  const api = client ?? fallback;

  /** The live list: what the server sent, plus and minus this session's work. */
  const [rows, setRows] = useState<readonly TeacherPost[]>(() => sortPosts(posts));

  const [heading, setHeading] = useState('');
  const [link, setLink] = useState('');
  const [priority, setPriority] = useState<Priority>(DEFAULT_PRIORITY);

  const [busy, setBusy] = useState<'add' | string | null>(null);
  /** One message slot: the newest outcome is the only one worth showing. */
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [added, setAdded] = useState(false);

  const title = (
    <h1 className="text-[22px] leading-7 font-bold">
      {labels('posts.title', mode).map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </h1>
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

  async function add() {
    if (busy) return;
    setAdded(false);

    // Checked here so an obvious mistake costs no round trip. The route and
    // Postgres check the same two things again.
    const cleanHeading = normalizeHeading(heading);
    if (cleanHeading === null) {
      setProblem('posts.needHeading');
      return;
    }
    const typedLink = link.trim();
    const cleanLink = typedLink.length === 0 ? null : normalizeLink(typedLink);
    if (typedLink.length > 0 && cleanLink === null) {
      setProblem('posts.badLink');
      return;
    }

    setBusy('add');
    setProblem(null);
    try {
      const saved = await api.create({ heading: cleanHeading, priority, link: cleanLink });
      setRows((old) => sortPosts([saved, ...old]));
      // Clear the form, ready for the next notice.
      setHeading('');
      setLink('');
      setPriority(DEFAULT_PRIORITY);
      setAdded(true);
    } catch {
      // Fixed message, and the typed text stays: nothing was saved, so the
      // teacher does not have to write it again.
      setProblem('posts.failed');
    } finally {
      setBusy(null);
    }
  }

  async function remove(postId: string) {
    if (busy) return;
    setBusy(postId);
    setProblem(null);
    setAdded(false);
    try {
      await api.remove(postId);
      setRows((old) => old.filter((row) => row.id !== postId));
    } catch {
      setProblem('posts.failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      {title}

      {problem ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain(problem, mode)}
        </p>
      ) : null}

      {added ? (
        <p role="status" className="rounded-[10px] border border-border bg-card p-3 text-correct">
          {plain('posts.added', mode)}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{plain('posts.heading', mode)}</span>
          <input
            type="text"
            value={heading}
            maxLength={MAX_HEADING_LENGTH}
            onChange={(event) => setHeading(event.target.value)}
            className={FIELD}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{plain('posts.priority', mode)}</span>
          <select
            value={String(priority)}
            onChange={(event) => {
              const picked = Number(event.target.value);
              setPriority(isPriority(picked) ? picked : DEFAULT_PRIORITY);
            }}
            className={FIELD}
          >
            {PRIORITIES.map((value) => (
              <option key={value} value={String(value)}>
                {plain(PRIORITY_KEY[value], mode)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{plain('posts.link', mode)}</span>
          <input
            type="url"
            inputMode="url"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            className={FIELD}
          />
        </label>

        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void add()}
          aria-label={plain('posts.add', mode)}
          className="min-h-12 w-full rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100 disabled:opacity-60"
        >
          {plain(busy === 'add' ? 'posts.adding' : 'posts.add', mode)}
        </button>
      </div>

      {rows.length === 0 ? (
        <p role="status" className="text-muted-foreground">
          {plain('posts.none', mode)}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((post) => (
            <li
              key={post.id}
              className="flex items-center gap-3 rounded-[10px] border border-border bg-card p-3"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span
                  className={cn(
                    'text-xs font-medium',
                    post.priority >= 2 ? 'text-marked' : 'text-muted-foreground',
                  )}
                >
                  {plain(PRIORITY_KEY[post.priority as Priority] ?? 'posts.priority0', mode)}
                </span>
                <span className="text-base font-medium">{post.heading}</span>
                {post.link ? (
                  <span className="truncate text-sm text-muted-foreground">{post.link}</span>
                ) : null}
              </div>

              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void remove(post.id)}
                aria-label={plain('posts.delete', mode)}
                className="flex min-h-12 min-w-12 items-center justify-center rounded-[10px] border border-wrong px-3 text-wrong transition-colors duration-100 disabled:opacity-60"
              >
                <Trash2 size={20} strokeWidth={2} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
