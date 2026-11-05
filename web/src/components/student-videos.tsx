/**
 * `/t/<teacherId>/videos`, the student view (issue 08-videos-tile).
 *
 * Definition of done: "Students see each video's thumbnail and title. If the
 * teacher switches Videos to No show, students see a muted 'Coming soon' tile
 * that does not open."
 *
 * TWO GATES, one rule. `videos_visible` closes the Postgres read, so the list
 * arrives EMPTY for a teacher on No show (the
 * `teacher_videos_select_visible` policy in 0008). This component also checks
 * the flag, so the student gets "Coming soon" instead of "No videos yet": the
 * flag decides the MESSAGE, the database decides the DATA. A page bug can
 * therefore never leak a hidden list, only name the state wrongly.
 *
 * V6: YouTube links only. A tile opens the video ON YOUTUBE in a new tab; we
 * never embed a player, so no YouTube script runs on our page and the 150 KB
 * JS budget (DESIGN.md section 10) stays intact.
 *
 * A server component: there is nothing to click except the links, so no
 * client bundle is needed at all.
 */
import { VideoThumb } from '@/components/video-thumb';
import { DEFAULT_MODE, labels, plain, type LangMode } from '@/lib/i18n';
import type { PublicTeacher } from '@/lib/teachers/types';
import { youTubeWatchUrl } from '@/lib/videos/youtube-url';
import type { TeacherVideo } from '@/lib/videos/types';

export function StudentVideos({
  teacher,
  videos,
  mode = DEFAULT_MODE,
  configured = true,
}: {
  teacher: PublicTeacher;
  /** Already filtered by Postgres: empty for a teacher on No show. */
  videos: readonly TeacherVideo[];
  mode?: LangMode;
  /** False when the Supabase env vars are missing. */
  configured?: boolean;
}) {
  const title = (
    <h1 className="text-[22px] leading-7 font-bold">
      {labels('videos.title', mode).map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </h1>
  );

  /** The muted panel of DESIGN.md section 8. Nothing in it is tappable. */
  function muted(text: string) {
    return (
      <section className="flex flex-col gap-3">
        {title}
        <p
          role="status"
          className="rounded-[10px] border border-border bg-muted p-3 text-muted-foreground"
        >
          {text}
        </p>
      </section>
    );
  }

  if (!configured) return muted(plain('videos.notConfigured', mode));

  // PRD F-C2: No show reads "Coming soon". Checked before the list, so a
  // teacher on No show never falls through to the empty state.
  if (!teacher.videosVisible) return muted(plain('placeholder.soon', mode));

  if (videos.length === 0) return muted(plain('videos.none', mode));

  return (
    <section className="flex flex-col gap-3">
      {title}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {videos.map((video) => (
          <li key={video.id}>
            <a
              href={youTubeWatchUrl(video.youtubeId)}
              target="_blank"
              // noopener so the YouTube tab can never reach back into our
              // page; noreferrer keeps the student's path to themselves.
              rel="noopener noreferrer"
              className="flex flex-col gap-2 rounded-[10px] border border-border bg-card p-3 transition-colors duration-100"
            >
              <VideoThumb src={video.thumbUrl} />
              {/* No title from oEmbed: show whose video it is, never a blank
                  row and never the raw id. */}
              <span className="text-sm font-medium">{video.title ?? teacher.displayName}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
