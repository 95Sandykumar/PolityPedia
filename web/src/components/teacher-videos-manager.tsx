'use client';

/**
 * The teacher's videos screen (issue 08-videos-tile).
 *
 * Definition of done, first line: "A teacher pastes YouTube links." Plus the
 * list, a Remove button per row, and the one Show / No show switch of V6 and
 * PRD F-C2.
 *
 * The rows are read on the server and passed in, so this component holds no
 * key and makes no read of its own. The client is a prop so the test can
 * inject a fake: no real network call and no real key (web/CLAUDE.md).
 *
 * The link is parsed here only to answer "That is not a YouTube link" without
 * a round trip. The ROUTE parses it again and the database checks the shape a
 * third time; this check is convenience, never the gate.
 */
import { Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { VideoThumb } from '@/components/video-thumb';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import { createBrowserVideosClient } from '@/lib/videos/browser-videos-client';
import { parseYouTubeId } from '@/lib/videos/youtube-url';
import type { BrowserVideosClient, TeacherVideo } from '@/lib/videos/types';
import { cn } from '@/lib/utils';

const OUTLINE_BUTTON =
  'min-h-12 rounded-[10px] border border-border bg-card px-3 text-base font-medium text-foreground transition-colors duration-100 disabled:opacity-60';

export function TeacherVideosManager({
  videos,
  visible: initialVisible,
  client,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  videos: readonly TeacherVideo[];
  /** `teachers.videos_visible`, read on the server. */
  visible: boolean;
  client?: BrowserVideosClient;
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const fallback = useMemo(() => createBrowserVideosClient(), []);
  const api = client ?? fallback;

  const [link, setLink] = useState('');
  const [visible, setVisible] = useState(initialVisible);
  /** Rows added in this session, so the list grows without a reload. */
  const [added, setAdded] = useState<readonly TeacherVideo[]>([]);
  /** Rows removed in this session, so the list shrinks as you work. */
  const [removed, setRemoved] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  const shown = [...videos, ...added].filter((video) => !removed.includes(video.id));

  const title = (
    <h1 className="text-[22px] leading-7 font-bold">
      {labels('videos.title', mode).map((line) => (
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
          {plain('videos.notConfigured', mode)}
        </p>
      </section>
    );
  }

  async function add() {
    if (busy) return;
    setError(null);

    // V6: YouTube only. Told straight away, with no request sent.
    const youtubeId = parseYouTubeId(link);
    if (youtubeId === null) {
      setError('videos.badLink');
      return;
    }

    setBusy(true);
    try {
      // The RAW link goes over the wire. The route owns the parse that counts.
      await api.add(link.trim());
      setLink('');
      // A placeholder row, so the teacher sees the video straight away. The
      // real title arrives from oEmbed on the next page load.
      setAdded((old) => [
        ...old,
        {
          id: 'pending:' + youtubeId,
          teacherId: '',
          youtubeId,
          title: null,
          thumbUrl: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
          position: shown.length,
        },
      ]);
    } catch {
      // Fixed message only. The thrown error may quote Postgres.
      setError('videos.failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.remove(id);
      setRemoved((old) => [...old, id]);
    } catch {
      // The row stays: nothing in the database changed.
      setError('videos.failed');
    } finally {
      setBusy(false);
    }
  }

  async function toggleVisible() {
    if (busy) return;
    const wanted = !visible;
    setBusy(true);
    setError(null);
    try {
      await api.setVisible(wanted);
      setVisible(wanted);
    } catch {
      // The switch stays where it was: the stored value did not move.
      setError('videos.failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      {title}

      {/* V6 / F-C2: one switch for the whole tile. */}
      <div className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-card p-3">
        <span className="text-sm text-muted-foreground">{plain('videos.switch', mode)}</span>
        <button
          type="button"
          disabled={busy}
          aria-pressed={visible}
          onClick={() => void toggleVisible()}
          aria-label={plain(visible ? 'videos.show' : 'videos.noShow', mode)}
          className={cn(
            'min-h-12 rounded-[10px] px-3 text-base font-medium transition-colors duration-100 disabled:opacity-60',
            visible
              ? 'bg-primary text-primary-foreground'
              : 'border border-border bg-muted text-muted-foreground',
          )}
        >
          {plain(visible ? 'videos.show' : 'videos.noShow', mode)}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="videos-link" className="text-sm font-medium">
          {plain('videos.link', mode)}
        </label>
        <input
          id="videos-link"
          type="url"
          inputMode="url"
          autoComplete="off"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder="https://www.youtube.com/watch?v=..."
          className="min-h-12 rounded-[10px] border border-border bg-card px-3 text-base"
        />
        <p className="text-xs text-muted-foreground">{plain('videos.hint', mode)}</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void add()}
          aria-label={plain('videos.add', mode)}
          className="min-h-12 rounded-[10px] bg-primary px-3 text-base font-medium text-primary-foreground transition-colors duration-100 disabled:opacity-60"
        >
          {plain(busy ? 'videos.adding' : 'videos.add', mode)}
        </button>
      </div>

      {error ? (
        <p role="alert" className="rounded-[10px] border border-border bg-card p-3 text-wrong">
          {plain(error, mode)}
        </p>
      ) : null}

      {/* What a student sees right now. Two different sentences, so the
          teacher can tell "switched off" from "nothing added yet". */}
      {!visible || shown.length === 0 ? (
        <p role="status" className="text-muted-foreground">
          {plain(visible ? 'videos.none' : 'placeholder.soon', mode)}
        </p>
      ) : null}

      {shown.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {shown.map((video) => (
            <li
              key={video.id}
              className="flex items-center gap-3 rounded-[10px] border border-border bg-card p-3"
            >
              <div className="w-28 shrink-0">
                <VideoThumb src={video.thumbUrl} />
              </div>
              <span className="min-w-0 flex-1 break-words text-sm font-medium">
                {video.title ?? video.youtubeId}
              </span>
              <button
                type="button"
                disabled={busy || video.id.startsWith('pending:')}
                onClick={() => void remove(video.id)}
                aria-label={plain('videos.delete', mode)}
                className={cn(OUTLINE_BUTTON, 'shrink-0')}
              >
                <Trash2 size={20} strokeWidth={2} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
