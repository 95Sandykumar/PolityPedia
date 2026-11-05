/**
 * The videos contract for PolityPedia (issue 08-videos-tile).
 *
 * V6 / PRD F-C1: YouTube links only, and we show the thumbnail and the title.
 * PRD F-C2: one teacher switch, Show or No show; No show reads "Coming soon".
 *
 * YouTube and Supabase both sit behind these interfaces so tests can fake
 * them: no real network call and no real key anywhere in the test suite
 * (web/CLAUDE.md).
 *
 * Three kinds of client, because a key must never reach the browser:
 * - `VideosClient` runs on the server with the signed-in user's own access
 *   token, so Postgres RLS (`teacher_videos_*`) is the real gate.
 * - `VideoMeta` is the only thing that talks to YouTube. One call, no key.
 * - `BrowserVideosClient` calls our own route handler and never sees a key.
 */

/** One row of `public.teacher_videos`. */
export interface TeacherVideo {
  id: string;
  teacherId: string;
  /** The 11-character YouTube id. Checked in SQL and in `youtube-url.ts`. */
  youtubeId: string;
  /** From oEmbed. Null when YouTube did not answer; the page falls back. */
  title: string | null;
  thumbUrl: string | null;
  position: number;
}

/** What `add` needs. `teacher_id` is NOT here: it comes from the session. */
export interface AddVideoInput {
  youtubeId: string;
  title: string | null;
  thumbUrl: string;
  position: number;
}

/** Longest title we store. Matches the SQL check in 0008. */
export const MAX_VIDEO_TITLE_LENGTH = 300;

/**
 * The one thing in this slice that talks to YouTube.
 *
 * Keyless on purpose: the public oEmbed endpoint is enough for a title, so
 * the YouTube Data API stays out of scope (issue notes).
 */
export interface VideoMeta {
  /** The video title, or null when YouTube did not answer. Never throws. */
  readTitle(youtubeId: string): Promise<string | null>;
}

/** Server side. Carries the caller's own access token, so RLS decides. */
export interface VideosClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /** The caller's own videos, for the teacher screen. Empty on any failure. */
  listMine(): Promise<TeacherVideo[]>;
  /**
   * One teacher's videos for a student. Returns 0 rows when that teacher is
   * on No show or is not approved: the `teacher_videos_select_visible` policy
   * decides, not this method.
   */
  listForTeacher(teacherId: string): Promise<TeacherVideo[]>;
  /** Add one row owned by the caller. */
  add(input: AddVideoInput): Promise<void>;
  /** Delete one of the caller's own rows. */
  remove(id: string): Promise<void>;
  /** The caller's own Show / No show state. True when there is nothing to read. */
  readVisible(): Promise<boolean>;
  /** V6: write `teachers.videos_visible` on the caller's own row. */
  setVisible(visible: boolean): Promise<void>;
}

/** Browser side: the teacher's videos screen. Calls our own route. */
export interface BrowserVideosClient {
  /** The raw pasted link. The route parses it, so both sides use one parser. */
  add(url: string): Promise<void>;
  remove(id: string): Promise<void>;
  setVisible(visible: boolean): Promise<void>;
}
