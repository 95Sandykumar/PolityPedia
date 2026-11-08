/**
 * The server reads behind the teacher's Home screen (teacher-ui).
 *
 * Server only. Every read runs HERE, on the server, with the teacher's own
 * access token out of the httpOnly session cookie, so Postgres RLS decides the
 * rows and the browser never holds a key. READ ONLY: no write, no schema.
 *
 * The lists come from the helpers the Papers, Mock sets, Batches, Notices and
 * Videos screens already use, so Home can never disagree with them. The one
 * new read is the teacher's own row in `teachers` (`teachers_select_own`), for
 * the greeting and the approval state.
 *
 * FOLLOWERS ARE NOT HERE ON PURPOSE. `follows_select_own` lets a student read
 * only their own rows, so a teacher cannot count who follows them without a
 * new policy or view, and this slice changes no schema.
 *
 * Every read fails SOFT: a Supabase hiccup gives a zero or a null, never a 500
 * on the first screen a teacher sees.
 */
import type { AuthSession } from '@/lib/auth/types';
import { readSupabaseEnv } from '@/lib/auth/env';
import { readMyBatches } from '@/lib/batches/teacher-page';
import { readMyMockSets } from '@/lib/mocks/teacher-page';
import { readMyPapers } from '@/lib/papers/teacher-page';
import { readMyPosts } from '@/lib/posts/server-posts';
import { isTeacherStatus } from '@/lib/teachers/types';
import { readMyVideos } from '@/lib/videos/page-data';
import {
  summarizeTeacherHome,
  type OwnTeacher,
  type TeacherHomeSummary,
} from './summary';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Turn one `teachers` row into the greeting name and the approval state. */
export function parseOwnTeacher(row: unknown): OwnTeacher {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    // Their own row, so the real name is theirs to see. Alias is the fallback.
    name: text(r.real_name) ?? text(r.alias),
    status: isTeacherStatus(r.status) ? r.status : null,
  };
}

/** The caller's own teacher row. Null name and status on any failure. */
export async function readOwnTeacher(
  session: AuthSession | null,
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<OwnTeacher> {
  const empty: OwnTeacher = { name: null, status: null };
  const found = readSupabaseEnv(env);
  if (!found || !session) return empty;

  try {
    const res = await fetchImpl(
      `${found.url}/rest/v1/teachers?select=real_name,alias,status&limit=1`,
      {
        method: 'GET',
        headers: {
          apikey: found.anonKey,
          authorization: 'Bearer ' + session.accessToken,
          accept: 'application/json',
        },
        cache: 'no-store',
      },
    );
    if (!res.ok) return empty;
    const body = (await res.json()) as unknown;
    return Array.isArray(body) && body.length > 0 ? parseOwnTeacher(body[0]) : empty;
  } catch {
    return empty;
  }
}

export async function readTeacherHome(
  session: AuthSession | null,
): Promise<TeacherHomeSummary> {
  const [teacher, papers, mocks, batches, posts, videos] = await Promise.all([
    readOwnTeacher(session),
    readMyPapers(session),
    readMyMockSets(session),
    readMyBatches(session),
    readMyPosts(session).catch(() => []),
    readMyVideos(session).catch(() => ({ videos: [], visible: true })),
  ]);

  // Issue 45-keep-money-and-scores: an archived paper, set or batch is not part
  // of "what I have", so the home counts and next-step hints skip it.
  return summarizeTeacherHome({
    teacher,
    papers: papers.filter((one) => !one.archivedAt),
    mocks: mocks.filter((one) => !one.archivedAt),
    batches: batches.filter((one) => !one.archivedAt),
    notices: posts.length,
    videos: videos.videos.length,
  });
}
