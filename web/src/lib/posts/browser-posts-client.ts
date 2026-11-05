/**
 * Browser-side teacher-posts client (issue 09-teacher-notifications).
 *
 * The page never holds a Supabase key and never sees a token. It calls our own
 * route handler; that reads the teacher's access token out of the httpOnly
 * session cookie and lets Postgres RLS decide.
 *
 * Security: the thrown message is the HTTP status only, so a Postgres policy
 * name is never echoed back into the page.
 */
import { normalizeHeading, normalizeLink, type BrowserTeacherPostsClient, type NewTeacherPost, type TeacherPost } from './types';

export const TEACHER_POSTS_API = '/api/teacher/posts';

export function createBrowserTeacherPostsClient(
  fetchImpl?: typeof fetch,
): BrowserTeacherPostsClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  return {
    async create(input: NewTeacherPost) {
      const res = await doFetch(TEACHER_POSTS_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          heading: input.heading,
          priority: input.priority,
          link: input.link,
        }),
      });
      if (!res.ok) throw new Error('Request failed with status ' + res.status);

      const body = (await res.json()) as { post?: unknown };
      const post = readPost(body.post);
      if (!post) throw new Error('Request returned no post');
      return post;
    },

    async remove(postId: string) {
      const res = await doFetch(TEACHER_POSTS_API, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ postId }),
      });
      if (!res.ok) throw new Error('Request failed with status ' + res.status);
    },
  };
}

/**
 * The reply is still a response off the network, so it is checked like any
 * other. `normalizeLink` runs again here: the value is about to become an
 * `href` in the teacher's own list.
 */
function readPost(value: unknown): TeacherPost | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;

  const id = typeof row.id === 'string' ? row.id : null;
  const teacherId = typeof row.teacherId === 'string' ? row.teacherId : null;
  const heading = normalizeHeading(row.heading);
  if (!id || !teacherId || heading === null) return null;

  return {
    id,
    teacherId,
    priority: typeof row.priority === 'number' ? row.priority : 0,
    heading,
    link: normalizeLink(row.link),
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
  };
}
